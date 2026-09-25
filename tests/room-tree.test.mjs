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
    // desktop/ joined on 2026-09-20 — the being's OWN surface, as opposed to media/ (what
    // the chat sent), files/ (the operator's shelf) and directives/ + scripts/ (what it was
    // given). It is here rather than in the sandbox pool profile because that profile is
    // scratch and is wiped on every lease; the conversation folder is the being's cwd and
    // the one place it can durably write.
    // outbox/ joined on 2026-09-22 — what the being hands OUT. It is created eagerly for the
    // same reason desktop/ is, and with one more: the drain (src/room-outbox.mjs) deliberately
    // creates nothing at all, so a being confined to this folder would have no way to make the
    // one folder the feature is addressed at.
    // heartbeats/ joined on 2026-09-25 — the being's own schedule, one <name>.yaml per beat, named
    // on the pointers card, so it must be really there.
    expect(treeOf(named.mkdirs, ROOM())).toEqual(['', 'desktop', 'directives', 'files', 'heartbeats', 'media', 'outbox', 'scripts', 'transcripts']);
  });

  // (The pointers card naming these folders is guarded in tests/pointers.test.mjs, which
  // derives its set from Room.treeDirs — not duplicated here.)

  // REPRODUCE-FIRST (operator 2026-07-26: "why an empty identity.d in namedrooms? fix,
  // please."): the tree existing is not the same as it being SEEDED. /rooms create must
  // populate directives/ with the room template's SHARED NN-*.md layers, exactly like a
  // conversation's turn-boundary seeding does — else the pointers card tells a room's
  // brain to read ./directives/ and it finds nothing there.
  // 00-identity.md is NOT among them since 2026-09-10: the personality is fed in context,
  // never filed (see conversations-state._sharedLayers).
  it('/rooms create SEEDS directives/ with the SHARED room template layers — not just an empty folder', async () => {
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
      .map((p) => relative(room.directivesDir, p))
      .filter((rel) => rel && !rel.startsWith('..'))
      .sort();
    expect(layerNames).toEqual(['10-actions.md', '30-pointers.md', '40-rules.md']);
    for (const [p, body] of Object.entries(named.writes)) {
      if (relative(room.directivesDir, p).startsWith('..')) continue;
      expect(body.trim()).not.toBe('');
    }
  });
});
