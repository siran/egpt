// room-relay.test.mjs — Command Surface Phase 4, design B (re-entry). The reproduce-first
// suite for the room brain-member fan-out wired at the spine chokepoint:
//   1. a brain member's MODE gates delivery (muted→never, mention→@<id> only, active→every msg);
//   2. the member's reply RE-ENTERS as a synthetic NON-human turn — counted EXACTLY ONCE by the
//      guard and logged once (phase-3 tie);
//   3. two `active` brains answering each other are BOUNDED at guard.turns;
//   4. E participates in the brain chatter per its OWN mode (the reply reaches E via re-entry).
//
// Uses the REAL identity (so the { body, from } synthetic re-entry carries fromBrain through
// identity.build), the REAL guard, and the REAL room relay — fakes only at the CDP seam
// (streamFromTab), the member store (resolveMembers), the adapter driver, and the sender.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createRoomRelay } from '../src/spine/room-relay.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
import { createIdentity } from '../src/spine/identity.mjs';

const identity = createIdentity({ now: () => 1000 });

// A human inbound in the { body, from } shape the REAL identity.build consumes. network
// 'whatsapp' → surface 'whatsapp'; a stable room chatId. authorized (a bare STOP would be
// honored — the bodies here are never safe-words).
function human(body, { chatId = 'room-1', msgId = 'm1' } = {}) {
  return { body, from: { network: 'whatsapp', chatId, chatName: 'devroom', userId: 'u-an', senderName: 'An', authorized: true, msgKey: msgId } };
}

function harness({ members = [], eGating, turns = 6, tunnelRooms = null } = {}) {
  const relayCalls = [];
  const activateCalls = [];
  const callOrder = [];
  const posts = [];
  const roomLogs = [];
  let seq = 0;
  const bridge = { sent: [], onMessage() {}, send(chat, text, opts) { this.sent.push({ chat, text, opts }); }, stop() {}, wasSentByUs: () => false };
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, body: ev.body }); return { text: `E:${ev.body}`, sessionId: 's1' }; } };
  const router = { resolve: () => 'e' };
  // Default E gating: receives but never replies, so the brain fan-out is isolated. The
  // participation test overrides it with a real 'on' gate.
  const gating = eGating ?? { async decide() { return { mode: 'mention', receives: true, mayReply: false, sendToEgpt: 'mode' }; }, surfaces: () => false };
  const transcript = { entries: [], async log(ev) { this.entries.push({ body: ev.body, fromBrain: ev.fromBrain ?? null }); } };
  const heartbeats = { runDue() {} };
  // E's persona sender — replies land in bridge.sent (distinct from member posts).
  const sender = { open(chatId, { replyTo } = {}) { return { activate() {}, update() {}, async finish(r, { surface = true } = {}) { const t = typeof r === 'string' ? r : r?.text; if (surface && t) bridge.send(chatId, t, { replyTo }); }, fail() {} }; } };

  const guard = createStopGuard({ turns });

  const roomRelay = createRoomRelay({
    // tunnelRooms mirrors boot.mjs createMemberResolver's `roster.tunnelRooms` — the room
    // name(s) the reverse lookup found ev's own chat invited into (see room-relay.mjs header).
    resolveMembers: async () => { if (tunnelRooms) members.tunnelRooms = tunnelRooms; return members; },
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
    logRoomTranscript: async (roomName, ev) => { roomLogs.push({ roomName, ev }); },
    onLog: () => {},
  });

  const spine = createSpine({
    bridge, brain, identity, router, gating, sender, transcript, heartbeats,
    guard, roomRelay, clock: { now: () => 1000 }, turnTimeoutMs: 0,
  });
  return { spine, bridge, brain, transcript, guard, relayCalls, activateCalls, callOrder, posts, roomLogs, channel: 'whatsapp:room-1' };
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

    // logged exactly once (C1.2), tagged with the brain's provenance (fromBrain)
    const brainLogs = transcript.entries.filter((e) => e.fromBrain === 'chatgpt');
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
// mirror of the brain path's `ev.fromBrain === m.id` skip is asserted here — the origin group is
// never delivered its own line, and a group delivery re-enters NOTHING (it is a send, not a turn),
// so B's copy cannot fan back to A.
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
    // A delivery is a SEND, not a turn: neither channel accrues a non-human turn, because there
    // is no synthetic re-entry to fan back at the origin. That absence IS the loop's floor.
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

// ── the room's OWN transcript record for a tunnelled wa-group message (operator 2026-08-30) ──
//
// The root cause: this service never counts/logs (see the module header) — the re-entry does
// that once, at the chokepoint, and a wa-group delivery is a plain SEND, never re-entered (the
// ping-pong lock). So the ROOM's own transcript.md never saw a wa-group message that tunnelled
// through it. `logRoomTranscript` closes exactly that gap, additively: `resolveMembers`'s
// reverse lookup hands the room name(s) back on `members.tunnelRooms` (mirroring boot.mjs
// createMemberResolver's real shape), and fanOut calls the seam ONCE per resolved room per
// inbound event — never once per member relayed to.
describe("room relay — a wa-group message logs ONE record into the room's own transcript", () => {
  const A = 'room-1';
  const B = 'group-B';

  it('fans out AND calls logRoomTranscript exactly once (not once per wa-group member), with who/what/where', async () => {
    const members = [
      { id: A, kind: 'wa-group', state: 'active' },
      { id: B, kind: 'wa-group', state: 'active' },
    ];
    const { spine, roomLogs, posts } = harness({ members, tunnelRooms: ['dj-son'] });

    await spine.handleInbound(human('hola equipo'));

    expect(posts).toHaveLength(1);          // the OTHER group still gets delivered exactly as before
    expect(roomLogs).toHaveLength(1);       // ONE record, even though two wa-group members are in the roster
    expect(roomLogs[0].roomName).toBe('dj-son');
    expect(roomLogs[0].ev.body).toBe('hola equipo');       // what was said
    expect(roomLogs[0].ev.senderName).toBe('An');          // who said it
    expect(roomLogs[0].ev.chatName).toBe('devroom');        // which group it came from
  });

  it('no tunnelRooms on the roster (the ordinary/non-tunnel case) — logRoomTranscript is never called', async () => {
    const members = [{ id: 'chatgpt', kind: 'brain', state: 'active', adapter: 'chatgpt-cdp', targetId: 'T1' }];
    const { spine, roomLogs } = harness({ members });   // no tunnelRooms passed
    await spine.handleInbound(human('anything at all'));
    expect(roomLogs).toHaveLength(0);
  });

  it('logRoomTranscript not injected (default) — fanOut behaves exactly as before: no throw, no attempt', async () => {
    const members = [{ id: A, kind: 'wa-group', state: 'active' }, { id: B, kind: 'wa-group', state: 'active' }];
    members.tunnelRooms = ['dj-son'];   // resolveMembers hands back a tunnel — but the seam is unset
    const roomRelay = createRoomRelay({
      resolveMembers: async () => members,
      adapterOf: async () => null,
      streamFromTab: async () => '',
      openStream: () => ({ update() {}, finish: async () => {}, fail: async () => {} }),
      onLog: () => {},
    });
    const ev = { surface: 'whatsapp', chatId: A, chatName: 'devroom', senderName: 'An', body: 'hola', ts: 1000 };
    await expect(roomRelay.fanOut(ev, {})).resolves.toBeUndefined();
  });
});
