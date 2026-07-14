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

  it('the PER-CONVERSATION override still beats the dispatch global (precedence unchanged)', async () => {
    let state = emptyState();
    state = ensureContact(state, 'whatsapp', '!room:beeper.com', { pushedName: 'fam', slugHint: 'fam' }).state;
    state.contacts.whatsapp['!room:beeper.com'].e = { mode: 'on', send_to_egpt: 'always' };
    const g = createGating({
      getConfig: () => ({ dispatch: { send_to_egpt: 'mode', auto_default_mode: 'on' } }),
      loadState: async () => state,
      defaultKey: 'e',
    });
    const d = await g.decide('e', { surface: 'whatsapp', chatId: '!room:beeper.com', kind: 'message' });
    expect(d.sendToEgpt).toBe('always');   // bv.send_to_egpt override, not the dispatch 'mode' global
  });
});
