// ayde-user-setup.test.mjs — setup/ayde-user.mjs keeps the /ayde users in $EGPT_HOME/secrets/ayde.users
// (one "<user>:<level>:<scrypt…>" line each) and never prints a password or a hash.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkUser } from '../src/bridges/http-ayde.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'setup', 'ayde-user.mjs');
const LINE_RE = /^([^:\n]+):(team|devs|admin|root):N=16384,r=8,p=1:([A-Za-z0-9+/]+=*):([A-Za-z0-9+/]+=*)$/;

describe('setup/ayde-user.mjs', () => {
  let home;
  const said = [];
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'egpt-ayde-user-')); said.length = 0; });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const file = () => join(home, 'secrets', 'ayde.users');
  const run = (args, input = '') => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8', env: { ...process.env, EGPT_HOME: home } });
    said.push(r.stdout, r.stderr);
    return r;
  };
  const users = () => readFileSync(file(), 'utf8').trim().split('\n').map((l) => LINE_RE.exec(l).slice(1, 3));

  it('add (password on stdin), list (user + level only), set-level, add again (a new password), remove; never a password, salt or hash on screen', async () => {
    expect(run(['add', 'jaime', 'team'], 'clave-de-jaime-1\n').status).toBe(0);
    expect(run(['add', 'ana.p', 'root'], 'clave de ana con espacios\r\n').status).toBe(0);
    expect(users()).toEqual([['jaime', 'team'], ['ana.p', 'root']]);
    const first = readFileSync(file(), 'utf8');
    expect(await checkUser(first, 'jaime', 'clave-de-jaime-1')).toBe('team');
    expect(await checkUser(first, 'ana.p', 'clave de ana con espacios')).toBe('root');
    expect(await checkUser(first, 'jaime', 'clave de ana con espacios')).toBe(null);

    const list = run(['list']);
    expect(list.status).toBe(0);
    expect(list.stdout.trim().split('\n')).toEqual(['jaime team', 'ana.p root']);

    expect(run(['set-level', 'jaime', 'admin']).status).toBe(0);
    expect(await checkUser(readFileSync(file(), 'utf8'), 'jaime', 'clave-de-jaime-1')).toBe('admin');

    expect(run(['add', 'jaime', 'devs'], 'clave-de-jaime-2').status).toBe(0);
    let text = readFileSync(file(), 'utf8');
    expect(text.trim().split('\n').filter((l) => l.startsWith('jaime:'))).toHaveLength(1);
    expect(await checkUser(text, 'jaime', 'clave-de-jaime-2')).toBe('devs');
    expect(await checkUser(text, 'jaime', 'clave-de-jaime-1')).toBe(null);

    expect(run(['remove', 'ana.p']).status).toBe(0);
    text = readFileSync(file(), 'utf8');
    expect(users()).toEqual([['jaime', 'devs']]);

    const out = said.join('\n');
    const fields = [...first.trim().split('\n'), ...text.trim().split('\n')].flatMap((l) => LINE_RE.exec(l).slice(3));
    for (const secret of ['clave-de-jaime-1', 'clave-de-jaime-2', 'clave de ana', 'N=16384', ...fields]) expect(out).not.toContain(secret);
    expect(readdirSync(join(home, 'secrets'))).toEqual(['ayde.users']);   // no temp file left
    if (process.platform !== 'win32') {
      expect(statSync(file()).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, 'secrets')).mode & 0o777).toBe(0o700);
    }
  });

  it('refuses the reserved "logout" user (the sign-out page uses it), writing nothing', () => {
    for (const args of [['add', 'logout', 'team'], ['set-level', 'logout', 'root'], ['remove', 'logout']]) {
      const r = run(args, 'clave-de-logout-1\n');
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(/"logout" is reserved/);
    }
    expect(existsSync(file())).toBe(false);
  });

  it('list with no users file says so', () => {
    const r = run(['list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no users/);
  });

  it('refuses a bad action, user or level, an empty or short password, and set-level or remove of an unknown user — writing nothing', () => {
    expect(run(['rename', 'jaime']).status).toBe(1);
    expect(run(['add', 'ja:ime', 'team'], 'clave-de-jaime-1').status).toBe(1);
    expect(run(['add', 'ja ime', 'team'], 'clave-de-jaime-1').status).toBe(1);
    expect(run(['add', 'jaime'], 'clave-de-jaime-1').status).toBe(1);
    const level = run(['add', 'jaime', 'boss'], 'clave-de-jaime-1');
    expect(level.status).toBe(1);
    expect(level.stderr).toMatch(/"boss" is not a level \(team, devs, admin, root\)/);
    expect(run(['add', 'jaime', 'team'], '').status).toBe(1);
    const short = run(['add', 'jaime', 'team'], 'corta\n');
    expect(short.status).toBe(1);
    expect(short.stderr).toMatch(/at least 8/);
    expect(existsSync(file())).toBe(false);
    expect(run(['add', 'jaime', 'team'], 'clave-de-jaime-1').status).toBe(0);
    const before = readFileSync(file(), 'utf8');
    for (const args of [['remove', 'nadie'], ['set-level', 'nadie', 'root'], ['set-level', 'jaime', 'boss']]) {
      const r = run(args);
      expect(r.status, args.join(' ')).toBe(1);
    }
    expect(run(['remove', 'nadie']).stderr).toMatch(/no user "nadie"/);
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });
});
