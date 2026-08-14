// PER-AGENT mode (operator 2026-07-25: "better to have in config.yaml the configuration per
// agent on its mode. overridable in conversations.yaml with an agents block").
//
// THE MISSING RUNG: an agent could only take a per-conversation mode or the node-wide default —
// it had no default of its OWN, so `@e` and `@don` were forced to share one mode everywhere.
// The chain src/spine/gating.mjs `decide()` now resolves, most specific first:
//
//   conversations.yaml  <conv>.agents.<name>.<field>   per-conversation block (the ONLY one,
//                                                       phase 1, operator 2026-08-14)
//   config.yaml         agents.<name>.mode             the agent's own default   ← THE NEW RUNG
//   config.yaml         dispatch.auto_default_mode     node-wide default (EVERY being, phase 2 —
//                                                      operator 2026-08-14: no longer
//                                                      persona-only; legacy whatsapp.auto_e_default) / 'mention'
//   built-in            DEFAULT_AUTO_MODE
//
// A pre-phase-1 entry — mode/send_to_egpt written directly as `entry[<being>]`, OUTSIDE
// agents: — is NOT read any more (getBeing only reads `entry.agents.<being>`); the
// "REGRESSION" describe below locks that it degrades silently to the ordinary default chain,
// never a migration, never a crash (operator decision — see conversations-state.mjs's
// getBeing doc comment).
//
// The mode SEMANTICS (auto-mode.replyAllowed) are untouched — this locks only WHICH mode a
// given agent resolves to in a given conversation.
import { describe, it, expect } from 'vitest';
import { createGating } from '../src/spine/gating.mjs';

const JID = '!room:beeper.com';
const ev = { surface: 'whatsapp', chatId: JID, kind: 'message' };
const MID     = { atEStart: false, atEAnywhere: true,  replyToBot: false };
const AT_HEAD = { atEStart: true,  atEAnywhere: true,  replyToBot: false };

// A conversation entry, written literally (no EGPT_HOME touch): `patch` is merged onto the
// contact entry so a test can supply either shape of per-conversation block.
const convState = (patch = {}) => ({
  contacts: { whatsapp: { [JID]: { slug: 'fam', pushedName: 'fam', ...patch } } },
});
const mk = (config, state = null) => createGating({
  getConfig: () => config,
  loadState: state ? async () => state : null,
  defaultKey: 'e',
});

describe('REPRODUCE-FIRST 1 — config.yaml agents.<name>.mode is that agent\'s own default', () => {
  it('a sibling agent takes its configured mode instead of the built-in sibling default', async () => {
    const g = mk({ agents: { wren: { configuration: 'sonnet-high', mode: 'on' } } });
    expect((await g.decide('wren', ev)).mode).toBe('on');
  });

  it('the PERSONA agent\'s own mode beats the node-wide dispatch.auto_default_mode', async () => {
    const g = mk({ agents: { e: { default: true, mode: 'mute' } }, dispatch: { auto_default_mode: 'on' } });
    expect((await g.decide('e', ev)).mode).toBe('mute');
  });

  it('TWO agents with DIFFERENT modes in ONE config behave differently on the SAME message', async () => {
    // e: mention (a mid-sentence @e is enough) · don: mention-direct (only at the head)
    const g = mk({ agents: { e: { default: true, mode: 'mention' }, don: { relay_channel: 'mesh', mode: 'mention-direct' } } });
    expect((await g.decide('e',   ev, MID)).mayReply).toBe(true);    // @e mid-sentence answers
    expect((await g.decide('don', ev, MID)).mayReply).toBe(false);   // @don mid-sentence stays silent
    expect((await g.decide('don', ev, AT_HEAD)).mayReply).toBe(true); // …but @don at the head wakes it
  });

  it('an unknown mode value on an agent is ignored (falls through to the node default)', async () => {
    // phase 2 (operator 2026-08-14): the node default now applies to every being, so an
    // invalid per-agent mode falls through to dispatch.auto_default_mode, not a sibling-only
    // 'mention' floor.
    const g = mk({ agents: { wren: { mode: 'bogus' } }, dispatch: { auto_default_mode: 'on' } });
    expect((await g.decide('wren', ev)).mode).toBe('on');   // node default, not 'bogus'
  });

  it('the agents map is keyed lowercase (boot\'s own convention) — a routed being resolves case-insensitively', async () => {
    const g = mk({ agents: { wren: { mode: 'mute' } } });
    expect((await g.decide('Wren', ev)).mode).toBe('mute');
  });
});

