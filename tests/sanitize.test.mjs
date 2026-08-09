// Characterization test for Phase 0a (conversations↔rooms merge): the sanitizers
// moved to the leaf src/sanitize.mjs must produce BYTE-IDENTICAL output to their
// old behavior, and the re-exports from the original homes must be the same fn.

import { describe, it, expect } from 'vitest';
import { sanitizeSlug, sanitizeName } from '../src/sanitize.mjs';
import { sanitizeSlug as slugFromConvState } from '../src/conversations-state.mjs';

describe('sanitizeSlug — Windows-path-safe, name-preserving (characterization)', () => {
  it('keeps accents, spaces, parens, plus — strips only Windows-illegal chars', () => {
    expect(sanitizeSlug('Tío Jesús Palma')).toBe('Tío Jesús Palma');
    expect(sanitizeSlug('+1 (646) 821-7865')).toBe('+1 (646) 821-7865');
    expect(sanitizeSlug('premise-driven bitcoin')).toBe('premise-driven bitcoin');
  });

  it('illegal chars → single space; collapses whitespace; trims dots/spaces', () => {
    expect(sanitizeSlug('a/b:c*d')).toBe('a b c d');
    expect(sanitizeSlug('  hello   world  ')).toBe('hello world');
    expect(sanitizeSlug('...name...')).toBe('name');
  });

  it('reserved device names get an underscore; empty → ""', () => {
    expect(sanitizeSlug('CON')).toBe('CON_');
    expect(sanitizeSlug('nul')).toBe('nul_');
    expect(sanitizeSlug('')).toBe('');
    expect(sanitizeSlug('   ')).toBe('');
    expect(sanitizeSlug(null)).toBe('');
  });

  it('caps at 80 chars and is idempotent', () => {
    const long = 'x'.repeat(120);
    expect(sanitizeSlug(long)).toBe('x'.repeat(80));
    const once = sanitizeSlug('Tío/Jesús');
    expect(sanitizeSlug(once)).toBe(once);
  });

  it('conversations-state re-exports the SAME function', () => {
    expect(slugFromConvState).toBe(sanitizeSlug);
  });
});

describe('sanitizeName — kebab room handle (characterization)', () => {
  it('lowercases to a kebab token; empty → "room"', () => {
    expect(sanitizeName('Work')).toBe('work');
    expect(sanitizeName('ChatGPT CDP')).toBe('chatgpt-cdp');
    expect(sanitizeName('  --weird__name--  ')).toBe('weird__name');
    expect(sanitizeName('')).toBe('room');
    expect(sanitizeName(null)).toBe('room');
  });
});
