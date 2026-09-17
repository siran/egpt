// guard-operator-meta.test.mjs — the per-chat loop guard vs THE OPERATOR and THE META ENGINEERS
// (operator 2026-09-16, two rulings):
//   1. "All chats should accept commands from the operator."
//   2. "Meta engineers must not be blocked by the bridge; meta engineers are beyond the bridge" —
//      "a meta engineer is an `access_level: all`, all-powerful agent." (GENOME I8: "E is gated;
//      meta-engineers are not.")
//
// THE LIVE FAILURE, kg 2026-09-16, the operator's own admin group:
//   19:01:41 guard: whatsapp:trYqoMoH7jETBozvcOQh auto-STOP — 6 consecutive non-human turns
//   19:05:02 guard: ... stopped — prompt suppressed        (operator: "w podemos enviar ...", to wren)
//   19:28:25 guard: ... stopped — command suppressed       (operator: "/agents wren refresh")
//   19:28:39 guard: ... stopped — prompt suppressed        (operator: "w there?")
// A heartbeat posting into the group tripped the brake — correctly. What the brake then blocked
// was the defect: the operator's own command, and every prompt to wren, the meta engineer.
//
// Only the PER-CHAT loop guard is in scope. The node-wide kill switch (STOP file / `stop` in Self)
// keeps applying to everyone — locked at the bottom.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { createCommands } from '../src/spine/commands.mjs';

const AGENTS = {
  egpt: { configuration: 'sonnet-high', handles: ['e', 'egpt'], default: true },   // the persona
  wren: { configuration: 'egpt-xhigh', handles: ['wren', 'w'] },   // the meta engineer on kg
  codex: { configuration: 'codex' },
  dren: { configuration: 'relay', relay_channel: 'egpt-mesh-do-kg', to: 'dren.do' },   // do's meta engineer, reached by relay
  don: { configuration: 'relay', relay_channel: 'egpt-mesh-do-kg', to: 'don.do' },     // do's persona, reached by relay
};

const ADMIN = 'trYqoMoH7jETBozvcOQh';
const CH = `whatsapp:${ADMIN}`;
let seq = 0;
const base = (chatId) => ({
  surface: 'whatsapp', node: 'wa', chatId, chatName: 'eGPT Admin', ts: 1, kind: 'text', raw: {},
  mention: { atEStart: false, atEAnywhere: false, replyToBot: false },
});
// The operator, typing on his own account: authorized, a genuine human turn.
const op = (body, over = {}) => ({ ...base(ADMIN), senderId: 'u-an', senderName: 'An', msgId: `op-${++seq}`, isSender: true, authorized: true, body, ...over });
// A group member who is NOT an allowed user: no command authority.
const member = (body, over = {}) => ({ ...base(ADMIN), senderId: 'u-bob', senderName: 'Bob', msgId: `mb-${++seq}`, isSender: false, authorized: false, body, ...over });
// A PEER NODE's post (do's spine committed it — the structural signature, already decoded by identity).
const peer = (body, over = {}) => ({ ...base(ADMIN), senderId: 'u-rodz', senderName: 'Rodz', msgId: `peer-${++seq}`, isSender: false, authorized: false, fromNode: 'do', body, ...over });

function build({ levels = {}, turns = 3, stopSwitch = null, isSelfChat = () => false } = {}) {
  const guard = createStopGuard({ turns });
  const bridge = { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false };
  const asked = [];
  const brain = {
    calls: [],
    async turn(being, e) { this.calls.push(being); return { text: `↩ ${being}`, sessionId: 's', being }; },
    // THE SEAM the spine asks: this conversation's RESOLVED access_level for an agent. Modelled on
    // the precedence brainpool.resolveConv walks — a per-conversation value (`<chatId>/<agent>`)
    // beats the agent's conversation_defaults (`<agent>`), else 'regular'.
    async accessLevel(being, e) {
      asked.push({ being, chatId: e.chatId });
      return levels[`${e.chatId}/${being}`] ?? levels[being] ?? 'regular';
    },
  };
  // THE COMMAND PATH'S OWN AUTHORITY — the real isCommand, not a model of it.
  const real = createCommands({ getConfig: () => ({ whatsapp: { chat_id: '!self' } }), send: async () => {}, exit: () => {}, brains: { resolve: (name) => ({ name, type: 'ccode' }) } });
  const ran = [];
  const commands = { isCommand: real.isCommand, run: async (e) => { ran.push(e.body); } };
  const mesh = {
    handled: [], forwarded: [],
    isEnvelope: (e) => String(e.body).startsWith('ENV:'),
    async handle(e) { this.handled.push(e.body); },
    async forward(e, t) { this.forwarded.push(t.being); return true; },
    async onEdit() { return false; },
  };
  const heartbeats = { beats: 0, runDue() { this.beats += 1; } };
  const spine = createSpine({
    bridge, brain, commands, mesh, guard, stopSwitch, isSelfChat, heartbeats,
    identity: { build: (m) => ({ ...m }) },
    router: createRouter({ getAgents: () => AGENTS, defaultBeing: 'egpt' }),
    gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: (d) => d.mayReply },
    sender: { open() { return { update() {}, activate() {}, fail() {}, async finish() {} }; } },
    transcript: { async log() {} },
    defaultBeing: 'egpt',
    clock: { now: () => 1 },
  });
  return { spine, guard, brain, ran, mesh, heartbeats, asked };
}

