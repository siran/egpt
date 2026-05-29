// tests/extension-bus-flood.test.mjs — flood detector for the CHROME
// EXTENSION (extension/src/tools/bus-flood.js). Extension-only.
//
// Goal: every body event is held briefly; if a duplicate arrives, BOTH
// (held + duplicate) suppress and the detector enters flood mode. End
// of flood = endQuietMs without another match. Releases the original
// only if no duplicate arrived. Status notices fire via callbacks so
// bus-ext.js can route them through the event channel.

import { describe, it, expect } from 'vitest';
import {
  HeldFloodDetector, floodKey,
  DEFAULT_HOLD_MS, DEFAULT_END_QUIET_MS,
} from '../extension/src/tools/bus-flood.js';

// Tiny fake timer that the detector can use via injected setTimeout /
// clearTimeout. advance(ms) fires all callbacks whose due-time has
// elapsed. Tests get deterministic time control.
function makeFakeTimer() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();   // id → { dueAt, fn, cancelled }
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { dueAt: now + (ms ?? 0), fn, cancelled: false });
      return id;
    },
    clearTimeout: (id) => {
      const e = pending.get(id);
      if (e) e.cancelled = true;
    },
    advance: (ms) => {
      const target = now + ms;
      // Repeatedly fire timers due at or before `target`, in due-order
      while (true) {
        let next = null;
        for (const [id, e] of pending) {
          if (e.cancelled) { pending.delete(id); continue; }
          if (e.dueAt > target) continue;
          if (!next || e.dueAt < next.dueAt) next = { id, ...e };
        }
        if (!next) break;
        pending.delete(next.id);
        now = next.dueAt;
        next.fn();
      }
      now = target;
    },
    pendingCount: () => [...pending.values()].filter(e => !e.cancelled).length,
  };
}

describe('floodKey', () => {
  it('uses from + body[0..60]', () => {
    expect(floodKey({ from: 'kg', body: '> /help' })).toBe('kg:> /help');
    expect(floodKey({})).toBe('?:');
  });
});

describe('HeldFloodDetector', () => {
  function setup(opts = {}) {
    const timer = makeFakeTimer();
    const released = [];
    const starts = [];
    const ends = [];
    const det = new HeldFloodDetector({
      holdMs: 250,
      endQuietMs: 1500,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      onRelease:    (ev) => released.push(ev),
      onFloodStart: (info) => starts.push(info),
      onFloodEnd:   (info) => ends.push(info),
      ...opts,
    });
    return { det, timer, released, starts, ends };
  }

  it('passes through non-body events without holding', () => {
    const { det, released } = setup();
    const r = det.submit({ from: 'a', type: 'node-online' });
    expect(r).toBe('pass');
    expect(released).toEqual([]);   // caller handles direct delivery
  });

  it('passes through events with non-string body', () => {
    const { det } = setup();
    expect(det.submit({ from: 'a', body: 42 })).toBe('pass');
    expect(det.submit({ from: 'a', body: null })).toBe('pass');
  });

  it('holds a body event and releases it after holdMs if no duplicate', () => {
    const { det, timer, released, starts, ends } = setup();
    const ev = { from: 'kg', body: 'hello' };
    expect(det.submit(ev)).toBe('held');
    expect(released).toEqual([]);

    timer.advance(249);
    expect(released).toEqual([]);
    timer.advance(2);
    expect(released).toEqual([ev]);   // released after holdMs

    expect(starts).toEqual([]);
    expect(ends).toEqual([]);
  });

  it('on duplicate within holdMs: drops BOTH, fires onFloodStart immediately', () => {
    const { det, timer, released, starts, ends } = setup();
    const ev = { from: 'kg', body: '> /help' };
    expect(det.submit(ev)).toBe('held');
    timer.advance(100);
    expect(det.submit(ev)).toBe('dropped');

    expect(starts).toEqual([{ fromKey: 'kg', bodySnippet: '> /help' }]);
    expect(released).toEqual([]);   // original was NOT released

    // No end-fire yet — endQuietMs hasn't elapsed
    expect(ends).toEqual([]);
  });

  it('fires onFloodEnd with total count (held + duplicates) after endQuietMs of quiet', () => {
    const { det, timer, ends } = setup();
    const ev = { from: 'kg', body: 'x' };
    det.submit(ev);          // held
    det.submit(ev);          // drop #1
    det.submit(ev);          // drop #2
    det.submit(ev);          // drop #3
    timer.advance(1499);
    expect(ends).toEqual([]);
    timer.advance(2);
    expect(ends).toEqual([{ fromKey: 'kg', bodySnippet: 'x', totalCount: 4 }]);
  });

  it('continued duplicates reset the end-quiet timer', () => {
    const { det, timer, ends } = setup();
    const ev = { from: 'kg', body: 'x' };
    det.submit(ev);
    det.submit(ev);
    timer.advance(1000);
    det.submit(ev);           // extends the flood
    timer.advance(1499);
    expect(ends).toEqual([]); // not yet — last drop was 1499ms ago
    timer.advance(2);
    expect(ends).toEqual([{ fromKey: 'kg', bodySnippet: 'x', totalCount: 3 }]);
  });

  it('different (from, body) pairs are independent', () => {
    const { det, timer, released, starts, ends } = setup();
    det.submit({ from: 'a', body: 'x' });
    det.submit({ from: 'a', body: 'x' });   // flood A
    det.submit({ from: 'b', body: 'x' });   // independent — held
    det.submit({ from: 'a', body: 'y' });   // independent — held

    timer.advance(251);
    // b/x and a/y release as normal (held, then released)
    expect(released).toContainEqual({ from: 'b', body: 'x' });
    expect(released).toContainEqual({ from: 'a', body: 'y' });
    // a/x flooded — no release; one start notice fired
    expect(starts).toEqual([{ fromKey: 'a', bodySnippet: 'x' }]);

    timer.advance(1500);
    expect(ends).toEqual([{ fromKey: 'a', bodySnippet: 'x', totalCount: 2 }]);
  });

  it('after flood ends, a new duplicate burst is detected fresh', () => {
    const { det, timer, starts, ends } = setup();
    const ev = { from: 'kg', body: 'x' };
    det.submit(ev); det.submit(ev);    // flood
    timer.advance(1600);                // flood ends
    expect(ends).toHaveLength(1);

    // Another burst on the same key
    det.submit(ev); det.submit(ev);
    timer.advance(1600);
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
  });

  it('reproduces the shell-loop case — 0 admitted, 119 suppressed, 1 notice pair', () => {
    const { det, timer, released, starts, ends } = setup();
    const ev = { from: 'kg', body: '> /help' };
    // 119 events spread over 4 seconds (~30/sec)
    for (let i = 0; i < 119; i++) {
      det.submit(ev);
      timer.advance(Math.floor(4000 / 119));
    }
    // Drain end-quiet timer
    timer.advance(1500);
    expect(released).toEqual([]);              // NONE rendered
    expect(starts).toHaveLength(1);            // single start notice
    expect(ends).toEqual([{ fromKey: 'kg', bodySnippet: '> /help', totalCount: 119 }]);
  });

  it('reset() drops all pending timers and held state', () => {
    const { det, timer, released, ends } = setup();
    det.submit({ from: 'a', body: 'x' });
    det.submit({ from: 'a', body: 'x' });   // flood — sets endTimer
    det.reset();
    timer.advance(5000);
    expect(released).toEqual([]);
    expect(ends).toEqual([]);
  });
});
