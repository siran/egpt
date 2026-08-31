// room-relay.test.mjs — Command Surface Phase 4, design B (re-entry). The reproduce-first
// suite for the room brain-member fan-out wired at the spine chokepoint:
//   1. a brain member's MODE gates delivery (muted→never, mention→@<id> only, active→every msg);
//   2. the member's reply RE-ENTERS as a synthetic NON-human turn — counted EXACTLY ONCE by the
//      guard and logged once (phase-3 tie);
//   3. two `active` brains answering each other are BOUNDED at guard.turns;
//   4. E participates in the brain chatter per its OWN mode (the reply reaches E via re-entry).
// …and, since 2026-08-31, THE SAME re-entry carrying an invited group's message into the room it
// joined — so a group triggers that room's agents — with a LOOP SAFETY suite at the bottom that
// builds each of the four cycles that opens up and names the structural stop for each.
//
// Uses the REAL identity (so the { body, from } synthetic re-entry carries fromMember through
// identity.build), the REAL guard, and the REAL room relay — fakes only at the CDP seam
// (streamFromTab), the member store (resolveMembers), the adapter driver, and the sender.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createRoomRelay } from '../src/spine/room-relay.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { encodeNodeSignature } from '../src/node-signature.mjs';

const identity = createIdentity({ now: () => 1000 });

// A human inbound in the { body, from } shape the REAL identity.build consumes. network
// 'whatsapp' → surface 'whatsapp'; a stable room chatId. authorized (a bare STOP would be
// honored — the bodies here are never safe-words).
function human(body, { chatId = 'room-1', msgId = 'm1' } = {}) {
  return { body, from: { network: 'whatsapp', chatId, chatName: 'devroom', userId: 'u-an', senderName: 'An', authorized: true, msgKey: msgId } };
}

function harness({ members = [], eGating, turns = 6, tunnelRooms = null, tunnelEverySurface = false } = {}) {
  const relayCalls = [];
  const activateCalls = [];
  const callOrder = [];
  const posts = [];
  let seq = 0;
  const bridge = { sent: [], onMessage() {}, send(chat, text, opts) { this.sent.push({ chat, text, opts }); }, stop() {}, wasSentByUs: () => false };
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, body: ev.body, surface: ev.surface, chatId: ev.chatId }); return { text: `E:${ev.body}`, sessionId: 's1' }; } };
  const router = { resolve: () => 'e' };
  // Default E gating: receives but never replies, so the brain fan-out is isolated. The
  // participation test overrides it with a real 'on' gate.
  const gating = eGating ?? { async decide() { return { mode: 'mention', receives: true, mayReply: false, sendToEgpt: 'mode' }; }, surfaces: () => false };
  const transcript = { entries: [], async log(ev) { this.entries.push({ surface: ev.surface, chatId: ev.chatId, body: ev.body, fromMember: ev.fromMember ?? null }); } };
  const heartbeats = { runDue() {} };
  // E's persona sender — replies land in bridge.sent (distinct from member posts).
  const sender = { open(chatId, { replyTo } = {}) { return { activate() {}, update() {}, async finish(r, { surface = true } = {}) { const t = typeof r === 'string' ? r : r?.text; if (surface && t) bridge.send(chatId, t, { replyTo }); }, fail() {} }; } };

  const guard = createStopGuard({ turns });

  const roomRelay = createRoomRelay({
    // Mirrors boot.mjs createMemberResolver: the conversation's OWN roster, plus — non-enumerably
    // — the room name(s) the reverse lookup found this chat invited into. In the TUNNEL shape
    // (`tunnelRooms` set) the members live in the ROOM's config and nowhere else: the invited
    // group's own conversation-room is EMPTY and carries only the tunnel, which is exactly what
    // `/members add group` writes and what the reverse lookup reads back. The reverse lookup does
    // not run on surface `room` there (a tunnel starts at a surface chat and ends in a room), so
    // the fake honours the same rule — and `tunnelEverySurface` deliberately BREAKS it, to prove
    // the relay's own one-hop lock does not depend on a well-behaved resolver.
    resolveMembers: async (surface) => {
      if (!tunnelRooms) return members.slice();
      const roster = surface === 'room' ? members.slice() : [];
      if (tunnelEverySurface || surface !== 'room') {
        Object.defineProperty(roster, 'tunnelRooms', { value: tunnelRooms, enumerable: false });
      }
      return roster;
    },
    adapterOf: async () => ({ injectScript: (t) => `INJECT[${t}]`, pollScript: 'POLL' }),
    // The fake focus seam: record the drive so tests can assert it fires BEFORE streamFromTab.
    activateTarget: async (targetId) => {
      activateCalls.push(targetId);
      callOrder.push(`activate:${targetId}`);
    },
    // The fake CDP seam: record the drive, emit a partial, return a unique reply.
    streamFromTab: async ({ targetId, injectScript, pollScript, onUpdate }) => {
      relayCalls.push({ targetId, injectScript, pollScript });
      callOrder.push(`stream:${targetId}`);
      onUpdate?.('…partial…');
      return `brain-reply-${++seq}`;
    },
    // The member-stamped sender (a brain member isn't an agent) — records the posted reply.
    openStream: (memberId, chatId, opts) => {
      const rec = { memberId, chatId, opts, updates: [], final: null };
      posts.push(rec);
      return { update: (t) => rec.updates.push(t), finish: async (r) => { rec.final = typeof r === 'string' ? r : r?.text; }, fail: async () => {} };
    },
    onLog: () => {},
  });

  const spine = createSpine({
    bridge, brain, identity, router, gating, sender, transcript, heartbeats,
    guard, roomRelay, clock: { now: () => 1000 }, turnTimeoutMs: 0,
  });
  return { spine, bridge, brain, transcript, guard, relayCalls, activateCalls, callOrder, posts, channel: 'whatsapp:room-1' };
}

