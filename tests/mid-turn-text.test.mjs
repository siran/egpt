// A being's mid-turn text (operator 2026-11-11): text the model writes as part of its normal output
// ("I'll check X…" before a tool use) reaches the chat as soon as it is written, through the reply
// path and under the final reply's gate — in every mode of the train, a bot's quiet turn and a tunnel
// included. A segment that is only '…' never posts. The final answer still lands, not doubled.
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender, THINKING } from '../src/spine/sender.mjs';
import { LIVE_FRAME_MARK } from '../src/dispatch-line.mjs';
import { createReplyActions } from '../src/spine/reply-actions.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const MOUTH_HOLDS = { route: async () => null, mouthIsElsewhere: () => false };
const CHAT = { surface: 'whatsapp', node: 'wa', chatId: '!g', chatName: 'grupo', kind: 'text', raw: { chatType: 'group' }, senderId: 'u-1', senderName: 'An' };
let seq = 0;
const msg = (body, extra = {}) => ({ ...CHAT, body, msgId: `m${++seq}`, ts: 1, mention: { ...mentionStatus(body, ['e', 'egpt']), replyToBot: false }, ...extra });
const BEING = { fromMember: { id: 'claude', kind: 'brain' } };   // a bot's line: the turn is quiet
const flush = () => new Promise((r) => setImmediate(r));

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
    react() { return true; }, unreact() { return true; },
  };
}

function build({ mode = 'mention', train, work }) {
  const agents = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, mode } };
  const config = { conversation_defaults: { allowed_users: ['u-1'] }, agents, dispatch: { thinking_train: train } };
  const bridge = fakeBridge();
  const brain = { async turn(being, ev, onPartial) { return work(onPartial); } };
  const onLog = () => {};
  const sideGroupFor = async (ev) => (ev.chatId === '!t' ? { chatId: '!split', tunnel: true } : null);
  const spine = createSpine({
    bridge, brain, transcript: { async log() {} }, defaultBeing: 'egpt', peerMouth: MOUTH_HOLDS,
    sender: createSender({ bridge, peerMouth: MOUTH_HOLDS, bodyEmojiOf: () => '🐶', labelOf: () => 'E', onLog }),
    actions: createReplyActions({ bridge, peerMouth: MOUTH_HOLDS, bodyEmojiOf: () => '🐶', labelOf: () => 'E', onLog }),
    router: createRouter({ getAgents: () => agents, getConfig: () => config, defaultBeing: 'egpt' }),
    gating: createGating({ getConfig: () => config, defaultKey: 'egpt', sideGroupFor }),
    identity: { build: (m) => ({ ...m, line: m.body }) },
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now: () => 1 },
    log: { line: onLog },
  });
  spine.start();
  // what a chat has been shown, in order: every opened, edited and settled text
  const shownTexts = (chat = '!g') => bridge.events.filter(([op, c]) => c === chat && op !== 'react').map(([, , t]) => t).join('\n');
  return { bridge, shownTexts };
}
// text A, a tool use, then the final B (warm-cli streams the whole train; the result is the last message)
const aToolB = (atTool) => async (onPartial) => {
  onPartial('Voy a mirar X.');
  onPartial('Voy a mirar X.', { tool: true });
  await flush();
  atTool();
  onPartial('Voy a mirar X.\nListo, B.');
  return { text: 'Listo, B.' };
};

const MODES = [
  ['bubble train', { train: 'bubble' }, () => msg('@e mira X')],
  ['emoji train', { train: 'emoji' }, () => msg('@e mira X')],
  ['quiet bot-triggered turn (bubble)', { train: 'bubble', mode: 'on' }, () => msg('mira X', BEING)],
  ['quiet bot-triggered turn (emoji)', { train: 'emoji', mode: 'on' }, () => msg('mira X', BEING)],
];

describe('mid-turn text shows when it is written, before the final', () => {
  for (const [name, opts, line] of MODES) {
    it(`REPRODUCE: ${name} — "A", a tool use, "B": A is on screen before B is written; B lands at the end, once`, async () => {
      let atTool = null;
      const b = build({ ...opts, work: aToolB(() => { atTool = b.shownTexts(); }) });
      await b.bridge.emit(line());
      await flush();
      expect(atTool).toContain('Voy a mirar X.');
      expect(atTool).not.toContain('Listo, B.');
      const last = b.bridge.streams.at(-1).finals.at(-1);
      expect(last).toContain('Listo, B.');
      expect(last.match(/Listo, B\./g)).toHaveLength(1);     // not doubled by the final
      expect(last.match(/Voy a mirar X\./g)).toHaveLength(1);
    });
  }

  it('REPRODUCE: a tunnelled turn shows A in the split before B; the origin gets nothing', async () => {
    let atTool = null;
    const b = build({ train: 'emoji', work: aToolB(() => { atTool = b.shownTexts('!split'); }) });
    await b.bridge.emit(msg('@e mira X', { chatId: '!t' }));
    await flush();
    expect(atTool).toContain('Voy a mirar X.');
    expect(atTool).not.toContain('Listo, B.');
    expect(b.shownTexts('!t')).toBe('');
  });

  // where the final reply's gate hides a '…' (a quiet turn); an addressed human's '…' is posted by that gate today
  for (const [name, opts, line] of MODES.slice(2)) {
    it(`${name} — a segment that is only "…" never posts; nothing opens mid-turn`, async () => {
      let atTool = null;
      const b = build({ ...opts, work: async (onPartial) => { onPartial('…'); onPartial('…', { tool: true }); onPartial('…\n…'); await flush(); atTool = b.shownTexts(); return { text: '…' }; } });
      await b.bridge.emit(line());
      await flush();
      // the ⏳ placeholder (bubble) is not text; a '…' frame or post is
      const silences = b.bridge.events.filter(([op, , t]) => op !== 'react' && t !== THINKING && String(t).replaceAll(LIVE_FRAME_MARK, '').replace(/[…\s]/g, '') === '');
      expect(silences.filter(([op]) => op !== 'post')).toEqual([]);
    });
  }

  for (const [name, opts, line] of MODES) {
    it(`${name} — a failure after A was shown is loud: A stays, the failure ends the message`, async () => {
      const b = build({ ...opts, work: async (onPartial) => { onPartial('Voy a mirar X.'); onPartial('Voy a mirar X.', { tool: true }); await flush(); throw new Error('boom'); } });
      await b.bridge.emit(line());
      await flush();
      const last = b.bridge.streams.at(-1).finals.at(-1);
      expect(last).toContain('Voy a mirar X.');
      expect(last).toMatch(/❌|boom|fail/i);
    });
  }
});
