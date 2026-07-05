// Auto-mode humanization (operator 2026-07-05, "it should take time to answer …
// they wander off like a normal person"). AUTO CHATS ONLY. Two randomized delays, both
// OUTSIDE the turn-timeout budget:
//   1) DWELL before the turn — a person's message doesn't fire an instant reply; more
//      messages during the dwell accumulate + reset/extend it (bounded by a hard cap);
//      when it expires ONE turn fires with the whole burst.
//   2) TYPING TIME before the send — the plain post-once send is delayed by a
//      typing-speed function of the reply length (capped).
// Every non-auto mode is regression-locked to fire instantly, exactly as before.
//
// Timers + rng are injected (the spine's existing seam), so these tests are fully
// deterministic — no real waiting, no vi.useFakeTimers global patching.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../spine.mjs';

// A controllable fake timer: records each armed timer (fn + delay), fires them on demand.
// The spine arms the dwell (pre-turn) and the typing sleep (mid-turn) through here.
function fakeTimers() {
  let seq = 0;
  const pending = new Map();   // id -> { fn, delay }
  return {
    setTimeout: (fn, delay = 0) => { const id = ++seq; pending.set(id, { fn, delay }); return { __id: id, unref() {} }; },
    clearTimeout: (t) => { if (t && t.__id != null) pending.delete(t.__id); },
    size: () => pending.size,
    delays: () => [...pending.values()].map((e) => e.delay),
    flush() { const es = [...pending.values()]; pending.clear(); for (const { fn } of es) fn(); },
  };
}

const yieldMacro = () => new Promise((r) => setTimeout(r, 0));
// Drive every armed timer to completion, letting the async turn body progress between
// rounds (dwell fires → turn runs → typing arms → typing fires → send).
async function settle(timers, rounds = 20) {
  for (let i = 0; i < rounds; i++) { await yieldMacro(); if (timers.size() === 0) break; timers.flush(); }
  await yieldMacro();
}

const fakeIdentity = { build: (m) => ({ ...m, line: `${m.senderName}@[${m.chatName}]: ${m.body}` }) };
const fakeRouter = { resolve: () => ({ being: 'e', mention: {} }) };
function fakeSender(bridge) {
  return { open(chatId, opts = {}) {
    return {
      activate() {}, update() {}, async fail() {},
      async finish(reply, { surface = true } = {}) {
        const t = typeof reply === 'string' ? reply : reply?.text;
        if (surface && t) bridge.send(chatId, t, opts);
      },
    };
  } };
}
function fakeBridge() {
  let cb = null;
  return { sent: [], onMessage(fn) { cb = fn; }, emit(m) { return cb(m); }, send(chat, text, opts) { this.sent.push({ chat, text, opts }); }, stop() {} };
}
function fakeTranscript() { return { entries: [], async log(ev, reply, opts = {}) { this.entries.push({ ev, reply, opts }); } }; }
function fakeBrain(text = (ev) => `↩ ${ev.body}`) {
  return { calls: [], async turn(being, ev) { this.calls.push({ being, ev }); return { text: text(ev), sessionId: 's1' }; } };
}
const heartbeats = { runDue() {} };

