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

describe('createStopGuard — loop-guard', () => {
  it('warns once at the soft limit, auto-stops at the hard limit', () => {
    const g = createStopGuard({ softLimit: 4, hardLimit: 8 });
    const actions = [];
    for (let i = 0; i < 8; i++) actions.push(g.noteBeing('A'));
    expect(actions).toEqual(['none', 'none', 'none', 'warn', 'none', 'none', 'none', 'stop']);
  });

  it('a human turn resets the count (normal human↔bot talk never trips it)', () => {
    const g = createStopGuard({ softLimit: 4, hardLimit: 8 });
    g.noteBeing('A'); g.noteBeing('A'); g.noteBeing('A');   // 3 being turns
    g.noteHuman('A');                                       // human resets
    const actions = [];
    for (let i = 0; i < 4; i++) actions.push(g.noteBeing('A'));
    expect(actions).toEqual(['none', 'none', 'none', 'warn']);   // counted from 1 again
  });

  it('a "…" silence still consumes a slot (caller notes silences too)', () => {
    const g = createStopGuard({ softLimit: 3, hardLimit: 5 });
    // three real replies + two silences with no human between → hard stop
    const actions = [g.noteBeing('A'), g.noteBeing('A'), g.noteBeing('A'), g.noteBeing('A'), g.noteBeing('A')];
    expect(actions[2]).toBe('warn');
    expect(actions[4]).toBe('stop');
  });
});
