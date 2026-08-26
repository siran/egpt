// rooms-being-state.test.mjs — a ROOM's per-being state lives in config/rooms.yaml.
//
// THE BUG (operator 2026-08-26): rooms.yaml registers rooms — *"a conversation with a
// different base dir"* — but the RUNTIME state of a room's beings still landed in
// config/conversations.yaml, because recordThread → patchBeing writes the registry state
// regardless of surface. Live proof at the time: `radio` had a threadId + allowed_users in
// conversations.yaml while `dj-son` sat in rooms.yaml with only `heartbeats:`.
//
// These tests drive the REAL state IO pair (conversations-state readState/writeState — the
// one boot.mjs hands every service) against a throwaway config/ dir holding BOTH files, so
// they exercise the actual routing rather than a stand-in. Nothing here touches ~/.egpt:
// the rooms.yaml is resolved as the SIBLING of the conversations.yaml it is given.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { readState, writeState, emptyState, getBeing, recordThread, patchBeing, deleteBeing } from '../src/conversations-state.mjs';
import { createBrainPool } from '../src/spine/brainpool.mjs';
import { createContacts } from '../src/spine/contacts.mjs';

let dir, CONV, ROOMS;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'egpt-rooms-state-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  CONV = join(dir, 'config', 'conversations.yaml');
  ROOMS = join(dir, 'config', 'rooms.yaml');
});
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const writeConv = (contacts) => writeFileSync(CONV, YAML.stringify({ contacts }), 'utf8');
const readYaml = (p) => (existsSync(p) ? (YAML.parse(readFileSync(p, 'utf8')) ?? {}) : null);
const roomsRows = () => { const d = readYaml(ROOMS); return d?.rooms ?? d ?? {}; };

// A registered room, exactly as ensureContact mints one (surface `room`, slug = the name).
const ROOM_ENTRY = { slug: 'radio', conversation_path: '.egpt/conversations/room/radio', home_dir: '/c/Users/an' };
// …and a Beeper-backed conversation, the regression lock's subject.
const WA_ENTRY = { slug: 'morgan-2607011609', conversation_path: '.egpt/conversations/whatsapp/morgan-2607011609', home_dir: '/c/Users/an' };

describe('a room writes its per-being state to rooms.yaml, not conversations.yaml', () => {
  it('recordThread on surface `room` lands the thread in rooms.yaml', async () => {
    writeConv({ room: { radio: { ...ROOM_ENTRY } } });
    const state = await readState(CONV);
    await writeState(CONV, recordThread(state, 'room', 'radio', 'thread-abc', '2026-08-26T10:00:00.000Z', 'egpt'));

    expect(roomsRows()['room/radio'].agents.egpt).toEqual({
      threadId: 'thread-abc',
      threadCreatedAt: '2026-08-26T10:00:00.000Z',
      identityInjectedAt: '2026-08-26T10:00:00.000Z',
    });
    // …and conversations.yaml no longer carries it at all.
    const conv = readYaml(CONV);
    expect(conv.contacts.room.radio.agents).toBeUndefined();
    expect(readFileSync(CONV, 'utf8')).not.toContain('thread-abc');
  });

  it('the thread reads back through getBeing on the next load', async () => {
    writeConv({ room: { radio: { ...ROOM_ENTRY } } });
    await writeState(CONV, recordThread(await readState(CONV), 'room', 'radio', 'thread-abc', '2026-08-26T10:00:00.000Z', 'egpt'));

    const b = getBeing(await readState(CONV), 'room', 'radio', 'egpt');
    expect(b.present).toBe(true);
    expect(b.threadId).toBe('thread-abc');
  });

  it('the per-conversation OVERRIDE tier — access_level / allowed_users / sandboxed / mode — is read from rooms.yaml', async () => {
    writeConv({ room: { radio: { ...ROOM_ENTRY } } });
    writeFileSync(ROOMS, YAML.stringify({
      rooms: {
        'room/radio': {
          heartbeats: { dj: false },
          agents: { egpt: { access_level: 'all', allowed_users: ['16468217865'], sandboxed: false, mode: 'auto' } },
        },
      },
    }), 'utf8');

    const b = getBeing(await readState(CONV), 'room', 'radio', 'egpt');
    expect(b.accessLevel).toBe('all');
    expect(b.allowedUsers).toEqual(['16468217865']);
    expect(b.sandboxed).toBe(false);
    expect(b.mode).toBe('auto');
  });

  it('a later write MERGES into the room row — the operator\'s other blocks and comments survive', async () => {
    writeConv({ room: { radio: { ...ROOM_ENTRY } } });
    writeFileSync(ROOMS, '# operator notes\nrooms:\n  room/radio:\n    heartbeats:\n      dj: false\n  room/dj-son:\n    heartbeats:\n      dj: true\n', 'utf8');

    await writeState(CONV, recordThread(await readState(CONV), 'room', 'radio', 'thread-abc', '2026-08-26T10:00:00.000Z', 'egpt'));

    const text = readFileSync(ROOMS, 'utf8');
    expect(text).toContain('# operator notes');
    const rows = roomsRows();
    expect(rows['room/radio'].heartbeats).toEqual({ dj: false });     // sibling block kept
    expect(rows['room/dj-son'].heartbeats).toEqual({ dj: true });     // sibling ROW kept
    expect(rows['room/radio'].agents.egpt.threadId).toBe('thread-abc');
  });

  it('deleteBeing (the /agents reset path) clears the block in rooms.yaml', async () => {
    writeConv({ room: { radio: { ...ROOM_ENTRY } } });
    writeFileSync(ROOMS, YAML.stringify({ rooms: { 'room/radio': { heartbeats: { dj: false }, agents: { egpt: { threadId: 'thread-abc' } } } } }), 'utf8');

    await writeState(CONV, deleteBeing(await readState(CONV), 'room', 'radio', 'egpt'));

    expect(roomsRows()['room/radio'].agents).toBeUndefined();
    expect(roomsRows()['room/radio'].heartbeats).toEqual({ dj: false });   // the rest of the row survives
    expect(getBeing(await readState(CONV), 'room', 'radio', 'egpt').present).toBe(false);
  });

  it('an unrelated state write does not churn rooms.yaml', async () => {
    writeConv({ room: { radio: { ...ROOM_ENTRY, agents: { egpt: { threadId: 'thread-abc' } } } } });
    await writeState(CONV, await readState(CONV));      // the migrating write
    const first = readFileSync(ROOMS, 'utf8');
    await writeState(CONV, await readState(CONV));      // nothing changed since
    expect(readFileSync(ROOMS, 'utf8')).toBe(first);
  });
});

