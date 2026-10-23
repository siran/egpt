// mode mute = log only (operator 2026-10-16): "not even allowed users wake it; eGPT only logs and saves
// files per conversation." A muted being's chat is RECORDED like any non-off mode, and it runs NO turn:
// no reply, no send_to_egpt context turn, not even when called by handle. 'off' is unchanged (nothing
// recorded). Media is saved by the bridge before the spine (media.save reads no mode), so the record
// is the spine's whole share of "saves files".
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const OP = '+16468217865';
const CHAT = { surface: 'whatsapp', chatId: '!g', chatName: 'grupo', kind: 'text', raw: { chatType: 'group' }, senderId: OP, senderName: 'An' };
const msg = (body, extra = {}) => ({
  ...CHAT, body, msgId: `m-${Math.random()}`, ts: 1,
  mention: { ...mentionStatus(body, ['e', 'egpt']), replyToBot: extra.replyToBeing != null },
  ...extra,
});

function build({ eMode = 'mute', wrenMode, dispatch = {}, state = null } = {}) {
  const agents = {
    egpt: { configuration: 'egpt', handles: ['e', 'egpt'], mode: eMode, conversation_defaults: { allowed_users: [OP] } },
    wren: { configuration: 'egpt', handles: ['wren'], ...(wrenMode ? { mode: wrenMode } : {}) },
  };
  let cb = null;
  const bridge = { onMessage(fn) { cb = fn; }, send() {}, emit(m) { return cb(m); }, stop() {} };
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, ev }); return { text: 'ok', sessionId: 's', being }; } };
  const transcript = { entries: [], async log(ev, reply) { this.entries.push({ ev, reply }); } };
  const sender = { open() { return { update() {}, fail() {}, async finish() {} }; } };
  const loadState = state ? async () => state : null;
  const config = { agents, dispatch };
  const spine = createSpine({
    bridge, brain, sender, transcript,
    router: createRouter({ getAgents: () => agents, getConfig: () => config, loadState }),
    gating: createGating({ getConfig: () => config, loadState }),
    identity: { build: (m) => ({ ...m, line: m.body }) },
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now: () => 1 },
  });
  spine.start();
  const inbound = () => transcript.entries.filter((e) => e.reply == null).map((e) => e.ev.body);
  return { bridge, brain, inbound };
}

describe('mute — recorded, never a turn', () => {
  it('REPRODUCTION: send_to_egpt always used to run a turn on every muted line — an allowed user\'s handle call runs none now', async () => {
    const { bridge, brain, inbound } = build({ dispatch: { send_to_egpt: 'always' } });
    await bridge.emit(msg('e hola'));
    await bridge.emit(msg('buenas'));
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual(['e hola', 'buenas']);
  });

  it('the conversation\'s own send_to_egpt: always does not reopen it either', async () => {
    const state = { contacts: { whatsapp: { '!g': { slug: 'grupo', agents: { egpt: { mode: 'mute', send_to_egpt: 'always' } } } } } };
    const { bridge, brain, inbound } = build({ eMode: 'mention', state });
    await bridge.emit(msg('buenas'));
    await bridge.emit(msg('@e hola'));
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual(['buenas', '@e hola']);
  });

  it('a handle call or a quote-reply by an allowed user runs no turn (send_to_egpt mode)', async () => {
    const { bridge, brain, inbound } = build();
    await bridge.emit(msg('@e hola'));
    await bridge.emit(msg('y esto?', { replyToBeing: 'egpt' }));
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual(['@e hola', 'y esto?']);
  });

  it('a muted sibling stays asleep beside one that answers', async () => {
    const { bridge, brain } = build({ eMode: 'mention', wrenMode: 'mute' });
    await bridge.emit(msg('@wren hola'));
    await bridge.emit(msg('@e y @wren, vengan'));
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);
  });

  it('a voice note: both its lines are recorded, no turn', async () => {
    const { bridge, brain, inbound } = build();
    await bridge.emit(msg('(voice note)', { voiceLine: 'arrival' }));
    await bridge.emit(msg('(voice transcription, 3s) e hola', { voiceLine: 'outcome', isVoice: true }));
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual(['(voice note)', '(voice transcription, 3s) e hola']);
  });

  it('a media message is recorded with its saved path, no turn', async () => {
    const { bridge, brain, inbound } = build();
    await bridge.emit(msg('e mirá [image saved: media/2610161200-An.jpg]'));
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual(['e mirá [image saved: media/2610161200-An.jpg]']);
  });
});

describe('off — unchanged: not recorded, no turn', () => {
  it('nothing is recorded and nothing runs, even a handle call', async () => {
    const { bridge, brain, inbound } = build({ eMode: 'off', wrenMode: 'off' });
    await bridge.emit(msg('@e hola'));
    await bridge.emit(msg('(voice note)', { voiceLine: 'arrival' }));
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual([]);
  });
});
