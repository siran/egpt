// The spine pipe, end-to-end against fakes (SPINE-REWRITE-PLAN.md §6 Phase 1
// verify gate: "boots; fake Bridge+Brain round-trip a msg"). No network, no
// Claude process — every port/service is a fake, so this locks the LOOP shape
// and the gating branches, independent of the real subsystems layered in later.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../spine.mjs';

// --- fakes: each port/service as a tiny recorder ------------------------------
function fakeBridge() {
  let cb = null;
  return {
    sent: [],
    onMessage(fn) { cb = fn; },
    send(chat, text) { this.sent.push({ chat, text }); },
    // drive an inbound message; resolves after the pump drains it
    emit(msg) { return cb(msg); },
    stopped: false,
    stop() { this.stopped = true; },
  };
}

function fakeBrain() {
  return {
    calls: [],
    async turn(being, ev) { this.calls.push({ being, ev }); return { text: `↩ ${ev.body}`, sessionId: 's1' }; },
  };
}

// identity.build: minimal classify — pass the raw fields through as the envelope.
const fakeIdentity = { build: (msg) => ({ ...msg, line: `${msg.senderName}@[${msg.chatName}]: ${msg.body}` }) };
const fakeRouter = { resolve: () => 'e' };

// gating with togglable receive/reply, so each branch is exercised independently.
function fakeGating({ receive = true, reply = true } = {}) {
  return { mayReceive: () => receive, mayReply: () => reply };
}

function fakeTranscript() { return { entries: [], log(ev, reply) { this.entries.push({ ev, reply }); } }; }
// sender wraps the bridge — a real round-trip: inbound via bridge, outbound via bridge.
// open→update*→finish; this fake one-shots on finish (the fake brain doesn't stream).
function fakeSender(bridge) {
  return { open(chatId) { return { update() {}, async finish(reply) { const t = typeof reply === 'string' ? reply : reply?.text; if (t) bridge.send(chatId, t); } }; } };
}
function fakeHeartbeats() { return { ran: [], runDue(now) { this.ran.push(now); } }; }
function fakeStore() { return { threads: [], recordThread(rec) { this.threads.push(rec); } }; }

function build({ receive = true, reply = true } = {}) {
  const bridge = fakeBridge();
  const brain = fakeBrain();
  const transcript = fakeTranscript();
  const heartbeats = fakeHeartbeats();
  const store = fakeStore();
  const spine = createSpine({
    bridge, brain, store,
    identity: fakeIdentity, router: fakeRouter,
    gating: fakeGating({ receive, reply }),
    sender: fakeSender(bridge), transcript, heartbeats,
    clock: { now: () => 1000 },
  });
  return { spine, bridge, brain, transcript, heartbeats, store };
}

const MSG = {
  surface: 'wa', node: 'wa', chatId: 'chat-1@g.us', chatName: 'fam',
  senderId: 'u-1', senderName: 'An', msgId: 'm1', ts: 1000, body: 'hola', kind: 'text', raw: {},
};

describe('spine pipe', () => {
  it('boots and stops without throwing', () => {
    const { spine, bridge } = build();
    expect(() => { spine.start(); spine.stop(); }).not.toThrow();
    expect(bridge.stopped).toBe(true);
  });

  it('round-trips a message: bridge in → brain → bridge out, logged + recorded', async () => {
    const { spine, bridge, brain, transcript, store } = build();
    spine.start();
    await bridge.emit(MSG);

    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('e');
    expect(bridge.sent).toEqual([{ chat: 'chat-1@g.us', text: '↩ hola' }]);   // out via the same bridge
    expect(transcript.entries).toHaveLength(1);
    expect(transcript.entries[0].reply).toEqual({ text: '↩ hola', sessionId: 's1' });
    expect(store.threads).toHaveLength(1);
    expect(store.threads[0].being).toBe('e');
  });

  it('mayReceive=false (off/mute): no brain, no send, but STILL logged (C1.2)', async () => {
    const { spine, bridge, brain, transcript, store } = build({ receive: false });
    spine.start();
    await bridge.emit(MSG);

    expect(brain.calls).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
    expect(transcript.entries).toHaveLength(1);
    expect(transcript.entries[0].reply).toBeUndefined();   // inbound recorded, no reply
    expect(store.threads).toHaveLength(0);
  });

  it('mayReply=false (mention not matched): receives + logs, but does NOT invoke the brain or send', async () => {
    const { spine, bridge, brain, transcript } = build({ reply: false });
    spine.start();
    await bridge.emit(MSG);

    expect(brain.calls).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
    expect(transcript.entries).toHaveLength(1);
    expect(transcript.entries[0].reply).toBeUndefined();
  });

  it('processes inbound serially (queue drains one at a time)', async () => {
    const { spine, bridge, brain } = build();
    spine.start();
    await Promise.all([
      bridge.emit({ ...MSG, msgId: 'm1', body: 'one' }),
      bridge.emit({ ...MSG, msgId: 'm2', body: 'two' }),
    ]);
    expect(brain.calls.map(c => c.ev.body)).toEqual(['one', 'two']);
    expect(bridge.sent.map(s => s.text)).toEqual(['↩ one', '↩ two']);
  });

  it('tick() runs due heartbeats with the clock time', () => {
    const { spine, heartbeats } = build();
    spine.tick();
    expect(heartbeats.ran).toEqual([1000]);
  });

  it('throws when a required dependency is missing', () => {
    expect(() => createSpine({ bridge: fakeBridge() })).toThrow(/missing required dependency/);
  });
});
