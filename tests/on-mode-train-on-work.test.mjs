// An ambient 'on' turn opens its ⏳ train when the being starts working (operator 2026-10-18,
// after "help me pay paypal…" ran ~37 s with nothing visible and a steered "e" opened nothing
// either): on its first tool use, after AMBIENT_OPEN_MS of running, or when a human line is
// steered in. A quick tool-free silence still posts nothing. Ambient = a NON-HUMAN line (22:10):
// a human's opens its ⏳ on arrival. Built with dispatch.bot_quiet: false — under the default a
// non-human line's train never opens before its end (tests/mode-bot-quiet.test.mjs).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender, THINKING } from '../src/spine/sender.mjs';
import { createReplyActions } from '../src/spine/reply-actions.mjs';
import { createWarmCliSession } from '../src/warm-cli-session.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const MOUTH_HOLDS = { route: async () => null, mouthIsElsewhere: () => false };
const CHAT = { surface: 'whatsapp', node: 'wa', chatId: '!g', chatName: 'grupo', kind: 'text', raw: { chatType: 'group' }, senderId: 'u-1', senderName: 'An' };
let seq = 0;
const msg = (body, extra = {}) => ({ ...CHAT, body, msgId: `m${++seq}`, ts: 1, mention: { ...mentionStatus(body, ['e', 'egpt']), replyToBot: false }, ...extra });
const BEING = { fromMember: { id: 'claude', kind: 'brain' } };   // another being's line (room relay)
const flush = () => new Promise((r) => setImmediate(r));
async function until(cond) { for (let i = 0; i < 50 && !cond(); i++) await flush(); }
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

function streamingBridge() {
  let cb = null;
  const streams = [], sent = [];
  return {
    streams, sent,
    onMessage(fn) { cb = fn; }, emit(m) { return cb(m); }, stop() {},
    send(chat, text, opts) { sent.push({ chat, text, opts }); return { ok: true }; },
    startStream(chat, init, opts) {
      const h = { chat, init, opts, frames: [], finals: [], delivered: false, confirmedId: `${chat}#${streams.length + 1}`, update(t) { h.frames.push(t); }, async finish(t) { h.finals.push(t); h.delivered = true; } };
      streams.push(h);
      return h;
    },
    react() { return true; },
  };
}

// `work(onPartial)` is the brain's turn body; `steers` turns on allow_new_input 'any'.
function build({ mode = 'on', work, steers = false } = {}) {
  const agents = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, mode } };
  const config = { conversation_defaults: { allowed_users: ['u-1'] }, agents, dispatch: { bot_quiet: false } };   // An (u-1) owns the node
  const bridge = streamingBridge();
  const brain = {
    calls: [], steered: [],
    async turn(being, ev, onPartial) { brain.calls.push(ev); return work(onPartial); },
    ...(steers ? { allowNewInput: async () => 'any', steer: async (being, ev) => { brain.steered.push(ev.body); return true; } } : {}),
  };
  const transcript = { async log() {} };
  const notes = [];
  const onLog = (s) => notes.push(s);
  const spine = createSpine({
    bridge, brain, transcript, defaultBeing: 'egpt',
    sender: createSender({ bridge, bodyEmojiOf: () => '🐶', labelOf: () => 'E', onLog }),
    actions: createReplyActions({ bridge, peerMouth: MOUTH_HOLDS, bodyEmojiOf: () => '🐶', labelOf: () => 'E', onLog }),
    router: createRouter({ getAgents: () => agents, getConfig: () => config, defaultBeing: 'egpt' }),
    gating: createGating({ getConfig: () => config, defaultKey: 'egpt' }),
    identity: { build: (m) => ({ ...m, line: m.body }) },
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now: () => 1 },
    log: { line: onLog },
  });
  spine.start();
  const quiet = () => notes.filter((s) => s.includes('nothing posted'));
  return { bridge, brain, quiet };
}

afterEach(() => { vi.useRealTimers(); });

