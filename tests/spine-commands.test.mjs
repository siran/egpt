// Operator slash commands: recognition (Self DM / authorized), lifecycle exits,
// and the loop intercept (a command is never routed to the brain).
import { describe, it, expect } from 'vitest';
import { createCommands } from '../src/spine/commands.mjs';
import { createSpine } from '../spine.mjs';
import { emptyState, ensureContact, getBeing } from '../conversations-state.mjs';

function harness({ config = {}, state = null } = {}) {
  const sent = [], exits = [], rewinds = [];
  let st = state;
  const cmds = createCommands({
    getConfig: () => config,
    send: async (chatId, text) => sent.push({ chatId, text }),
    exit: (code) => exits.push(code),
    writeRewindTarget: (ref) => rewinds.push(ref),
    loadState: state ? async () => st : null,
    writeState: state ? async (s) => { st = s; } : null,
  });
  return { cmds, sent, exits, rewinds, getState: () => st };
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
