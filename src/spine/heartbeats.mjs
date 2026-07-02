// heartbeats.mjs — the spine's cadence registry (SPINE-REWRITE-PLAN.md §2c). A
// heartbeat is a named function the loop's tick() runs on a fixed cadence. The
// registry is deliberately dumb: no scheduler, no drift correction, no
// priorities — tick() calls runDue(now) every tickMs and each entry fires once
// enough time has elapsed. Cadences therefore RIDE the tick; a cadence finer than
// tickMs can't be honored (boot sizes tickMs below the finest cadence).
//
// This is load-bearing: the alive-file writer is the FIRST registered heartbeat
// (operator 2026-07-01 — "the branch that writes the alive file should be a
// heartbeat"), so a fresh alive.txt beat ATTESTS that the loop's time-driven half
// is actually turning. If runDue stops being called, no beat lands and the
// daemon's wedge check restarts the node. Because heartbeats are now a deadman
// switch, one broken heartbeat must never take the tick (or its siblings) down
// with it: every fn is wrapped so a sync throw AND an async rejection are both
// caught + logged, never propagated.

export function createHeartbeats({ onLog = () => {} } = {}) {
  const beats = [];   // { name, everyMs, fn, lastRun }

  // lastRun 0 → a freshly-registered heartbeat fires on the FIRST runDue (in
  // production `now` is epoch ms, so now - 0 always clears everyMs).
  function register(name, everyMs, fn) {
    beats.push({ name, everyMs, fn, lastRun: 0 });
  }

  function runDue(now) {
    for (const b of beats) {
      if (now - b.lastRun < b.everyMs) continue;
      b.lastRun = now;
      try {
        const r = b.fn(now);
        if (r && typeof r.then === 'function') r.then(undefined, (e) => onLog(`${b.name}: ${e?.message ?? e}`));
      } catch (e) {
        onLog(`${b.name}: ${e?.message ?? e}`);
      }
    }
  }

  function list() {
    return beats.map(({ name, everyMs, lastRun }) => ({ name, everyMs, lastRun }));
  }

  return { register, runDue, list };
}
