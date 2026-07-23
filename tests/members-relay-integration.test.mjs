// members-relay-integration.test.mjs — the END-TO-END connection (bug fix 2026-07-23).
//
// The flagship @chatgpt flow, proven across the phase-2 ↔ phase-4 seam that was broken:
//   1. the operator (in a conversation) runs `/members add tab <n>` + `/members chatgpt mode
//      mention` through the REAL createCommands dispatch;
//   2. a real spine (real identity + guard + room relay) receives `@chatgpt …` on the SAME
//      conversation and the relay drives the tab (fake streamFromTab is called).
//
// The crux: createCommands (WRITE) and the relay's resolveMembers (READ) share ONE
// resolveConvRoom — a per-(surface,chatId) temp-dir Room. Before the fix, /members wrote a
// NamedRoom while the relay read the ConversationRoom, so the relay saw NO members and
// @chatgpt silently no-op'd; this test FAILS on that code and PASSES after.
//
// Fakes only at the edges: CDP tab list (commands), streamFromTab + adapter driver + member
// sender (relay). The room store is real (room-core writes config.yaml under a temp dir).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommands } from '../src/spine/commands.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createRoomRelay } from '../src/spine/room-relay.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { Room } from '../src/room-core.mjs';

class TmpRoom extends Room {
  constructor(dir, slug) { super(); this._dir = dir; this.slug = slug; }
  baseDir() { return this._dir; }
}

const ADAPTERS = [{ name: 'chatgpt-cdp', urlMatch: /chatgpt\.com|chat\.openai\.com/, homeUrl: 'https://chatgpt.com/' }];
const threeTabs = [{ id: 'GPT1', title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' }];

// A human inbound in the { body, from } shape the REAL identity.build consumes.
function human(body, { chatId = '!conv-1', msgId = 'm1' } = {}) {
  return { body, from: { network: 'whatsapp', chatId, chatName: 'devroom', userId: 'u-an', senderName: 'An', authorized: true, msgKey: msgId } };
}

let base;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'egpt-mri-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

// THE shared conversation-room resolver, exactly the shape boot injects into BOTH sides.
function makeResolveConvRoom() {
  const convRooms = new Map();
  return async (surface, chatId) => {
    const key = `${surface}:${chatId}`;
    if (!convRooms.has(key)) convRooms.set(key, new TmpRoom(join(base, 'conv', surface, String(chatId)), String(chatId)));
    return convRooms.get(key);
  };
}

function commandsFor(resolveConvRoom) {
  const sent = [];
  const cmds = createCommands({
    getConfig: () => ({ whatsapp: { chat_id: '!conv-1' } }),
    send: async (chatId, text) => sent.push({ chatId, text }),
    cdp: { listTabs: async () => threeTabs },
    loadAdapters: async () => ADAPTERS,
    resolveConvRoom,
  });
  return { cmds, sent };
}

function spineFor(resolveConvRoom) {
  const relayCalls = [];
  const posts = [];
  let seq = 0;
  const bridge = { sent: [], onMessage() {}, send(chat, text, opts) { this.sent.push({ chat, text, opts }); }, stop() {}, wasSentByUs: () => false };
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, body: ev.body }); return { text: `E:${ev.body}`, sessionId: 's1' }; } };
  const router = { resolve: () => 'e' };
  const gating = { async decide() { return { mode: 'mention', receives: true, mayReply: false, sendToEgpt: 'mode' }; }, surfaces: () => false };
  const transcript = { entries: [], async log(ev) { this.entries.push({ body: ev.body, fromBrain: ev.fromBrain ?? null }); } };
  const heartbeats = { runDue() {} };
  const sender = { open(chatId, { replyTo } = {}) { return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
  const guard = createStopGuard({ turns: 6 });
  const identity = createIdentity({ now: () => 1000 });

  const roomRelay = createRoomRelay({
    // READ the roster through the SAME resolveConvRoom /members WRITES through (boot's wiring).
    resolveMembers: async (surface, chatId) => {
      const room = await resolveConvRoom(surface, chatId);
      return room ? await room.members() : [];
    },
    adapterOf: async () => ({ injectScript: (t) => `INJECT[${t}]`, pollScript: 'POLL' }),
    streamFromTab: async ({ targetId, injectScript, pollScript, onUpdate }) => {
      relayCalls.push({ targetId, injectScript, pollScript });
      onUpdate?.('…partial…');
      return `brain-reply-${++seq}`;
    },
    openStream: (memberId, chatId, opts) => {
      const rec = { memberId, chatId, opts, final: null };
      posts.push(rec);
      return { update() {}, finish: async (r) => { rec.final = typeof r === 'string' ? r : r?.text; }, fail: async () => {} };
    },
    onLog: () => {},
  });

  const spine = createSpine({
    bridge, brain, identity, router, gating, sender, transcript, heartbeats,
    guard, roomRelay, clock: { now: () => 1000 }, turnTimeoutMs: 0,
  });
  return { spine, relayCalls, posts };
}

describe('members → relay integration — the flagship @chatgpt flow end to end', () => {
  it('/members add tab + mode mention makes a later @chatgpt on the SAME conversation drive the tab', async () => {
    const resolveConvRoom = makeResolveConvRoom();
    const { cmds, sent } = commandsFor(resolveConvRoom);

    // Operator wires the tab into THIS conversation (no /room join — the conversation IS the room).
    await cmds.run({ chatId: '!conv-1', surface: 'whatsapp', body: '/members add tab 1' });
    expect(sent.at(-1).text).toMatch(/added 'chatgpt'/);
    await cmds.run({ chatId: '!conv-1', surface: 'whatsapp', body: '/members chatgpt mode mention' });
    expect(sent.at(-1).text).toMatch(/mode:mention/);

    // A real spine, sharing the SAME resolveConvRoom, receives @chatgpt on that conversation.
    const { spine, relayCalls, posts } = spineFor(resolveConvRoom);
    await spine.handleInbound(human('@chatgpt summarize the last 10 messages'));

    expect(relayCalls).toHaveLength(1);                                   // the relay FIRED (bug: was 0)
    expect(relayCalls[0].targetId).toBe('GPT1');                         // the tab the operator added
    expect(relayCalls[0].injectScript).toBe('INJECT[summarize the last 10 messages]');  // @chatgpt stripped
    expect(posts[0].final).toBe('brain-reply-1');                        // the reply streamed into the room
  });

  it('a muted member (never flipped to mention/all) is NOT driven by @chatgpt', async () => {
    const resolveConvRoom = makeResolveConvRoom();
    const { cmds } = commandsFor(resolveConvRoom);
    await cmds.run({ chatId: '!conv-1', surface: 'whatsapp', body: '/members add tab 1' });   // added muted, never flipped

    const { spine, relayCalls } = spineFor(resolveConvRoom);
    await spine.handleInbound(human('@chatgpt hello'));
    expect(relayCalls).toHaveLength(0);   // mode:disable → nothing reaches it
  });
});
