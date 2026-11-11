// On mode, a human line that does not address the being is a quiet turn (operator 2026-11-02, eGPT
// Admin 20:56: "why is polite silence not being suppressed?" — every line, even one to another being,
// left E's "⏳ Thinking…" edited to "✓"). No ⏳ at arrival or later, posted only when whole, its '…'
// never shown: the bot_quiet path. A line addressing the being (@handle, bare handle, a reply to its
// post) keeps its ⏳ at arrival. mention/accum, auto, bot_quiet and the tunnel are unchanged.
// dispatch.thinking_train: bubble — this file's subject is the ⏳ bubble (the emoji train: tests/emoji-thinking-train.test.mjs).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender, THINKING } from '../src/spine/sender.mjs';
import { createReplyActions } from '../src/spine/reply-actions.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const MOUTH_HOLDS = { route: async () => null, mouthIsElsewhere: () => false };
const CHAT = { surface: 'whatsapp', node: 'wa', chatId: '!g', chatName: 'eGPT Admin', kind: 'text', raw: { chatType: 'group' }, senderId: 'u-1', senderName: 'An' };
let seq = 0;
const msg = (body, extra = {}) => ({ ...CHAT, body, msgId: `m${++seq}`, ts: 1, mention: { ...mentionStatus(body, ['e', 'egpt']), replyToBot: extra.replyToBeing != null }, ...extra });
const BEING = { fromMember: { id: 'claude', kind: 'brain' } };   // another being's line (room relay)
const flush = () => new Promise((r) => setImmediate(r));
async function until(cond) { for (let i = 0; i < 50 && !cond(); i++) await flush(); }
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const TOOL = ['', { tool: true }];
const E = '🐶', N = '🦊';

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
    react(chat, msgId, emoji) { reactions.push([msgId, emoji]); return true; },
  };
}

// E (egpt) runs `work`; n, a second being in mention mode, answers '…'. `steers`: allow_new_input 'any'.
function build({ mode = 'on', work, steers = false, dispatch } = {}) {
  const agents = {
    egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, mode },
    n: { configuration: 'n', handles: ['n'], mode: 'mention' },
  };
  const config = { conversation_defaults: { allowed_users: ['u-1'] }, agents, dispatch: { thinking_train: 'bubble', ...dispatch } };
  const bridge = streamingBridge();
  const brain = {
    calls: [], steered: [],
    async turn(being, ev, onPartial) {
      if (being !== 'egpt') return { text: '…', being };
      brain.calls.push({ ev, open: bridge.streams.filter((s) => s.opts?.bodyEmoji === E).map((s) => s.init) });
      return work(onPartial);
    },
    ...(steers ? { allowNewInput: async () => 'any', steer: async (being, ev) => { brain.steered.push(ev.body); return true; } } : {}),
  };
  const transcript = { entries: [], async log(ev, r) { this.entries.push({ ev, reply: r }); } };
  const notes = [];
  const onLog = (s) => notes.push(s);
  const emojiOf = (b) => (b === 'n' ? N : E);
  const spine = createSpine({
    bridge, brain, transcript, defaultBeing: 'egpt', peerMouth: MOUTH_HOLDS,
    sender: createSender({ bridge, bodyEmojiOf: emojiOf, labelOf: () => 'E', onLog }),
    actions: createReplyActions({ bridge, peerMouth: MOUTH_HOLDS, bodyEmojiOf: emojiOf, labelOf: () => 'E', onLog }),
    router: createRouter({ getAgents: () => agents, getConfig: () => config, defaultBeing: 'egpt' }),
    gating: createGating({ getConfig: () => config, defaultKey: 'egpt' }),
    identity: { build: (m) => ({ ...m, line: m.body }) },
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now: () => 1 },
    log: { line: onLog },
  });
  spine.start();
  const eStreams = () => bridge.streams.filter((s) => s.opts?.bodyEmoji === E).map((s) => [s.init, s.frames, s.finals]);
  const eReplies = () => transcript.entries.filter((x) => x.reply != null && x.reply.being !== 'n').map((x) => x.reply);
  const withheld = () => notes.filter((s) => s.includes('nothing posted'));
  return { bridge, brain, eStreams, eReplies, withheld };
}
const speaks = (partials, text) => async (onPartial) => { for (const p of partials) (Array.isArray(p) ? onPartial(...p) : onPartial(p)); return { text }; };

afterEach(() => { vi.useRealTimers(); });