describe('on mode, a non-human line — the train opens when the being starts working', () => {
  it('REPRODUCE: the first tool use opens the ⏳ train at that moment, before any text', async () => {
    const g = gate();
    const b = build({ work: async (onPartial) => { onPartial('', { tool: true }); await g.p; return { text: 'Listo, pagado.' }; } });
    const done = b.bridge.emit(msg('help me pay paypal', BEING));
    await until(() => b.bridge.streams.length);
    expect(b.bridge.streams.map((s) => s.init)).toEqual([THINKING]);
    expect(b.bridge.streams[0].opts).toMatchObject({ replyTo: expect.stringMatching(/^m\d+$/) });
    g.open();
    await done;
    expect(b.bridge.streams).toHaveLength(1);
    expect(b.bridge.streams[0].finals).toEqual(['Listo, pagado.']);
    expect(b.bridge.sent).toEqual([]);
  });

  it('REPRODUCE: ten seconds of work with no text and no tool opens the ⏳ train', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const g = gate();
    const b = build({ work: async () => { await g.p; return { text: 'Hecho' }; } });
    const done = b.bridge.emit(msg('alguien revisa esto?', BEING));
    await until(() => b.brain.calls.length);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(b.bridge.streams).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(b.bridge.streams.map((s) => s.init)).toEqual([THINKING]);
    g.open();
    await done;
    expect(b.bridge.streams[0].finals).toEqual(['Hecho']);
  });

  for (const line of ['e', 'mirá esto']) {
    it(`REPRODUCE (live 21:33): a human line ("${line}") steered into the ambient turn opens its train at once`, async () => {
      const g = gate();
      const b = build({ steers: true, work: async () => { await g.p; return { text: 'Abrí PayPal.' }; } });
      const done = b.bridge.emit(msg('help me pay paypal', BEING));
      await until(() => b.brain.calls.length);
      expect(b.bridge.streams).toEqual([]);
      await b.bridge.emit(msg(line));
      expect(b.brain.steered).toEqual([line]);
      expect(b.bridge.streams.map((s) => s.init)).toEqual([THINKING]);
      g.open();
      await done;
      expect(b.bridge.streams).toHaveLength(1);
      expect(b.bridge.streams[0].finals).toEqual(['Abrí PayPal.']);
    });
  }

  it('REPRODUCE: worked then stayed silent — the train resolves to ✓, as a non-ambient silence does', async () => {
    const b = build({ work: async (onPartial) => { onPartial('', { tool: true }); return { text: '…' }; } });
    await b.bridge.emit(msg('qué hora es allá?', BEING));
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([[THINKING, ['✓']]]);
    expect(b.bridge.sent).toEqual([]);
    expect(b.quiet()).toEqual([]);
  });

  for (const line of ['jajaja', 'e']) {
    it(`a non-human line ("${line}") steered in opens nothing, addressed or not`, async () => {
      const g = gate();
      const b = build({ steers: true, work: async () => { await g.p; return { text: '…' }; } });
      const done = b.bridge.emit(msg('jaja', BEING));
      await until(() => b.brain.calls.length);
      await b.bridge.emit(msg(line, BEING));
      expect(b.brain.steered).toEqual([line]);
      g.open();
      await done;
      expect(b.bridge.streams).toEqual([]);
      expect(b.quiet()).toHaveLength(1);
    });
  }

  it('a quick tool-free silence posts nothing, logs one line, and leaves no timer to open it later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const b = build({ work: async () => ({ text: '…' }) });
    await b.bridge.emit(msg('qué calor', BEING));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.bridge.streams).toEqual([]);
    expect(b.bridge.sent).toEqual([]);
    expect(b.quiet()).toHaveLength(1);
  });
});

describe('on mode, a human line — its ⏳ is up on arrival, addressed or not', () => {
  for (const body of ['help me pay paypal', '@e hola']) {
    it(`"${body}": one ⏳ before any text, tool or timer; a tool use and ten seconds open nothing more`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const g = gate();
      let atTurn = null;
      const b = build({ work: async (onPartial) => { atTurn = b.bridge.streams.map((s) => s.init); onPartial('Hola', undefined); onPartial('Hola', { tool: true }); await g.p; return { text: 'Hola' }; } });
      const done = b.bridge.emit(msg(body));
      await until(() => b.brain.calls.length);
      expect(atTurn).toEqual([THINKING]);
      await vi.advanceTimersByTimeAsync(10_000);
      g.open();
      await done;
      expect(b.bridge.streams).toHaveLength(1);
      expect(b.bridge.streams[0].init).toBe(THINKING);
      expect(b.bridge.streams[0].frames).toEqual(['Hola ⏳']);   // the tool signal is not text: no extra frame
      expect(b.bridge.streams[0].finals).toEqual(['Hola']);
    });
  }
});

