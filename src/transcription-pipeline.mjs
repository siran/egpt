// transcription-pipeline.mjs — declarative, per-note transcription fallback chain.
//
// A profile is { fallback_order: [<name>...], <name>: { type, ...cfg } }. For each
// voice note we walk fallback_order and return the first engine that yields a
// transcript. Engines by `type`:
//   whisper-server-remote — POST to an endpoint (HMAC token). timeout_ms fails fast;
//                           cooldown_ms is a circuit-breaker so a down remote is SKIPPED
//                           (not re-timed-out) every note until the cooldown elapses.
//   whisper-server-local  — resident whisper.cpp server. LAZY-spawned the first time it's
//                           reached (i.e. an earlier engine failed); resident after. While
//                           it warms, this engine "fails" and the chain falls through.
//   whisper-cli           — per-note binary spawn; the floor — EXCEPT while a resident
//                           whisper-server is serving on this node (see tryCli).
//
// Per-note re-try from the top means a recovered remote is used again with no /restart.
// onTransition fires ONLY when the winning engine changes (degrade or recover) — so a busy
// voice-note chat doesn't flood Self. All side-effecting deps are injected (testable).
import { readFile } from 'node:fs/promises';
import { residentWhisperServer } from './tools/whisper-server.mjs';
import { createDecodeOnce } from './tools/decode-once.mjs';

