// Locks the loop-guard state machine (C7.7, operator 2026-06-13): the loop counter pauses
// a channel, a human turn resets the count, a "…" silence still consumes a slot,
// soft→warn once / hard→auto-stop, RESUME clears it, and the operator safe-words parse
// exactly.
//
// STOP / STOP ALL are NOT here any more: since 2026-07-25 they are the KILL SWITCH (write
// EGPT_HOME/STOP, stop the service) and their contract lives in tests/stop-file.test.mjs.
// The guard's own stopChannel survives because the LOOP COUNTER still trips it.
import { describe, it, expect } from 'vitest';
import { createStopGuard, parseStopWord } from '../src/stop-guard.mjs';

describe('parseStopWord', () => {
  it('parses the safe-words, case- and punctuation-tolerant', () => {
    expect(parseStopWord('STOP')).toBe('stop');
    expect(parseStopWord('stop.')).toBe('stop');
    expect(parseStopWord('Stop ALL')).toBe('stop_all');
    expect(parseStopWord('stopall')).toBe('stop_all');
    expect(parseStopWord('RESUME')).toBe('resume');
    expect(parseStopWord('resume all')).toBe('resume_all');
  });
  it('does not misfire on ordinary text containing the word', () => {
    expect(parseStopWord('please stop the build')).toBeNull();
    expect(parseStopWord('stopping now')).toBeNull();
    expect(parseStopWord('')).toBeNull();
  });
});

describe('createStopGuard — the per-channel pause', () => {
  it('a stopped channel blocks; other channels and a human turn are unaffected', () => {
    const g = createStopGuard();
    g.stopChannel('A');
    expect(g.blocked('A')).toBe(true);
    expect(g.blocked('B')).toBe(false);
    g.resumeChannel('A');
    expect(g.blocked('A')).toBe(false);
  });

  it('RESUME ALL clears every auto-stopped channel and its counts', () => {
    const g = createStopGuard();
    g.stopChannel('A'); g.stopChannel('B'); g.noteBeing('C');
    expect(g.blocked('A')).toBe(true);
    expect(g.blocked('B')).toBe(true);
    g.resumeAll();
    expect(g.blocked('A')).toBe(false);
    expect(g.blocked('B')).toBe(false);
    expect(g.countOf('C')).toBe(0);
  });

  it('a human turn does NOT clear a stopped channel (deliberate override)', () => {
    const g = createStopGuard();
    g.stopChannel('A');
    g.noteHuman('A');
    expect(g.blocked('A')).toBe(true);   // only RESUME clears it
  });

  it('applyControl routes RESUME / RESUME ALL — and never STOP (that is the kill switch)', () => {
    const g = createStopGuard();
    g.stopChannel('A');
    g.applyControl(parseStopWord('resume'), 'A');
    expect(g.blocked('A')).toBe(false);
    g.stopChannel('Z');
    g.applyControl(parseStopWord('resume all'), 'A');
    expect(g.blocked('Z')).toBe(false);
    // STOP/STOP ALL reach the STOP file, not this state machine — applyControl ignores them.
    g.applyControl(parseStopWord('stop'), 'A');
    g.applyControl(parseStopWord('stop all'), 'A');
    expect(g.blocked('A')).toBe(false);
    expect(g.blocked('anything')).toBe(false);
  });
});

describe('createStopGuard — loop counter (config-driven turns)', () => {
  it('warns a couple below the cap, auto-stops at `turns` (the 6th trips)', () => {
    const g = createStopGuard({ turns: 6 });   // hard 6, soft 4 (a couple below)
    const actions = [];
    for (let i = 0; i < 6; i++) actions.push(g.noteBeing('A'));
    expect(actions).toEqual(['none', 'none', 'none', 'warn', 'none', 'stop']);
    expect(g.countOf('A')).toBe(6);
  });

  it('a human turn resets the count (normal human↔bot talk never trips it)', () => {
    const g = createStopGuard({ turns: 6 });
    g.noteBeing('A'); g.noteBeing('A'); g.noteBeing('A');   // 3 non-human turns
    g.noteHuman('A');                                       // human resets
    const actions = [];
    for (let i = 0; i < 4; i++) actions.push(g.noteBeing('A'));
    expect(actions).toEqual(['none', 'none', 'none', 'warn']);   // counted from 1 again
  });

  it('a "…" silence still consumes a slot (caller notes silences too)', () => {
    const g = createStopGuard({ turns: 5 });   // hard 5, soft 3
    // three real replies + two silences with no human between → hard stop
    const actions = [g.noteBeing('A'), g.noteBeing('A'), g.noteBeing('A'), g.noteBeing('A'), g.noteBeing('A')];
    expect(actions[2]).toBe('warn');
    expect(actions[4]).toBe('stop');
  });

  it('turns: -1 (global) disables tripping entirely', () => {
    const g = createStopGuard({ turns: -1 });
    const actions = [];
    for (let i = 0; i < 50; i++) actions.push(g.noteBeing('A'));
    expect(actions.every((a) => a === 'none')).toBe(true);
  });

  it('a per-conversation override wins over the node default (tighten, loosen, disable)', () => {
    const g = createStopGuard({ turns: 6 });
    // tighten: this channel trips at 3 (hard 3, soft 1)
    expect(g.noteBeing('tight', { turns: 3 })).toBe('warn');   // n=1 === soft 1
    expect(g.noteBeing('tight', { turns: 3 })).toBe('none');
    expect(g.noteBeing('tight', { turns: 3 })).toBe('stop');   // n=3 === hard
    // disable: this channel never trips regardless of the node default
    const off = [];
    for (let i = 0; i < 20; i++) off.push(g.noteBeing('free', { turns: -1 }));
    expect(off.every((a) => a === 'none')).toBe(true);
  });

  it('window (minutes) ages out old non-human turns so only recent ones count', () => {
    let t = 0;
    const g = createStopGuard({ turns: 4, window: 5, now: () => t });   // 5-min window, hard 4
    expect(g.noteBeing('A')).toBe('none');            // t=0m → [0]              n=1
    t = 4 * 60_000; expect(g.noteBeing('A')).toBe('warn');   // t=4m → [0,4m]   n=2 (soft 2)
    t = 6 * 60_000; expect(g.noteBeing('A')).toBe('warn');   // t=6m → [4m,6m]  the t=0 turn aged out
    t = 7 * 60_000; expect(g.noteBeing('A')).toBe('none');   // t=7m → [4m,6m,7m] n=3
    t = 8 * 60_000; expect(g.noteBeing('A')).toBe('stop');   // t=8m → [4m,6m,7m,8m] n=4 → stop
  });
});
