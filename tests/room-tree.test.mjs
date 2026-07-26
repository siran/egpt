// room-tree.test.mjs — ONE OWNER OF THE ROOM TREE (operator 2026-07-26: "the work is for
// the Room abstraction, it is then for free in a room or conversation on any network").
//
// THE DRIFT THIS LOCKS DOWN: the directory list was written out TWICE — once in
// src/spine/commands.mjs (/room create's mkdir loop) and once in
// src/conversations-state.mjs (seedIdentityLayers) — and the two copies had already
// disagreed: /room create made media/ + files/, seeding did not, so a NamedRoom and a
// conversation were NOT the same Room on disk. A conversation IS a Room with another
// base_dir; if the two creation paths can produce different trees, the abstraction is a
// shared helper wearing a class.
//
// The assertion is deliberately about the RELATIVE dir set (the tree BELOW baseDir), not
// absolute paths — the two roots differ by design (conversations/<surface>/<slug> vs
// rooms/<name>); the tree inside them must not.
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

// An io seam that RECORDS mkdir and swallows every write. readFile always misses, so
// seedIdentityLayers takes its copy-if-missing branch (it would otherwise skip layers) and
// /room create's stat-probe reports "no such room yet".
function captureIo() {
  const mkdirs = [];
  const miss = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  return {
    mkdirs,
    io: {
      mkdir: async (p) => { mkdirs.push(p); },
      writeFile: async () => {},
      readFile: async () => miss(),
      stat: async () => miss(),
    },
  };
}

// The tree a path created, as leaf names relative to that Room's own base ('' = the base
// folder itself), deduped + sorted so creation ORDER is not part of the contract.
const treeOf = (mkdirs, room) => [...new Set(mkdirs.map((p) => relative(room.baseDir(), p)))].sort();

describe('ONE owner of the Room tree — both creation paths make the SAME tree', () => {
  it('/room create <name> and seeding a conversation produce the identical dir set', async () => {
    // (a) the NamedRoom path — /room create
    const named = captureIo();
    const cmds = createCommands({
      getConfig: () => ({ whatsapp: { chat_id: '!self' } }),
      send: async () => {},
      io: named.io,
    });
    await cmds.run({ chatId: '!self', surface: SURFACE, body: `/room create ${ROOM_NAME}` });

    // (b) the conversation path — the turn-boundary seeding
    const conv = captureIo();
    await seedIdentityLayers(SURFACE, SLUG, 'egpt', { io: conv.io });

    const namedTree = treeOf(named.mkdirs, Room.named(ROOM_NAME));
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
    });
    await cmds.run({ chatId: '!self', surface: SURFACE, body: `/room create ${ROOM_NAME}` });
    // '' is the base folder; the rest are the dir getters room-core.mjs declares.
    expect(treeOf(named.mkdirs, Room.named(ROOM_NAME))).toEqual(['', 'files', 'identity.d', 'media', 'scripts', 'transcripts']);
  });
});
