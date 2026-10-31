// On-mode ambient turns post nothing up front (operator 2026-10-18): "if mode is 'on' then '...'
// should not be posted in channel, only logged." Ruled at 22:10: a HUMAN line opens its ⏳ at
// arrival, addressed or not; only a NON-HUMAN one (another being, a node-signed line) runs with no
// ⏳ — its silence posts nothing, a real reply posts once. Every other mode keeps the immediate ⏳.
// A test that streams or works before a non-human line's end, or runs one in mention/accum, sets
// dispatch.bot_quiet: false — the default quiet turn is tests/mode-bot-quiet.test.mjs's.
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender, THINKING } from '../src/spine/sender.mjs';
import { createReplyActions } from '../src/spine/reply-actions.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const MOUTH_HOLDS = { route: async () => null, mouthIsElsewhere: () => false };
const CHAT = { surface: 'whatsapp', node: 'wa', chatId: '!g', chatName: 'grupo', kind: 'text', raw: { chatType: 'group' }, senderId: 'u-1', senderName: 'An' };
let seq = 0;
const BEING = { fromMember: { id: 'claude', kind: 'brain' } };   // another being's line (room relay)
const SIGNED = { fromNode: 'do' };                                // a node-signed line
const msg = (body, extra = {}) => ({
  ...CHAT, body, msgId: `m${++seq}`, ts: 1,
  mention: { ...mentionStatus(body, ['e', 'egpt']), replyToBot: extra.replyToBeing != null },
  ...extra,
});

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
    react(chat, msgId, emoji) { reactions.push({ chat, msgId, emoji }); return true; },
  };
}

// Fired on demand: the auto dwell is a timer.
function fakeTimers() {
  const pending = [];
  return {
    setTimeout: (fn) => { pending.push(fn); return { unref() {} }; },
    clearTimeout: () => {},
    async settle() { for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 0)); pending.splice(0).forEach((fn) => fn()); } },
  };
}

