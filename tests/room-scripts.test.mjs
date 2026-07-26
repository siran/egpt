// room-scripts.test.mjs — a Room has a `scripts/` folder of *.x.md TEXTECUTABLES, and
// because a conversation IS a Room (room-core.mjs) the conversation folder gets one too
// (operator 2026-07-26: "an *.x.md goes in the scripts/ folder of a Room, so I can tell E,
// do yyy and it knows to read the textecutable").
//
// WHAT THIS GUARDS — the `./transcripts/` dead-end of 2026-07-25: the pointers card
// advertised a directory NOTHING in the codebase ever created, so E was sent to a path that
// did not exist. tests/pointers.test.mjs checks the card's paths against a hand-kept
// whitelist; this file checks them against DISK. A pointer that says "look here first" is
// only allowed if the folder is really there the moment the card is readable.
//
// MECHANISM: egpt-home.mjs freezes EGPT_HOME from process.env ONCE at module load, so it is
// set here BEFORE any app module is imported and conversations-state is imported DYNAMICALLY
// inside beforeAll (the same mechanism boot-profile-contract.test.mjs uses; vitest gives each
// test FILE its own module registry). NO profile skeletons are laid down on purpose — the
// room template then resolves to the REPO's shipped config/skeletons/room/, so the card under
// test is the real shipped card, not a fixture that could drift from it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const HOME = join(os.tmpdir(), `egpt-room-scripts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = HOME;

const SURFACE = 'whatsapp';
const SLUG = 'scripts-fixture';
const CONV = join(HOME, 'conversations', SURFACE, SLUG);

// Every `./<dir>/` the card may name belongs to exactly one class:
//   SEEDED_NOW — created by seedIdentityLayers itself, so it MUST be on disk the instant the
//                card is readable. E is TOLD to go there; an absent folder is a dead end.
//   ON_DEMAND  — created by a service the first time it has something to put there (media/ on
//                the first saved file). "nothing saved yet" is honest; the card says as much.
// A directory in NEITHER class is a `./transcripts/` — a pointer to nothing.
const SEEDED_NOW = ['identity.d', 'scripts'];
const ON_DEMAND = ['media'];

let seeded;

beforeAll(async () => {
  await fs.mkdir(HOME, { recursive: true });
  const { seedIdentityLayers } = await import('../src/conversations-state.mjs');
  await seedIdentityLayers(SURFACE, SLUG, 'egpt');
  seeded = await fs.readFile(join(CONV, 'identity.d', '30-pointers.md'), 'utf8');
});

afterAll(async () => { await fs.rm(HOME, { recursive: true, force: true }); });

describe('a conversation gets its scripts/ folder (a conversation IS a Room)', () => {
  it('seeding a conversation creates <conv>/scripts/', async () => {
    expect((await fs.stat(join(CONV, 'scripts'))).isDirectory()).toBe(true);
  });

  it('the folder starts EMPTY — no example script is planted', async () => {
    expect(await fs.readdir(join(CONV, 'scripts'))).toEqual([]);
  });

  it('the seeded pointers card sits beside it and names ./scripts/', () => {
    expect(seeded).toContain('./scripts/');
  });

  // THE TEST THAT WOULD HAVE CAUGHT ./transcripts/ — the card's directories, asserted
  // against the filesystem rather than against the card's own text.
  it('every ./<dir>/ the SEEDED card names is either on disk now or made on first use', async () => {
    const dirs = [...new Set([...seeded.matchAll(/\.\/([A-Za-z0-9._-]+)\//g)].map((m) => m[1]))];
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs.filter((d) => !SEEDED_NOW.includes(d) && !ON_DEMAND.includes(d))).toEqual([]);
    for (const d of dirs.filter((d) => SEEDED_NOW.includes(d))) {
      expect((await fs.stat(join(CONV, d))).isDirectory()).toBe(true);
    }
  });
});
