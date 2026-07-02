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
