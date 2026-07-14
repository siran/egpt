// identity-layers.test.mjs — the `/e` wizard's personality feed: listIdentityLayers()
// enumerates the FLAT *.md files in the profile's config/identities/ PLUS 'egpt' (the
// shipped default, which lives in the room template — no profile file). A profile file
// config/identities/egpt.md OVERRIDES the shipped default for resolution. Runs against an
// isolated EGPT_HOME so nothing touches the real profile. egpt-home.mjs reads EGPT_HOME
// once at module load, so it is set BEFORE conversations-state is dynamically imported.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = join(tmpdir(), `egpt-idlayers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;

let listIdentityLayers, resolveIdentityFile, readIdentityFeed;

beforeAll(async () => {
  // A profile identity file that OVERRIDES the shipped `egpt`, plus a profile-only layer.
  await mkdir(join(tmpHome, 'config', 'identities'), { recursive: true });
  await writeFile(join(tmpHome, 'config', 'identities', 'egpt.md'), '# profile egpt\n\nOverridden.\n', 'utf8');
  await writeFile(join(tmpHome, 'config', 'identities', 'secretary.md'), '# I am a secretary\n\nProfile-only layer.\n', 'utf8');
  ({ listIdentityLayers, resolveIdentityFile, readIdentityFeed } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await rm(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('listIdentityLayers + flat-file resolution', () => {
  it('lists the profile *.md basenames plus egpt, deduped (egpt once) and sorted', () => {
    const layers = listIdentityLayers();
    expect(layers).toContain('egpt');          // shipped default (+ a profile override) → once
    expect(layers.filter((n) => n === 'egpt')).toHaveLength(1);
    expect(layers).toContain('secretary');     // profile-only
    expect(layers).toEqual([...layers].sort()); // sorted
  });

  it('the profile identity file WINS for resolution', async () => {
    expect(resolveIdentityFile('egpt')).toBe(join(tmpHome, 'config', 'identities', 'egpt.md'));
    expect(await readIdentityFeed('egpt')).toMatch(/profile egpt/);   // not the shipped "I am eGPT"
  });

  // operator 2026-07-06: limbs are a SPINE CONTRACT, not an identity trait — a being
  // wearing a CUSTOM identity (secretary.md REPLACES the shipped 00-identity.md) must
  // STILL learn the /react grammar. The action limbs feed independently (10-actions.md),
  // so a custom-identity feed carries them just like the shared pointers/rules do.
  it('a CUSTOM identity being still learns the action limbs (10-actions.md feeds independent of identity)', async () => {
    const feed = await readIdentityFeed('secretary');
    expect(feed).toMatch(/I am a secretary/);     // the custom identity replaces the eGPT default
    expect(feed).not.toMatch(/I am eGPT/);        // ...so the shipped identity block is absent
    expect(feed).toMatch(/\/react #<id> <emoji>/);  // ...yet the limbs grammar is STILL present
  });
});
