// The spine pipe, end-to-end against fakes (plans/2606291226-SPINE-REWRITE-PLAN.md §6 Phase 1
// verify gate: "boots; fake Bridge+Brain round-trip a msg"). No network, no
// Claude process — every port/service is a fake, so this locks the LOOP shape
// and the gating branches, independent of the real subsystems layered in later.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createReplyActions } from '../src/spine/reply-actions.mjs';
import { createSender, RETAINED_SEAM } from '../src/spine/sender.mjs';
import { createGating } from '../src/spine/gating.mjs';

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

// gating with togglable knobs, so each branch is exercised independently.
//   receive — decide().receives ('off' = false)
//   reply   — decide().mayReply (would the reply surface at all)
//   send    — decide().sendToEgpt ('always' | 'mode')
//   surface — surfaces() result; defaults to `mayReply` unless given (on-mode '...').
function fakeGating({ receive = true, reply = true, send = 'mode', surface } = {}) {
  return {
    async decide() { return { mode: reply ? 'on' : 'mention', receives: receive, mayReply: reply, sendToEgpt: send }; },
    surfaces: (d, _text) => (surface === undefined ? d.mayReply : surface),
  };
}

// ONE append per call: the spine records the inbound at its single ingestion point
// (`log(ev)`) and each answering turn appends its own reply (`log(ev, reply)`).
// `actions` — the limb stage-directions the spine appends after execute (operator 2026-09-01).
function fakeTranscript() {
  return {
    entries: [], actions: [],
    log(ev, reply) { this.entries.push({ ev, reply }); },
    logAction(ev, action, opts) { this.actions.push({ ev, action, ...opts }); },
  };
}
const inbounds = (t) => t.entries.filter((e) => e.reply == null);
const replies = (t) => t.entries.filter((e) => e.reply != null);
// sender wraps the bridge — a real round-trip: inbound via bridge, outbound via bridge.
// open→update*→finish; honors the surface flag (not surfaced → nothing sent).
function fakeSender(bridge) {
  return { open(chatId) { return { update() {}, fail() {}, async finish(reply, { surface = true } = {}) { const t = typeof reply === 'string' ? reply : reply?.text; if (surface && t) bridge.send(chatId, t); } }; } };
}
function fakeHeartbeats() { return { ran: [], runDue(now) { this.ran.push(now); } }; }
function fakeStore() { return { threads: [], recordThread(rec) { this.threads.push(rec); } }; }

function build({ receive = true, reply = true, send = 'mode', surface } = {}) {
  const bridge = fakeBridge();
  const brain = fakeBrain();
  const transcript = fakeTranscript();
  const heartbeats = fakeHeartbeats();
  const store = fakeStore();
  const spine = createSpine({
    bridge, brain, store,
    identity: fakeIdentity, router: fakeRouter,
    gating: fakeGating({ receive, reply, send, surface }),
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
    // the message is recorded ONCE at ingestion, the reply appended after it
    expect(transcript.entries.map((e) => e.reply == null)).toEqual([true, false]);
    expect(replies(transcript)[0].reply).toEqual({ text: '↩ hola', sessionId: 's1', surfaced: true });
    expect(store.threads).toHaveLength(1);
    expect(store.threads[0].being).toBe('e');
  });

  it('mayReceive=false (off): NOT received — no brain, no send, NOT logged', async () => {
    const { spine, bridge, brain, transcript, store } = build({ receive: false });
    spine.start();
    await bridge.emit(MSG);

    expect(brain.calls).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
    expect(transcript.entries).toHaveLength(0);   // 'off' is not received at all
    expect(store.threads).toHaveLength(0);
  });

  it('mayReply=false + send_to_egpt=mode (default): logs, but does NOT run the brain or send', async () => {
    const { spine, bridge, brain, transcript } = build({ reply: false, send: 'mode' });
    spine.start();
    await bridge.emit(MSG);

    expect(brain.calls).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
    expect(transcript.entries).toHaveLength(1);
    expect(transcript.entries[0].reply).toBeUndefined();   // recorded only — 'not contacted yet'
  });

  it('mayReply=false + send_to_egpt=always: E RUNS (context), reply recorded not-surfaced, NOT sent', async () => {
    const { spine, bridge, brain, transcript, store } = build({ reply: false, send: 'always' });
    spine.start();
    await bridge.emit(MSG);

    expect(brain.calls).toHaveLength(1);                          // E ran on the message
    expect(bridge.sent).toHaveLength(0);                          // but nothing surfaced
    expect(inbounds(transcript)).toHaveLength(1);
    expect(replies(transcript)[0].reply).toEqual({ text: '↩ hola', sessionId: 's1', surfaced: false });
    expect(store.threads).toHaveLength(1);                        // thread recorded — E engaged
  });

  it("on-mode silence (surfaces=false): brain runs, reply recorded not-surfaced, NOT sent", async () => {
    const { spine, bridge, brain, transcript } = build({ reply: true, surface: false });
    spine.start();
    await bridge.emit(MSG);

    expect(brain.calls).toHaveLength(1);
    expect(bridge.sent).toHaveLength(0);                          // '...' not surfaced
    expect(replies(transcript)[0].reply).toEqual({ text: '↩ hola', sessionId: 's1', surfaced: false });
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

  it('stats() reports zeros for an empty queue', () => {
    const { spine } = build();
    spine.start();
    expect(spine.stats()).toEqual({ queueDepth: 0, oldestMs: 0 });
  });

  it('stats() reflects a backed-up queue; the oldest pending wait grows with the clock', async () => {
    const bridge = fakeBridge();
    let now = 1000;
    let release;
    const gate = new Promise((r) => { release = r; });
    const brain = { async turn() { await gate; return { text: 'x' }; } };
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter, gating: fakeGating({}),
      sender: fakeSender(bridge), transcript: fakeTranscript(), heartbeats: fakeHeartbeats(),
      clock: { now: () => now },
    });
    spine.start();

    // first msg is in-flight (shifted, parked on the never-yet-resolved brain);
    // the second stays pending in the queue.
    const drained = bridge.emit({ ...MSG, msgId: 'a', body: 'one' });
    bridge.emit({ ...MSG, msgId: 'b', body: 'two' });
    expect(spine.stats().queueDepth).toBe(1);
    now = 5000;
    expect(spine.stats().oldestMs).toBe(4000);   // pending msg enqueued at 1000

    release();
    await drained;
    expect(spine.stats()).toEqual({ queueDepth: 0, oldestMs: 0 });
  });

  it('throws when a required dependency is missing', () => {
    expect(() => createSpine({ bridge: fakeBridge() })).toThrow(/missing required dependency/);
  });
});

