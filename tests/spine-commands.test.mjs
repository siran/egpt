// Operator slash commands: recognition (Self DM / authorized), lifecycle exits,
// and the loop intercept (a command is never routed to the brain).
import { describe, it, expect } from 'vitest';
import { createCommands } from '../src/spine/commands.mjs';
import { createSpine } from '../spine.mjs';
import { emptyState, ensureContact, getBeing } from '../conversations-state.mjs';

function harness({ config = {}, state = null } = {}) {
  const sent = [], exits = [], rewinds = [], writes = [];
  let st = state;
  const cmds = createCommands({
    getConfig: () => config,
    send: async (chatId, text) => sent.push({ chatId, text }),
    exit: (code) => exits.push(code),
    writeRewindTarget: (ref) => rewinds.push(ref),
    loadState: state ? async () => st : null,
    writeState: state ? async (s) => { writes.push(s); st = s; } : null,
  });
  return { cmds, sent, exits, rewinds, writes, getState: () => st };
}

describe('commands.isCommand', () => {
  it('recognizes a slash command in the Self DM', () => {
    const { cmds } = harness({ config: { whatsapp: { chat_id: '!self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!self' })).toBe(true);
  });
  it('recognizes a slash command from an authorized sender / own send anywhere', () => {
    const { cmds } = harness();
    expect(cmds.isCommand({ body: '/restart', chatId: '!group', authorized: true })).toBe(true);
    expect(cmds.isCommand({ body: '/restart', chatId: '!group', isSender: true })).toBe(true);
  });
  it('does NOT recognize a slash command from a random chat/sender', () => {
    const { cmds } = harness({ config: { whatsapp: { chat_id: '!self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!group' })).toBe(false);
  });
  it('recognizes a slash command in the TELEGRAM surface Self DM (per-surface chat_id)', () => {
    const { cmds } = harness({ config: { whatsapp: { chat_id: '!self' }, telegram: { chat_id: '!tg-self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!tg-self', surface: 'telegram' })).toBe(true);
  });
  it('does NOT recognize a slash command from a random telegram chat', () => {
    const { cmds } = harness({ config: { telegram: { chat_id: '!tg-self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!tg-group', surface: 'telegram' })).toBe(false);
  });
  it('the whatsapp Self chat_id does NOT authorize the same id on the telegram surface (namespace)', () => {
    const { cmds } = harness({ config: { whatsapp: { chat_id: '!self' } } });
    expect(cmds.isCommand({ body: '/restart', chatId: '!self', surface: 'telegram' })).toBe(false);
  });
  it('does NOT treat plain text (or @e) as a command', () => {
    const { cmds } = harness();
    expect(cmds.isCommand({ body: 'hola', chatId: '!self', authorized: true })).toBe(false);
    expect(cmds.isCommand({ body: '@e estas?', chatId: '!self', authorized: true })).toBe(false);
  });
});

describe('commands.run', () => {
  it('lifecycle commands exit with the daemon codes', async () => {
    const { cmds, exits } = harness();
    await cmds.run({ body: '/restart', chatId: '!self' });
    await cmds.run({ body: '/upgrade', chatId: '!self' });
    expect(exits).toEqual([43, 42]);
  });
  it('/rewind <ref> writes the target then exits 44', async () => {
    const { cmds, exits, rewinds } = harness();
    await cmds.run({ body: '/rewind deadbeef', chatId: '!self' });
    expect(rewinds).toEqual(['deadbeef']);
    expect(exits).toEqual([44]);
  });
  it('an unwired command is acknowledged (no exit, not leaked to E)', async () => {
    const { cmds, sent, exits } = harness();
    await cmds.run({ body: '/channels', chatId: '!self' });
    expect(exits).toEqual([]);
    expect(sent[0].text).toMatch(/channels: recognized/);
  });

  it('/e auto <mode> persists the conversation mode into conversations.yaml', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/e auto on', chatId: '!room', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').mode).toBe('on');
    expect(sent[0].text).toMatch(/E mode here → on/);
  });

  it('/e auto <bad> is rejected and leaves the mode unchanged', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/e auto loud', chatId: '!room', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').mode).toBe(null);
    expect(sent[0].text).toMatch(/unknown mode/);
  });

  it('/e auto accum is now the unknown-mode error (accum retired 2026-07-01)', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!room', { pushedName: 'fam', slugHint: 'fam' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/e auto accum', chatId: '!room', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!room', 'e').mode).toBe(null);   // not persisted
    expect(sent[0].text).toMatch(/unknown mode "accum"/);
    expect(sent[0].text).toMatch(/on, mute, mention-direct, mention, off/);   // the surviving enum, accum gone from the list
  });

  it('/e auto <mode> <target> from Self sets the NAMED chat (not the Self DM)', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent, getState } = harness({ state });
    await cmds.run({ body: '/e auto on hfm', chatId: '!self', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!hfm:beeper.local', 'e').mode).toBe('on');   // the NAMED chat
    expect(getBeing(getState(), 'whatsapp', '!self', 'e')).toBe(null);                     // Self DM untouched (not even a contact)
    expect(sent[0].text).toMatch(/HFM.*→ on/);
  });

  it('/e auto <mode> <unknown> reports no match', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent } = harness({ state });
    await cmds.run({ body: '/e auto on zzz', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/no chat matches/);
  });

  it('/e auto <mode> <unknown-jid> errors and does NOT write state (no false ✅)', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent, writes } = harness({ state });
    // A verbatim jid E has never seen: patchContact would silently no-op, so the
    // old code replied "✅" for a chat it never touched. Now it must fail loudly.
    await cmds.run({ body: '/e auto mute !nope:beeper.local', chatId: '!self', surface: 'whatsapp' });
    expect(sent[0].text).toMatch(/no chat matches/);
    expect(writes).toHaveLength(0);
  });

  it('/e auto <mode> <known-jid> succeeds and writes state', async () => {
    const state = ensureContact(emptyState(), 'whatsapp', '!hfm:beeper.local', { pushedName: 'HFM', slugHint: 'HFM' }).state;
    const { cmds, sent, writes, getState } = harness({ state });
    await cmds.run({ body: '/e auto mute !hfm:beeper.local', chatId: '!self', surface: 'whatsapp' });
    expect(getBeing(getState(), 'whatsapp', '!hfm:beeper.local', 'e').mode).toBe('mute');
    expect(writes).toHaveLength(1);
    expect(sent[0].text).toMatch(/→ mute/);
  });
});

describe('loop intercept', () => {
  it('a command is handled, NOT routed to the brain (and is logged)', async () => {
    let cb = null;
    const brain = { calls: [], async turn(b, e) { this.calls.push(e); return { text: 'x' }; } };
    const exits = [];
    const cmds = createCommands({ getConfig: () => ({ whatsapp: { chat_id: '!self' } }), send: async () => {}, exit: (c) => exits.push(c) });
    const transcript = { entries: [], log(ev) { this.entries.push(ev); } };
    const spine = createSpine({
      bridge: { onMessage(fn) { cb = fn; }, send() {}, stop() {} },
      brain, commands: cmds,
      identity: { build: (m) => ({ ...m }) },
      router: { resolve: () => 'e' },
      gating: { decide: async () => ({ mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }), surfaces: () => true },
      sender: { open: () => ({ update() {}, async finish() {} }) },
      transcript, heartbeats: { runDue() {} },
    });
    spine.start();
    await cb({ body: '/restart', chatId: '!self' });
    expect(brain.calls).toHaveLength(0);   // intercepted — not the persona
    expect(exits).toEqual([43]);
    expect(transcript.entries).toHaveLength(1);
  });
});
