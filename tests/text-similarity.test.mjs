// Locks the pure scoring behind the 👂 echo-coverage query (src/text-similarity.mjs):
//   - normalizeTokens drops emoji / punctuation / symbols and folds diacritics, so a
//     covering reply is matched by its WORDS, not its markers (this is WHY 👂/💸/🌉 can
//     never reach a post/no-post decision — they are simply not tokens);
//   - similarity is the OVERLAP COEFFICIENT |A∩B|/min(|A|,|B|), 0 when either is empty.
// …plus closestNames, the CHARACTER-level "did you mean …?" the /members errors read
// (2026-08-31) — a different metric over the same folded space, because a one-letter typo
// makes two words disjoint TOKENS and the overlap coefficient cannot see it at all.
import { describe, it, expect } from 'vitest';
import { normalizeTokens, similarity, closestNames } from '../src/text-similarity.mjs';

describe('normalizeTokens', () => {
  it('lowercases and splits on non-alphanumerics', () => {
    expect(normalizeTokens('Hola, que TAL!')).toEqual(['hola', 'que', 'tal']);
  });

  it('drops emojis / symbols / punctuation entirely (they are not tokens)', () => {
    expect(normalizeTokens('👂 hola 💸 que 🌉 tal')).toEqual(['hola', 'que', 'tal']);
    expect(normalizeTokens('👂')).toEqual([]);
  });

  it('folds diacritics so accented and un-accented words compare equal', () => {
    expect(normalizeTokens('sí')).toEqual(['si']);
    expect(normalizeTokens('árbol niño acción')).toEqual(['arbol', 'nino', 'accion']);
  });

  it('an emoji stuck to a word still folds to the bare word — sí💸 and sí🌉 → same token', () => {
    expect(normalizeTokens('sí💸')).toEqual(['si']);
    expect(normalizeTokens('sí🌉')).toEqual(['si']);
    expect(normalizeTokens('sí💸')).toEqual(normalizeTokens('sí🌉'));
  });

  it('keeps alphanumeric runs together (a duration token like 8s survives whole)', () => {
    expect(normalizeTokens('(8s) hola')).toEqual(['8s', 'hola']);
  });

  it('null / undefined / empty → []', () => {
    expect(normalizeTokens(null)).toEqual([]);
    expect(normalizeTokens(undefined)).toEqual([]);
    expect(normalizeTokens('')).toEqual([]);
  });
});

describe('similarity — overlap coefficient', () => {
  const T = normalizeTokens;

  it('identical token sets → 1.0', () => {
    expect(similarity(T('hola que tal'), T('hola que tal'))).toBe(1);
  });

  it('completely disjoint → 0', () => {
    expect(similarity(T('hola que tal'), T('foo bar baz'))).toBe(0);
  });

  it('either side empty → 0', () => {
    expect(similarity(T(''), T('hola'))).toBe(0);
    expect(similarity(T('hola'), T(''))).toBe(0);
    expect(similarity([], [])).toBe(0);
  });

  it('overlap coefficient divides by the SMALLER set (a near-substring stays ~1.0)', () => {
    // one transcript adds a leading duration + trailing words; the shorter is fully contained → 1.0
    expect(similarity(T('8s hola que tal extra words'), T('hola que tal'))).toBe(1);
  });

  it('partial overlap scores between 0 and 1', () => {
    // A={hola,que,tal}, B={hola,que,otra,cosa}; ∩={hola,que}=2, min=3 → 2/3
    expect(similarity(T('hola que tal'), T('hola que otra cosa'))).toBeCloseTo(2 / 3, 10);
  });

  it("a peer's 👂 echo (marker + duration) still matches the bare transcript ≥ 0.6", () => {
    const mine = T('hola que tal como estas');
    const peerEcho = T('👂 (8s) hola que tal como estas');   // marker + duration prefix, same words
    expect(similarity(peerEcho, mine)).toBeGreaterThanOrEqual(0.6);
  });
});

// closestNames — the "did you mean …?" behind /members' two dead-end errors.
describe('closestNames — character-level near-miss', () => {
  // The operator's live case, 2026-08-31: a chat named with two c's, typed with one.
  const CHATS = ['perrito traducciones', 'Radio WnL', 'Familia', 'egpt-mesh-do-kg'];

  it('catches the ONE-LETTER miss the overlap coefficient cannot see', () => {
    // token sets {perrito,traduciones} vs {perrito,traducciones} → disjoint on the 2nd word
    expect(similarity(normalizeTokens('perrito traduciones'), normalizeTokens('perrito traducciones'))).toBe(0.5);
    expect(closestNames('perrito traduciones', CHATS)).toEqual(['perrito traducciones']);
  });

  it('a single-word typo, where token overlap scores a flat 0', () => {
    expect(similarity(normalizeTokens('Familai'), normalizeTokens('Familia'))).toBe(0);
    expect(closestNames('Familai', CHATS)).toEqual(['Familia']);
  });

  it('compares in the folded space — case, accents and punctuation are free', () => {
    expect(closestNames('RADIO WNL!', CHATS)).toEqual(['Radio WnL']);
    expect(closestNames('perrito traducciónes', CHATS)).toEqual(['perrito traducciones']);
  });

  it('a CONTAINED fragment is a hit even though the ratio alone would bury it', () => {
    expect(closestNames('radio', CHATS)).toEqual(['Radio WnL']);
  });

  it('returns the candidate VERBATIM, so it can be quoted back at the operator', () => {
    expect(closestNames('egpt mesh do kg', CHATS)).toEqual(['egpt-mesh-do-kg']);
  });

  it('nothing close enough → [] (a wrong guess costs another attempt)', () => {
    expect(closestNames('zzzzzzzzzz', CHATS)).toEqual([]);
    expect(closestNames('', CHATS)).toEqual([]);
    expect(closestNames('anything', [])).toEqual([]);
    expect(closestNames('anything', null)).toEqual([]);
  });

  it('nearest first, capped by limit, de-duplicated', () => {
    const near = closestNames('familia', ['Familia', 'familia', 'Familai', 'Familias', 'zzz'], { limit: 2 });
    expect(near).toEqual(['Familia', 'Familias']);   // 'familia' folds to the same key as 'Familia' — one entry
  });
});
