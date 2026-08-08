// tests/spine-radio-relay.test.mjs — the ingestion-point hook (src/spine/spine.mjs
// handleFast, right after transcript.log(ev)) that fires the radio relay
// (src/spine/boot.mjs createRadioNoteRelay, src/radio-relay.mjs uploadNote) for a genuine
// inbound voice note. Same fake-pipe harness as tests/spine-pipe.test.mjs: no network, no
// Beeper, no Claude — just the loop shape + the gating condition.
import { describe, it, expect, vi } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';

function fakeBridge({ wasSentByUs = () => false } = {}) {
  let cb = null;
  return {
    sent: [],
    onMessage(fn) { cb = fn; },
    send(chat, text) { this.sent.push({ chat, text }); },
    emit(msg) { return cb(msg); },
    wasSentByUs,
    stop() {},
  };
}
const fakeBrain = () => ({ async turn(being, ev) { return { text: `↩ ${ev.body}`, sessionId: 's1' }; } });
const fakeIdentity = { build: (msg) => ({ ...msg, line: `${msg.senderName}@[${msg.chatName}]: ${msg.body}` }) };
const fakeRouter = { resolve: () => 'e' };
const fakeGating = { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'always' }; }, surfaces: (d) => d.mayReply };
const fakeSender = (bridge) => ({ open(chatId) { return { update() {}, fail() {}, async finish(reply) { bridge.send(chatId, typeof reply === 'string' ? reply : reply?.text); } }; } });
const fakeTranscript = () => ({ log() {} });
const fakeHeartbeats = () => ({ runDue() {} });

function build({ radioRelay, bridge = fakeBridge() } = {}) {
  const brain = fakeBrain();
  const spine = createSpine({
    bridge, brain,
    identity: fakeIdentity, router: fakeRouter, gating: fakeGating,
    sender: fakeSender(bridge), transcript: fakeTranscript(), heartbeats: fakeHeartbeats(),
    radioRelay,
    clock: { now: () => 1000 },
  });
  return { spine, bridge, brain };
}

const VOICE_MSG = {
  surface: 'whatsapp', node: 'wa', chatId: 'chat-1@g.us', chatName: 'fam',
  senderId: 'u-1', senderName: 'An', msgId: 'm1', ts: 1000, body: '(voice transcription) hola', kind: 'text', isVoice: true, raw: {},
};

describe('spine radio relay hook — fires for a genuine inbound voice note', () => {
  it('calls radioRelay(ev) once, with the built ev, when ev.isVoice is true', async () => {
    const calls = [];
    const radioRelay = vi.fn(async (ev) => { calls.push(ev); });
    const { spine, bridge } = build({ radioRelay });
    spine.start();
    await bridge.emit(VOICE_MSG);
    await new Promise((r) => setImmediate(r));   // radioRelay is fire-and-forget — let the microtask land
    expect(radioRelay).toHaveBeenCalledTimes(1);
    expect(calls[0].chatId).toBe('chat-1@g.us');
    expect(calls[0].msgId).toBe('m1');
    expect(calls[0].isVoice).toBe(true);
  });

  it('does NOT call radioRelay for an ordinary text message (isVoice false)', async () => {
    const radioRelay = vi.fn(async () => {});
    const { spine, bridge } = build({ radioRelay });
    spine.start();
    await bridge.emit({ ...VOICE_MSG, isVoice: false, body: 'hola' });
    await new Promise((r) => setImmediate(r));
    expect(radioRelay).not.toHaveBeenCalled();
  });

  it('does NOT call radioRelay when no relay is wired (null — byte-identical to before)', async () => {
    const { spine, bridge } = build({ radioRelay: null });
    spine.start();
    await expect(bridge.emit(VOICE_MSG)).resolves.not.toThrow();
    expect(bridge.sent).toEqual([{ chat: 'chat-1@g.us', text: '↩ (voice transcription) hola' }]);
  });
});

describe('spine radio relay hook — provenance gate (isHumanTurn, not re-derived)', () => {
  it('does NOT call radioRelay for THIS node\'s own send (bridge.wasSentByUs)', async () => {
    const radioRelay = vi.fn(async () => {});
    const bridge = fakeBridge({ wasSentByUs: (chatId, msgId) => msgId === 'm1' });
    const { spine } = build({ radioRelay, bridge });
    spine.start();
    await bridge.emit(VOICE_MSG);
    await new Promise((r) => setImmediate(r));
    expect(radioRelay).not.toHaveBeenCalled();
  });

  it('does NOT call radioRelay for a PEER node\'s signed line (ev.fromNode != null)', async () => {
    const radioRelay = vi.fn(async () => {});
    const { spine, bridge } = build({ radioRelay });
    spine.start();
    await bridge.emit({ ...VOICE_MSG, fromNode: 'do' });   // a co-account peer's structural signature
    await new Promise((r) => setImmediate(r));
    expect(radioRelay).not.toHaveBeenCalled();
  });

  it('does NOT call radioRelay for backlog (a woken node\'s replay)', async () => {
    const radioRelay = vi.fn(async () => {});
    const { spine, bridge } = build({ radioRelay });
    spine.start();
    await bridge.emit({ ...VOICE_MSG, backlog: true });
    await new Promise((r) => setImmediate(r));
    expect(radioRelay).not.toHaveBeenCalled();
  });
});

describe('spine radio relay hook — a relay failure never breaks the message path', () => {
  it('a rejected radioRelay promise is caught + logged; the reply still sends', async () => {
    const lines = [];
    const radioRelay = vi.fn(async () => { throw new Error('station is down'); });
    const bridge = fakeBridge();
    const brain = fakeBrain();
    const spine = createSpine({
      bridge, brain,
      identity: fakeIdentity, router: fakeRouter, gating: fakeGating,
      sender: fakeSender(bridge), transcript: fakeTranscript(), heartbeats: fakeHeartbeats(),
      radioRelay,
      log: { line: (s) => lines.push(s) },
      clock: { now: () => 1000 },
    });
    spine.start();
    await bridge.emit(VOICE_MSG);
    await new Promise((r) => setImmediate(r));
    expect(bridge.sent).toEqual([{ chat: 'chat-1@g.us', text: '↩ (voice transcription) hola' }]);
    expect(lines.some((l) => l.includes('radio relay') && l.includes('station is down'))).toBe(true);
  });
});