describe('room relay — brain-member gated delivery (mode)', () => {
  it('mention member: @<id> relays the STRIPPED text and posts the reply; a non-addressing message does NOT reach it', async () => {
    const members = [{ id: 'chatgpt', kind: 'brain', state: 'mention', adapter: 'chatgpt-cdp', targetId: 'T1' }];
    const { spine, relayCalls, posts } = harness({ members });

    await spine.handleInbound(human('@chatgpt summarize this'));
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0].targetId).toBe('T1');
    expect(relayCalls[0].injectScript).toBe('INJECT[summarize this]');   // @chatgpt stripped before relay
    expect(relayCalls[0].pollScript).toBe('POLL');
    expect(posts).toHaveLength(1);
    expect(posts[0].final).toBe('brain-reply-1');                        // the reply streamed into the room

    // a message that does NOT address @chatgpt is not delivered to a mention-mode member
    await spine.handleInbound(human('just chatting here', { msgId: 'm2' }));
    expect(relayCalls).toHaveLength(1);
  });

  it('muted member: NOTHING reaches it, even an @<id> message', async () => {
    const members = [{ id: 'chatgpt', kind: 'brain', state: 'muted', adapter: 'chatgpt-cdp', targetId: 'T1' }];
    const { spine, relayCalls } = harness({ members });
    await spine.handleInbound(human('@chatgpt hello'));
    expect(relayCalls).toHaveLength(0);
  });

  it('active member: EVERY room message reaches it (no mention needed, whole body relayed)', async () => {
    const members = [{ id: 'chatgpt', kind: 'brain', state: 'active', adapter: 'chatgpt-cdp', targetId: 'T1' }];
    const { spine, relayCalls } = harness({ members });
    await spine.handleInbound(human('anything at all'));
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0].injectScript).toBe('INJECT[anything at all]');
  });

  it('an inactive member (no live targetId) is skipped — no relay to a closed tab', async () => {
    const members = [{ id: 'chatgpt', kind: 'brain', state: 'active', adapter: 'chatgpt-cdp', targetId: null }];
    const { spine, relayCalls } = harness({ members });
    await spine.handleInbound(human('anyone home?'));
    expect(relayCalls).toHaveLength(0);
  });

  it('focuses the tab BEFORE injecting — activateTarget(targetId) runs ahead of streamFromTab (Chrome throttles background tabs)', async () => {
    const members = [{ id: 'chatgpt', kind: 'brain', state: 'active', adapter: 'chatgpt-cdp', targetId: 'T1' }];
    const { spine, activateCalls, callOrder, relayCalls } = harness({ members });
    await spine.handleInbound(human('anything at all'));
    expect(relayCalls).toHaveLength(1);
    expect(activateCalls).toEqual(['T1']);
    expect(callOrder).toEqual(['activate:T1', 'stream:T1']);
  });
});

