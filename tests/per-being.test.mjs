import { describe, it, expect } from 'vitest';
import { getBeing, residentsOf, patchBeing, deleteBeing, recordThread, serialize, parse } from '../src/conversations-state.mjs';

// PHASE 1 (operator 2026-08-14): ONE block per being — `entry.agents.<being>` — flat, carrying
// every field the being has (mode, send_to_egpt, threadId, threadCreatedAt, identityInjectedAt,
// access_level). There is no more separate spine-written `entry[<being>]` snapshot AND no more
// `readonly` sub-object anywhere: agent/type/model/effort/allowed_tools are never frozen per
// conversation — brainpool.mjs resolves them fresh from config every turn instead, so getBeing
// no longer returns them at all.
//
// A pre-phase-1 entry — mode/threadId/readonly written directly as `entry[<being>]`, OUTSIDE
// agents: — is NOT migrated and NOT read by getBeing (the chosen degrade: it reads back exactly
// like a never-instanced being, silently, until its next turn writes the new shape). residentsOf
// still RECOGNIZES such a legacy block (so config-resolver doesn't mistake it for arbitrary
// config) even though getBeing ignores its contents entirely — that split is locked below.
const state = { contacts: { whatsapp: {
  '!legacy:beeper.local': { slug: 'legacy', mode: 'mention', personality: 'banter', threadId: 'T1', threadCreatedAt: 'C1', identityInjectedAt: 'I1' },
  '!pre-phase1:beeper.local': { slug: 'prephase1',
    // The pre-phase-1 shape: entry[<being>], no agents: block at all.
    e:    { mode: 'on', threadId: 'T2', threadCreatedAt: 'C2', identityInjectedAt: 'I2' },
    wren: { mode: 'mention', threadId: 'T3' },
  },
  '!current:beeper.local': { slug: 'current',
    agents: {
      e:    { mode: 'on', threadId: 'T4', threadCreatedAt: 'C4', identityInjectedAt: 'I4' },
      wren: { mode: 'mention', threadId: 'T5' },
    },
  },
} } };

describe('getBeing — reads ONLY entry.agents.<being> (phase 1)', () => {
  it('a legacy top-level FLAT entry (pre-2026-07-10) never resolves the persona — present:false', () => {
    const v = getBeing(state, 'whatsapp', '!legacy:beeper.local', 'e');
    expect(v.present).toBe(false);
    expect(v.mode).toBe(null);
    expect(v.threadId).toBe(null);
    expect(v.slug).toBe('legacy');   // contact-level fields (slug) still resolve
  });

  it('a pre-phase-1 entry[<being>] block (mode/thread written OUTSIDE agents:) is NOT read — degrades to present:false, exactly like never-instanced', () => {
    const v = getBeing(state, 'whatsapp', '!pre-phase1:beeper.local', 'e');
    expect(v.present).toBe(false);
    expect(v.mode).toBe(null);
    expect(v.threadId).toBe(null);
    expect(v.slug).toBe('prephase1');
  });

  it('the CURRENT shape resolves the persona through agents.e', () => {
    expect(getBeing(state, 'whatsapp', '!current:beeper.local', 'e')).toMatchObject({
      present: true, mode: 'on', threadId: 'T4',
    });
  });

  it('a named sibling resolves through its own agents.<name> block', () => {
    expect(getBeing(state, 'whatsapp', '!current:beeper.local', 'wren')).toMatchObject({
      present: true, being: 'wren', mode: 'mention', threadId: 'T5',
    });
  });

  it('a being with no agents block at all is absent — no leak from a sibling key', () => {
    const w = getBeing(state, 'whatsapp', '!legacy:beeper.local', 'wren');
    expect(w.present).toBe(false);
    expect(w.mode).toBe(null);
    expect(w.threadId).toBe(null);
  });

  it('returns null for an unknown contact', () => {
    expect(getBeing(state, 'whatsapp', '!nope:beeper.local', 'e')).toBe(null);
  });

  it('no more readonly-derived fields: model/effort/brain/brainType/allowedTools are gone from the view', () => {
    const v = getBeing(state, 'whatsapp', '!current:beeper.local', 'e');
    expect(v.model).toBeUndefined();
    expect(v.effort).toBeUndefined();
    expect(v.brain).toBeUndefined();
    expect(v.brainType).toBeUndefined();
    expect(v.allowedTools).toBeUndefined();
  });
});

