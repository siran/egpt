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
//   whisper-cli           — per-note binary spawn; the always-available floor.
//
// Per-note re-try from the top means a recovered remote is used again with no /restart.
// onTransition fires ONLY when the winning engine changes (degrade or recover) — so a busy
// voice-note chat doesn't flood Self. All side-effecting deps are injected (testable).

export function buildTranscriptionPipeline({
  profile,
  transcribeViaEndpoint,          // (audioPath, {endpoint, keyB64, timeoutMs}, log, meta) -> transcript (throws on fail)
  startWhisperServer,             // async ({command, model, host, port, language, extraArgs, antiRepetition, onLog}) -> {url, stop}
  makeWhisperServerTranscriber,   // ({url, ffmpeg, language}) -> (audioPath, cfg, log, meta) -> transcript
  cli,                            // transcribeAudioFile(audioPath, cfg, log, meta) -> transcript
  now = () => Date.now(),
  onTransition = () => {},        // ({from, to, recovered}) -> void
  onLog = () => {},
} = {}) {
  const order = Array.isArray(profile?.fallback_order) ? profile.fallback_order : [];
  const engines = order.map((name) => ({ name, ...(profile?.[name] || {}) }));
  const idxOf = (name) => order.indexOf(name);

  const breaker = new Map();       // remote name -> downUntil (ms)
  const local = new Map();         // local name -> { server, transcribe, starting, error }
  let lastWinner = null;

  async function tryRemote(eng, audioPath, log, meta) {
    const downUntil = breaker.get(eng.name);
    if (downUntil && downUntil > now()) return null;            // in cooldown — skip fast
    try {
      const t = await transcribeViaEndpoint(
        audioPath, { endpoint: eng.endpoint, keyB64: eng.token, timeoutMs: eng.timeout_ms ?? 4000 }, log, meta);
      breaker.delete(eng.name);                                  // healthy again
      return t || null;
    } catch (e) {
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
        h.transcribe = makeWhisperServerTranscriber({ url: s.url, ffmpeg: eng.ffmpeg_command, language: eng.language });
        onLog(`pipeline: local "${eng.name}" resident at ${s.url}`);
      }).catch((e) => { h.starting = false; h.error = e; onLog(`pipeline: local "${eng.name}" spawn failed: ${e?.message ?? e}`); });
      return null;                                               // warming → fall through (cli covers the gap)
    }
    if (!h.transcribe) return null;                              // still warming / failed → fall through
    try { return (await h.transcribe(audioPath, cfg, log, meta)) || null; }
    catch (e) { onLog(`pipeline: local "${eng.name}" transcribe failed: ${e?.message ?? e}`); return null; }
  }

  async function tryCli(eng, audioPath, log, meta) {
    try { return (await cli(audioPath, eng, log, meta)) || null; }
    catch (e) { onLog(`pipeline: cli "${eng.name}" failed: ${e?.message ?? e}`); return null; }
  }

  async function transcribe(audioPath, cfg = {}, log = () => {}, meta = null) {
    for (const eng of engines) {
      let t = null;
      if (eng.type === 'whisper-server-remote') t = await tryRemote(eng, audioPath, log, meta);
      else if (eng.type === 'whisper-server-local') t = await tryLocal(eng, audioPath, cfg, log, meta);
      else if (eng.type === 'whisper-cli') t = await tryCli(eng, audioPath, log, meta);
      else { onLog(`pipeline: "${eng.name}" has unknown type "${eng.type}" — skipping`); continue; }
      if (t) {
        if (lastWinner && lastWinner !== eng.name) {
          onTransition({ from: lastWinner, to: eng.name, recovered: idxOf(eng.name) < idxOf(lastWinner) });
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
