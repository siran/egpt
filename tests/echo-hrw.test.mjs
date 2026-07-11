// echo-hrw.test.mjs — the 👂-echo deterministic PICK (operator 2026-07-10, Phase 3a;
// plans/2607101713-HRW-ECHO-PLAN.md). Locks the rendezvous-hash pick that makes exactly ONE
// co-account spine echo each voice note — NOT dedup: no coordination, the shared note id + the
// shared candidate set are the ONLY thing making the two nodes agree on the same winner.
import { describe, it, expect } from 'vitest';
import { hrwWinner, hrwRanked, isEchoWinner, echoRank } from '../src/spine/echo-hrw.mjs';

describe('hrwWinner', () => {
  it('is DETERMINISTIC + order-independent: same key + candidates → same winner regardless of order', () => {
    for (const key of ['1', '488', 'abc', 'm-9f3', 'note-xyz']) {
      const w1 = hrwWinner(key, ['kg', 'do']);
      const w2 = hrwWinner(key, ['do', 'kg']);
      expect(w1).toBe(w2);
      const w3 = hrwWinner(key, ['a', 'b', 'c', 'd']);
      const w4 = hrwWinner(key, ['d', 'c', 'b', 'a']);
      const w5 = hrwWinner(key, ['c', 'a', 'd', 'b']);
      expect(w4).toBe(w3);
      expect(w5).toBe(w3);
    }
  });

  it('ROTATES across keys: over many note ids BOTH of [kg, do] win a healthy share (not 100/0)', () => {
    let kg = 0;
    let doo = 0;
    const N = 1000;
    for (let i = 1; i <= N; i++) {   // Beeper ids are per-chat sequence numbers ("1".."N")
      const w = hrwWinner(String(i), ['kg', 'do']);
      if (w === 'kg') kg++;
      else if (w === 'do') doo++;
    }
    expect(kg + doo).toBe(N);                 // always exactly one winner
    expect(kg).toBeGreaterThan(N * 0.25);     // neither node is starved — the echoer rotates
    expect(doo).toBeGreaterThan(N * 0.25);
  });

  it('has a STABLE lexicographic tie-break: an equal-hash pair resolves to the smaller string, either order', () => {
    // '123zx' and '1dpad' both FNV-1a-hash to the same value under key 'tie' (found offline).
    // Lexicographically '123zx' < '1dpad', so it wins regardless of the order passed.
    expect(hrwWinner('tie', ['123zx', '1dpad'])).toBe('123zx');
    expect(hrwWinner('tie', ['1dpad', '123zx'])).toBe('123zx');
  });

  it('returns null for an empty / absent candidate list', () => {
    expect(hrwWinner('k', [])).toBeNull();
    expect(hrwWinner('k', null)).toBeNull();
    expect(hrwWinner('k', undefined)).toBeNull();
  });

  it('a single candidate always wins', () => {
    expect(hrwWinner('anything', ['solo'])).toBe('solo');
  });
});

describe('isEchoWinner', () => {
  it('SOLO node (empty / absent peers) is ALWAYS the winner → always echoes (lone-node behavior)', () => {
    for (const noteId of ['1', '42', 'm-abc']) {
      expect(isEchoWinner(noteId, 'kg', [])).toBe(true);
      expect(isEchoWinner(noteId, 'kg', null)).toBe(true);
      expect(isEchoWinner(noteId, 'kg', undefined)).toBe(true);
    }
  });

  it('a peer set of just [self] is always the winner', () => {
    expect(isEchoWinner('88', 'kg', ['kg'])).toBe(true);
  });

  it('DOUBLE-👂 LOCK: peers [kg, do] + a given note id → EXACTLY ONE of kg/do echoes, the other stays silent', () => {
    // For the SAME note id the two nodes independently compute opposite verdicts — this is what
    // replaces the old double-👂. Verified across many ids; both roles win a share (rotation).
    let kgWins = 0;
    let doWins = 0;
    for (let i = 1; i <= 200; i++) {
      const id = String(i);
      const kg = isEchoWinner(id, 'kg', ['kg', 'do']);
      const doo = isEchoWinner(id, 'do', ['kg', 'do']);
      expect(kg).toBe(!doo);   // exactly one true for the SAME id — never both, never neither
      if (kg) kgWins++;
      if (doo) doWins++;
    }
    expect(kgWins).toBeGreaterThan(0);   // the winner rotates — neither node is the fixed echoer
    expect(doWins).toBeGreaterThan(0);
  });

  it('is case-insensitive on self + peers (config casing never splits the pick)', () => {
    for (let i = 1; i <= 50; i++) {
      const id = String(i);
      expect(isEchoWinner(id, 'KG', ['KG', 'DO'])).toBe(isEchoWinner(id, 'kg', ['kg', 'do']));
    }
  });
});

