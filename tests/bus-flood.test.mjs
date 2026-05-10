// tests/bus-flood.test.mjs — per-source body-rate suppression.
//
// Different from event-key dedup: events with distinct ts/sig are
// considered distinct by the per-key dedup; this layer adds
// "but if a peer keeps repeating the same body, drop the burst".

import { describe, it, expect } from 'vitest';
import { FloodTracker, floodKey } from '../extension/src/tools/bus-flood.js';

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('floodKey', () => {
  it('uses from + body[0..60]', () => {
    const k = floodKey({ from: 'kg', body: '> /help' });
    expect(k).toBe('kg:> /help');
  });

  it('handles missing fields', () => {
    expect(floodKey({})).toBe('?:');
    expect(floodKey({ from: 'x' })).toBe('x:');
    expect(floodKey({ body: 'y' })).toBe('?:y');
  });

  it('truncates long bodies (collisions accepted for very long bodies)', () => {
    const long = 'a'.repeat(100);
    expect(floodKey({ from: 'x', body: long }).length).toBeLessThan('x:'.length + 61);
  });
});

describe('FloodTracker', () => {
  it('admits the first N events; drops subsequent identical', () => {
    const clock = fakeClock(1000);
    const t = new FloodTracker({ now: clock.now, threshold: 5 });
    const ev = { from: 'kg', body: '> /help' };
    for (let i = 0; i < 5; i++) {
      expect(t.check(ev)).toBe(false);
      clock.advance(50);    // 50ms between events; well within window
    }
    for (let i = 0; i < 50; i++) {
      expect(t.check(ev)).toBe(true);   // dropped
      clock.advance(10);
    }
  });

  it('resets after the window expires', () => {
    const clock = fakeClock(1000);
    const t = new FloodTracker({ now: clock.now, windowMs: 5000, threshold: 5 });
    const ev = { from: 'kg', body: 'x' };
    // Saturate
    for (let i = 0; i < 5; i++) t.check(ev);
    expect(t.check(ev)).toBe(true);

    // After the window, the next event starts a fresh count
    clock.advance(5001);
    expect(t.check(ev)).toBe(false);
    // And 4 more before suppression kicks in again
    for (let i = 0; i < 4; i++) expect(t.check(ev)).toBe(false);
    expect(t.check(ev)).toBe(true);
  });

  it('tracks different (from, body) pairs independently', () => {
    const clock = fakeClock(1000);
    const t = new FloodTracker({ now: clock.now, threshold: 3 });
    expect(t.check({ from: 'a', body: 'x' })).toBe(false);
    expect(t.check({ from: 'a', body: 'x' })).toBe(false);
    expect(t.check({ from: 'a', body: 'x' })).toBe(false);
    expect(t.check({ from: 'a', body: 'x' })).toBe(true);    // a/x flooded
    expect(t.check({ from: 'b', body: 'x' })).toBe(false);   // b/x unrelated
    expect(t.check({ from: 'a', body: 'y' })).toBe(false);   // a/y unrelated
  });

  it('different bodies from the same source are independent', () => {
    const clock = fakeClock(1000);
    const t = new FloodTracker({ now: clock.now, threshold: 2 });
    expect(t.check({ from: 'kg', body: 'one' })).toBe(false);
    expect(t.check({ from: 'kg', body: 'one' })).toBe(false);
    expect(t.check({ from: 'kg', body: 'one' })).toBe(true);
    expect(t.check({ from: 'kg', body: 'two' })).toBe(false);   // distinct body
  });

  it('non-body events are never suppressed', () => {
    const clock = fakeClock(1000);
    const t = new FloodTracker({ now: clock.now, threshold: 2 });
    const noBody = { from: 'kg', type: 'node-online' };
    for (let i = 0; i < 100; i++) expect(t.check(noBody)).toBe(false);
  });

  it('fires onSuppress exactly once per flood window', () => {
    const clock = fakeClock(1000);
    let calls = 0;
    const t = new FloodTracker({
      now: clock.now, threshold: 3, windowMs: 5000,
      onSuppress: () => { calls++; },
    });
    const ev = { from: 'kg', body: 'flood' };
    for (let i = 0; i < 50; i++) t.check(ev);
    expect(calls).toBe(1);   // one warning for the whole window

    clock.advance(5001);
    // Reset; the next saturation should produce another single warning
    for (let i = 0; i < 50; i++) t.check(ev);
    expect(calls).toBe(2);
  });

  it('reproduces the shell-loop case (119 events in 4 seconds)', () => {
    const clock = fakeClock(1000);
    const t = new FloodTracker({ now: clock.now, threshold: 5, windowMs: 5000 });
    const ev = { from: 'kg', body: '> /help' };
    let admitted = 0;
    let dropped = 0;
    for (let i = 0; i < 119; i++) {
      if (t.check(ev)) dropped++; else admitted++;
      clock.advance(4000 / 119);    // ~30/sec across 4 seconds
    }
    expect(admitted).toBe(5);       // exactly threshold
    expect(dropped).toBe(114);
  });
});