// AUTO-COMPACTION overrides (operator 2026-09-03: config/agents.yaml is where a globally-pinned
// agent's "threads, compaction rules — en fin, honor existing configuration keys" live). Unlike
// every other per-conversation override this one is OBJECT-valued, because the node-global
// `compaction:` block it overrides is — and it reuses that block's OWN key names (`enabled`,
// `ratio`, `cooling_ms`, `context_window`) rather than a second dialect of them. RAW here, like
// access_level/allow_new_input above: getBeing reports what the file SAYS, and brainpool's
// resolveConv is the ONE place that decides what it MEANS.
describe('getBeing — the compaction override block (operator 2026-09-03)', () => {
  const st = (compaction) => ({ contacts: { whatsapp: { '!comp:beeper.local': { slug: 'comp',
    agents: { e: { mode: 'on', ...(compaction === undefined ? {} : { compaction }) } },
  } } } });
  const read = (compaction) => getBeing(st(compaction), 'whatsapp', '!comp:beeper.local', 'e').compaction;

  it('present → the block comes back VERBATIM, keys and values untouched', () => {
    const block = { enabled: true, ratio: 0.8, cooling_ms: 30_000, context_window: 1_000_000 };
    expect(read(block)).toEqual(block);
  });

  it('absent → null ("this conversation states nothing" — the node-global block keeps applying)', () => {
    expect(read(undefined)).toBe(null);
    expect(getBeing(state, 'whatsapp', '!current:beeper.local', 'e').compaction).toBe(null);
  });

  it('not a plain object (a scalar, a list) → null, never handed on as a policy', () => {
    expect(read('0.8')).toBe(null);
    expect(read(['ratio', 0.8])).toBe(null);
    expect(read(0.8)).toBe(null);
  });
});

describe('residentsOf — agents.<name> keys, PLUS a recognized-but-inert legacy entry[<being>] block', () => {
  it('a legacy flat entry (no object-valued being block at all) has no residents', () => {
    expect(residentsOf(state.contacts.whatsapp['!legacy:beeper.local'])).toEqual([]);
  });

  it('a pre-phase-1 entry — RECOGNIZED as residents (config-resolver exclusion) even though getBeing never reads them', () => {
    expect(residentsOf(state.contacts.whatsapp['!pre-phase1:beeper.local']).sort()).toEqual(['e', 'wren']);
  });

  it('the current shape — agents.<name> keys are the residents', () => {
    expect(residentsOf(state.contacts.whatsapp['!current:beeper.local']).sort()).toEqual(['e', 'wren']);
  });

  it('a contact-level block that merely resembles a being (no being-vocabulary field) is NOT a resident', () => {
    const entry = { slug: 'x', agents: { e: { mode: 'on' } }, guard: { turns: 3, window: 60 } };
    expect(residentsOf(entry)).toEqual(['e']);
  });
});

