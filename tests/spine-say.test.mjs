// spine-say.test.mjs — A BEING SAYS A LINE MID-TURN (`node "$EGPT_ASK_SPINE" say <text>`).
// The spine's sayNow posts through THE reply path (sender.post: persona stamp, the bridge's own
// sent-message registration) into the chat the live turn answers, and records it in the transcript
// as the being's line. It is no incoming line: it wakes nobody and leaves the turn running.
import { describe, it, expect } from 'vitest';
import { createSpine, MAX_SAYS_PER_TURN } from '../src/spine/spine.mjs';
import { createSender } from '../src/spine/sender.mjs';

const CHAT = 'chat-A@g.us';
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function build({ publicOf } = {}) {
  let cb = null;
  const sent = [], logged = [];
  const bridge = {
    onMessage(fn) { cb = fn; }, emit(msg) { return cb(msg); }, stop() {},
    send(chat, text, opts) { sent.push({ chat, text, opts }); return { ok: true, confirmedId: null }; },
    startStream(chat, init) { return { chat, init, update() {}, async finish() {}, confirmedId: 'x#1' }; },
  };
  const calls = [];
  const brain = { calls, turn(being, ev) { return new Promise((r) => { calls.push({ being, ev, release: (text = 'done') => r({ text, sessionId: 's1' }) }); }); } };
  const spine = createSpine({
    bridge, brain,
    identity: { build: (m) => ({ ...m, line: m.body }), spineEvent: async (surface, chatId) => ({ surface, chatId }) },
    router: { resolve: () => ({ being: 'egpt', mention: { atEStart: true, atEAnywhere: true } }) },
    gating: { async decide() { return { mode: 'mention', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: (d) => d.mayReply },
    sender: createSender({ bridge, publicOf, bodyEmojiOf: () => '🐶', labelOf: () => 'E' }),
    transcript: { async log(ev, reply) { logged.push(reply ? { ...reply } : { inbound: ev.body }); } },
    heartbeats: { runDue() {} },
    stopSwitch: { present: () => false, pull: async () => {} },
    labelOf: () => 'E', clock: { now: () => Date.now() }, turnTimeoutMs: 0, log: { line() {} },
  });
  spine.start();
  return { spine, bridge, brain, sent, logged };
}
const mention = (body = '@e publish', msgId = 'm1', chatId = CHAT) => ({ surface: 'whatsapp', node: 'wa', chatId, chatName: 'fam', senderId: 'u', senderName: 'An', msgId, ts: Date.now(), body, kind: 'text', raw: {} });
// The session a say comes from: boot's `brain.warmKey(being, ev) === who.key`, here by chat.
const WHO = { being: 'egpt', inSession: (ev) => ev.chatId === CHAT };
const FORK = 'chat-A@g.us/6078';   // a fork topic: its own chat, its parent's folder (and slug)

describe('sayNow — a line said while the turn runs', () => {
  it('posts through the reply path: stamped as the being, in the turn\'s chat, recorded as its line, turn untouched', async () => {
    const b = build();
    const done = b.bridge.emit(mention());
    await flush();
    const r = await b.spine.sayNow({ ...WHO, text: 'publishing the app now' });
    expect(r).toMatchObject({ ok: true });
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0]).toMatchObject({ chat: CHAT, text: 'publishing the app now', opts: { bodyEmoji: '🐶', label: 'E', persona: 'egpt' } });
    expect(b.logged).toContainEqual({ text: 'publishing the app now', being: 'egpt', surfaced: true });
    expect(b.brain.calls).toHaveLength(1);                          // woke nobody: no second turn
    b.brain.calls[0].release('all done');
    await done;
    expect(b.logged.filter((l) => l.inbound)).toHaveLength(1);       // and it is no incoming line
  });

  it('is refused with no live turn (none yet, and after it ended)', async () => {
    const b = build();
    expect(await b.spine.sayNow({ ...WHO, text: 'hi' })).toMatchObject({ ok: false, detail: 'no live turn' });
    const done = b.bridge.emit(mention());
    await flush();
    b.brain.calls[0].release();
    await done;
    expect(await b.spine.sayNow({ ...WHO, text: 'hi' })).toMatchObject({ ok: false, detail: 'no live turn' });
    expect(b.sent.map((s) => s.text)).not.toContain('hi');
  });

  it('is refused for another being or another session', async () => {
    const b = build();
    b.bridge.emit(mention());
    await flush();
    expect(await b.spine.sayNow({ ...WHO, being: 'leo', text: 'hi' })).toMatchObject({ ok: false });
    expect(await b.spine.sayNow({ ...WHO, inSession: (ev) => ev.chatId === 'other@g.us', text: 'hi' })).toMatchObject({ ok: false });
    expect(b.sent).toHaveLength(0);
  });

  it('a fork and its parent, the being live in BOTH: each session says into its own chat only', async () => {
    const b = build();
    b.bridge.emit(mention('@e a', 'p1', CHAT));
    await flush();
    b.bridge.emit(mention('@e b', 'f1', FORK));
    await flush();
    expect(b.brain.calls).toHaveLength(2);
    const parent = { being: 'egpt', inSession: (ev) => ev.chatId === CHAT };
    const fork = { being: 'egpt', inSession: (ev) => ev.chatId === FORK };
    expect(await b.spine.sayNow({ ...fork, text: 'from the fork' })).toMatchObject({ ok: true });
    expect(await b.spine.sayNow({ ...parent, text: 'from the parent' })).toMatchObject({ ok: true });
    expect(b.sent.filter((s) => s.text === 'from the fork').map((s) => s.chat)).toEqual([FORK]);
    expect(b.sent.filter((s) => s.text === 'from the parent').map((s) => s.chat)).toEqual([CHAT]);
  });

  it('live in the parent only: a say from the fork\'s session is refused, nothing lands in the parent', async () => {
    const b = build();
    b.bridge.emit(mention('@e a', 'p1', CHAT));
    await flush();
    expect(await b.spine.sayNow({ being: 'egpt', inSession: (ev) => ev.chatId === FORK, text: 'stray' })).toMatchObject({ ok: false, detail: 'no live turn' });
    expect(b.sent.map((s) => s.text)).not.toContain('stray');
  });

  it('two live turns matching one session is refused as ambiguous', async () => {
    const b = build();
    b.bridge.emit(mention('@e a', 'p1', CHAT));
    await flush();
    b.bridge.emit(mention('@e b', 'f1', FORK));
    await flush();
    expect(await b.spine.sayNow({ being: 'egpt', inSession: () => true, text: 'x' })).toMatchObject({ ok: false, detail: expect.stringMatching(/ambiguous/) });
  });

  it('allows MAX_SAYS_PER_TURN (10) and refuses the next', async () => {
    expect(MAX_SAYS_PER_TURN).toBe(10);
    const b = build();
    b.bridge.emit(mention());
    await flush();
    for (let i = 0; i < 10; i++) expect(await b.spine.sayNow({ ...WHO, text: `n${i}` })).toMatchObject({ ok: true });
    expect(await b.spine.sayNow({ ...WHO, text: 'one more' })).toMatchObject({ ok: false, detail: expect.stringMatching(/10/) });
    expect(b.sent).toHaveLength(10);
  });

  it('a post the sender does not deliver is a refusal, not a recorded line', async () => {
    const b = build({ publicOf: () => true });
    b.bridge.emit(mention());
    await flush();
    expect(await b.spine.sayNow({ ...WHO, text: 'hi' })).toMatchObject({ ok: false });
    expect(b.logged.filter((l) => l.being)).toHaveLength(0);
  });
});
