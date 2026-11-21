// git-env.test.mjs — src/git-env.mjs: a brace revision reaches git intact. On reve the git first on
// PATH under Git Bash is msys2's, which globbed `HEAD^{commit}` into `HEAD^commit` (the daemon's rescue
// verify) and `@{u}` into `@u` (egpt-update's look). Elsewhere git is native and this passes either way.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnv } from '../src/git-env.mjs';

describe('gitEnv', () => {
  it('adds noglob and keeps the MSYS options already set', () => {
    expect(gitEnv({ PATH: '/x' })).toEqual({ PATH: '/x', MSYS: 'noglob' });
    expect(gitEnv({ MSYS: 'winsymlinks:nativestrict' }).MSYS).toBe('winsymlinks:nativestrict noglob');
  });

  it('REPRODUCE: HEAD^{commit} reaches the real git as written', () => {
    const repo = mkdtempSync(join(tmpdir(), 'egpt-git-env-'));
    try {
      const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe', env: gitEnv() });
      git('init', '-q');
      git('commit', '-q', '--allow-empty', '-m', 'one');
      const head = String(git('rev-parse', 'HEAD').stdout).trim();
      const verify = git('rev-parse', '--verify', 'HEAD^{commit}');
      expect(String(verify.stderr).trim()).toBe('');
      expect(String(verify.stdout).trim()).toBe(head);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
