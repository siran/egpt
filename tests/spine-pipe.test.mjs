// The spine pipe, end-to-end against fakes (SPINE-REWRITE-PLAN.md §6 Phase 1
// verify gate: "boots; fake Bridge+Brain round-trip a msg"). No network, no
// Claude process — every port/service is a fake, so this locks the LOOP shape
// and the gating branches, independent of the real subsystems layered in later.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../spine.mjs';
import { createReplyActions } from '../src/spine/reply-actions.mjs';

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

function fakeTranscript() { return { entries: [], log(ev, reply) { this.entries.push({ ev, reply }); } }; }
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
    expect(transcript.entries).toHaveLength(1);
    expect(transcript.entries[0].reply).toEqual({ text: '↩ hola', sessionId: 's1', surfaced: true });
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
    expect(transcript.entries[0].reply).toBeUndefined();   // logged only — 'not contacted yet'
  });

  it('mayReply=false + send_to_egpt=always: E RUNS (context), reply recorded not-surfaced, NOT sent', async () => {
    const { spine, bridge, brain, transcript, store } = build({ reply: false, send: 'always' });
    spine.start();
    await bridge.emit(MSG);

    expect(brain.calls).toHaveLength(1);                          // E ran on the message
    expect(bridge.sent).toHaveLength(0);                          // but nothing surfaced
    expect(transcript.entries).toHaveLength(1);
    expect(transcript.entries[0].reply).toEqual({ text: '↩ hola', sessionId: 's1', surfaced: false });
    expect(store.threads).toHaveLength(1);                        // thread recorded — E engaged
  });

  it("on-mode silence (surfaces=false): brain runs, reply recorded not-surfaced, NOT sent", async () => {
    const { spine, bridge, brain, transcript } = build({ reply: true, surface: false });
    spine.start();
    await bridge.emit(MSG);

    expect(brain.calls).toHaveLength(1);
    expect(bridge.sent).toHaveLength(0);                          // '...' not surfaced
    expect(transcript.entries[0].reply).toEqual({ text: '↩ hola', sessionId: 's1', surfaced: false });
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
    expect(transcript.entries[0].reply.text).toBe('Nice one!\n/react #7 🔥\nbye');   // RAW recorded — nothing lost
    expect(transcript.entries[0].reply.surfaced).toBe(true);
  });

  it('action-only reply: nothing surfaces (placeholder resolves silent), the action still runs + is recorded', async () => {
    const { spine, bridge, transcript, limbs } = buildA('/react #7 👍');
    spine.start();
    await bridge.emit(MSG);
    expect(bridge.sent).toHaveLength(0);                                   // no prose → nothing posted
    expect(limbs.calls.react).toEqual([{ chat: MSG.chatId, id: '7', emoji: '👍' }]);
    expect(transcript.entries[0].reply.text).toBe('/react #7 👍');         // recorded
    expect(transcript.entries[0].reply.surfaced).toBe(true);              // E DID respond (via the limb)
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

// TRUSTED EGPT NETWORK (operator 2026-07-08): the sibling-output guard (piece 2) and the
// standby takeover hold (piece 3). Peer output (a peer node's own stamped reply) is logged
// but NEVER dispatched — any mode, incl mode:on. On a STANDBY node a network-addressed
// dispatch is HELD for takeover_ms and cancelled if the primary answers (a peer reply lands
// in the chat); a PINNED own-handle mention bypasses the hold. primary/absent = no change.
describe('spine — trusted network (sibling-output guard + standby takeover)', () => {
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
  // mode:on gating so a bare message (no @e) still dispatches — models the shared-chat gate pass.
  const onGating = { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true };
  function buildNet({ network } = {}) {
    const bridge = fakeBridge();
    const brain = fakeBrain();
    const transcript = fakeTranscript();
    const timers = fakeTimers();
    const spine = createSpine({
      bridge, brain, store: fakeStore(),
      identity: fakeIdentity, router: fakeRouter, gating: onGating,
      sender: fakeSender(bridge), transcript, heartbeats: fakeHeartbeats(),
      network, clock: { now: () => 1000 }, turnTimeoutMs: 0,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    spine.start();
    return { spine, bridge, brain, transcript, timers };
  }

  // PIECE 2 — sibling-output guard.
  it('peer output (peerOutput:true) is transcript-logged but NEVER dispatched — even in mode:on', async () => {
    const { bridge, brain, transcript } = buildNet();   // no network block → primary; guard is default-on
    await bridge.emit({ ...MSG, msgId: 'p1', body: '🤝 egpt\nya respondí', peerOutput: true });
    expect(brain.calls).toHaveLength(0);                 // never dispatched (no mode:on trigger, no gate pass)
    expect(bridge.sent).toHaveLength(0);
    expect(transcript.entries).toHaveLength(1);          // …but it IS logged (still flows to the transcript)
  });
  it('regression: a NON-peer message in mode:on still dispatches normally', async () => {
    const { bridge, brain } = buildNet();
    await bridge.emit({ ...MSG, msgId: 'n1', body: 'hola' });
    expect(brain.calls).toHaveLength(1);
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ hola' }]);
  });

  // BACKLOG BACKFILL (operator 2026-07-08, S3 wake): an old message (backlog:true) is logged
  // but NEVER dispatched — even a network-addressed @e in mode:on. The node backfills its
  // record on wake; it does not re-answer stale traffic. Same seam as the sibling-output guard.
  it('backlog (backlog:true) is transcript-logged but NEVER dispatched — even @e in mode:on', async () => {
    const { bridge, brain, transcript } = buildNet();
    await bridge.emit({ ...MSG, msgId: 'b1', body: '@e estás?', backlog: true });
    expect(brain.calls).toHaveLength(0);                 // never dispatched (woken node backfills, doesn't re-answer)
    expect(bridge.sent).toHaveLength(0);
    expect(transcript.entries).toHaveLength(1);          // …but it IS logged (the record stays complete)
  });

  // PIECE 3 — standby takeover.
  it('standby HOLDS a network-addressed dispatch, then fires after takeover_ms when no peer answers', async () => {
    const { bridge, brain, timers } = buildNet({ network: { role: 'standby', takeover_ms: 5000 } });
    await bridge.emit({ ...MSG, msgId: 's1', body: '@e estás?' });   // no pinned → held
    expect(brain.calls).toHaveLength(0);                 // held, not dispatched yet
    expect(timers.size()).toBe(1);                       // one pending takeover hold
    await settle(timers);                                // no peer reply → the hold fires
    expect(brain.calls).toHaveLength(1);                 // dispatched after the delay
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ @e estás?' }]);
  });
  it('standby CANCELS the held dispatch when a peer-stamped reply lands in the same chat within the window', async () => {
    const { bridge, brain, transcript, timers } = buildNet({ network: { role: 'standby', takeover_ms: 5000 } });
    await bridge.emit({ ...MSG, msgId: 's2', body: '@e estás?' });         // held
    expect(timers.size()).toBe(1);
    await bridge.emit({ ...MSG, msgId: 'peer', body: '🤝 egpt\nyo contesto', peerOutput: true });   // the primary answered
    expect(timers.size()).toBe(0);                       // the hold was cancelled
    await settle(timers);
    expect(brain.calls).toHaveLength(0);                 // the standby stayed silent
    expect(bridge.sent).toHaveLength(0);
    expect(transcript.entries.map((e) => e.ev.msgId)).toEqual(['s2', 'peer']);   // both received messages logged
  });
  it('standby answers a PINNED own-handle mention (@ed) IMMEDIATELY — no hold', async () => {
    const { bridge, brain, timers } = buildNet({ network: { role: 'standby', takeover_ms: 5000 } });
    await bridge.emit({ ...MSG, msgId: 'd1', body: '@ed estás?', mention: { atEStart: true, atEAnywhere: true, replyToBot: false, pinned: true } });
    expect(brain.calls).toHaveLength(1);                 // dispatched at once, no timer
    expect(timers.size()).toBe(0);
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ @ed estás?' }]);
  });
  it('regression: role:primary (and an absent network block) = zero behavior change — dispatches immediately, no hold', async () => {
    const primary = buildNet({ network: { role: 'primary' } });
    await primary.bridge.emit({ ...MSG, msgId: 'pr', body: '@e hi' });
    expect(primary.brain.calls).toHaveLength(1);
    expect(primary.timers.size()).toBe(0);               // no hold armed for a primary
    const absent = buildNet();                            // no network block at all
    await absent.bridge.emit({ ...MSG, msgId: 'ab', body: '@e hi' });
    expect(absent.brain.calls).toHaveLength(1);
    expect(absent.timers.size()).toBe(0);
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