// Phase 3b ORDERED FAILOVER (operator 2026-07-11): hrwRanked gives the FULL failover order and
// echoRank this node's 1-indexed position, so a lower rank posts only if the higher ranks are
// silent. Deterministic + identical on every node — the same coordination-free property as the pick.
describe('hrwRanked', () => {
  it('is a DETERMINISTIC full ordering, IDENTICAL regardless of input order, and a permutation of the candidates', () => {
    const a = hrwRanked('note-1', ['a', 'b', 'c', 'd']);
    expect(hrwRanked('note-1', ['d', 'c', 'b', 'a'])).toEqual(a);   // reversed input → same order
    expect(hrwRanked('note-1', ['c', 'a', 'd', 'b'])).toEqual(a);   // shuffled input → same order
    expect([...a].sort()).toEqual(['a', 'b', 'c', 'd']);            // every candidate present exactly once
  });

  it('rank-1 of hrwRanked === hrwWinner (the pick is the head of the order — they can never diverge)', () => {
    for (const key of ['1', '488', 'note-xyz', 'm-9f3']) {
      expect(hrwRanked(key, ['kg', 'do'])[0]).toBe(hrwWinner(key, ['kg', 'do']));
      expect(hrwRanked(key, ['a', 'b', 'c', 'd'])[0]).toBe(hrwWinner(key, ['a', 'b', 'c', 'd']));
    }
  });

  it('has a STABLE lexicographic tie-break: an equal-hash pair orders smaller-first, either input order', () => {
    // '123zx' and '1dpad' collide under key 'tie' (the same collision the hrwWinner test uses).
    expect(hrwRanked('tie', ['123zx', '1dpad'])).toEqual(['123zx', '1dpad']);
    expect(hrwRanked('tie', ['1dpad', '123zx'])).toEqual(['123zx', '1dpad']);
  });

  it('returns [] for an empty / absent candidate list', () => {
    expect(hrwRanked('k', [])).toEqual([]);
    expect(hrwRanked('k', null)).toEqual([]);
    expect(hrwRanked('k', undefined)).toEqual([]);
  });
});

describe('echoRank', () => {
  it('is 1-INDEXED; a solo node (empty/absent peers, or just [self]) is ALWAYS rank 1', () => {
    for (const id of ['1', '42', 'm-abc']) {
      expect(echoRank(id, 'kg', [])).toBe(1);
      expect(echoRank(id, 'kg', null)).toBe(1);
      expect(echoRank(id, 'kg', undefined)).toBe(1);
      expect(echoRank(id, 'kg', ['kg'])).toBe(1);
    }
  });

  it('both co-account peers get DISTINCT ranks that are a PERMUTATION of 1..N for the SAME note', () => {
    for (let i = 1; i <= 200; i++) {
      const id = String(i);
      const rk = echoRank(id, 'kg', ['kg', 'do']);
      const rd = echoRank(id, 'do', ['kg', 'do']);
      expect(new Set([rk, rd])).toEqual(new Set([1, 2]));   // distinct, exactly {1,2} — never both 1, never a gap
    }
  });

  it('over 3 peers, each note assigns every node a distinct rank — the ranks are a permutation of 1..3', () => {
    for (let i = 1; i <= 100; i++) {
      const id = String(i);
      const ranks = ['a', 'b', 'c'].map((n) => echoRank(id, n, ['a', 'b', 'c']));
      expect([...ranks].sort()).toEqual([1, 2, 3]);
    }
  });

  it('rank === 1 IFF isEchoWinner — the winner is exactly the rank-1 node (3a behavior unchanged)', () => {
    for (let i = 1; i <= 100; i++) {
      const id = String(i);
      for (const [self, peers] of [['kg', ['kg', 'do']], ['do', ['kg', 'do']], ['solo', []], ['a', ['a', 'b', 'c']]]) {
        expect(echoRank(id, self, peers) === 1).toBe(isEchoWinner(id, self, peers));
      }
    }
  });

  it('is case-insensitive on self + peers (config casing never splits the order)', () => {
    for (let i = 1; i <= 50; i++) {
      const id = String(i);
      expect(echoRank(id, 'KG', ['KG', 'DO'])).toBe(echoRank(id, 'kg', ['kg', 'do']));
    }
  });
});