// Conversation-E LIMBS in the loop (ROADMAP §3): a reply's own-line action commands
// are STRIPPED from the surfaced prose, the RAW reply is recorded, and the actions
// execute against the bridge AFTER recording — confined to the reply's own chat.
describe('spine — emitted reply actions', () => {
  function fakeLimbs() {
    const calls = { react: [], send: [], media: [], edit: [], del: [] };
    return { calls,
      react: (chat, id, emoji) => { calls.react.push({ chat, id, emoji }); return true; },
      send: (chat, text, opts) => { calls.send.push({ chat, text, opts }); return { ok: true }; },
      sendMedia: (chat, path, opts) => { calls.media.push({ chat, path, opts }); return true; },
      editOwn: (chat, id, text) => { calls.edit.push({ chat, id, text }); return true; },
      deleteOwn: (chat, id) => { calls.del.push({ chat, id }); return true; },
      wasSentByUs: () => true,
    };
  }
  function buildA(replyText) {
    const bridge = fakeBridge();
    const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, ev }); return { text: replyText, sessionId: 's1' }; } };
    const transcript = fakeTranscript();
    const limbs = fakeLimbs();
    const actions = createReplyActions({ bridge: limbs, bodyEmojiOf: () => '🐶', labelOf: () => 'egpt', resolveConvDir: async () => null, onLog: () => {} });
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter, gating: fakeGating({}),
      sender: fakeSender(bridge), transcript, heartbeats: fakeHeartbeats(), actions,
      clock: { now: () => 1000 },
    });
    return { spine, bridge, transcript, limbs };
  }

  it('prose + action: prose surfaces (action line stripped), action executes, RAW reply recorded', async () => {
    const { spine, bridge, transcript, limbs } = buildA('Nice one!\n/react #7 🔥\nbye');
    spine.start();
    await bridge.emit(MSG);
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: 'Nice one!\nbye' }]);   // action line NOT surfaced
    expect(limbs.calls.react).toEqual([{ chat: MSG.chatId, id: '7', emoji: '🔥' }]);
    expect(replies(transcript)[0].reply.text).toBe('Nice one!\n/react #7 🔥\nbye');   // RAW recorded — nothing lost
    expect(replies(transcript)[0].reply.surfaced).toBe(true);
  });

  it('action-only reply: nothing surfaces (placeholder resolves silent), the action still runs + is recorded', async () => {
    const { spine, bridge, transcript, limbs } = buildA('/react #7 👍');
    spine.start();
    await bridge.emit(MSG);
    expect(bridge.sent).toHaveLength(0);                                   // no prose → nothing posted
    expect(limbs.calls.react).toEqual([{ chat: MSG.chatId, id: '7', emoji: '👍' }]);
    expect(replies(transcript)[0].reply.text).toBe('/react #7 👍');         // recorded
    expect(replies(transcript)[0].reply.surfaced).toBe(true);              // E DID respond (via the limb)
  });

  it('a malformed action is stripped from the surfaced prose and NOT executed', async () => {
    const { spine, bridge, limbs } = buildA('Hey\n/react\nthere');   // /react with no emoji → malformed
    spine.start();
    await bridge.emit(MSG);
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: 'Hey\nthere' }]);   // malformed line stripped
    expect(limbs.calls.react).toEqual([]);                                     // never executed
  });

  it('a reply emitted as a limb quote-replies via the bridge send with replyTo', async () => {
    const { spine, bridge, limbs } = buildA('/reply #42 on it');
    spine.start();
    await bridge.emit(MSG);
    expect(bridge.sent).toHaveLength(0);                                   // action-only
    expect(limbs.calls.send[0]).toMatchObject({ chat: MSG.chatId, text: 'on it', opts: { replyTo: '42' } });
  });
});

// mode:auto is an IMPERSONATION of the operator (operator 2026-07-05): E replies ONLY
// to OTHER people, as the operator; the operator's OWN messages (isSender) NEVER prompt
// E — they log + accumulate into the conversation cycle, and the NEXT other-person turn
// is prompted WITH them (in order) + the trigger line. (Echoes of E's own auto replies
// come back isSender too but are dropped by the bridge's sent-ids echo guard upstream.)
describe('spine — mode:auto (operator impersonation)', () => {
  const autoGating = { async decide() { return { mode: 'auto', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true };
  // Auto replies are now humanized: a person's message DWELLS before the turn, and the
  // reply is delayed by a typing time before the send (operator 2026-07-05). Drive both
  // injected timers deterministically so these behavioral assertions stay stable.
  function fakeTimers() {
    let seq = 0; const pending = new Map();
    return {
      setTimeout: (fn) => { const id = ++seq; pending.set(id, fn); return { __id: id, unref() {} }; },
      clearTimeout: (t) => { if (t && t.__id != null) pending.delete(t.__id); },
      size: () => pending.size,
      flush() { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) fn(); },
    };
  }
  const yieldMacro = () => new Promise((r) => setTimeout(r, 0));
  async function settle(timers, rounds = 16) {
    for (let i = 0; i < rounds; i++) { await yieldMacro(); if (timers.size() === 0) break; timers.flush(); }
    await yieldMacro();
  }
  function buildAuto() {
    const bridge = fakeBridge();
    const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, ev }); return { text: `↩ ${ev.body}`, sessionId: 's1' }; } };
    const transcript = fakeTranscript();
    const timers = fakeTimers();
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter, gating: autoGating,
      sender: fakeSender(bridge), transcript, heartbeats: fakeHeartbeats(),
      clock: { now: () => 1000 }, turnTimeoutMs: 0, rng: () => 0.5,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    spine.start();
    return { spine, bridge, brain, transcript, timers };
  }

  it("the operator's OWN message (isSender) runs NO turn — logged + accumulated, never answered", async () => {
    const { bridge, brain, transcript, timers } = buildAuto();
    await bridge.emit({ ...MSG, isSender: true, body: 'note to self' });
    await settle(timers);
    expect(brain.calls).toHaveLength(0);          // E is never prompted by the operator's own line
    expect(bridge.sent).toHaveLength(0);          // nothing sent (no reply to self)
    expect(transcript.entries).toHaveLength(1);   // but it IS logged (C1.2)
  });

  it('the OTHER person triggers ONE turn whose prompt carries the accumulated operator lines in order + the trigger', async () => {
    const { bridge, brain, timers } = buildAuto();
    await bridge.emit({ ...MSG, isSender: true,  body: 'first' });                     // operator — accumulates
    await bridge.emit({ ...MSG, isSender: true,  body: 'second' });                    // operator — accumulates
    await bridge.emit({ ...MSG, isSender: false, senderName: 'Bea', body: 'hey' });    // other person — arms the dwell
    expect(brain.calls).toHaveLength(0);                                               // dwell pending — no turn yet
    await settle(timers);                                                              // dwell fires → turn → typing → send
    expect(brain.calls).toHaveLength(1);                                               // exactly one turn
    expect(brain.calls[0].ev.line).toBe('An@[fam]: first\n\nAn@[fam]: second\n\nBea@[fam]: hey');
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ hey' }]);                // E replied to the other person
  });

  it('an other-person message with nothing accumulated prompts with just its own line', async () => {
    const { bridge, brain, timers } = buildAuto();
    await bridge.emit({ ...MSG, isSender: false, senderName: 'Bea', body: 'hi' });
    await settle(timers);
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].ev.line).toBe('Bea@[fam]: hi');   // no prepend when the cycle is empty
  });

  it('regression: a NON-auto (mention) chat is unchanged — an isSender @e message runs a normal turn (the auto-only interception does not bleed in)', async () => {
    const bridge = fakeBridge();
    const brain = fakeBrain();
    const mentionGating = { async decide() { return { mode: 'mention', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true };
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter, gating: mentionGating,
      sender: fakeSender(bridge), transcript: fakeTranscript(), heartbeats: fakeHeartbeats(),
      clock: { now: () => 1000 },
    });
    spine.start();
    await bridge.emit({ ...MSG, isSender: true, body: '@e ping' });
    expect(brain.calls).toHaveLength(1);                                     // ran a normal turn (NOT intercepted as auto-own)
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ @e ping' }]);
  });
});

