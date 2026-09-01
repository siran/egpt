// STEERING A LIVE TURN — `allow_new_input` (operator's ruling 2026-08-30).
//
// Until now a message arriving while a conversation's turn was still streaming ALWAYS queued
// on the spine's per-conversation FIFO (turnBy) and was prompted into the NEXT turn, under its
// own placeholder. That is still the default for `none`. What is new: the message can instead
// be WOVEN INTO the turn already running, which then answers it — in ONE reply, with no second
// placeholder and no second turn.
//
// WHY IT WORKS: measured 2026-08-30 against the real `claude --input-format stream-json` CLI.
// A second user line written to a live stdin mid-turn is ABSORBED by an AGENTIC turn at a tool
// boundary (one result, answering the NEW instruction, 4 of 6 planned Reads abandoned, then
// 143s of silence — no second result), while a PURE-TEXT turn instead finishes its original
// task and answers the new message separately. See warm-cli-session.mjs's header.
//
// THE ORDERED ENUM (default same_sender, ONLY TESTED WITH ccode):
//   none         queue it — today's behavior, byte for byte.
//   same_sender  the sender the live turn is ALREADY answering steers it; anyone else queues.
//   any          any sender in the conversation steers it.
//
// The spine owns HALF the decision — WHOSE message the live turn is answering — because that
// identity exists nowhere else (`trains` is a count, not an identity). brainpool owns the
// other half (resolving the two config tiers) and the weave itself. Both brain seams are
// OPTIONAL: a Brain with neither can never steer, which is what makes every older caller and
// every non-ccode brain byte-identical to before.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createTurns } from '../src/spine/turns.mjs';

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeBridge({ reactThrows = false } = {}) {
  let cb = null;
  const reactions = [];
  return {
    reactions,
    onMessage(fn) { cb = fn; },
    emit(msg) { return cb(msg); },
    send() {},
    stop() {},
    async react(chatId, msgId, emoji) {
      reactions.push({ chatId, msgId, emoji });
      if (reactThrows) throw new Error('reaction boom');
      return true;
    },
  };
}

// Records every placeholder opened and what it resolved to. A STEERED message must add
// nothing here at all — no placeholder is the whole visible contract.
function recordingSender() {
  const placeholders = [];
  return {
    placeholders,
    open(chatId, opts = {}) {
      const ph = { chatId, opts, updates: [], finished: null, failed: null, activated: false };
      placeholders.push(ph);
      return {
        activate() { ph.activated = true; },
        update(p) { ph.updates.push(p); },
        async finish(reply, { surface = true } = {}) { ph.finished = { text: typeof reply === 'string' ? reply : reply?.text, surface }; },
        async fail(e) { ph.failed = e?.message ?? String(e); },
        confirmedId: Promise.resolve(null),
      };
    },
  };
}

// A Brain whose first turn hangs (so a second message genuinely arrives MID-TURN) and whose
// steer seams are scriptable. `hasSeams:false` models a Brain that predates the feature — and,
// equivalently, a spine wired to one; `steerTakes:false` models what llama/pi actually produce
// (no session-level inject(), so the pool refuses and NOTHING happened).
// `scopeOf` models a SHARED SCOPE — the seam turns.keyOf resolves the turn key through, which is
// what lets several chats land on ONE key (a WhatsApp group invited into a room runs on the
// ROOM's thread and the ROOM's warm process). Omitted ⇒ no seam at all, i.e. key = the event's
// own address, which is what every other test here uses.
function steerableBrain({ allow = 'same_sender', steerTakes = true, hasSeams = true, throwOnFirst = false, scopeOf = null } = {}) {
  const calls = [], steered = [], allowAsked = [], order = [];
  let releaseFirst = null;
  const brain = {
    calls, steered, allowAsked, order,
    releaseFirst: () => releaseFirst?.(),
    async turn(being, ev) {
      const idx = calls.length;
      calls.push({ being, ev, key: `${being}:${ev.surface}:${ev.chatId}` });
      order.push(`start:${ev.body}`);
      if (idx === 0) {
        await new Promise((res) => { releaseFirst = res; });
        if (throwOnFirst) { order.push(`throw:${ev.body}`); throw new Error(`boom-${ev.body}`); }
      }
      order.push(`end:${ev.body}`);
      return { text: `reply-${ev.body}`, sessionId: `s${idx}` };
    },
  };
  if (hasSeams) {
    brain.allowNewInput = async (being, ev) => { allowAsked.push({ being, body: ev.body }); return allow; };
    brain.steer = (being, ev) => { if (!steerTakes) return false; steered.push(ev.body); return true; };
  }
  if (scopeOf) brain.scopeOf = scopeOf;
  return brain;
}

