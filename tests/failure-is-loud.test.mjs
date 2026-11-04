// A failed turn is loud (operator 2026-11-04: "if there's a failure it has to be loud, and must not go silent
// as unresponsiveness"). An engine error, an API error or refusal (the engine's flag), a timeout, an empty or
// failed result: one failure line, naming it, where the reply would have gone, in every mode and for quiet,
// emoji, unaddressed, tunnelled and bot-triggered turns alike; the mark comes off. A '…' is no failure.
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender } from '../src/spine/sender.mjs';
import { createReplyActions } from '../src/spine/reply-actions.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const MOUTH_HOLDS = { route: async () => null, mouthIsElsewhere: () => false };
const CHAT = { surface: 'whatsapp', node: 'wa', chatId: '!g', chatName: 'familia', kind: 'text', raw: { chatType: 'group' }, senderId: 'u-1', senderName: 'An' };
let seq = 0;
const msg = (body, extra = {}) => ({ ...CHAT, body, msgId: `m${++seq}`, ts: 1, mention: { ...mentionStatus(body, ['e', 'egpt']), replyToBot: false }, ...extra });
const BEING = { fromMember: { id: 'claude', kind: 'brain' } };
const flush = () => new Promise((r) => setImmediate(r));

const SAFEGUARDS = { text: "API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations.\n\nDetails: `[reasoning_extraction]`", failed: true, failReason: 'is_error' };
const LINE = (why) => `⚠️ the turn failed — ${why}; not answered`;

function fakeBridge() {
  let cb = null;
  const events = [];
  return {
    events,
    onMessage(fn) { cb = fn; }, emit(m) { return cb(m); }, stop() {},
    send(chat, text) { events.push(['send', chat, text]); return { ok: true }; },
    startStream(chat, init) {
      const h = { delivered: false, confirmedId: `${chat}#${events.length}`, update() {}, async finish(t) { h.delivered = true; events.push(['post', chat, t]); } };
      return h;
    },
    react(chat, msgId, emoji) { events.push(['react', chat, msgId, emoji]); return true; },
    unreact(chat, msgId, emoji) { events.push(['unreact', chat, msgId, emoji]); return true; },
  };
}

// '!t' replies into a tunnel; '!l' into a side group made only once the reply has something to post.
function build({ mode = 'on', train, work, turnTimeoutMs = 0 } = {}) {
  const agents = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, mode } };
  const config = { conversation_defaults: { allowed_users: ['u-1'] }, agents, ...(train ? { dispatch: { thinking_train: train } } : {}) };
  const bridge = fakeBridge();
  const brain = { async turn() { return work(); } };
  const made = [];
  const sideGroupFor = async (ev, { create } = {}) => (ev.chatId === '!t' ? { chatId: '!split', tunnel: true }
    : ev.chatId === '!l' ? (create ? '!side' : async () => { made.push('!side'); return '!side'; }) : null);
  const timers = [];
  const onLog = () => {};
  const spine = createSpine({
    bridge, brain, transcript: { async log() {} }, defaultBeing: 'egpt', peerMouth: MOUTH_HOLDS, turnTimeoutMs,
    sender: createSender({ bridge, peerMouth: MOUTH_HOLDS, bodyEmojiOf: () => '🐶', labelOf: () => 'E', onLog }),
    actions: createReplyActions({ bridge, peerMouth: MOUTH_HOLDS, bodyEmojiOf: () => '🐶', labelOf: () => 'E', onLog }),
    router: createRouter({ getAgents: () => agents, getConfig: () => config, defaultBeing: 'egpt' }),
    gating: createGating({ getConfig: () => config, defaultKey: 'egpt', sideGroupFor }),
    identity: { build: (m) => ({ ...m, line: m.body }) },
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now: () => 1 },
    setTimeout: (fn) => { timers.push(fn); return { unref() {} }; }, clearTimeout: () => {}, rng: () => 0.5,
    log: { line: onLog },
  });
  spine.start();
  const posts = () => bridge.events.filter(([op]) => op === 'post' || op === 'send').map(([, chat, t]) => [chat, t]);
  const marks = (id) => bridge.events.filter(([op, , msgId]) => (op === 'react' || op === 'unreact') && msgId === id).map(([op, , , e]) => `${op === 'react' ? '+' : '-'}${e}`);
  const fire = () => { for (const fn of timers.splice(0)) fn(); };
  return { bridge, posts, marks, made, fire };
}
async function run(b, m) { await b.bridge.emit(m); await flush(); await flush(); }
const TRAIN = ['+👾', '+🤔', '-🤔'];