// VOICE-REPLY PIPELINE (chunk 2, operator 2026-08-09; redesigned 2026-08-10): text is
// ALWAYS delivered via the normal streaming out.finish() path, unconditionally — the
// original design (delete the streamed text, post audio-only) looked broken live: an
// answer would appear then vanish. Now a voice-triggered turn (ev.isVoice) or an explicit
// `@ev` override ADDITIONALLY attaches synthesized audio as a REPLY TO the text just
// delivered, once its id is known. Fakes for synthesize/bridge.sendMedia/bridge.send — no
// real process, no real network, no real port (same DI discipline as the rest of this file).
describe('spine — voice-reply pipeline (chunk 2)', () => {
  function fakeVoiceBridge() {
    let cb = null;
    return {
      sent: [], media: [],
      onMessage(fn) { cb = fn; },
      send(chat, text, opts = {}) { this.sent.push({ chat, text, opts }); },
      sendMedia(chat, path, opts = {}) { this.media.push({ chat, path, opts }); return { ok: true, chatId: chat, pendingMessageID: 'pm-1', confirmedId: Promise.resolve('conf-1') }; },
      emit(msg) { return cb(msg); },
      stopped: false,
      stop() { this.stopped = true; },
    };
  }
  // Same shape as fakeSender, but records every finish() call AND exposes confirmedId
  // (mirroring sender.mjs's real getter) — 'text-conf-1' once a surfaced finish() actually
  // sent something, null otherwise (surface:false / empty), so the voice-attach step's
  // "no confirmedId → skip" branch is exercisable too.
  function fakeSenderRecording(bridge) {
    const finishCalls = [];
    return {
      finishCalls,
      open(chatId) {
        let confirmedId = null;
        return {
          update() {}, fail() {},
          async finish(reply, opts = { surface: true }) {
            finishCalls.push({ reply, opts });
            const t = typeof reply === 'string' ? reply : reply?.text;
            if (opts.surface !== false && t) { bridge.send(chatId, t); confirmedId = 'text-conf-1'; }
          },
          get confirmedId() { return confirmedId; },
        };
      },
    };
  }
  function buildVoice({ synthesize, voice = 'es_MX-claude-high', bridgeOf = null } = {}) {
    const bridge = fakeVoiceBridge();
    const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, ev }); return { text: `↩ ${ev.body}`, sessionId: 's1' }; } };
    const transcript = fakeTranscript();
    const sender = fakeSenderRecording(bridge);
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter,
      gating: fakeGating({}),
      sender, transcript, heartbeats: fakeHeartbeats(),
      clock: { now: () => 1000 },
      synthesize, voice, bridgeOf,
    });
    return { spine, bridge, brain, transcript, sender };
  }

  it('voice-in (ev.isVoice, no @ev): text delivers normally (kept, not deleted), voice note follows as a reply TO it', async () => {
    let synthCalls = 0;
    const synthesize = async () => { synthCalls++; return Buffer.from('AUDIO'); };
    const { spine, bridge, sender } = buildVoice({ synthesize });
    spine.start();
    await bridge.emit({ ...MSG, isVoice: true });

    // The text delivery is the SAME single surfaced finish() any ordinary reply gets —
    // no {text:'', surface:false} deletion call, no second finish() call.
    expect(sender.finishCalls).toHaveLength(1);
    expect(sender.finishCalls[0]).toMatchObject({ reply: { text: '↩ hola' }, opts: { surface: true } });
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ hola', opts: {} }]);
    expect(synthCalls).toBe(1);
    expect(bridge.media).toHaveLength(1);
    expect(bridge.media[0]).toMatchObject({ chat: MSG.chatId, opts: { replyTo: 'text-conf-1' } });   // replies to the TEXT
  });

  it('text-in, no @ev: completely unchanged (regression lock) — no synth call, plain text-out, no media', async () => {
    const synthesize = async () => { throw new Error('must not be called'); };
    const { spine, bridge } = buildVoice({ synthesize });
    spine.start();
    await bridge.emit(MSG);   // isVoice unset, no @ev in body

    expect(bridge.media).toHaveLength(0);
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ hola', opts: {} }]);
  });

  it('@ev override in a TEXT turn: text delivers normally, voice note follows as a reply TO it', async () => {
    const synthesize = async () => Buffer.from('AUDIO');
    const { spine, bridge } = buildVoice({ synthesize });
    spine.start();
    await bridge.emit({ ...MSG, isVoice: false, body: '@ev hola' });

    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ @ev hola', opts: {} }]);
    expect(bridge.media).toHaveLength(1);
    expect(bridge.media[0]).toMatchObject({ chat: MSG.chatId, opts: { replyTo: 'text-conf-1' } });
  });

  it('synthesis returns null → text already delivered either way, no media attempted beyond the declined call', async () => {
    const synthesize = async () => null;
    const { spine, bridge } = buildVoice({ synthesize });
    spine.start();
    await bridge.emit({ ...MSG, isVoice: true });

    expect(bridge.media).toHaveLength(0);
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ hola', opts: {} }]);
  });

  it('synthesis throws → text already delivered, error is logged not thrown', async () => {
    const synthesize = async () => { throw new Error('boom'); };
    const { spine, bridge } = buildVoice({ synthesize });
    spine.start();
    await bridge.emit({ ...MSG, isVoice: true });

    expect(bridge.media).toHaveLength(0);
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ hola', opts: {} }]);
  });

  it('bridge.sendMedia failure (not ok) does not affect the already-delivered text', async () => {
    const synthesize = async () => Buffer.from('AUDIO');
    const { spine, bridge } = buildVoice({ synthesize });
    bridge.sendMedia = (chat, path, opts) => { bridge.media.push({ chat, path, opts }); return false; };
    spine.start();
    await bridge.emit({ ...MSG, isVoice: true });

    expect(bridge.media).toHaveLength(1);
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ hola', opts: {} }]);
  });

  // THE FOURTH CALL SITE of the ONE outbound resolver (src/spine/sender.mjs makeOutbound, operator
  // 2026-09-07). The voice attach is one of the spine's own direct bridge sends, so it must ride
  // the BEING's own connection — the same answer the reply (spine-sender.test.mjs), the limbs
  // (reply-actions.test.mjs) and the steer 👀 (mouth-routing.test.mjs) now get from that one
  // function. Before it, this was a fourth private copy of `bridgeOf(being) ?? bridge`.
  it('bridgeOf present: the voice note rides the BEING\'s OWN connection, never the default one', async () => {
    const synthesize = async () => Buffer.from('AUDIO');
    const rodz = fakeVoiceBridge();
    const { spine, bridge } = buildVoice({ synthesize, bridgeOf: (b) => (b === 'e' ? rodz : null) });
    spine.start();
    await bridge.emit({ ...MSG, isVoice: true });

    expect(rodz.media).toHaveLength(1);
    expect(rodz.media[0]).toMatchObject({ chat: MSG.chatId, opts: { replyTo: 'text-conf-1' } });
    expect(bridge.media).toHaveLength(0);        // …and nothing on the default connection
  });

  // …AND THE CHAT IS PART OF THAT QUESTION (operator 2026-09-11/09-12). bridgeOf takes the chat,
  // and boot's rawBridgeOf answers with the being's MOUTH when there is no chat to place and with
  // the connection that HOLDS the chat otherwise. This site asked without it, so on a two-account
  // node the attach rode the mouth while ev.chatId named a room only the ear has — the same
  // DROPPED send that killed the /reply limb, one call site over (src/spine/reply-actions.mjs).
  it("the voice note rides the connection that HOLDS the chat, not the being's own mouth", async () => {
    const synthesize = async () => Buffer.from('AUDIO');
    const ear = fakeVoiceBridge(), mouth = fakeVoiceBridge();
    const { spine, bridge } = buildVoice({ synthesize, bridgeOf: (_being, chatId = null) => (chatId ? ear : mouth) });
    spine.start();
    await bridge.emit({ ...MSG, isVoice: true });

    expect(ear.media).toHaveLength(1);
    expect(ear.media[0]).toMatchObject({ chat: MSG.chatId, opts: { replyTo: 'text-conf-1' } });
    expect(mouth.media).toHaveLength(0);        // the mouth has no such room — this is where it was DROPPED
  });

  it('no synthesize/voice wired: byte-identical to before — no synth attempted, no media, plain text-out', async () => {
    const { spine, bridge } = buildVoice({ synthesize: null, voice: null });
    spine.start();
    await bridge.emit({ ...MSG, isVoice: true });

    expect(bridge.media).toHaveLength(0);
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ hola', opts: {} }]);
  });

  it('text delivery withheld (no confirmedId, e.g. an edge case where finish() never surfaced) → voice attach is skipped, not crashed', async () => {
    const synthesize = async () => { throw new Error('must not be called — no confirmedId to reply to'); };
    const bridge = fakeVoiceBridge();
    const brain = { async turn() { return { text: '', sessionId: 's1' }; } };   // empty reply → surface:false path
    const transcript = fakeTranscript();
    const sender = fakeSenderRecording(bridge);
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter, gating: fakeGating({}),
      sender, transcript, heartbeats: fakeHeartbeats(),
      clock: { now: () => 1000 }, synthesize, voice: 'es_MX-claude-high',
    });
    spine.start();
    await bridge.emit({ ...MSG, isVoice: true });

    expect(bridge.media).toHaveLength(0);   // no confirmedId → voice-out skipped entirely, no throw
  });

  // THE VOICE PATH SHARES THE DELIVERY (operator 2026-10-08, the stray "🐶 E: ..." after a voice
  // note "perrito …"). The on/auto drop ALSO suppresses voice-out: a HIDDEN '…' (on/auto) must post
  // NOTHING — no text AND nothing synthesized. The voice path has no silence-specific code; it reads
  // `deliverable`, which gating.surfaces sets false for a '…' in on/auto. With REAL gating in 'on'
  // mode this REPRODUCES the wrong fix two ways: the correct on/auto drop stays (surface:false, no
  // voice), while the ruled-wrong "drop in EVERY mode" would have hidden it in mention too. The
  // placeholder is EDITED to '✓' in the real sender (spine-sender.test.mjs) — never deleted.
  it("voice-in whose model reply is '…' (ON mode, REAL gating): HIDDEN — nothing synthesized, nothing posted, resolved via the withheld path", async () => {
    let synthCalls = 0;
    const synthesize = async () => { synthCalls++; return Buffer.from('AUDIO'); };
    const bridge = fakeVoiceBridge();
    const brain = { async turn() { return { text: '…', sessionId: 's1' }; } };   // the model CHOSE silence
    const sender = fakeSenderRecording(bridge);
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter,
      gating: createGating({ getConfig: () => ({ dispatch: { auto_default_mode: 'on' } }), loadState: null, defaultKey: 'e' }),   // REAL gating → 'on' hides the '…'
      sender, transcript: fakeTranscript(), heartbeats: fakeHeartbeats(),
      clock: { now: () => 1000 }, synthesize, voice: 'es_MX-claude-high',
    });
    spine.start();
    await bridge.emit({ ...MSG, isVoice: true });

    expect(synthCalls).toBe(0);                              // the hidden '…' is never spoken (voice-out suppressed)
    expect(bridge.media).toHaveLength(0);                   // no voice note attached
    expect(bridge.sent).toHaveLength(0);                    // no text posted either
    expect(sender.finishCalls[0].opts.surface).toBe(false); // resolved via the withheld path (→ '✓' in the real sender)
  });

  // A DELIBERATE '…' is NEVER SPOKEN, in ANY mode (operator 2026-10-08) — even in mention/accum,
  // where gating.surfaces LETS it through as TEXT. mention mode + REAL gating + a voice turn: the
  // '…' IS delivered as text (deliverable stays true), but synthesis is NOT invoked. This REPRODUCES
  // on pre-fix code (which spoke it: deliverable && ev.isVoice), and locks the voice-only suppression
  // that leaves text deliverability untouched — distinct from the on/auto case above (text hidden too).
  it("voice-in whose model reply is '…' (MENTION mode, REAL gating): text '…' delivers, but it is NEVER synthesized", async () => {
    let synthCalls = 0;
    const synthesize = async () => { synthCalls++; return Buffer.from('AUDIO'); };
    const bridge = fakeVoiceBridge();
    const brain = { async turn() { return { text: '…', sessionId: 's1' }; } };   // the model CHOSE silence
    const sender = fakeSenderRecording(bridge);
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter,
      gating: createGating({ getConfig: () => ({ dispatch: { auto_default_mode: 'mention' } }), loadState: null, defaultKey: 'e' }),
      sender, transcript: fakeTranscript(), heartbeats: fakeHeartbeats(),
      clock: { now: () => 1000 }, synthesize, voice: 'es_MX-claude-high',
    });
    spine.start();
    await bridge.emit({ ...MSG, isVoice: true, mention: { atEAnywhere: true } });   // the mention gate opens → '…' surfaces as text

    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '…', opts: {} }]);   // TEXT still delivered (mention/accum unchanged)
    expect(synthCalls).toBe(0);                                                 // …but the deliberate silence is never spoken
    expect(bridge.media).toHaveLength(0);                                       // no voice note attached
  });

  // REGRESSION LOCK (matched pair with the above): a NORMAL reply on the SAME mention-mode voice turn
  // is STILL synthesized — the suppression is silence-specific, not a mode-wide voice kill.
  it('voice-in with a NORMAL reply (MENTION mode, REAL gating): text delivers AND is synthesized', async () => {
    let synthCalls = 0;
    const synthesize = async () => { synthCalls++; return Buffer.from('AUDIO'); };
    const bridge = fakeVoiceBridge();
    const brain = { async turn(being, ev) { return { text: `↩ ${ev.body}`, sessionId: 's1' }; } };
    const sender = fakeSenderRecording(bridge);
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter,
      gating: createGating({ getConfig: () => ({ dispatch: { auto_default_mode: 'mention' } }), loadState: null, defaultKey: 'e' }),
      sender, transcript: fakeTranscript(), heartbeats: fakeHeartbeats(),
      clock: { now: () => 1000 }, synthesize, voice: 'es_MX-claude-high',
    });
    spine.start();
    await bridge.emit({ ...MSG, isVoice: true, mention: { atEAnywhere: true } });

    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ hola', opts: {} }]);
    expect(synthCalls).toBe(1);
    expect(bridge.media).toHaveLength(1);
    expect(bridge.media[0]).toMatchObject({ chat: MSG.chatId, opts: { replyTo: 'text-conf-1' } });
  });
});

