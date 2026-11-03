// On mode, a human line that does not address the being runs a quiet turn (848a763a), which opens no ⏳:
// the human saw no sign the line was received (operator 2026-11-03: "we agreed to react as soon as sent.
// then reaction is removed. polite silence then can be kept, or the response"). The bridge's ✍️ goes on
// the line at arrival and comes off when the turn ends, whatever its outcome. Not on an addressed line
// (its ⏳ is the receipt), a bot's line, a tunnelled or side-group reply, or a reaction.
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender, THINKING } from '../src/spine/sender.mjs';
import { createReplyActions } from '../src/spine/reply-actions.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const MOUTH_HOLDS = { route: async () => null, mouthIsElsewhere: () => false };
const CHAT = { surface: 'whatsapp', node: 'wa', chatId: '!g', chatName: 'eGPT Admin', kind: 'text', raw: { chatType: 'group' }, senderId: 'u-1', senderName: 'An' };
let seq = 0;
const msg = (body, extra = {}) => ({ ...CHAT, body, msgId: `m${++seq}`, ts: 1, mention: { ...mentionStatus(body, ['e', 'egpt']), replyToBot: false }, ...extra });
const BEING = { fromMember: { id: 'claude', kind: 'brain' } };
const flush = () => new Promise((r) => setImmediate(r));
async function until(cond) { for (let i = 0; i < 50 && !cond(); i++) await flush(); }
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const E = '🐶';

function fakeBridge({ reactThrows = false } = {}) {
  let cb = null;
  const streams = [], events = [];
  return {
    streams, events,
    onMessage(fn) { cb = fn; }, emit(m) { return cb(m); }, stop() {},
    send(chat, text) { events.push(['send', chat, text]); return { ok: true }; },
    startStream(chat, init, opts) {
      const h = { chat, init, opts, frames: [], finals: [], delivered: false, confirmedId: `${chat}#${streams.length + 1}`, update(t) { h.frames.push(t); }, async finish(t) { h.finals.push(t); h.delivered = true; events.push(['post', chat, t]); } };
      streams.push(h);
      return h;
    },
    react(chat, msgId, emoji) { if (reactThrows && emoji === '✍️') throw new Error('react refused'); events.push(['react', chat, msgId, emoji]); return true; },
    unreact(chat, msgId, emoji) { events.push(['unreact', chat, msgId, emoji]); return true; },
  };
}

// `sideGroupFor`: the chats whose reply goes elsewhere ('!t' the tunnel, '!s' a side group).
function build({ mode = 'on', work, reactThrows = false, turnTimeoutMs = 0 } = {}) {
  const agents = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, mode } };
  const config = { conversation_defaults: { allowed_users: ['u-1'] }, agents };
  const bridge = fakeBridge({ reactThrows });
  const brain = { calls: [], async turn(being, ev, onPartial) { brain.calls.push(ev.body); return work(onPartial, ev); } };
  const transcript = { entries: [], async log(ev, r) { this.entries.push({ ev, reply: r }); } };
  const notes = [];
  const onLog = (s) => notes.push(s);
  const sideGroupFor = async (ev) => (ev.chatId === '!t' ? { chatId: '!split', tunnel: true } : ev.chatId === '!s' ? '!side' : null);
  const spine = createSpine({
    bridge, brain, transcript, defaultBeing: 'egpt', peerMouth: MOUTH_HOLDS, turnTimeoutMs,
    sender: createSender({ bridge, bodyEmojiOf: () => E, labelOf: () => 'E', onLog }),
    actions: createReplyActions({ bridge, peerMouth: MOUTH_HOLDS, bodyEmojiOf: () => E, labelOf: () => 'E', onLog }),
    router: createRouter({ getAgents: () => agents, getConfig: () => config, defaultBeing: 'egpt' }),
    gating: createGating({ getConfig: () => config, defaultKey: 'egpt', sideGroupFor }),
    identity: { build: (m) => ({ ...m, line: m.body }) },
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now: () => 1 },
    log: { line: onLog },
  });
  spine.start();
  const marks = () => bridge.events.filter(([op, , , emoji]) => (op === 'react' || op === 'unreact') && emoji === '✍️');
  return { bridge, brain, notes, marks };
}
const answers = (text) => async () => ({ text });
const ON = (id, chat = '!g') => ['react', chat, id, '✍️'];
const OFF = (id, chat = '!g') => ['unreact', chat, id, '✍️'];