describe('on mode, a human line not addressed to the being — quiet', () => {
  for (const body of ['n estás?', 'n try to trigger E', 'qué calor hace hoy']) {
    it(`REPRODUCE (eGPT Admin 20:56): "${body}" answered '…' opens no ⏳ and posts nothing`, async () => {
      const b = build({ work: speaks([TOOL, '.', '..', '...'], '…') });
      await b.bridge.emit(msg(body));
      expect(b.brain.calls).toHaveLength(1);
      expect(b.brain.calls[0].open).toEqual([]);
      expect(b.eStreams()).toEqual([]);
      expect(b.bridge.sent).toEqual([]);
      expect(b.withheld()).toHaveLength(1);
      expect(b.eReplies()).toEqual([expect.objectContaining({ text: '…', surfaced: false })]);
    });
  }

  it('REPRODUCE: a real reply after a tool use and streamed text shows as it is written (2026-11-11) — no ⏳ first, one message', async () => {
    const b = build({ work: speaks([TOOL, 'Hace', 'Hace calor', TOOL], 'Hace calor, sí.') });
    await b.bridge.emit(msg('qué calor hace hoy'));
    expect(b.brain.calls[0].open).toEqual([]);
    expect(b.eStreams()).toEqual([['Hace ⏳', ['Hace calor ⏳'], ['Hace calor, sí.']]]);
    expect(b.bridge.streams[0].opts).toMatchObject({ replyTo: expect.stringMatching(/^m\d+$/) });
    expect(b.bridge.sent).toEqual([]);
  });

  it('REPRODUCE: a minute of work opens nothing; the reply is posted whole', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const g = gate();
    const b = build({ work: async () => { await g.p; return { text: 'Hecho' }; } });
    const done = b.bridge.emit(msg('alguien revisa esto?'));
    await until(() => b.brain.calls.length);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.eStreams()).toEqual([]);
    g.open();
    await done;
    expect(b.eStreams()).toEqual([['Hecho', [], ['Hecho']]]);
  });

  it('REPRODUCE: an unaddressed line steered into the quiet turn gets no ✍️ and opens nothing; an addressed one does both', async () => {
    const g = gate();
    const b = build({ steers: true, work: async () => { await g.p; return { text: 'Listo.' }; } });
    const first = msg('qué calor hace hoy');   // its own quiet turn: the arrival ✍️ (on-mode-arrival-ack.test.mjs)
    const done = b.bridge.emit(first);
    await until(() => b.brain.calls.length);
    await b.bridge.emit(msg('mirá esto'));
    await flush();
    expect(b.brain.steered).toEqual(['mirá esto']);
    expect(b.bridge.reactions).toEqual([[first.msgId, '✍️']]);
    expect(b.eStreams()).toEqual([]);
    const addressed = msg('e y aquello');
    await b.bridge.emit(addressed);
    await flush();
    expect(b.brain.steered).toEqual(['mirá esto', 'e y aquello']);
    expect(b.bridge.reactions).toEqual([[first.msgId, '✍️'], [addressed.msgId, '✍️']]);
    expect(b.eStreams().map(([init]) => init)).toEqual([THINKING]);
    g.open();
    await done;
    expect(b.eStreams()).toEqual([[THINKING, [], ['Listo.']]]);
  });
});

describe('on mode, a line addressed to the being — ⏳ at arrival, unchanged', () => {
  for (const [what, m] of [
    ['@handle', () => msg('@e hola')],
    ['bare handle at the start', () => msg('e hola')],
    ['@handle mid-line', () => msg('hola @e')],
    ['a reply to its post', () => msg('y esto?', { replyToBeing: 'egpt' })],
  ]) {
    it(`${what}: ⏳ before the turn runs; a '…' resolves it to ✓`, async () => {
      const b = build({ work: speaks([], '…') });
      await b.bridge.emit(m());
      expect(b.brain.calls[0].open).toEqual([THINKING]);
      expect(b.eStreams()).toEqual([[THINKING, [], ['✓']]]);
    });
  }

  it('a real reply streams into the ⏳', async () => {
    const b = build({ work: speaks([TOOL, 'Hola'], 'Hola') });
    await b.bridge.emit(msg('@e hola'));
    expect(b.eStreams()).toEqual([[THINKING, ['Hola ⏳'], ['Hola']]]);
  });
});

describe('regression locks', () => {
  it("mention mode: an unaddressed line runs no turn; '@e' answered '…' — ⏳ first, the '…' is posted", async () => {
    const b = build({ mode: 'mention', work: speaks([], '…') });
    await b.bridge.emit(msg('qué calor hace hoy'));
    expect(b.brain.calls).toHaveLength(0);
    await b.bridge.emit(msg('@e hola'));
    expect(b.eStreams()).toEqual([[THINKING, [], ['…']]]);
  });

  it('bot_quiet: false — on mode, a bot\'s unaddressed line still opens its ⏳ on a tool use', async () => {
    const b = build({ dispatch: { bot_quiet: false }, work: speaks([TOOL], '…') });
    await b.bridge.emit(msg('qué hora es allá?', BEING));
    expect(b.eStreams()).toEqual([[THINKING, [], ['✓']]]);
  });

  it('bot_quiet (default): on mode, a bot\'s line posts nothing on silence', async () => {
    const b = build({ work: speaks([TOOL], '…') });
    await b.bridge.emit(msg('qué hora es allá?', BEING));
    expect(b.eStreams()).toEqual([]);
  });
});

describe('gating.decide — quiet', () => {
  const gating = (mode, dispatch) => createGating({ getConfig: () => ({ agents: { egpt: { mode } }, ...(dispatch ? { dispatch } : {}) }) });
  const ev = { surface: 'whatsapp', chatId: '!g', body: 'hola' };
  const ADDRESSED = [{ atEStart: true, atEAnywhere: true }, { atEAnywhere: true }, { replyToBot: true }];

  it("on: a human's unaddressed line is quiet; an addressed one is not", async () => {
    expect((await gating('on').decide('egpt', ev, {})).quiet).toBe(true);
    for (const m of ADDRESSED) expect((await gating('on').decide('egpt', ev, m)).quiet).toBeUndefined();
  });

  for (const mode of ['auto', 'mention', 'mention-direct', 'accum']) {
    it(`${mode}: a human's unaddressed line is not quiet`, async () => {
      expect((await gating(mode).decide('egpt', ev, {})).quiet).toBeUndefined();
    });
  }

  it('on: a bot\'s line follows bot_quiet alone', async () => {
    expect((await gating('on').decide('egpt', ev, {}, { bot: true })).quiet).toBe(true);
    expect((await gating('on', { bot_quiet: false }).decide('egpt', ev, {}, { bot: true })).quiet).toBeUndefined();
  });
});