// SYMMETRIC NODES (operator 2026-07-09): the sibling-output guard + standby takeover were
// REMOVED. Each node answers only the agents IT configures and nothing is injected network-wide,
// so there is no overlap to suppress. A message that merely STARTS with a peer's old reply stamp
// is ordinary chat now — it dispatches normally, immediately, no hold. (BACKLOG backfill STAYS —
// the S3-wake record guarantee, unrelated to the removed suppression.)
describe('spine — symmetric nodes (no suppression, no standby)', () => {
  const onGating = { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true };
  function build() {
    const bridge = fakeBridge();
    const brain = fakeBrain();
    const transcript = fakeTranscript();
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter, gating: onGating,
      sender: fakeSender(bridge), transcript, heartbeats: fakeHeartbeats(),
      clock: { now: () => 1000 }, turnTimeoutMs: 0,
    });
    spine.start();
    return { spine, bridge, brain, transcript };
  }

  it('a message starting with a FORMER peer stamp now dispatches NORMALLY in mode:on (the guard is gone)', async () => {
    const { bridge, brain } = build();
    await bridge.emit({ ...MSG, msgId: 'p1', body: '🤝 egpt\nya respondí' });   // no peerOutput flag exists anymore
    expect(brain.calls).toHaveLength(1);   // ordinary dispatch — no sibling-output guard skips it
  });

  it('every dispatch is IMMEDIATE — no standby hold, no delay', async () => {
    const { bridge, brain } = build();
    await bridge.emit({ ...MSG, msgId: 'n1', body: '@e estás?' });
    expect(brain.calls).toHaveLength(1);   // dispatched at once (no hold ever armed)
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ @e estás?' }]);
  });

  // BACKLOG BACKFILL (operator 2026-07-08, S3 wake) — UNCHANGED: an old message (backlog:true) is
  // logged but NEVER dispatched. The woken node backfills its record; it does not re-answer stale traffic.
  it('backlog (backlog:true) is transcript-logged but NEVER dispatched — even @e in mode:on', async () => {
    const { bridge, brain, transcript } = build();
    await bridge.emit({ ...MSG, msgId: 'b1', body: '@e estás?', backlog: true });
    expect(brain.calls).toHaveLength(0);                 // never dispatched (woken node backfills, doesn't re-answer)
    expect(bridge.sent).toHaveLength(0);
    expect(transcript.entries).toHaveLength(1);          // …but it IS logged (the record stays complete)
  });
});

