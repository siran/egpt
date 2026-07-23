// Locks the kill-switch + loop-guard state machine (C7.7, operator 2026-06-13):
// STOP halts prompting (channel or global), a human turn resets the loop count,
// a "…" silence still consumes a slot, soft→warn once / hard→auto-stop, and the
// operator safe-words parse exactly.
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

describe('createStopGuard — kill-switch', () => {
  it('STOP blocks one channel; other channels and a human turn are unaffected', () => {
    const g = createStopGuard();
    g.stopChannel('A');
    expect(g.blocked('A')).toBe(true);
    expect(g.blocked('B')).toBe(false);
    g.resumeChannel('A');
    expect(g.blocked('A')).toBe(false);
  });

  it('STOP ALL blocks every channel; RESUME ALL clears it (egpt off → on)', () => {
    const g = createStopGuard();
    g.stopAll();
    expect(g.blocked('A')).toBe(true);
    expect(g.blocked('anything')).toBe(true);
    expect(g.isStoppedAll()).toBe(true);
    g.resumeAll();
    expect(g.blocked('A')).toBe(false);
    expect(g.isStoppedAll()).toBe(false);
  });

  it('a human turn does NOT clear an active STOP (deliberate override)', () => {
    const g = createStopGuard();
    g.stopChannel('A');
    g.noteHuman('A');
    expect(g.blocked('A')).toBe(true);   // only RESUME clears it
  });

  it('applyControl routes the parsed words', () => {
    const g = createStopGuard();
    g.applyControl(parseStopWord('stop'), 'A');
    expect(g.blocked('A')).toBe(true);
    g.applyControl(parseStopWord('resume'), 'A');
    expect(g.blocked('A')).toBe(false);
    g.applyControl(parseStopWord('stop all'), 'A');
    expect(g.blocked('Z')).toBe(true);
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