describe('room relay — the reply counts as exactly ONE non-human turn (phase-3 guard tie)', () => {
  it('human resets, the single brain reply counts once, and is transcript-logged exactly once', async () => {
    const members = [{ id: 'chatgpt', kind: 'brain', state: 'active', adapter: 'chatgpt-cdp', targetId: 'T1' }];
    const { spine, guard, channel, transcript, relayCalls } = harness({ members });

    await spine.handleInbound(human('hi'));
    expect(relayCalls).toHaveLength(1);
    expect(guard.countOf(channel)).toBe(1);                 // human reset to 0, the ONE brain reply counted once

    // logged exactly once (C1.2), tagged with the brain's provenance (fromMember)
    const brainLogs = transcript.entries.filter((e) => e.fromMember?.id === 'chatgpt');
    expect(brainLogs).toHaveLength(1);
    expect(brainLogs[0].body).toBe('brain-reply-1');

    // a second genuine human turn RESETS again — proving the human was never miscounted as non-human
    await spine.handleInbound(human('hey again', { msgId: 'm2' }));
    expect(guard.countOf(channel)).toBe(1);                 // reset to 0, then its one reply → 1 (never 2)
  });
});

describe('room relay — two active brains answering each other halt at guard.turns', () => {
  it('bounded: relays stop, the channel is blocked, the counter saturates at turns', async () => {
    const members = [
      { id: 'aa', kind: 'brain', state: 'active', adapter: 'chatgpt-cdp', targetId: 'T-A' },
      { id: 'bb', kind: 'brain', state: 'active', adapter: 'chatgpt-cdp', targetId: 'T-B' },
    ];
    const turns = 4;
    const { spine, guard, channel, relayCalls } = harness({ members, turns });

    await spine.handleInbound(human('kick it off'));

    // every re-entered reply is one non-human turn; the guard trips at `turns`, and each relay
    // is gated on !blocked, so the fan-out cannot run past the cap (no infinite brain↔brain loop).
    expect(guard.blocked(channel)).toBe(true);
    expect(guard.countOf(channel)).toBe(turns);
    expect(relayCalls.length).toBe(turns);
  });
});

