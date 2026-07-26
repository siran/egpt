// prefer-newer.test.mjs — the SEEDED-FILE staleness trap, as a CLASS (operator 2026-07-26,
// hitting it a fourth time: "staleness trap? again? wtf?").
//
// Every file seed.mjs plants in the profile is COPY-IF-MISSING, so once a profile has a
// copy no upgrade can ever change it. That was fixed for ONE instance on 2026-07-25 — the
// room template (resolveRoomLayerFile, commit 0b03dc9) — and the fix was never applied to
// the class. This suite locks the RULE at every read path that consults a seeded profile
// file AND its shipped counterpart: the NEWER of the two wins, either direction.
//
//   1. the resolver itself (preferNewer)          — profile newer / shipped newer / one only
//   2. the AGENT TYPE file  config/agents/<t>.yaml vs src/brains/<t>.yaml   (the live failure)
//   3. the AUTO-MODE layer  config/skeletons/auto-mode.md vs the shipped copy
//
// (the room template's own direction tests live in room-template-resolution.test.mjs)
//
// REAL files with EXPLICIT utimes stamps — never write order. The profile side is an
// isolated tmp EGPT_HOME; the shipped side is a tmp dir where the reader lets us inject one
// (brains) and the REAL repo file where it does not (auto-mode.md is read through a
// module-derived path) — that file is only ever READ here, never touched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tmpHome = join(tmpdir(), `egpt-prefernewer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;

const OLDER = new Date(Date.UTC(2020, 0, 1));
const NEWER = new Date();

// A tmp stand-in for the two agent-type layers: <builtin>/ = the repo's src/brains,
// <agents>/ = the profile's config/agents. Both injectable into createBrains.
const builtinDir = join(tmpHome, 'shipped-brains');
const agentsDir = join(tmpHome, 'config', 'agents');
const TYPE = 'zzz-repro-type';

const profileSkeletons = join(tmpHome, 'config', 'skeletons');
const profileAutoMode = join(profileSkeletons, 'auto-mode.md');
const SHIPPED_AUTO_MODE = fileURLToPath(new URL('../config/skeletons/auto-mode.md', import.meta.url));

let preferNewer, createBrains, readAutoModeLayer;

beforeAll(async () => {
  await mkdir(builtinDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  await mkdir(profileSkeletons, { recursive: true });
  ({ preferNewer } = await import('../src/prefer-newer.mjs'));
  ({ createBrains } = await import('../src/spine/brains.mjs'));
  ({ readAutoModeLayer } = await import('../src/conversations-state.mjs'));
});

afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await rm(tmpHome, { recursive: true, force: true }); } catch {}
});

// Write both copies of one seeded file and stamp which is newer.
async function stamp(profilePath, profileText, shippedPath, shippedText, newer) {
  await writeFile(profilePath, profileText, 'utf8');
  await writeFile(shippedPath, shippedText, 'utf8');
  await utimes(profilePath, ...(newer === 'profile' ? [NEWER, NEWER] : [OLDER, OLDER]));
  await utimes(shippedPath, ...(newer === 'shipped' ? [NEWER, NEWER] : [OLDER, OLDER]));
}

describe('preferNewer — the one rule every seeded profile file resolves by', () => {
  const p = join(tmpHome, 'unit-profile.md');
  const s = join(tmpHome, 'unit-shipped.md');

  it('the PROFILE copy wins when it is newer (an operator edit stays sacred)', async () => {
    await stamp(p, 'PROFILE', s, 'SHIPPED', 'profile');
    expect(preferNewer(p, s)).toBe(p);
  });

  it('the SHIPPED copy wins when it is newer (a git pull restamps it, so the upgrade lands)', async () => {
    await stamp(p, 'PROFILE', s, 'SHIPPED', 'shipped');
    expect(preferNewer(p, s)).toBe(s);
  });

  it('only one existing → that one; neither → null', async () => {
    await rm(s, { force: true });
    expect(preferNewer(p, s)).toBe(p);
    await writeFile(s, 'SHIPPED', 'utf8');
    await rm(p, { force: true });
    expect(preferNewer(p, s)).toBe(s);
    await rm(s, { force: true });
    expect(preferNewer(p, s)).toBeNull();
  });
});

