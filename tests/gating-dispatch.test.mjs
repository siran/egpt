// Locks the dispatch: consolidation (operator 2026-07-10): the persona routing
// globals moved OUT of the whatsapp transport block into `dispatch:` —
// auto_default_mode, auto_paused, and the new send_to_egpt global default. Each
// read in src/spine/gating.mjs is canonical-with-legacy-fallback
// (`c.dispatch?.<k> ?? c.whatsapp?.<legacy>`), so deploying onto a legacy-shaped
// config is a NO-OP and a migrated config reads the same value from the new home.
import { describe, it, expect } from 'vitest';
import { createGating } from '../src/spine/gating.mjs';
import { emptyState, ensureContact } from '../src/conversations-state.mjs';

// No loadState → no per-conversation view (beingView returns null), so decide()
// resolves purely from config: exactly the GLOBAL-default path we want to lock.
const mkGating = (config) => createGating({ getConfig: () => config, loadState: null, defaultKey: 'e' });
const ev = { surface: 'whatsapp', chatId: '!r:beeper.com', kind: 'message' };

describe('gating dispatch: — auto_default_mode (canonical) with whatsapp.auto_e_default fallback', () => {
  it('canonical dispatch.auto_default_mode drives the persona default mode', async () => {
    expect((await mkGating({ dispatch: { auto_default_mode: 'mute' } }).decide('e', ev)).mode).toBe('mute');
  });
  it('legacy whatsapp.auto_e_default is still honored when dispatch is absent (back-compat)', async () => {
    expect((await mkGating({ whatsapp: { auto_e_default: 'mute' } }).decide('e', ev)).mode).toBe('mute');
  });
  it('canonical wins when both are present', async () => {
    const g = mkGating({ dispatch: { auto_default_mode: 'on' }, whatsapp: { auto_e_default: 'mute' } });
    expect((await g.decide('e', ev)).mode).toBe('on');
  });
});

describe('gating dispatch: — auto_paused (canonical) with whatsapp.auto_e_paused fallback', () => {
  // Use 'on' mode (replyAllowed always true) so mayReply tracks the pause flag alone.
  it('canonical dispatch.auto_paused:true is the absolute kill', async () => {
    const g = mkGating({ dispatch: { auto_paused: true, auto_default_mode: 'on' } });
    expect((await g.decide('e', ev)).mayReply).toBe(false);
  });
  it('legacy whatsapp.auto_e_paused:true still kills when dispatch is absent (back-compat)', async () => {
    const g = mkGating({ whatsapp: { auto_e_paused: true, auto_e_default: 'on' } });
    expect((await g.decide('e', ev)).mayReply).toBe(false);
  });
  it('canonical false WINS over a legacy true (a migrated node is not paused by a stale legacy flag)', async () => {
    const g = mkGating({ dispatch: { auto_paused: false, auto_default_mode: 'on' }, whatsapp: { auto_e_paused: true } });
    expect((await g.decide('e', ev)).mayReply).toBe(true);
  });
});

