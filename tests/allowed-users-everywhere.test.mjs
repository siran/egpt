// "No mode is above allowed_users" (operator 2026-10-16). Live on dg: the persona Queen D (agents.egpt,
// handles [q], allowed_users [@dagiely]) woke on "q …" from a sender NOT on that list. The explicit `q`
// hit was dropped by allowed_users, and the persona fall-through then woke her anyway on the bridge's
// atE. Every wake the router hands out is now tested against the woken being's allowed_users; a denied
// line is still recorded and wakes nobody.
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const X = '@dagiely:beeper.com';
const Y = '@anrodriguez:beeper.com';
const CHAT = { surface: 'whatsapp', chatId: '!g', chatName: 'grupo', kind: 'text', raw: { chatType: 'group' } };

const queen = (mode = 'mention', extra = {}) => ({
  egpt: { configuration: 'egpt', handles: ['q'], mode, conversation_defaults: { allowed_users: [X] } },
  wren: { configuration: 'egpt', handles: ['wren'] },
  ...extra,
});
const open = (mode = 'mention') => ({
  egpt: { configuration: 'egpt', handles: ['e', 'egpt'], mode },
  wren: { configuration: 'egpt', handles: ['wren'] },
});

// The bridge's persona gate (mentionStatus over the persona's DECLARED handles), as on the live node.
const msg = (senderId, body, { wake = ['q'], replyToBeing = null } = {}) => ({
  ...CHAT, senderId, senderName: senderId, body, msgId: `m-${Math.random()}`, ts: 1,
  replyToBeing,
  mention: { ...mentionStatus(body, wake), replyToBot: replyToBeing != null },
});

function build(agents, { state = null } = {}) {
  let cb = null;
  const bridge = { onMessage(fn) { cb = fn; }, send() {}, emit(m) { return cb(m); }, stop() {} };
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, ev }); return { text: 'ok', sessionId: 's', being }; } };
  const transcript = { entries: [], async log(ev, reply) { this.entries.push({ ev, reply }); } };
  const sender = { open() { return { update() {}, fail() {}, async finish() {} }; } };
  const loadState = state ? async () => state : null;
  const config = { agents };
  const router = createRouter({ getAgents: () => agents, getConfig: () => config, loadState });
  const gating = createGating({ getConfig: () => config, loadState });
  const spine = createSpine({
    bridge, brain, router, gating, sender, transcript,
    identity: { build: (m) => ({ ...m, line: m.body }) },
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now: () => 1 },
  });
  spine.start();
  const inbound = () => transcript.entries.filter((e) => e.reply == null).map((e) => e.ev.body);
  return { bridge, brain, router, inbound };
}

describe('allowed_users holds on every wake — the persona fall-through (dg, Queen D)', () => {
  it('REPRODUCTION: Y writes "q hola" — nobody wakes, and the line is still recorded', async () => {
    const { bridge, brain, inbound } = build(queen('mention'));
    await bridge.emit(msg(Y, 'q hola'));
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual(['q hola']);
  });

  it('the router drops a denied sender\'s being, named or taken by its mode — no target at all', async () => {
    const { router } = build(queen('on'));
    expect((await router.resolve(msg(Y, 'q hola'))).targets).toEqual([]);
    expect((await router.resolve(msg(Y, 'buenas'))).targets).toEqual([]);
    expect((await router.resolve(msg(X, 'buenas'))).targets).toEqual([{ being: 'egpt', mention: {}, address: null, fallthrough: true }]);
  });

  it('X writes "q hola" — Queen D wakes', async () => {
    const { bridge, brain } = build(queen('mention'));
    await bridge.emit(msg(X, 'q hola'));
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);
  });

  it('Y quote-replies to her message — not woken; X doing the same is', async () => {
    const { bridge, brain, inbound } = build(queen('mention'));
    await bridge.emit(msg(Y, 'y esto?', { replyToBeing: 'egpt' }));
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual(['y esto?']);
    await bridge.emit(msg(X, 'y esto?', { replyToBeing: 'egpt' }));
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);
  });

  it('mode on: Y\'s unaddressed line wakes nobody (recorded); X\'s does', async () => {
    const { bridge, brain, inbound } = build(queen('on'));
    await bridge.emit(msg(Y, 'buenas'));
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual(['buenas']);
    await bridge.emit(msg(X, 'buenas'));
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);
  });

  it('mode accum: Y wakes nobody, addressed or not; X addressing her does', async () => {
    const { bridge, brain, inbound } = build(queen('accum'));
    await bridge.emit(msg(Y, 'buenas'));
    await bridge.emit(msg(Y, 'q hola'));
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual(['buenas', 'q hola']);
    await bridge.emit(msg(X, 'q hola'));
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);
  });

  it('the conversation\'s own allowed_users replaces the global list for the fall-through too', async () => {
    const state = { contacts: { whatsapp: { '!g': { slug: 'grupo', agents: { egpt: { allowed_users: [Y] } } } } } };
    const { bridge, brain } = build(queen('mention'), { state });
    await bridge.emit(msg(X, 'q hola'));
    expect(brain.calls).toEqual([]);
    await bridge.emit(msg(Y, 'q hola'));
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);
  });

  it('another being Y may reach still answers: "@wren" from Y wakes wren, not the persona', async () => {
    const { bridge, brain } = build(queen('on'));
    await bridge.emit(msg(Y, '@wren hola'));
    expect(brain.calls.map((c) => c.being)).toEqual(['wren']);
  });
});

describe('allowed_users — unchanged where nobody set a list', () => {
  it('a persona with NO allowed_users still wakes for anyone, addressed or (mode on) not', async () => {
    const { bridge, brain } = build(open('on'));
    await bridge.emit(msg(Y, 'e hola', { wake: ['e', 'egpt'] }));
    await bridge.emit(msg('+1555', 'buenas', { wake: ['e', 'egpt'] }));
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt', 'egpt']);
  });

  it('the stranger agent still answers a stranger\'s new 1:1 (ownerOnly), the persona\'s list notwithstanding', async () => {
    const agents = queen('mention', { marketer: { configuration: 'egpt', handles: ['mk'], mode: 'on' } });
    const config = { agents, dispatch: { stranger_agent: { secondary: 'marketer' } } };
    const router = createRouter({ getAgents: () => agents, getConfig: () => config, loadState: async () => ({ contacts: {} }) });
    const dm = { ...msg('+58414', 'hola'), chatId: '!dm', connection: 'secondary', raw: { chatType: 'private' } };
    expect((await router.resolve(dm)).targets).toEqual([{ being: 'marketer', mention: {}, address: null, fallthrough: true }]);
    expect((await router.resolve({ ...dm, body: 'q hola' })).targets.map((t) => [t.being, !!t.denied])).toEqual([['marketer', false]]);
  });
});