// THE LIVE FAILURE (operator 2026-07-26): a full commented allowed_tools vocabulary was
// shipped into the agent-type file and ~/.egpt/config/agents/egpt.yaml — seeded long ago,
// never edited — still had zero of it. config/agents won over src/brains unconditionally,
// so no upgrade to a shipped type def could ever reach an already-seeded profile.
describe('the agent TYPE file (config/agents/<type>.yaml vs the shipped src/brains/<type>.yaml)', () => {
  const profilePath = join(agentsDir, `${TYPE}.yaml`);
  const shippedPath = join(builtinDir, `${TYPE}.yaml`);
  const brains = () => createBrains({ builtinDir, agentsDir });

  it('the SHIPPED def wins when the repo copy is newer — an upgrade reaches a seeded profile', async () => {
    await stamp(
      profilePath, 'type: ccode\nmodel: STALE\n',
      shippedPath, 'type: ccode\nmodel: FRESH\neffort: high\n',
      'shipped',
    );
    expect(brains().resolve(TYPE)).toMatchObject({ model: 'FRESH', effort: 'high' });
  });

  it('the PROFILE def wins when the operator edited it after the pull (edits stay sacred)', async () => {
    await stamp(
      profilePath, 'type: ccode\nmodel: MINE\n',
      shippedPath, 'type: ccode\nmodel: SHIPPED\neffort: high\n',
      'profile',
    );
    const def = brains().resolve(TYPE);
    expect(def).toMatchObject({ model: 'MINE' });
    expect(def.effort).toBe('high');        // a field only the shipped layer sets still merges in
  });

  it('a conversation brains/ still wins over both, whatever the mtimes say', async () => {
    const convDir = join(tmpHome, 'conv');
    await mkdir(join(convDir, 'brains'), { recursive: true });
    await writeFile(join(convDir, 'brains', `${TYPE}.yaml`), 'model: CONV\n', 'utf8');
    await stamp(
      profilePath, 'type: ccode\nmodel: MINE\n',
      shippedPath, 'type: ccode\nmodel: SHIPPED\n',
      'shipped',
    );
    expect(brains().resolve(TYPE, { convDir })).toMatchObject({ model: 'CONV', type: 'ccode' });
  });
});

// Same trap, same directory as the room template that was fixed — but this reader was left
// behind: readAutoModeLayer took the profile copy whenever it existed ("it stays wholesale,
// not resolveRoomLayerFile's per-file mtime pick"), so an edit to the shipped auto-mode
// layer could never reach a node whose profile had been seeded.
describe('the auto-mode layer (config/skeletons/auto-mode.md vs the shipped copy)', () => {
  it('the SHIPPED layer wins when the repo copy is newer', async () => {
    await writeFile(profileAutoMode, 'PROFILE-STALE-AUTO-MODE', 'utf8');
    await utimes(profileAutoMode, OLDER, OLDER);              // the real shipped file is far newer
    const shipped = (await readFile(SHIPPED_AUTO_MODE, 'utf8')).trim();
    const layer = await readAutoModeLayer();
    expect(layer).toBe(shipped);
    expect(layer).not.toContain('PROFILE-STALE-AUTO-MODE');
  });

  it('the PROFILE layer wins when the operator edited it (edits stay sacred)', async () => {
    await writeFile(profileAutoMode, 'PROFILE-FRESH-AUTO-MODE', 'utf8');
    await utimes(profileAutoMode, NEWER, NEWER);
    expect(await readAutoModeLayer()).toBe('PROFILE-FRESH-AUTO-MODE');
  });

  it('no profile copy at all → the shipped layer', async () => {
    await rm(profileAutoMode, { force: true });
    const shipped = (await readFile(SHIPPED_AUTO_MODE, 'utf8')).trim();
    expect(await readAutoModeLayer()).toBe(shipped);
  });
});