describe('gating dispatch: — send_to_egpt global default (canonical) with whatsapp.send_to_egpt fallback', () => {
  it('canonical dispatch.send_to_egpt is the global default', async () => {
    expect((await mkGating({ dispatch: { send_to_egpt: 'always' } }).decide('e', ev)).sendToEgpt).toBe('always');
  });
  it('legacy whatsapp.send_to_egpt is still honored when dispatch is absent (back-compat)', async () => {
    expect((await mkGating({ whatsapp: { send_to_egpt: 'always' } }).decide('e', ev)).sendToEgpt).toBe('always');
  });
  it('canonical wins when both are present', async () => {
    const g = mkGating({ dispatch: { send_to_egpt: 'mode' }, whatsapp: { send_to_egpt: 'always' } });
    expect((await g.decide('e', ev)).sendToEgpt).toBe('mode');
  });

  // PHASE 2 (operator 2026-08-14, "remove the concept of siblings"): the default-gate
  // asymmetry (`being === defaultKey ? ... : 'mention'`) is gone from defaultMode — every
  // being's un-configured default now resolves the SAME way.
  it('PHASE 2: a non-default being with no per-agent mode now ALSO follows dispatch.auto_default_mode (not forced to \'mention\')', async () => {
    expect((await mkGating({ dispatch: { auto_default_mode: 'on' } }).decide('wren', ev)).mode).toBe('on');
  });

  it('REGRESSION: the persona itself is unchanged — same node default applies as before phase 2', async () => {
    expect((await mkGating({ dispatch: { auto_default_mode: 'on' } }).decide('e', ev)).mode).toBe('on');
  });

  it('REGRESSION: absent dispatch/whatsapp default → every being still falls back to \'mention\' (today\'s ultimate fallback, unchanged)', async () => {
    expect((await mkGating({}).decide('wren', ev)).mode).toBe('mention');
    expect((await mkGating({}).decide('e', ev)).mode).toBe('mention');
  });

  it('the PER-CONVERSATION override still beats the dispatch global (precedence unchanged)', async () => {
    let state = emptyState();
    state = ensureContact(state, 'whatsapp', '!room:beeper.com', { pushedName: 'fam', slugHint: 'fam' }).state;
    state.contacts.whatsapp['!room:beeper.com'].agents = { e: { mode: 'on', send_to_egpt: 'always' } };
    const g = createGating({
      getConfig: () => ({ dispatch: { send_to_egpt: 'mode', auto_default_mode: 'on' } }),
      loadState: async () => state,
      defaultKey: 'e',
    });
    const d = await g.decide('e', { surface: 'whatsapp', chatId: '!room:beeper.com', kind: 'message' });
    expect(d.sendToEgpt).toBe('always');   // bv.send_to_egpt override, not the dispatch 'mode' global
  });
});

// surfaces() POST-brain (operator 2026-10-08, the stray "🐶 E: ..."): the model's DELIBERATE '…'
// silence SURFACES as a normal reply in mention / mention-direct / accum, and is HIDDEN only in
// 'on' and its operator twin 'auto' (where its placeholder is edited to the quiet limb mark '✓'
// downstream in the sender — never deleted). This is the ORIGINAL on/auto-only drop; the prior
// "drop in every mode" fix was ruled wrong. An EMPTY/failed turn keeps its mode-specific handling:
// surfaced in mention (visible no-reply marker), unsurfaced in on/auto (BRIDGE_SILENCE path).
describe('gating surfaces: — the model\'s "…" silence is HIDDEN only in on/auto, SURFACES elsewhere', () => {
  const g = mkGating({});
  const dec = (mode, mayReply = true) => ({ mode, mayReply });

  it("a '…' / '...' reply SURFACES in mention/mention-direct/accum (delivered as a normal reply)", () => {
    for (const mode of ['mention', 'mention-direct', 'accum']) {
      expect(g.surfaces(dec(mode), '…')).toBe(true);
      expect(g.surfaces(dec(mode), '...')).toBe(true);
    }
  });

  it("a '…' reply is HIDDEN in on/auto (recorded, not surfaced)", () => {
    expect(g.surfaces(dec('on'), '…')).toBe(false);
    expect(g.surfaces(dec('auto'), '...')).toBe(false);
  });

  it('PRESERVE: an EMPTY reply still SURFACES in mention → resolves to the visible no-reply marker', () => {
    expect(g.surfaces(dec('mention'), '')).toBe(true);
    expect(g.surfaces(dec('accum'), '   ')).toBe(true);
  });

  it('PRESERVE: an EMPTY reply in on/auto stays unsurfaced (BRIDGE_SILENCE path), and real prose always surfaces', () => {
    expect(g.surfaces(dec('on'), '')).toBe(false);
    expect(g.surfaces(dec('mention'), 'hola')).toBe(true);
    expect(g.surfaces(dec('on'), 'hola')).toBe(true);
  });

  it('PRESERVE: a non-replying decision never surfaces, silence or not', () => {
    expect(g.surfaces(dec('mention', false), 'hola')).toBe(false);
    expect(g.surfaces(dec('on', false), '…')).toBe(false);
  });
});
