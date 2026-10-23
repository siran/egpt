// telegram-token-setup.test.mjs — setup/telegram-token.mjs stores the bot token in the secrets
// folder (never config.yaml) and prints only its length + sha256[:12].
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { secretTag } from '../src/bridges/telegram.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'setup', 'telegram-token.mjs');
const TOKEN = '123456789:AAHfake-token-for-the-setup-test_0123456';

describe('setup/telegram-token.mjs', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'egpt-tg-setup-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const run = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args, '--home', home], { input, encoding: 'utf8' });

  it('writes secrets/telegram-<connection>.token (trimmed), prints length + sha only', () => {
    const r = run(['main'], `  ${TOKEN}\n`);
    expect(r.status, r.stderr).toBe(0);
    const p = join(home, 'secrets', 'telegram-main.token');
    expect(readFileSync(p, 'utf8')).toBe(`${TOKEN}\n`);
    expect(r.stdout).toContain(secretTag(TOKEN));
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(readdirSync(join(home, 'secrets'))).toEqual(['telegram-main.token']);   // no temp file left
    if (process.platform !== 'win32') {
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, 'secrets')).mode & 0o777).toBe(0o700);
    }
  });

  it('replaces an existing token', () => {
    expect(run(['main'], TOKEN).status).toBe(0);
    const other = '987654321:BBHanother-fake-token-for-the-test_9876';
    expect(run(['main'], other).status).toBe(0);
    expect(readFileSync(join(home, 'secrets', 'telegram-main.token'), 'utf8')).toBe(`${other}\n`);
  });

  it('refuses something that is not a bot token, and a bad connection name, writing nothing', () => {
    const bad = run(['main'], 'not a token');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/does not look like a bot token/);
    expect(run(['../x'], TOKEN).status).toBe(1);
    expect(existsSync(join(home, 'secrets', 'telegram-main.token'))).toBe(false);
  });
});
