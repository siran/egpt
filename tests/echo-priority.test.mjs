// echo-priority.test.mjs — the 👂-echo WINNER-SELECTION rank, REAL HRW keyed on a NODE-STABLE
// audio-content hash (operator 2026-07-24; revives HRW over the static-priority stopgap;
// plans/2607101713-HRW-ECHO-PLAN.md). Locks per-note rendezvous hashing over the co-account peer set:
// both nodes compute the SAME ordering for a note (the key is node-stable), so exactly one is rank-1;
// different notes reshuffle who posts; the peer-list order is only the collision tiebreak. NOT dedup.
//
// REPRODUCE-FIRST: the reshuffle + order-independence cases FAIL against the OLD static echoRank
// (which ignores the note key and reads a FIXED list position) and PASS against HRW.
import { describe, it, expect } from 'vitest';
import { echoRank } from '../src/spine/echo-priority.mjs';

describe('echoRank (HRW on the node-stable audio-hash noteKey)', () => {
  const PEERS = ['do', 'kg'];
  // a spread of distinct note keys (stand-ins for the sha256 of each note's audio bytes)
  const KEYS = Array.from({ length: 200 }, (_, i) => `audio-sha-${i}`);

  it('is DETERMINISTIC: the same peers+noteKey give the same rank on repeated calls', () => {
    for (const k of KEYS.slice(0, 20)) {
      const r = echoRank('do', PEERS, k);
      expect(echoRank('do', PEERS, k)).toBe(r);
      expect(echoRank('do', PEERS, k)).toBe(r);
    }
  });

  it('two nodes over the SAME peers+noteKey get a PERMUTATION of 1..N — never two rank-1', () => {
    for (const k of KEYS) {
      const ranks = PEERS.map((n) => echoRank(n, PEERS, k));
      expect(ranks.slice().sort()).toEqual([1, 2]);          // strict total order — no shared rank
      expect(ranks.filter((r) => r === 1)).toHaveLength(1);  // exactly one winner
    }
  });

  it('a 3-node set ranks as a permutation of 1..3 for every note (total order, one winner)', () => {
    const trio = ['a', 'b', 'c'];
    for (const k of KEYS) {
      const ranks = trio.map((n) => echoRank(n, trio, k));
      expect(ranks.slice().sort()).toEqual([1, 2, 3]);
    }
  });

  // REPRODUCE (fails on the static impl): the winner ROTATES per note. The static rank is
  // note-independent, so 'do' would get its FIXED position for EVERY key → a single value. HRW spreads
  // 'do' across BOTH ranks as the note key changes.
  it('different noteKeys RESHUFFLE the rank — the echoer rotates per note', () => {
    const ranksSeen = new Set(KEYS.map((k) => echoRank('do', PEERS, k)));
    expect(ranksSeen).toEqual(new Set([1, 2]));   // static impl → {2} (or {1}); HRW → both
    // and the two nodes always swap: when do is rank 1, kg is rank 2, and vice versa.
    for (const k of KEYS) {
      expect(echoRank('kg', PEERS, k)).toBe(3 - echoRank('do', PEERS, k));
    }
  });

  // REPRODUCE (fails on the static impl): peer-list ORDER does not change the HRW winner — the rank is
  // a function of the peer SET + note key, with list order used ONLY as the collision tiebreak. The
  // static impl reads a fixed list index, so reversing the list flips the rank; HRW does not.
  it('is ORDER-INDEPENDENT for distinct hashes — list order is only the tiebreak', () => {
    for (const k of KEYS) {
      expect(echoRank('do', ['do', 'kg'], k)).toBe(echoRank('do', ['kg', 'do'], k));
      expect(echoRank('kg', ['do', 'kg'], k)).toBe(echoRank('kg', ['kg', 'do'], k));
    }
    // a 3-node set: every permutation of the list yields the same rank for a given note.
    const perms = [['a', 'b', 'c'], ['c', 'b', 'a'], ['b', 'c', 'a'], ['a', 'c', 'b']];
    for (const k of KEYS.slice(0, 40)) {
      const r = echoRank('b', perms[0], k);
      for (const p of perms) expect(echoRank('b', p, k)).toBe(r);
    }
  });

  // TIEBREAK: when two entries hash IDENTICALLY the earlier peer-list index takes the higher rank.
  // A real FNV-1a-32 collision between distinct short names is infeasible to construct (the hash is
  // empirically injective over hundreds of thousands of short strings), so we force the tie with a
  // duplicated peer name: both entries score identically and must be ordered by their index — the
  // duplicate is transparent to self's rank (the earlier copy is the one self resolves to).
  it('breaks a hash tie by peer-list order (earlier index wins; a duplicate is transparent)', () => {
    for (const k of KEYS.slice(0, 30)) {
      // 'do' listed twice ties with itself; its rank must equal the no-duplicate case (earlier copy
      // wins, so the extra copy never demotes self). This exercises the a.index - b.index tiebreak.
      expect(echoRank('do', ['do', 'kg', 'do'], k)).toBe(echoRank('do', ['do', 'kg'], k));
      expect(echoRank('do', ['do', 'do', 'kg'], k)).toBe(echoRank('do', ['do', 'kg'], k));
    }
  });

  it('a solo node (just [self], or empty/absent peers) is ALWAYS rank 1', () => {
    for (const k of ['', 'x', 'audio-sha-9']) {
      expect(echoRank('kg', ['kg'], k)).toBe(1);
      expect(echoRank('kg', [], k)).toBe(1);
      expect(echoRank('kg', null, k)).toBe(1);
      expect(echoRank('kg', undefined, k)).toBe(1);
    }
  });

  it('a node NOT in the peer set is rank 0 (never-post sentinel), for any note', () => {
    for (const k of KEYS.slice(0, 10)) {
      expect(echoRank('x', PEERS, k)).toBe(0);
    }
  });

  it('is case-insensitive on self AND the peer set (config casing never splits the order)', () => {
    for (const k of KEYS.slice(0, 30)) {
      expect(echoRank('DO', ['DO', 'KG'], k)).toBe(echoRank('do', ['do', 'kg'], k));
      expect(echoRank('kg', ['DO', 'KG'], k)).toBe(echoRank('kg', ['do', 'kg'], k));
      expect(echoRank('Do', ['do', 'kg'], k)).toBe(echoRank('do', ['do', 'kg'], k));
    }
  });

  it('an absent/empty noteKey is handled deterministically (no throw; a stable ordering)', () => {
    const a = echoRank('do', PEERS);          // undefined key
    const b = echoRank('do', PEERS, null);    // null key
    const c = echoRank('do', PEERS, '');      // empty key
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect([1, 2]).toContain(a);
    expect(new Set(PEERS.map((n) => echoRank(n, PEERS, '')))).toEqual(new Set([1, 2]));
  });
});
