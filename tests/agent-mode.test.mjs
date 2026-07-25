// PER-AGENT mode (operator 2026-07-25: "better to have in config.yaml the configuration per
// agent on its mode. overridable in conversations.yaml with an agents block").
//
// THE MISSING RUNG: an agent could only take a per-conversation mode or the node-wide default —
// it had no default of its OWN, so `@e` and `@don` were forced to share one mode everywhere.
// The chain src/spine/gating.mjs `decide()` now resolves, most specific first:
//
//   conversations.yaml  <conv>.agents.<name>.<field>   per-conversation override (NEW shape)
//   conversations.yaml  <conv>.<name>.<field>          per-conversation block    (current shape)
//   config.yaml         agents.<name>.mode             the agent's own default   ← THE NEW RUNG
//   config.yaml         dispatch.auto_default_mode     node-wide default (persona; legacy
//                                                      whatsapp.auto_e_default) / 'mention'
//   built-in            DEFAULT_AUTO_MODE
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
    const g = mk({ agents: { wren: { mode: 'bogus' } }, dispatch: { auto_default_mode: 'on' } });
    expect((await g.decide('wren', ev)).mode).toBe('mention');   // sibling default, not 'bogus'
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

  it('the `agents:` block overrides FIELD-WISE — the current-shape block keeps every field it does not name', async () => {
    const g = mk(
      { agents: { e: { default: true, mode: 'on' } } },
      convState({ e: { mode: 'on', send_to_egpt: 'always' }, agents: { e: { mode: 'mute' } } }),
    );
    const d = await g.decide('e', ev);
    expect(d.mode).toBe('mute');            // the agents: block's mode
    expect(d.sendToEgpt).toBe('always');    // …and the existing block's send_to_egpt survives
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

describe('REGRESSION — everything below the new rung is unchanged', () => {
  it('no mode anywhere: the PERSONA still gets dispatch.auto_default_mode', async () => {
    expect((await mk({ dispatch: { auto_default_mode: 'mute' } }).decide('e', ev)).mode).toBe('mute');
    expect((await mk({ whatsapp: { auto_e_default: 'mute' } }).decide('e', ev)).mode).toBe('mute');   // legacy home
    expect((await mk({}).decide('e', ev)).mode).toBe('mention');                                     // built-in
  });

  it('no mode anywhere: a SIBLING still gets the built-in \'mention\' (never the persona\'s node default)', async () => {
    expect((await mk({ dispatch: { auto_default_mode: 'on' } }).decide('wren', ev)).mode).toBe('mention');
  });

  it('an EXISTING conversations.yaml entry in the CURRENT shape still resolves (no migration required)', async () => {
    const g = mk({ dispatch: { auto_default_mode: 'mention' } }, convState({ e: { mode: 'on', threadId: 'T1' } }));
    expect((await g.decide('e', ev)).mode).toBe('on');
  });

  it('the CURRENT-shape per-conversation block still beats the new config.yaml per-agent mode', async () => {
    const g = mk({ agents: { e: { default: true, mode: 'mute' } } }, convState({ e: { mode: 'on' } }));
    expect((await g.decide('e', ev)).mode).toBe('on');
  });

  it('the per-conversation send_to_egpt override still beats the dispatch global', async () => {
    const g = mk({ dispatch: { send_to_egpt: 'mode' } }, convState({ e: { mode: 'on', send_to_egpt: 'always' } }));
    expect((await g.decide('e', ev)).sendToEgpt).toBe('always');
  });

  it('auto_paused is still the absolute kill, per-agent mode or not', async () => {
    const g = mk({ dispatch: { auto_paused: true }, agents: { wren: { mode: 'on' } } });
    const d = await g.decide('wren', ev);
    expect(d.mode).toBe('on');
    expect(d.mayReply).toBe(false);
  });
});
