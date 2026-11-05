// The emoji thinking train (operator 2026-11-03, dispatch.thinking_train: emoji, the default): no ⏳
// bubble; a human line that starts or queues a turn gets 👾 at arrival, 🤔 when its turn starts, and the
// mark comes off when the turn ends, whatever the outcome. The reply posts whole at finish; a tool use or
// the first text that is not a polite silence takes the mark off and opens the bubble (2026-11-04). A '…' posts
// nothing unless the being was addressed directly. Steers keep ✍️/👍. `bubble` is the old behaviour.
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender, THINKING } from '../src/spine/sender.mjs';
import { createReplyActions } from '../src/spine/reply-actions.mjs';
import { createTurns } from '../src/spine/turns.mjs';
import { makePeerMouth, makeLimbAwareBridge } from '../src/spine/boot.mjs';
import { makeOutbound } from '../src/spine/sender.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';
import { LIVE_FRAME_MARK } from '../src/dispatch-line.mjs';

const MOUTH_HOLDS = { route: async () => null, mouthIsElsewhere: () => false };
const CHAT = { surface: 'whatsapp', node: 'wa', chatId: '!g', chatName: 'eGPT Admin', kind: 'text', raw: { chatType: 'group' }, senderId: 'u-1', senderName: 'An' };
let seq = 0;
const msg = (body, extra = {}) => ({ ...CHAT, body, msgId: `m${++seq}`, ts: 1, mention: { ...mentionStatus(body, ['e', 'egpt']), replyToBot: false }, ...extra });
const BEING = { fromMember: { id: 'claude', kind: 'brain' } };
const flush = () => new Promise((r) => setImmediate(r));
async function until(cond) { for (let i = 0; i < 50 && !cond(); i++) await flush(); }
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const E = '🐶';

// The spine's own timer seam: armed timers are recorded and fired on demand (the dwell, typing, the timeout).
function fakeTimers() {
  let n = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms = 0) => { const id = ++n; pending.set(id, { fn, ms }); return { id, unref() {} }; },
    clearTimeout: (t) => { if (t?.id != null) pending.delete(t.id); },
    fire() { const all = [...pending.values()]; pending.clear(); for (const { fn } of all) fn(); },
    size: () => pending.size,
  };
}

function fakeBridge() {
  let cb = null;
  const streams = [], events = [];
  return {
    streams, events,
    onMessage(fn) { cb = fn; }, emit(m) { return cb(m); }, stop() {},
    send(chat, text) { events.push(['send', chat, text]); return { ok: true }; },
    startStream(chat, init, opts) {
      events.push(['open', chat, init]);
      const h = { chat, init, opts, frames: [], finals: [], delivered: false, confirmedId: `${chat}#${streams.length + 1}`, update(t) { h.frames.push(t); events.push(['frame', chat, t]); }, async finish(t) { h.finals.push(t); h.delivered = true; events.push(['post', chat, t]); } };
      streams.push(h);
      return h;
    },
    react(chat, msgId, emoji) { events.push(['react', chat, msgId, emoji]); return true; },
    unreact(chat, msgId, emoji) { events.push(['unreact', chat, msgId, emoji]); return true; },
  };
}

// `train`: dispatch.thinking_train (unset = the default). '!t' replies into a tunnel, '!s' into a side group.
// `mouth(bridge)`: a peer mouth other than the holder itself (the default). `frames`: the train's frames, on `frameTimers`.
// `wren`: a second being, `w`, in mention mode; `work` gets the being as its third argument.
function build({ mode = 'on', train, work, turnTimeoutMs = 0, steers = false, now = () => 1, mouth = null, frames = null, wren = false } = {}) {
  const agents = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, mode }, ...(wren ? { wren: { configuration: 'wren', handles: ['w', 'wren'], mode: 'mention' } } : {}) };
  const config = { conversation_defaults: { allowed_users: ['u-1'] }, agents, ...(train ? { dispatch: { thinking_train: train } } : {}) };
  const bridge = fakeBridge();
  const peerMouth = mouth ? mouth(bridge) : MOUTH_HOLDS;   // mouth() => null: no mouth on this node
  const brain = {
    calls: [], steered: [],
    async turn(being, ev, onPartial) { brain.calls.push(ev.body); return work(onPartial, ev, being); },
    ...(steers ? { allowNewInput: async () => 'any', async steer(to, ev) { brain.steered.push(ev.body); return { ack: Promise.resolve({ ok: true }) }; } } : {}),
  };
  const transcript = { entries: [], async log(ev, r) { this.entries.push({ ev, reply: r }); } };
  const notes = [];
  const onLog = (s) => notes.push(s);
  const timers = fakeTimers(), frameTimers = fakeTimers();
  const sideGroupFor = async (ev) => (ev.chatId === '!t' ? { chatId: '!split', tunnel: true } : ev.chatId === '!s' ? '!side' : null);
  const spine = createSpine({
    bridge, brain, transcript, defaultBeing: 'egpt', peerMouth, turnTimeoutMs,
    sender: createSender({ bridge, peerMouth, bodyEmojiOf: () => E, labelOf: () => 'E', onLog, now }),
    actions: createReplyActions({ bridge, peerMouth, bodyEmojiOf: () => E, labelOf: () => 'E', onLog }),
    router: createRouter({ getAgents: () => agents, getConfig: () => config, defaultBeing: 'egpt' }),
    gating: createGating({ getConfig: () => config, defaultKey: 'egpt', sideGroupFor }),
    identity: { build: (m) => ({ ...m, line: m.body }) },
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, rng: () => 0.5,
    log: { line: onLog },
    ...(frames ? { turns: createTurns({ brain, bridge, peerMouth, log: { line: onLog }, thinkingFrames: () => frames, setTimeout: frameTimers.setTimeout, clearTimeout: frameTimers.clearTimeout }) } : {}),
  });
  spine.start();
  // The reactions on one message, in order: '+👾' placed, '-🤔' taken off.
  const marks = (id) => bridge.events.filter(([op, , msgId]) => (op === 'react' || op === 'unreact') && msgId === id).map(([op, , , e]) => `${op === 'react' ? '+' : '-'}${e}`);
  const reactions = () => bridge.events.filter(([op]) => op === 'react' || op === 'unreact');
  const posts = () => bridge.events.filter(([op]) => op === 'post' || op === 'send').map(([, chat, t]) => [chat, t]);
  const bubbles = () => bridge.streams.filter((s) => s.init === THINKING || String(s.init).includes(LIVE_FRAME_MARK) || s.frames.length);
  return { spine, bridge, brain, notes, timers, frameTimers, config, marks, reactions, posts, bubbles };
}
const answers = (text) => async () => ({ text });
const TRAIN = ['+👾', '+🤔', '-🤔'];
// The reaction left on the message after `seq`, one per account: a placement replaces the last.
const left = (seq) => seq.reduce((up, op) => (op[0] === '+' ? op.slice(1) : up === op.slice(1) ? null : up), null);