// THE RESUME OBSERVATION (2026-09-27, node do). dolly lost AC power at 2026-09-25 22:40 and slept
// until 2026-09-27 10:00:24 with the spine process SUSPENDED, not restarted — so its bridge's start
// still read 09-20, and every message from the 35-hour sleep arrived as live traffic and was
// answered. The spine now notices that ITS OWN tick stopped (the measurement daemon-runtime.mjs
// makes: a gap between ticks far beyond the interval) and reports the moment it woke through
// resumedAt(), which the Beeper backlog gate reads (tests/beeper-bridge.test.mjs covers that end).
describe('spine — resume observation (a slept process is not a live one)', () => {
  const TICK = 30_000;
  // A mention-mode gate: a being is reached only by a message that addresses it — so a chat's
  // backlog of plain chatter would have woken nobody, and one `@e` line would have.
  const mentionGating = {
    async decide(_being, ev) { return { mode: 'mention', receives: true, mayReply: !!ev.mention?.atEAnywhere, sendToEgpt: 'mode' }; },
    surfaces: (d) => d.mayReply,
  };
  function buildTicking({ tickMs = TICK } = {}) {
    let now = Date.UTC(2026, 8, 25, 22, 0);
    const lines = [];
    const armed = [];
    const said = [];     // what the node said on its own account (boot's sayOnce, faked)
    const timers = [];   // the spine's setTimeout, on this clock
    const bridge = fakeBridge();
    const spine = createSpine({
      bridge, brain: fakeBrain(), identity: fakeIdentity, router: fakeRouter, gating: mentionGating,
      sender: fakeSender(bridge), transcript: fakeTranscript(), heartbeats: fakeHeartbeats(),
      clock: { now: () => now }, log: { line: (s) => lines.push(s) },
      say: async (m) => { said.push(m); return true; },
      tickMs, setInterval: (fn, ms) => { armed.push({ fn, ms }); return 1; }, clearInterval: () => {},
      setTimeout: (fn, ms) => { const t = { fn, at: now + ms, cleared: false, unref() {} }; timers.push(t); return t; },
      clearTimeout: (t) => { if (t) t.cleared = true; },
    });
    spine.start();
    return {
      spine, said, bridge,
      tick: () => (armed.length ? armed[0].fn() : spine.tick()),   // the interval's own callback, as libuv fires it
      advance: (ms) => { now += ms; },
      // …and time passing while the node is AWAKE: its timers fire, in deadline order
      settle: async (ms) => {
        now += ms;
        for (let t; (t = timers.filter((x) => !x.cleared && x.at <= now).sort((a, b) => a.at - b.at)[0]);) { t.cleared = true; await t.fn(); }
      },
      now: () => now,
      resumes: () => lines.filter((l) => /resumed after/.test(l)),
    };
  }

  it('REPRODUCE-FIRST: a 35-hour gap between ticks is a resume, reported at the moment of waking — and said once', () => {
    const s = buildTicking();
    for (let i = 0; i < 5; i++) { s.advance(TICK); s.tick(); }   // an ordinary, awake spine
    expect(s.spine.resumedAt()).toBe(null);
    s.advance(35 * 3600_000 + 24_000);                             // lid closed: no timer fires, the wall clock runs on
    s.tick();                                                      // the overdue tick, on waking
    const wokeAt = s.now();
    expect(s.spine.resumedAt()).toBe(wokeAt);
    expect(s.resumes()).toHaveLength(1);
    expect(s.resumes()[0]).toContain('resumed after ~126024s');
    expect(s.resumes()[0]).toContain(new Date(wokeAt).toISOString());   // the moment it woke, in the line
    for (let i = 0; i < 3; i++) { s.advance(TICK); s.tick(); }   // awake again
    expect(s.spine.resumedAt()).toBe(wokeAt);                      // still the last resume — every later message reads it
    expect(s.resumes()).toHaveLength(1);
  });

  // THE RACE THE TICK ALONE LOSES. On Windows 8+ a wait's timeout does not count time asleep, so
  // after a resume the event loop can still sit up to one tick interval in its I/O wait — and the
  // missed messages Beeper delivers on waking are exactly the I/O that ends it. The gate therefore
  // asks on arrival, and the question is the same measurement: the one that sees the gap first
  // reports it, the other finds it already reported.
  it('the gate can see the resume FIRST — asked on arrival before the overdue tick, and the tick does not report it again', () => {
    const s = buildTicking();
    for (let i = 0; i < 3; i++) { s.advance(TICK); s.tick(); }
    s.advance(35 * 3600_000);
    const wokeAt = s.now();
    expect(s.spine.resumedAt()).toBe(wokeAt);                      // a message's gate, before any tick fired
    s.advance(4_000); s.tick();                                    // …then the overdue tick
    expect(s.spine.resumedAt()).toBe(wokeAt);
    expect(s.resumes()).toHaveLength(1);
  });

  it('ordinary cadence with jitter and load NEVER reads as sleep (threshold 90s: load must never read as sleep)', () => {
    const s = buildTicking();
    // tick to tick: late, early, an 85s stall, and one exactly AT the threshold (the test is strictly greater)
    for (const gap of [30_000, 12_000, 48_000, 30_000, 85_000, 5_000, 30_000, 90_000, 30_000]) { s.advance(gap); s.tick(); }
    // …and messages arriving between ticks, each one an observation of its own
    for (let i = 0; i < 20; i++) { s.advance(7_000); expect(s.spine.resumedAt()).toBe(null); if (i % 4 === 3) s.tick(); }
    expect(s.spine.resumedAt()).toBe(null);
    expect(s.resumes()).toEqual([]);
  });

  it('a hand-driven spine (tickMs 0: no interval to measure against) never reports a resume', () => {
    const s = buildTicking({ tickMs: 0 });
    s.tick();
    s.advance(35 * 3600_000);
    s.tick();
    expect(s.spine.resumedAt()).toBe(null);
    expect(s.resumes()).toEqual([]);
  });

  // THE NOTICE (operator 2026-09-27, verbatim: "after a wake we can say 'N messages in the
  // backlog. type /recap to list them'"). Once per chat, after that chat's backlog has settled, and
  // only in a chat whose backlog WOULD HAVE REACHED A BEING had it been live — the spine's own
  // route + gate, asked without dispatching. N is the chat's whole backlog: the list /recap shows.
  const A = 'chat-palma@g.us', B = 'chat-charla@g.us';
  const slept = (s, over) => s.bridge.emit({ ...MSG, backlog: true, ...over });
  const addressed = { atEAnywhere: true };
  function wake(s) {
    for (let i = 0; i < 3; i++) { s.advance(TICK); s.tick(); }
    const sleptAt = s.now();
    s.advance(35 * 3600_000);
    s.spine.resumedAt();                                   // the gate's first arrival sees the gap
    return (min) => sleptAt + min * 60_000;                // a stamp `min` minutes into the sleep
  }

  it('REPRODUCE-FIRST: one notice per chat whose backlog would have reached a being, once that chat settles — N is its backlog', async () => {
    const s = buildTicking();
    const at = wake(s);
    await slept(s, { chatId: A, msgId: 'a1', body: '@e ¿me escuchas?', msgTs: at(60), mention: addressed });
    await slept(s, { chatId: A, msgId: 'a2', body: 'hola?', msgTs: at(70) });
    await s.settle(3_000);
    await slept(s, { chatId: A, msgId: 'a3', body: 'bueno, mañana', msgTs: at(80) });   // still arriving: the wait restarts
    await slept(s, { chatId: B, msgId: 'b1', body: 'buenas noches', msgTs: at(90) });  // chatter — nobody addressed
    await s.settle(4_000);
    expect(s.said).toEqual([]);                            // A has not settled yet
    await s.settle(2_000);
    expect(s.said).toEqual([{ chatId: A, text: '3 messages in the backlog. type /recap to list them', what: 'backlog' }]);
    await slept(s, { chatId: A, msgId: 'a4', body: 'otra más', msgTs: at(95) });
    await s.settle(60_000);
    expect(s.said).toHaveLength(1);                        // once per chat per wake — B never
  });

  it('a single message reads "1 message in the backlog"', async () => {
    const s = buildTicking();
    const at = wake(s);
    await slept(s, { chatId: A, body: '@e ¿estás?', msgTs: at(5), mention: addressed });
    await s.settle(10_000);
    expect(s.said.map((m) => m.text)).toEqual(['1 message in the backlog. type /recap to list them']);
  });

  it('only what was written WHILE it slept: a backlog message stamped before the sleep is neither listed nor told', async () => {
    const s = buildTicking();
    const at = wake(s);
    await slept(s, { chatId: A, body: '@e de la semana pasada', msgTs: at(-3 * 24 * 60), mention: addressed });
    await s.settle(10_000);
    expect(s.said).toEqual([]);
    expect(s.spine.backlogOf({ surface: MSG.surface, chatId: A })).toEqual([]);
  });

  it('no wake, no notice: a backlog replay on a node that never slept (older than bridge start) says nothing', async () => {
    const s = buildTicking();
    for (let i = 0; i < 3; i++) { s.advance(TICK); s.tick(); }
    await slept(s, { chatId: A, body: '@e ¿estás?', msgTs: s.now() - 3600_000, mention: addressed });
    await s.settle(10_000);
    expect(s.said).toEqual([]);
    expect(s.spine.backlogOf({ surface: MSG.surface, chatId: A })).toEqual([]);
  });

  it('/recap\'s list: every chat keeps its own backlog, told or not — and the next wake replaces it', async () => {
    const s = buildTicking();
    const at = wake(s);
    await slept(s, { chatId: A, body: '@e ¿me escuchas?', msgTs: at(60), mention: addressed });
    await slept(s, { chatId: B, body: 'buenas noches', msgTs: at(90) });
    expect(s.spine.backlogOf({ surface: MSG.surface, chatId: B })).toEqual([{ sender: 'An', ts: at(90), body: 'buenas noches' }]);
    expect(s.spine.backlogOf({ surface: MSG.surface, chatId: A })).toEqual([{ sender: 'An', ts: at(60), body: '@e ¿me escuchas?' }]);
    s.advance(TICK); s.tick();
    s.advance(2 * 3600_000); s.spine.resumedAt();          // it slept again
    expect(s.spine.backlogOf({ surface: MSG.surface, chatId: A })).toEqual([]);
  });
});

