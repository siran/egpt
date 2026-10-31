// dispatch.bot_quiet (operator 2026-10-31, default on): a turn a BOT's line triggered — another
// being, a node-signed line (isHumanTurn false) — stays quiet. No ⏳ train opens for it, whatever
// the being does meanwhile (a tool use, ten seconds of work, streamed text); its reply is posted
// once, whole, when the turn ends; its '…' is never shown, in any mode — only recorded, as
// "(not surfaced)". No ✓ bubble, no steer reaction on the bot's line. A HUMAN's turn is unchanged.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender, THINKING } from '../src/spine/sender.mjs';
import { createReplyActions } from '../src/spine/reply-actions.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const MOUTH_HOLDS = { route: async () => null, mouthIsElsewhere: () => false };
const CHAT = { surface: 'whatsapp', node: 'wa', chatId: '!g', chatName: 'grupo', kind: 'text', raw: { chatType: 'group' }, senderId: 'u-1', senderName: 'An' };
let seq = 0;
const msg = (body, extra = {}) => ({ ...CHAT, body, msgId: `m${++seq}`, ts: 1, mention: { ...mentionStatus(body, ['e', 'egpt']), replyToBot: false }, ...extra });
const BEING = { fromMember: { id: 'claude', kind: 'brain' } };   // another being's line (room relay)
const SIGNED = { fromNode: 'do' };                                // a node-signed line ("💸<do>")
const flush = () => new Promise((r) => setImmediate(r));
async function until(cond) { for (let i = 0; i < 50 && !cond(); i++) await flush(); }
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const TOOL = ['', { tool: true }];

function streamingBridge() {
  let cb = null;
  const streams = [], sent = [], reactions = [];
  return {
    streams, sent, reactions,
    onMessage(fn) { cb = fn; }, emit(m) { return cb(m); }, stop() {},
    send(chat, text, opts) { sent.push({ chat, text, opts }); return { ok: true }; },
    startStream(chat, init, opts) {
      const h = { chat, init, opts, frames: [], finals: [], delivered: false, confirmedId: `${chat}#${streams.length + 1}`, update(t) { h.frames.push(t); }, async finish(t) { h.finals.push(t); h.delivered = true; } };
      streams.push(h);
      return h;
    },
    react(chat, msgId, emoji) { reactions.push(emoji); return true; },
  };
}

// `work(onPartial)` is the brain's turn body; `steers` turns on allow_new_input 'any'.
function build({ mode = 'on', work, steers = false, dispatch } = {}) {
  const agents = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, mode } };
  const config = { conversation_defaults: { allowed_users: ['u-1'] }, agents, ...(dispatch ? { dispatch } : {}) };
  const bridge = streamingBridge();
  const brain = {
    calls: [], steered: [],
    async turn(being, ev, onPartial) { brain.calls.push({ ev, open: bridge.streams.map((s) => s.init) }); return work(onPartial); },
    ...(steers ? { allowNewInput: async () => 'any', steer: async (being, ev) => { brain.steered.push(ev.body); return true; } } : {}),
  };
  const transcript = { entries: [], async log(ev, r) { this.entries.push({ ev, reply: r }); } };
  const notes = [];
  const onLog = (s) => notes.push(s);
  const spine = createSpine({
    bridge, brain, transcript, defaultBeing: 'egpt', peerMouth: MOUTH_HOLDS,
    sender: createSender({ bridge, bodyEmojiOf: () => '🐶', labelOf: () => 'E', onLog }),
    actions: createReplyActions({ bridge, peerMouth: MOUTH_HOLDS, bodyEmojiOf: () => '🐶', labelOf: () => 'E', onLog }),
    router: createRouter({ getAgents: () => agents, getConfig: () => config, defaultBeing: 'egpt' }),
    gating: createGating({ getConfig: () => config, defaultKey: 'egpt' }),
    identity: { build: (m) => ({ ...m, line: m.body }) },
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now: () => 1 },
    log: { line: onLog },
  });
  spine.start();
  const replies = () => transcript.entries.filter((e) => e.reply != null).map((e) => e.reply);
  return { bridge, brain, replies };
}
const speaks = (partials, text) => async (onPartial) => { for (const p of partials) (Array.isArray(p) ? onPartial(...p) : onPartial(p)); return { text }; };

afterEach(() => { vi.useRealTimers(); });