describe('emoji train (the default): 👾 at arrival → 🤔 when the turn starts → off at the end; no ⏳', () => {
  for (const [mode, body] of [['on', '@e hola'], ['on', 'qué calor hace hoy'], ['accum', '@e hola'], ['mention', '@e hola']]) {
    it(`REPRODUCE: ${mode}, "${body}"`, async () => {
      const g = gate();
      const b = build({ mode, work: async () => { await g.p; return { text: 'Hola, sí.' }; } });
      const m = msg(body);
      const done = b.bridge.emit(m);
      await until(() => b.brain.calls.length);
      await flush();
      expect(b.marks(m.msgId)).toEqual(['+👾', '+🤔']);
      expect(b.bridge.streams).toEqual([]);
      g.open();
      await done;
      await flush();
      expect(b.marks(m.msgId)).toEqual(TRAIN);
      expect(b.posts()).toEqual([['!g', 'Hola, sí.']]);
      expect(b.bubbles()).toEqual([]);
      // the reply is posted before the mark comes off
      const ops = b.bridge.events.map(([op, , x, e]) => (op === 'post' ? 'post' : `${op}${e ?? ''}`));
      expect(ops).toEqual(['react👾', 'react🤔', 'open', 'post', 'unreact🤔']);
    });
  }

  it('REPRODUCE: auto — 👾 at arrival, 🤔 when the dwell fires and the turn starts, off after the send', async () => {
    const g = gate();
    const b = build({ mode: 'auto', work: async () => { await g.p; return { text: 'dale' }; } });
    const m = msg('nos vemos mañana?');
    await b.bridge.emit(m);
    await flush();
    expect(b.marks(m.msgId)).toEqual(['+👾']);
    expect(b.brain.calls).toEqual([]);
    b.timers.fire();                                   // the dwell
    await until(() => b.brain.calls.length);
    await flush();
    expect(b.marks(m.msgId)).toEqual(['+👾', '+🤔']);
    g.open();
    for (let i = 0; i < 10 && !b.posts().length; i++) { await flush(); b.timers.fire(); }   // typing time
    await until(() => b.marks(m.msgId).length === 3);
    expect(b.posts()).toEqual([['!g', 'dale']]);
    expect(b.marks(m.msgId)).toEqual(TRAIN);
    expect(b.bubbles()).toEqual([]);
  });

  it('REPRODUCE: auto — every line of a burst gets 👾; one turn; all go 🤔 then off', async () => {
    const b = build({ mode: 'auto', work: answers('dale') });
    const [x, y] = [msg('hola'), msg('estás?')];
    await b.bridge.emit(x);
    await b.bridge.emit(y);
    await flush();
    expect([b.marks(x.msgId), b.marks(y.msgId)]).toEqual([['+👾'], ['+👾']]);
    for (let i = 0; i < 10 && !b.posts().length; i++) { b.timers.fire(); await until(() => b.brain.calls.length); await flush(); }
    await until(() => b.marks(y.msgId).length === 3);
    expect(b.brain.calls).toHaveLength(1);
    expect([b.marks(x.msgId), b.marks(y.msgId)]).toEqual([TRAIN, TRAIN]);
  });

  it('REPRODUCE: auto — a dwell dropped by a mode change takes its 👾 off', async () => {
    const b = build({ mode: 'auto', work: answers('dale') });
    const m = msg('hola');
    await b.bridge.emit(m);
    await flush();
    b.config.agents.egpt.mode = 'mention';
    b.timers.fire();
    await until(() => b.marks(m.msgId).length === 2);
    expect(b.brain.calls).toEqual([]);
    expect(b.marks(m.msgId)).toEqual(['+👾', '-👾']);
  });

  it('REPRODUCE: with no streamed text and no tool use, the ambient timer opens nothing; the reply posts whole', async () => {
    const g = gate();
    const b = build({ mode: 'on', work: async () => { await g.p; return { text: 'Listo.' }; } });
    const m = msg('@e revisá esto');
    const done = b.bridge.emit(m);
    await until(() => b.brain.calls.length);
    b.timers.fire();
    await flush();
    expect(b.bridge.streams).toEqual([]);
    g.open();
    await done;
    await flush();
    expect(b.posts()).toEqual([['!g', 'Listo.']]);
    expect(b.bubbles()).toEqual([]);
    expect(b.marks(m.msgId)).toEqual(TRAIN);
  });

  it('REPRODUCE: the liveness pulse edits nothing for an emoji turn', async () => {
    let t = 1;
    const g = gate();
    const b = build({ mode: 'on', now: () => t, work: async () => { await g.p; return { text: 'listo' }; } });
    const done = b.bridge.emit(msg('@e revisá esto'));
    await until(() => b.brain.calls.length);
    for (const step of [20_000, 60_000, 15 * 60_000]) { t += step; b.spine.tick(); await flush(); }
    expect(b.bridge.streams).toEqual([]);
    expect(b.bridge.events.filter(([op]) => op === 'send')).toEqual([]);
    g.open();
    await done;
    expect(b.posts()).toEqual([['!g', 'listo']]);
  });
});

