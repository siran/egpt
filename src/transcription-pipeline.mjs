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
//                           it warms, this engine "fails" and the chain falls through; when
//                           nothing below answers, the walk waits for the start and tries it
//                           once more, so a note is never lost to a warm-up.
//   whisper-server-ecs    — whisper-server in an on-demand ECS service: woken (desired 1) by a
//                           note, slept (desired 0) after idle_stop_ms (src/tools/whisper-ecs.mjs);
//                           decoded like whisper-server-local.
//   whisper-cli           — per-note binary spawn; the floor — EXCEPT while a resident
//                           whisper-server is serving on this node (see tryCli).
//
// Per-note re-try from the top means a recovered remote is used again with no /restart.
// onTransition fires ONLY when the winning engine changes (degrade or recover) — so a busy
// voice-note chat doesn't flood Self. All side-effecting deps are injected (testable).
//
// WHERE THE DECODE RUNS (2026-09-16). transcribe()'s caller may hand a hook, `onDecodeHere`: the
// chain calls it when a decode starts ON THIS NODE — a whisper-cli rung, a whisper-server-local rung,
// or a whisper-server-remote rung whose endpoint is this node's own transcriptor — and calls the
// function it returned when the walk ends, a throw included. At most once per walk, and the walk is
// once per bytes (decode-once), so a caller that joins a decode never has its hook called. The
// bridge's 🎧 listening mark hangs off it (src/bridges/beeper.mjs).
import { readFile } from 'node:fs/promises';
import { residentWhisperServer } from './tools/whisper-server.mjs';
import { createDecodeOnce, sha256Hex } from './tools/decode-once.mjs';

