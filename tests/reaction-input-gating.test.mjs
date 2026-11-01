// A PERSON'S REACTION IS INPUT (operator 2026-10-18): it "obeys the same rules as all messages,
// meaning mention|accum|mute|on|off". A reaction gates exactly as a text reply to the same message,
// never by words in the quoted snippet. A being's own reaction never gets here (dropped at the bridge).
// …EXCEPT ON A BOT'S POST (operator 2026-11-01): a reaction to one of ours (sent by this account, or
// node-signed by any node) is recorded and invokes no being, in any mode.
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { encodeNodeSignature } from '../src/node-signature.mjs';

const OP = '+16468217865';
const base = { chatId: '!g', chatName: 'grupo', chatType: 'group', network: 'whatsapp', userId: OP, senderName: 'An', authorized: true, atEStart: false, atEAnywhere: false };
// The two shapes the bridge hands the spine for one target message #m1.
const reactionTo = (snippet, extra = {}) => ({ body: `reacted 👍 to #m1 "${snippet}"`, from: { ...base, isReaction: true, msgKey: 'm1', replyToBot: false, ...extra } });
const textReply = (body, extra = {}) => ({ body, from: { ...base, msgKey: `t-${Math.random()}`, replyToId: 'm1', replyToBot: false, ...extra } });
const toBeing = { replyToBeing: 'egpt', replyToBot: true };

// `sent`: ids this account sent (bridge wasSentByUs) — the one-account node sends the beings' posts.
function build(mode, { sent = [] } = {}) {
  const agents = {
    egpt: { configuration: 'egpt', handles: ['e', 'egpt'], mode },
    wren: { configuration: 'egpt', handles: ['wren'], mode },
  };
  let cb = null;
  const bridge = { onMessage(fn) { cb = fn; }, send() {}, emit(m) { return cb(m); }, stop() {}, wasSentByUs: (_c, id) => sent.includes(id) };
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, kind: ev.kind }); return { text: 'ok', sessionId: 's', being }; } };
  const transcript = { entries: [], async log(ev, reply) { if (reply == null) this.entries.push(ev.kind); } };
  const opens = [];
  const sender = { open(chatId, o) { opens.push(o); return { update() {}, fail() {}, async finish() {} }; } };
  const config = { agents };
  const spine = createSpine({
    bridge, brain, sender, transcript,
    router: createRouter({ getAgents: () => agents, getConfig: () => config }),
    gating: createGating({ getConfig: () => config }),
    identity: createIdentity({ now: () => 1 }), fromThisNode: (ev) => ev.fromNode === 'kg',
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now: () => 1 },
  });
  spine.start();
  return { bridge, brain, opens, recorded: transcript.entries };
}

// Same message, same attributes: the reaction and the text reply must take the same decision.
async function both(mode, r, t, opts) {
  const a = build(mode, opts); await a.bridge.emit(r);
  const b = build(mode, opts); await b.bridge.emit(t);
  return { reaction: a, text: b };
}

describe('a person\'s reaction gates like a text reply to the same message', () => {
  // contract 6.4
  it('on: wakes every being on there, as a text would', async () => {
    const { reaction, text } = await both('on', reactionTo('hola'), textReply('👍'));
    expect(text.brain.calls.map((c) => c.being).sort()).toEqual(['egpt', 'wren']);
    expect(reaction.brain.calls.map((c) => `${c.being}/${c.kind}`).sort()).toEqual(['egpt/reaction', 'wren/reaction']);
    expect(reaction.opens).toHaveLength(2);
  });

  // contract 6.4
  it('mention: a reply to the BEING\'s post wakes it; a reaction to that post is recorded only', async () => {
    const { reaction, text } = await both('mention', reactionTo('🐶 e: listo', toBeing), textReply('👍', toBeing));
    expect(text.brain.calls.map((c) => c.being)).toEqual(['egpt']);
    expect(reaction.brain.calls).toEqual([]);
    expect(reaction.recorded).toEqual(['reaction']);
  });

  it('REPRODUCE mention: a handle inside the QUOTED snippet addresses nobody — a reply "👍" to it wakes nobody either', async () => {
    const { reaction, text } = await both('mention', reactionTo('hola @wren mirá'), textReply('👍'));
    expect(text.brain.calls).toEqual([]);
    expect(reaction.brain.calls).toEqual([]);
    expect(reaction.opens).toEqual([]);
    expect(reaction.recorded).toEqual(['reaction']);
  });

  it('accum: same gate as mention — a reaction wakes no one, on the being\'s post or anyone else\'s', async () => {
    expect((await both('accum', reactionTo('🐶 e: listo', toBeing), textReply('👍', toBeing))).reaction.brain.calls).toEqual([]);
    const { reaction, text } = await both('accum', reactionTo('hola'), textReply('👍'));
    expect(text.brain.calls).toEqual([]);
    expect(reaction.brain.calls).toEqual([]);
    expect(reaction.recorded).toEqual(['reaction']);
  });

  // The being's post was sent by THIS account (a one-account node, or the ear's own fallback). A
  // reaction's msgId is its TARGET, so "did we send it" said echo and swallowed the person's ❤️.
  it("REPRODUCE: a reaction to a post THIS account sent is still a person's — recorded, not echo; a reply to it wakes", async () => {
    const sent = ['m1'];
    const m = await both('mention', reactionTo('🐶 e: listo', toBeing), textReply('👍', toBeing), { sent });
    expect(m.text.brain.calls.map((c) => c.being)).toEqual(['egpt']);
    expect(m.reaction.recorded).toEqual(['reaction']);
  });

  // contract 6.4
  it('mute: recorded, no turn — off: not even recorded', async () => {
    const mute = build('mute'); await mute.bridge.emit(reactionTo('🐶 e: listo', toBeing));
    expect(mute.brain.calls).toEqual([]);
    expect(mute.recorded).toEqual(['reaction']);
    const off = build('off'); await off.bridge.emit(reactionTo('🐶 e: listo', toBeing));
    expect(off.brain.calls).toEqual([]);
    expect(off.recorded).toEqual([]);
  });
});

