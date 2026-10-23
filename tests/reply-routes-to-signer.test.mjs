// A reply is addressed to the being that SIGNED the quoted post (operator 2026-10-18: "a reply to
// Rodz means a reply to the being that spoke"). Signature only — no peer-being list:
//   (a) quoted post signed by a LOCAL being → that being wakes (like a mention);
//   (b) signed by ANOTHER node → addressed there: recorded, no local wake in any mode — unless the
//       reply also mentions a local being (a mention wins);
//   (c) unsigned → today's behaviour.
// Reactions take the same decision. Real spine + identity + router + gating; this node is `kg`.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';

const AGENTS = {
  egpt: { handles: ['e', 'egpt'] },
  wren: { handles: ['wren'] },
};

// `mode` is E's in this chat; wren keeps the default ('mention') unless given.
function buildSpine(mode, { wren = null } = {}) {
  const config = { node_name: 'kg' };
  const state = { contacts: { whatsapp: { c: { slug: 'fam', agents: { egpt: { mode }, ...(wren ? { wren: { mode: wren } } : {}) } } } } };
  const loadState = async () => state;
  const logs = [];
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, kind: ev.kind }); return { text: 'x' }; } };
  const transcript = { logged: [], async log(ev, reply) { if (reply == null) this.logged.push(ev.body); } };
  const sender = { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
    brain, sender, transcript,
    identity: createIdentity({ now: () => 1000 }),
    router: createRouter({ getAgents: () => AGENTS, getConfig: () => config, loadState, onLog: (l) => logs.push(l) }),
    gating: createGating({ getConfig: () => config, loadState }),
    heartbeats: { runDue() {} }, mesh: { isEnvelope: () => false, async handle() {} },
    fromThisNode: (ev) => ev?.fromNode != null && String(ev.fromNode).toLowerCase() === 'kg',
    isSelfChat: () => false, clock: { now: () => 1000 },
  });
  return { spine, brain, transcript, logs };
}

let n = 0;
const base = { chatId: 'c', chatName: 'fam', network: 'whatsapp', userId: 'op', senderName: 'An', authorized: true };
// What the bridge hands over for a human's text reply to #q, whose frame said `quoted` (node/being).
const reply = (body, { node = null, being = null, atE = false } = {}) => ({
  body,
  from: { ...base, msgKey: `t${++n}`, replyToId: 'q', replyToNode: node, replyToBeing: node === 'kg' ? being : null, replyToBot: node === 'kg' && !!being, atEStart: atE, atEAnywhere: atE },
});
const reaction = ({ node = null, being = null } = {}) => ({
  body: 'reacted 👍 to #q "…"',
  from: { ...base, msgKey: 'q', isReaction: true, replyToNode: node, replyToBeing: node === 'kg' ? being : null, replyToBot: node === 'kg' && !!being },
});
const woke = (b) => b.brain.calls.map((c) => c.being);

describe('a reply wakes the being that signed the quoted post (kg, E on)', () => {
  it("(a) a reply to E's signed post wakes E once", async () => {
    const s = buildSpine('on');
    await s.spine.handleInbound(reply('y eso?', { node: 'kg', being: 'egpt' }));
    expect(woke(s)).toEqual(['egpt']);
  });

  it("(a) a reply to wren's signed post wakes wren — and E (on) takes it too, by its mode", async () => {
    const s = buildSpine('on');
    await s.spine.handleInbound(reply('y eso?', { node: 'kg', being: 'wren' }));
    expect(woke(s).sort()).toEqual(['egpt', 'wren']);
  });

  it("(b) a reply to don's do-signed post is recorded and wakes nobody here", async () => {
    const s = buildSpine('on');
    await s.spine.handleInbound(reply('y eso?', { node: 'do', being: 'don' }));
    expect(woke(s)).toEqual([]);
    expect(s.transcript.logged).toEqual(['y eso?']);
    expect(s.logs.some((l) => /<do>/.test(l))).toBe(true);
  });

  it('(b) a node-only do frame (a system line) is addressed there too', async () => {
    const s = buildSpine('on');
    await s.spine.handleInbound(reply('ok', { node: 'do' }));
    expect(woke(s)).toEqual([]);
  });

  it('(b) the same reply that also says "@e …" wakes E (a mention wins)', async () => {
    const s = buildSpine('on');
    await s.spine.handleInbound(reply('@e mirá lo que dijo don', { node: 'do', being: 'don', atE: true }));
    expect(woke(s)).toEqual(['egpt']);
  });

  it('(b) a mention of another local being wins too', async () => {
    const s = buildSpine('on');
    await s.spine.handleInbound(reply('@wren mirá esto', { node: 'do', being: 'don' }));
    expect(woke(s)).toEqual(['wren']);
  });

  it('(c) a reply to an unsigned message: today\'s behaviour (E on wakes)', async () => {
    const s = buildSpine('on');
    await s.spine.handleInbound(reply('y eso?'));
    expect(woke(s)).toEqual(['egpt']);
  });

  it("a reaction to don's post wakes nobody here; one to E's post wakes E", async () => {
    const a = buildSpine('on');
    await a.spine.handleInbound(reaction({ node: 'do', being: 'don' }));
    expect(woke(a)).toEqual([]);
    expect(a.transcript.logged).toHaveLength(1);
    const b = buildSpine('on');
    await b.spine.handleInbound(reaction({ node: 'kg', being: 'egpt' }));
    expect(woke(b)).toEqual(['egpt']);
  });

  it("'off' still does not receive a reply to don's post", async () => {
    const s = buildSpine('off', { wren: 'off' });
    await s.spine.handleInbound(reply('y eso?', { node: 'do', being: 'don' }));
    expect(woke(s)).toEqual([]);
    expect(s.transcript.logged).toEqual([]);
  });
});

describe('LOCK: mention mode is unchanged', () => {
  const cases = [
    ['a reply to E\'s post wakes E', reply('y eso?', { node: 'kg', being: 'egpt' }), ['egpt']],
    ['a reply to don\'s post wakes nobody', reply('y eso?', { node: 'do', being: 'don' }), []],
    ['a reply to don\'s post saying @e wakes E', reply('@e y eso?', { node: 'do', being: 'don', atE: true }), ['egpt']],
    ['a reply to an unsigned message wakes nobody', reply('y eso?'), []],
    ['"hola wren" mid-sentence wakes nobody', reply('hola wren', { node: 'do', being: 'don' }), []],
    ['"wren hola" at the start wakes wren', reply('wren hola', { node: 'do', being: 'don' }), ['wren']],
  ];
  for (const [name, msg, want] of cases) {
    it(name, async () => {
      const s = buildSpine('mention');
      await s.spine.handleInbound(msg);
      expect(woke(s)).toEqual(want);
    });
  }
});