describe('bot_quiet (default on): a bot-triggered turn opens no ⏳ train', () => {
  for (const [who, extra, body] of [['another being', BEING, 'qué hora es allá?'], ['a node-signed line', SIGNED, '@e qué hora es allá?']]) {
    it(`REPRODUCE: on mode, ${who} — worked (a tool use), streamed dots, ended '…': nothing reaches the chat, the '…' is recorded`, async () => {
      const b = build({ work: speaks([TOOL, '.', '..', '...'], '…') });
      await b.bridge.emit(msg(body, extra));
      expect(b.brain.calls).toHaveLength(1);
      expect(b.bridge.streams).toEqual([]);
      expect(b.bridge.sent).toEqual([]);
      expect(b.replies()).toEqual([expect.objectContaining({ text: '…', surfaced: false })]);
    });
  }

  it('REPRODUCE: on mode, a real reply after a tool use and streamed text is posted ONCE, whole — no ⏳, no live frames', async () => {
    const b = build({ work: speaks([TOOL, 'Son', 'Son las 3', TOOL], 'Son las 3 allá.') });
    await b.bridge.emit(msg('qué hora es allá?', BEING));
    expect(b.brain.calls[0].open).toEqual([]);
    expect(b.bridge.streams.map((s) => [s.init, s.frames, s.finals])).toEqual([['Son las 3 allá.', [], ['Son las 3 allá.']]]);
    expect(b.bridge.streams[0].opts).toMatchObject({ replyTo: expect.stringMatching(/^m\d+$/), bodyEmoji: '🐶' });
    expect(b.bridge.sent).toEqual([]);
  });

  it('REPRODUCE: on mode, ten seconds of work open nothing either', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const g = gate();
    const b = build({ work: async () => { await g.p; return { text: 'Hecho' }; } });
    const done = b.bridge.emit(msg('alguien revisa esto?', BEING));
    await until(() => b.brain.calls.length);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.bridge.streams).toEqual([]);
    g.open();
    await done;
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([['Hecho', ['Hecho']]]);
  });

  for (const mode of ['mention', 'accum']) {
    it(`REPRODUCE: ${mode} mode, a bot's '@e …' answered '…' posts nothing — no ⏳, no '…', no ✓`, async () => {
      const b = build({ mode, work: speaks(['…'], '…') });
      await b.bridge.emit(msg('@e hola', SIGNED));
      expect(b.brain.calls).toHaveLength(1);
      expect(b.bridge.streams).toEqual([]);
      expect(b.bridge.sent).toEqual([]);
      expect(b.replies()).toEqual([expect.objectContaining({ text: '…', surfaced: false })]);
    });

    it(`REPRODUCE: ${mode} mode, a bot's '@e …' real reply is posted once, whole`, async () => {
      const b = build({ mode, work: speaks(['Hola'], 'Hola, D.') });
      await b.bridge.emit(msg('@e hola', SIGNED));
      expect(b.brain.calls[0].open).toEqual([]);
      expect(b.bridge.streams.map((s) => [s.init, s.frames, s.finals])).toEqual([['Hola, D.', [], ['Hola, D.']]]);
    });
  }

  it("REPRODUCE: a bot's line steered into a live turn gets no ✍️ — a human's still does", async () => {
    const g = gate();
    const b = build({ steers: true, work: async () => { await g.p; return { text: 'Listo.' }; } });
    const done = b.bridge.emit(msg('@e revisa esto'));
    await until(() => b.brain.calls.length);
    await b.bridge.emit(msg('@e y esto también', SIGNED));
    await flush();
    expect(b.brain.steered).toEqual(['@e y esto también']);
    expect(b.bridge.reactions).toEqual([]);
    await b.bridge.emit(msg('e y aquello'));
    await flush();
    expect(b.bridge.reactions).toEqual(['✍️']);
    g.open();
    await done;
  });
});

describe('bot_quiet: a HUMAN-triggered turn is unchanged', () => {
  it('on mode: ⏳ at arrival, live frames, the reply settles it', async () => {
    const b = build({ work: speaks([TOOL, 'Hola'], 'Hola') });
    await b.bridge.emit(msg('qué calor hace hoy'));
    expect(b.brain.calls[0].open).toEqual([THINKING]);
    expect(b.bridge.streams.map((s) => [s.init, s.frames, s.finals])).toEqual([[THINKING, ['Hola ⏳'], ['Hola']]]);
  });

  it("on mode: a '…' resolves the ⏳ to ✓", async () => {
    const b = build({ work: speaks([], '…') });
    await b.bridge.emit(msg('jaja'));
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([[THINKING, ['✓']]]);
  });

  it("mention mode: '@e' answered '…' — ⏳ first, the '…' is posted", async () => {
    const b = build({ mode: 'mention', work: speaks([], '…') });
    await b.bridge.emit(msg('@e hola'));
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([[THINKING, ['…']]]);
    expect(b.replies()).toEqual([expect.objectContaining({ text: '…', surfaced: true })]);
  });
});

describe('bot_quiet: false — a bot-triggered turn as before', () => {
  const dispatch = { bot_quiet: false };

  it('on mode: a tool use opens the ⏳ train; the silence settles it ✓', async () => {
    const b = build({ dispatch, work: speaks([TOOL], '…') });
    await b.bridge.emit(msg('qué hora es allá?', BEING));
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([[THINKING, ['✓']]]);
  });

  it("mention mode: a bot's '@e' — ⏳ first, its '…' is posted", async () => {
    const b = build({ mode: 'mention', dispatch, work: speaks([], '…') });
    await b.bridge.emit(msg('@e hola', SIGNED));
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([[THINKING, ['…']]]);
  });
});
