// heartbeats.mjs — the spine's cadence registry (plans/2606291226-SPINE-REWRITE-PLAN.md §2c). A
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

  // A hot reload (one per inbound message) clear()s then re-register()s the WHOLE set.
  // A recurring beat's clock (lastRun) must SURVIVE that, keyed by name + cadence — else a
  // long-cadence beat (e.g. frequency: 1h) re-arms to lastRun 0 on every reload and fires
  // ~every message instead of once per cadence. clear() snapshots each beat's schedule by
  // name; register() carries it forward when the SAME name returns at the SAME cadence.
  let prior = new Map();   // name → { everyMs, lastRun }, snapshotted at the last clear()

  // lastRun 0 → a freshly-registered heartbeat fires on the FIRST runDue (in
  // production `now` is epoch ms, so now - 0 always clears everyMs). A re-registered beat
  // (same name + cadence) keeps the lastRun it had before the clear(), so a reload never
  // resets its clock (no early/extra fire); a NEW beat, or one whose cadence CHANGED in
  // config, gets lastRun 0 and fires on the next runDue, as a freshly-declared beat does.
  function register(name, everyMs, fn) {
    const carried = prior.get(name);
    const lastRun = carried && carried.everyMs === everyMs ? carried.lastRun : 0;
    beats.push({ name, everyMs, fn, lastRun });
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

  // Drop every registered beat so the loader can replace the whole set on a hot
  // reload (the fresh collect() rebuilds it). Stays dumb: no scheduling, just
  // array surgery — but first snapshot each beat's schedule by name so a re-register
  // after this clear() can carry its lastRun forward (see register), and a reload
  // does not reset a recurring beat's clock.
  function clear() {
    prior = new Map(beats.map((b) => [b.name, { everyMs: b.everyMs, lastRun: b.lastRun }]));
    beats.length = 0;
  }

  return { register, runDue, list, clear };
}
