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
//     and loop_guard.inbound.turns): -1 = never idle-evict, 0 = always evict (at turn end), N ms.
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
//   - BACKGROUND WORK (2026-10-15): a session whose background tasks are still running
//     (session.background > 0) is NEVER idle- or LRU-evicted — closing it kills them, and that is
//     not the bridge's to decide (operator 2026-10-15); the spine asks the being instead (liveness).
//     Its completion report goes up through onBackgroundDone(key, info).
//   - KEEP (2026-10-22): keepWarm(key) true (the conversation's warm.keep, asked live) — never idle- or
//     LRU-evicted, the same holds as background work; a stop, re-pin, reconfigure or failure still ends it.
//   - ADOPT (2026-10-16): a process the daemon held across a spine restart (src/cli-host.mjs) is
//     put back as its key's entry — adopt(), no spawn.
//
// Brain-agnostic over the warm primitive: the session factory is INJECTED. egpt
// wires `createWarmCliSession` — a resident `claude` CLI background agent (no
// SDK — I11). Callers that want a non-warmable brain keep using the cold
// `stream()` path.

import { isDeepStrictEqual } from 'node:util';

const BACKGROUND_RECHECK_MS = 60_000;   // re-check for an always-evict (ttl 0) session held for background work

// The options a session keeps from its spawn: all but the session id (its own guard) and the being
// link (minted per turn). Only these three are logged with their values — the rest may hold a secret.
const NOT_SPAWN = new Set(['sessionId', 'beingLink']);
const SHOWN = new Set(['model', 'effort', 'verboseThinking']);
const spawnOptions = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !NOT_SPAWN.has(k) && typeof v !== 'function'));
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const _describe = (changes, opened) => Object.keys(changes).map((k) => (SHOWN.has(k) ? `${k} ${opened[k] ?? 'unset'}→${changes[k]}` : k)).join(', ');

