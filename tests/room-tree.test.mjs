// room-tree.test.mjs — ONE OWNER OF THE ROOM TREE (operator 2026-07-26: "the work is for
// the Room abstraction, it is then for free in a room or conversation on any network").
//
// THE DRIFT THIS LOCKS DOWN: the directory list was written out TWICE — once in
// src/spine/commands.mjs (/room create's mkdir loop) and once in
// src/conversations-state.mjs (seedIdentityLayers) — and the two copies had already
// disagreed: /rooms create made media/ + files/, seeding did not, so an operator-named room
// and a chat conversation were NOT the same Room on disk. A conversation IS a Room with
// another base_dir; if the two creation paths can produce different trees, the abstraction
// is a shared helper wearing a class.
//
// The assertion is deliberately about the RELATIVE dir set (the tree BELOW baseDir), not
// absolute paths — the two bases differ by surface (conversations/room/<slug> vs
// conversations/<surface>/<slug>); the tree inside them must not.
//
// Both paths already take an `io` seam ({ mkdir, readFile, writeFile }), so this runs
// fully in-memory: no profile is touched, nothing is written to disk.
import { describe, it, expect } from 'vitest';
import { relative } from 'node:path';
import { Room } from '../src/room-core.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import { seedIdentityLayers } from '../src/conversations-state.mjs';

const SURFACE = 'whatsapp';
const SLUG = 'tree-fixture';
const ROOM_NAME = 'tree-fixture';

// An io seam that RECORDS mkdir and every write (path -> bytes). readFile always misses, so
// seedIdentityLayers takes its copy-if-missing branch (it would otherwise skip layers) and
// /rooms create's stat-probe reports "no such room yet".
function captureIo() {
  const mkdirs = [];
  const writes = {};
  const miss = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  return {
    mkdirs,
    writes,
    io: {
      mkdir: async (p) => { mkdirs.push(p); },
      writeFile: async (p, d) => { writes[p] = d; },
      readFile: async () => miss(),
      stat: async () => miss(),
    },
  };
}

// The tree a path created, as leaf names relative to that Room's own base ('' = the base
// folder itself), deduped + sorted so creation ORDER is not part of the contract.
const treeOf = (mkdirs, room) => [...new Set(mkdirs.map((p) => relative(room.baseDir(), p)))].sort();

// The shared (surface, chatId) → Room resolver boot injects. `/rooms create <name>` reaches
// it as ('room', <name>) — a room is a conversation on surface `room` — and here the slug
// IS the name, so the created tree is the one ROOM lands at below.
const resolveConvRoom = async (surface, chatId) => Room.forChat(surface, chatId);
const ROOM = () => Room.forChat('room', ROOM_NAME);

describe('ONE owner of the Room tree — both creation paths make the SAME tree', () => {
  it('/rooms create <name> and seeding a conversation produce the identical dir set', async () => {
    // (a) the operator-named-room path — /rooms create
    const named = captureIo();
    const cmds = createCommands({
      getConfig: () => ({ whatsapp: { chat_id: '!self' } }),
      send: async () => {},
      io: named.io,
      resolveConvRoom,
    });
    await cmds.run({ chatId: '!self', surface: SURFACE, body: `/rooms create ${ROOM_NAME}` });

    // (b) the conversation path — the turn-boundary seeding
    const conv = captureIo();
    await seedIdentityLayers(Room.forChat(SURFACE, SLUG), 'egpt', { io: conv.io });

    const namedTree = treeOf(named.mkdirs, ROOM());
    const convTree = treeOf(conv.mkdirs, Room.forChat(SURFACE, SLUG));

    expect(namedTree.length).toBeGreaterThan(1);   // the capture worked at all
    expect(convTree).toEqual(namedTree);           // ← a conversation IS a Room: same tree
  });

  it('that ONE tree is exactly what Room declares — no path invents a folder of its own', async () => {
    const named = captureIo();
    const cmds = createCommands({
      getConfig: () => ({ whatsapp: { chat_id: '!self' } }),
      send: async () => {},
      io: named.io,
      resolveConvRoom,
    });
    await cmds.run({ chatId: '!self', surface: SURFACE, body: `/rooms create ${ROOM_NAME}` });
    // '' is the base folder; the rest are the dir getters room-core.mjs declares.
    expect(treeOf(named.mkdirs, ROOM())).toEqual(['', 'files', 'identity.d', 'media', 'scripts', 'transcripts']);
  });

  // REPRODUCE-FIRST (operator 2026-07-26: "why an empty identity.d in namedrooms? fix,
  // please."): the tree existing is not the same as it being SEEDED. /rooms create must
  // populate identity.d/ with the room template's NN-*.md layers, exactly like a
  // conversation's turn-boundary seeding does — else both pointer cards tell a room's
  // brain to read ./identity.d/ and find nothing there.
  it('/rooms create SEEDS identity.d/ with the room template layers — not just an empty folder', async () => {
    const named = captureIo();
    const cmds = createCommands({
      getConfig: () => ({ whatsapp: { chat_id: '!self' } }),
      send: async () => {},
      io: named.io,
      resolveConvRoom,
    });
    await cmds.run({ chatId: '!self', surface: SURFACE, body: `/rooms create ${ROOM_NAME}` });

    const room = ROOM();
    const layerNames = Object.keys(named.writes)
      .map((p) => relative(room.identityDir, p))
      .filter((rel) => rel && !rel.startsWith('..'))
      .sort();
    expect(layerNames).toEqual(['00-identity.md', '10-actions.md', '30-pointers.md', '40-rules.md']);
    for (const [p, body] of Object.entries(named.writes)) {
      if (relative(room.identityDir, p).startsWith('..')) continue;
      expect(body.trim()).not.toBe('');
    }
  });
});
