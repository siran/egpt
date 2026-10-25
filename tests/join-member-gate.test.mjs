// join-member-gate.test.mjs — opening the side-group commands to C's members must NOT widen /agents
// (operator 2026-10-16). /join is retired (2026-10-25); /split carries the member gate now.
//
// /split is admitted for any sender at the command gate (isCommand) and splitGroup decides; every
// other '/'-verb keeps the operator gate (isOperator: Self DM, ev.authorized from
// networks.<surface>.allowed_users or isSender, or isSender). A per-agent allowed_users (either tier)
// decides who may WAKE a being, never who may run /agents. Real isCommand + real run over in-memory
// state, through the real spine: a member's /agents line must change nothing.
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  process.env.EGPT_HOME = `${tmp}/egpt-join-member-gate-home`;
});

import { createSpine } from '../src/spine/spine.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import { ensureContact, recordThread, patchBeing, getBeing } from '../src/conversations-state.mjs';

const GROUP = '!grpC';
const MEMBER = '@whatsapp_lid-777000:beeper.local';
const AGENTS = { e: { handles: ['e'], default: true, conversation_defaults: { allowed_users: [MEMBER] } } };
const CONFIG = { networks: { whatsapp: { chat_ids: ['!self'], allowed_users: ['@an:beeper.com'] } }, agents: AGENTS };

let seq = 0;
const member = (body) => ({
  surface: 'whatsapp', node: 'wa', chatId: GROUP, chatName: 'C', ts: 1, kind: 'text', raw: { chatType: 'group' },
  mention: { atEStart: false, atEAnywhere: false, replyToBot: false },
  senderId: MEMBER, senderName: 'Emely', msgId: `m-${++seq}`, isSender: false, authorized: false, body,
});

function build() {
  // C with a live E thread, a mode, and the member named on BOTH allowed_users tiers.
  let st = ensureContact({ contacts: {} }, 'whatsapp', GROUP, { pushedName: 'C' }).state;
  st = recordThread(st, 'whatsapp', GROUP, 'thread-1', '2026-10-16T00:00:00Z', 'e');
  st = patchBeing(st, 'whatsapp', GROUP, 'e', { mode: 'mention', allowed_users: [MEMBER] });
  const state = { st };
  const replies = [];
  const real = createCommands({
    getConfig: () => CONFIG, send: async (c, t) => replies.push({ c, t }), exit: () => {},
    loadState: async () => state.st, writeState: async (s) => { state.st = s; },
    logTranscript: async () => true, defaultKey: 'e',
  });
  const ran = [];
  const commands = { commandOf: real.commandOf, isCommand: real.isCommand, run: async (e) => { ran.push(e.body); return real.run(e); } };
  const brain = { calls: [], async turn(being) { this.calls.push(being); return { text: 'ok', sessionId: 'thread-1', being }; }, async accessLevel() { return 'regular'; } };
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
    brain, commands,
    heartbeats: { runDue() {} },
    identity: { build: (m) => ({ ...m }) },
    router: createRouter({ getAgents: () => AGENTS, defaultBeing: 'e' }),
    gating: { async decide() { return { mode: 'mention', receives: true, mayReply: false, sendToEgpt: 'mode' }; }, surfaces: (d) => d.mayReply },
    sender: { open() { return { update() {}, activate() {}, fail() {}, async finish() {} }; } },
    transcript: { async log() {} },
    defaultBeing: 'e',
    clock: { now: () => 1 },
  });
  return { spine, ran, replies, real, state };
}

describe('/agents stays operator-only while /split is open to members', () => {
  for (const body of ['/e agents rethread e', '/e agents reset e', '/e agents mode on e', '/e agents compact e', '/e agents stop e', '/e agents refresh e', '/e agents access_level all e', '/e agents e', '/e agents compact']) {
    it(`a member (not on networks allowed_users, not isSender) sending "${body}" runs nothing and changes nothing`, async () => {
      const { spine, ran, replies, state } = build();
      const before = state.st;
      await spine.handleInbound(member(body));
      expect(ran).toEqual([]);
      expect(replies).toEqual([]);
      expect(state.st).toBe(before);
      expect(getBeing(state.st, 'whatsapp', GROUP, 'e')).toMatchObject({ threadId: 'thread-1', mode: 'mention' });
    });
  }

  it('per-agent allowed_users (conversation_defaults AND the conversation block) do NOT grant /agents', async () => {
    const { real } = build();
    expect(await real.isCommand(real.commandOf(member('/e agents rethread e')))).toBe(false);
  });

  it('the same member IS admitted for /split (the widening is the side-group commands alone); the retired /join is not public', async () => {
    const { real } = build();
    expect(await real.isCommand(real.commandOf(member('/e split emely')))).toBe(true);
    expect(await real.isCommand(real.commandOf(member('/e join emely')))).toBe(false);
  });
});
