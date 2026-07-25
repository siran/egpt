import { describe, it, expect } from 'vitest';
import { getBeing, residentsOf, patchBeing, recordThread, serialize, parse } from '../src/conversations-state.mjs';

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

// patchBeing is the WRITE side of that merge (operator 2026-07-25: "so fix /e auto to the new
// config"). The invariant it exists to hold: getBeing reads back exactly what was written, no
// matter which of the two blocks the field currently resolves from.
describe('per-being: patchBeing lands each field where getBeing resolves it', () => {
  const base = () => ({ contacts: { whatsapp: {
    '!ovr:beeper.local': { slug: 'ovr',
      e:      { mode: 'on', threadId: 'T9', readonly: { model: 'opus' } },
      agents: { e: { mode: 'mute' }, don: { mode: 'mention-direct' } },
    },
    '!old:beeper.local': { slug: 'old', e: { mode: 'on', threadId: 'T1' } },
  } } });

  it('a field the agents: block pins is written THERE — the effective value changes', () => {
    const s = patchBeing(base(), 'whatsapp', '!ovr:beeper.local', 'e', { mode: 'mention' });
    expect(getBeing(s, 'whatsapp', '!ovr:beeper.local', 'e').mode).toBe('mention');
    const entry = s.contacts.whatsapp['!ovr:beeper.local'];
    expect(entry.agents.e.mode).toBe('mention');
    expect(entry.agents.don).toEqual({ mode: 'mention-direct' });   // another agent's pin untouched
    expect(entry.e.threadId).toBe('T9');                            // the spine's block untouched
  });

  it('a field the agents: block does NOT pin keeps going to entry[being] — no machine state in the operator block', () => {
    const s = recordThread(base(), 'whatsapp', '!ovr:beeper.local', 'T-NEW', '2026-07-25T00:00:00Z', 'e');
    expect(getBeing(s, 'whatsapp', '!ovr:beeper.local', 'e').threadId).toBe('T-NEW');
    const entry = s.contacts.whatsapp['!ovr:beeper.local'];
    expect(entry.e.threadId).toBe('T-NEW');
    expect(entry.agents.e).toEqual({ mode: 'mute' });   // the pin is not where threads get recorded
    expect(getBeing(s, 'whatsapp', '!ovr:beeper.local', 'e').mode).toBe('mute');   // …and it still wins
  });

  it('an agents-only being: writing a pinned field updates the pin, an unpinned one opens its own block', () => {
    const s = patchBeing(base(), 'whatsapp', '!ovr:beeper.local', 'don', { mode: 'off', threadId: 'T-DON' });
    expect(getBeing(s, 'whatsapp', '!ovr:beeper.local', 'don')).toMatchObject({ mode: 'off', threadId: 'T-DON' });
    const entry = s.contacts.whatsapp['!ovr:beeper.local'];
    expect(entry.agents.don).toEqual({ mode: 'off' });
    expect(entry.don).toEqual({ threadId: 'T-DON' });
  });

  it('a conversation with no agents: block never grows one (nothing migrates)', () => {
    const s = patchBeing(base(), 'whatsapp', '!old:beeper.local', 'e', { mode: 'mute' });
    const entry = s.contacts.whatsapp['!old:beeper.local'];
    expect(entry).toEqual({ slug: 'old', e: { mode: 'mute', threadId: 'T1' } });
    expect(getBeing(s, 'whatsapp', '!old:beeper.local', 'e').mode).toBe('mute');
  });

  it('the written override survives the YAML round-trip (it is read back off disk, not just in memory)', () => {
    const s = patchBeing(base(), 'whatsapp', '!ovr:beeper.local', 'e', { mode: 'mention' });
    expect(getBeing(parse(serialize(s)), 'whatsapp', '!ovr:beeper.local', 'e').mode).toBe('mention');
  });
});
