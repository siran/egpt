// warm-sessions.mjs — lazy-warm pool of persistent brain sessions.
//
// feat/sibling-reply. Holds open `createWarmSession()` instances keyed by a
// stable key (one per conversation-e thread, system-e, or sibling). Policy
// (operator 2026-06-10):
//   - LAZY: a key warms on its FIRST turn; reused (warm) thereafter.
//   - IDLE-EVICT: after `idleTtl` with no turn, the session is closed — freeing
//     the Node process + context RAM. Never keep every conversation-e warm.
//     Per-class TTL: system=persistent (-1), conversation=short follow-up window,
//     sibling=medium. HOUSE DIALECT (operator 2026-07-26, as posts_back_delay_ms
//     and guard.turns): -1 = never idle-evict, 0 = always evict (at turn end), N ms.
//     PER-RUN OVERRIDE (operator 2026-07-02: "keep any conversation as a
//     background agent 15m after the last message, configurable … honor override
//     per configuration"): run() takes an optional `idleTtlMs` that stamps THIS
//     entry's own TTL, overriding the class TTL (same dialect). It is
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
  idleTtlMs = 180_000,               // fallback for an unlisted class — absent NEVER means 0
  idleTtlByClass = {},
  dispatchTimeoutMs = 600_000,
  injectWhileBusy = true,            // master switch for steer() — weave a mid-turn message into the live turn
  onLog = () => {},
  makeSession,                       // REQUIRED: the warm-session factory (injected)
} = {}) {
  if (typeof makeSession !== 'function') {
    throw new Error('createWarmPool: makeSession factory is required (e.g. createWarmCliSession)');
  }
  const _s = new Map();   // key -> { session, klass, lastUsed, idleTimer, busy, errored, chain }

  const _ttlFor = (klass) => {
    const v = idleTtlByClass?.[klass];
    return v === undefined ? idleTtlMs : v;   // absent class → the pool default, never 0
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
    const ttl = e.idleTtlMs ?? _ttlFor(e.klass);   // per-run override wins (null/undefined = none)
    if (ttl < 0) return;                            // -1 = never idle-evict, stay warm forever
    if (ttl === 0) { _evict(key, 'idle ttl 0'); return; }   // 0 = always evict, never kept warm
    e.idleTimer = setTimeout(() => _evict(key, `idle ${ttl}ms`), ttl); e.idleTimer.unref?.();
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
    e.injectSeq = 0;   // reset the per-turn injection counter (see steer)
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
  // `idleTtlMs` (optional) overrides that class TTL for this entry (-1 never, 0 always, N ms).
  function run(key, message, onUpdate = () => {}, { brainOptions = {}, klass = 'sibling', timeoutMs, idleTtlMs } = {}) {
    let e = _s.get(key);
    if (e && e.errored) { _evict(key, 'reopen after error'); e = null; }
    // SESSION-IDENTITY GUARD (operator 2026-06-21): a warm entry stays bound to
    // whatever claude session it opened/resumed. The conversation/E key omits the
    // session id (unlike the sibling key `sib:name:session_id`), so a re-pin on
    // the SAME key — `/agents reset <handle>` nulling the thread, or the
    // out-of-process compactor reseeding it to a new session — would otherwise be
    // silently ignored: the pool keeps resuming the STALE session. That was the
    // SPOILER bug (a fresh-thread reset rebooted straight back onto the 4 MB /
    // 0-boundary session). If the caller
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
    // The INJECT-INTO-RUNNING-TURN block that used to sit HERE (operator 2026-06-13) now
    // lives in `steer()` below — MOVED, not duplicated, and for one reason: it fired on
    // `e.busy` alone, i.e. on WHO GOT THERE SECOND rather than on anyone's intent. That was
    // harmless only while it was dead (no session exported `inject` until 2026-08-30). The
    // moment createWarmCliSession gained one, EVERY caller that reaches a busy key would
    // have started weaving: compaction's `/compact` (whose own header promises it "queues
    // behind any in-flight turn ... never woven into one"), a due heartbeat, a mesh
    // responder — each of them landing an unrelated prompt inside a human's live turn AND
    // getting `{text:null}` back as its own answer. Weaving is now something a caller ASKS
    // for, by name, once policy (conversation_defaults.allow_new_input) has said it may.
    if (!e) {
      _lruEvictIfFull(key);
      e = { session: makeSession({ ...brainOptions, onLog }), klass, lastUsed: Date.now(), idleTimer: null, busy: false, errored: false, chain: Promise.resolve(), idleTtlMs: undefined };
      _s.set(key, e);
      onLog(`warm: opened ${key} (klass=${klass}); size=${_s.size}/${max}`);
    }
    // Stamp the per-run idle override whenever the caller SPECIFIES one (undefined =
    // "leave as stamped", so the compactor's own pool.run, which omits it, never
    // clobbers the ttl the last real turn set). A changed config re-stamps here, so
    // it takes effect on the NEXT _armIdle. null = no override (fall to the class TTL).
    if (idleTtlMs !== undefined) e.idleTtlMs = idleTtlMs;
    const p = e.chain.then(() => _doTurn(key, message, onUpdate, timeoutMs ?? dispatchTimeoutMs));
    e.chain = p.then(() => {}, () => {});   // keep the per-key chain alive across failures
    return p;
  }

  // STEER — weave `message` into the turn ALREADY streaming on `key`, instead of queueing a
  // fresh turn behind it (the mechanism: operator 2026-06-13; this explicit shape + the
  // measurement that proves the CLI supports it: operator 2026-08-30, see
  // warm-cli-session.mjs's header). The live turn's single `result` carries the combined
  // reply, so there is NOTHING to return here beyond "did it take" — no promise, no text.
  //
  // INJECTED-OR-NOTHING, and that is the whole contract. It NEVER opens a session, never
  // queues, never runs a turn. `false` means the message was not touched at all, so the
  // caller's fallback is simply "do what you would have done anyway" — the spine's
  // openAndRunReply, i.e. today's per-conversation FIFO, placeholder and all. That is what
  // makes the fallthrough structurally safe rather than a lost reply: were this to fall
  // through to a real turn (as the run()-embedded version did), a caller that opened no
  // placeholder — because it expected a weave — would have a turn nobody delivers.
  //
  // Four ways to get false, all of them "there was nothing to steer": no warm entry, the
  // entry is idle (the turn ended between the caller's check and this call — the race),
  // the entry is errored, or the session exports no `inject`. THAT LAST ONE IS THE BRAIN-
  // AGNOSTIC GUARD: llama is plain HTTP request/response with no stream to interrupt, and
  // pi is a different harness the 2026-08-30 measurement never covered — neither exports
  // `inject`, so both land here and queue exactly as they do today, with no per-brain
  // branching anywhere above.
  function steer(key, message) {
    if (!injectWhileBusy) return false;               // pool-level master switch (off = never weave)
    const e = _s.get(key);
    if (!e || !e.busy || e.errored) return false;
    if (typeof e.session.inject !== 'function') return false;
    if (!e.session.inject(message)) return false;
    e.lastUsed = Date.now();
    onLog(`warm: steered into the running turn ${key}`);
    return true;
  }

  function has(key) { return _s.has(key); }
  function evict(key) { _evict(key, 'manual'); }
  function close() { for (const k of [..._s.keys()]) _evict(k, 'pool close'); }
  function stats() { return { size: _s.size, max, keys: [..._s.keys()] }; }

  return { run, steer, has, evict, close, stats };
}