// The first tool use, or the first text that is not a polite silence (operator 2026-11-04: "as soon as any
// text is outputted from model we show it"). The bubble opens as an ambient bubble turn's does, with the text
// so far; the 🤔 comes off; from then on it is a bubble turn.
describe('emoji train: the first text or tool use opens the bubble and takes the mark off', () => {
  const OFF_AT_ONCE = ['+👾', '-👾'];                   // a tool at once: off before the 🤔 lands, nothing placed after
  it('REPRODUCE: the first text opens the bubble with it, 🤔 off; a later tool use opens nothing more; pulses edit it, the reply lands in it', async () => {
    let t = 1;
    const text = gate(), tool = gate(), g = gate();
    const b = build({ mode: 'on', now: () => t, work: async (onPartial) => {
      await text.p;
      onPartial('Voy a mirar.');
      await tool.p;
      onPartial('Voy a mirar.', { tool: true });
      await g.p;
      onPartial('Voy a mirar.\nEs eso');
      return { text: 'Voy a mirar.\nEs eso, listo.' };
    } });
    const m = msg('@e revisá esto');
    const done = b.bridge.emit(m);
    await until(() => b.brain.calls.length);
    b.timers.fire();
    await flush();
    expect(b.bridge.streams).toEqual([]);
    expect(b.marks(m.msgId)).toEqual(['+👾', '+🤔']);
    text.open();
    await until(() => b.bridge.streams.length && b.marks(m.msgId).length === 3);
    expect(b.bridge.streams.map((s) => [s.chat, s.init])).toEqual([['!g', `Voy a mirar. ${LIVE_FRAME_MARK}`]]);
    expect(b.marks(m.msgId)).toEqual(TRAIN);
    tool.open();
    await flush(); await flush();
    expect(b.bridge.streams).toHaveLength(1);
    expect(b.marks(m.msgId)).toEqual(TRAIN);
    t += 20_000; b.spine.tick(); await flush();
    expect(b.bridge.streams[0].frames.at(-1)).toMatch(/^Voy a mirar\. ⏳ \S+ 20s$/);
    g.open();
    await done;
    await flush();
    expect(b.bridge.streams).toHaveLength(1);
    expect(b.bridge.streams[0].frames).toContain(`Voy a mirar.\nEs eso ${LIVE_FRAME_MARK}`);
    expect(b.posts()).toEqual([['!g', 'Voy a mirar.\nEs eso, listo.']]);
    expect(b.marks(m.msgId)).toEqual(TRAIN);
  });

  it("REPRODUCE: an unaddressed 'on' reply streamed as nothing but '…' never opens and posts nothing; the mark comes off", async () => {
    const said = gate();
    const b = build({ mode: 'on', work: async (onPartial) => { await said.p; onPartial(''); onPartial('…'); return { text: '…' }; } });
    const m = msg('qué calor hace hoy');
    const done = b.bridge.emit(m);
    await until(() => b.brain.calls.length);
    await flush();
    said.open();
    await done;
    await flush();
    expect(b.bridge.streams).toEqual([]);
    expect(b.posts()).toEqual([]);
    expect(b.marks(m.msgId)).toEqual(TRAIN);
  });

  for (const silence of [['…'], ['.', '..', '...']]) {
    it(`REPRODUCE: a stream that starts ${silence.map((s) => `'${s}'`).join(', ')} stays unshown, and opens once real text follows`, async () => {
      const start = gate(), more = gate(), g = gate();
      const real = `${silence.at(-1)} pues sí`;
      const b = build({ mode: 'on', work: async (onPartial) => {
        await start.p;
        for (const s of silence) onPartial(s);
        await more.p;
        onPartial(real);
        await g.p;
        return { text: `${real}, hace calor.` };
      } });
      const m = msg('qué calor hace hoy');
      const done = b.bridge.emit(m);
      await until(() => b.brain.calls.length);
      await flush();
      start.open();
      await flush(); await flush();
      expect(b.bridge.streams).toEqual([]);
      expect(b.marks(m.msgId)).toEqual(['+👾', '+🤔']);
      more.open();
      await until(() => b.bridge.streams.length && b.marks(m.msgId).length === 3);
      expect(b.bridge.streams.map((s) => s.init)).toEqual([`${real} ${LIVE_FRAME_MARK}`]);
      expect(b.marks(m.msgId)).toEqual(TRAIN);
      g.open();
      await done;
      await flush();
      expect(b.posts()).toEqual([['!g', `${real}, hace calor.`]]);
    });
  }

  it('REPRODUCE: a tool use before any text opens the ⏳ placeholder', async () => {
    const g = gate();
    const b = build({ mode: 'mention', work: async (onPartial) => { onPartial('', { tool: true }); await g.p; return { text: 'Listo.' }; } });
    const m = msg('@e revisá esto');
    const done = b.bridge.emit(m);
    await until(() => b.bridge.streams.length);
    expect(b.bridge.streams.map((s) => s.init)).toEqual([THINKING]);
    g.open();
    await done;
    await flush();
    expect(b.bridge.streams[0].finals).toEqual(['Listo.']);
    expect(b.posts()).toEqual([['!g', 'Listo.']]);
    expect(b.marks(m.msgId)).toEqual(OFF_AT_ONCE);
  });

  it('a second tool use opens nothing more and takes nothing off twice', async () => {
    const b = build({ mode: 'on', work: async (onPartial) => { onPartial('a', { tool: true }); onPartial('a b', { tool: true }); return { text: 'a b c' }; } });
    const m = msg('@e revisá esto');
    await b.bridge.emit(m);
    await flush();
    expect(b.bridge.streams).toHaveLength(1);
    expect(b.posts()).toEqual([['!g', 'a b c']]);
    expect(b.marks(m.msgId)).toEqual(OFF_AT_ONCE);
  });

  it("REPRODUCE: an unaddressed 'on' line that uses a tool opens too, then a '…' settles it as bubble's does", async () => {
    const b = build({ mode: 'on', work: async (onPartial) => { onPartial('', { tool: true }); return { text: '…' }; } });
    const m = msg('qué calor hace hoy');
    await b.bridge.emit(m);
    await flush();
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([[THINKING, ['✓']]]);
    expect(b.marks(m.msgId)).toEqual(OFF_AT_ONCE);
  });

  it('REPRODUCE: the thinking frames step until the bubble opens, then stop (2026-11-04)', async () => {
    const tool = gate(), g = gate();
    const b = build({ mode: 'on', frames: ['🤔', '🤓', '👀'], work: async (onPartial) => { await tool.p; onPartial('Mirando.', { tool: true }); await g.p; return { text: 'Mirando. Listo.' }; } });
    const m = msg('@e revisá esto');
    const done = b.bridge.emit(m);
    await until(() => b.brain.calls.length);
    await flush();
    b.frameTimers.fire(); await flush();
    b.frameTimers.fire(); await flush();
    expect(b.marks(m.msgId)).toEqual(['+👾', '+🤔', '+🤓', '+👀']);
    tool.open();
    await until(() => b.bridge.streams.length);
    await flush();
    expect(b.frameTimers.size()).toBe(0);
    g.open();
    await done;
    await flush();
    expect(b.marks(m.msgId)).toEqual(['+👾', '+🤔', '+🤓', '+👀', '-👀']);
    expect(b.posts()).toEqual([['!g', 'Mirando. Listo.']]);
  });

  it("REPRODUCE (lock): a bot's line and a tunnelled turn that use a tool still post nothing until the end", async () => {
    const tool = async (onPartial) => { onPartial('Mirando.'); onPartial('Mirando.', { tool: true }); onPartial('Mirando. Hecho'); return { text: 'Mirando. Hecho.' }; };
    const b = build({ mode: 'on', work: tool });
    await b.bridge.emit(msg('@e qué hora es allá?', BEING));
    await b.bridge.emit(msg('@e qué calor', { chatId: '!t' }));
    await flush();
    expect(b.brain.calls).toHaveLength(2);
    expect(b.bubbles()).toEqual([]);
    expect(b.posts()).toEqual([['!g', 'Mirando. Hecho.'], ['!split', 'Mirando. Hecho.']]);
    expect(b.reactions()).toEqual([]);
  });
});

