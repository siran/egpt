// Per-conversation turn queue + placeholder-on-arrival (operator 2026-07-04, the
// live "two @e mentions 27s apart" bug: one reply mangled BOTH prompts, the second
// stuck on "⏳ Thinking…"). Root cause: a second mention arriving mid-train was not
// serialized per conversation — the warm pool wove it into the running turn (both
// answers in one reply) and the two identical "Thinking…" placeholders collided on
// the bridge's newest-text id resolver (one stuck).
//
// Required behaviour (operator, verbatim intent): "accumulate messages that mention
// the model, and prompt in order, reply in order; each Sending-to message is its own
// placeholder id for the thinking train." So: each accepted mention posts its OWN
// placeholder the instant it arrives; turns run in arrival order, one at a time per
// conversation (never concurrent on the same warm key); each turn's stream edits ONLY
// its own placeholder; a queue drains even if a turn throws; different conversations
// stay fully concurrent.
//
// These tests REPRODUCE the mangle first (they fail on the pre-fix spine, which only
// opens the 2nd placeholder AFTER the 1st turn finishes), then the fix makes them pass.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../spine.mjs';

const flush = () => new Promise((r) => setTimeout(r, 0));

// A bridge whose emit() drives one inbound message (like the real onMessage → pump).
function fakeBridge() {
  let cb = null;
  return { onMessage(fn) { cb = fn; }, emit(msg) { return cb(msg); }, send() {}, stop() {} };
}

// A sender that records every placeholder it opens, plus each placeholder's own
// stream (updates / finish / fail / activate). The list order IS the arrival order.
function recordingSender() {
  const placeholders = [];
  return {
    placeholders,
    open(chatId, opts = {}) {
      const ph = { chatId, opts, updates: [], finished: null, failed: null, activated: false, openedAt: placeholders.length };
      placeholders.push(ph);
      return {
        activate() { ph.activated = true; },
        update(p) { ph.updates.push(p); },
        async finish(reply, { surface = true } = {}) { ph.finished = { text: typeof reply === 'string' ? reply : reply?.text, surface }; },
        async fail(e) { ph.failed = e?.message ?? String(e); },
      };
    },
  };
}

// A brain whose turns are gate-able and fully observable. `order` is a monotonic log
// of turn boundaries — the cleanest proof of sequential (not concurrent) execution.
// The warm key a turn WOULD open is `<being>:<surface>:<chatId>` (what the spine keys
// turnBy on, which maps 1:1 to the real warm-pool key at the being+chat granularity).
function gatedBrain({ throwOnFirst = false } = {}) {
  const calls = [];
  const order = [];
  let releaseFirst = null;
  const brain = {
    calls, order,
    releaseFirst: () => releaseFirst?.(),
    async turn(being, ev, onPartial) {
      const idx = calls.length;
      const key = `${being}:${ev.surface}:${ev.chatId}`;
      calls.push({ being, ev, key });
      order.push(`start:${ev.body}`);
      onPartial?.(`partial-${ev.body}`);                 // stream a per-turn token into THIS turn's placeholder
      if (idx === 0) {
        await new Promise((res) => { releaseFirst = res; });   // hold the first turn open (a slow turn in flight)
        if (throwOnFirst) { order.push(`throw:${ev.body}`); throw new Error(`boom-${ev.body}`); }
      }
      order.push(`end:${ev.body}`);
      return { text: `reply-${ev.body}`, sessionId: `s${idx}` };
    },
  };
  return brain;
}

