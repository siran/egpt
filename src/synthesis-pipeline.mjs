// synthesis-pipeline.mjs — declarative TTS fallback chain (mirrors
// transcription-pipeline.mjs's shape, drastically simpler: only ONE engine type
// exists today).
//
// A profile is { fallback_order: [<name>...], <name>: { type, ...cfg } }. For each
// reply we walk fallback_order and return the first engine that yields audio. Engine
// types:
//   piper-server-remote — POST to an endpoint (HMAC token). connect_timeout_ms fails
//                          fast on a dead worker; cooldown_ms is a circuit-breaker so
//                          a down remote is SKIPPED (not re-timed-out) every reply
//                          until the cooldown elapses.
//
// (An obvious future slot: a resident local piper process, mirroring transcription's
// whisper-server-local — not implemented here.)

export function buildSynthesisPipeline({
  profile,
  synthesizeViaEndpoint,          // (text, voice, {endpoint, keyB64, timeoutMs}, log) -> Buffer (throws on fail)
  reachable,                      // async (url, timeoutMs) -> bool — quick liveness probe (omit to skip probing)
  now = () => Date.now(),
  onLog = () => {},
} = {}) {
  const order = Array.isArray(profile?.fallback_order) ? profile.fallback_order : [];
  const engines = order.map((name) => ({ name, ...(profile?.[name] || {}) }));

  const breaker = new Map();       // engine name -> downUntil (ms)

  async function tryRemote(eng, text, voice, log) {
    const downUntil = breaker.get(eng.name);
    if (downUntil && downUntil > now()) return null;            // in cooldown — skip fast
    if (reachable && !(await reachable(eng.endpoint, eng.connect_timeout_ms ?? 3000))) {
      breaker.set(eng.name, now() + (eng.cooldown_ms ?? 30_000));
      onLog(`pipeline: remote "${eng.name}" unreachable — cooldown ${eng.cooldown_ms ?? 30_000}ms`);
      return null;
    }
    try {
      const audio = await synthesizeViaEndpoint(
        text, voice, { endpoint: eng.endpoint, keyB64: eng.token, timeoutMs: eng.timeout_ms ?? 20_000 }, log);
      breaker.delete(eng.name);                                 // healthy again
      return audio || null;
    } catch (e) {
      breaker.set(eng.name, now() + (eng.cooldown_ms ?? 30_000));
      onLog(`pipeline: remote "${eng.name}" failed (${e?.message ?? e}) — cooldown ${eng.cooldown_ms ?? 30_000}ms`);
      return null;
    }
  }

  async function synthesize(text, voice, log = () => {}) {
    for (const eng of engines) {
      let audio = null;
      if (eng.type === 'piper-server-remote') audio = await tryRemote(eng, text, voice, log);
      else { onLog(`pipeline: "${eng.name}" has unknown type "${eng.type}" — skipping`); continue; }
      if (audio) return audio;
    }
    return null;                                                 // every engine declined
  }

  return { synthesize };
}