describe('a failed turn posts its one failure line, naming the failure', () => {
  it("REPRODUCE (live, the family chat): an unaddressed 'on' line whose result is the safeguards refusal", async () => {
    const b = build({ work: async () => SAFEGUARDS });
    const m = msg('w hi');
    await run(b, m);
    expect(b.posts()).toEqual([['!g', LINE('API error (safeguards)')]]);
    expect(b.marks(m.msgId)).toEqual(TRAIN);
  });

  it('REPRODUCE: an emoji turn that fails posts it and takes the reaction off', async () => {
    const b = build({ mode: 'mention', work: async () => ({ text: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.', failed: true, failReason: 'is_error api_error 401' }) });
    const m = msg('@e hola');
    await run(b, m);
    expect(b.posts()).toEqual([['!g', LINE('API error 401')]]);
    expect(b.marks(m.msgId)).toEqual(TRAIN);
  });

  it('REPRODUCE: an addressed failure (bubble) posts it', async () => {
    const b = build({ train: 'bubble', work: async () => SAFEGUARDS });
    await run(b, msg('@e hola'));
    expect(b.posts()).toEqual([['!g', LINE('API error (safeguards)')]]);
  });

  it("REPRODUCE: a bot's line and a tunnelled turn that fail post it", async () => {
    const b = build({ work: async () => SAFEGUARDS });
    await run(b, msg('@e qué hora es allá?', BEING));
    await run(b, msg('@e qué calor', { chatId: '!t' }));
    expect(b.posts()).toEqual([['!g', LINE('API error (safeguards)')], ['!split', LINE('API error (safeguards)')]]);
  });

  for (const train of [undefined, 'bubble']) {
    it(`REPRODUCE: a failed result with no text, and an empty one, are failures too (${train ?? 'emoji'})`, async () => {
      const replies = [{ text: '', failed: true, failReason: 'is_error' }, { text: '' }];
      const b = build({ train, work: async () => replies.shift() });
      const m = msg('qué calor hace hoy');
      await run(b, m);
      await run(b, msg('y mañana?'));
      expect(b.posts()).toEqual([['!g', LINE('engine error')], ['!g', LINE('empty reply')]]);
    });
  }

  it('REPRODUCE: a thrown engine error and a timeout name themselves, not a send fault', async () => {
    const b = build({ work: async () => { throw new Error('claude: error_during_execution — overloaded'); } });
    await run(b, msg('qué calor hace hoy'));
    const t = build({ turnTimeoutMs: 600_000, work: () => new Promise(() => {}) });
    const m = msg('@e hola');
    const done = t.bridge.emit(m);
    await flush();
    t.fire();
    await done;
    await flush();
    expect(b.posts()).toEqual([['!g', LINE('claude: error_during_execution — overloaded')]]);
    expect(t.posts()).toEqual([['!g', LINE('timed out after 10m00s')]]);
    expect(t.marks(m.msgId)).toEqual(TRAIN);
  });

  it('REPRODUCE: an unaddressed failure whose side group is not made yet makes it and posts there', async () => {
    const b = build({ work: async () => SAFEGUARDS });
    await run(b, msg('qué calor', { chatId: '!l' }));
    expect(b.made).toEqual(['!side']);
    expect(b.posts()).toEqual([['!side', LINE('API error (safeguards)')]]);
  });
});

describe("a '…' is no failure (lock)", () => {
  it("an unaddressed '…' posts nothing; an addressed one with the emoji train posts the '…'; its side group is never made", async () => {
    const b = build({ work: async () => ({ text: '…' }) });
    const m = msg('qué calor hace hoy');
    await run(b, m);
    await run(b, msg('qué calor', { chatId: '!l' }));
    expect(b.posts()).toEqual([]);
    expect(b.made).toEqual([]);
    expect(b.marks(m.msgId)).toEqual(TRAIN);
    await run(b, msg('@e hola'));
    expect(b.posts()).toEqual([['!g', '…']]);
  });

  it("bubble: an unaddressed '…' posts nothing", async () => {
    const b = build({ train: 'bubble', work: async () => ({ text: '…' }) });
    await run(b, msg('qué calor hace hoy'));
    expect(b.posts()).toEqual([]);
  });
});