describe('sender — begin()', () => {
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

  it('opens an ambient handle on the ⏳ placeholder; text and pulses follow into it', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e', replyTo: 'm1', ambient: true });
    out.activate();
    out.begin();
    expect(bridge.streams.map((s) => s.init)).toEqual([THINKING]);
    out.update('Hola');
    expect(out.pulse(15_000)).toBe(true);
    await out.finish({ text: 'Hola' });
    expect(bridge.streams).toHaveLength(1);
    expect(bridge.streams[0].frames[0]).toBe('Hola ⏳');
    expect(bridge.streams[0].frames).toHaveLength(2);
    expect(bridge.streams[0].finals).toEqual(['Hola']);
  });

  it('opens on the mouth that says the reply', async () => {
    const ear = fakeBridge(), mouth = fakeBridge();
    const out = createSender({ bridge: ear, peerMouth: { route: async () => ({ bridge: mouth, chatId: 'mouth-room', connection: 'rodz' }) } }).open('!c', { being: 'e', ambient: true });
    out.begin();
    await flush();
    expect(ear.streams).toEqual([]);
    expect(mouth.streams.map((s) => [s.chat, s.init])).toEqual([['mouth-room', THINKING]]);
  });

  it('is a no-op on an addressed handle, and once the turn has ended', async () => {
    const bridge = fakeBridge();
    const sender = createSender({ bridge });
    sender.open('!c', { being: 'e' }).begin();
    expect(bridge.streams).toHaveLength(1);
    const silent = sender.open('!c', { being: 'e', ambient: true });
    await silent.finish({ text: '…' }, { surface: false });
    silent.begin();
    expect(bridge.streams).toHaveLength(1);
  });
});

describe('warm-cli-session — a tool use reaches onUpdate as { tool: true }', () => {
  function fakeClaude(events) {
    return () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.kill = () => {};
      proc.stdin = { write: () => setImmediate(() => { for (const e of events) proc.stdout.emit('data', JSON.stringify(e) + '\n'); }), end: () => {} };
      return proc;
    };
  }
  const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  const toolUse = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'mcp__browser__navigate', input: { url: 'https://paypal.com' } }] } };

  it('REPRODUCE: the tool_use is reported before any text, carrying the text so far', async () => {
    const s = createWarmCliSession({ spawn: fakeClaude([
      { type: 'system', subtype: 'init', session_id: 's' }, toolUse,
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
      delta('Abrí'), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Abrí' }] } }, toolUse,
      { type: 'result', subtype: 'success', result: 'Abrí' },
    ]) });
    const calls = [];
    await s.turn('pay', (t, use) => calls.push([t, use]));
    s.close();
    expect(calls).toEqual([['', { tool: true }], ['Abrí', undefined], ['Abrí', { tool: true }]]);
  });

  it('verboseThinking: the signal carries the verbose text so far, never acc', async () => {
    const s = createWarmCliSession({ verboseThinking: true, spawn: fakeClaude([
      { type: 'system', subtype: 'init', session_id: 's' }, delta('Voy'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Voy' }] } }, toolUse,
      { type: 'result', subtype: 'success', result: 'Voy' },
    ]) });
    const calls = [];
    await s.turn('pay', (t, use) => calls.push([t, use]));
    s.close();
    expect(calls.at(-1)).toEqual(['Voy\n\nmcp__browser__navigate(https://paypal.com)', { tool: true }]);
  });

  it('a text-only turn never passes a second argument', async () => {
    const s = createWarmCliSession({ spawn: fakeClaude([
      { type: 'system', subtype: 'init', session_id: 's' }, delta('Hola'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hola' }] } },
      { type: 'result', subtype: 'success', result: 'Hola' },
    ]) });
    const calls = [];
    await s.turn('hi', (...a) => calls.push(a));
    s.close();
    expect(calls).toEqual([['Hola']]);
  });
});
