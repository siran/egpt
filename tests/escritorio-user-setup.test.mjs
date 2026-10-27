// escritorio-user-setup.test.mjs — setup/escritorio-user.mjs keeps a chatbox client's escritorio
// staff in $EGPT_HOME/secrets/chatbox-<client>-escritorio.users (one scrypt line per user) and never
// prints a password or a hash.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkStaff } from '../src/bridges/http-admin.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'setup', 'escritorio-user.mjs');
const LINE_RE = /^([^:\n]+):N=16384,r=8,p=1:([A-Za-z0-9+/]+=*):([A-Za-z0-9+/]+=*)$/;

describe('setup/escritorio-user.mjs', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'egpt-escritorio-user-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const run = (args, input = '') => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8', env: { ...process.env, EGPT_HOME: home } });
  const file = () => join(home, 'secrets', 'chatbox-demoiev-escritorio.users');
  const said = [];
  const ran = (args, input) => { const r = run(args, input); said.push(r.stdout, r.stderr); return r; };

  it('add (password on stdin), list, add again (a new password), remove; never a password, salt or hash on screen', async () => {
    expect(ran(['demoiev', 'add', 'jaime'], 'clave-de-jaime-1\n').status).toBe(0);
    expect(ran(['demoiev', 'add', 'ana.p'], 'clave de ana con espacios\r\n').status).toBe(0);
    let text = readFileSync(file(), 'utf8');
    const lines = text.trim().split('\n');
    expect(lines.map((l) => LINE_RE.exec(l)?.[1])).toEqual(['jaime', 'ana.p']);
    expect(await checkStaff(text, 'jaime', 'clave-de-jaime-1')).toBe(true);
    expect(await checkStaff(text, 'ana.p', 'clave de ana con espacios')).toBe(true);
    expect(await checkStaff(text, 'jaime', 'clave de ana con espacios')).toBe(false);

    const list = ran(['demoiev', 'list']);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/^jaime$/m);
    expect(list.stdout).toMatch(/^ana\.p$/m);

    expect(ran(['demoiev', 'add', 'jaime'], 'clave-de-jaime-2').status).toBe(0);
    text = readFileSync(file(), 'utf8');
    expect(text.trim().split('\n').filter((l) => l.startsWith('jaime:'))).toHaveLength(1);
    expect(await checkStaff(text, 'jaime', 'clave-de-jaime-2')).toBe(true);
    expect(await checkStaff(text, 'jaime', 'clave-de-jaime-1')).toBe(false);

    const removed = ran(['demoiev', 'remove', 'ana.p']);
    expect(removed.status).toBe(0);
    text = readFileSync(file(), 'utf8');
    expect(text.trim().split('\n').map((l) => LINE_RE.exec(l)?.[1])).toEqual(['jaime']);
    expect(ran(['demoiev', 'list']).stdout).not.toMatch(/ana/);

    const out = said.join('\n');
    for (const secret of ['clave-de-jaime-1', 'clave-de-jaime-2', 'clave de ana', ...lines.flatMap((l) => LINE_RE.exec(l).slice(2)), ...text.trim().split(':').slice(2)]) expect(out).not.toContain(secret);
    expect(readdirSync(join(home, 'secrets'))).toEqual(['chatbox-demoiev-escritorio.users']);   // no temp file left
    if (process.platform !== 'win32') {
      expect(statSync(file()).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, 'secrets')).mode & 0o777).toBe(0o700);
    }
  });

  it('list with no users file says so', () => {
    const r = ran(['demoiev', 'list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no users/);
  });

  it('refuses a bad client, user or action, an empty or short password, and removing an unknown user — writing nothing', () => {
    expect(ran(['Demo IEV', 'add', 'jaime'], 'clave-de-jaime-1').status).toBe(1);
    expect(ran(['demoiev', 'add', 'ja:ime'], 'clave-de-jaime-1').status).toBe(1);
    expect(ran(['demoiev', 'add', 'ja ime'], 'clave-de-jaime-1').status).toBe(1);
    expect(ran(['demoiev', 'rename', 'jaime']).status).toBe(1);
    expect(ran(['demoiev', 'add', 'jaime'], '').status).toBe(1);
    const short = ran(['demoiev', 'add', 'jaime'], 'corta\n');
    expect(short.status).toBe(1);
    expect(short.stderr).toMatch(/at least 8/);
    expect(existsSync(file())).toBe(false);
    expect(ran(['demoiev', 'add', 'jaime'], 'clave-de-jaime-1').status).toBe(0);
    const before = readFileSync(file(), 'utf8');
    const gone = ran(['demoiev', 'remove', 'nadie']);
    expect(gone.status).toBe(1);
    expect(gone.stderr).toMatch(/no user "nadie"/);
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });
});
