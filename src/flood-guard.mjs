// flood-guard.mjs — the bridge's LAST line of defense against a send flood.
//
// No chat should ever receive a burst of bot sends. A runaway — whatever the
// cause: a mesh re-relay loop, a being looping, a bad backlog replay — is caught
// HERE, at the send chokepoint, regardless of source. The bot↔bot loop-guard
// (C7.7) only sees the PROMPT path and only counts being-turns; this counts raw
// SENDS, so it catches floods the loop-guard structurally cannot (the 2026-06-19
// mesh loop posted as the operator and bypassed the loop-guard entirely).
//
// Rule: > `limit` sends to one chat within `windowMs` is not normal → PAUSE that
// chat (refuse further sends) for `cooldownMs`, log loudly. Fail-safe, not
// fail-deadly: a paused chat drops sends but the process stays up.

export function createFloodGuard({
  limit = 10,
  windowMs = 3_000,
  cooldownMs = 60_000,
  onTrip = () => {},
  now = Date.now,
} = {}) {
  const hits = new Map();    // chatId -> [ts] within the window
  const paused = new Map();  // chatId -> resume-at ts

  // true ⇒ send allowed; false ⇒ chat is flood-paused, caller must NOT send.
  function allow(chatId) {
    const key = String(chatId ?? '');
    const t = now();
    const until = paused.get(key);
    if (until != null) {
      if (t < until) return false;            // still paused
      paused.delete(key); hits.delete(key);   // cooldown elapsed → reset
    }
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    arr.push(t);
    hits.set(key, arr);
    if (arr.length > limit) {
      paused.set(key, t + cooldownMs);
      hits.delete(key);
      try { onTrip(key, arr.length, windowMs, cooldownMs); } catch { /* never let the alarm throw */ }
      return false;
    }
    return true;
  }

  function isPaused(chatId) { const u = paused.get(String(chatId ?? '')); return u != null && now() < u; }
  function resume(chatId) { const k = String(chatId ?? ''); paused.delete(k); hits.delete(k); }
  function resumeAll() { paused.clear(); hits.clear(); }
  function status() { return { paused: [...paused.keys()], limit, windowMs }; }

  return { allow, isPaused, resume, resumeAll, status };
}

// THE send path. Every bridge send MUST go through this — and it refuses to be
// constructed without a flood guard, so an unguarded send path cannot exist by
// accident. (This is the wiring the 2026-06-19 post-mortem said was missing: a
// guard that works in isolation but isn't in the path is false confidence.)
export function guardedSend({ send, floodGuard, log = () => {}, label = 'bridge' } = {}) {
  if (typeof send !== 'function') throw new Error('guardedSend: a send function is required');
  if (!floodGuard || typeof floodGuard.allow !== 'function') {
    throw new Error('guardedSend: a floodGuard is required — no send path may be unguarded');
  }
  return async (text, opts = {}) => {
    const chatId = opts?.chatId ?? opts?.chat_id ?? opts?.jid ?? '';
    if (!floodGuard.allow(chatId)) {
      log(`flood-guard: ⛔ ${label} send to ${chatId} BLOCKED — flood pause active`);
      return { blocked: true, reason: 'flood-pause' };
    }
    return send(text, opts);
  };
}
