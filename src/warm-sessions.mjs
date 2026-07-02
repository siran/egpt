// warm-sessions.mjs — lazy-warm pool of persistent brain sessions.
//
// feat/sibling-reply. Holds open `createWarmSession()` instances keyed by a
// stable key (one per conversation-e thread, system-e, or sibling). Policy
// (operator 2026-06-10):
//   - LAZY: a key warms on its FIRST turn; reused (warm) thereafter.
//   - IDLE-EVICT: after `idleTtl` with no turn, the session is closed — freeing
//     the Node process + context RAM. Never keep every conversation-e warm.
//     Per-class TTL: system=persistent (0), conversation=short follow-up window,
//     sibling=medium. 0 = never idle-evict.
//     PER-RUN OVERRIDE (operator 2026-07-02: "keep any conversation as a
//     background agent 15m after the last message, configurable … honor override
//     per configuration"): run() takes an optional `idleTtlMs` that stamps THIS
//     entry's own TTL, overriding the class TTL (0 still = never evict). It is
//     re-stamped on every run that specifies one, so a changed per-conversation
//     config takes effect on the next turn; a run that OMITS it leaves the stamp
//     as-is (so the compactor's own pool.run never clobbers the last real turn's).
//   - maxWarm: hard ceiling → LRU-evict the least-recently-used. Memory is
//     bounded by `max`, NOT by total conversations.
//   - TIMEOUT: a turn with no result within `dispatchTimeoutMs` fails AND evicts
//     the session, so a hung/slow resume can never wedge the message queue.
//   - One turn at a time per key (the warm primitive requires it); turns on the
//     same key are serialized via a per-entry promise chain.
//
// Brain-agnostic over the warm primitive: the session factory is INJECTED. egpt
// wires `createWarmCliSession` — a resident `claude` CLI background agent (no
// SDK — I11). Callers that want a non-warmable brain keep using the cold
// `stream()` path.

