// echo-hrw.test.mjs — the 👂-echo deterministic PICK (operator 2026-07-10, Phase 3a;
// plans/2607101713-HRW-ECHO-PLAN.md). Locks the rendezvous-hash pick that makes exactly ONE
// co-account spine echo each voice note — NOT dedup: no coordination, the shared note id + the
// shared candidate set are the ONLY thing making the two nodes agree on the same winner.
import { describe, it, expect } from 'vitest';
import { hrwWinner, isEchoWinner } from '../src/spine/echo-hrw.mjs';

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
