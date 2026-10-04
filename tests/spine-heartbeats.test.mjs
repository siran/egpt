// The spine's cadence registry (src/spine/heartbeats.mjs): due-on-first-run,
// cadence math, independent cadences, and the invariant that one broken heartbeat
// (sync throw OR async rejection) is caught + logged and never stops its siblings
// or the tick.
import { describe, it, expect } from 'vitest';
import { createHeartbeats } from '../src/spine/heartbeats.mjs';

describe('createHeartbeats', () => {
  it('fires each heartbeat on the first runDue, then honors independent cadences', () => {
    const hb = createHeartbeats();
    const fires = [];
    hb.register('a', 100, (n) => fires.push(['a', n]));
    hb.register('b', 300, (n) => fires.push(['b', n]));

    hb.runDue(1000);                              // lastRun 0 → both due on the first scan
    expect(fires).toEqual([['a', 1000], ['b', 1000]]);

    fires.length = 0;
    hb.runDue(1050);                              // a:+50 <100, b:+50 <300 → neither
    expect(fires).toEqual([]);

    hb.runDue(1100);                              // a:+100 ≥100 fires; b:+100 <300
    expect(fires).toEqual([['a', 1100]]);

    fires.length = 0;
    hb.runDue(1400);                              // a:+300 ≥100; b:+400 ≥300 → both
    expect(fires).toEqual([['a', 1400], ['b', 1400]]);
  });

  it('catches a sync throw, logs it, and still runs the other heartbeats', () => {
    const logs = [];
    const hb = createHeartbeats({ onLog: (m) => logs.push(m) });
    const ran = [];
    hb.register('boom', 100, () => { throw new Error('kaboom'); });
    hb.register('ok', 100, () => ran.push('ok'));

    expect(() => hb.runDue(1000)).not.toThrow();
    expect(ran).toEqual(['ok']);                 // sibling still ran
    expect(logs.some((l) => l.includes('boom') && l.includes('kaboom'))).toBe(true);
  });

  it('catches an async rejection, logs it, and still runs the other heartbeats', async () => {
    const logs = [];
    const hb = createHeartbeats({ onLog: (m) => logs.push(m) });
    const ran = [];
    hb.register('areject', 100, async () => { throw new Error('async-boom'); });
    hb.register('ok', 100, () => ran.push('ok'));

    hb.runDue(1000);
    expect(ran).toEqual(['ok']);
    await new Promise((r) => setTimeout(r, 0));   // let the rejection handler run
    expect(logs.some((l) => l.includes('areject') && l.includes('async-boom'))).toBe(true);
  });

  it('list() reports { name, everyMs, lastRun } and lastRun advances on fire', () => {
    const hb = createHeartbeats();
    hb.register('alive', 60_000, () => {});
    expect(hb.list()).toEqual([{ name: 'alive', everyMs: 60_000, lastRun: 0 }]);
    hb.runDue(60_000);
    expect(hb.list()).toEqual([{ name: 'alive', everyMs: 60_000, lastRun: 60_000 }]);
  });
});

// A hot reload (one per inbound message) does clear() + re-register() the whole set — exactly
// what createHeartbeatLoader.reload() does onto this registry. A recurring beat's clock must
// survive that, keyed by name + cadence, or a long-cadence beat re-arms to lastRun 0 on every
// reload and fires ~every message. (The live bug: an acim-room `frequency: 1h` beat fired on
// roughly every conversation turn — 15:35, 15:38, 15:40, 15:43 … — because each turn reloaded.)
describe('createHeartbeats — a recurring schedule survives a reload (clear + re-register)', () => {
  const HOUR = 3_600_000;
  const T0 = 1_000_000_000_000;   // epoch-ish, as production `now` is
  const reload = (hb, name, everyMs, fn) => { hb.clear(); hb.register(name, everyMs, fn); };

  it('REPRODUCE-FIRST: a reload 3 min after a fire does NOT re-fire a 1h beat before the hour is up', () => {
    const hb = createHeartbeats();
    const fires = [];
    hb.register('acim-lote', HOUR, (n) => fires.push(n));

    hb.runDue(T0);                               // boot tick: lastRun 0 → the first, legitimate fire
    expect(fires).toEqual([T0]);

    reload(hb, 'acim-lote', HOUR, (n) => fires.push(n));   // an inbound message reloads the beat
    hb.runDue(T0 + 3 * 60_000);                  // 3 minutes later — far short of the hour
    expect(fires).toEqual([T0]);                 // pre-fix: re-register reset lastRun→0 so it fired AGAIN here
  });

  it('LOCK: the next fire is one full cadence after the last REAL fire, across reloads in between', () => {
    const hb = createHeartbeats();
    const fires = [];
    hb.register('acim-lote', HOUR, (n) => fires.push(n));
    hb.runDue(T0);                               // fire #1
    for (let m = 3; m < 60; m += 3) {            // a reload every 3 min for the rest of the hour
      reload(hb, 'acim-lote', HOUR, (n) => fires.push(n));
      hb.runDue(T0 + m * 60_000);
    }
    expect(fires).toEqual([T0]);                 // nothing between t0 and t0+1h, reloads notwithstanding

    hb.runDue(T0 + HOUR);                         // the hour elapses
    expect(fires).toEqual([T0, T0 + HOUR]);       // fire #2 at t0+1h, not sooner

    reload(hb, 'acim-lote', HOUR, (n) => fires.push(n));
    hb.runDue(T0 + HOUR + 3 * 60_000);            // 3 min after fire #2 + a reload
    expect(fires).toEqual([T0, T0 + HOUR]);       // still anchored to the real fire
    hb.runDue(T0 + 2 * HOUR);
    expect(fires).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR]);
  });

  it('REGRESSION: a cadence CHANGED in config re-arms (fires on the next runDue), not carries the old clock', () => {
    const hb = createHeartbeats();
    const fires = [];
    hb.register('x', HOUR, (n) => fires.push(['1h', n]));
    hb.runDue(T0);                               // fires under the 1h cadence
    reload(hb, 'x', 300_000, (n) => fires.push(['5m', n]));   // operator edits 1h → 5m
    hb.runDue(T0 + 60_000);                       // 1 min later: a changed cadence is a fresh clock → fires
    expect(fires).toEqual([['1h', T0], ['5m', T0 + 60_000]]);
  });

  it('REGRESSION: a beat that has not fired yet still fires on its first runDue after a reload (alive first-fire contract)', () => {
    const hb = createHeartbeats();
    const fires = [];
    hb.register('alive', 60_000, (n) => fires.push(n));   // registered, no tick yet
    reload(hb, 'alive', 60_000, (n) => fires.push(n));    // a reload lands before the first tick
    hb.runDue(T0);
    expect(fires).toEqual([T0]);                          // lastRun carried = 0 → still fires immediately
  });
});
