// echo-priority.test.mjs — the 👂-echo STATIC PRIORITY rank (operator 2026-07-11, Phase 3b;
// plans/2607101713-HRW-ECHO-PLAN.md). Locks the note-INDEPENDENT static rank that REPLACED HRW: two
// co-account spines rank themselves by their FIXED position in a shared priority list, so the primary
// always posts and a standby promotes only on the primary's silence — no per-note hash, no node-local
// message-id divergence, no double-👂. NOT dedup.
import { describe, it, expect } from 'vitest';
import { echoRank } from '../src/spine/echo-priority.mjs';

describe('echoRank (static priority)', () => {
  it('is the 1-INDEXED position of self in the priority list', () => {
    expect(echoRank('do', ['do', 'kg'])).toBe(1);   // primary
    expect(echoRank('kg', ['do', 'kg'])).toBe(2);   // first failover
  });

  it('a solo node (just [self], or empty/absent priority) is ALWAYS rank 1', () => {
    expect(echoRank('kg', ['kg'])).toBe(1);
    expect(echoRank('kg', [])).toBe(1);
    expect(echoRank('kg', null)).toBe(1);
    expect(echoRank('kg', undefined)).toBe(1);
  });

  it('a node NOT in the priority list is rank 0 (never-post sentinel)', () => {
    expect(echoRank('x', ['do', 'kg'])).toBe(0);
  });

  it('is case-insensitive on self AND the priority list (config casing never splits the order)', () => {
    expect(echoRank('DO', ['DO', 'KG'])).toBe(1);
    expect(echoRank('KG', ['DO', 'KG'])).toBe(2);
    expect(echoRank('kg', ['DO', 'KG'])).toBe(2);
    expect(echoRank('Do', ['do', 'kg'])).toBe(1);
  });

  it('depends ONLY on the given priority ORDER, not on any note id (note-independent)', () => {
    // The whole point of dropping HRW: there is no noteId argument, so the rank is the same for every
    // note. Flipping the priority order flips the ranks; nothing else can.
    expect(echoRank('do', ['do', 'kg'])).toBe(1);
    expect(echoRank('do', ['kg', 'do'])).toBe(2);   // reversed priority → reversed rank
    expect(echoRank('kg', ['kg', 'do'])).toBe(1);
  });

  it('ranks a 3-node priority list distinctly — a permutation of 1..3', () => {
    expect(['a', 'b', 'c'].map((n) => echoRank(n, ['a', 'b', 'c']))).toEqual([1, 2, 3]);
  });
});