const fakeIdentity = { build: (m) => ({ ...m, mention: m.mention ?? { atEStart: true, atEAnywhere: true, replyToBot: false }, line: m.body }) };
const fakeRouter = { resolve: () => ({ being: 'e', mention: { atEStart: true, atEAnywhere: true, replyToBot: false } }) };
const fakeGating = { async decide() { return { mode: 'mention', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true };
const fakeTranscript = { async log() {} };
const fakeHeartbeats = { runDue() {} };

function build(brainOpts = {}) {
  const bridge = fakeBridge();
  const sender = recordingSender();
  const brain = gatedBrain(brainOpts);
  const spine = createSpine({
    bridge, brain,
    identity: fakeIdentity, router: fakeRouter, gating: fakeGating,
    sender, transcript: fakeTranscript, heartbeats: fakeHeartbeats,
    clock: { now: () => 1000 },
  });
  spine.start();
  return { spine, bridge, sender, brain };
}

const CHAT = 'chat-A@g.us';
const mention = (body, msgId) => ({ surface: 'wa', node: 'wa', chatId: CHAT, chatName: 'fam', senderId: 'u', senderName: 'An', msgId, ts: 1000, body, kind: 'text', raw: {} });

describe('spine — per-conversation turn queue + placeholder-on-arrival', () => {
  it('(a) two mentions back-to-back: BOTH placeholders open at arrival, in order, while turn 1 is still in flight', async () => {
    const { bridge, sender, brain } = build();
    const p1 = bridge.emit(mention('one', 'm1'));       // turn 1 gates open
    const p2 = bridge.emit(mention('two', 'm2'));        // arrives mid-train
    await flush();

    // Both placeholders exist NOW — the 2nd did NOT wait for the 1st turn to finish.
    expect(sender.placeholders).toHaveLength(2);
    expect(sender.placeholders[0].opts.queued).toBe(false);                       // 1st: runs immediately
    expect(sender.placeholders[1].opts).toMatchObject({ queued: true, queuedAhead: 1 });   // 2nd: queued behind it
    // Only turn 1 has started (turn 2 waits its turn — not concurrent).
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].ev.body).toBe('one');

    brain.releaseFirst();
    await Promise.all([p1, p2]);
  });

  it('(b) turns run() sequentially — turn 2 starts only after turn 1 resolves, same warm key, in arrival order', async () => {
    const { bridge, brain } = build();
    const p1 = bridge.emit(mention('one', 'm1'));
    const p2 = bridge.emit(mention('two', 'm2'));
    await flush();

    expect(brain.order).toEqual(['start:one']);          // turn 2 has NOT started while turn 1 is in flight
    brain.releaseFirst();
    await Promise.all([p1, p2]);

    expect(brain.order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);   // strictly sequential
    expect(brain.calls.map((c) => c.ev.body)).toEqual(['one', 'two']);               // arrival order
    expect(brain.calls[0].key).toBe(brain.calls[1].key);                             // same warm key
  });

  it('(c) each turn streams into its OWN placeholder — no cross-edit', async () => {
    const { bridge, sender, brain } = build();
    const p1 = bridge.emit(mention('one', 'm1'));
    const p2 = bridge.emit(mention('two', 'm2'));
    await flush();

    // Turn 1's token landed on placeholder 1; placeholder 2 is untouched (its turn hasn't run).
    expect(sender.placeholders[0].updates).toEqual(['partial-one']);
    expect(sender.placeholders[1].updates).toEqual([]);

    brain.releaseFirst();
    await Promise.all([p1, p2]);

    expect(sender.placeholders[0].updates).toEqual(['partial-one']);
    expect(sender.placeholders[1].updates).toEqual(['partial-two']);
    expect(sender.placeholders[0].finished.text).toBe('reply-one');
    expect(sender.placeholders[1].finished.text).toBe('reply-two');
    expect(sender.placeholders[1].activated).toBe(true);                 // the queued one flipped live when its turn began
  });

  it('(d) a queued turn still runs when the first turn THROWS: queue drains, turn 1 fails visibly, turn 2 delivers', async () => {
    const { bridge, sender, brain } = build({ throwOnFirst: true });
    const p1 = bridge.emit(mention('one', 'm1'));
    const p2 = bridge.emit(mention('two', 'm2'));
    await flush();

    brain.releaseFirst();                                 // turn 1 throws
    await Promise.all([p1, p2]);

    expect(sender.placeholders[0].failed).toMatch(/boom-one/);           // 1st placeholder shows the failure
    expect(brain.calls.map((c) => c.ev.body)).toEqual(['one', 'two']);   // turn 2 still ran
    expect(sender.placeholders[1].finished.text).toBe('reply-two');      // 2nd placeholder resolved
  });

  it('different conversations run fully concurrently (no head-of-line blocking across chats)', async () => {
    const { bridge, brain } = build();
    const pA = bridge.emit({ ...mention('a', 'm1'), chatId: 'chat-A@g.us' });   // gates open (turn 1)
    const pB = bridge.emit({ ...mention('b', 'm2'), chatId: 'chat-B@g.us' });   // a DIFFERENT chat
    await flush();

    // chat B's turn is NOT stuck behind chat A's in-flight turn — it started AND
    // finished while chat A is still gated open (global-pump blocking would show
    // neither 'start:b' nor 'end:b' until 'end:a').
    expect(brain.order).toContain('start:b');
    expect(brain.order).toContain('end:b');
    expect(brain.order).not.toContain('end:a');
    brain.releaseFirst();
    await Promise.all([pA, pB]);
  });
});
