import { describe, it, expect } from 'vitest';
import { getBeing, residentsOf } from '../conversations-state.mjs';

// A flat (un-migrated) conversation and a nested (per-being) one in the same state.
const state = { contacts: { whatsapp: {
  '!flat:beeper.local':   { slug: 'flat', mode: 'mention', personality: 'banter', threadId: 'T1', threadCreatedAt: 'C1', identityInjectedAt: 'I1' },
  '!nested:beeper.local': { slug: 'nested',
    e:    { mode: 'on',      readonly: { model: 'opus',  effort: 'high',   personality: 'default' }, threadId: 'T2', threadCreatedAt: 'C2', identityInjectedAt: 'I2' },
    wren: { mode: 'mention', readonly: { model: 'haiku', effort: 'medium', personality: 'banter'  }, threadId: 'T3' },
  },
} } };

describe('per-being reader convergence (#2)', () => {
  it('a legacy FLAT entry no longer resolves the persona from flat fields — present:false (operator 2026-07-10: one-time reset, persona is a nested being now)', () => {
    const v = getBeing(state, 'whatsapp', '!flat:beeper.local', 'e');
    expect(v.present).toBe(false);          // no nested `e` block → the flat mode/thread are abandoned
    expect(v.mode).toBe(null);
    expect(v.threadId).toBe(null);
    expect(v.slug).toBe('flat');            // contact-level fields (slug) still resolve
  });

  it('nested entry resolves e through the e: block', () => {
    expect(getBeing(state, 'whatsapp', '!nested:beeper.local', 'e')).toMatchObject({
      present: true, mode: 'on', threadId: 'T2', model: 'opus', effort: 'high',
    });
  });

  it('a named resident resolves through its own block', () => {
    expect(getBeing(state, 'whatsapp', '!nested:beeper.local', 'wren')).toMatchObject({
      present: true, being: 'wren', mode: 'mention', threadId: 'T3', model: 'haiku',
    });
  });

  it('a being with no block (and not e) is absent — no flat-field leak', () => {
    const w = getBeing(state, 'whatsapp', '!flat:beeper.local', 'wren');
    expect(w.present).toBe(false);
    expect(w.mode).toBe(null);
    expect(w.threadId).toBe(null);
  });

  it('returns null for an unknown contact', () => {
    expect(getBeing(state, 'whatsapp', '!nope:beeper.local', 'e')).toBe(null);
  });

  it('residentsOf: flat → []; nested → [e, wren] (operator 2026-07-10: no implicit "e")', () => {
    expect(residentsOf(state.contacts.whatsapp['!flat:beeper.local'])).toEqual([]);
    expect(residentsOf(state.contacts.whatsapp['!nested:beeper.local'])).toEqual(['e', 'wren']);
  });
});