describe('on mode, an unaddressed human line — ✍️ while its quiet turn runs', () => {
  it("REPRODUCE: ✍️ at arrival, off when the turn ends in '…'", async () => {
    const g = gate();
    const b = build({ work: async () => { await g.p; return { text: '…' }; } });
    const m = msg('qué calor hace hoy');
    const done = b.bridge.emit(m);
    await until(() => b.brain.calls.length);
    await flush();
    expect(b.marks()).toEqual([ON(m.msgId)]);
    g.open();
    await done;
    await flush();
    expect(b.bridge.events).toEqual([ON(m.msgId), OFF(m.msgId)]);
  });

  it('REPRODUCE: ✍️ at arrival, off once the reply is posted', async () => {
    const b = build({ work: answers('Hace calor, sí.') });
    const m = msg('qué calor hace hoy');
    await b.bridge.emit(m);
    await flush();
    expect(b.bridge.events).toEqual([ON(m.msgId), ['post', '!g', 'Hace calor, sí.'], OFF(m.msgId)]);
  });

  it('REPRODUCE: off when the turn throws', async () => {
    const b = build({ work: async () => { throw new Error('engine down'); } });
    const m = msg('qué calor hace hoy');
    await b.bridge.emit(m);
    await flush();
    expect(b.marks()).toEqual([ON(m.msgId), OFF(m.msgId)]);
  });

  it('REPRODUCE: off when the turn times out', async () => {
    const b = build({ turnTimeoutMs: 20, work: () => new Promise(() => {}) });
    const m = msg('qué calor hace hoy');
    await b.bridge.emit(m);
    await flush();
    expect(b.notes.some((s) => s.includes('TIMEOUT'))).toBe(true);
    expect(b.marks()).toEqual([ON(m.msgId), OFF(m.msgId)]);
  });

  it('REPRODUCE: queued behind a running turn, ✍️ at arrival, before its own turn starts', async () => {
    const g = gate();
    const b = build({ work: async (_, ev) => { if (ev.body === '@e uno') await g.p; return { text: '…' }; } });
    const first = b.bridge.emit(msg('@e uno'));
    await until(() => b.brain.calls.length);
    const m = msg('qué calor hace hoy');
    const second = b.bridge.emit(m);
    await flush();
    expect(b.brain.calls).toEqual(['@e uno']);
    expect(b.marks()).toEqual([ON(m.msgId)]);
    g.open();
    await Promise.all([first, second]);
    await flush();
    expect(b.marks()).toEqual([ON(m.msgId), OFF(m.msgId)]);
  });

  it("REPRODUCE: the ✍️ is off before the turn's limbs run (a Telegram bot holds one reaction per message)", async () => {
    const m = msg('qué calor hace hoy');
    const b = build({ work: async () => ({ text: `/react #${m.msgId} 👍` }) });
    await b.bridge.emit(m);
    await flush();
    expect(b.bridge.events.filter(([op]) => op === 'react' || op === 'unreact')).toEqual([ON(m.msgId), OFF(m.msgId), ['react', '!g', m.msgId, '👍']]);
  });

  it('REPRODUCE: a failed placement does not break the turn; nothing is taken off', async () => {
    const b = build({ reactThrows: true, work: answers('Hace calor, sí.') });
    const m = msg('qué calor hace hoy');
    await b.bridge.emit(m);
    await flush();
    expect(b.brain.calls).toHaveLength(1);
    expect(b.bridge.events).toEqual([['post', '!g', 'Hace calor, sí.']]);
    expect(b.notes.filter((s) => s.startsWith('arrival-ack'))).toEqual(['arrival-ack egpt/!g: react refused']);
  });
});