describe('patchBeing — every field lands in entry.agents.<being> (phase 1: one destination, not a split)', () => {
  const base = () => ({ contacts: { whatsapp: {
    '!ovr:beeper.local': { slug: 'ovr', agents: { e: { mode: 'on', threadId: 'T9' }, don: { mode: 'mention-direct' } } },
    '!old:beeper.local': { slug: 'old', e: { mode: 'on', threadId: 'T1' } },   // pre-phase-1 leftover, never touched by writes
  } } });

  it('a field write merges over the being\'s existing agents.<being> block — siblings survive', () => {
    const s = patchBeing(base(), 'whatsapp', '!ovr:beeper.local', 'e', { mode: 'mention' });
    expect(getBeing(s, 'whatsapp', '!ovr:beeper.local', 'e').mode).toBe('mention');
    const entry = s.contacts.whatsapp['!ovr:beeper.local'];
    expect(entry.agents.e).toEqual({ mode: 'mention', threadId: 'T9' });   // threadId survives the merge
    expect(entry.agents.don).toEqual({ mode: 'mention-direct' });          // another being's block untouched
  });

  it('recordThread writes threadId/threadCreatedAt/identityInjectedAt into agents.<being>, merged over an existing mode', () => {
    const s = recordThread(base(), 'whatsapp', '!ovr:beeper.local', 'T-NEW', '2026-07-25T00:00:00Z', 'e');
    const entry = s.contacts.whatsapp['!ovr:beeper.local'];
    expect(entry.agents.e).toMatchObject({ mode: 'on', threadId: 'T-NEW', threadCreatedAt: '2026-07-25T00:00:00Z', identityInjectedAt: '2026-07-25T00:00:00Z' });
    expect(getBeing(s, 'whatsapp', '!ovr:beeper.local', 'e').threadId).toBe('T-NEW');
  });

  it('a being with no agents.<name> block yet OPENS one — first write, same destination as every later write', () => {
    const s = patchBeing(base(), 'whatsapp', '!ovr:beeper.local', 'scribe', { mode: 'off', threadId: 'T-SCRIBE' });
    expect(getBeing(s, 'whatsapp', '!ovr:beeper.local', 'scribe')).toMatchObject({ mode: 'off', threadId: 'T-SCRIBE' });
    const entry = s.contacts.whatsapp['!ovr:beeper.local'];
    expect(entry.agents.scribe).toEqual({ mode: 'off', threadId: 'T-SCRIBE' });
  });

  it('a pre-phase-1 entry[<being>] block is left completely untouched by a write — it never becomes the write target', () => {
    const s = patchBeing(base(), 'whatsapp', '!old:beeper.local', 'e', { mode: 'mute' });
    const entry = s.contacts.whatsapp['!old:beeper.local'];
    expect(entry.e).toEqual({ mode: 'on', threadId: 'T1' });   // untouched — writes never land here any more
    expect(entry.agents).toEqual({ e: { mode: 'mute' } });     // the write opened the ONE current-shape block instead
    expect(getBeing(s, 'whatsapp', '!old:beeper.local', 'e').mode).toBe('mute');   // and getBeing reads it back
  });

  it('access_level writes exactly like any other field now — no special-cased destination', () => {
    const s = patchBeing(base(), 'whatsapp', '!ovr:beeper.local', 'e', { access_level: 'all' });
    expect(getBeing(s, 'whatsapp', '!ovr:beeper.local', 'e').accessLevel).toBe('all');
    expect(s.contacts.whatsapp['!ovr:beeper.local'].agents.e).toMatchObject({ mode: 'on', threadId: 'T9', access_level: 'all' });
  });

  it('the written block survives the YAML round-trip (read back off disk, not just in memory)', () => {
    const s = patchBeing(base(), 'whatsapp', '!ovr:beeper.local', 'e', { mode: 'mention', access_level: 'regular' });
    const back = getBeing(parse(serialize(s)), 'whatsapp', '!ovr:beeper.local', 'e');
    expect(back.mode).toBe('mention');
    expect(back.accessLevel).toBe('regular');
  });
});

describe('deleteBeing — wipes the WHOLE agents.<being> block outright', () => {
  it('present reads back false after delete; a sibling being in the same conversation is untouched', () => {
    const seeded = { contacts: { whatsapp: { '!ovr:beeper.local': { slug: 'ovr',
      agents: { e: { mode: 'on', threadId: 'T9', access_level: 'all' }, don: { mode: 'mention-direct' } },
    } } } };
    const s = deleteBeing(seeded, 'whatsapp', '!ovr:beeper.local', 'e');
    expect(getBeing(s, 'whatsapp', '!ovr:beeper.local', 'e').present).toBe(false);
    expect(getBeing(s, 'whatsapp', '!ovr:beeper.local', 'don').present).toBe(true);
    expect(getBeing(s, 'whatsapp', '!ovr:beeper.local', 'don').mode).toBe('mention-direct');
  });

  it('deleting the LAST being drops the now-empty agents: container entirely, not a stray {}', () => {
    const seeded = { contacts: { whatsapp: { '!solo:beeper.local': { slug: 'solo', agents: { e: { mode: 'on' } } } } } };
    const s = deleteBeing(seeded, 'whatsapp', '!solo:beeper.local', 'e');
    const entry = s.contacts.whatsapp['!solo:beeper.local'];
    expect(entry.agents).toBeUndefined();
  });

  it('a pre-phase-1 entry[<being>] block is left alone by deleteBeing too (it never touches that key)', () => {
    const seeded = { contacts: { whatsapp: { '!old:beeper.local': { slug: 'old', e: { mode: 'on', threadId: 'T1' }, agents: { e: { access_level: 'all' } } } } } };
    const s = deleteBeing(seeded, 'whatsapp', '!old:beeper.local', 'e');
    expect(s.contacts.whatsapp['!old:beeper.local'].e).toEqual({ mode: 'on', threadId: 'T1' });   // untouched
    expect(getBeing(s, 'whatsapp', '!old:beeper.local', 'e').present).toBe(false);                 // but reads back gone
  });
});
