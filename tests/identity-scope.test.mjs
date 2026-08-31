// identity-scope.test.mjs — ONE being, several chats (operator 2026-08-31).
//
// room/acim's `egpt` had been doing translation work for weeks — thread 892d0ee4,
// access_level `all`, its own warm CLI. The operator then made a WhatsApp group ("perrito
// traducciones") and invited it into that room as a `wa-group` member: *"i think the best is
// to 'join the agents' … we need to use the same key for the agent to use the same warm cli
// (however, it might be that the group/room name also enter in the cache-key and so perhaps
// we need to find a workaround)"*.
//
// He is right about the cache key, and it is the crux. A being's instance is keyed FOUR ways
// — its thread, its warm process, the spine's per-conversation turn FIFO, and its
// per-conversation run config — and every one of them is derived from (being, surface,
// chatId). Collapsing three of the four would be WORSE than collapsing none: a shared thread
// with a per-chat warm key is two `claude --resume <same id>` processes on one session file.
//
// So the tests come in pairs. THE ASK, which fails on the pre-scope derivation (the control
// beside it IS that derivation, kept green on purpose so the two can be read together), and
// THE LOCK: a conversation in no room, and a room with no invited groups, must key exactly as
// they did before this existed — same key, same prompt, same brainOptions, same thread, and
// not one extra state or contact read.
import { describe, it, expect } from 'vitest';
import { createIdentityScope } from '../src/spine/identity-scope.mjs';
import { createMemberResolver } from '../src/spine/boot.mjs';
import { createBrainPool } from '../src/spine/brainpool.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { emptyState, getBeing, patchBeing } from '../src/conversations-state.mjs';

const ROOM = 'acim';                          // room/acim — where the instance lives
const ACIM_THREAD = '892d0ee4-acim';          // the thread it has been working on for weeks
const GROUP = '!perrito@g.us';                // the invited WhatsApp group's own chat id
const GROUP_NAME = 'perrito traducciones';

// config/rooms.yaml as the REVERSE LOOKUP sees it: room/acim has invited the group in.
const JOINED = { 'room/acim': { members: [{ id: GROUP, kind: 'wa-group', state: 'active' }] } };
const NO_ROOMS = {};
// The same group invited into TWO rooms — no single instance to join.
const TWO_ROOMS = {
  'room/acim': { members: [{ id: GROUP, kind: 'wa-group', state: 'active' }] },
  'room/otra': { members: [{ id: GROUP, kind: 'wa-group', state: 'active' }] },
};

// boot's REAL reverse lookup, over an injected rooms.yaml. resolveConvRoom only has to answer
// `members()` here — the own-room half of the roster plays no part in the scope.
const memberResolver = (rooms) => createMemberResolver({
  resolveConvRoom: async () => ({ members: async () => [] }),
  readRooms: async () => rooms,
});
const scopeOver = (rooms, onLog) => createIdentityScope({ resolveMembers: memberResolver(rooms), ...(onLog ? { onLog } : {}) });