export function createWarmPool({
  max = 6,
  idleTtlMs = 180_000,               // fallback for an unlisted class — absent NEVER means 0
  idleTtlByClass = {},
  dispatchTimeoutMs = 600_000,
  injectWhileBusy = true,            // master switch for steer() — weave a mid-turn message into the live turn
  onBackgroundDone = null,           // (key, { summaries }) — a session's background task finished with no turn in flight
  keepWarm = () => false,            // (key) → true: never idle- or LRU-evicted (warm.keep)
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

  // WHY THE ENTRY IS BEING THROWN AWAY, and it is NOT always "the turn failed" (operator
  // 2026-09-11). The commonest eviction on the live node is a cold spawn whose `--resume`
  // target the CLI no longer has: the process dies BEFORE the model is reached, so no turn ran,
  // nothing the human said was lost, and brainpool.mjs resets the thread and retries fresh on
  // the spot. `turn failed` claimed the being had failed when it had not, in the one line the
  // operator ever sees about it — and it also dropped the error's own text, so the log said a
  // turn had failed and never said why. Both are fixed here.
  //
  // THE SESSION MARKS IT, NOT THIS POOL. warm-cli-session.mjs sets `resumeTargetMissing` on
  // that one error; nothing here sniffs a vendor sentence, so a brain that resumes nothing
  // (llama's HTTP, pi) keeps exactly today's wording.
  function _whyEvicted(err) {
    const msg = String(err?.message ?? err ?? '').trim();
    if (err?.resumeTargetMissing) return `the --resume target is gone, so no turn ran${msg ? `: ${msg}` : ''}`;
    return msg ? `turn failed: ${msg}` : 'turn failed';
  }

  // Idle, but background work is still running or the conversation keeps it warm: held and re-checked.
  function _idleOut(key, ttl) {
    const e = _s.get(key);
    if (!e) return;
    const n = e.session.background ?? 0;
    if (n > 0 || keepWarm(key)) {
      onLog(`warm: kept ${key} past idle — ${n > 0 ? `${n} background task(s) still running` : 'warm.keep'}`);
      e.idleTimer = setTimeout(() => _idleOut(key, ttl), ttl || BACKGROUND_RECHECK_MS); e.idleTimer.unref?.();
      return;
    }
    _evict(key, ttl === 0 ? 'idle ttl 0' : `idle ${ttl}ms`);
  }

  function _backgroundDone(key, info) {
    if (!_s.has(key)) return;
    onLog(`warm: ${(info?.reply ?? info?.lost) != null ? 'an adopted turn' : 'background work'} finished on ${key} with no turn in flight`);
    try { Promise.resolve(onBackgroundDone(key, info)).catch((err) => onLog(`warm: background wake ${key} failed: ${err?.message ?? err}`)); }
    catch (err) { onLog(`warm: background wake ${key} failed: ${err?.message ?? err}`); }
  }

  function _armIdle(key) {
    const e = _s.get(key);
    if (!e) return;
    if (e.idleTimer) clearTimeout(e.idleTimer);
    const ttl = e.idleTtlMs ?? _ttlFor(e.klass);   // per-run override wins (null/undefined = none)
    if (ttl < 0) return;                            // -1 = never idle-evict, stay warm forever
    if (ttl === 0) { _idleOut(key, 0); return; }            // 0 = always evict, never kept warm
    e.idleTimer = setTimeout(() => _idleOut(key, ttl), ttl); e.idleTimer.unref?.();
  }

  function _lruEvictIfFull(exceptKey) {
    while (_s.size >= max) {
      let victim = null, oldest = Infinity;
      for (const [k, e] of _s) {
        if (k === exceptKey || e.busy || e.session.background > 0 || keepWarm(k)) continue;
        if (e.lastUsed < oldest) { oldest = e.lastUsed; victim = k; }
      }
      if (!victim) break;   // everything is busy or kept — let it grow over `max`
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
      if (e.reconfig) {
        const changes = e.reconfig;
        e.reconfig = null;
        await e.session.reconfigure(changes);
        onLog(`warm: configuration applied to the live process on ${key} (${_describe(changes, e.opened)})`);
        Object.assign(e.opened, changes);
      }
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
      // An operator stop (/agents stop) ends the turn, not the session: it stays warm. So does a
      // configuration the live process refused: it keeps the one it has.
      if (!err?.interrupted && !err?.reconfigure) {
        e.errored = true;
        e.failure = err;   // kept only so the eviction below can say WHAT went wrong
      }
      throw err;
    } finally {
      e.busy = false;
      e.inFlight = null;
      const failed = _s.get(key);
      if (failed?.errored) _evict(key, _whyEvicted(failed.failure)); else _armIdle(key);
    }
  }

  // Run a turn on the warm session for `key`, opening it lazily. brainOptions is
  // passed to the warm primitive (model, sessionId/resume, cwd, allowedTools,
  // confineToDirs, …). klass ∈ {system, conversation, sibling} selects the TTL;
  // `idleTtlMs` (optional) overrides that class TTL for this entry (-1 never, 0 always, N ms).
  function run(key, message, onUpdate = () => {}, { brainOptions = {}, klass = 'sibling', timeoutMs, idleTtlMs, retried = false } = {}) {
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
    // CONFIGURATION GUARD (operator 2026-09-17), the same shape one field over. A warm process
    // takes its options at SPAWN (argv, system prompt, sandbox, …), and the key does not carry them — so a conversation
    // repointed at another configuration (conversations.yaml agents.<being>.configuration, or a
    // config.yaml edit) kept running on the old one for as long as its process stayed warm. If the
    // caller now asks for any spawn option other than the one this entry was opened with, evict
    // and reopen: the same sessionId is passed again, so the thread resumes on the new engine.
    // Idle-only, like the guard above. Gated on a STATED value: a caller that names none
    // (compaction's `/compact` passes no effort, and a null model when the def has none) is asking
    // for whatever is warm, not for "unset". Live background work defers the reopen (step B).
    // What the live process takes in place (session.reconfigurable — measured control requests) is
    // applied before the next turn, process and background work untouched; only the rest reopens.
    if (e && !e.errored && !e.busy) {
      const changed = Object.keys(spawnOptions(brainOptions)).filter((k) => brainOptions[k] != null && !isDeepStrictEqual(brainOptions[k], e.opened[k] ?? null));
      const live = changed.filter((k) => e.session.reconfigurable?.has(k));
      const rest = changed.filter((k) => !live.includes(k));
      const n = e.session.background ?? 0;
      if (rest.length && !n) { _evict(key, `configuration changed: ${_describe(pick(brainOptions, changed), e.opened)}`); e = null; }
      else {
        if (rest.length) onLog(`warm: configuration changed on ${key} (${_describe(pick(brainOptions, rest), e.opened)}) — reopen deferred: ${n} background task(s) still running`);
        if (live.length) e.reconfig = { ...e.reconfig, ...pick(brainOptions, live) };
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
      // `opened` is what the CONFIGURATION GUARD above compares against: the options this
      // process was spawned with, kept on the entry because not every session exposes its own.
      const seam = onBackgroundDone ? { onBackgroundDone: (info) => _backgroundDone(key, info) } : {};
      const opened = spawnOptions(brainOptions);
      // `pool`: what a daemon-held process needs to be adopted back into an entry like this one (boot).
      e = { session: makeSession({ ...brainOptions, onLog, ...seam, pool: { key, klass, idleTtlMs, opened } }), klass, lastUsed: Date.now(), idleTimer: null, busy: false, errored: false, chain: Promise.resolve(), idleTtlMs: undefined, opened };
      _s.set(key, e);
      onLog(`warm: opened ${key} (klass=${klass}); size=${_s.size}/${max}`);
    }
    // Stamp the per-run idle override whenever the caller SPECIFIES one (undefined =
    // "leave as stamped", so the compactor's own pool.run, which omits it, never
    // clobbers the ttl the last real turn set). A changed config re-stamps here, so
    // it takes effect on the NEXT _armIdle. null = no override (fall to the class TTL).
    if (idleTtlMs !== undefined) e.idleTtlMs = idleTtlMs;
    e.runs = (e.runs ?? 0) + 1;   // in flight + queued, read by pending()
    // A session that never answered is already evicted (_doTurn): the same turn, once, on a fresh process.
    const p = e.chain.then(() => _doTurn(key, message, onUpdate, timeoutMs ?? dispatchTimeoutMs)).catch((err) => {
      if (!err?.unresponsive || retried) throw err;
      onLog(`warm: ${key} never answered — the turn runs once more on a fresh process, same thread`);
      return run(key, message, onUpdate, { brainOptions, klass, timeoutMs, idleTtlMs, retried: true });
    });
    const settled = () => { e.runs--; };
    e.chain = p.then(settled, settled);   // keep the per-key chain alive across failures
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
  //
  // AND EVERY REFUSAL IS SAID OUT LOUD, AND NONE OF THEM IS A SUCCESS (operator 2026-09-09,
  // after `Joyce Vicente-2606301852` swallowed ~90 minutes of messages behind four confident
  // 👀s). `e.busy` is A FLAG THIS FILE SETS, not liveness, and `inject`'s old `true` was a
  // successful WRITE to a live pipe, not a read — so this function could report a weave into a
  // turn that had already ended and nothing anywhere disagreed. It now returns `false` (nothing
  // was handed over — the caller queues, exactly as before) or `{ ack }`, the session's promise
  // of what the MODEL did with it, and it names the reason on every path that is not the happy
  // one. "we need to improve error handling, and that no error is swallowed silently".
  //
  // NO TIMER ANYWHERE. `ack` settles from CLI events only (warm-cli-session.mjs): the CLI's own
  // replay of the line, or the turn ending/failing/exiting/closing without one. A session that
  // does neither is wedged, and the missing 👀 in the chat is how that is reported.
  async function steer(key, message) {
    if (!injectWhileBusy) return false;               // pool-level master switch (off = never weave)
    const e = _s.get(key);
    if (!e) { onLog(`warm: steer FAILED ${key} — no warm entry for that key; the caller believed a turn was live here`); return false; }
    if (e.errored) { onLog(`warm: steer FAILED ${key} — the session is errored and about to be evicted`); return false; }
    if (!e.busy) { onLog(`warm: steer FAILED ${key} — no turn is in flight (it ended between the caller's check and this call)`); return false; }
    // Brain-agnostic guard, unchanged in effect: llama is request/response with no stream to
    // interrupt and pi is a harness nobody has measured. Neither exports `inject`, so neither
    // can be steered — but a conversation configured to steer one of them is a misconfiguration
    // the operator should be able to read, not a silent queue.
    if (typeof e.session.inject !== 'function') { onLog(`warm: steer FAILED ${key} — this brain cannot be steered (the session exports no inject)`); return false; }
    const handed = e.session.inject(message);
    if (!handed) { onLog(`warm: steer FAILED ${key} — the session refused the line (closed, no process, or the stdin write threw)`); return false; }
    e.lastUsed = Date.now();
    onLog(`warm: handed to the live turn ${key} — awaiting the model's acknowledgement`);
    const ack = Promise.resolve(handed.ack ?? { ok: false, reason: 'this session gives no acknowledgement' }).then((r) => {
      if (r?.ok) onLog(`warm: the model ACKNOWLEDGED the steered message ${key}`);
      else onLog(`warm: steer NOT INGESTED ${key} — the write landed and the model never took it (${r?.reason ?? 'no reason given'})`);
      return r ?? { ok: false, reason: 'no answer' };
    });
    return { ack };
  }

  // STOP the turn in flight on `key` (/agents stop). The session's own interrupt when it has one
  // (process, session id and the queued runs behind it all kept); a session without one, or one
  // that has not ended the turn within `graceMs`, is ended instead — the next run reopens on the
  // same session id. Never touches another key.
  async function interrupt(key, { graceMs = 5_000 } = {}) {
    const e = _s.get(key);
    if (!e || !e.busy) return { stopped: false };
    if (typeof e.session.interrupt !== 'function') { _evict(key, 'operator stop'); return { stopped: 'evict' }; }
    const ended = e.session.interrupt();
    if (!ended) return { stopped: false };            // the turn ended between busy and here
    let timer;
    const inTime = await Promise.race([
      Promise.resolve(ended).then(() => true),
      new Promise((r) => { timer = setTimeout(() => r(false), graceMs); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
    if (inTime) { onLog(`warm: interrupted ${key} (operator stop)`); return { stopped: 'interrupt' }; }
    if (_s.get(key) === e) _evict(key, `operator stop: interrupt not honoured in ${graceMs}ms`);
    return { stopped: 'evict' };
  }

  // A process the daemon held across a spine restart (src/cli-host.mjs) becomes this key's entry
  // again: no spawn, no --resume. brainOptions carries the adopted process (`adopt`); an adopted turn
  // still running keeps the entry busy until it ends.
  function adopt(key, { brainOptions = {}, klass = 'sibling', idleTtlMs, opened = {} } = {}) {
    if (_s.has(key)) { onLog(`warm: adopt ${key} refused — the key is already open`); return false; }
    const seam = onBackgroundDone ? { onBackgroundDone: (info) => _backgroundDone(key, info) } : {};
    const o = { ...opened };
    const e = { session: makeSession({ ...brainOptions, onLog, ...seam, pool: { key, klass, idleTtlMs, opened: o } }), klass, lastUsed: Date.now(), idleTimer: null, busy: false, errored: false, chain: Promise.resolve(), idleTtlMs, opened: o };
    _s.set(key, e);
    const orphan = e.session.orphan;
    onLog(`warm: adopted ${key} (klass=${klass}${orphan ? ', a turn still running' : ''}); size=${_s.size}/${max}`);
    if (!orphan) { _armIdle(key); return true; }
    e.busy = true;
    e.chain = Promise.resolve(orphan).then(() => {}, () => {}).then(() => { e.busy = false; if (_s.get(key) === e) _armIdle(key); });
    return true;
  }

  function has(key) { return _s.has(key); }
  function background(key) { return _s.get(key)?.session.backgroundTasks ?? []; }
  function busy(key) { return _s.get(key)?.busy === true; }
  // Runs on `key` not yet settled (in flight + queued). A run's caller resumes already uncounted.
  function pending(key) { return _s.get(key)?.runs ?? 0; }
  function evict(key) { _evict(key, 'manual'); }
  function close() { for (const k of [..._s.keys()]) _evict(k, 'pool close'); }
  function stats() { return { size: _s.size, max, keys: [..._s.keys()] }; }

  return { run, adopt, steer, interrupt, has, busy, pending, background, evict, close, stats };
}
