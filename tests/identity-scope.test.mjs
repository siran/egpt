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
// The mesh SERVICE and its wire codec — the responder half of the relay, exercised here against
// the REAL brainpool so 'which conversation does a relayed turn run in' is answered end to end.
import { createMeshService } from '../src/spine/mesh.mjs';
import { encodeMesh } from '../src/mesh/relay.mjs';
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

// THE PIN, as an operator writes it: FLAT on the agent, not under `conversation_defaults` —
// `conversation_defaults` means "node-wide default a conversation MAY override", the exact
// opposite of a pin, which no conversation may override.
const PINNED = { agents: { wren: { scope: 'room/wren' } } };
// The same reverse lookup, counting the calls, so "the pin never asks" is assertable.
const countingResolver = (rooms) => {
  const inner = memberResolver(rooms);
  const spy = (...a) => { spy.calls++; return inner(...a); };
  spy.calls = 0;
  return spy;
};

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
// THE GLOBAL WREN (operator 2026-09-01) — the second scope the module header predicted: a being
// pinned node-wide to ONE conversation, so every chat it is addressed in resolves to the same
// instance. It reads `being` and nothing else, and it is the ONLY rule that fires when it does.
describe('createIdentityScope — a being pinned node-wide to one conversation', () => {
  it('a pinned being resolves to the pin from an ordinary chat that is in NO room', async () => {
    const scope = createIdentityScope({ resolveMembers: memberResolver(NO_ROOMS), getConfig: () => PINNED });
    expect(await scope('wren', 'whatsapp', GROUP)).toEqual({ surface: 'room', chatId: 'wren', pinned: true });
  });

  it('the pin BEATS wa-group membership, and never even asks: an explicit declaration about a BEING outranks an inference about a CHAT', async () => {
    const spy = countingResolver(JOINED);           // this chat WOULD resolve to room/acim
    const scope = createIdentityScope({ resolveMembers: spy, getConfig: () => PINNED });
    expect(await scope('wren', 'whatsapp', GROUP)).toEqual({ surface: 'room', chatId: 'wren', pinned: true });
    expect(spy.calls).toBe(0);                      // no membership lookup at all
  });

  // WHICH KIND OF SHARED KEY IS THIS (operator 2026-09-01)? Both rules collapse several chats onto
  // one instance, but the spine has to tell them apart: a pinned being is prompted with the message
  // that arrived and never with the key's accumulated cycle, while a membership scope keeps
  // accumulating exactly as it does today (*"E remains independent per conversation, as always"*).
  // So the PIN says so on its way out, and the membership branch says nothing at all.
  it('the pin branch reports `pinned: true`; the membership branch reports no flag', async () => {
    const scope = createIdentityScope({ resolveMembers: memberResolver(JOINED), getConfig: () => PINNED });
    expect(await scope('wren', 'whatsapp', GROUP)).toEqual({ surface: 'room', chatId: 'wren', pinned: true });
    // The SAME chat, an unpinned being: the wa-group membership answer, unchanged and unmarked.
    const membership = await scope('e', 'whatsapp', GROUP);
    expect(membership).toEqual({ surface: 'room', chatId: ROOM });
    expect('pinned' in membership).toBe(false);
  });

  it('ADDITIVE — a caller that reads only {surface, chatId} sees no difference', async () => {
    // The thread, the warm key, the conversation dir and the run config all read exactly two
    // fields; the flag is for the ONE caller that builds a prompt.
    const scope = createIdentityScope({ resolveMembers: memberResolver(NO_ROOMS), getConfig: () => PINNED });
    const { surface, chatId } = await scope('wren', 'whatsapp', GROUP);
    expect({ surface, chatId }).toEqual({ surface: 'room', chatId: 'wren' });
  });

  it('the pin is per-BEING, not per-node: an UNPINNED being in that SAME chat still gets the membership answer', async () => {
    const scope = createIdentityScope({ resolveMembers: memberResolver(JOINED), getConfig: () => PINNED });
    expect(await scope('e', 'whatsapp', GROUP)).toEqual({ surface: 'room', chatId: ROOM });
  });

  it('a chatId containing a `/` survives — split on the FIRST slash only', async () => {
    const scope = createIdentityScope({ resolveMembers: memberResolver(NO_ROOMS), getConfig: () => ({ agents: { wren: { scope: 'whatsapp/!a/b@g.us' } } }) });
    expect(await scope('wren', 'whatsapp', GROUP)).toEqual({ surface: 'whatsapp', chatId: '!a/b@g.us', pinned: true });
  });

  it('`shell/wren` and `room/wren` are the SAME pin — the surface goes through surfaceOf', async () => {
    // The console's NETWORK is `shell`; its SURFACE is `room` (identity.mjs TRANSPORT_SURFACE).
    // Without this an operator writing the network name would open a SECOND instance that reads
    // correctly in config.yaml and shares nothing with the first — a thread split with no error.
    const asShell = createIdentityScope({ resolveMembers: memberResolver(NO_ROOMS), getConfig: () => ({ agents: { wren: { scope: 'shell/wren' } } }) });
    const asRoom  = createIdentityScope({ resolveMembers: memberResolver(NO_ROOMS), getConfig: () => PINNED });
    expect(await asShell('wren', 'whatsapp', GROUP)).toEqual({ surface: 'room', chatId: 'wren', pinned: true });
    expect(await asShell('wren', 'whatsapp', GROUP)).toEqual(await asRoom('wren', 'whatsapp', GROUP));
  });

  it('a MALFORMED scope never throws — it falls through to today\'s answer, and says why', async () => {
    for (const bad of ['room', '/wren', 'room/', 42, {}, true]) {
      const logs = [];
      const scope = createIdentityScope({
        resolveMembers: memberResolver(JOINED),
        getConfig: () => ({ agents: { wren: { scope: bad } } }),
        onLog: (m) => logs.push(m),
      });
      // Today's answer, unchanged: half an address is never guessed at.
      expect(await scope('wren', 'whatsapp', GROUP)).toEqual({ surface: 'room', chatId: ROOM });
      expect(logs.join('\n')).toMatch(/agents\.wren\.scope/);
    }
    // An ABSENT scope is not malformed, and says nothing.
    for (const absent of [undefined, null, '']) {
      const logs = [];
      const scope = createIdentityScope({
        resolveMembers: memberResolver(NO_ROOMS),
        getConfig: () => ({ agents: { wren: { scope: absent } } }),
        onLog: (m) => logs.push(m),
      });
      expect(await scope('wren', 'whatsapp', GROUP)).toBe(null);
      expect(logs).toEqual([]);
    }
  });

  it('LOCK — with NO getConfig injected at all, every answer is exactly today\'s, for a would-be pinned being too', async () => {
    // Every existing caller and test fake wires none; this is the regression that matters most.
    expect(await scopeOver(JOINED)('wren', 'whatsapp', GROUP)).toEqual({ surface: 'room', chatId: ROOM });
    expect(await scopeOver(NO_ROOMS)('wren', 'whatsapp', GROUP)).toBe(null);
    expect(await scopeOver(TWO_ROOMS, () => {})('wren', 'whatsapp', GROUP)).toBe(null);
    expect(await scopeOver(NO_ROOMS)('wren', 'room', ROOM)).toBe(null);
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
async function harness({ rooms, results = [{ text: 'ok', sessionId: ACIM_THREAD }], scope } = {}) {
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
    ...(scope ? { resolveScope: scope } : rooms === undefined ? {} : { resolveScope: scopeOver(rooms) }),
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
    expect(Boolean((await joined.brain.scopeOf('e', groupEv)).pinned)).toBe(false);
  });

  // The seam the SPINE reads to build a prompt (operator 2026-09-01): the address is the turn key,
  // and `pinned` says the key is a node-wide pin rather than a membership scope. It comes out of the
  // resolve the turn already makes — the spine never asks a second time.
  it('the PIN reaches the spine through the same seam the address does; a membership scope carries no flag', async () => {
    const pinScope = createIdentityScope({ resolveMembers: memberResolver(NO_ROOMS), getConfig: () => PINNED });
    const { brain } = await harness({ scope: pinScope });
    expect(await brain.scopeOf('wren', groupEv)).toEqual({ surface: 'room', chatId: 'wren', pinned: true });
  });

  it('a pinned being IN its own pinned conversation is still pinned — the flag survives the "already there" branch', async () => {
    // room/wren resolving to room/wren is scoped:false (the address did not move), and that chat is
    // exactly the one whose own chatter would otherwise be the cycle wren gets prepended.
    const pinScope = createIdentityScope({ resolveMembers: memberResolver(NO_ROOMS), getConfig: () => PINNED });
    const { brain } = await harness({ scope: pinScope });
    const homeEv = { surface: 'room', chatId: 'wren', chatName: 'wren', line: 'An@[wren].room (14:05): sigue', body: 'sigue' };
    expect(await brain.scopeOf('wren', homeEv)).toEqual({ surface: 'room', chatId: 'wren', pinned: true });
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

// ─────────────────────────────────────────────────────────────────────────────
// REACHED THROUGH THE MESH (operator 2026-08-31, the same day and the same E):
// *"the mesh tail should get from/to agents separate, and so the threads. there should be
// relation between thread-id and the egpt-mesh. mesh is transport, not mixing."*
//
// Everything above assumes the group's message arrives on THIS node. The operator's E is
// reached the other way round: the group lives on the requester's account, and its line crosses
// as a relay envelope through the channel `egpt-mesh-do-kg`. The responder used to run that turn
// in the CHANNEL's conversation, so the membership rule the whole file is about could never fire
// for it — relay-E got its own thread, its own warm CLI and `access_level: regular`, no matter
// which room the group had been invited into.
//
// The envelope's `from:` carries the origin chat's NAME, and a NAME is the one part of a chat's
// identity that crosses accounts (the same group is `!6ljZJkx0OaY9ZVhEzFgi` on anrodz42 and
// `!HuXFQeZSY1X4khNDWTzz` on dolly.egpt — measured 2026-08-31). The responder resolves it to its
// OWN id and answers there; the scope above then does the rest with no further change.
const RELAY_CHANNEL = 'egpt-mesh-do-kg';

// The Bridge port surface mesh.mjs uses, plus the name→id resolver (forwarded by beeper-port
// since c84deac). `chatIds` is THIS node's own view: GROUP_NAME is the group's title, GROUP is
// the id THIS account knows it by — never the requester's.
function meshBridge({ chatIds = {} } = {}) {
  const b = {
    sent: [], streams: [], resolveCalls: [],
    async resolveChatId(nameOrId, opts) { b.resolveCalls.push({ nameOrId, opts }); return (nameOrId in chatIds) ? chatIds[nameOrId] : null; },
    send(chat, text) { b.sent.push({ chat, text }); return { ok: true }; },
    async postStatus() { return 'post-1'; },
    startStream(chat, init) {
      const h = { chat, init, updates: [], finals: [] };
      h.update = (t) => h.updates.push(t);
      h.finish = async (t) => { h.finals.push(t); };
      b.streams.push(h);
      return h;
    },
  };
  return b;
}

const meshFlush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

// One envelope, as the requester's node posts it: the human's body, the origin chat's NAME, and
// the target being.node. `to: e.do` is what puts this node on the hook.
const envelope = (from, body) => encodeMesh({ by: 'An', body, from, from_node: 'kg', to: 'e.do', post_id: 'p1' });

function meshOver(brain, bridge) {
  return createMeshService({
    bridge, brain,
    getConfig: () => ({ node_name: 'do', agents: { e: { configuration: 'egpt', name: 'e' } } }),
    onLog: () => {},
  });
}

describe('the mesh is TRANSPORT, not identity — a relayed group turn lands on the ROOM\'s instance', () => {
  it("THE OPERATOR'S CASE: perrito traducciones reached through egpt-mesh-do-kg runs on room/acim's thread, warm key and access_level", async () => {
    const { brain, pool, getState } = await harness({ rooms: JOINED });
    const bridge = meshBridge({ chatIds: { [GROUP_NAME]: GROUP } });
    const mesh = meshOver(brain, bridge);

    await mesh.handle({ surface: 'whatsapp', chatId: RELAY_CHANNEL, msgId: 'm1', body: envelope(GROUP_NAME, '@e traduce esto') });
    await meshFlush();

    expect(pool.calls).toHaveLength(1);
    // The same three keys THE ASK asserts for a locally-delivered group message — reached the
    // long way round, they resolve identically. One E, one memory, one pair of hands.
    expect(pool.calls[0].key).toBe('e:ccode:room:acim');
    expect(pool.calls[0].brainOptions.sessionId).toBe(ACIM_THREAD);
    expect(pool.calls[0].brainOptions.dangerouslySkipPermissions).toBe(true);   // the room's `all`
    // NOT A COPY, here either: the group's own entry gains no thread.
    expect(getBeing(getState(), 'whatsapp', GROUP, 'e')?.threadId ?? null).toBe(null);
    expect(getBeing(getState(), 'room', ROOM, 'e').threadId).toBe(ACIM_THREAD);
    // PROVENANCE: the being is told which chat the line arrived in, by its real name.
    expect(pool.calls[0].message).toMatch(new RegExp(`ARRIVED IN "${GROUP_NAME}"`));
    // TRANSPORT UNCHANGED: the answer still goes back out through the channel it came in on.
    expect(bridge.streams.map((s) => s.chat)).toEqual([RELAY_CHANNEL]);
  });

  it('...and the pre-change behaviour beside it: an origin that does not resolve here still answers in the CHANNEL', async () => {
    // The fallback, and the reason it must exist: this node is not in "Radio WnL", so there is
    // no local address for it. Guessing would key a live thread on a foreign account's id; the
    // turn runs in the transport chat instead, exactly as every relayed turn did before today.
    const { brain, pool } = await harness({ rooms: JOINED });
    const bridge = meshBridge({});                       // resolves nothing
    const mesh = meshOver(brain, bridge);

    await mesh.handle({ surface: 'whatsapp', chatId: RELAY_CHANNEL, msgId: 'm1', body: envelope('Radio WnL', '@e pon musica') });
    await meshFlush();

    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].key).toMatch(/^e:ccode:whatsapp:egpt-mesh-do-kg-\d{10}$/);
    expect(pool.calls[0].brainOptions.sessionId).toBe(null);                    // its own thread
    expect(pool.calls[0].brainOptions.dangerouslySkipPermissions).toBe(false);  // 'regular'
  });
});