describe('emoji train: polite silence', () => {
  it("REPRODUCE: an unaddressed 'on' line answered '…' posts nothing; the mark comes off", async () => {
    const b = build({ mode: 'on', work: answers('…') });
    const m = msg('qué calor hace hoy');
    await b.bridge.emit(m);
    await flush();
    expect(b.posts()).toEqual([]);
    expect(b.bridge.streams).toEqual([]);
    expect(b.marks(m.msgId)).toEqual(TRAIN);
  });

  for (const [mode, body, extra] of [['on', '@e hola'], ['on', 'e hola'], ['on', 'y eso?', { replyToBeing: 'egpt' }], ['mention', '@e hola'], ['accum', '@e hola']]) {
    it(`REPRODUCE: addressed (${mode}, "${body}"${extra ? ', a reply to its post' : ''}) — the '…' is posted as a message`, async () => {
      const b = build({ mode, work: answers('…') });
      const m = msg(body, extra);
      await b.bridge.emit(m);
      await flush();
      expect(b.posts()).toEqual([['!g', '…']]);
      expect(b.bubbles()).toEqual([]);
      expect(b.marks(m.msgId)).toEqual(TRAIN);
    });
  }

  it("auto: a '…' is the operator's silence — nothing is posted", async () => {
    const b = build({ mode: 'auto', work: answers('…') });
    const m = msg('@e hola');
    await b.bridge.emit(m);
    for (let i = 0; i < 10 && b.marks(m.msgId).length < 3; i++) { b.timers.fire(); await flush(); }
    expect(b.posts()).toEqual([]);
    expect(b.marks(m.msgId)).toEqual(TRAIN);
  });
});