// Trip the brake the way kg's was tripped: non-human posts, no human turn between them.
async function tripWithPeerPosts(spine, guard, n = 3) {
  for (let i = 0; i < n; i++) await spine.handleInbound(peer(`beat ${i}`));
  expect(guard.blocked(CH)).toBe(true);
}

describe('ruling 1 — the operator\'s commands run in every chat, stopped or not', () => {
  it('REPRODUCE (19:28:25): "/agents wren refresh" runs in a stopped channel — and the channel STAYS stopped for a non-meta being', async () => {
    const { spine, guard, brain, ran } = build({ levels: { wren: 'all' } });
    await tripWithPeerPosts(spine, guard);
    const before = brain.calls.length;

    await spine.handleInbound(op('/agents wren refresh'));
    expect(ran).toEqual(['/agents wren refresh']);

    // a command is not "the loop is over" — only RESUME is
    expect(guard.blocked(CH)).toBe(true);
    await spine.handleInbound(op('@e are you there?'));
    expect(brain.calls.length).toBe(before);
  });

  it("a group member's command in a stopped channel is still suppressed — the command path's own authority decides", async () => {
    const { spine, guard, brain, ran } = build();
    guard.stopChannel(CH);
    await spine.handleInbound(member('/status'));
    expect(ran).toEqual([]);
    expect(brain.calls).toEqual([]);
    // …and the same line from the operator runs
    await spine.handleInbound(op('/status'));
    expect(ran).toEqual(['/status']);
  });

  it('a command that is NOT a human turn stays suppressed (the 2026-07-25 command flood) — authority alone is not enough', async () => {
    // On a shared account a peer node's post reads authorized/isSender, so isCommand admits it.
    // Provenance is what keeps a stopped channel from answering machine-made commands again.
    const { spine, guard, ran } = build();
    guard.stopChannel(CH);
    await spine.handleInbound(peer('/status', { isSender: true, authorized: true }));
    expect(ran).toEqual([]);
  });
});

describe('ruling 2 — meta engineers (resolved access_level: all) are beyond the per-chat guard', () => {
  it('REPRODUCE (19:28:39): "w there?" reaches wren in a stopped channel; the same prompt to a non-meta being is still suppressed', async () => {
    const { spine, guard, brain } = build({ levels: { wren: 'all', egpt: 'sandbox' } });
    guard.stopChannel(CH);

    await spine.handleInbound(op('w there?'));
    expect(brain.calls).toEqual(['wren']);

    // egpt is 'sandbox' on kg — all's capability inside the OS box, NOT 'all': not a meta engineer
    await spine.handleInbound(op('e there?'));
    await spine.handleInbound(op('@codex there?'));
    expect(brain.calls).toEqual(['wren']);
    expect(guard.blocked(CH)).toBe(true);        // nothing addressed to wren lifted the stop
  });

  it('one message addressing a meta AND a non-meta being runs ONLY the meta engineer in a stopped channel', async () => {
    const { spine, guard, brain } = build({ levels: { wren: 'all' } });
    guard.stopChannel(CH);
    await spine.handleInbound(op('@e and @wren, status?'));
    expect(brain.calls).toEqual(['wren']);
    await spine.handleInbound(op('@wren and @e, status?'));
    expect(brain.calls).toEqual(['wren', 'wren']);
  });

  it("a meta engineer's turns do not count toward the cap; a non-meta being's still do", async () => {
    const { spine, guard, brain } = build({ levels: { wren: 'all' } });
    for (let i = 0; i < 10; i++) await spine.handleInbound(peer(`@wren step ${i}`));
    expect(guard.countOf(CH)).toBe(0);
    expect(guard.blocked(CH)).toBe(false);
    expect(brain.calls.filter((b) => b === 'wren')).toHaveLength(10);

    // the same burst at the persona counts, and trips at the cap
    for (let i = 0; i < 3; i++) await spine.handleInbound(peer(`@e step ${i}`));
    expect(guard.blocked(CH)).toBe(true);
    // …and a message that also addresses a non-meta being is that being's turn too: it counts
    const g2 = build({ levels: { wren: 'all' } });
    for (let i = 0; i < 3; i++) await g2.spine.handleInbound(peer(`@wren and @e ${i}`));
    expect(g2.guard.blocked(CH)).toBe(true);
  });

  it('a relay turn addressed to a meta engineer is not suppressed: @dren (all) is forwarded from a stopped channel, @don (regular) is not', async () => {
    const { spine, guard, mesh } = build({ levels: { dren: 'all' } });
    guard.stopChannel(CH);
    await spine.handleInbound(op('@dren are you there?'));
    await spine.handleInbound(op('@don are you there?'));
    expect(mesh.forwarded).toEqual(['dren']);
  });

  it('LOCK — an inbound mesh ENVELOPE is never suppressed, whoever it addresses (an envelope carries no guard channel)', async () => {
    const { spine, guard, mesh } = build({ levels: { wren: 'all' } });
    guard.stopChannel(CH);
    await spine.handleInbound(peer('ENV: to wren.kg'));
    await spine.handleInbound(peer('ENV: to egpt.kg'));
    expect(mesh.handled).toEqual(['ENV: to wren.kg', 'ENV: to egpt.kg']);
  });

  it('access_level: all from a PER-CONVERSATION override makes a meta engineer THERE — not elsewhere, and not the other beings in that conversation', async () => {
    const SELF = 'yz3kJjWXsQJofK9naaVb';
    const selfCh = `whatsapp:${SELF}`;
    const { spine, guard, brain, asked } = build({ levels: { [`${SELF}/codex`]: 'all' } });
    guard.stopChannel(selfCh);
    guard.stopChannel(CH);

    await spine.handleInbound(op('@codex hi', { chatId: SELF }));
    expect(brain.calls).toEqual(['codex']);
    expect(asked).toContainEqual({ being: 'codex', chatId: SELF });   // asked per conversation, not per name

    await spine.handleInbound(op('@e hi', { chatId: SELF }));        // regular in that same conversation
    await spine.handleInbound(op('@codex hi'));                      // regular in the admin group
    expect(brain.calls).toEqual(['codex']);
  });
});

