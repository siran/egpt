// shell-token-secret.test.mjs — the shell / being-link token: config.yaml wins, else secrets/shell.token.
// Without either the shell stays disabled (fail closed); a boxed being's ask-spine then cannot reach
// the spine (EDW 2026-10-24: "spine unreachable on 127.0.0.1:23475").
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellTokenOf } from '../src/spine/boot.mjs';

describe('shellTokenOf', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'egpt-shell-token-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('config.yaml shell.token wins (kg/do unchanged)', () => {
    mkdirSync(join(home, 'secrets'));
    writeFileSync(join(home, 'secrets', 'shell.token'), 'from-file\n');
    expect(shellTokenOf({ shell: { token: ' from-config ' } }, home)).toBe('from-config');
  });

  it('no config token: secrets/shell.token, trimmed', () => {
    mkdirSync(join(home, 'secrets'));
    writeFileSync(join(home, 'secrets', 'shell.token'), 'from-file\n');
    expect(shellTokenOf({}, home)).toBe('from-file');
  });

  it('neither: empty, so the shell stays disabled (never auto-generated)', () => {
    expect(shellTokenOf({}, home)).toBe('');
  });
});
