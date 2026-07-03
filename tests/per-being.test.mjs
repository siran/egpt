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
  it('flat entry resolves e through the legacy fields (no nested block needed)', () => {
    expect(getBeing(state, 'whatsapp', '!flat:beeper.local', 'e')).toMatchObject({
      present: true, being: 'e', mode: 'mention', threadId: 'T1', model: null, effort: null,
    });
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

  it('residentsOf: flat → [e]; nested → [e, wren]', () => {
    expect(residentsOf(state.contacts.whatsapp['!flat:beeper.local'])).toEqual(['e']);
    expect(residentsOf(state.contacts.whatsapp['!nested:beeper.local'])).toEqual(['e', 'wren']);
  });
});