// ── REGRESSION LOCK ─────────────────────────────────────────────────────────
describe('a Beeper conversation is COMPLETELY unaffected', () => {
  it('reads and writes its per-being state through conversations.yaml, and never touches rooms.yaml', async () => {
    writeConv({ whatsapp: { 'morgan-chat': { ...WA_ENTRY, agents: { egpt: { access_level: 'regular', allowed_users: ['u-1'] } } } } });

    const before = getBeing(await readState(CONV), 'whatsapp', 'morgan-chat', 'egpt');
    expect(before.accessLevel).toBe('regular');
    expect(before.allowedUsers).toEqual(['u-1']);

    await writeState(CONV, recordThread(await readState(CONV), 'whatsapp', 'morgan-chat', 'wa-thread', '2026-08-26T10:00:00.000Z', 'egpt'));

    expect(existsSync(ROOMS)).toBe(false);                                   // rooms.yaml never created
    const conv = readYaml(CONV);
    expect(conv.contacts.whatsapp['morgan-chat'].agents.egpt.threadId).toBe('wa-thread');
    expect(conv.contacts.whatsapp['morgan-chat'].agents.egpt.access_level).toBe('regular');
    expect(getBeing(await readState(CONV), 'whatsapp', 'morgan-chat', 'egpt').threadId).toBe('wa-thread');
  });

  it('a room row in rooms.yaml never leaks into a same-slug conversation on another surface', async () => {
    writeConv({
      room:     { radio: { ...ROOM_ENTRY } },
      whatsapp: { 'radio-chat': { ...WA_ENTRY, slug: 'radio', conversation_path: '.egpt/conversations/whatsapp/radio' } },
    });
    writeFileSync(ROOMS, YAML.stringify({ rooms: { 'room/radio': { agents: { egpt: { threadId: 'room-thread' } } } } }), 'utf8');

    const st = await readState(CONV);
    expect(getBeing(st, 'room', 'radio', 'egpt').threadId).toBe('room-thread');
    expect(getBeing(st, 'whatsapp', 'radio-chat', 'egpt').present).toBe(false);
  });
});