describe('emoji train: queued and steered', () => {
  it('REPRODUCE: queued behind a running turn, 👾 is held until its own turn starts, then 🤔', async () => {
    const g = gate();
    const b = build({ mode: 'on', work: async (_, ev) => { if (ev.body === '@e uno') await g.p; return { text: `re ${ev.body}` }; } });
    const first = msg('@e uno');
    const one = b.bridge.emit(first);
    await until(() => b.brain.calls.length);
    const second = msg('@e dos');
    const two = b.bridge.emit(second);
    await flush(); await flush();
    expect(b.brain.calls).toEqual(['@e uno']);
    expect(b.marks(first.msgId)).toEqual(['+👾', '+🤔']);
    expect(b.marks(second.msgId)).toEqual(['+👾']);
    g.open();
    await Promise.all([one, two]);
    await flush();
    expect([b.marks(first.msgId), b.marks(second.msgId)]).toEqual([TRAIN, TRAIN]);
    expect(b.bubbles()).toEqual([]);
  });

  it('REPRODUCE: a line steered into the live turn gets ✍️ then 👍 — no 👾/🤔, and the live turn opens no ⏳', async () => {
    const g = gate();
    const b = build({ mode: 'on', steers: true, work: async () => { await g.p; return { text: 'Listo.' }; } });
    const first = msg('@e uno');
    const done = b.bridge.emit(first);
    await until(() => b.brain.calls.length);
    const steered = msg('@e y también esto');
    await b.bridge.emit(steered);
    await until(() => b.marks(steered.msgId).length === 2);
    expect(b.brain.steered).toEqual(['@e y también esto']);
    expect(b.marks(steered.msgId)).toEqual(['+✍️', '+👍']);
    expect(b.bridge.streams).toEqual([]);
    g.open();
    await done;
    await flush();
    expect(b.marks(first.msgId)).toEqual(TRAIN);
    expect(b.marks(steered.msgId)).toEqual(['+✍️', '+👍']);
    expect(b.posts()).toEqual([['!g', 'Listo.']]);
  });
});

// kg 2026-11-04, eGPT Admin #44699: E ('on', every line) and wren (addressed) each ran a train on the one line.
describe('emoji train: one per line, whichever beings answer it', () => {
  it('REPRODUCE: E and wren on one line — one train; it steps while either runs and comes off when the last ends', async () => {
    const eg = gate(), wg = gate();
    const b = build({ mode: 'on', wren: true, frames: ['🤔', '🤓'], work: async (_, ev, being) => { await (being === 'wren' ? wg.p : eg.p); return { text: being === 'wren' ? 'Sí.' : '…' }; } });
    const m = msg('w hola');
    const done = b.bridge.emit(m);
    await until(() => b.brain.calls.length === 2);
    await flush();
    expect(b.marks(m.msgId)).toEqual(['+👾', '+🤔']);
    eg.open();
    await flush(); await flush();
    b.frameTimers.fire(); await flush();
    expect(b.marks(m.msgId)).toEqual(['+👾', '+🤔', '+🤓']);
    wg.open();
    await done;
    await flush();
    expect(b.marks(m.msgId)).toEqual(['+👾', '+🤔', '+🤓', '-🤓']);
    expect(b.posts()).toEqual([['!g', 'Sí.']]);
  });

  it('REPRODUCE: one of them uses a tool — its bubble opens and the mark comes off once, for both', async () => {
    const tool = gate(), wg = gate();
    const b = build({ mode: 'on', wren: true, frames: ['🤔', '🤓'], work: async (onPartial, ev, being) => {
      if (being === 'wren') { await wg.p; return { text: 'Sí.' }; }
      await tool.p; onPartial('Mirando.', { tool: true }); return { text: 'Mirando. Listo.' };
    } });
    const m = msg('w hola');
    const done = b.bridge.emit(m);
    await until(() => b.brain.calls.length === 2);
    await flush();
    tool.open();
    await until(() => b.bridge.streams.length);
    await flush();
    expect(b.marks(m.msgId)).toEqual(['+👾', '+🤔', '-🤔']);
    expect(b.frameTimers.size()).toBe(0);
    wg.open();
    await done;
    await flush();
    expect(b.marks(m.msgId)).toEqual(['+👾', '+🤔', '-🤔']);
  });
});

