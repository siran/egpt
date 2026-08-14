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

// THE INSTANCING FIELDS through the same block (operator 2026-07-25: "in conversations.yaml i
// can override an agent's config for the conversation"). The five frozen fields — agent, type,
// model, effort, allowed_tools — may be written FLAT in `agents.<name>` (no `readonly:` wrapper)
// and layer FIELD-WISE over the spine's frozen `entry[<name>].readonly`. Before this, pinning a
// model per-conversation meant re-authoring a whole `readonly:` block under the operator's own
// key: it wore the name of the spine's snapshot AND clobbered the other four frozen fields.
describe('per-being: the agents: override reaches the INSTANCING fields', () => {
  const frozen = { agent: 'egpt', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: ['Read', 'Grep'] };
  const withPin = () => ({ contacts: { whatsapp: {
    '!pin:beeper.local': { slug: 'pin',
      egpt:   { mode: 'on', threadId: 'T1', readonly: { ...frozen } },
      agents: { egpt: { mode: 'auto', model: 'opus' } },
    },
  } } });

  it('a FLAT model pins the model — agent/type/effort/allowed_tools STILL come from the freeze', () => {
    expect(getBeing(withPin(), 'whatsapp', '!pin:beeper.local', 'egpt')).toMatchObject({
      model: 'opus',                       // ← the pin
      mode: 'auto',                        // the block-level override still works
      agent: 'egpt', brain: 'egpt', brainType: 'ccode', effort: 'high', allowedTools: ['Read', 'Grep'],
      threadId: 'T1',                      // the spine's own block is untouched
    });
  });

  it('an agents.<name>.readonly already on disk still reads — but a FLAT field beats it', () => {
    const s = { contacts: { whatsapp: {
      '!ro:beeper.local': { slug: 'ro',
        egpt:   { readonly: { ...frozen } },
        agents: { egpt: { readonly: { model: 'haiku', effort: 'low' }, model: 'opus' } },
      },
    } } };
    expect(getBeing(s, 'whatsapp', '!ro:beeper.local', 'egpt')).toMatchObject({
      model: 'opus',        // flat wins over the override's own readonly…
      effort: 'low',        // …which still layers where no flat field speaks…
      agent: 'egpt', brainType: 'ccode', allowedTools: ['Read', 'Grep'],   // …over the freeze
    });
  });

  it('a conversation with NO pin resolves exactly the freeze (nothing invented)', () => {
    const s = { contacts: { whatsapp: { '!plain:beeper.local': { slug: 'p', egpt: { readonly: { ...frozen } } } } } };
    expect(getBeing(s, 'whatsapp', '!plain:beeper.local', 'egpt')).toMatchObject({
      model: 'sonnet', effort: 'high', agent: 'egpt', brainType: 'ccode', allowedTools: ['Read', 'Grep'],
    });
  });

  it('the pin adds NO phantom resident (the _FLAT_ENTRY_KEYS trap)', () => {
    expect(residentsOf(withPin().contacts.whatsapp['!pin:beeper.local'])).toEqual(['egpt']);
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

// access_level (operator 2026-08-14, /e access all|regular) is an ALWAYS-OVERRIDE field:
// it must land in the agents.<being> block on EVERY write, first write included — unlike
// every other field above, which only routes there once the override block already
// defines it (a first-time write otherwise lands in the spine's own entry[being] snapshot,
// which is the wrong home: access_level is never spine machine-state). Regression-locks
// that this special-case did NOT change how any OTHER field routes.
describe('per-being: access_level always routes to the agents: override block, first write included', () => {
  it('getBeing reads access_level back from the override block', () => {
    const state = { contacts: { whatsapp: { '!ovr:beeper.local': {
      slug: 'ovr', e: { mode: 'on' }, agents: { e: { access_level: 'all' } },
    } } } };
    expect(getBeing(state, 'whatsapp', '!ovr:beeper.local', 'e').accessLevel).toBe('all');
  });

  it('a being with no access_level ever written resolves accessLevel: null', () => {
    const state = { contacts: { whatsapp: { '!plain:beeper.local': { slug: 'plain', e: { mode: 'on' } } } } };
    expect(getBeing(state, 'whatsapp', '!plain:beeper.local', 'e').accessLevel).toBe(null);
  });

  it('a FIRST-TIME access_level write on a being with NO agents: block at all lands in entry.agents.<being>, not entry[<being>]', () => {
    const state = { contacts: { whatsapp: { '!fresh:beeper.local': { slug: 'fresh', e: { mode: 'on', threadId: 'T1' } } } } };
    const s = patchBeing(state, 'whatsapp', '!fresh:beeper.local', 'e', { access_level: 'all' });
    const entry = s.contacts.whatsapp['!fresh:beeper.local'];
    expect(entry.agents).toEqual({ e: { access_level: 'all' } });
    expect(entry.e).toEqual({ mode: 'on', threadId: 'T1' });   // the spine's block untouched
    expect(getBeing(s, 'whatsapp', '!fresh:beeper.local', 'e').accessLevel).toBe('all');
  });

  it('a second access_level write updates the existing pin; an unrelated field in the SAME patch still routes by the normal rule', () => {
    const seeded = { contacts: { whatsapp: { '!ovr:beeper.local': {
      slug: 'ovr', e: { mode: 'on', threadId: 'T9' }, agents: { e: { access_level: 'all' } },
    } } } };
    const s = patchBeing(seeded, 'whatsapp', '!ovr:beeper.local', 'e', { access_level: 'regular', threadId: 'T-NEW' });
    expect(getBeing(s, 'whatsapp', '!ovr:beeper.local', 'e').accessLevel).toBe('regular');
    const entry = s.contacts.whatsapp['!ovr:beeper.local'];
    expect(entry.agents.e.access_level).toBe('regular');
    expect(entry.e.threadId).toBe('T-NEW');   // threadId is not agents:-pinned here, so it still goes to entry[being]
  });

  it('access_level survives the YAML round-trip', () => {
    const state = { contacts: { whatsapp: { '!fresh:beeper.local': { slug: 'fresh', e: { mode: 'on' } } } } };
    const s = patchBeing(state, 'whatsapp', '!fresh:beeper.local', 'e', { access_level: 'all' });
    expect(getBeing(parse(serialize(s)), 'whatsapp', '!fresh:beeper.local', 'e').accessLevel).toBe('all');
  });

  it('regression: mode/threadId still route by the pre-existing k-in-ovr rule, unaffected by the access_level special-case', () => {
    const seeded = { contacts: { whatsapp: { '!ovr:beeper.local': {
      slug: 'ovr',
      e: { mode: 'on', threadId: 'T9', readonly: { model: 'opus' } },
      agents: { e: { mode: 'mute' }, don: { mode: 'mention-direct' } },
    } } } };
    const s = patchBeing(seeded, 'whatsapp', '!ovr:beeper.local', 'e', { mode: 'mention' });
    const entry = s.contacts.whatsapp['!ovr:beeper.local'];
    expect(entry.agents.e.mode).toBe('mention');   // agents.e already pinned mode → still routes there
    expect(entry.e.threadId).toBe('T9');           // threadId (unpinned) still goes to entry[being]
  });
});