describe('ACCEPTED (operator\'s decision) — two meta engineers exchanging turns have NO automatic brake; the operator is the brake', () => {
  it('dren (do) and wren (kg) trade 20 turns in a chat: every one runs, nothing is counted, nothing stops', async () => {
    const pulls = [];
    const { spine, guard, brain } = build({
      levels: { wren: 'all' },
      stopSwitch: { present: () => false, pull: (why) => pulls.push(why) },
      isSelfChat: (e) => e.chatId === 'SELF',
    });
    for (let i = 0; i < 20; i++) await spine.handleInbound(peer(`@wren ${i}`));
    expect(brain.calls).toHaveLength(20);
    expect(guard.countOf(CH)).toBe(0);
    expect(guard.blocked(CH)).toBe(false);
    // the brake that remains is the operator's
    await spine.handleInbound(op('stop', { chatId: 'SELF' }));
    expect(pulls).toHaveLength(1);
  });
});

describe('regression locks — what does not change', () => {
  it('RESUME clears one channel, RESUME ALL clears every channel — unchanged', async () => {
    const { spine, guard } = build({ levels: { wren: 'all' } });
    guard.stopChannel(CH);
    guard.stopChannel('whatsapp:other');
    await spine.handleInbound(op('resume'));
    expect(guard.blocked(CH)).toBe(false);
    expect(guard.blocked('whatsapp:other')).toBe(true);
    guard.stopChannel(CH);
    await spine.handleInbound(op('RESUME ALL'));
    expect(guard.status().stoppedChannels).toEqual([]);
  });

  it('the lifecycle commands are still exempt — from the operator, and from a non-human source', async () => {
    const { spine, guard, ran } = build();
    guard.stopChannel(CH);
    await spine.handleInbound(op('/restart'));
    await spine.handleInbound(peer('/upgrade', { isSender: true, authorized: true }));
    expect(ran).toEqual(['/restart', '/upgrade']);
  });

  it('the NODE-WIDE STOP still stops a meta engineer: `stop` in Self pulls the kill switch and reaches no brain, and the STOP file halts the tick', async () => {
    let present = false;
    const pulls = [];
    const { spine, brain, heartbeats } = build({
      levels: { wren: 'all', egpt: 'all' },           // even with every being a meta engineer
      stopSwitch: { present: () => present, pull: (why) => pulls.push(why) },
      isSelfChat: (e) => e.chatId === 'SELF',
    });
    await spine.handleInbound(op('stop', { chatId: 'SELF' }));
    expect(pulls).toHaveLength(1);
    expect(brain.calls).toEqual([]);

    present = true;
    spine.tick();
    expect(pulls).toHaveLength(2);
    expect(heartbeats.beats).toBe(0);
  });
});