// mode: auto answer routing (ROADMAP §3): an operator quote-reply in the advice channel
// is intercepted EARLY (before gating), logged, and routed to the origin — never treated
// as a normal message where the ask was posted (E must not reply in the advice channel).
describe('spine — advice answer hook', () => {
  it('advice.isAnswer → route to origin, short-circuiting gating/brain (still logged)', async () => {
    const bridge = fakeBridge();
    const brain = fakeBrain();
    const transcript = fakeTranscript();
    const routed = [];
    const advice = { isAnswer: (ev) => ev.body === 'ANSWER', routeAnswer: (ev) => { routed.push(ev); } };
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter, gating: fakeGating({}),
      sender: fakeSender(bridge), transcript, heartbeats: fakeHeartbeats(), advice,
      clock: { now: () => 1000 },
    });
    spine.start();
    await bridge.emit({ ...MSG, body: 'ANSWER' });
    expect(routed).toHaveLength(1);                 // routed to the origin conversation
    expect(brain.calls).toHaveLength(0);            // NOT a normal turn in the advice channel
    expect(bridge.sent).toHaveLength(0);            // and nothing surfaced here
    expect(transcript.entries).toHaveLength(1);     // but the received message is logged (C1.2)

    // a non-answer message in the same channel routes normally (through the brain)
    await bridge.emit({ ...MSG, body: 'hola' });
    expect(routed).toHaveLength(1);
    expect(brain.calls).toHaveLength(1);
  });
});

// PHRASE TRIGGERS (operator 2026-10-04): a non-slash operator message whose whole text equals a
// configured config.<cmd>.triggers phrase is CONSUMED by classify — the command runs (discreetly)
// and NO being turn is dispatched. The matcher/runner live in commands.mjs (commands.phraseCommand /
// commands.runPhrase, covered by fork-command.test.mjs); this locks the DISPATCH half: consume vs.
// fall through, and that the consumed message is still recorded like any ordinary inbound.
describe('spine — phrase-trigger dispatch (classify consumes, no being turn)', () => {
  function buildPhrase(phraseCommand) {
    const bridge = fakeBridge();
    const brain = fakeBrain();
    const transcript = fakeTranscript();
    const ran = [];
    const commands = {
      isCommand: () => false,                       // not a '/'-command — a natural phrase
      phraseCommand,
      runPhrase: async (ev, cmd) => { ran.push({ body: ev.body, cmd }); },
    };
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter, gating: fakeGating({}),
      sender: fakeSender(bridge), transcript, heartbeats: fakeHeartbeats(), commands,
      clock: { now: () => 1000 },
    });
    spine.start();
    return { bridge, brain, transcript, ran };
  }

  it('a matching operator phrase RUNS the command and dispatches NO being turn — but IS logged', async () => {
    const { bridge, brain, transcript, ran } = buildPhrase((ev) => (ev.body === 'dame un segundo' ? 'join' : null));
    await bridge.emit({ ...MSG, authorized: true, body: 'dame un segundo' });
    expect(ran).toEqual([{ body: 'dame un segundo', cmd: 'join' }]);   // the command ran
    expect(brain.calls).toHaveLength(0);                               // no being turn dispatched (consumed)
    expect(bridge.sent).toHaveLength(0);                               // nothing surfaced in the chat
    expect(transcript.entries).toHaveLength(1);                        // but recorded like any ordinary message
  });

  it('a non-matching message is ordinary — phraseCommand returns null and the brain runs normally', async () => {
    const { bridge, brain, ran } = buildPhrase(() => null);
    await bridge.emit({ ...MSG, authorized: true, body: 'hola' });
    expect(ran).toHaveLength(0);
    expect(brain.calls).toHaveLength(1);                               // flowed through to the being
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ hola' }]);
  });
});

