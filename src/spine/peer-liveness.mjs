// peer-liveness.mjs — IS MY PEER SPINE ALIVE? Answered by OBSERVATION, never by negotiation.
//
// WHY IT EXISTS (operator 2026-09-02). Two spines now fit on one machine — one in Session 0
// holding the agent's Beeper, one in Session 1 holding the operator's — and on a forced restart
// only the Session 0 one exists, because Session 1 needs a human to log in. The operator's
// ruling: *"say computer force-restarts, then kg's s0 (rodz) can recognize E as a fallback
// handle since there is no S1 process (an is not there)"*. So the S0 spine should ASSUME the
// peer's handle while the peer is absent, and give it back when the peer returns.
//
// THE POINT IS THAT NOTHING IS NEGOTIATED. Two independent processes cannot both decide to
// answer without either talking or being told in advance who answers — but "is my peer alive?"
// is a LOCAL OBSERVATION, not a protocol. One spine probes the other's console port. No
// messages, no election, no split-brain algorithm to get wrong. It is the same primitive as
// `fallback_handle`'s `unless_present` (same rule, different predicate) and as
// whisper-server.mjs's adoption probe (look at the port, believe what answers).
//
// ASYMMETRIC HYSTERESIS, and this is the whole safety argument. The two directions are NOT
// equally dangerous:
//   - Believing the peer is alive when it is dead costs SILENCE. Nobody answers for a moment.
//   - Believing the peer is dead when it is alive costs a DOUBLE ANSWER — the exact failure the
//     account split was built to end, visible to everyone in the chat, from two accounts.
// So: YIELD EAGERLY, CLAIM RELUCTANTLY. One probe saying "alive" hands the handle back
// immediately; it takes `claimAfter` consecutive probes saying "dead" to take it. The operator
// accepted the remaining window as "a bit of a log-in stutter" — this makes that stutter as
// short as observation allows while never trading it for a duplicate reply.
//
// STARTS SILENT. Before the first probe returns, the peer is presumed ALIVE. A spine that has
// not yet looked must not speak on a handle that might not be its own; the cost is one probe
// interval of silence on a cold start, which is the cheap direction.

const DEFAULT_EVERY_MS = 5_000;
const DEFAULT_CLAIM_AFTER = 3;

/**
 * @param {object} deps
 * @param {() => Promise<boolean>} deps.probe   the observation — true = the peer answered.
 *   boot supplies a TCP connect to the peer's console port (shell.port). It must never throw;
 *   a throw is treated as "dead", which is the honest reading of an unanswered probe.
 * @param {number} [deps.everyMs]      probe interval. Default 5s.
 * @param {number} [deps.claimAfter]   consecutive DEAD probes before claiming the handle.
 *   Yielding always takes exactly ONE live probe — see the asymmetry above.
 * @param {typeof setInterval} [deps.setIntervalFn]   test seams; real timers by default.
 * @param {typeof clearInterval} [deps.clearIntervalFn]
 * @param {(m: string) => void} [deps.onLog]
 * @returns {{ isAlive: () => boolean, isClaiming: () => boolean, tick: () => Promise<void>,
 *             start: () => void, stop: () => void }}
 *   `isAlive()` is the peer's state; `isClaiming()` is its negation, named for the caller that
 *   cares — the router asks "may I answer on the fallback handle?", not "how is my peer?".
 */
export function createPeerLiveness({
  probe,
  everyMs = DEFAULT_EVERY_MS,
  claimAfter = DEFAULT_CLAIM_AFTER,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onLog = () => {},
} = {}) {
  if (typeof probe !== 'function') throw new Error('createPeerLiveness: probe is required');
  const needed = Number.isInteger(claimAfter) && claimAfter > 0 ? claimAfter : DEFAULT_CLAIM_AFTER;

  // Presumed alive until observed otherwise — see STARTS SILENT above.
  let alive = true;
  let deadStreak = 0;
  let timer = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    let up = false;
    // The probe owns its own failures; a throw here is an unanswered probe, which is "dead".
    try { up = !!(await probe()); } catch { up = false; }

    if (up) {
      deadStreak = 0;
      // YIELD EAGERLY: one live probe is enough to hand the handle straight back.
      if (!alive) { alive = true; onLog('peer is back — yielding its fallback handle'); }
      return;
    }

    deadStreak += 1;
    if (alive && deadStreak >= needed) {
      alive = false;
      onLog(`peer has not answered ${deadStreak} consecutive probes — claiming its fallback handle`);
    }
  };

  return {
    isAlive: () => alive,
    isClaiming: () => !alive,
    // Exposed so the caller (and the tests) can force an observation without waiting a tick.
    tick,
    start() {
      if (timer || stopped) return;
      timer = setIntervalFn(() => { void tick(); }, everyMs);
      // Never hold the process open for a liveness probe.
      timer?.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) { clearIntervalFn(timer); timer = null; }
    },
  };
}

/**
 * The real observation: does anything answer on the peer's console port?
 *
 * A bare TCP connect, NOT the console handshake — this asks "is a spine serving there", and a
 * spine that is up but would refuse our token is still a spine that will answer the chat. It
 * also means the probe needs no secret, so a liveness check can never leak one.
 *
 * @param {object} o
 * @param {number} o.port                  the peer's console port (its `shell.port`)
 * @param {string} [o.host]                loopback by default — the peer is on this machine
 * @param {number} [o.timeoutMs]
 * @param {typeof import('node:net')} [o.net]   injection seam for tests
 * @returns {() => Promise<boolean>}
 */
export function tcpProbe({ port, host = '127.0.0.1', timeoutMs = 1500, net = null } = {}) {
  return async () => {
    const mod = net ?? (await import('node:net'));
    return await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch { /* already gone */ } resolve(v); } };
      const sock = mod.connect({ port, host });
      sock.setTimeout?.(timeoutMs);
      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false));
      sock.once('error', () => finish(false));
    });
  };
}