export function buildTranscriptionPipeline({
  profile,
  transcribeViaEndpoint,          // (audioPath, {endpoint, keyB64, timeoutMs}, log, meta) -> transcript (throws on fail)
  reachable,                      // async (url, timeoutMs) -> bool — quick liveness probe (omit to skip probing)
  startWhisperServer,             // async ({command, model, host, port, language, extraArgs, antiRepetition, onLog}) -> {url, stop}
  makeWhisperServerTranscriber,   // ({url, ffmpeg, language, audio_ctx}) -> (audioPath, cfg, log, meta) -> transcript
  cli,                            // transcribeAudioFile(audioPath, cfg, log, meta) -> transcript
  residentServing = residentWhisperServer,   // () -> {url} of a whisper-server serving in this process, or null
  // routesToOwnTranscriptor(cfg) (src/spine/transcriptor-worker.mjs) — { at, endpoint } of the remote
  // rung that is THIS node's own transcriptor, or null. The one definition, handed in, not re-derived.
  ownTranscriptor = null,
  // publishTranscript(endpoint, { keyB64, sha, transcript, durationSec }) (src/tools/transcriptor.mjs) —
  // reconciles a LOCAL fallback decode to the worker rung that could not decode it, so that worker never
  // decodes those bytes again (operator 2026-09-29: "dolly should identify them by hash"). Injected; null
  // (tests, or a node with no worker rung) turns reconciliation off, exactly like `reachable`.
  publishTranscript = null,
  makeEcsWaker = null,            // (eng) -> { acquire, release, boot, stop } (src/tools/whisper-ecs.mjs); null skips the type
  now = () => Date.now(),
  onTransition = () => {},        // ({from, to, recovered}) -> void
  onLog = () => {},
} = {}) {
  const order = Array.isArray(profile?.fallback_order) ? profile.fallback_order : [];
  const engines = order.map((name) => ({ name, ...(profile?.[name] || {}) }));
  const idxOf = (name) => order.indexOf(name);

  const breaker = new Map();       // remote name -> downUntil (ms)
  const local = new Map();         // local name -> { server, transcribe, starting, error }
  const gpu = new Map();           // ecs name -> { waker, url, transcribe }
  const failReason = new Map();    // engine name -> last failure reason (surfaced to Self on fallback)
  const decodeOnce = createDecodeOnce({ now });
  // Local decodes waiting to be reconciled to a worker that was down when they were decoded (operator
  // 2026-09-29). Bounded so an outage cannot grow it without limit; flushed by tryRemote when the worker
  // rung is next reachable, and each entry drops as soon as the worker accepts it (idempotent there).
  const pendingReconcile = new Map();     // `${endpoint}\0${sha}` -> { endpoint, keyB64, sha, transcript, durationSec }
  const RECONCILE_MAX = 256;
  let lastWinner = null;

  // Reconcile a transcript this node decoded LOCALLY to a worker rung that did not decode it (unreachable,
  // in cooldown, or a 413). Immediate when the worker is reachable (a 413'd file — dolly is up, it only
  // refused these bytes); otherwise the rung is in cooldown, so the result is HELD and flushPending sends
  // it when tryRemote next finds the rung reachable. Best-effort and idempotent on the worker.
  function reconcile(worker, sha, transcript, durationSec) {
    if (!publishTranscript || !worker.endpoint || !worker.keyB64) return;
    const key = `${worker.endpoint}\u0000${sha}`;
    const item = { endpoint: worker.endpoint, keyB64: worker.keyB64, sha, transcript, durationSec };
    const downUntil = breaker.get(worker.name);
    if (downUntil && downUntil > now()) return hold(key, item);        // worker rung down → send on reconnect
    publishTranscript(item.endpoint, item).then((ok) => { if (!ok) hold(key, item); }, () => hold(key, item));
  }
  function hold(key, item) {
    pendingReconcile.set(key, item);
    while (pendingReconcile.size > RECONCILE_MAX) pendingReconcile.delete(pendingReconcile.keys().next().value);
  }
  // The worker rung answered a probe (or none is configured and we are about to use it): send everything
  // decoded locally for that endpoint while it was down. Fire-and-forget; an entry drops only once the
  // worker accepts it, so a still-down worker keeps it for the next try.
  function flushPending(endpoint) {
    if (!publishTranscript) return;
    for (const [key, item] of [...pendingReconcile]) {
      if (item.endpoint !== endpoint) continue;
      publishTranscript(item.endpoint, item).then((ok) => { if (ok) pendingReconcile.delete(key); }, () => {});
    }
  }

  async function tryRemote(eng, audioPath, log, meta, decodingHere) {
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
    flushPending(eng.endpoint);   // reachable (or no probe) → reconcile anything decoded locally while it was down
    if (ownTranscriptor && eng.endpoint === ownTranscriptor.endpoint) await decodingHere();   // this node's own worker
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

  // `later`: the walk's rung list on its first pass (a warming rung appends itself to it), null when the
  // walk has come back to this rung.
  async function tryLocal(eng, audioPath, cfg, log, meta, decodingHere, later) {
    let h = local.get(eng.name);
    if (!h) {                                                    // first time reached → lazy spawn
      h = { server: null, transcribe: null, starting: true, error: null };
      local.set(eng.name, h);
      h.started = Promise.resolve(startWhisperServer({
        command: eng.command, model: eng.model, host: eng.host, port: eng.port,
        language: eng.language, extraArgs: eng.extra_args, antiRepetition: eng.anti_repetition !== false, onLog,
      })).then((s) => {
        h.server = s; h.starting = false;
        // Thread the engine's decode budget through (was dropped → stuck at the 120s
        // default, so large-v3-on-CPU notes longer than that aborted mid-encode →
        // "whisper_full_with_state: failed to encode" + a local→cli flap). Set it
        // generously in config; cli stays the floor for anything still stuck.
        h.transcribe = makeWhisperServerTranscriber({ url: s.url, ffmpeg: eng.ffmpeg_command, language: eng.language, audio_ctx: eng.audio_ctx, timeoutMs: eng.timeout_ms });
        onLog(`pipeline: local "${eng.name}" resident at ${s.url}`);
      }).catch((e) => { h.starting = false; h.error = e; onLog(`pipeline: local "${eng.name}" spawn failed: ${e?.message ?? e}`); });
    }
    if (h.starting) {
      // Warming → fall through (cli covers the gap). A NOTE IS NEVER LOST TO A WARM-UP (EDW, 2026-10-27: this
      // was its only rung, and the first note after every restart was lost): if no rung below answers, the
      // walk comes back here once and waits for the start to settle.
      if (later) { later.push(eng); return null; }
      await h.started;
    }
    if (!h.transcribe) return null;                              // the start failed (h.error) → fall through
    return decodeOn(eng, h, `local "${eng.name}"`, audioPath, cfg, log, meta, decodingHere);
  }

  // SERIALIZE per server: whisper-server decodes ONE note at a time. Two concurrent
  // POSTs corrupt its shared state ("failed to encode") and the second waits past its
  // timeout. Chain each note behind the previous so a burst queues instead of colliding.
  async function decodeOn(eng, h, what, audioPath, cfg, log, meta, decodingHere) {
    const prev = h.tail ?? Promise.resolve();
    let release;
    h.tail = new Promise((r) => { release = r; });
    try {
      await decodingHere();                                      // its place in the queue is taken: queued here is decoding here
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
      onLog(`pipeline: ${what} transcribe failed: ${e?.message ?? e}`);
      return null;
    } finally {
      release();                                                 // let the next queued note run
    }
  }

  function gpuOf(eng) {
    let g = gpu.get(eng.name);
    if (!g) { g = { waker: makeEcsWaker(eng), url: null, transcribe: null }; gpu.set(eng.name, g); }
    return g;
  }

  // The worker's own `language` wins over the caller's cfg (the cli profile's): auto on the GPU, es on the cli.
  async function tryEcs(eng, audioPath, cfg, log, meta, decodingHere) {
    if (!makeEcsWaker) { onLog(`pipeline: "${eng.name}" is whisper-server-ecs but this node has no ECS waker — skipping`); return null; }
    const g = gpuOf(eng);
    try {
      const { url, why } = await g.waker.acquire({ onWait: decodingHere });
      if (!url) { failReason.set(eng.name, why); return null; }
      if (g.url !== url) {
        g.url = url;
        g.transcribe = makeWhisperServerTranscriber({ url, ffmpeg: eng.ffmpeg_command, language: eng.language, audio_ctx: eng.audio_ctx, timeoutMs: eng.timeout_ms });
      }
      return await decodeOn(eng, g, `gpu "${eng.name}"`, audioPath, eng.language != null ? { ...cfg, language: eng.language } : cfg, log, meta, decodingHere);
    } finally {
      g.waker.release();
    }
  }

  // ONE MODEL PER NODE (dolly, 2026-09-15). whisper-cli loads its OWN model per note. When the
  // rungs above failed while a resident whisper-server still held its model — do's worker rung
  // was down, the WhisperServer service's large-v3 was loaded — every note spawned a second
  // model beside it, and the 15.9 GB box ran out of memory. While a resident server is serving
  // (this pipeline's own local engine, or any server this process started or adopted), the cli
  // rung DECLINES, loudly, instead. It still runs when none is serving.
  async function tryCli(eng, audioPath, log, meta, decodingHere) {
    const own = [...local.values()].find((h) => h.server?.isAlive?.());
    const resident = own ? { url: own.server.url } : residentServing();
    if (resident) {
      failReason.set(eng.name, `declined: a resident whisper-server is serving at ${resident.url}`);
      onLog(`!! pipeline: cli "${eng.name}" DECLINED — a resident whisper-server is serving at ${resident.url} on this node, and whisper-cli would load a second model beside it. This note stays untranscribed; the rung above it is what failed.`);
      return null;
    }
    await decodingHere();
    try { return (await cli(audioPath, eng, log, meta)) || null; }
    catch (e) { onLog(`pipeline: cli "${eng.name}" failed: ${e?.message ?? e}`); return null; }
  }

  // ONE DECODE PER BYTES (src/tools/decode-once.mjs). Both connections, voice notes and videos all
  // come through here, and the same note arrives once per connection whose account is in the chat.
  // The decode writes into its own meta, which every caller sharing it copies into theirs. A file
  // this process cannot read has no key: it walks the chain as before, and the engines say why.
  // (The bytes live only inside the .then callback, so a long video is not held in memory for the
  // whole decode.)
  // `onDecodeHere` (header) rides with the walk this call STARTS; a call that joins a running or
  // recent decode never passes it on, which is what makes the mark once per note per node.
  async function transcribe(audioPath, cfg = {}, log = () => {}, meta = null, onDecodeHere = null) {
    const once = await readFile(audioPath).then((bytes) => {
      const sha = sha256Hex(bytes);   // the reconcile key too: the walk it starts hands it on to reconcile()
      return { sha, ...decodeOnce(sha, () => {
        const decoded = {};
        return { result: walk(audioPath, cfg, log, decoded, onDecodeHere, sha).then((transcript) => ({ transcript, meta: decoded })) };
      }) };
    }, () => null);
    if (!once) return walk(audioPath, cfg, log, meta, onDecodeHere, null);
    const { served, job } = once;
    if (served) log(`transcribe: ${audioPath.split(/[\\/]/).pop()} served from an existing decode of the same bytes (${served})`);
    const { transcript, meta: decoded } = await job.result;
    if (meta) Object.assign(meta, decoded);
    return transcript;
  }

  async function walk(audioPath, cfg, log, meta, onDecodeHere = null, sha = null) {
    // The hook is AWAITED before the first on-node decode starts, so whatever it puts up is up
    // before that decode spends its first second, and its end can never run ahead of it. Neither
    // half may cost the transcript: a throw is logged and the decode goes on.
    let asked = false, end = null;
    const decodingHere = async () => {
      if (asked || !onDecodeHere) return;
      asked = true;
      try { end = await onDecodeHere(); }
      catch (e) { onLog(`pipeline: the decode-start hook threw — ${e?.message ?? e}`); }
    };
    const failedWorkers = [];   // whisper-server-remote rungs that did NOT answer this note (candidates to reconcile to)
    const rungs = [...engines];   // + a whisper-server-local rung found warming, walked once more after the rest (tryLocal)
    try {
      for (const [i, eng] of rungs.entries()) {
        let t = null;
        if (eng.type === 'whisper-server-remote') {
          t = await tryRemote(eng, audioPath, log, meta, decodingHere);
          if (!t && eng.endpoint) failedWorkers.push({ name: eng.name, endpoint: eng.endpoint, keyB64: eng.token });
        }
        else if (eng.type === 'whisper-server-local') t = await tryLocal(eng, audioPath, cfg, log, meta, decodingHere, i < engines.length ? rungs : null);
        else if (eng.type === 'whisper-server-ecs') t = await tryEcs(eng, audioPath, cfg, log, meta, decodingHere);
        else if (eng.type === 'whisper-cli') t = await tryCli(eng, audioPath, log, meta, decodingHere);
        else { onLog(`pipeline: "${eng.name}" has unknown type "${eng.type}" — skipping`); continue; }
        if (t) {
          // A LOCAL rung produced this transcript while a worker rung above it did not — reconcile it to
          // those workers by sha so THEY never decode these bytes (operator 2026-09-29). A remote rung
          // that won is already in its worker's store, so it never reconciles.
          if (sha && eng.type !== 'whisper-server-remote') for (const w of failedWorkers) reconcile(w, sha, t, meta?.durationSec);
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
      return null;                                               // every engine declined (transcript stays empty)
    } finally {
      if (typeof end === 'function') {
        try { await end(); }
        catch (e) { onLog(`pipeline: the decode-end hook threw — ${e?.message ?? e}`); }
      }
    }
  }

  // Boot: an ECS worker a previous run left awake gets its idle stop.
  function boot() {
    return Promise.all(engines.filter((e) => e.type === 'whisper-server-ecs' && makeEcsWaker).map((e) => gpuOf(e).waker.boot()));
  }

  function stop() {
    for (const h of local.values()) { try { h.server?.stop(); } catch { /* best effort */ } }
    for (const g of gpu.values()) g.waker.stop();
  }

  return { transcribe, stop, boot };
}
