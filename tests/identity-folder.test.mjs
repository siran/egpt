// identity-folder.test.mjs — identities are FLAT .md files now (operator 2026-07-03).
// An identity = config/identities/<name>.md; the kickoff feed = that file + the shared
// pointers/rules (the room template config/skeletons/room/{30,40}). A name with no profile
// file falls back to the room template's 00-identity.md (the shipped eGPT default). Runs
// against an isolated EMPTY profile so resolution deterministically hits the repo's shipped
// room template (EGPT_HOME read once at module load → set before the dynamic import).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = join(tmpdir(), `egpt-idfile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;

let resolveIdentityFile, readIdentityFeed;

beforeAll(async () => {
  await mkdir(tmpHome, { recursive: true });   // empty profile → shipped room template is the fallback
  ({ resolveIdentityFile, readIdentityFeed } = await import('../conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await rm(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('identity flat files', () => {
  it('resolveIdentityFile is null when the profile has no config/identities/<name>.md', () => {
    expect(resolveIdentityFile('egpt')).toBeNull();
    expect(resolveIdentityFile('zzz-no-such-identity')).toBeNull();
  });
  it('readIdentityFeed(egpt) falls back to the shipped room template (identity + pointers + rules)', async () => {
    const feed = await readIdentityFeed('egpt');
    expect(feed.length).toBeGreaterThan(0);
    expect(feed).toMatch(/eGPT/);        // 00-identity.md leads
    expect(feed).toMatch(/Pointers/);    // 30-pointers.md joined in
    expect(feed).toMatch(/RULES/);       // 40-rules.md joined in
  });
  it('readIdentityFeed for an unknown name ALSO falls back to the eGPT default (never empty)', async () => {
    expect(await readIdentityFeed('zzz-nope')).toMatch(/eGPT/);
  });
});