describe('a person\'s reaction to a BOT\'s post invokes nobody (operator 2026-11-01)', () => {
  it("REPRODUCE on: a human 👍 on E's post runs no turn, and is recorded", async () => {
    const s = build('on');
    await s.bridge.emit(reactionTo('🐶 E: listo', toBeing));
    expect(s.brain.calls).toEqual([]);
    expect(s.opens).toEqual([]);
    expect(s.recorded).toEqual(['reaction']);
  });

  it('REPRODUCE on: one on a post this account sent (no frame read) likewise; one on another node\'s signed post stays as it was', async () => {
    const mine = build('on');
    await mine.bridge.emit(reactionTo('listo', { replyToBot: true }));
    expect(mine.brain.calls).toEqual([]);
    expect(mine.recorded).toEqual(['reaction']);
    const peer = build('on');
    await peer.bridge.emit(reactionTo('🐶 don: listo', { replyToNode: 'do' }));
    expect(peer.brain.calls).toEqual([]);
    expect(peer.recorded).toEqual(['reaction']);
  });

  it("regression lock on: a human 👍 on a human's message wakes every being on there, as today", async () => {
    const s = build('on');
    await s.bridge.emit(reactionTo('hola'));
    expect(s.brain.calls.map((c) => `${c.being}/${c.kind}`).sort()).toEqual(['egpt/reaction', 'wren/reaction']);
  });
});

describe('a person\'s edit gates like a message', () => {
  const editOf = () => ({ body: 'edited #m1\n    - hola\n    + chau', from: { ...base, msgKey: 'm1', isStageDirection: true } });

  // contract 6.4
  it('on wakes every being; mention/accum without a handle and mute record only; off drops', async () => {
    const on = build('on'); await on.bridge.emit(editOf());
    expect(on.brain.calls.map((c) => `${c.being}/${c.kind}`).sort()).toEqual(['egpt/edit', 'wren/edit']);
    expect(on.recorded).toEqual(['edit']);
    for (const mode of ['mention', 'accum', 'mute']) {
      const s = build(mode); await s.bridge.emit(editOf());
      expect(s.brain.calls).toEqual([]);
      expect(s.recorded).toEqual(['edit']);
    }
    const off = build('off'); await off.bridge.emit(editOf());
    expect(off.brain.calls).toEqual([]);
    expect(off.recorded).toEqual([]);
  });
});

// A one-account node says a being's /react as "👌 (E)", quoting the target, under a NODE-only frame.
// Its echo is own output (the bridge stamps fromNode) and names no author, so it wakes nobody — not
// even the being whose post it quotes.
describe('the one-account "👌 (E)" line comes back as own output and wakes nobody', () => {
  it("quoting wren's post, in mention: no turn for wren or anyone", async () => {
    const s = build('mention', { sent: ['m1', 'r1'] });
    await s.bridge.emit({
      body: `👌 (E)${encodeNodeSignature('kg')}`,
      from: { ...base, isSender: true, fromNode: 'kg', msgKey: 'r1', replyToId: 'm1', replyToBeing: 'wren', replyToBot: true },
    });
    expect(s.brain.calls).toEqual([]);
    expect(s.opens).toEqual([]);
    expect(s.recorded).toEqual(['text']);
  });
});
