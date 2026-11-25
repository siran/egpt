// secrets-store.test.mjs — src/secrets.mjs's operator side (the secrets page): list, save keeping metadata-only history,
// meta, rename, purge, name validation, the managed/ folder apart from the node's token files, the Windows ACL, and
// readSecret refusing a value locked in the browser (enc:v1:).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readSecret, writeSecret, listSecrets, getSecret, saveSecret, renameSecret, secretHistory, purgeHistory, readMeta, lockPath, pageDir } from '../src/secrets.mjs';

let home, t;
const clock = () => (t += 1000);
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'egpt-secrets-store-')); t = Date.UTC(2026, 10, 25, 10, 0, 0); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
// Windows has no POSIX modes: the real icacls would also run in these tests, so every save there gets a recorder.
const acls = [];
const save = (name, value, who = 'ana', o = {}) => saveSecret(home, name, value, who, { now: clock, ...(process.platform === 'win32' && { icacls: (a) => acls.push(a) }), ...o });
const mode = (p) => statSync(p).mode & 0o777;
const managed = (...p) => join(pageDir(home), ...p);
const allFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]));

describe('secrets store', () => {
  it('creates, then changes: the value is the file; the previous one goes to history as metadata, with who and when', () => {
    expect(save('bot.token', 'v1')).toEqual({ action: 'created', locked: false });
    expect(secretHistory(home, 'bot.token')).toEqual([]);
    expect(save('bot.token', 'enc:v1:aa:bb:cc', 'bo')).toEqual({ action: 'changed', locked: true });
    expect(save('bot.token', 'v3', 'cy')).toEqual({ action: 'changed', locked: false });
    expect(getSecret(home, 'bot.token').value).toBe('v3');
    const h = secretHistory(home, 'bot.token');
    expect(h.map((e) => [e.kind, e.value])).toEqual([['encrypted', 'enc:v1:aa:bb:cc'], ['plain', undefined]]);   // newest first; a locked one keeps its ciphertext, a plain one no value
    expect(h[0]).toMatchObject({ changed_by: 'bo', replaced_by: 'cy' });
    expect(h[1]).toMatchObject({ changed_by: 'ana', replaced_by: 'bo', fingerprint: createHash('sha256').update('v1').digest('hex').slice(0, 8) });
    expect(h[1].replaced_at).toBe('2026-11-25T10:00:02.000Z');
  });

  it('no plaintext in history: an old plain value is on no file under the folder, only its fingerprint', () => {
    save('k', 'PLAIN-SECRET-ONE'); save('k', 'PLAIN-SECRET-TWO'); save('k', 'PLAIN-SECRET-THREE');
    const onDisk = allFiles(join(home, 'secrets')).filter((f) => !f.endsWith(join('managed', 'k'))).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(onDisk).not.toMatch(/PLAIN-SECRET/);
    expect(secretHistory(home, 'k')).toHaveLength(2);
    expect(readFileSync(managed('k'), 'utf8')).toBe('PLAIN-SECRET-THREE\n');   // the current value is the file, as before
  });

  it('purgeHistory forgets one secret\'s entries, or all; the values and meta stay', () => {
    save('a', '1'); save('a', '2'); save('a', '3'); save('b', 'x'); save('b', 'y');
    expect(purgeHistory(home, 'a')).toBe(2);
    expect(secretHistory(home, 'a')).toEqual([]);
    expect(secretHistory(home, 'b')).toHaveLength(1);
    expect(purgeHistory(home)).toBe(1);
    expect(secretHistory(home, 'b')).toEqual([]);
    expect(purgeHistory(home, 'a')).toBe(0);
    expect(() => purgeHistory(home, '../x')).toThrow(/bad name/);
    expect(getSecret(home, 'a').value).toBe('3');
    expect(readMeta(home).b).toMatchObject({ changed_by: 'ana' });
  });

  it('meta: created_* stays, changed_* follows', () => {
    save('a', 'x', 'ana'); save('a', 'y', 'bo');
    expect(readMeta(home).a).toEqual({ created_by: 'ana', created_at: '2026-11-25T10:00:01.000Z', changed_by: 'bo', changed_at: '2026-11-25T10:00:02.000Z' });
  });

  it.skipIf(process.platform === 'win32')('POSIX: files are 0600 and the folders 0700', () => {
    save('a', 'x'); save('a', 'y');
    for (const p of [managed('a'), managed('.meta.json')]) expect(mode(p)).toBe(0o600);
    const hist = managed('.history', 'a');
    expect(mode(pageDir(home))).toBe(0o700);
    expect(mode(hist)).toBe(0o700);
    expect(mode(join(hist, secretHistory(home, 'a')[0].stamp))).toBe(0o600);
  });

  it('Windows ACL: every folder and file the page writes is set to the user and SYSTEM only, inheritance removed', () => {
    const calls = [];
    saveSecret(home, 'a', 'x', 'ana', { now: clock, platform: 'win32', icacls: (a) => calls.push(a) });
    saveSecret(home, 'a', 'y', 'ana', { now: clock, platform: 'win32', icacls: (a) => calls.push(a) });
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args.slice(1, 3)).toEqual(['/inheritance:r', '/grant:r']);
      const grants = args.slice(3);
      expect(grants).toHaveLength(2);   // the owner and SYSTEM, nobody else
      expect(grants[1]).toMatch(/^\*S-1-5-18:/);
      expect(grants.join(' ')).not.toMatch(/Everyone|Users|Administrators|egpt-sbx|egpt-sandbox-pool|\*S-1-1-0/i);
    }
    const dirs = calls.filter((a) => /\(OI\)\(CI\)F$/.test(a[3])).map((a) => a[0]);
    expect(dirs).toContain(pageDir(home));
    expect(dirs).toContain(managed('.history', 'a'));
    const files = calls.filter((a) => !/\(OI\)\(CI\)F$/.test(a[3])).map((a) => a[0]);
    expect(files.some((f) => f.startsWith(managed('a')))).toBe(true);
    expect(files.some((f) => f.startsWith(managed('.meta.json')))).toBe(true);
    expect(files.some((f) => f.includes(`${join('.history', 'a')}`))).toBe(true);
    expect(statSync(managed('a')).isFile()).toBe(true);   // and the write still happened
  });

  it('lockPath: icacls is only for win32; the owner is the given user', () => {
    const calls = [];
    lockPath('C:\\x', { platform: 'linux', icacls: (a) => calls.push(a) });
    expect(calls).toEqual([]);
    lockPath('C:\\x', { platform: 'win32', dir: true, user: 'BOX\\an', icacls: (a) => calls.push(a) });
    expect(calls).toEqual([['C:\\x', '/inheritance:r', '/grant:r', 'BOX\\an:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F']]);
  });

  it('a page session cannot touch the node\'s token files: shell.token and the telegram token are neither listed, read nor overwritten', () => {
    mkdirSync(join(home, 'secrets'), { recursive: true });
    for (const [n, v] of [['shell.token', 'SHELL'], ['telegram-main.token', 'TG'], ['synthesizer.token', 'SYN']]) writeFileSync(join(home, 'secrets', n), `${v}\n`);
    for (const n of ['shell.token', 'telegram-main.token', 'synthesizer.token']) {
      expect(() => save(n, 'EVIL'), n).toThrow(/node's own files/);
      expect(getSecret(home, n)).toBeNull();
    }
    save('mine', 'x');
    expect(() => renameSecret(home, 'mine', 'shell.token')).toThrow(/node's own files/);
    expect(listSecrets(home).map((s) => s.name)).toEqual(['mine']);
    expect(readFileSync(join(home, 'secrets', 'shell.token'), 'utf8')).toBe('SHELL\n');
    expect(readFileSync(join(home, 'secrets', 'telegram-main.token'), 'utf8')).toBe('TG\n');
    expect(readSecret(home, 'shell.token').token).toBe('SHELL');
  });

  it('readSecret finds what the page saved (managed/), the node\'s own file first', () => {
    save('gh.token', 'from-page');
    expect(readSecret(home, 'gh.token')).toMatchObject({ token: 'from-page', path: managed('gh.token') });
    expect(readSecret(home, 'nope')).toMatchObject({ token: null, problem: 'missing', path: join(home, 'secrets', 'nope') });
    writeSecret(home, 'gh.token', 'own');
    expect(readSecret(home, 'gh.token').token).toBe('own');
  });

  it('lists names with locked or plain, never dotfiles, .history, .meta.json, *.tmp-* or a folder', () => {
    save('plain', 'x'); save('locked', 'enc:v1:aa:bb:cc');
    writeFileSync(managed('.hidden'), 'x'); writeFileSync(managed('x.tmp-123'), 'x'); mkdirSync(managed('dir'));
    const l = listSecrets(home);
    expect(l.map((s) => [s.name, s.locked])).toEqual([['locked', true], ['plain', false]]);
    expect(l[1].changed_by).toBe('ana');
    expect(listSecrets(join(home, 'none'))).toEqual([]);
  });

  it('names: only ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ is written; values up to 64 KB', () => {
    for (const bad of ['', '.x', '-x', 'a/b', '../x', 'a b', 'x'.repeat(101), '.meta.json', '.history', 'a.tmp-1', null]) expect(() => save(bad, 'v'), String(bad)).toThrow(/bad name/);
    expect(() => save('x'.repeat(100), 'v')).not.toThrow();
    expect(() => save('big', 'a'.repeat(64 * 1024))).not.toThrow();
    expect(() => save('big2', 'a'.repeat(64 * 1024 + 1))).toThrow(/64 KB/);
    expect(() => save('empty', '')).toThrow(/empty/);
    expect(existsSync(managed('big2'))).toBe(false);
    expect(getSecret(home, '../etc')).toBeNull();
    expect(secretHistory(home, '../x')).toEqual([]);
  });

  it('rename moves the value, its history and its meta; refuses a missing source or an existing target', () => {
    save('old', 'v1'); save('old', 'v2'); save('other', 'z');
    expect(save('new', 'v3', 'bo', { from: 'old' })).toEqual({ action: 'renamed', locked: false });
    expect(getSecret(home, 'old')).toBeNull();
    expect(secretHistory(home, 'new').map((e) => e.kind)).toEqual(['plain', 'plain']);   // moved, then v2 replaced by v3
    expect(readMeta(home).old).toBeUndefined();
    expect(readMeta(home).new).toMatchObject({ created_by: 'ana', changed_by: 'bo' });
    const o = process.platform === 'win32' ? { icacls: () => {} } : {};
    expect(() => renameSecret(home, 'nope', 'x', o)).toThrow(/no secret/);
    expect(() => renameSecret(home, 'new', 'other', o)).toThrow(/exists/);
    expect(getSecret(home, 'new').value).toBe('v3');
  });

  it('readSecret: a locked value is unusable, never handed over as a token; a plain one still reads', () => {
    save('t', 'enc:v1:aa:bb:cc'); save('p', 'tok');
    expect(readSecret(home, 't')).toMatchObject({ token: null, problem: 'encrypted' });
    expect(readSecret(home, 'p').token).toBe('tok');
    writeSecret(home, 'w', 'enc:v1:x:y:z');
    expect(readSecret(home, 'w').problem).toBe('encrypted');
    expect(readFileSync(managed('p'), 'utf8')).toBe('tok\n');
  });

  it('the secrets folder is under no sandbox share: not in conversations/, rooms/ or agents/ (what a box or a pool account is given)', () => {
    for (const share of ['conversations', 'rooms', 'agents']) expect(pageDir(home).startsWith(join(home, share))).toBe(false);
    expect(pageDir(home)).toBe(join(home, 'secrets', 'managed'));
  });
});