// Each lock pairs the case with an unaddressed human line in the same harness, which does get its ✍️.
describe('no ✍️', () => {
  it('REPRODUCE: an addressed line opens its ⏳ and gets no ✍️; an unaddressed one does', async () => {
    const b = build({ work: answers('…') });
    await b.bridge.emit(msg('@e hola'));
    expect(b.bridge.streams.map((s) => [s.init, s.finals])).toEqual([[THINKING, ['✓']]]);
    const m = msg('qué calor hace hoy');
    await b.bridge.emit(m);
    await flush();
    expect(b.marks()).toEqual([ON(m.msgId), OFF(m.msgId)]);
  });

  it("REPRODUCE: a bot's line gets no ✍️; a human's does", async () => {
    const b = build({ work: answers('…') });
    await b.bridge.emit(msg('qué hora es allá?', BEING));
    expect(b.brain.calls).toHaveLength(1);
    const m = msg('qué calor hace hoy');
    await b.bridge.emit(m);
    await flush();
    expect(b.marks()).toEqual([ON(m.msgId), OFF(m.msgId)]);
  });

  it('REPRODUCE: a tunnelled turn and a side-group reply put no ✍️ in the origin; a reply in place does', async () => {
    const b = build({ work: answers('Hace calor, sí.') });
    await b.bridge.emit(msg('qué calor hace hoy', { chatId: '!t' }));
    await b.bridge.emit(msg('qué calor hace hoy', { chatId: '!s' }));
    expect(b.brain.calls).toHaveLength(2);
    expect(b.bridge.events.filter(([op]) => op === 'post').map(([, chat]) => chat)).toEqual(['!split', '!side']);
    const m = msg('qué calor hace hoy');
    await b.bridge.emit(m);
    await flush();
    expect(b.marks()).toEqual([ON(m.msgId), OFF(m.msgId)]);
  });

  it("REPRODUCE: a human's reaction runs its quiet turn with no ✍️ (its msgId is the target's); a line does", async () => {
    const b = build({ work: answers('…') });
    await b.bridge.emit(msg('[An reacted 👍 to #m0]', { kind: 'reaction', msgId: 'm0' }));
    expect(b.brain.calls).toHaveLength(1);
    const m = msg('qué calor hace hoy');
    await b.bridge.emit(m);
    await flush();
    expect(b.marks()).toEqual([ON(m.msgId), OFF(m.msgId)]);
  });

  it('mention mode: an unaddressed line runs no turn and gets no ✍️', async () => {
    const b = build({ mode: 'mention', work: answers('…') });
    await b.bridge.emit(msg('qué calor hace hoy'));
    await flush();
    expect(b.brain.calls).toHaveLength(0);
    expect(b.marks()).toEqual([]);
  });
});

describe('gating.decide — unaddressed', () => {
  const gating = (mode) => createGating({ getConfig: () => ({ agents: { egpt: { mode } } }) });
  const ev = { surface: 'whatsapp', chatId: '!g', body: 'hola' };
  it("set only for a human's unaddressed 'on' line", async () => {
    expect((await gating('on').decide('egpt', ev, {})).unaddressed).toBe(true);
    expect((await gating('on').decide('egpt', ev, { atEAnywhere: true })).unaddressed).toBeUndefined();
    expect((await gating('on').decide('egpt', ev, {}, { bot: true })).unaddressed).toBeUndefined();
    for (const mode of ['auto', 'mention', 'accum']) expect((await gating(mode).decide('egpt', ev, {})).unaddressed).toBeUndefined();
  });
});
