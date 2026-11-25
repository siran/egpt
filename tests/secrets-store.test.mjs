// secrets-store.test.mjs — src/secrets.mjs's operator side (the secrets page): list, save keeping history,
// meta, rename, name validation, and readSecret refusing a value locked in the browser (enc:v1:).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSecret, writeSecret, listSecrets, getSecret, saveSecret, renameSecret, secretHistory, readMeta } from '../src/secrets.mjs';

let home, t;
const clock = () => (t += 1000);
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'egpt-secrets-store-')); t = Date.UTC(2026, 10, 25, 10, 0, 0); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const save = (name, value, who = 'ana', o = {}) => saveSecret(home, name, value, who, { now: clock, ...o });
const mode = (p) => statSync(p).mode & 0o777;

describe('secrets store', () => {
  it('creates, then changes: the value is the file, the previous one goes to history as stored, with who and when', () => {
    expect(save('bot.token', 'v1')).toEqual({ action: 'created', locked: false });
    expect(secretHistory(home, 'bot.token')).toEqual([]);
    expect(save('bot.token', 'enc:v1:aa:bb:cc', 'bo')).toEqual({ action: 'changed', locked: true });
    expect(save('bot.token', 'v3', 'cy')).toEqual({ action: 'changed', locked: false });
    expect(getSecret(home, 'bot.token').value).toBe('v3');
    const h = secretHistory(home, 'bot.token');
    expect(h.map((e) => e.value)).toEqual(['enc:v1:aa:bb:cc', 'v1']);   // newest first, the locked one still locked
    expect(h[0]).toMatchObject({ changed_by: 'bo', replaced_by: 'cy' });
    expect(h[1]).toMatchObject({ changed_by: 'ana', replaced_by: 'bo' });
    expect(h[1].replaced_at).toBe('2026-11-25T10:00:02.000Z');
  });

  it('meta: created_* stays, changed_* follows; files are 0600 and the folders 0700', () => {
    save('a', 'x', 'ana'); save('a', 'y', 'bo');
    expect(readMeta(home).a).toEqual({ created_by: 'ana', created_at: '2026-11-25T10:00:01.000Z', changed_by: 'bo', changed_at: '2026-11-25T10:00:02.000Z' });
    for (const p of ['a', '.meta.json']) expect(mode(join(home, 'secrets', p))).toBe(0o600);
    const hist = join(home, 'secrets', '.history', 'a');
    expect(mode(hist)).toBe(0o700);
    expect(mode(join(hist, secretHistory(home, 'a')[0].stamp))).toBe(0o600);
  });

  it('lists names with locked or plain, never dotfiles, .history, .meta.json, *.tmp-* or a folder', () => {
    save('plain', 'x'); save('locked', 'enc:v1:aa:bb:cc');
    writeFileSync(join(home, 'secrets', '.hidden'), 'x'); writeFileSync(join(home, 'secrets', 'x.tmp-123'), 'x'); mkdirSync(join(home, 'secrets', 'dir'));
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
    expect(existsSync(join(home, 'secrets', 'big2'))).toBe(false);
    expect(getSecret(home, '../etc')).toBeNull();
    expect(secretHistory(home, '../x')).toEqual([]);
  });

  it('rename moves the value, its history and its meta; refuses a missing source or an existing target', () => {
    save('old', 'v1'); save('old', 'v2'); save('other', 'z');
    expect(save('new', 'v3', 'bo', { from: 'old' })).toEqual({ action: 'renamed', locked: false });
    expect(getSecret(home, 'old')).toBeNull();
    expect(secretHistory(home, 'new').map((e) => e.value)).toEqual(['v2', 'v1']);   // moved, then v2 replaced by v3
    expect(readMeta(home).old).toBeUndefined();
    expect(readMeta(home).new).toMatchObject({ created_by: 'ana', changed_by: 'bo' });
    expect(() => renameSecret(home, 'nope', 'x')).toThrow(/no secret/);
    expect(() => renameSecret(home, 'new', 'other')).toThrow(/exists/);
    expect(getSecret(home, 'new').value).toBe('v3');
  });

  it('readSecret: a locked value is unusable, never handed over as a token; a plain one still reads', () => {
    save('t', 'enc:v1:aa:bb:cc'); save('p', 'tok');
    expect(readSecret(home, 't')).toMatchObject({ token: null, problem: 'encrypted' });
    expect(readSecret(home, 'p').token).toBe('tok');
    writeSecret(home, 'w', 'enc:v1:x:y:z');
    expect(readSecret(home, 'w').problem).toBe('encrypted');
    expect(readFileSync(join(home, 'secrets', 'p'), 'utf8')).toBe('tok\n');
  });
});