// ── wa-group members: the room as a TUNNEL between groups (operator 2026-08-29) ──────────
//
// A `wa-group` member is a WhatsApp group INVITED into the room (`/members add group <chatId>`);
// several groups may join the same room, and they share the roster with the brain members. It is
// fanned out to by the SAME loop and gated by the SAME admits(); only the delivery differs — a
// send to that group's OWN chat id (m.id), never an injection into a tab and never into ev.chatId.
//
// The correctness risk is a PING-PONG: two groups in one room answering each other forever. The
// origin is never delivered its own line — `m.id === ev.chatId` here, where the room IS the chat,
// and `ev.fromMember.id === m.id` once the line has been re-addressed into a room it tunnels into
// (the LOOP SAFETY suite at the bottom of this file builds every such cycle and shows its stop).
describe('room relay — a wa-group member is a CHAT the room fans out to', () => {
  const A = 'room-1';        // the chat every human() below arrives in
  const B = 'group-B';

  it('the other group receives it in ITS OWN chat id, stamped with who spoke — the origin group receives nothing', async () => {
    const members = [
      { id: A, kind: 'wa-group', state: 'active' },
      { id: B, kind: 'wa-group', state: 'active' },
    ];
    const { spine, posts, relayCalls } = harness({ members });

    await spine.handleInbound(human('hola equipo'));

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ chatId: B, memberId: 'An' });   // B's own chat id; the ORIGIN speaker's name
    expect(posts[0].final).toBe('hola equipo');
    expect(posts.some((p) => p.chatId === A)).toBe(false);           // never back to where it came from
    expect(relayCalls).toHaveLength(0);                              // a send, not a CDP injection — no tab driven
  });

  it('PING-PONG LOCK: two groups relay BOTH ways, each line delivered exactly once, nothing re-entered', async () => {
    const members = [
      { id: A, kind: 'wa-group', state: 'active' },
      { id: B, kind: 'wa-group', state: 'active' },
    ];
    const { spine, posts, guard } = harness({ members });

    await spine.handleInbound(human('from A'));
    await spine.handleInbound(human('from B', { chatId: B, msgId: 'm2' }));

    expect(posts.map((p) => ({ chatId: p.chatId, final: p.final }))).toEqual([
      { chatId: B, final: 'from A' },     // A's line reached B, once
      { chatId: A, final: 'from B' },     // …and B's reached A, once — no third delivery anywhere
    ]);
    // A room that IS the chat tunnels nowhere, so a delivery here is a plain SEND: neither channel
    // accrues a turn of any kind, and there is nothing to fan back at the origin.
    expect(guard.countOf('whatsapp:room-1')).toBe(0);
    expect(guard.countOf('whatsapp:group-B')).toBe(0);
  });

  it('a muted and an off group receive NOTHING — the same mode gate a brain member passes', async () => {
    const members = [
      { id: 'group-muted', kind: 'wa-group', state: 'muted' },
      { id: 'group-off', kind: 'wa-group', state: 'off' },
    ];
    const { spine, posts } = harness({ members });
    await spine.handleInbound(human('anyone there'));
    expect(posts).toHaveLength(0);
  });

  it('THE OPEN UMBRELLA: one room, a group AND a chatgpt tab — both receive the message, and the group receives the tab\'s reply too', async () => {
    const members = [
      { id: B, kind: 'wa-group', state: 'active' },
      { id: 'chatgpt', kind: 'brain', state: 'active', adapter: 'chatgpt-cdp', targetId: 'T1' },
    ];
    const { spine, posts, relayCalls } = harness({ members });

    await spine.handleInbound(human('hi team'));

    expect(relayCalls).toHaveLength(1);                             // the tab was driven with the same line
    expect(relayCalls[0].injectScript).toBe('INJECT[hi team]');
    // The group saw the human line AND — through the brain reply's re-entry — chatgpt's answer,
    // each stamped with whoever produced it. That is the "same open umbrella".
    const toB = posts.filter((p) => p.chatId === B);
    expect(toB.map((p) => p.final)).toEqual(['hi team', 'brain-reply-1']);
    expect(toB.map((p) => p.memberId)).toEqual(['An', 'chatgpt']);
    // …and chatgpt's reply still posts into the origin room exactly as it did before.
    expect(posts.filter((p) => p.chatId === A).map((p) => p.final)).toEqual(['brain-reply-1']);
  });
});

describe('room relay — E participates in the brain chatter per its OWN mode (design B)', () => {
  it("with E at 'on', E's turn runs on the human message AND on the brain member's reply", async () => {
    const members = [{ id: 'chatgpt', kind: 'brain', state: 'active', adapter: 'chatgpt-cdp', targetId: 'T1' }];
    const onGating = { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true };
    const { spine, brain, relayCalls } = harness({ members, eGating: onGating });

    await spine.handleInbound(human('hi team'));

    expect(relayCalls).toHaveLength(1);                                 // chatgpt relayed once
    const bodies = brain.calls.map((c) => c.body);
    expect(bodies).toContain('hi team');                               // E answered the human
    expect(bodies).toContain('brain-reply-1');                         // …and saw the brain's re-entered reply
  });
});