export function createWarmPool({
  max = 6,
  idleTtlMs = 180_000,
  idleTtlByClass = {},
  dispatchTimeoutMs = 600_000,
  injectWhileBusy = true,            // weave a mid-turn message into the live turn
  onLog = () => {},
  makeSession,                       // REQUIRED: the warm-session factory (injected)
} = {}) {
  if (typeof makeSession !== 'function') {
    throw new Error('createWarmPool: makeSession factory is required (e.g. createWarmCliSession)');
  }
  const _s = new Map();   // key -> { session, klass, lastUsed, idleTimer, busy, errored, chain }

  const _ttlFor = (klass) => {
    const v = idleTtlByClass?.[klass];
    return v === undefined ? idleTtlMs : v;   // 0 = never idle-evict
  };

  function _evict(key, why) {
    const e = _s.get(key);
    if (!e) return;
    _s.delete(key);
    if (e.idleTimer) clearTimeout(e.idleTimer);
    try { e.session.close(); } catch { /* already closing */ }
    onLog(`warm: evicted ${key} (${why}); size=${_s.size}/${max}`);
  }

  function _armIdle(key) {
    const e = _s.get(key);
    if (!e) return;
    if (e.idleTimer) clearTimeout(e.idleTimer);
    const ttl = e.idleTtlMs ?? _ttlFor(e.klass);   // per-run override wins; 0 = never idle-evict
    if (ttl > 0) { e.idleTimer = setTimeout(() => _evict(key, `idle ${ttl}ms`), ttl); e.idleTimer.unref?.(); }
  }

  function _lruEvictIfFull(exceptKey) {
    while (_s.size >= max) {
      let victim = null, oldest = Infinity;
      for (const [k, e] of _s) {
        if (k === exceptKey || e.busy) continue;
        if (e.lastUsed < oldest) { oldest = e.lastUsed; victim = k; }
      }
      if (!victim) break;   // everything is busy — let it grow over `max` briefly
      _evict(victim, 'maxWarm LRU');
    }
  }

  async function _doTurn(key, message, onUpdate, _limit) {
    const e = _s.get(key);
    if (!e || e.errored) throw new Error('warm: session unavailable');
    e.busy = true;
    e.injectSeq = 0;   // reset the per-turn injection counter (see run/INJECT)
    // NEVER evict while thinking. An idle timer armed after the PREVIOUS turn
    // must not fire mid-turn and close a busy session (that would end the query
    // mid-turn). Idle = time since the last turn ENDED, so clear any pending idle
    // timer now; _armIdle re-arms it in finally once this turn completes. (LRU
    // already skips busy; the per-turn timeout was removed.)
    if (e.idleTimer) { clearTimeout(e.idleTimer); e.idleTimer = null; }
    try {
      // NO turn timeout. A warm claude session stays open INDEFINITELY (like the
      // CLI) — a turn runs as long as it needs: thinking, long answers, slow
      // models. The old fake timeout guillotined legit turns AND evicted the
      // warm session (operator 2026-06-12: "claude code cli can be open
      // indefinitely … this is a fake timeout"). Only a genuine session error
      // (thrown by .turn) evicts. `_limit` kept for signature compat, unused.
      const res = await e.session.turn(message, onUpdate);
      e.lastUsed = Date.now();
      return res;
    } catch (err) {
      e.errored = true;
      throw err;
    } finally {
      e.busy = false;
      e.inFlight = null;
      if (_s.get(key)?.errored) _evict(key, 'turn failed'); else _armIdle(key);
    }
  }

  // Run a turn on the warm session for `key`, opening it lazily. brainOptions is
  // passed to the warm primitive (model, sessionId/resume, cwd, allowedTools,
  // confineToDirs, …). klass ∈ {system, conversation, sibling} selects the TTL;
  // `idleTtlMs` (optional) overrides that class TTL for this entry (0 = never evict).
  function run(key, message, onUpdate = () => {}, { brainOptions = {}, klass = 'sibling', timeoutMs, idleTtlMs } = {}) {
    let e = _s.get(key);
    if (e && e.errored) { _evict(key, 'reopen after error'); e = null; }
    // SESSION-IDENTITY GUARD (operator 2026-06-21): a warm entry stays bound to
    // whatever claude session it opened/resumed. The conversation/E key omits the
    // session id (unlike the sibling key `sib:name:session_id`), so a re-pin on
    // the SAME key — `/e new` nulling the thread, or the out-of-process compactor
    // reseeding it to a new session — would otherwise be silently ignored: the
    // pool keeps resuming the STALE session. That was the SPOILER bug (`/e new`
    // rebooted straight back onto the 4 MB / 0-boundary session). If the caller
    // now asks for a DIFFERENT session than the open one is bound to, evict so we
    // reopen on the requested id. Idle-only (never guillotine an in-flight turn);
    // gated on an explicit `sessionId` so callers that don't manage sessions are
    // untouched; acts only once the open session has a known id to compare.
    if (e && !e.errored && !e.busy && Object.prototype.hasOwnProperty.call(brainOptions, 'sessionId')) {
      const want = brainOptions.sessionId ?? null;
      const have = e.session?.sessionId ?? null;
      if (have && want !== have) {
        _evict(key, `session re-pinned (${String(have).slice(0, 8)}…→${want ? String(want).slice(0, 8) + '…' : 'fresh'})`);
        e = null;
      }
    }
    // INJECT-INTO-RUNNING-TURN (operator 2026-06-13): if a turn is already
    // streaming on this key, weave the new message into THAT live turn rather
    // than serializing a fresh turn behind it. The in-flight turn's single
    // result carries the combined reply, so this call resolves with an
    // `injected` marker and the caller emits nothing separately. Falls through
    // to the normal queued turn when the session can't inject or the turn just
    // ended (race: busy flipped false between the check and the push).
    if (injectWhileBusy && e && e.busy && !e.errored && typeof e.session.inject === 'function') {
      if (e.session.inject(message)) {
        e.lastUsed = Date.now();
        onLog(`warm: injected into running turn ${key}`);
        return Promise.resolve({ injected: true, text: null, sessionId: null });
      }
    }
    if (!e) {
      _lruEvictIfFull(key);
      e = { session: makeSession({ ...brainOptions, onLog }), klass, lastUsed: Date.now(), idleTimer: null, busy: false, errored: false, chain: Promise.resolve(), idleTtlMs: undefined };
      _s.set(key, e);
      onLog(`warm: opened ${key} (klass=${klass}); size=${_s.size}/${max}`);
    }
    // Stamp the per-run idle override whenever the caller SPECIFIES one (undefined =
    // "leave as stamped", so the compactor's own pool.run, which omits it, never
    // clobbers the ttl the last real turn set). A changed config re-stamps here, so
    // it takes effect on the NEXT _armIdle. 0 = never idle-evict.
    if (idleTtlMs !== undefined) e.idleTtlMs = idleTtlMs;
    const p = e.chain.then(() => _doTurn(key, message, onUpdate, timeoutMs ?? dispatchTimeoutMs));
    e.chain = p.then(() => {}, () => {});   // keep the per-key chain alive across failures
    return p;
  }

  function has(key) { return _s.has(key); }
  function evict(key) { _evict(key, 'manual'); }
  function close() { for (const k of [..._s.keys()]) _evict(k, 'pool close'); }
  function stats() { return { size: _s.size, max, keys: [..._s.keys()] }; }

  return { run, has, evict, close, stats };
}
