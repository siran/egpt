// Locks the pure scoring behind the 👂 echo-coverage query (src/text-similarity.mjs):
//   - normalizeTokens drops emoji / punctuation / symbols and folds diacritics, so a
//     covering reply is matched by its WORDS, not its markers (this is WHY 👂/💸/🌉 can
//     never reach a post/no-post decision — they are simply not tokens);
//   - similarity is the OVERLAP COEFFICIENT |A∩B|/min(|A|,|B|), 0 when either is empty.
import { describe, it, expect } from 'vitest';
import { normalizeTokens, similarity } from '../src/text-similarity.mjs';

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