export function buildTranscriptionPipeline({
  profile,
  transcribeViaEndpoint,          // (audioPath, {endpoint, keyB64, timeoutMs}, log, meta) -> transcript (throws on fail)
  reachable,                      // async (url, timeoutMs) -> bool — quick liveness probe (omit to skip probing)
  startWhisperServer,             // async ({command, model, host, port, language, extraArgs, antiRepetition, onLog}) -> {url, stop}
  makeWhisperServerTranscriber,   // ({url, ffmpeg, language}) -> (audioPath, cfg, log, meta) -> transcript
  cli,                            // transcribeAudioFile(audioPath, cfg, log, meta) -> transcript
  residentServing = residentWhisperServer,   // () -> {url} of a whisper-server serving in this process, or null
  now = () => Date.now(),
  onTransition = () => {},        // ({from, to, recovered}) -> void
  onLog = () => {},
} = {}) {
  const order = Array.isArray(profile?.fallback_order) ? profile.fallback_order : [];
  const engines = order.map((name) => ({ name, ...(profile?.[name] || {}) }));
  const idxOf = (name) => order.indexOf(name);

  const breaker = new Map();       // remote name -> downUntil (ms)
  const local = new Map();         // local name -> { server, transcribe, starting, error }
  const failReason = new Map();    // engine name -> last failure reason (surfaced to Self on fallback)
  const decodeOnce = createDecodeOnce({ now });
  let lastWinner = null;

  async function tryRemote(eng, audioPath, log, meta) {
    const downUntil = breaker.get(eng.name);
    if (downUntil && downUntil > now()) return null;            // in cooldown — skip fast
    // Liveness probe: fail FAST on a down endpoint (connect_timeout_ms) instead of
    // waiting the full DECODE budget — a working server legitimately takes seconds
    // to transcribe a long note, so timeout_ms must be generous, not a fail-fast.
    if (reachable && !(await reachable(eng.endpoint, eng.connect_timeout_ms ?? 3000))) {
      breaker.set(eng.name, now() + (eng.cooldown_ms ?? 30_000));
      failReason.set(eng.name, 'unreachable');
      onLog(`pipeline: remote "${eng.name}" unreachable — cooldown ${eng.cooldown_ms ?? 30_000}ms`);
      return null;
    }
    try {
      const t = await transcribeViaEndpoint(
        audioPath, { endpoint: eng.endpoint, keyB64: eng.token, timeoutMs: eng.timeout_ms ?? 120_000 }, log, meta);
      breaker.delete(eng.name); failReason.delete(eng.name);     // healthy again
      return t || null;
    } catch (e) {
      failReason.set(eng.name, e?.message ?? String(e));
      // A 413 refuses THIS file (over the worker's body cap), not the worker: no cooldown, so the
      // notes behind a long video still reach it.
      if (e?.status === 413) {
        onLog(`pipeline: remote "${eng.name}" refused this file (${e.message}) — next rung, no cooldown`);
        return null;
      }
      breaker.set(eng.name, now() + (eng.cooldown_ms ?? 30_000));
      onLog(`pipeline: remote "${eng.name}" failed (${e?.message ?? e}) — cooldown ${eng.cooldown_ms ?? 30_000}ms`);
      return null;
    }
  }

  async function tryLocal(eng, audioPath, cfg, log, meta) {
    let h = local.get(eng.name);
    if (!h) {                                                    // first time reached → lazy spawn
      h = { server: null, transcribe: null, starting: true, error: null };
      local.set(eng.name, h);
      Promise.resolve(startWhisperServer({
        command: eng.command, model: eng.model, host: eng.host, port: eng.port,
        language: eng.language, extraArgs: eng.extra_args, antiRepetition: eng.anti_repetition !== false, onLog,
      })).then((s) => {
        h.server = s; h.starting = false;
        // Thread the engine's decode budget through (was dropped → stuck at the 120s
        // default, so large-v3-on-CPU notes longer than that aborted mid-encode →
        // "whisper_full_with_state: failed to encode" + a local→cli flap). Set it
        // generously in config; cli stays the floor for anything still stuck.
        h.transcribe = makeWhisperServerTranscriber({ url: s.url, ffmpeg: eng.ffmpeg_command, language: eng.language, timeoutMs: eng.timeout_ms });
        onLog(`pipeline: local "${eng.name}" resident at ${s.url}`);
      }).catch((e) => { h.starting = false; h.error = e; onLog(`pipeline: local "${eng.name}" spawn failed: ${e?.message ?? e}`); });
      return null;                                               // warming → fall through (cli covers the gap)
    }
    if (!h.transcribe) return null;                              // still warming / failed → fall through
    // SERIALIZE per server: whisper-server decodes ONE note at a time. Two concurrent
    // POSTs corrupt its shared state ("failed to encode") and the second waits past its
    // timeout. Chain each note behind the previous so a burst queues instead of colliding.
    const prev = h.tail ?? Promise.resolve();
    let release;
    h.tail = new Promise((r) => { release = r; });
    try {
      await prev.catch(() => {});                                // wait our turn (ignore prior outcome)
      // The transcriber swallows its error (null) but LOGS "transcribe failed — <why>"
      // (we don't change its contract — the worker relies on null-on-error). Tap that
      // line so the actual reason (e.g. a timeout) reaches Self, not just egpt.log.
      let why = null;
      const tap = (m) => { const mm = /transcribe failed — (.+)$/.exec(String(m)); if (mm) why = mm[1]; log(m); };
      const t = (await h.transcribe(audioPath, cfg, tap, meta)) || null;
      if (t) failReason.delete(eng.name);
      else failReason.set(eng.name, why ?? 'no transcript');
      return t;
    } catch (e) {
      failReason.set(eng.name, e?.message ?? String(e));
      onLog(`pipeline: local "${eng.name}" transcribe failed: ${e?.message ?? e}`);
      return null;
    } finally {
      release();                                                 // let the next queued note run
    }
  }

  // ONE MODEL PER NODE (dolly, 2026-09-15). whisper-cli loads its OWN model per note. When the
  // rungs above failed while a resident whisper-server still held its model — do's worker rung
  // was down, the WhisperServer service's large-v3 was loaded — every note spawned a second
  // model beside it, and the 15.9 GB box ran out of memory. While a resident server is serving
  // (this pipeline's own local engine, or any server this process started or adopted), the cli
  // rung DECLINES, loudly, instead. It still runs when none is serving.
  async function tryCli(eng, audioPath, log, meta) {
    const own = [...local.values()].find((h) => h.server?.isAlive?.());
    const resident = own ? { url: own.server.url } : residentServing();
    if (resident) {
      failReason.set(eng.name, `declined: a resident whisper-server is serving at ${resident.url}`);
      onLog(`!! pipeline: cli "${eng.name}" DECLINED — a resident whisper-server is serving at ${resident.url} on this node, and whisper-cli would load a second model beside it. This note stays untranscribed; the rung above it is what failed.`);
      return null;
    }
    try { return (await cli(audioPath, eng, log, meta)) || null; }
    catch (e) { onLog(`pipeline: cli "${eng.name}" failed: ${e?.message ?? e}`); return null; }
  }

  // ONE DECODE PER BYTES (src/tools/decode-once.mjs). Both connections, voice notes and videos all
  // come through here, and the same note arrives once per connection whose account is in the chat.
  // The decode writes into its own meta, which every caller sharing it copies into theirs. A file
  // this process cannot read has no key: it walks the chain as before, and the engines say why.
  // (The bytes live only inside the .then callback, so a long video is not held in memory for the
  // whole decode.)
  async function transcribe(audioPath, cfg = {}, log = () => {}, meta = null) {
    const once = await readFile(audioPath).then((bytes) => decodeOnce(bytes, () => {
      const decoded = {};
      return { result: walk(audioPath, cfg, log, decoded).then((transcript) => ({ transcript, meta: decoded })) };
    }), () => null);
    if (!once) return walk(audioPath, cfg, log, meta);
    const { served, job } = once;
    if (served) log(`transcribe: ${audioPath.split(/[\\/]/).pop()} served from an existing decode of the same bytes (${served})`);
    const { transcript, meta: decoded } = await job.result;
    if (meta) Object.assign(meta, decoded);
    return transcript;
  }

  async function walk(audioPath, cfg, log, meta) {
    for (const eng of engines) {
      let t = null;
      if (eng.type === 'whisper-server-remote') t = await tryRemote(eng, audioPath, log, meta);
      else if (eng.type === 'whisper-server-local') t = await tryLocal(eng, audioPath, cfg, log, meta);
      else if (eng.type === 'whisper-cli') t = await tryCli(eng, audioPath, log, meta);
      else { onLog(`pipeline: "${eng.name}" has unknown type "${eng.type}" — skipping`); continue; }
      if (t) {
        if (lastWinner && lastWinner !== eng.name) {
          const recovered = idxOf(eng.name) < idxOf(lastWinner);
          // On a fall-BACK, surface WHY the prior engine failed this note (the
          // timeout/error), not just "engine unavailable" — operator wants the
          // reason on Self, not buried in egpt.log.
          onTransition({ from: lastWinner, to: eng.name, recovered, reason: recovered ? null : (failReason.get(lastWinner) ?? null) });
        }
        lastWinner = eng.name;
        return t;
      }
    }
    return null;                                                 // every engine declined (transcript stays empty)
  }

  function stop() { for (const h of local.values()) { try { h.server?.stop(); } catch { /* best effort */ } } }

  return { transcribe, stop };
}