// ── THE TUNNEL IS A TURN: an invited group's message wakes the room's agents ──────────────────
// (operator 2026-08-31: *"if there is nobody connected in the shell to a room, fanning out is to
// write on their transcript. an advanced feature is what it does now, that is shows the messages
// that arrived to the group/room while you were absent. a delivery IS a turn then, so that the
// group can trigger the room's agents. i want precisely for the group to trigger acim's E, which
// has been doing good work."*)
//
// Before this, a message arriving in an invited group was DELIVERED from the group's own fan-out
// and merely LOGGED into the room (the retired `logRoomTranscript` seam), so the room's agents
// were never woken by it — the tunnel was one-directional in effect. It is RE-ENTERED into the
// room now, through the SAME `reenter` a brain member's reply travels, addressed at `room/<name>`.
// Everything else follows from the room having an ordinary turn: the ingestion chokepoint writes
// its ONE transcript record, its agents run per their own mode, and its own fan-out — this same
// loop, one level down — delivers to the other groups and the brain tabs.
describe("room relay — an invited group's message RE-ENTERS the room it joined, as a turn", () => {
  const A = 'room-1';        // the group every human() below arrives in
  const B = 'group-B';
  const R = 'dj-son';        // the room both groups were invited into

  const groupPair = () => [
    { id: A, kind: 'wa-group', state: 'active' },
    { id: B, kind: 'wa-group', state: 'active' },
  ];

  it('the room gets ONE record of its own, addressed room/<name> — and the other group is delivered to from THERE, once', async () => {
    const { spine, transcript, posts } = harness({ members: groupPair(), tunnelRooms: [R] });

    await spine.handleInbound(human('hola equipo'));

    // ONE record in the room, even though two wa-group members share the roster, and independent
    // of any member's mode — it comes from the ingestion chokepoint, not from a second writer.
    const inRoom = transcript.entries.filter((e) => e.surface === 'room');
    expect(inRoom).toHaveLength(1);
    expect(inRoom[0]).toMatchObject({ chatId: R, body: 'hola equipo' });
    // …beside the origin group's own record. Two conversations, one line each — never doubled.
    expect(transcript.entries.filter((e) => e.surface === 'whatsapp' && e.chatId === A)).toHaveLength(1);
    // The delivery happens ONCE, and from the room: B's own chat id, stamped with who spoke.
    expect(posts.map((p) => ({ chatId: p.chatId, memberId: p.memberId, final: p.final })))
      .toEqual([{ chatId: B, memberId: 'An', final: 'hola equipo' }]);
  });

  it("THE ASK: the ROOM's agent runs on the group's message, gated by the ROOM's own mode", async () => {
    // E is 'on' in the room and 'mention' (never replies) in the group — so a turn in the room is
    // the ONLY way the group's line can reach it. That turn is the whole point of the change.
    const onlyRoomReplies = {
      async decide(_being, ev) {
        return ev.surface === 'room'
          ? { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }
          : { mode: 'mention', receives: true, mayReply: false, sendToEgpt: 'mode' };
      },
      surfaces: () => true,
    };
    const { spine, brain } = harness({ members: groupPair(), tunnelRooms: [R], eGating: onlyRoomReplies });

    await spine.handleInbound(human('equipo, status?'));

    expect(brain.calls.map((c) => ({ surface: c.surface, chatId: c.chatId, body: c.body })))
      .toEqual([{ surface: 'room', chatId: R, body: 'equipo, status?' }]);
  });

  it('a MUTED room agent stays silent — the trigger is enabled, the reply is never forced', async () => {
    const mutedEverywhere = {
      async decide() { return { mode: 'muted', receives: true, mayReply: false, sendToEgpt: 'mode' }; },
      surfaces: () => false,
    };
    const { spine, brain, transcript } = harness({ members: groupPair(), tunnelRooms: [R], eGating: mutedEverywhere });

    await spine.handleInbound(human('hola'));

    expect(brain.calls).toHaveLength(0);                                             // no reply forced
    expect(transcript.entries.filter((e) => e.surface === 'room')).toHaveLength(1);   // still on the room's record
  });

  it("the room's own brain tab is driven from the ROOM turn, and its reply reaches BOTH groups", async () => {
    const members = [...groupPair(), { id: 'chatgpt', kind: 'brain', state: 'active', adapter: 'chatgpt-cdp', targetId: 'T1' }];
    const { spine, posts, relayCalls } = harness({ members, tunnelRooms: [R] });

    await spine.handleInbound(human('team, status?'));

    expect(relayCalls).toHaveLength(1);                            // driven ONCE, not once per end
    expect(relayCalls[0].injectScript).toBe('INJECT[team, status?]');
    // chatgpt's reply re-enters at the ROOM, so the room's fan-out hands it to BOTH groups — the
    // origin included, which is where the question was asked.
    expect(posts.filter((p) => p.chatId === B).map((p) => p.final)).toEqual(['team, status?', 'brain-reply-1']);
    expect(posts.filter((p) => p.chatId === A).map((p) => p.final)).toEqual(['brain-reply-1']);
  });

  it('no tunnelRooms on the roster (a group in no room) — nothing is re-entered, nothing is recorded elsewhere', async () => {
    const { spine, transcript, posts } = harness({ members: groupPair() });   // no tunnelRooms passed

    await spine.handleInbound(human('hola equipo'));

    expect(transcript.entries.map((e) => `${e.surface}:${e.chatId}`)).toEqual(['whatsapp:room-1']);
    expect(posts.map((p) => p.chatId)).toEqual([B]);   // the room-IS-the-chat path, byte-identical
  });
});

