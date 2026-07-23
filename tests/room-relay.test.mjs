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

function harness({ members = [], eGating, turns = 6 } = {}) {
  const relayCalls = [];
  const posts = [];
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
    resolveMembers: async () => members,
    adapterOf: async () => ({ injectScript: (t) => `INJECT[${t}]`, pollScript: 'POLL' }),
    // The fake CDP seam: record the drive, emit a partial, return a unique reply.
    streamFromTab: async ({ targetId, injectScript, pollScript, onUpdate }) => {
      relayCalls.push({ targetId, injectScript, pollScript });
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
  return { spine, bridge, brain, transcript, guard, relayCalls, posts, channel: 'whatsapp:room-1' };
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