// Each lock pairs the case with a human line in place in the same harness, which does get its train.
describe('emoji train: none', () => {
  it("REPRODUCE: a bot's line gets no train; a human's does", async () => {
    const b = build({ mode: 'on', work: answers('ok') });
    const bot = msg('@e qué hora es allá?', BEING);
    await b.bridge.emit(bot);
    expect(b.brain.calls).toHaveLength(1);
    expect(b.marks(bot.msgId)).toEqual([]);
    const m = msg('@e hola');
    await b.bridge.emit(m);
    await flush();
    expect(b.marks(m.msgId)).toEqual(TRAIN);
  });

  it('REPRODUCE: a tunnelled turn and a side-group reply put nothing in the origin; a reply in place does', async () => {
    const b = build({ mode: 'on', work: answers('Hace calor, sí.') });
    await b.bridge.emit(msg('@e qué calor', { chatId: '!t' }));
    await b.bridge.emit(msg('@e qué calor', { chatId: '!s' }));
    expect(b.brain.calls).toHaveLength(2);
    expect(b.posts().map(([chat]) => chat)).toEqual(['!split', '!side']);
    expect(b.reactions()).toEqual([]);
    const m = msg('@e qué calor');
    await b.bridge.emit(m);
    await flush();
    expect(b.marks(m.msgId)).toEqual(TRAIN);
  });

  it("REPRODUCE: a human's reaction runs its turn with no train (its msgId is the target's); a line does", async () => {
    const b = build({ mode: 'on', work: answers('…') });
    await b.bridge.emit(msg('[An reacted 👍 to #m0]', { kind: 'reaction', msgId: 'm0' }));
    expect(b.brain.calls).toHaveLength(1);
    expect(b.reactions()).toEqual([]);
    const m = msg('qué calor hace hoy');
    await b.bridge.emit(m);
    await flush();
    expect(b.marks(m.msgId)).toEqual(TRAIN);
  });

  for (const mode of ['mention', 'accum']) {
    it(`${mode}: a line that addresses nobody starts no turn and gets nothing`, async () => {
      const b = build({ mode, work: answers('…') });
      await b.bridge.emit(msg('qué calor hace hoy'));
      await flush();
      expect(b.brain.calls).toHaveLength(0);
      expect(b.reactions()).toEqual([]);
    });
  }
});

describe('emoji train: every end takes the mark off', () => {
  it('REPRODUCE: the turn throws', async () => {
    const g = gate();
    const b = build({ work: async () => { await g.p; throw new Error('engine down'); } });
    const m = msg('@e hola');
    const done = b.bridge.emit(m);
    await until(() => b.brain.calls.length);
    await flush();
    g.open();
    await done;
    await flush();
    expect(b.marks(m.msgId)).toEqual(TRAIN);
    expect(b.bubbles()).toEqual([]);
  });

  it('REPRODUCE: a turn that throws at once: whatever landed comes off, nothing is placed after', async () => {
    const b = build({ work: async () => { throw new Error('engine down'); } });
    const m = msg('@e hola');
    await b.bridge.emit(m);
    await flush();
    const seq = b.marks(m.msgId);
    expect(seq[0]).toBe('+👾');
    expect(seq.at(-1)).toMatch(/^-/);
    expect(left(seq)).toBeNull();
  });

  it('REPRODUCE: the turn times out', async () => {
    const b = build({ turnTimeoutMs: 20, work: () => new Promise(() => {}) });
    const m = msg('@e hola');
    const done = b.bridge.emit(m);
    await until(() => b.brain.calls.length);
    await flush();
    b.timers.fire();
    await done;
    await flush();
    expect(b.notes.some((s) => s.includes('TIMEOUT'))).toBe(true);
    expect(b.marks(m.msgId)).toEqual(TRAIN);
  });

  it('REPRODUCE: the turn is cancelled (the engine reports it failed)', async () => {
    const b = build({ work: async () => ({ text: 'interrupted', failed: true, failReason: 'interrupted' }) });
    const m = msg('@e hola');
    await b.bridge.emit(m);
    await flush();
    expect(b.marks(m.msgId)).toEqual(TRAIN);
  });

  it("REPRODUCE: the 👾 lands on the holder at arrival; the mouth's copy still awaited holds neither the turn nor the next one (2026-11-04)", async () => {
    const copy = gate();
    const asked = [], placed = [];
    const mouth = (bridge) => ({
      route: async () => ({ connection: 'secondary', bridge, chatId: '!g' }), mouthIsElsewhere: () => true,
      async quote(chat, { wait } = {}) { if (!wait) return { ok: false, reason: 'no-match' }; asked.push(wait); await copy.p; return { ok: true, msgId: 'x' }; },   // the reply's own quote asks no wait
      async react(chat, { emoji, remove }) { placed.push(`${remove ? '-' : '+'}${emoji}`); return { ok: true, chatId: '!g' }; },
    });
    const b = build({ work: async (_, ev) => ({ text: `re ${ev.body}` }), mouth });
    const [one, two] = [msg('@e uno'), msg('@e dos')];
    await b.bridge.emit(one);
    await b.bridge.emit(two);
    await flush();
    expect(b.posts()).toEqual([['!g', 're @e uno'], ['!g', 're @e dos']]);
    expect([b.marks(one.msgId), b.marks(two.msgId)]).toEqual([TRAIN, TRAIN]);
    expect(asked).toEqual([6000, 6000]);
    copy.open();
    await flush(); await flush();
    expect(placed).toEqual([]);                          // both ended before the copy: nothing moves
  });

  it("REPRODUCE: the mark is off before the turn's limbs run (one reaction per account per message)", async () => {
    const m = msg('@e reaccioná');
    const b = build({ work: async () => ({ text: `/react #${m.msgId} 👍` }) });
    await b.bridge.emit(m);
    await flush();
    expect(b.marks(m.msgId)).toEqual([...TRAIN, '+👍']);
  });
});

