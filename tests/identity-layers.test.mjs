// identity-layers.test.mjs — the `/e` wizard's personality feed: listIdentityLayers()
// enumerates layer folders across the profile (EGPT_HOME/identities/) and the repo's
// shipped identities/, deduped with the PROFILE winning (same precedence resolveIdentityDir
// uses). Runs against an isolated EGPT_HOME so a profile layer can shadow a shipped one
// without touching the real profile. egpt-home.mjs reads EGPT_HOME once at module load, so
// it is set BEFORE conversations-state is dynamically imported.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = join(tmpdir(), `egpt-idlayers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;

let listIdentityLayers, resolveIdentityDir, readIdentityFeed;

beforeAll(async () => {
  // A profile layer that SHADOWS the shipped `egpt`, plus a profile-only layer.
  await mkdir(join(tmpHome, 'identities', 'egpt'), { recursive: true });
  await writeFile(join(tmpHome, 'identities', 'egpt', '00-identity.md'), '# profile egpt\n\nOverridden.\n', 'utf8');
  await mkdir(join(tmpHome, 'identities', 'secretary'), { recursive: true });
  await writeFile(join(tmpHome, 'identities', 'secretary', '00-identity.md'), '# I am a secretary\n\nProfile-only layer.\n', 'utf8');
  ({ listIdentityLayers, resolveIdentityDir, readIdentityFeed } = await import('../conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await rm(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('listIdentityLayers + profile-wins resolution', () => {
  it('enumerates profile ∪ repo layers, deduped (egpt listed once, profile-only present)', () => {
    const layers = listIdentityLayers();
    expect(layers).toContain('egpt');          // present in both roots → once
    expect(layers.filter((n) => n === 'egpt')).toHaveLength(1);
    expect(layers).toContain('secretary');     // profile-only
    expect(layers).toEqual([...layers].sort()); // sorted
  });

  it('the profile layer WINS over the shipped one of the same name', async () => {
    expect(resolveIdentityDir('egpt')).toBe(join(tmpHome, 'identities', 'egpt'));
    expect(await readIdentityFeed('egpt')).toMatch(/profile egpt/);   // not the repo's "I am eGPT"
  });
});