// ── LOOP SAFETY ──────────────────────────────────────────────────────────────────────────────
//
// The SEND-not-a-turn rule used to be the loop stop, and re-entry removes it. Each of the four
// cycles is BUILT here and shown to terminate on a STRUCTURAL stop — an identity check or a
// suppression that cannot be raced — with the guard's counter as a backstop only, never the
// design. See room-relay.mjs's header for the same four, stated as locks.
describe('room relay — LOOP SAFETY: every cycle built, and the thing that stops it', () => {
  const A = 'room-1';
  const B = 'group-B';
  const R = 'dj-son';
  const pairOf = () => [
    { id: A, kind: 'wa-group', state: 'active' },
    { id: B, kind: 'wa-group', state: 'active' },
  ];

  it('1 — SELF-ECHO: A never receives its own line back, from either end of the tunnel', async () => {
    // From the ROOM turn, where ev.chatId is the room and A is just another member: the stop is
    // `ev.fromMember.id === m.id` — the provenance the tunnel synthetic carries.
    const tunnelled = harness({ members: pairOf(), tunnelRooms: [R] });
    await tunnelled.spine.handleInbound(human('hola'));
    expect(tunnelled.posts.some((p) => p.chatId === A)).toBe(false);

    // …and from a room that IS the chat, where that member is the conversation: the stop is
    // `m.id === ev.chatId`. Both readings of "its own author", both still holding.
    const direct = harness({ members: pairOf() });
    await direct.spine.handleInbound(human('hola'));
    expect(direct.posts.some((p) => p.chatId === A)).toBe(false);
  });

  it('2 — TWO GROUPS PING-PONGING: the cycle needs our own send back as an inbound, and an escaped one stays NON-human into the room', async () => {
    // The cycle: A → room → send to B → [B's inbound] → room → send to A → … The first arrow it
    // needs is B's copy coming back as an INBOUND, and it never does: every send this node makes
    // is dropped by the bridge on its exact (chat, id) after the in-flight confirm resolves
    // (beeper.mjs wasSentByUs/_awaitSends — id-exact, never a resemblance window).
    //
    // Build the cycle anyway, with that gate deliberately failed: hand the escaped echo straight
    // back in. It carries this node's structural signature, and the tunnel synthetic carries
    // `fromNode` ACROSS the re-addressing (identity has already rendered the frame away, so it
    // cannot be re-read from the body) — so the room turn is NON-HUMAN, counts, and the guard
    // bounds it instead of a human-looking line resetting the counter on every lap.
    const { spine, guard } = harness({ members: pairOf(), tunnelRooms: [R], turns: 4 });
    const SIG = encodeNodeSignature('kg');

    await spine.handleInbound(human(`hola${SIG}`, { chatId: B, msgId: 'echo-1' }));

    expect(guard.countOf('whatsapp:group-B')).toBe(1);   // the escaped echo itself: non-human
    expect(guard.countOf(`room:${R}`)).toBe(1);          // …and STILL non-human inside the room
  });

  it('2b — ONE HOP: a turn the relay re-entered never tunnels onward, even if the resolver offers it a room', async () => {
    // The resolver does not offer one (boot.mjs skips the reverse lookup on surface `room`), but
    // a fan-out that terminates only because its roster source is well-behaved is not a design.
    // `tunnelEverySurface` breaks the resolver deliberately: the room turn is handed the SAME
    // tunnel it came from. `!ev.fromMember` is what makes the chain finite — without it this test
    // recurses until the heap dies, which is exactly how the lock was found.
    const { spine, transcript, posts } = harness({ members: pairOf(), tunnelRooms: [R], tunnelEverySurface: true });

    await spine.handleInbound(human('hola'));

    expect(transcript.entries.filter((e) => e.surface === 'room')).toHaveLength(1);   // ONE hop, not N
    expect(posts.map((p) => p.chatId)).toEqual([B]);
  });

  it("3 — AN AGENT'S OWN REPLY: a brain member never re-triggers itself, and two of them halt at guard.turns", async () => {
    // One brain: its reply re-enters (so the others + E see it) but is never fed back to its own
    // author — `ev.fromMember.id === m.id`. One drive, not an endless self-conversation.
    const solo = harness({ members: [{ id: 'chatgpt', kind: 'brain', state: 'active', adapter: 'chatgpt-cdp', targetId: 'T1' }] });
    await solo.spine.handleInbound(human('hi'));
    expect(solo.relayCalls).toHaveLength(1);

    // Two brains DO legitimately answer each other — neither is "its own author" for the other's
    // line — so that one is bounded, not stopped: each re-entered reply is our own output, hence
    // non-human, hence counted. This is the ONE cycle the guard is the answer to.
    const pair = harness({
      members: [
        { id: 'aa', kind: 'brain', state: 'active', adapter: 'chatgpt-cdp', targetId: 'T-A' },
        { id: 'bb', kind: 'brain', state: 'active', adapter: 'chatgpt-cdp', targetId: 'T-B' },
      ],
      turns: 4,
    });
    await pair.spine.handleInbound(human('kick it off'));
    expect(pair.guard.blocked(pair.channel)).toBe(true);
    expect(pair.relayCalls).toHaveLength(4);
  });

  it("4 — OUR OWN SEND COMING BACK: the bridge's id-exact suppression is the stop; the spine's belt classifies whatever escapes it", async () => {
    // beeper.mjs drops an inbound whose (chat, id) is in `_sentIds`, after awaiting that chat's
    // in-flight sends so the confirmed id is known — the message never reaches the spine at all.
    // The spine keeps the belt: `bridge.wasSentByUs(chatId, msgId)` in isHumanTurn. Wire it true
    // and the echo is counted, not treated as a human resetting the loop.
    const h = harness({ members: pairOf(), tunnelRooms: [R] });
    h.bridge.wasSentByUs = (chatId, msgId) => msgId === 'ours-1';

    await h.spine.handleInbound(human('our own words', { chatId: B, msgId: 'ours-1' }));

    expect(h.guard.countOf('whatsapp:group-B')).toBe(1);   // counted, never a reset
  });
});