// ─────────────────────────────────────────────────────────────────────────────
describe('createIdentityScope — which conversation a being\'s instance lives in', () => {
  it('a chat invited into exactly ONE room resolves to that room', async () => {
    expect(await scopeOver(JOINED)('e', 'whatsapp', GROUP)).toEqual({ surface: 'room', chatId: ROOM });
  });

  it('a chat in no room is its own instance — null, the default answer', async () => {
    expect(await scopeOver(NO_ROOMS)('e', 'whatsapp', GROUP)).toBe(null);
  });

  it('a chat invited into TWO rooms keeps its own instance, and says why', async () => {
    const logs = [];
    expect(await scopeOver(TWO_ROOMS, (m) => logs.push(m))('e', 'whatsapp', GROUP)).toBe(null);
    // Never picks one arbitrarily: that would hand a live thread to whichever row YAML listed first.
    expect(logs.join('\n')).toMatch(/member of 2 rooms \(acim, otra\) — no single instance/);
  });

  it('a ROOM never resolves into another room — the reverse lookup declines on surface `room` (the one-hop lock)', async () => {
    const rooms = { 'room/outer': { members: [{ id: ROOM, kind: 'wa-group', state: 'active' }] } };
    expect(await scopeOver(rooms)('e', 'room', ROOM)).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
function fakePool(results) {
  const calls = [], evicted = [];
  let i = 0;
  return {
    calls, evicted,
    run(key, message, onPartial, opts) {
      calls.push({ key, message, brainOptions: opts.brainOptions });
      const r = results[Math.min(i, results.length - 1)]; i++;
      return Promise.resolve(r);
    },
    evict(key) { evicted.push(key); },
    steer() { return false; },
  };
}

// A brainpool over an in-memory registry, counting the IO a TURN costs. `rooms: undefined`
// wires NO resolveScope at all — which is exactly the derivation as it stood before the scope
// existed, and is what the locks below compare against.
async function harness({ rooms, results = [{ text: 'ok', sessionId: ACIM_THREAD }] } = {}) {
  let state = emptyState();
  const io = { loadState: 0, resolve: 0 };
  const loadState = async () => { io.loadState++; return state; };
  const writeState = async (s) => { state = s; };
  const real = createContacts({ loadState, writeState, io: { mkdir: async () => {} } });
  const contacts = { resolve: (...a) => { io.resolve++; return real.resolve(...a); } };

  // Register both conversations the way a live node does, then give room/acim the being the
  // operator has been working with: a live thread, and the access_level he ruled applies.
  await real.resolve('room', ROOM);
  await real.resolve('whatsapp', GROUP, { chatName: GROUP_NAME });
  state = patchBeing(state, 'room', ROOM, 'e', { threadId: ACIM_THREAD, access_level: 'all', allowed_users: ['*'] });
  io.loadState = 0; io.resolve = 0;                    // count only what the TURN itself costs

  const pool = fakePool(results);
  const brain = createBrainPool({
    pool, contacts, loadState, writeState,
    getConfig: () => ({ agents: { e: {} } }),
    io: { mkdir: async () => {}, readFile: async () => null, writeFile: async () => {} },
    resolveConfig: () => ({}),
    loadFeed: async () => '', loadManifest: async () => '',
    seedLayers: async () => {},
    // Observable stand-in for config/permissions/<level>.md, so a turn's brainOptions SHOW
    // which access_level was resolved for it.
    loadPermission: (level) => ({ dangerouslySkipPermissions: level === 'all', allowedTools: level === 'all' ? ['ALL'] : ['Read'] }),
    ...(rooms === undefined ? {} : { resolveScope: scopeOver(rooms) }),
  });
  return { brain, pool, io, getState: () => state };
}

const roomEv = { surface: 'room', chatId: ROOM, chatName: ROOM, line: 'An@[acim].room (14:05): sigue con el capítulo 3', body: 'sigue con el capítulo 3' };
const groupEv = { surface: 'whatsapp', chatId: GROUP, chatName: GROUP_NAME, line: `An@[${GROUP_NAME}].wa (14:05) #m1: traduce esto`, body: 'traduce esto' };

describe('brainpool — the four identity keys derive from the SCOPE, not the chat', () => {
  it('THE ASK: an invited group runs on the ROOM\'s being — one warm key, one thread, the room\'s access_level', async () => {
    const { brain, pool, getState } = await harness({ rooms: JOINED });
    await brain.turn('e', roomEv);
    await brain.turn('e', groupEv);

    // 2. WARM PROCESS — the group's turn opens no second CLI; it lands on the room's entry.
    expect(pool.calls[0].key).toBe('e:ccode:room:acim');
    expect(pool.calls[1].key).toBe(pool.calls[0].key);
    // 1. THREAD — resumed, not minted. Same memory.
    expect(pool.calls[0].brainOptions.sessionId).toBe(ACIM_THREAD);
    expect(pool.calls[1].brainOptions.sessionId).toBe(ACIM_THREAD);
    // 4. RUN CONFIG — the room's `all` applies to the turn the group triggered (it would
    //    otherwise inherit 'regular' from the global default), and the same hands: the room's
    //    own conversation dir, not the group's.
    expect(pool.calls[1].brainOptions.dangerouslySkipPermissions).toBe(true);
    expect(pool.calls[1].brainOptions.cwd).toBe(pool.calls[0].brainOptions.cwd);
    // NOT A COPY: the group's own entry still has no thread of its own. There is ONE record.
    expect(getBeing(getState(), 'whatsapp', GROUP, 'e')?.threadId ?? null).toBe(null);
    expect(getBeing(getState(), 'room', ROOM, 'e').threadId).toBe(ACIM_THREAD);
  });

  it('...and the pre-scope derivation, unchanged beside it: two beings, two threads, two access levels', async () => {
    const { brain, pool } = await harness({});          // no resolveScope == today, before the scope
    await brain.turn('e', roomEv);
    await brain.turn('e', groupEv);

    expect(pool.calls[0].key).toBe('e:ccode:room:acim');
    expect(pool.calls[1].key).toMatch(/^e:ccode:whatsapp:perrito traducciones-\d{10}$/);
    expect(pool.calls[1].key).not.toBe(pool.calls[0].key);          // a SECOND warm CLI
    expect(pool.calls[1].brainOptions.sessionId).toBe(null);        // a fresh thread of its own
    expect(pool.calls[1].brainOptions.dangerouslySkipPermissions).toBe(false);   // 'regular', the global default
  });

  it('LOCK — a conversation in NO room: same key, same prompt, same brainOptions, same thread, no extra IO', async () => {
    const before = await harness({});                    // the derivation before the scope existed
    await before.brain.turn('e', groupEv);
    const after = await harness({ rooms: NO_ROOMS });     // the seam wired, resolving to null
    await after.brain.turn('e', groupEv);
    const cost = { loadState: after.io.loadState, resolve: after.io.resolve };

    expect(after.pool.calls[0].key).toBe(before.pool.calls[0].key);
    expect(after.pool.calls[0].message).toBe(before.pool.calls[0].message);
    expect(after.pool.calls[0].brainOptions).toEqual(before.pool.calls[0].brainOptions);
    expect(getBeing(after.getState(), 'whatsapp', GROUP, 'e').threadId)
      .toBe(getBeing(before.getState(), 'whatsapp', GROUP, 'e').threadId);
    // The scope resolution itself reads rooms; the DERIVATION reads nothing it did not read before.
    expect(cost).toEqual({ loadState: before.io.loadState, resolve: before.io.resolve });
  });

  it('LOCK — a ROOM with no invited groups: same key, same prompt, same brainOptions, no extra IO', async () => {
    const before = await harness({});
    await before.brain.turn('e', roomEv);
    const after = await harness({ rooms: NO_ROOMS });
    await after.brain.turn('e', roomEv);
    const cost = { loadState: after.io.loadState, resolve: after.io.resolve };

    expect(after.pool.calls[0].key).toBe(before.pool.calls[0].key);
    expect(after.pool.calls[0].message).toBe(before.pool.calls[0].message);
    expect(after.pool.calls[0].brainOptions).toEqual(before.pool.calls[0].brainOptions);
    expect(cost).toEqual({ loadState: before.io.loadState, resolve: before.io.resolve });
  });

  // (The two LOCKs above are deliberately written so their COMPARISON runs on the pre-scope
  // code too — the expected values are literally what that code derives. Only the seam itself
  // is asserted separately, here.)
  it('the scope seam an unscoped conversation sees: its own address, room and chat alike', async () => {
    const { brain } = await harness({ rooms: NO_ROOMS });
    expect(await brain.scopeOf('e', groupEv)).toEqual({ surface: 'whatsapp', chatId: GROUP });
    expect(await brain.scopeOf('e', roomEv)).toEqual({ surface: 'room', chatId: ROOM });
    const joined = await harness({ rooms: JOINED });
    expect(await joined.brain.scopeOf('e', groupEv)).toEqual({ surface: 'room', chatId: ROOM });
  });

  it('PROVENANCE — a scoped turn names the chat the line came from, above the line; an unscoped one is the bare line', async () => {
    const scoped = await harness({ rooms: JOINED });
    await scoped.brain.turn('e', groupEv);
    const msg = scoped.pool.calls[0].message;
    // One instance now hears several chats: the being has to be able to tell which is talking
    // and therefore where its answer will land.
    expect(msg).toMatch(/^THIS LINE ARRIVED IN "perrito traducciones" \(whatsapp\)/);
    expect(msg).toMatch(/delivered THERE/);
    expect(msg.endsWith(groupEv.line)).toBe(true);

    // The ROOM's own turn is not framed — it IS the conversation the thread is named for.
    await scoped.brain.turn('e', roomEv);
    expect(scoped.pool.calls[1].message).toBe(roomEv.line);

    const plain = await harness({});
    await plain.brain.turn('e', groupEv);
    expect(plain.pool.calls[0].message).toBe(groupEv.line);
  });

  it('evict/steer reach the joined entry from EITHER address — both names point at one warm entry', async () => {
    const { brain, pool } = await harness({ rooms: JOINED });
    await brain.turn('e', groupEv);                      // ran from the GROUP's address
    brain.evict('e', roomEv);                            // ...evicted from the ROOM's
    expect(pool.evicted).toEqual(['e:ccode:room:acim']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KEY 3 — the spine's per-conversation turn FIFO. It is the one identity key derived outside
// brainpool, and the one that decides whether two chats sharing a warm entry can ever run at
// the same time. Head-of-line blocking across a room and its groups is the ACCEPTED price
// (operator told): concurrency here IS the corruption, so nothing is added to dodge it.
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeBridge() {
  let cb = null;
  return { onMessage(fn) { cb = fn; }, emit(msg) { return cb(msg); }, send() {}, stop() {} };
}

function gatedBrain(scopeOf) {
  const order = [], calls = [];
  let release = null;
  const brain = {
    order, calls,
    release: () => release?.(),
    async turn(being, ev) {
      const first = calls.length === 0;
      calls.push({ being, ev });
      order.push(`start:${ev.body}`);
      if (first) await new Promise((r) => { release = r; });
      order.push(`end:${ev.body}`);
      return { text: `reply-${ev.body}`, sessionId: 's' };
    },
  };
  if (scopeOf) brain.scopeOf = scopeOf;
  return brain;
}

function spineWith(scopeOf) {
  const bridge = fakeBridge();
  const brain = gatedBrain(scopeOf);
  const spine = createSpine({
    bridge, brain,
    identity: { build: (m) => ({ ...m, mention: { atEStart: true, atEAnywhere: true, replyToBot: false }, line: m.body }) },
    router: { resolve: () => ({ being: 'e', mention: { atEStart: true, atEAnywhere: true, replyToBot: false } }) },
    gating: { async decide() { return { mode: 'mention', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
    sender: { open: () => ({ activate() {}, update() {}, async finish() {}, async fail() {} }) },
    transcript: { async log() {} },
    heartbeats: { runDue() {} },
    clock: { now: () => 1000 },
  });
  spine.start();
  return { bridge, brain };
}

const inRoom = { surface: 'room', chatId: ROOM, chatName: ROOM, senderId: 'u', senderName: 'An', msgId: 'r1', ts: 1000, body: 'from the room', kind: 'text', raw: {} };
const inGroup = { surface: 'whatsapp', chatId: GROUP, chatName: GROUP_NAME, senderId: 'u', senderName: 'An', msgId: 'g1', ts: 1000, body: 'from the group', kind: 'text', raw: {} };

describe('spine — the turn FIFO keys on the INSTANCE, not the chat', () => {
  it('a group joined to a room QUEUES behind the room\'s turn — one warm entry, one turn at a time', async () => {
    const scope = scopeOver(JOINED);
    const { bridge, brain } = spineWith(async (being, ev) => (await scope(being, ev.surface, ev.chatId)) ?? ev);
    const a = bridge.emit(inRoom);                        // gates open
    const b = bridge.emit(inGroup);                       // a DIFFERENT chat, the SAME instance
    await flush();

    expect(brain.order).toEqual(['start:from the room']); // the group's turn has NOT started
    brain.release();
    await Promise.all([a, b]);
    expect(brain.order).toEqual(['start:from the room', 'end:from the room', 'start:from the group', 'end:from the group']);
  });

  it('a Brain with NO scopeOf is byte-identical: the key is the event\'s own address, and the two chats stay concurrent', async () => {
    const { bridge, brain } = spineWith(null);
    const a = bridge.emit(inRoom);
    const b = bridge.emit(inGroup);
    await flush();

    // Two chats, two keys, no head-of-line blocking — exactly today's behavior for every
    // conversation that is its own instance.
    expect(brain.order).toContain('start:from the group');
    expect(brain.order).toContain('end:from the group');
    expect(brain.order).not.toContain('end:from the room');
    brain.release();
    await Promise.all([a, b]);
  });
});