describe('REPRODUCE-FIRST 2 — conversations.yaml `agents:` block overrides the per-agent config', () => {
  it('<conv>.agents.<name>.mode WINS over config.yaml agents.<name>.mode', async () => {
    const g = mk(
      { agents: { wren: { mode: 'on' } } },
      convState({ agents: { wren: { mode: 'mute' } } }),
    );
    expect((await g.decide('wren', ev)).mode).toBe('mute');
  });

  it('the persona is a normal agent here too', async () => {
    const g = mk(
      { agents: { e: { default: true, mode: 'on' } }, dispatch: { auto_default_mode: 'on' } },
      convState({ agents: { e: { mode: 'mention-direct' } } }),
    );
    expect((await g.decide('e', ev)).mode).toBe('mention-direct');
  });

  it('the `agents:` block carries every per-conversation field flat, side by side (phase 1: one block, not a merge)', async () => {
    const g = mk(
      { agents: { e: { default: true, mode: 'on' } } },
      convState({ agents: { e: { mode: 'mute', send_to_egpt: 'always' } } }),
    );
    const d = await g.decide('e', ev);
    expect(d.mode).toBe('mute');
    expect(d.sendToEgpt).toBe('always');
  });

  it('a conversation naming OTHER agents leaves this one on its config default', async () => {
    const g = mk(
      { agents: { wren: { mode: 'on' }, don: { mode: 'mute' } } },
      convState({ agents: { don: { mode: 'off' } } }),
    );
    expect((await g.decide('wren', ev)).mode).toBe('on');    // untouched by don's override
    expect((await g.decide('don',  ev)).mode).toBe('off');
  });
});

describe('REGRESSION — everything below the new rung is unchanged (except the retired pre-phase-1 shape, see below)', () => {
  it('no mode anywhere: the PERSONA still gets dispatch.auto_default_mode', async () => {
    expect((await mk({ dispatch: { auto_default_mode: 'mute' } }).decide('e', ev)).mode).toBe('mute');
    expect((await mk({ whatsapp: { auto_e_default: 'mute' } }).decide('e', ev)).mode).toBe('mute');   // legacy home
    expect((await mk({}).decide('e', ev)).mode).toBe('mention');                                     // built-in
  });

  // PHASE 2 (operator 2026-08-14, "remove the concept of siblings"): the default-gate
  // asymmetry (`being === defaultKey ? dispatch.auto_default_mode : 'mention'`) is gone — every
  // being's un-configured default now resolves the SAME way. Was: a sibling with no mode of its
  // own always fell back to the built-in 'mention', never the node's auto_default_mode.
  it('PHASE 2: no mode anywhere — a SIBLING now ALSO gets the node-wide dispatch.auto_default_mode (no longer forced to \'mention\')', async () => {
    expect((await mk({ dispatch: { auto_default_mode: 'on' } }).decide('wren', ev)).mode).toBe('on');
  });

  it('REGRESSION: absent dispatch.auto_default_mode too — a sibling still falls back to the built-in \'mention\' (today\'s ultimate fallback, unchanged)', async () => {
    expect((await mk({}).decide('wren', ev)).mode).toBe('mention');
  });

  // REPRODUCE-FIRST (phase 1, operator 2026-08-14): a pre-phase-1 entry — mode/threadId
  // written directly as `entry.e`, OUTSIDE agents: — is NOT read any more (getBeing only
  // reads `entry.agents.<being>`). The chosen degrade is SILENT: it resolves exactly like a
  // never-instanced conversation, falling through the ordinary default chain — never a
  // migration, never a crash.
  it('a pre-phase-1 entry[<being>] block on disk degrades silently to the ordinary default (not read, not migrated)', async () => {
    const g = mk({ dispatch: { auto_default_mode: 'mention' } }, convState({ e: { mode: 'on', threadId: 'T1' } }));
    expect((await g.decide('e', ev)).mode).toBe('mention');   // the legacy flat block is inert
  });

  it('a pre-phase-1 entry[<being>] block does NOT beat config.yaml\'s per-agent mode — it is simply never read', async () => {
    const g = mk({ agents: { e: { default: true, mode: 'mute' } } }, convState({ e: { mode: 'on' } }));
    expect((await g.decide('e', ev)).mode).toBe('mute');   // config wins; the legacy block is inert
  });

  it('a pre-phase-1 entry[<being>].send_to_egpt is NOT read — the dispatch global applies instead', async () => {
    const g = mk({ dispatch: { send_to_egpt: 'mode' } }, convState({ e: { mode: 'on', send_to_egpt: 'always' } }));
    expect((await g.decide('e', ev)).sendToEgpt).toBe('mode');
  });

  it('auto_paused is still the absolute kill, per-agent mode or not', async () => {
    const g = mk({ dispatch: { auto_paused: true }, agents: { wren: { mode: 'on' } } });
    const d = await g.decide('wren', ev);
    expect(d.mode).toBe('on');
    expect(d.mayReply).toBe(false);
  });
});