// ── MIGRATION ───────────────────────────────────────────────────────────────
describe('a room with LEGACY state in conversations.yaml keeps its thread', () => {
  const legacy = {
    threadId: '85937f93-839e-43d0-b931-caa7d2d8b56f',
    threadCreatedAt: '2026-08-20T02:47:41.779Z',
    identityInjectedAt: '2026-08-20T02:47:41.779Z',
    access_level: 'all',
    allowed_users: ['16468217865', '@anrodriguez:beeper.com'],
  };

  it('reads through to the legacy block — no rooms.yaml row yet, no fresh session', async () => {
    writeConv({ room: { radio: { ...ROOM_ENTRY, agents: { egpt: legacy } } } });
    const b = getBeing(await readState(CONV), 'room', 'radio', 'egpt');
    expect(b.threadId).toBe(legacy.threadId);            // ← the continuity that must not be lost
    expect(b.accessLevel).toBe('all');
    expect(b.allowedUsers).toEqual(legacy.allowed_users);
  });

  it('the first write lifts it into rooms.yaml and drops it from conversations.yaml — once', async () => {
    writeConv({ room: { radio: { ...ROOM_ENTRY, agents: { egpt: legacy } } } });
    await writeState(CONV, await readState(CONV));

    expect(roomsRows()['room/radio'].agents.egpt).toEqual(legacy);
    expect(readYaml(CONV).contacts.room.radio.agents).toBeUndefined();
    expect(getBeing(await readState(CONV), 'room', 'radio', 'egpt').threadId).toBe(legacy.threadId);
  });

  it('a rooms.yaml being wins over the legacy one, and a legacy-only sibling being survives the merge', async () => {
    writeConv({ room: { radio: { ...ROOM_ENTRY, agents: { egpt: legacy, wren: { threadId: 'wren-legacy' } } } } });
    writeFileSync(ROOMS, YAML.stringify({ rooms: { 'room/radio': { agents: { egpt: { threadId: 'newer-thread' } } } } }), 'utf8');

    const st = await readState(CONV);
    expect(getBeing(st, 'room', 'radio', 'egpt').threadId).toBe('newer-thread');
    expect(getBeing(st, 'room', 'radio', 'wren').threadId).toBe('wren-legacy');

    await writeState(CONV, st);
    expect(Object.keys(roomsRows()['room/radio'].agents).sort()).toEqual(['egpt', 'wren']);
  });
});

// ── END TO END: a room's FIRST TURN through the real brainpool ──────────────
describe('a room\'s first turn records its thread into rooms.yaml', () => {
  const roomEv = { surface: 'room', chatId: 'radio', line: 'An@[radio] (14:05): hola', body: 'hola' };

  function harness(scripted) {
    const calls = [];
    const pool = {
      run(key, message, _onPartial, opts) { calls.push({ key, message, brainOptions: opts.brainOptions }); return Promise.resolve(scripted); },
      evict() {},
    };
    const loadState = () => readState(CONV);
    const writeStateFn = (s) => writeState(CONV, s);
    const io = { mkdir: async () => {}, readFile: async () => null, writeFile: async () => {} };
    const brain = createBrainPool({
      pool,
      getConfig: () => ({ agents: { egpt: { conversation_defaults: { access_level: 'regular' } } } }),
      contacts: createContacts({ loadState, writeState: writeStateFn, io }),
      loadState, writeState: writeStateFn,
      defaultKey: 'egpt',
      io,
      resolveConfig: () => ({}),
      loadFeed: async () => '', loadManifest: async () => '',
      seedLayers: async () => {},
      loadPermission: () => null,
    });
    return { brain, pool, calls };
  }

  it('mints the thread into rooms.yaml — conversations.yaml keeps only the pointer row', async () => {
    writeConv({ room: { radio: { ...ROOM_ENTRY } } });
    const { brain, calls } = harness({ text: 'hey', sessionId: 'sid-room-1' });

    const out = await brain.turn('egpt', roomEv);
    expect(out.sessionId).toBe('sid-room-1');
    expect(calls[0].brainOptions.sessionId).toBeNull();           // fresh — nothing to resume

    expect(roomsRows()['room/radio'].agents.egpt.threadId).toBe('sid-room-1');
    expect(readFileSync(CONV, 'utf8')).not.toContain('sid-room-1');
  });

  it('RESUMES a room whose thread is in rooms.yaml (and a legacy one still in conversations.yaml)', async () => {
    writeConv({ room: { radio: { ...ROOM_ENTRY } } });
    writeFileSync(ROOMS, YAML.stringify({ rooms: { 'room/radio': { agents: { egpt: { threadId: 'stored-room-thread' } } } } }), 'utf8');
    const a = harness({ text: 'hey', sessionId: 'stored-room-thread' });
    await a.brain.turn('egpt', roomEv);
    expect(a.calls[0].brainOptions.sessionId).toBe('stored-room-thread');

    rmSync(ROOMS);
    writeConv({ room: { radio: { ...ROOM_ENTRY, agents: { egpt: { threadId: 'legacy-room-thread' } } } } });
    const b = harness({ text: 'hey', sessionId: 'legacy-room-thread' });
    await b.brain.turn('egpt', roomEv);
    expect(b.calls[0].brainOptions.sessionId).toBe('legacy-room-thread');   // continuity kept
  });
});