describe('dispatch.thinking_train: bubble — today exactly', () => {
  it('REPRODUCE (lock): an addressed line opens ⏳ and gets no mark; an unaddressed one gets dd2c11b7\'s ✍️', async () => {
    const b = build({ mode: 'on', train: 'bubble', work: answers('Hola.') });
    const addressed = msg('@e hola');
    await b.bridge.emit(addressed);
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([[THINKING, ['Hola.']]]);
    expect(b.marks(addressed.msgId)).toEqual([]);
    const m = msg('qué calor hace hoy');
    await b.bridge.emit(m);
    await flush();
    expect(b.marks(m.msgId)).toEqual(['+✍️', '-✍️']);
  });

  it('REPRODUCE: read live — the next line follows the flag as it stands', async () => {
    const b = build({ mode: 'on', train: 'bubble', work: answers('Hola.') });
    await b.bridge.emit(msg('@e hola'));
    expect(b.bridge.streams.map((s) => s.init)).toEqual([THINKING]);
    b.config.dispatch.thinking_train = 'emoji';
    const m = msg('@e hola otra vez');
    await b.bridge.emit(m);
    await flush();
    expect(b.bridge.streams.map((s) => s.init)).toEqual([THINKING, 'Hola.']);
    expect(b.marks(m.msgId)).toEqual(TRAIN);
  });
});

describe('gating.decide — emoji, addressed', () => {
  const gating = (mode, dispatch) => createGating({ getConfig: () => ({ agents: { egpt: { mode } }, ...(dispatch ? { dispatch } : {}) }) });
  const ev = { surface: 'whatsapp', chatId: '!g', body: 'hola', msgId: 'm1' };
  const reacts = () => Promise.resolve(true);
  it('emoji by default where the chat can be marked, absent under bubble; `addressed` only for a human line that addresses the being', async () => {
    expect((await gating('on').decide('egpt', ev, {}, { reacts })).emoji).toBe(true);
    expect((await gating('on', { thinking_train: 'bubble' }).decide('egpt', ev, { atEAnywhere: true }, { reacts }))).toEqual({ mode: 'on', receives: true, mayReply: true });
    expect((await gating('on').decide('egpt', ev, { atEAnywhere: true }, { reacts })).addressed).toBe(true);
    expect((await gating('on').decide('egpt', ev, { replyToBot: true }, { reacts })).addressed).toBe(true);
    expect((await gating('on').decide('egpt', ev, {}, { reacts })).addressed).toBeUndefined();
    expect((await gating('on').decide('egpt', ev, { atEAnywhere: true }, { bot: true, reacts })).addressed).toBeUndefined();
    expect((await gating('on').decide('egpt', { ...ev, msgId: undefined }, { replyToBot: true }, { reacts })).addressed).toBeUndefined();   // a wake: no line
  });
  it("REPRODUCE: no mark possible here (or no answer) — bubble's decision, exactly; asked only when a reply may follow", async () => {
    const asked = [];
    const no = () => { asked.push('no'); return Promise.resolve(false); };
    const BUBBLE = { mode: 'on', receives: true, mayReply: true };
    expect(await gating('on').decide('egpt', ev, { atEAnywhere: true }, { reacts: no })).toEqual(BUBBLE);
    expect(await gating('on').decide('egpt', ev, { atEAnywhere: true })).toEqual(BUBBLE);
    expect(await gating('on').decide('egpt', ev, { atEAnywhere: true }, { reacts: () => Promise.reject(new Error('x')) })).toEqual(BUBBLE);
    await gating('mention').decide('egpt', ev, {}, { reacts: no });                          // no turn: not asked
    await gating('on', { thinking_train: 'bubble' }).decide('egpt', ev, {}, { reacts: no });  // bubble: not asked
    expect(asked).toEqual(['no']);
  });
  it("surfaces: an addressed '…' surfaces with the emoji train, except in auto and a tunnel", async () => {
    const g = gating('on');
    expect(g.surfaces({ mode: 'on', mayReply: true, emoji: true, addressed: true }, '…')).toBe(true);
    expect(g.surfaces({ mode: 'on', mayReply: true, emoji: true }, '…')).toBe(false);
    expect(g.surfaces({ mode: 'on', mayReply: true, addressed: true }, '…')).toBe(false);
    expect(g.surfaces({ mode: 'auto', mayReply: true, emoji: true, addressed: true }, '…')).toBe(false);
    expect(g.surfaces({ mode: 'on', mayReply: true, emoji: true, addressed: true, quiet: true, tunnel: true }, '…')).toBe(false);
  });
});

