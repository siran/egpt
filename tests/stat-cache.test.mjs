// stat-cache.test.mjs — config/registry files are read and parsed only when they changed
// (operator 2026-10-18: "an in-memory copy works if the files haven't changed"). Reads are counted
// through the cache's io seam; an external edit is picked up on the next read; our own
// writeState is visible at once without a read or a parse.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createStatCache, RACY_MS } from '../src/stat-cache.mjs';
import { readState, writeState, parse, emptyState, mutateState, conversationPathOf } from '../src/conversations-state.mjs';
import { readRoomsFile } from '../src/rooms-file.mjs';
import { configContentHashSync } from '../src/tools/config-io.mjs';
import { createContacts } from '../src/spine/contacts.mjs';

let dir;
beforeEach(async () => { dir = await fs.mkdtemp(join(os.tmpdir(), 'egpt-stat-cache-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

// A cache over the real fs that counts what it reads.
function counting() {
  const n = { reads: 0, readsSync: 0 };
  const cache = createStatCache({ io: {
    readFile: (...a) => { n.reads++; return fs.readFile(...a); },
    readFileSync: (...a) => { n.readsSync++; return readFileSync(...a); },
  } });
  return { cache, n };
}
// Settled: last written long enough ago that a read of it is trusted (see RACY_MS).
async function settle(path) { const t = (Date.now() - RACY_MS * 5) / 1000; await fs.utimes(path, t, t); }
async function writeSettled(path, text) { await fs.writeFile(path, text, 'utf8'); await settle(path); }

const CONV = `contacts:
  whatsapp:
    "chat-1": # Group One
      conversation_path: .egpt/conversations/whatsapp/Group One
      home_dir: /c/Users/fixture
      agents:
        egpt:
          mode: on
          threadId: t-1
`;

describe('createStatCache', () => {
  it('an unchanged file is neither read nor parsed again', async () => {
    const p = join(dir, 'a.yaml');
    await writeSettled(p, 'x: 1\n');
    const { cache, n } = counting();
    let parses = 0;
    const parseFn = (t) => { parses++; return t; };
    expect(await cache.read(p, parseFn)).toBe('x: 1\n');
    expect(await cache.read(p, parseFn)).toBe('x: 1\n');
    expect(await cache.read(p, parseFn)).toBe('x: 1\n');
    expect(n.reads).toBe(1);
    expect(parses).toBe(1);
  });

  it('an external edit is picked up on the next read', async () => {
    const p = join(dir, 'a.yaml');
    await writeSettled(p, 'x: 1\n');
    const { cache, n } = counting();
    const id = (t) => t;
    await cache.read(p, id);
    await fs.writeFile(p, 'x: 22\n', 'utf8');
    expect(await cache.read(p, id)).toBe('x: 22\n');
    expect(n.reads).toBe(2);
  });

  it('a file read within RACY_MS of its mtime is read again (a same-tick rewrite cannot hide)', async () => {
    const p = join(dir, 'a.yaml');
    await fs.writeFile(p, 'x: 1\n', 'utf8');
    const { cache, n } = counting();
    const id = (t) => t;
    await cache.read(p, id);
    await cache.read(p, id);
    expect(n.reads).toBe(2);
  });

  it('absent → null; created later → read', async () => {
    const p = join(dir, 'later.yaml');
    const { cache } = counting();
    const id = (t) => t;
    expect(await cache.read(p, id)).toBe(null);
    await fs.writeFile(p, 'y: 2\n', 'utf8');
    expect(await cache.read(p, id)).toBe('y: 2\n');
  });

  it('readSync: same rules', async () => {
    const p = join(dir, 'c.yaml');
    await writeSettled(p, 'z: 1\n');
    const { cache, n } = counting();
    const id = (t) => t;
    cache.readSync(p, id); cache.readSync(p, id);
    expect(n.readsSync).toBe(1);
    await fs.writeFile(p, 'z: 333\n', 'utf8');
    expect(cache.readSync(p, id)).toBe('z: 333\n');
  });

  it('put (our own write) is trusted at once', async () => {
    const p = join(dir, 'own.yaml');
    await fs.writeFile(p, 'w: 1\n', 'utf8');
    const { cache, n } = counting();
    const id = (t) => t;
    cache.put(p, statSync(p), 'w: 1\n', id);
    expect(await cache.read(p, id)).toBe('w: 1\n');
    expect(n.reads).toBe(0);
  });
});

describe('readState / writeState — the in-memory registry', () => {
  it('an unchanged conversations.yaml is not re-read', async () => {
    const p = join(dir, 'conversations.yaml');
    await writeSettled(p, CONV);
    const { cache, n } = counting();
    const a = await readState(p, { cache });
    const b = await readState(p, { cache });
    expect(n.reads).toBe(1);
    expect(b).toEqual(a);
    expect(a.contacts.whatsapp['chat-1'].pushedName).toBe('Group One');
  });

  it('an external edit (operator, wren) is picked up on the next read', async () => {
    const p = join(dir, 'conversations.yaml');
    await writeSettled(p, CONV);
    const { cache } = counting();
    await readState(p, { cache });
    await fs.writeFile(p, CONV.replace('mode: on', 'mode: mention-direct'), 'utf8');
    expect((await readState(p, { cache })).contacts.whatsapp['chat-1'].agents.egpt.mode).toBe('mention-direct');
  });

  it('our own write is visible at once — no read, no parse', async () => {
    const p = join(dir, 'conversations.yaml');
    await writeSettled(p, CONV);
    const { cache, n } = counting();
    const s = await readState(p, { cache });
    s.contacts.whatsapp['chat-1'].agents.egpt.threadId = 't-2';
    await writeState(p, s, { cache });
    const after = await readState(p, { cache });
    expect(after.contacts.whatsapp['chat-1'].agents.egpt.threadId).toBe('t-2');
    expect(n.reads).toBe(1);
  });

  it('the written-through copy equals what a re-parse of the file gives', async () => {
    const p = join(dir, 'conversations.yaml');
    const state = {
      ...emptyState(),
      system: { thread: 'sys-1' },
      contacts: {
        whatsapp: {
          'chat-a': { slug: 'a-2607030000', pushedName: '  Spaced\nName  ', firstSeenAt: '2026-07-03T00:00:00Z', threadId: 'dead', mode: 'on', gone: undefined, agents: { egpt: { mode: 'on', threadId: 'live', allowed_users: ['u-1', 'u-2'] } } },
          'chat-b': { aliasOf: 'chat-a' },
          'chat-c': { slug: 'c-2607030000', pushedName: '', conversation_path: '.egpt/conversations/whatsapp/c-2607030000', home_dir: '/c/Users/x', loop_guard: { inbound: { turns: -1 } }, n: 12, flag: false, nil: null },
        },
        room: { radio: { slug: 'radio', pushedName: 'radio', agents: { egpt: { access_level: 'all', threadId: 'room-t' } } } },
      },
    };
    const { cache } = counting();
    await writeState(p, state, { cache });
    const cached = await readState(p, { cache });
    const reparsed = await readState(p, { cache: createStatCache() });
    expect(cached).toEqual(reparsed);
    expect(cached.contacts.whatsapp['chat-a'].pushedName).toBe('Spaced Name');
    expect(cached.contacts.whatsapp['chat-a'].firstSeenAt).toBeUndefined();
    expect(cached.contacts.room.radio.agents.egpt.threadId).toBe('room-t');
    expect(parse(readFileSync(p, 'utf8')).contacts.room.radio.agents).toBeUndefined();   // the room's block lives in rooms.yaml
  });

  it('a caller mutating its copy never reaches the next read', async () => {
    const p = join(dir, 'conversations.yaml');
    await writeSettled(p, CONV);
    const { cache } = counting();
    const a = await readState(p, { cache });
    a.contacts.whatsapp['chat-1'].agents.egpt.mode = 'off';
    expect((await readState(p, { cache })).contacts.whatsapp['chat-1'].agents.egpt.mode).toBe('on');
  });
});

describe('rooms.yaml / config.yaml', () => {
  it('readRoomsFile: unchanged → no re-read; edited → the new rows', async () => {
    const p = join(dir, 'rooms.yaml');
    await writeSettled(p, 'rooms:\n  room/a:\n    x: 1\n');
    const { cache, n } = counting();
    expect(await readRoomsFile({ path: p, cache })).toEqual({ 'room/a': { x: 1 } });
    await readRoomsFile({ path: p, cache });
    expect(n.reads).toBe(1);
    await fs.writeFile(p, 'rooms:\n  room/a:\n    x: 2\n  room/b: {}\n', 'utf8');
    expect(await readRoomsFile({ path: p, cache })).toEqual({ 'room/a': { x: 2 }, 'room/b': {} });
  });

  it('configContentHashSync: hashed once while unchanged, re-hashed on an edit, null while malformed', async () => {
    const p = join(dir, 'config.yaml');
    await writeSettled(p, 'node_name: kg\n');
    const { cache, n } = counting();
    const h1 = configContentHashSync(p, { cache });
    expect(configContentHashSync(p, { cache })).toBe(h1);
    expect(n.readsSync).toBe(1);
    await fs.writeFile(p, 'node_name: kgg\n', 'utf8');
    const h2 = configContentHashSync(p, { cache });
    expect(h2).not.toBe(h1);
    await fs.writeFile(p, 'node_name: [unclosed\n', 'utf8');
    expect(configContentHashSync(p, { cache })).toBe(null);
  });
});

describe('contacts.resolve — a known chat is a read, not a lock', () => {
  it('answers while another writer holds the registry lock', async () => {
    const state = parse(CONV);
    state.contacts.whatsapp['chat-1'].conversation_path = conversationPathOf('whatsapp', 'Group One');   // nothing to backfill
    const writeState = async () => {};
    const contacts = createContacts({ loadState: async () => state, writeState });
    let release;
    const held = mutateState(writeState, () => new Promise((r) => { release = r; }));
    const slug = await Promise.race([
      contacts.resolve('whatsapp', 'chat-1', { chatName: 'Group One' }),
      new Promise((r) => setTimeout(() => r('BLOCKED'), 500)),
    ]);
    release(); await held;
    expect(slug).toBe('Group One');
  });
});
