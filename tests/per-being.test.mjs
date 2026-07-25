import { describe, it, expect } from 'vitest';
import { getBeing, residentsOf } from '../src/conversations-state.mjs';

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

// The `agents:` block (operator 2026-07-25: "overridable in conversations.yaml with an agents
// block") — the per-conversation OVERRIDE home. It layers OVER the being's existing block
// field-by-field, so an operator can pin one agent's mode in one chat without disturbing the
// threadId/readonly the spine writes there, and every entry already on disk keeps working.
describe('per-being: the conversations.yaml `agents:` override block', () => {
  const withAgents = { contacts: { whatsapp: {
    '!ovr:beeper.local': { slug: 'ovr',
      e:      { mode: 'on', send_to_egpt: 'always', threadId: 'T9', readonly: { model: 'opus', agent: 'sonnet-high' } },
      agents: { e: { mode: 'mute' }, don: { mode: 'mention-direct' } },
    },
  } } };

  it('an agents: entry OVERRIDES the same-named field and leaves the rest of the block intact', () => {
    expect(getBeing(withAgents, 'whatsapp', '!ovr:beeper.local', 'e')).toMatchObject({
      present: true, mode: 'mute', send_to_egpt: 'always', threadId: 'T9', model: 'opus', agent: 'sonnet-high',
    });
  });

  it('an agent that exists ONLY in the agents: block resolves from it (present, no legacy block needed)', () => {
    expect(getBeing(withAgents, 'whatsapp', '!ovr:beeper.local', 'don')).toMatchObject({
      present: true, being: 'don', mode: 'mention-direct', threadId: null,
    });
  });

  it('`agents` is a CONTAINER, never a resident — residentsOf must not list it', () => {
    expect(residentsOf(withAgents.contacts.whatsapp['!ovr:beeper.local'])).toEqual(['e']);
  });
});
