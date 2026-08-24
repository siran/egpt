// pointers.test.mjs — the POINTERS CARD is `config/skeletons/room/30-pointers.md`, and
// nothing else. It used to have a second, INLINE copy in src/pointers.mjs (POINTERS_TEXT +
// seedPointers); the two DIVERGED, and the module's only caller died with the old spine, so
// the tests here guarded a corpse while the live card rotted. src/pointers.mjs was deleted
// 2026-07-25 and this file now guards the surviving card.
//
// WHAT ROTS: the card is fed at kickoff AND copied to <conv>/identity.d/30-pointers.md, and
// E reads it while confined to its conversation folder. So every `./path` it names must be a
// path a conversation folder ACTUALLY has. It listed `./transcripts/` — a directory nothing
// in the codebase has ever created — sending E to a dead end.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { Room } from '../src/room-core.mjs';

const CARD = readFileSync(fileURLToPath(new URL('../config/skeletons/room/30-pointers.md', import.meta.url)), 'utf8');

// What a conversation folder REALLY holds — DERIVED from the ONE owner of the tree
// (Room.treeDirs, room-core.mjs) plus the two files the Room declares (transcript.md,
// config.yaml), so this set can never drift from what is created on disk the way the
// hand-written copy did. Optional daily-YYYY-MM-DD.md summaries live here too.
const CONV = Room.forChat('whatsapp', 'x');
const REAL_PATHS = new Set([
  ...CONV.treeDirs().slice(1).map((d) => `./${basename(d)}/`),   // slice(1): baseDir itself is not a './' pointer
  `./${basename(CONV.transcriptPath)}`,   // no configPath: the room rung moved to config/rooms.yaml
]);

describe('the pointers card (config/skeletons/room/30-pointers.md)', () => {
  it('points at ./identity.d/ — the folder the layers are actually seeded into', () => {
    expect(CARD).toContain('./identity.d/');
  });

  // Operator 2026-07-26: "an *.x.md goes in the scripts/ folder of a Room, so I can tell E,
  // do yyy and it knows to read the textecutable. we have to add to pointer file an
  // instruction like 'if you are asked to do something, check the x.md folder'." Being TOLD
  // is the whole feature — a scripts/ folder E never hears about is dead weight.
  it('tells E to look in ./scripts/ when it is asked to DO something', () => {
    expect(CARD).toContain('./scripts/');
    expect(CARD).toMatch(/\.x\.md/);
    expect(CARD).toMatch(/asked to DO something/);
  });

  // HONESTY: E's allowed_tools are Read/Write/Edit/Glob/Grep/WebSearch/WebFetch/Task — NO
  // Bash. It carries a textecutable out with ITS OWN tools; it cannot shell out to
  // src/tools/textecute.mjs. The card must not promise a run it cannot perform.
  it('does not promise E a shell it does not have', () => {
    expect(CARD).toMatch(/with my own tools/);
    expect(CARD).not.toMatch(/textecute\.mjs|node src\/tools|\bBash\b/);
  });

  it('names ONLY paths a conversation folder actually has', () => {
    const named = [...CARD.matchAll(/\.\/[A-Za-z0-9._-]+\/?/g)].map((m) => m[0]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((p) => !REAL_PATHS.has(p))).toEqual([]);
  });

  // 2026-07-26: ./transcripts/ is no longer the dead end that got this line deleted — it is
  // part of the Room tree (Room.treeDirs), so every conversation has the folder, and a thread
  // change archives the finished transcript into it. The card may name it again; the REAL_PATHS
  // check above is what keeps that honest (it is derived from the tree, not from this list).
  it('names ./transcripts/ — and the Room tree really creates it', () => {
    expect(CARD).toMatch(/\.\/transcripts\//);
    expect(CONV.treeDirs().map((d) => basename(d))).toContain('transcripts');
  });

});