const fakeIdentity = { build: (m) => ({ ...m, mention: m.mention ?? { atEStart: true, atEAnywhere: true, replyToBot: false }, line: m.body }) };
const fakeRouter = { resolve: () => ({ being: 'e', mention: { atEStart: true, atEAnywhere: true, replyToBot: false } }) };
const fakeGating = { async decide() { return { mode: 'mention', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true };
const fakeHeartbeats = { runDue() {} };

function build(brainOpts = {}, bridgeOpts = {}) {
  const bridge = fakeBridge(bridgeOpts);
  const sender = recordingSender();
  const brain = steerableBrain(brainOpts);
  const logged = [];                                    // [ev.body, isReply] per transcript.log call
  const notes = [];
  const spine = createSpine({
    bridge, brain,
    identity: fakeIdentity, router: fakeRouter, gating: fakeGating,
    sender,
    transcript: { async log(ev, reply) { logged.push({ body: ev.body, reply: reply ? (reply.text ?? '') : null }); } },
    heartbeats: fakeHeartbeats,
    clock: { now: () => 1000 },
    log: { line: (s) => notes.push(s) },
  });
  spine.start();
  return { spine, bridge, sender, brain, logged, notes };
}

const CHAT = 'chat-A@g.us';
const msg = (body, msgId, senderId = 'an', chatId = CHAT) => ({
  surface: 'wa', node: 'wa', chatId, chatName: 'fam',
  senderId, senderName: senderId, msgId, ts: 1000, body, kind: 'text', raw: {},
});

describe('spine — allow_new_input steers the live turn (operator 2026-08-30)', () => {
  it("'none' QUEUES exactly as today: its own placeholder, its own turn, nothing steered", async () => {
    const { bridge, sender, brain } = build({ allow: 'none' });
    const p1 = bridge.emit(msg('one', 'm1'));
    await flush();
    const p2 = bridge.emit(msg('two', 'm2'));            // same sender, mid-turn
    await flush();

    expect(brain.steered).toEqual([]);
    expect(sender.placeholders).toHaveLength(2);
    expect(sender.placeholders[1].opts).toMatchObject({ queued: true, queuedAhead: 1 });
    brain.releaseFirst();
    await Promise.all([p1, p2]);
    expect(brain.order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });

  it("'same_sender' + the SAME sender: woven into the live turn — NO second placeholder, NO second turn, NO second reply", async () => {
    const { bridge, sender, brain } = build({ allow: 'same_sender' });
    const p1 = bridge.emit(msg('one', 'm1', 'an'));
    await flush();
    const p2 = bridge.emit(msg('actually do X', 'm2', 'an'));
    await flush();

    expect(brain.steered).toEqual(['actually do X']);    // woven in
    expect(sender.placeholders).toHaveLength(1);         // THE stray-"…" guard: no 2nd placeholder
    expect(brain.calls).toHaveLength(1);                 // no 2nd turn queued behind
    brain.releaseFirst();
    await Promise.all([p1, p2]);
    // Still ONE placeholder and ONE turn once everything settles — the live turn's single
    // result is the combined reply.
    expect(sender.placeholders).toHaveLength(1);
    expect(sender.placeholders[0].finished).toEqual({ text: 'reply-one', surface: true });
    expect(brain.order).toEqual(['start:one', 'end:one']);
  });

  // The operator's ask (2026-08-30): a woven message gets no placeholder/reply of its own, so
  // without SOME ack its sender sees nothing until the live turn's eventual answer. A successful
  // steer must react on the STEERED message itself (its own chatId/msgId), not the one that's
  // already streaming — using the SAME bridge.react primitive the /react limb uses.
  it('a successful steer ACKs the steered message with a reaction (not a new placeholder/reply)', async () => {
    const { bridge, sender, brain } = build({ allow: 'any' });
    const p1 = bridge.emit(msg('one', 'm1', 'an'));
    await flush();
    const p2 = bridge.emit(msg('actually do X', 'm2', 'someone-else'));
    await flush();

    expect(brain.steered).toEqual(['actually do X']);
    expect(bridge.reactions).toEqual([{ chatId: CHAT, msgId: 'm2', emoji: '👀' }]);
    expect(sender.placeholders).toHaveLength(1);          // still no second placeholder
    brain.releaseFirst();
    await Promise.all([p1, p2]);
  });

  // Best-effort (operator constraint): a reaction fault must never undo a steer that already
  // landed — the woven message stays woven, and the turn resolves exactly as it would have.
  it('a reaction FAILURE does not break the steer — the weave still lands', async () => {
    const { bridge, sender, brain } = build({ allow: 'any' }, { reactThrows: true });
    const p1 = bridge.emit(msg('one', 'm1', 'an'));
    await flush();
    const p2 = bridge.emit(msg('actually do X', 'm2', 'someone-else'));
    await flush();

    expect(brain.steered).toEqual(['actually do X']);     // still woven despite the reaction throwing
    expect(bridge.reactions).toHaveLength(1);              // the attempt was made
    expect(sender.placeholders).toHaveLength(1);
    brain.releaseFirst();
    await expect(Promise.all([p1, p2])).resolves.toBeDefined();  // never throws out to the caller
    expect(sender.placeholders[0].finished).toEqual({ text: 'reply-one', surface: true });
  });

  it("'same_sender' + a DIFFERENT sender QUEUES (the bystander does not get to redirect someone else's answer)", async () => {
    const { bridge, sender, brain } = build({ allow: 'same_sender' });
    const p1 = bridge.emit(msg('one', 'm1', 'an'));
    await flush();
    const p2 = bridge.emit(msg('two', 'm2', 'someone-else'));
    await flush();

    expect(brain.steered).toEqual([]);
    expect(sender.placeholders).toHaveLength(2);
    expect(brain.calls).toHaveLength(1);                 // queued, not concurrent
    brain.releaseFirst();
    await Promise.all([p1, p2]);
    expect(brain.order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });

  it("'any' steers even from a DIFFERENT sender", async () => {
    const { bridge, sender, brain } = build({ allow: 'any' });
    const p1 = bridge.emit(msg('one', 'm1', 'an'));
    await flush();
    const p2 = bridge.emit(msg('two', 'm2', 'someone-else'));
    await flush();

    expect(brain.steered).toEqual(['two']);
    expect(sender.placeholders).toHaveLength(1);
    brain.releaseFirst();
    await Promise.all([p1, p2]);
    expect(brain.calls).toHaveLength(1);
  });

  // STRUCTURAL SAFETY (operator 2026-08-30). llama is plain HTTP request/response with no
  // stream to interrupt, and pi is a different, UNTESTED harness; neither exports the
  // session-level inject() this rides on, so the warm pool's steer refuses and reports FALSE.
  // False means NOTHING HAPPENED — so the spine must fall straight through to today's
  // queueing, placeholder and all. (Locked at the pool end too: warm-sessions.test.mjs.)
  it("a brain that CANNOT weave queues exactly as today, even with allow_new_input 'any'", async () => {
    const { bridge, sender, brain } = build({ allow: 'any', steerTakes: false });
    const p1 = bridge.emit(msg('one', 'm1'));
    await flush();
    const p2 = bridge.emit(msg('two', 'm2'));
    await flush();

    expect(brain.steered).toEqual([]);
    expect(sender.placeholders).toHaveLength(2);         // the fallthrough opened a real placeholder
    expect(sender.placeholders[1].opts).toMatchObject({ queued: true, queuedAhead: 1 });
    brain.releaseFirst();
    await Promise.all([p1, p2]);
    expect(brain.order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
    expect(sender.placeholders[1].finished).toEqual({ text: 'reply-two', surface: true });
  });

  it('a Brain with NO steer seams at all never steers — byte-identical to before the feature', async () => {
    const { bridge, sender, brain } = build({ hasSeams: false });
    const p1 = bridge.emit(msg('one', 'm1'));
    await flush();
    const p2 = bridge.emit(msg('two', 'm2'));
    await flush();

    expect(sender.placeholders).toHaveLength(2);
    brain.releaseFirst();
    await Promise.all([p1, p2]);
    expect(brain.order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });

  it('an IDLE key is never steered — nothing is streaming, so the policy is not even consulted', async () => {
    const { bridge, sender, brain } = build({ allow: 'any' });
    const p1 = bridge.emit(msg('one', 'm1'));
    await flush();
    brain.releaseFirst();
    await p1;                                            // turn 1 finished → the key is idle again
    const p2 = bridge.emit(msg('two', 'm2'));
    await flush();
    await p2;

    expect(brain.allowAsked).toEqual([]);                // short-circuited on "nothing in flight"
    expect(brain.steered).toEqual([]);
    expect(sender.placeholders).toHaveLength(2);
    expect(sender.placeholders[1].opts.queued).toBe(false);   // an ordinary immediate turn
  });

  // The live-turn identity is cleared in the SAME `finally` that drops the train, so the throw
  // path frees it too. Were it leaked, every later message on this key would try to steer a
  // turn that is long gone — and the pool would refuse each one, silently costing a round trip.
  it('the live-turn identity is released when the turn THROWS, so the next message queues normally', async () => {
    const { bridge, sender, brain } = build({ allow: 'any', throwOnFirst: true });
    const p1 = bridge.emit(msg('one', 'm1'));
    await flush();
    brain.releaseFirst();
    await p1;
    expect(brain.order).toContain('throw:one');
    expect(sender.placeholders[0].failed).toMatch(/boom-one/);   // resolved VISIBLY, not stuck

    const p2 = bridge.emit(msg('two', 'm2'));
    await flush();
    await p2;
    expect(brain.allowAsked).toEqual([]);                // the dead turn's slot was not left claimed
    expect(brain.steered).toEqual([]);
    expect(sender.placeholders).toHaveLength(2);
    expect(sender.placeholders[1].opts.queued).toBe(false);
  });

  // INGESTION IS UPSTREAM OF ALL OF THIS (operator 2026-07-25: "there must only be one path
  // for message ingestion, digestion and dispatching"). handleFast records the inbound line
  // at ARRIVAL — `await transcript.log(ev)`, before `act()` ever runs — and steering only
  // changes what happens to the message AFTER that. A steered message is therefore on the
  // record exactly once, like every other message, even though it produces no reply of its own.
  it('a STEERED message is still recorded exactly once — steering is downstream of ingestion', async () => {
    const { bridge, brain, logged } = build({ allow: 'same_sender' });
    const p1 = bridge.emit(msg('one', 'm1'));
    await flush();
    const p2 = bridge.emit(msg('two', 'm2'));
    await flush();

    expect(brain.steered).toEqual(['two']);
    // Both inbound lines are on the record; only the live turn appends a REPLY.
    expect(logged.filter((l) => l.reply === null).map((l) => l.body)).toEqual(['one', 'two']);
    brain.releaseFirst();
    await Promise.all([p1, p2]);
    expect(logged.filter((l) => l.reply !== null)).toHaveLength(1);
    expect(logged.filter((l) => l.body === 'two')).toHaveLength(1);   // recorded ONCE, never twice
  });

  it('the steer is noted with the resolved policy (the silent path is loud)', async () => {
    const { bridge, brain, notes } = build({ allow: 'any' });
    const p1 = bridge.emit(msg('one', 'm1'));
    await flush();
    const p2 = bridge.emit(msg('two', 'm2'));
    await flush();
    brain.releaseFirst();
    await Promise.all([p1, p2]);
    expect(notes.join('\n')).toMatch(/steer e\/chat-A@g\.us: wove .* into the live turn \(allow_new_input=any\)/);
  });

  it('a THIRD message steers the same live turn (the weave is not one-shot)', async () => {
    const { bridge, sender, brain } = build({ allow: 'same_sender' });
    const p1 = bridge.emit(msg('one', 'm1'));
    await flush();
    const p2 = bridge.emit(msg('two', 'm2'));
    await flush();
    const p3 = bridge.emit(msg('three', 'm3'));
    await flush();

    expect(brain.steered).toEqual(['two', 'three']);
    expect(sender.placeholders).toHaveLength(1);
    brain.releaseFirst();
    await Promise.all([p1, p2, p3]);
    expect(brain.calls).toHaveLength(1);
  });
});

// A SHARED SCOPE PUTS SEVERAL CHATS ON ONE TURN KEY (operator 2026-09-01).
//
// The verdict above compared the SENDER and nothing else, which was sufficient only while a turn
// key meant exactly one chat. It no longer does: turns.keyOf resolves the key through
// brain.scopeOf, so a WhatsApp group invited into a room runs on the ROOM's key — room/acim and
// the group "perrito traduciones" share one today.
//
// THE LIVE FAULT: a group member writes while the ROOM's turn is streaming. Same key, and the
// sender passes ('any', or the same person under 'same_sender') ⇒ his line is woven in. But a
// woven message makes its caller produce NOTHING for its conversation — no placeholder, no reply,
// only a 👀 — and the live turn's single answer is delivered to the LIVE TURN'S origin, the room.
// His question is answered where he cannot read it, and all he ever sees is an eye.
//
// The operator's ruling: the unit is the PAIR. "Keep the same sender+group: add, different
// sender+group: enqueue." So the CHAT must match for ANY steer, in both tiers; the sender must
// match on top of that only under 'same_sender'. Queueing is today's safe behaviour and produces
// a real reply in the right chat.
describe("spine — a SHARED SCOPE puts two chats on one key; only the live turn's OWN chat may steer it", () => {
  const ROOM = 'room-acim';
  const GROUP = 'perrito-traducciones@g.us';
  // Both chats resolve to the ROOM's instance: one warm key, one queue, ONE turn key.
  const sharedScope = { scopeOf: async () => ({ surface: 'wa', chatId: ROOM }) };

  it("REPRODUCE: a line from the GROUP is NOT woven into the ROOM's live turn — it queues and is answered in its OWN chat", async () => {
    const { bridge, sender, brain } = build({ allow: 'any', ...sharedScope });
    const p1 = bridge.emit(msg('one', 'm1', 'an', ROOM));
    await flush();
    const p2 = bridge.emit(msg('two', 'm2', 'marina', GROUP));   // same key, other chat, mid-turn
    await flush();

    expect(brain.steered).toEqual([]);                    // was ['two'] — woven into the ROOM's turn
    expect(bridge.reactions).toEqual([]);                 // …and the 👀 was all the group ever saw
    expect(sender.placeholders).toHaveLength(2);
    expect(sender.placeholders[1].chatId).toBe(GROUP);    // a real reply, in the chat that asked
    expect(sender.placeholders[1].opts).toMatchObject({ queued: true, queuedAhead: 1 });
    brain.releaseFirst();
    await Promise.all([p1, p2]);
    expect(sender.placeholders[1].finished).toEqual({ text: 'reply-two', surface: true });
    expect(brain.order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });

  it("'same_sender' does not override the chat: the SAME person writing from the other chat still queues", async () => {
    const { bridge, sender, brain } = build({ allow: 'same_sender', ...sharedScope });
    const p1 = bridge.emit(msg('one', 'm1', 'an', ROOM));
    await flush();
    const p2 = bridge.emit(msg('two', 'm2', 'an', GROUP));       // same sender, different chat
    await flush();

    expect(brain.steered).toEqual([]);
    expect(sender.placeholders).toHaveLength(2);
    expect(sender.placeholders[1].chatId).toBe(GROUP);
    brain.releaseFirst();
    await Promise.all([p1, p2]);
    expect(brain.order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });

  // The other half of the ruling, and the proof this is a NO-OP wherever the chat matches: inside
  // ONE chat a shared scope changes nothing, in either tier.
  it("the SAME chat still steers under 'same_sender' from the same person — unchanged", async () => {
    const { bridge, sender, brain } = build({ allow: 'same_sender', ...sharedScope });
    const p1 = bridge.emit(msg('one', 'm1', 'an', GROUP));
    await flush();
    const p2 = bridge.emit(msg('actually do X', 'm2', 'an', GROUP));
    await flush();

    expect(brain.steered).toEqual(['actually do X']);
    expect(sender.placeholders).toHaveLength(1);
    expect(brain.calls).toHaveLength(1);
    brain.releaseFirst();
    await Promise.all([p1, p2]);
  });

  it("the SAME chat still steers under 'any' from a DIFFERENT sender — unchanged", async () => {
    const { bridge, sender, brain } = build({ allow: 'any', ...sharedScope });
    const p1 = bridge.emit(msg('one', 'm1', 'an', GROUP));
    await flush();
    const p2 = bridge.emit(msg('two', 'm2', 'marina', GROUP));
    await flush();

    expect(brain.steered).toEqual(['two']);
    expect(sender.placeholders).toHaveLength(1);
    brain.releaseFirst();
    await Promise.all([p1, p2]);
    expect(brain.calls).toHaveLength(1);
  });

  // FAIL CLOSED. admitsNewInput is THE one verdict, and steerRelayedTurn hands it a live record
  // built OUTSIDE this module (mesh.relayInFlight). A record with no chat on it is a caller that
  // forgot to record one, and it must QUEUE — never steer. Same convention as the policy
  // allowlist: an unexpected value falls to today's behavior, never to the widest one.
  it("a live record with NO chatId is never steered, even under 'any'", async () => {
    const turns = createTurns({ brain: { async allowNewInput() { return 'any'; }, steer: () => true } });
    const ev = { surface: 'wa', chatId: ROOM, senderId: 'an', body: 'two' };

    expect(await turns.steerRelayedTurn({ to: 'e', ev, live: { senderId: 'an' } })).toBe(false);
    // …and the very same record WITH the chat steers, so it is the missing field that decided it.
    expect(await turns.steerRelayedTurn({ to: 'e', ev, live: { senderId: 'an', chatId: ROOM } })).toBe(true);
  });
});