// ── WHERE NO MARK CAN GO, THE TURN IS BUBBLE'S (operator 2026-11-03) ────────────────────────────────
describe('emoji train only where the chat can be marked; elsewhere bubble, for that turn', () => {
  it('REPRODUCE: a single-account node (no mouth) — the ⏳ opens, no reaction', async () => {
    const b = build({ mode: 'on', mouth: () => null, work: answers('Hola.') });
    await b.bridge.emit(msg('@e hola'));
    await flush();
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([[THINKING, ['Hola.']]]);
    expect(b.reactions()).toEqual([]);
  });

  it("REPRODUCE: a chat the mouth is not in — the ⏳ opens, no reaction; an unaddressed 'on' line keeps the quiet rule", async () => {
    const b = build({ mode: 'on', mouth: () => ({ route: async () => null, mouthIsElsewhere: () => true }), work: answers('…') });
    await b.bridge.emit(msg('@e hola'));
    await flush();
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([[THINKING, ['✓']]]);
    await b.bridge.emit(msg('qué calor hace hoy'));
    await flush();
    expect(b.bridge.streams).toHaveLength(1);
    expect(b.reactions()).toEqual([]);
  });
});

// The per-chat answer itself: makeOutbound canMark over boot's facade and the real peer mouth.
describe('canMark — can this chat carry a temporary mark', () => {
  const port = (name, extra = {}) => ({ name, async react() { return true; }, async unreact() { return true; }, async send() { return { ok: true }; }, ...extra });
  const TG = port('telegram', { owns: (c) => String(c).startsWith('tg:'), beingAccount: true });
  const HTTP = port('http', { owns: (c) => String(c).startsWith('http:') });
  const SHELL = { owns: (c) => c === 'lobby', async send() { return { ok: true }; } };

  it("REPRODUCE: an HTTP chat on a node that also has the Telegram bot — false; the bot's own chat — true", async () => {
    const facade = makeLimbAwareBridge(makeLimbAwareBridge(TG, HTTP), SHELL);   // a beeperless node, shell-aware
    const out = makeOutbound({ bridge: facade });
    expect(out('egpt', 'http:contoso-1').reacts()).toBe(false);
    expect(await out('egpt', 'http:contoso-1').canMark()).toBe(false);
    expect(await out('egpt', 'tg:42').canMark()).toBe(true);
    expect(await out('egpt', 'lobby').canMark()).toBe(false);
  });

  it('REPRODUCE: the console and the chatbox on a node with a mouth — false; the bot and a Beeper chat the mouth holds — true', async () => {
    const facade = makeLimbAwareBridge(makeLimbAwareBridge(port('beeper'), TG, HTTP), SHELL);
    const out = makeOutbound({ bridge: facade, peerMouth: MOUTH_HOLDS });
    expect(await out('egpt', 'lobby').canMark()).toBe(false);
    expect(await out('egpt', 'http:contoso-1').canMark()).toBe(false);
    expect(await out('egpt', 'tg:42').canMark()).toBe(true);
    expect(await out('egpt', '!room:beeper.local').canMark()).toBe(true);
  });

  it('no mouth: a Beeper chat — false', async () => {
    expect(await makeOutbound({ bridge: makeLimbAwareBridge(port('beeper'), TG) })('egpt', '!room:beeper.local').canMark()).toBe(false);
  });

  it("REPRODUCE: the real local mouth — true in a chat it is in, false in one it is not (route's own roster read)", async () => {
    const AN = '+15550000001', RODZ = '+15550000002', M1 = '+15551110001', M2 = '+15551110002';
    const raw = { id: '!g:beeper.local', type: 'group', participants: { items: [{ id: 'self', isSelf: true }, { id: 'rodz', phoneNumber: RODZ }, { id: 'm1', phoneNumber: M1 }, { id: 'm2', phoneNumber: M2 }] } };
    const mouthSide = { id: '!m:beeper.local', type: 'group', participants: { items: [{ id: 'self', isSelf: true }, { id: 'an', phoneNumber: AN }, { id: 'm1', phoneNumber: M1 }, { id: 'm2', phoneNumber: M2 }] } };
    const mouthBridge = { ...port('secondary'), async selfIdentities() { return [RODZ]; }, async listChatsRaw() { return [mouthSide]; } };
    const node = (member) => {
      const ear = { ...port('primary'), async selfIdentities() { return [AN]; }, async chatHasParticipant(_c, id) { return member && id === RODZ; }, async chatRaw() { return raw; } };
      const peerMouth = makePeerMouth({ peer: null, bridge: ear, localMouth: () => ({ name: 'secondary', home: 'primary', bridge: mouthBridge }) });
      return makeOutbound({ bridge: ear, peerMouth })('egpt', 'g');
    };
    expect(await node(true).canMark()).toBe(true);
    expect(await node(false).canMark()).toBe(false);
  });
});
// The copy that lands late, and the handover to the mouth: tests/emoji-train-handover.test.mjs.