function build({ mode = 'on', reply = 'ok', partials = [], tasks = [], dispatch } = {}) {
  const agents = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, mode } };
  const config = { conversation_defaults: { allowed_users: ['u-1'] }, agents, ...(dispatch ? { dispatch } : {}) };   // An (u-1) owns the node
  const bridge = streamingBridge();
  const brain = {
    calls: [], tasks,
    async turn(being, ev, onPartial) { this.calls.push({ being, ev, open: bridge.streams.map((s) => s.init) }); for (const p of partials) (Array.isArray(p) ? onPartial?.(...p) : onPartial?.(p)); return { text: reply, sessionId: 's' }; },
  };
  const transcript = { entries: [], async log(ev, r) { this.entries.push({ ev, reply: r }); } };
  const notes = [];
  const onLog = (s) => notes.push(s);
  const timers = mode === 'auto' ? fakeTimers() : null;
  const spine = createSpine({
    ...(timers ? { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, turnTimeoutMs: 0 } : {}),
    bridge, brain, transcript, defaultBeing: 'egpt',
    allBackground: () => brain.tasks.map((t) => ({ being: 'egpt', surface: 'whatsapp', chatId: '!g', ...t })),
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
  const quiet = () => notes.filter((s) => s.includes('nothing posted'));
  return { bridge, brain, replies, quiet, timers };
}

describe('on mode, a non-human line — no placeholder up front', () => {
  // contract 6.2
  it("REPRODUCE: a '…' silence posts NOTHING (no ⏳, no ✓, no edit) and logs one line", async () => {
    const b = build({ reply: '…' });
    await b.bridge.emit(msg('qué calor hace hoy', BEING));
    expect(b.brain.calls).toHaveLength(1);
    expect(b.bridge.streams).toEqual([]);
    expect(b.bridge.sent).toEqual([]);
    expect(b.quiet()).toHaveLength(1);
    expect(b.replies()).toEqual([expect.objectContaining({ text: '…', surfaced: false })]);   // recorded as today
  });

  it("REPRODUCE (live 'E: ⏳ Thinking… → E: …'): a streamed '…' partial opens nothing either", async () => {
    const b = build({ reply: '...', partials: ['.', '..', '...'] });
    await b.bridge.emit(msg('jaja', BEING));
    expect(b.bridge.streams).toEqual([]);
    expect(b.bridge.sent).toEqual([]);
    expect(b.quiet()).toHaveLength(1);
  });

  it('an empty turn posts nothing as well (no "<received silence>")', async () => {
    const b = build({ reply: '' });
    await b.bridge.emit(msg('ok', BEING));
    expect(b.bridge.streams).toEqual([]);
    expect(b.bridge.sent).toEqual([]);
    expect(b.quiet()).toHaveLength(1);
  });

  it('a real reply is posted ONCE, opening on its first text — never on ⏳ Thinking…', async () => {
    const b = build({ reply: 'Hola a todos', partials: ['Hola', 'Hola a todos'], dispatch: { bot_quiet: false } });
    await b.bridge.emit(msg('buenas', BEING));
    expect(b.bridge.streams).toHaveLength(1);
    const [s] = b.bridge.streams;
    expect(s.init).toBe('Hola ⏳');
    expect(s.opts).toMatchObject({ replyTo: expect.stringMatching(/^m\d+$/), bodyEmoji: '🐶' });
    expect(s.frames).toEqual(['Hola a todos ⏳']);
    expect(s.finals).toEqual(['Hola a todos']);
    expect(b.bridge.sent).toEqual([]);
    expect(b.quiet()).toEqual([]);
  });

  it('a real reply with no stream at all opens on the reply itself', async () => {
    const b = build({ reply: 'Hola' });
    await b.bridge.emit(msg('buenas', BEING));
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([['Hola', ['Hola']]]);
    expect(b.bridge.sent).toEqual([]);
  });

  it('a /react-only turn: the reaction lands, no message is posted', async () => {
    seq = 40;
    const b = build({ reply: '/react #m41 👍' });
    await b.bridge.emit(msg('lo logré!', BEING));
    expect(b.bridge.reactions).toEqual([{ chat: '!g', msgId: 'm41', emoji: '👍' }]);
    expect(b.bridge.streams).toEqual([]);
    expect(b.bridge.sent).toEqual([]);
  });

  it('a silent turn that leaves background work still posts the ⚙️ status — unquoted: the silence posted nothing to quote', async () => {
    const b = build({ reply: '…', tasks: [{ description: 'Crawl the site', since: 1 }] });
    await b.bridge.emit(msg('alguien sabe?', BEING));
    await new Promise((r) => setImmediate(r));
    expect(b.bridge.streams).toEqual([]);
    expect(b.bridge.sent).toMatchObject([{ chat: '!g', text: '⚙️ background work (1):\n• Crawl the site · 0s', opts: { persona: 'egpt', replyTo: null } }]);
  });

  it("REPRODUCE: addressed makes no difference — a node-signed '@e …' silence posts nothing", async () => {
    const b = build({ reply: '…' });
    await b.bridge.emit(msg('@e hola', SIGNED));
    expect(b.brain.calls).toHaveLength(1);
    expect(b.bridge.streams).toEqual([]);
    expect(b.bridge.sent).toEqual([]);
    expect(b.quiet()).toHaveLength(1);
  });

  it("REPRODUCE: another being's '@e …' reply opens on its own text, never on ⏳", async () => {
    const b = build({ reply: 'Hola' });
    await b.bridge.emit(msg('@e hola', BEING));
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([['Hola', ['Hola']]]);
  });
});

describe('on mode, a human line — ⏳ at arrival, addressed or not', () => {
  it('REPRODUCE: an unaddressed line opens its ⏳ before the turn runs; the reply edits it', async () => {
    const b = build({ reply: 'Hola' });
    await b.bridge.emit(msg('qué calor hace hoy'));
    expect(b.brain.calls[0].open).toEqual([THINKING]);
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([[THINKING, ['Hola']]]);
  });

  it("REPRODUCE: an unaddressed '…' resolves the ⏳ to ✓, nothing withheld", async () => {
    const b = build({ reply: '…' });
    await b.bridge.emit(msg('jaja'));
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([[THINKING, ['✓']]]);
    expect(b.bridge.sent).toEqual([]);
    expect(b.quiet()).toEqual([]);
  });
});

describe('a human, addressed, or any other mode — unchanged: immediate ⏳', () => {
  for (const [what, m] of [
    ['@handle', () => msg('@e hola')],
    ['handle at the start', () => msg('e hola')],
    ['a reply to the being', () => msg('y esto?', { replyToBeing: 'egpt' })],
  ]) {
    it(`on mode, ${what}: ⏳ placeholder first, the reply edits it`, async () => {
      const b = build({ reply: 'Hola' });
      await b.bridge.emit(m());
      expect(b.bridge.streams).toHaveLength(1);
      expect(b.bridge.streams[0].init).toBe(THINKING);
      expect(b.bridge.streams[0].finals).toEqual(['Hola']);
    });
  }

  it("on mode, addressed '…': the ⏳ resolves to ✓ as today", async () => {
    const b = build({ reply: '…' });
    await b.bridge.emit(msg('@e hola'));
    expect(b.bridge.streams[0].init).toBe(THINKING);
    expect(b.bridge.streams[0].finals).toEqual(['✓']);
    expect(b.quiet()).toEqual([]);
  });

  for (const mode of ['mention', 'accum']) {
    for (const [who, extra] of [['a human', {}], ['another being', BEING]]) {
      it(`${mode} mode, @handle from ${who}: ⏳ placeholder first, a '…' is posted`, async () => {
        const b = build({ mode, reply: '…', dispatch: { bot_quiet: false } });
        await b.bridge.emit(msg('@e hola', extra));
        expect(b.bridge.streams[0].init).toBe(THINKING);
        expect(b.bridge.streams[0].finals).toEqual(['…']);
      });
    }
  }
});

describe("on mode, a streamed '…' silence — the train keeps showing, then ✓", () => {
  const DOTS = ['.', '..', '...'];

  it("REPRODUCE: a human line streaming '.', '..', '...' ends ✓; no frame ever shows dots", async () => {
    const b = build({ reply: '...', partials: DOTS });
    await b.bridge.emit(msg('jaja'));
    expect(b.bridge.streams.map((s) => [s.init, s.frames, s.finals])).toEqual([[THINKING, [], ['✓']]]);
    expect(b.bridge.sent).toEqual([]);
  });

  it("REPRODUCE: an addressed human '@e' line streaming '…' ends ✓ as well", async () => {
    const b = build({ reply: '…', partials: ['…'] });
    await b.bridge.emit(msg('@e hola'));
    expect(b.bridge.streams.map((s) => [s.init, s.frames, s.finals])).toEqual([[THINKING, [], ['✓']]]);
  });

  it("REPRODUCE: a non-human line whose train opened on a tool use, then streamed dots, ends ✓", async () => {
    const b = build({ reply: '...', partials: [['', { tool: true }], ...DOTS], dispatch: { bot_quiet: false } });
    await b.bridge.emit(msg('jaja', BEING));
    expect(b.bridge.streams.map((s) => [s.init, s.frames, s.finals])).toEqual([[THINKING, [], ['✓']]]);
  });

  it("REPRODUCE: a reply that starts with dots streams once other text arrives", async () => {
    const b = build({ reply: '...bueno, sí', partials: ['...', '...bueno', '...bueno, sí'] });
    await b.bridge.emit(msg('vienes?'));
    const [s] = b.bridge.streams;
    expect(s.frames).toEqual(['...bueno ⏳', '...bueno, sí ⏳']);
    expect(s.finals).toEqual(['...bueno, sí']);
  });

  it('a non-human streamed silence still posts nothing', async () => {
    const b = build({ reply: '...', partials: DOTS });
    await b.bridge.emit(msg('jaja', BEING));
    expect(b.bridge.streams).toEqual([]);
    expect(b.bridge.sent).toEqual([]);
  });

  it('auto mode: a streamed silence posts nothing', async () => {
    const b = build({ mode: 'auto', reply: '...', partials: DOTS });
    await b.bridge.emit(msg('jaja'));
    await b.timers.settle();
    expect(b.brain.calls).toHaveLength(1);
    expect(b.bridge.streams).toEqual([]);
    expect(b.bridge.sent).toEqual([]);
  });

  for (const mode of ['mention', 'accum']) {
    it(`${mode} mode: a streamed '...' still surfaces, frames and all`, async () => {
      const b = build({ mode, reply: '...', partials: DOTS });
      await b.bridge.emit(msg('@e hola'));
      expect(b.bridge.streams.map((s) => [s.init, s.frames, s.finals])).toEqual([[THINKING, ['. ⏳', '.. ⏳', '... ⏳'], ['...']]]);
    });
  }
});

describe('sender — ambient open', () => {
  function fakeBridge() {
    const streams = [], sent = [];
    return {
      streams, sent,
      send(chat, text, opts) { sent.push({ chat, text, opts }); return { ok: true }; },
      startStream(chat, init, opts) {
        const h = { chat, init, opts, frames: [], finals: [], delivered: false, update(t) { h.frames.push(t); }, async finish(t) { h.finals.push(t); h.delivered = true; } };
        streams.push(h); return h;
      },
    };
  }

  it('holds a dots-only partial, opens on the first real text, streams from there', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e', replyTo: 'm1', ambient: true, queued: true, queuedAhead: 1 });
    out.activate();
    out.update('…');
    expect(bridge.streams).toEqual([]);
    out.update('Mirá');
    out.update('Mirá esto');
    expect(bridge.streams.map((s) => s.init)).toEqual(['Mirá ⏳']);
    expect(bridge.streams[0].frames).toEqual(['Mirá esto ⏳']);
    await out.finish({ text: 'Mirá esto' });
    expect(bridge.streams[0].finals).toEqual(['Mirá esto']);
    expect(bridge.sent).toEqual([]);
  });

  it("a withheld silence after a held '…' posts nothing and logs one line", async () => {
    const bridge = fakeBridge();
    const log = [];
    const out = createSender({ bridge, onLog: (s) => log.push(s) }).open('!c', { being: 'e', ambient: true });
    out.update('…');
    expect(out.pulse(20_000)).toBe(true);
    await out.finish({ text: '…' }, { surface: false });
    expect(bridge.streams).toEqual([]);
    expect(bridge.sent).toEqual([]);
    expect(log).toHaveLength(1);
    expect(out.confirmedId).toBe(null);
  });

  it('a local mouth says the late reply in its own room; a silence reaches neither account', async () => {
    const ear = fakeBridge(), mouth = fakeBridge();
    const peerMouth = { route: async () => ({ bridge: mouth, chatId: 'mouth-room', connection: 'rodz' }) };
    const sender = createSender({ bridge: ear, peerMouth });
    const silent = sender.open('!c', { being: 'e', ambient: true });
    await silent.finish({ text: '...' }, { surface: false });
    const said = sender.open('!c', { being: 'e', ambient: true });
    said.update('Hola');
    await said.finish({ text: 'Hola' });
    expect(ear.streams).toEqual([]);
    expect(ear.sent).toEqual([]);
    expect(mouth.streams.map((s) => [s.chat, s.init, s.finals])).toEqual([['mouth-room', 'Hola ⏳', ['Hola']]]);
  });

  it("hideSilence: dots-only partials leave the ⏳ alone; a withheld '...' settles on ✓", async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e', hideSilence: true });
    out.update('.'); out.update('...');
    await out.finish({ text: '...' }, { surface: false });
    expect(bridge.streams.map((s) => [s.init, s.frames, s.finals])).toEqual([[THINKING, [], ['✓']]]);
  });

  it('a failed ambient turn still says so, once', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e', ambient: true });
    await out.fail(new Error('boom'));
    expect(bridge.streams.map((s) => [s.init, s.finals])).toEqual([['… ❌ Sending failed.', ['… ❌ Sending failed.']]]);
  });
});