// LIVE BUG (operator 2026-07-15): /reply must be handled BEFORE anything is posted.
// The operator watched the literal token `/reply #<id> …` render in the chat, then the
// message get deleted and reposted as a native quote. Three causes, locked here:
//   1. the streaming callback piped the RAW, UNPARSED partial to the chat, so the token
//      rendered live (and a HALF-typed "/repl" would flicker if we only parsed whole lines);
//   2. the placeholder only carried a reply target when the message MENTIONED E, so a
//      no-mention chat got a PLAIN post — E could not quote what it was answering at all;
//   3. the redundancy guard stripped `/reply #X` whenever X was the message being ANSWERED,
//      on the premise that "the streamed reply already quotes it" — false whenever the
//      placeholder carried no reply target.
// The fixture is the REAL sender over a streaming bridge, so these assert what the
// operator actually sees: the stream's frames, its reply target, and the message count.
describe('spine — /reply handled BEFORE posting (no visible token, no delete+repost churn)', () => {
  // A bridge that is BOTH the spine's bridge (inbound + startStream) and reply-actions'
  // limb bridge (send/react/wasSentByUs) — so a reposted /reply limb lands in the same
  // `sent` list as any other post, and "exactly one message" is a real count.
  function streamingBridge() {
    let cb = null;
    const streams = [], sent = [];
    return {
      streams, sent,
      onMessage(fn) { cb = fn; },
      emit(msg) { return cb(msg); },
      send(chat, text, opts) { sent.push({ chat, text, opts }); return { ok: true }; },
      startStream(chat, init, opts) {
        const h = {
          chat, init, opts, frames: [], finals: [], deleted: false, delivered: false,
          update(t) { h.frames.push(t); },
          async finish(t) { h.finals.push(t); h.delivered = true; },
          async delete() { h.deleted = true; },
        };
        streams.push(h); return h;
      },
      react: () => true,
      // id-EXACT, as the real bridge is (beeper.mjs) — NOT a blanket true. The inbound trigger
      // (MSG, `m1`) is an EXTERNAL message, so it is NOT ours; anything else (a reposted limb,
      // an /edit target) is. A blanket `() => true` used to be inert here (no guard wired), but
      // the spine now refuses to reply to its OWN output (turnKind 'echo'), so a trigger wrongly
      // flagged as ours would be suppressed and never answered.
      wasSentByUs: (_chat, id) => id !== MSG.msgId,
      stop() {},
    };
  }

  // `partials` are fed to the brain's onPartial in order — the CUMULATIVE raw text the CLI
  // has emitted so far, exactly as brainpool hands it up (a plain string, and it may end
  // MID-LINE).
  function buildStreaming({ replyText, partials = [], verbose = false }) {
    const bridge = streamingBridge();
    const transcript = fakeTranscript();
    const brain = {
      calls: [],
      async turn(being, ev, onPartial) {
        this.calls.push({ being, ev });
        for (const p of partials) onPartial?.(p);
        // verbose rides out on the reply exactly as brainpool.mjs carries it, so the spine threads
        // it into finish() (gates the limb-only commandMark; operator 2026-10-06).
        return { text: replyText, sessionId: 's1', verbose };
      },
    };
    const actions = createReplyActions({ bridge, bodyEmojiOf: () => '🐶', labelOf: () => 'egpt', resolveConvDir: async () => null, onLog: () => {} });
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter, gating: fakeGating({}),
      sender: createSender({ bridge, bodyEmojiOf: () => '🐶', labelOf: () => 'egpt' }),
      transcript, heartbeats: fakeHeartbeats(), actions,
      clock: { now: () => 1000 },
    });
    spine.start();
    return { spine, bridge, brain, transcript };
  }

  // (1) The token — or ANY prefix of it — must never reach the chat. The partials below
  // walk the token in one character at a time the way a real stream does, ending mid-line
  // at every step ("/", "/re", "/reply #99"), so a naive "parse whole lines only" fix
  // still renders "/re" for a frame and then snaps it away. No frame may carry a '/' at all.
  it('a partial carrying /reply never renders — not the token, not a half-typed prefix', async () => {
    const { bridge } = buildStreaming({
      replyText: 'Hola\n/reply #99 hi',
      partials: ['Hola', 'Hola\n', 'Hola\n/', 'Hola\n/re', 'Hola\n/reply', 'Hola\n/reply #99', 'Hola\n/reply #99 hi'],
    });
    await bridge.emit(MSG);

    const frames = bridge.streams[0].frames;
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f).not.toMatch(/\//);        // no token, no half-typed prefix
    expect(new Set(frames)).toEqual(new Set(['Hola ⏳']));      // only the PROSE ever streams
  });

  // (2) MSG carries no mention and the chat is mode:on — E replies, so the reply must be a
  // native quote of the message it is answering. Today replyTo is null unless E was
  // mentioned, so the placeholder posts PLAIN and E cannot quote at all.
  it('a no-mention chat still opens the placeholder as a QUOTE of the triggering message', async () => {
    const { bridge } = buildStreaming({ replyText: 'hola' });
    await bridge.emit(MSG);

    expect(bridge.streams).toHaveLength(1);
    expect(bridge.streams[0].opts).toMatchObject({ replyTo: MSG.msgId });   // quoted from the START
  });

  // (3) The placeholder now genuinely quotes the trigger, so a /reply at that SAME message is
  // truly redundant — as a TARGET. Its WORDS are not redundant: they land in the reply that
  // already quotes it, so there is still no second/duplicate post (the 2026-07-08 rogue twin
  // stays fixed) and nothing E said is discarded.
  it('/reply at the message the placeholder already quotes DEMOTES to prose — ONE quoted message, no delete+repost', async () => {
    const { bridge } = buildStreaming({ replyText: `Vale, ya lo miro.\n/reply #${MSG.msgId} Hola Zohy 👋` });
    await bridge.emit(MSG);

    expect(bridge.streams[0].deleted).toBe(false);                    // the train is NOT torn down
    expect(bridge.streams[0].finals).toEqual(['Vale, ya lo miro.\nHola Zohy 👋']);   // the twin's words land HERE
    expect(bridge.streams[0].opts).toMatchObject({ replyTo: MSG.msgId });
    expect(bridge.sent).toHaveLength(0);                              // nothing reposted — exactly one message
  });

  // …and the redundancy guard must stay HONEST: a /reply at a DIFFERENT message is a real
  // limb and must still fire (delete+repost is unavoidable — Beeper's edit carries no reply
  // target, so an existing message cannot be retargeted).
  it('/reply at a DIFFERENT message is still honored (posts quoting that other message)', async () => {
    const { bridge } = buildStreaming({ replyText: '/reply #157204 sounds good', verbose: true });
    await bridge.emit(MSG);

    expect(bridge.streams[0].deleted).toBe(false);                    // nothing is ever deleted
    expect(bridge.streams[0].finals).toEqual(['⚙️ processing command (/reply)']);           // verbose ON → the bridge names what it is doing (2026-09-01), never a silence it did not receive
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0]).toMatchObject({ chat: MSG.chatId, text: 'sounds good', opts: { replyTo: '157204' } });
  });

  // THE LIVE SHAPE (operator 2026-07-15, Zohykar): E's WHOLE reply is `/reply #<trigger> …`.
  // Stripping it as "redundant" left the reply with no prose at all → action-only → the
  // placeholder was DELETED and nothing was posted: E's words were EATEN. Quoting the trigger
  // unconditionally makes the guard fire on far more replies, so it widens exactly this shape
  // — which is why the target is redundant but the WORDS are not: they demote into the reply
  // that already quotes the target. Exactly one message, nothing lost, no repost.
  it('an action-only /reply at the message we ALREADY quote demotes to prose — ONE quoted message, words intact', async () => {
    const { bridge } = buildStreaming({ replyText: `/reply #${MSG.msgId} Hola Zohy 👋` });
    await bridge.emit(MSG);

    expect(bridge.streams[0].deleted).toBe(false);                    // NOT torn down (today it is — the words vanish)
    expect(bridge.streams[0].finals).toEqual(['Hola Zohy 👋']);       // E's words ARE the reply
    expect(bridge.streams[0].opts).toMatchObject({ replyTo: MSG.msgId });   // natively quoting the trigger
    expect(bridge.sent).toHaveLength(0);                              // no repost — exactly one message
  });

  // A demoted /reply is PROSE, so it must STREAM like prose — it must not sit withheld as a
  // "viable action prefix" forever. The id is fixed the moment whitespace terminates it, so
  // from `#<id> ` on the line is provably prose and its text streams character by character.
  // The partialProse invariant still holds throughout: never a '/' , and a monotone prefix walk.
  it('the demoted prose streams LIVE, and no /reply token or half-typed prefix ever renders', async () => {
    const full = `/reply #${MSG.msgId} Hola Zohy`;
    const { bridge } = buildStreaming({
      replyText: full,
      partials: Array.from({ length: full.length }, (_, i) => full.slice(0, i + 1)),
    });
    await bridge.emit(MSG);

    const frames = bridge.streams[0].frames;
    for (const f of frames) expect(f).not.toMatch(/\//);              // the token never renders, at any position
    const shown = frames.map((f) => f.replace(/ ⏳$/, ''));
    expect(shown).toContain('Hola');                                  // …the demoted prose DOES stream, live
    expect(shown[shown.length - 1]).toBe('Hola Zohy');
    for (let i = 1; i < shown.length; i++)                            // monotone prefix walk — nothing ever un-renders
      expect(shown[i].startsWith(shown[i - 1])).toBe(true);
    expect(bridge.streams[0].finals).toEqual(['Hola Zohy']);          // lands exactly on the delivered prose
    expect(bridge.streams[0].deleted).toBe(false);
    expect(bridge.sent).toHaveLength(0);
  });

  // THE COST of streaming prose only: a TRUE action-only reply (a limb with no words of its
  // own) has no prose, so nothing streams and the placeholder holds "⏳ Thinking…" for the
  // whole turn. That is not a stuck placeholder — the turn still RESOLVES it at finish (here:
  // the react IS the response, so the placeholder is deleted — the legit-silence path,
  // UNCHANGED by the demote). Pinned so the "held, then resolved" end state stays honest.
  it('an action-only reply streams NOTHING (placeholder holds ⏳ Thinking…) but still RESOLVES at finish (verbose ON)', async () => {
    const { bridge } = buildStreaming({ replyText: '/react #7 👍', partials: ['/re', '/react #7', '/react #7 👍'], verbose: true });
    await bridge.emit(MSG);

    expect(bridge.streams[0].init).toBe('⏳ Thinking…');
    expect(bridge.streams[0].frames).toEqual([]);      // no half-typed token ever rendered
    expect(bridge.streams[0].finals).toEqual(['⚙️ processing command (/react)']);   // verbose ON: resolved to what the bridge is DOING, never deleted — the limb IS the response
    expect(bridge.sent).toHaveLength(0);
  });

  // THE LIVE BUG (operator 2026-10-06, with E/opus): same action-only /react, but verbose_thinking
  // OFF (the system default). "verbose thinking is off, and yet [the] reaction also appear as a
  // thinking process." The reaction still lands on its target; the placeholder must NOT carry the
  // "⚙️ processing command" debug line. End-to-end through the real spine + sender: it resolves to
  // the quiet mark, never commandMark, never a silence it did not receive, never deleted.
  it('verbose OFF: an action-only reply resolves QUIETLY — no "processing command" line in the chat', async () => {
    const { bridge } = buildStreaming({ replyText: '/react #7 👍', partials: ['/re', '/react #7', '/react #7 👍'], verbose: false });
    await bridge.emit(MSG);

    expect(bridge.streams[0].init).toBe('⏳ Thinking…');
    expect(bridge.streams[0].frames).toEqual([]);                 // still never renders the half-typed token
    expect(bridge.streams[0].finals).toEqual(['✓']);             // quiet — the ⏳ comes off, no debug line
    expect(bridge.streams[0].finals[0]).not.toContain('processing command');   // the operator's exact complaint
    expect(bridge.streams[0].finals[0]).not.toContain('received silence');     // a limb turn is not silence
    expect(bridge.streams[0].deleted).toBe(false);               // resolved, never destructively deleted
    expect(bridge.sent).toHaveLength(0);
  });

  // …AND THE SAME SHAPE WITH A MALFORMED TARGET (live: service-stderr.log
  // "stripped malformed action (reply: expected \"#<id> <text>\"): /reply #operator@[shell].room …").
  // The being's WHOLE reply was one /reply line whose id is not `[\w-]+`, so the parser STRIPS it
  // (correctly — a half-shaped command must never fire) and the turn is left with NO prose and NO
  // runnable action. `hadActions` counts the stripped line, so the turn still went down the
  // ACTION-ONLY branch with an EMPTY verb list — and `commandMark` is guarded on `commands?.length`,
  // so the placeholder fell through to BRIDGE_SILENCE. The chat was told the bridge received
  // nothing from the model, in the one case where the model had said everything it had to say.
  // A reply that cannot be delivered must SURFACE, never vanish behind a silence that did not
  // happen (operator: nothing in eGPT is allowed to lie).
  //
  // …AND THE MARKER WAS STILL THE WRONG ANSWER (operator 2026-09-14). "Meant to reply, nothing
  // deliverable" was false: the sentence inside the malformed limb WAS the deliverable, and the
  // chat got a warning instead of it. Only the TARGET is broken, so the words now demote to prose
  // (src/spine/reply-actions.mjs parseOne) — the limb still never fires and is still logged.
  it('a reply that is ONE malformed action line resolves VISIBLY — never as a silence that did not happen', async () => {
    const { bridge } = buildStreaming({ replyText: '/reply #operator@[shell].room No pude abrir Chrome en esta sesión.' });
    await bridge.emit(MSG);

    expect(bridge.streams[0].deleted).toBe(false);                       // nothing is ever deleted
    const settled = bridge.streams[0].finals.at(-1) ?? '';
    expect(settled).not.toContain('received silence');                   // the model spoke — the bridge must not claim it heard nothing
    expect(settled.trim()).not.toBe('');                                 // …and must not resolve to an empty message either
    expect(settled).not.toContain('/reply');                             // the malformed command is still never surfaced
    expect(settled).toContain('No pude abrir Chrome en esta sesión.');   // …and the ANSWER inside the malformed limb is what it says (2026-09-14)
    expect(settled).not.toBe('⚠️ no reply (turn failed/empty)');         // the marker is for a turn with nothing to say — this turn had everything to say
    expect(bridge.sent).toHaveLength(0);                                 // nothing runnable → no limb fired
  });

  // THE LIVE TURN OF 2026-09-01, whole (operator's own SPOILER transcript, twice that morning).
  // Three faults in one reply: the model's REASONING message and its ACTION message reached the
  // spine glued into one accumulated line ("…from me./react #563 🤝"), so the command streamed
  // into the chat as prose and — the message being append-only — stayed there; the CLI's own
  // `result` was the LAST message alone, so the turn went action-only and the placeholder
  // resolved with "<received silence (error?)>" beside prose a human had already read; and
  // nothing anywhere recorded that a reaction had happened.
  it('the welded command never reaches the chat, the bridge says it is processing it, and the transcript records the reaction', async () => {
    const prose = "This is agreeing with something #560 — a simple affirmation doesn't need a reply from me.";
    const { bridge, transcript } = buildStreaming({
      replyText: '/react #563 🤝',                                     // the CLI's `result`: the LAST assistant message
      partials: [prose, prose + '/', prose + '/react #563', prose + '/react #563 🤝'],   // …the ACCUMULATED train, welded
      verbose: true,                                                   // verbose ON → the commandMark record lands under the seam
    });
    await bridge.emit(MSG);

    for (const f of bridge.streams[0].frames) expect(f).not.toContain('/react');   // (1) never streamed
    expect(bridge.streams[0].finals).toEqual([prose + RETAINED_SEAM + '⚙️ processing command (/react)']);
    expect(bridge.streams[0].finals[0]).not.toContain('/react #563');              // (1) never delivered
    expect(bridge.streams[0].finals[0]).not.toContain('received silence');         // (2) never beside prose
    expect(transcript.actions).toHaveLength(1);                                    // (3) the reaction IS an event now
    expect(transcript.actions[0].action).toMatchObject({ type: 'react', targetId: '563', emoji: '🤝' });
    expect(transcript.actions[0].being).toBe('e');
    // the RAW reply is still what the record keeps — nothing the model emitted is lost
    expect(replies(transcript)[0].reply.text).toBe('/react #563 🤝');
  });

  it('a weld in the SETTLED reply is executed and stripped: the prose is delivered, the command is gone', async () => {
    const { bridge, transcript } = buildStreaming({ replyText: 'Listo, ya lo miré./react #7 👍' });
    await bridge.emit(MSG);

    expect(bridge.streams[0].finals).toEqual(['Listo, ya lo miré.']);   // prose delivered, no command, no seam
    expect(transcript.actions.map((a) => a.action.type)).toEqual(['react']);
  });

  // THE STABLE MESSAGE (operator 2026-08-28): "the message is replaced for a 'final' message,
  // and the in-transit thinking is deleted … sometimes it is writing something and then boom, it
  // changes". The settled reply is NOT always an extension of what streamed (warm-cli resolves
  // with the LAST assistant message; codex replaces `text` wholesale on item/completed), and the
  // final edit used to overwrite the whole message — so text a human had already read vanished.
  // Locked through the WHOLE pipe: the real sender, the real partialProse, the real parse.
  it('a settled reply that DIVERGES from the narration keeps it — and still shows no action line', async () => {
    const { bridge } = buildStreaming({
      replyText: `Listo: son 42 líneas.\n/react #${MSG.msgId} 👍`,
      partials: ['Voy a mirar', 'Voy a mirar el archivo…', `Voy a mirar el archivo…\n/react #${MSG.msgId} 👍`],
    });
    await bridge.emit(MSG);

    const h = bridge.streams[0];
    const shown = [...h.frames.map((f) => f.replace(/ ⏳$/, '')), ...h.finals];
    for (const s of shown) expect(s).not.toMatch(/\//);                  // the raw train still belongs to the transcript, not the chat
    for (let i = 1; i < shown.length; i++)                                // append-only: every value extends the last
      expect(shown[i].startsWith(shown[i - 1])).toBe(true);
    const final = h.finals[0];
    expect(final).toContain('Voy a mirar el archivo…');                   // what the human read is still there
    expect(final.endsWith('Listo: son 42 líneas.')).toBe(true);           // …and the settled answer is the last block
    expect(h.deleted).toBe(false);
    expect(bridge.sent).toHaveLength(0);                                  // still ONE message
  });
});
