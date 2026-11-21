// room-template-resolution.test.mjs — operator ruling 2026-07-25: "roomTemplateDir prefer
// the newer file." roomTemplateDir() used to pick the profile dir WHOLESALE whenever it
// existed, so an EDIT to a repo-shipped room-template layer (config/skeletons/room/*.md)
// could never reach an already-seeded profile — the profile copy wins outright and the
// upgraded repo copy is never even looked at. This suite reproduces that with REAL files
// (no mocked fs): a profile copy of a SHIPPED layer, its mtime set explicitly via utimes
// against the shipped file's own (never relying on write order), asserting resolution now
// goes PER FILE by modification time — whichever copy is newer wins, either direction —
// plus enumeration sees the UNION of both dirs (a repo-only layer must still be found).
//
// Only the profile side is written, in an isolated tmp EGPT_HOME. The shipped
// config/skeletons/room/ is READ, never written: a test that adds files to the checkout
// races every other file reading that folder (reader-level.test.mjs).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tmpHome = join(tmpdir(), `egpt-roomtpl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;

const SHIPPED_ROOM_DIR = fileURLToPath(new URL('../config/skeletons/room/', import.meta.url));
const MTIME_LAYER = '40-rules.md';          // shipped, and copied into the profile below — mtime decides
const SHIPPED_ONLY_LAYER = '10-actions.md'; // shipped, never in the profile
const shippedText = (file) => readFileSync(join(SHIPPED_ROOM_DIR, file), 'utf8').trim();   // neither holds a {{placeholder}}

const profileRoomDir = join(tmpHome, 'config', 'skeletons', 'room');
const profileLayerPath = join(profileRoomDir, MTIME_LAYER);

let readIdentityFeed;

const DAY = 24 * 60 * 60 * 1000;
const shippedMs = statSync(join(SHIPPED_ROOM_DIR, MTIME_LAYER)).mtimeMs;
const OLDER = new Date(shippedMs - DAY);
const NEWER = new Date(shippedMs + DAY);

beforeAll(async () => {
  await mkdir(profileRoomDir, { recursive: true });
  ({ readIdentityFeed } = await import('../src/conversations-state.mjs'));
});

afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await rm(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('room template resolution — per-file, newest mtime wins', () => {
  it('the REPO (shipped) copy wins when it is newer than the profile copy', async () => {
    await writeFile(profileLayerPath, 'PROFILE-STALE-MARKER', 'utf8');
    await utimes(profileLayerPath, OLDER, OLDER);

    const feed = await readIdentityFeed('zzz-repro-no-such-identity');
    expect(feed).toContain(shippedText(MTIME_LAYER));
    expect(feed).not.toContain('PROFILE-STALE-MARKER');
  });

  it('the PROFILE copy wins when it is newer (an operator edit stays sacred)', async () => {
    await writeFile(profileLayerPath, 'PROFILE-FRESH-MARKER', 'utf8');
    await utimes(profileLayerPath, NEWER, NEWER);

    const feed = await readIdentityFeed('zzz-repro-no-such-identity');
    expect(feed).toContain('PROFILE-FRESH-MARKER');
    expect(feed).not.toContain(shippedText(MTIME_LAYER));
  });

  it('a layer shipped ONLY in the repo dir is still enumerated once a profile dir exists', async () => {
    // profileRoomDir exists (created in beforeAll + used by the tests above) but has no
    // copy of SHIPPED_ONLY_LAYER — the union must still surface the repo-only file.
    const feed = await readIdentityFeed('zzz-repro-no-such-identity');
    expect(feed).toContain(shippedText(SHIPPED_ONLY_LAYER));
  });
});