const autoGating = { async decide() { return { mode: 'auto', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true };

function build({ gating = autoGating, brain = fakeBrain(), rng = () => 0.5, clock, actions } = {}) {
  const bridge = fakeBridge();
  const transcript = fakeTranscript();
  const timers = fakeTimers();
  const spine = createSpine({
    bridge, brain, identity: fakeIdentity, router: fakeRouter, gating,
    sender: fakeSender(bridge), transcript, heartbeats, actions,
    clock: clock ?? { now: () => 1000 }, turnTimeoutMs: 0, rng,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  spine.start();
  return { spine, bridge, brain, transcript, timers };
}

const MSG = { surface: 'wa', node: 'wa', chatId: 'c@g.us', chatName: 'fam', senderId: 'u', senderName: 'Bea', msgId: 'm1', ts: 1000, body: 'hola', kind: 'text', raw: {} };
const other = (over = {}) => ({ ...MSG, isSender: false, ...over });

describe('auto dwell — a person message waits a randomized dwell before the turn', () => {
  it('does NOT fire the turn immediately — one dwell timer is armed, no brain call yet', async () => {
    const { bridge, brain, timers } = build();
    await bridge.emit(other({ body: 'hey' }));
    expect(brain.calls).toHaveLength(0);        // no instant turn
    expect(bridge.sent).toHaveLength(0);
    expect(timers.size()).toBe(1);              // exactly one pending timer: the dwell
    // rng 0.5 → 45s + 0.5*(240-45)s = 142.5s, no tail (0.5 ≥ 0.15)
    expect(timers.delays()[0]).toBe(142_500);
    await settle(timers);
    expect(brain.calls).toHaveLength(1);        // fired once the dwell expired
    expect(bridge.sent).toEqual([{ chat: MSG.chatId, text: '↩ hey', opts: expect.objectContaining({ auto: true }) }]);
  });

  it('a burst during the dwell collapses into ONE turn carrying every line in order', async () => {
    const { bridge, brain, timers } = build();
    await bridge.emit(other({ senderName: 'Bea', body: 'one', msgId: 'a' }));
    await bridge.emit(other({ senderName: 'Cy',  body: 'two', msgId: 'b' }));
    await bridge.emit(other({ senderName: 'Bea', body: 'three', msgId: 'c' }));
    expect(brain.calls).toHaveLength(0);        // still dwelling — nothing fired mid-burst
    expect(timers.size()).toBe(1);              // one dwell (re-armed), not three
    await settle(timers);
    expect(brain.calls).toHaveLength(1);        // ONE turn for the whole burst
    expect(brain.calls[0].ev.line).toBe('Bea@[fam]: one\n\nCy@[fam]: two\n\nBea@[fam]: three');
    expect(bridge.sent).toHaveLength(1);        // one reply
  });

  it('each burst message logs at arrival (received = logged); the fired turn logs REPLY-only (no double-log)', async () => {
    const { bridge, transcript, timers } = build();
    await bridge.emit(other({ body: 'one', msgId: 'a' }));
    await bridge.emit(other({ body: 'two', msgId: 'b' }));
    // two inbound logs at arrival, each an inbound-only entry (no reply, not replyOnly)
    expect(transcript.entries.filter((e) => e.reply == null)).toHaveLength(2);
    await settle(timers);
    // the fired turn adds exactly one REPLY-only entry (replyOnly:true — no inbound re-log)
    const replyEntries = transcript.entries.filter((e) => e.reply != null);
    expect(replyEntries).toHaveLength(1);
    expect(replyEntries[0].opts.replyOnly).toBe(true);
  });
});

describe('auto dwell — the reset is bounded by a hard cap from the first message', () => {
  it('the per-arm wait shrinks to the remaining cap budget and never exceeds it', async () => {
    let t = 0;
    const { bridge, timers } = build({ clock: { now: () => t } });
    t = 0;       await bridge.emit(other({ body: 'a', msgId: '1' }));   // firstAt = 0, wait = 142.5s
    expect(timers.delays()[0]).toBe(142_500);
    // jump to just under the 10-min cap, then another message: only ~1s of budget remains
    t = 599_000; await bridge.emit(other({ body: 'b', msgId: '2' }));
    expect(timers.delays()[0]).toBe(1_000);        // min(142.5s, 600s-599s) = 1s — the cap clamps it
    // past the cap entirely: the next message fires the dwell immediately (0ms)
    t = 700_000; await bridge.emit(other({ body: 'c', msgId: '3' }));
    expect(timers.delays()[0]).toBe(0);            // a chatty burst can't starve the reply past the cap
  });
});

describe('auto typing — the send is delayed by a typing-speed function of the reply length', () => {
  it('scales with reply length and floors short replies', async () => {
    // short reply: '↩ hi' = 4 chars → 4*210*jitter(1.0 at rng .5) = 840 < 2s floor → 2000
    const short = build({ brain: fakeBrain(() => '↩ hi') });
    await short.bridge.emit(other({ body: 'hi' }));
    short.timers.flush();                     // fire the dwell → turn runs → arms the typing timer
    await yieldMacro(); await yieldMacro();
    expect(short.timers.delays()).toEqual([2_000]);   // typing timer, floored

    // longer reply: 100 chars → 100*210*1.0 = 21_000ms
    const body = 'x'.repeat(98);              // '↩ ' + 98 = 100 chars
    const long = build({ brain: fakeBrain(() => `↩ ${body}`) });
    await long.bridge.emit(other({ body: 'go' }));
    long.timers.flush();
    await yieldMacro(); await yieldMacro();
    expect(long.timers.delays()).toEqual([21_000]);
  });

  it('caps the typing delay at 90s for a very long reply', async () => {
    const huge = build({ brain: fakeBrain(() => '↩ ' + 'y'.repeat(5000)) });   // ~5002 chars → way over the cap
    await huge.bridge.emit(other({ body: 'go' }));
    huge.timers.flush();
    await yieldMacro(); await yieldMacro();
    expect(huge.timers.delays()).toEqual([90_000]);   // TYPING_CAP_MS
  });
});

describe('auto dwell — a mid-dwell /e flip AWAY from auto cancels the pending dwell cleanly', () => {
  it('the dwell fires but dispatches no turn once the mode is no longer auto', async () => {
    // gating starts 'auto', then flips to 'mention' (no @e in the trigger → mayReply false)
    let mode = 'auto';
    const gating = {
      async decide() {
        if (mode === 'auto') return { mode: 'auto', receives: true, mayReply: true, sendToEgpt: 'mode' };
        return { mode: 'mention', receives: true, mayReply: false, sendToEgpt: 'mode' };
      },
      surfaces: () => true,
    };
    const { bridge, brain, timers } = build({ gating });
    await bridge.emit(other({ body: 'hey' }));   // arms the dwell (auto)
    expect(timers.size()).toBe(1);
    mode = 'mention';                            // operator does /e auto mention <chat> mid-dwell
    await settle(timers);                        // dwell fires → re-decides → not auto → drops
    expect(brain.calls).toHaveLength(0);         // NO turn fired
    expect(bridge.sent).toHaveLength(0);         // nothing sent — cancelled cleanly
  });
});

describe('auto dwell — /ask (action-only consult) is NOT typing-delayed', () => {
  it('an action-only reply fires its limb with no typing timer', async () => {
    // reply is nothing but an emitted action → no prose → no typing delay
    const actions = {
      calls: [],
      parse(raw) { return raw.includes('/ask') ? { prose: '', run: [{ kind: 'ask' }], stripped: [] } : null; },
      execute(run) { this.calls.push(run); },
    };
    const { bridge, brain, timers } = build({ brain: fakeBrain(() => '/ask should I?'), actions });
    await bridge.emit(other({ body: 'help' }));
    timers.flush();                              // fire the dwell → turn runs
    await yieldMacro(); await yieldMacro();
    expect(brain.calls).toHaveLength(1);
    expect(actions.calls).toHaveLength(1);       // the /ask limb ran
    expect(timers.size()).toBe(0);               // NO typing timer was armed (undelayed consult)
    expect(bridge.sent).toHaveLength(0);         // action-only → nothing posted to the chat
  });
});

describe('auto dwell — a message arriving while a turn is generating follows the normal dwell path', () => {
  it('the in-flight reply still sends; the new message arms a fresh dwell', async () => {
    let release;
    const brain = { calls: [], async turn(being, ev) {
      this.calls.push({ being, ev });
      if (this.calls.length === 1) await new Promise((r) => { release = r; });   // hold turn 1 open
      return { text: `↩ ${ev.body}`, sessionId: 's' };
    } };
    const { bridge, timers } = build({ brain });
    await bridge.emit(other({ body: 'one', msgId: 'a' }));
    timers.flush();                              // dwell 1 fires → turn 1 starts, then blocks
    await yieldMacro(); await yieldMacro();
    expect(brain.calls).toHaveLength(1);         // turn 1 in flight

    await bridge.emit(other({ body: 'two', msgId: 'b' }));   // arrives mid-turn → arms a NEW dwell
    expect(timers.size()).toBe(1);               // the fresh dwell for msg 'two'
    release();                                   // turn 1 completes → typing arms
    await settle(timers);                        // drain turn 1's typing + send, then dwell 2 + turn 2
    expect(brain.calls).toHaveLength(2);
    expect(bridge.sent.map((s) => s.text)).toEqual(['↩ one', '↩ two']);   // both replies delivered, in order
  });
});
