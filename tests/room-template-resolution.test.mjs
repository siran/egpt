// room-template-resolution.test.mjs — operator ruling 2026-07-25: "roomTemplateDir prefer
// the newer file." roomTemplateDir() used to pick the profile dir WHOLESALE whenever it
// existed, so an EDIT to a repo-shipped room-template layer (config/skeletons/room/*.md)
// could never reach an already-seeded profile — the profile copy wins outright and the
// upgraded repo copy is never even looked at. This suite reproduces that with REAL files
// (no mocked fs): a profile copy and a repo copy of the SAME layer filename, mtimes set
// explicitly via fs.utimesSync (never relying on write order), asserting resolution now
// goes PER FILE by modification time — whichever copy is newer wins, either direction —
// plus enumeration sees the UNION of both dirs (a repo-only layer must still be found).
//
// The profile side lives in an isolated tmp EGPT_HOME (existing test convention). The
// "repo copy" is the REAL config/skeletons/room/ next to this repo's shipped templates
// (ROOM_TEMPLATE_SHIPPED_DIR is derived from the module's own file location, not
// overridable) — we add two uniquely-named, never-before-seen layer files there for the
// duration of this suite and remove them again in afterAll, so the shipped repo tree is
// left exactly as found.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tmpHome = join(tmpdir(), `egpt-roomtpl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;

const SHIPPED_ROOM_DIR = fileURLToPath(new URL('../config/skeletons/room/', import.meta.url));
const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const MTIME_LAYER = `77-repro-mtime-${token}.md`;          // exists in BOTH dirs — mtime decides
const SHIPPED_ONLY_LAYER = `78-repro-shipped-only-${token}.md`; // exists ONLY in the repo dir

const profileRoomDir = join(tmpHome, 'config', 'skeletons', 'room');
const profileLayerPath = join(profileRoomDir, MTIME_LAYER);
const shippedLayerPath = join(SHIPPED_ROOM_DIR, MTIME_LAYER);
const shippedOnlyPath = join(SHIPPED_ROOM_DIR, SHIPPED_ONLY_LAYER);

let readIdentityFeed;

const OLDER = new Date(Date.now() - 24 * 60 * 60 * 1000);
const NEWER = new Date();

beforeAll(async () => {
  await mkdir(profileRoomDir, { recursive: true });
  ({ readIdentityFeed } = await import('../src/conversations-state.mjs'));
});

afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await rm(tmpHome, { recursive: true, force: true }); } catch {}
  try { await rm(shippedLayerPath, { force: true }); } catch {}
  try { await rm(shippedOnlyPath, { force: true }); } catch {}
});

describe('room template resolution — per-file, newest mtime wins', () => {
  it('the REPO (shipped) copy wins when it is newer than the profile copy', async () => {
    await writeFile(profileLayerPath, 'PROFILE-STALE-MARKER', 'utf8');
    await writeFile(shippedLayerPath, 'REPO-FRESH-MARKER', 'utf8');
    await utimes(profileLayerPath, OLDER, OLDER);
    await utimes(shippedLayerPath, NEWER, NEWER);

    const feed = await readIdentityFeed('zzz-repro-no-such-identity');
    expect(feed).toContain('REPO-FRESH-MARKER');
    expect(feed).not.toContain('PROFILE-STALE-MARKER');
  });

  it('the PROFILE copy wins when it is newer (an operator edit stays sacred)', async () => {
    await writeFile(profileLayerPath, 'PROFILE-FRESH-MARKER', 'utf8');
    await writeFile(shippedLayerPath, 'REPO-STALE-MARKER', 'utf8');
    await utimes(shippedLayerPath, OLDER, OLDER);
    await utimes(profileLayerPath, NEWER, NEWER);

    const feed = await readIdentityFeed('zzz-repro-no-such-identity');
    expect(feed).toContain('PROFILE-FRESH-MARKER');
    expect(feed).not.toContain('REPO-STALE-MARKER');
  });

  it('a layer shipped ONLY in the repo dir is still enumerated once a profile dir exists', async () => {
    await writeFile(shippedOnlyPath, 'REPO-ONLY-MARKER', 'utf8');
    // profileRoomDir exists (created in beforeAll + used by the tests above) but has no
    // copy of SHIPPED_ONLY_LAYER — the union must still surface the repo-only file.
    const feed = await readIdentityFeed('zzz-repro-no-such-identity');
    expect(feed).toContain('REPO-ONLY-MARKER');
  });
});
