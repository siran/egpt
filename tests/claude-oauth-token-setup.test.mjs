// setup/claude-oauth-token.mjs stores the boxed beings' Claude credential in the secrets folder
// (never config.yaml) and prints only its length + sha256[:12].
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { secretTag } from '../src/bridges/telegram.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'setup', 'claude-oauth-token.mjs');
const TOKEN = 'sk-ant-oat01-FAKE_setup-test-token-0123456789';

describe('setup/claude-oauth-token.mjs', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'egpt-oauth-setup-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const run = (input) => spawnSync(process.execPath, [SCRIPT, '--home', home], { input, encoding: 'utf8' });

  it('writes secrets/claude-oauth.token (trimmed), prints length + sha only', () => {
    const r = run(`  ${TOKEN}\n`);
    expect(r.status, r.stderr).toBe(0);
    const p = join(home, 'secrets', 'claude-oauth.token');
    expect(readFileSync(p, 'utf8')).toBe(`${TOKEN}\n`);
    expect(r.stdout).toContain(secretTag(TOKEN));
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('refuses an API key or junk, writing nothing', () => {
    for (const bad of ['sk-ant-api03-not-a-subscription-token-0123456789', 'nope']) {
      const r = run(bad);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/does not look like a `claude setup-token` token/);
    }
    expect(existsSync(join(home, 'secrets', 'claude-oauth.token'))).toBe(false);
  });
});
