// http-secrets.test.mjs — the secrets page on the http limb: <ayde.path>/secret/<session token>/…, the page's
// lock (http-secrets-crypto.mjs, the file the page itself loads) and the audit line.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpBridge } from '../src/bridges/http.mjs';
import { createSecretSessions } from '../src/bridges/http-secrets.mjs';
import { encryptValue, decryptValue, isEncrypted } from '../src/bridges/http-secrets-crypto.mjs';
import { readSecret } from '../src/secrets.mjs';
import { logLine } from '../src/tools/template.mjs';
import { freeSafeHttpPort } from './free-safe-http-port.mjs';

let home, clock;
const live = [];
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'egpt-http-secrets-')); clock = 1_000_000; });
afterEach(async () => { while (live.length) await live.pop()(); await rm(home, { recursive: true, force: true }); });

async function limb({ claim = true, confirm = claim, ...opts } = {}) {
  const port = await freeSafeHttpPort();
  const audits = [];
  const sessions = createSecretSessions({ now: () => clock, onOpened: (s) => audits.push({ action: 'opened', who: s.who }) });
  const b = await startHttpBridge({ port, clients: { acme: { being: 'ed' } }, home, secretSessions: sessions, onSecret: (a) => audits.push(a), now: () => clock, ...opts });
  live.push(() => b.stop());
  const { token } = sessions.open({ who: 'ana', operator: '@op', chatId: '!c' });
  const at = (t, sub = '') => `http://127.0.0.1:${port}/ayde/secret/${t}${sub}`;
  let cookie = {};   // fetch keeps no cookies: the owner's is sent by hand
  const get = (sub, t = token) => fetch(at(t, sub), { headers: cookie });
  const post = (body, t = token, sub = '/api/save') => fetch(at(t, sub), { method: 'POST', headers: cookie, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const claimIt = async (t = token) => {
    const r = await fetch(at(t, '/claim'), { method: 'POST', redirect: 'manual' });
    const set = r.headers.get('set-cookie');
    if (set) cookie = { Cookie: set.split(';')[0] };
    return r;
  };
  const confirmIt = (code) => sessions.confirm({ chatId: '!c', operator: '@op', code });
  const codeOf = () => sessions.check(token).code;
  if (claim) await claimIt();
  if (confirm) { confirmIt(codeOf()); audits.length = 0; }
  return { port, token, sessions, audits, at, get, post, claimIt, confirmIt, codeOf, as: (c) => { cookie = c; }, cookieOf: () => cookie };
}

describe('the secrets page route', () => {
  it('answers 404 to a wrong, empty or expired token, revealing nothing', async () => {
    const l = await limb();
    for (const t of ['nope', 'x'.repeat(43), l.token.slice(0, -1), '']) {
      const r = await l.get('/api/list', t);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'not found' });
    }
    expect((await l.get('/api/list')).status).toBe(200);
    clock += 15 * 60_000;
    expect((await l.get('/api/list')).status).toBe(404);
    expect((await l.get('')).status).toBe(404);
  });

  it('the page, its script and the crypto module carry the hardening headers; the page has the three fields', async () => {
    const l = await limb();
    for (const sub of ['', '/', '/page.js', '/crypto.js', '/api/list']) {
      const r = await l.get(sub);
      expect(r.status, sub).toBe(200);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    }
    const res = await l.get('?name=x');
    const html = await res.text();
    for (const id of ['id="secret"', 'id="name"', 'id="value"']) expect(html).toContain(id);
    expect(html).toContain(`/ayde/secret/${l.token}/page.js`);
    expect(html).not.toContain('__PREFIX__');
    const csp = res.headers.get('content-security-policy');
    const nonce = /nonce-([^']+)/.exec(csp)[1];
    expect(html).toContain(`nonce="${nonce}"`);
    expect(csp).toMatch(/script-src 'self'/);
    expect(await (await l.get('/crypto.js')).text()).toBe(await readFile(new URL('../src/bridges/http-secrets-crypto.mjs', import.meta.url), 'utf8'));
  });

  it('saves plain (the node can use it), lists, and shows it', async () => {
    const l = await limb();
    const r = await l.post({ name: 'bot.token', value: 'abc123' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, action: 'created', secret: { name: 'bot.token', value: 'abc123', locked: false, created_by: 'ana' } });
    expect(readSecret(home, 'bot.token').token).toBe('abc123');
    const list = await (await l.get('/api/list')).json();
    expect(list).toMatchObject({ who: 'ana', secrets: [{ name: 'bot.token', locked: false, changed_by: 'ana' }] });
    expect((await (await l.get('/api/secret?name=bot.token')).json()).secret.value).toBe('abc123');
    expect((await l.get('/api/secret?name=nope')).status).toBe(404);
    expect((await l.get('/api/secret?name=..%2Fx')).status).toBe(404);
  });

  it('stores an enc:v1: string verbatim, and the node cannot use it', async () => {
    const l = await limb();
    const enc = await encryptValue('pw', 'the value');
    expect((await l.post({ name: 'team', value: enc })).status).toBe(200);
    expect(await readFile(join(home, 'secrets', 'managed', 'team'), 'utf8')).toBe(`${enc}\n`);
    expect(readSecret(home, 'team')).toMatchObject({ token: null, problem: 'encrypted' });
    const got = (await (await l.get('/api/secret?name=team')).json()).secret;
    expect(got).toMatchObject({ value: enc, locked: true });
    expect(await decryptValue('pw', got.value)).toBe('the value');
  });

  it('history is metadata: a locked old value stays as ciphertext, a plain one is never kept; a rename moves value, history and meta', async () => {
    const l = await limb();
    const enc = await encryptValue('pw', 'one');
    await l.post({ name: 'a', value: enc });
    await l.post({ name: 'a', value: 'two' });
    let j = await (await l.get('/api/secret?name=a')).json();
    expect(j.history).toHaveLength(1);
    expect(j.history[0]).toMatchObject({ kind: 'encrypted', value: enc, changed_by: 'ana', replaced_by: 'ana' });
    const r = await (await l.post({ name: 'b', from: 'a', value: 'three' })).json();
    expect(r).toMatchObject({ action: 'renamed', secret: { name: 'b', value: 'three' } });
    expect(r.history.map((h) => [h.kind, h.value])).toEqual([['plain', undefined], ['encrypted', enc]]);
    expect(JSON.stringify(r.history)).not.toContain('two');
    expect((await l.get('/api/secret?name=a')).status).toBe(404);
    expect((await (await l.get('/api/list')).json()).secrets.map((s) => s.name)).toEqual(['b']);
  });

  it('refuses bad names, an empty or oversize value, bad JSON and a rename onto an existing name; GET on save is 405', async () => {
    const l = await limb();
    for (const name of ['', '.x', 'a/b', '.meta.json', 'x'.repeat(101)]) expect((await l.post({ name, value: 'v' })).status, name).toBe(400);
    expect((await l.post({ name: 'ok', value: '' })).status).toBe(400);
    expect((await l.post({ name: 'ok', value: 'a'.repeat(64 * 1024) })).status).toBe(200);
    expect((await l.post({ name: 'big', value: 'a'.repeat(64 * 1024 + 1) })).status).toBe(400);
    expect((await l.post({ name: 'huge', value: 'a'.repeat(200 * 1024) })).status).toBe(413);
    expect((await l.post('{nope')).status).toBe(400);
    await l.post({ name: 'other', value: 'o' });
    expect((await l.post({ name: 'other', from: 'ok', value: 'v' })).status).toBe(400);
    expect((await l.get('/api/save')).status).toBe(405);
    expect((await l.post({}, l.token, '/api/list')).status).toBe(405);
  });

  it('every save and rename is audited: name, action, who, kind; the audit line never has the value', async () => {
    const l = await limb();
    await l.post({ name: 'a', value: 'SECRET-VALUE-1' });
    await l.post({ name: 'a', value: await encryptValue('pw', 'SECRET-VALUE-2') });
    await l.post({ name: 'b', from: 'a', value: 'SECRET-VALUE-3' });
    expect(l.audits).toEqual([
      { name: 'a', action: 'created', who: 'ana', kind: 'plain' },
      { name: 'a', action: 'changed', who: 'ana', kind: 'encrypted' },
      { name: 'a → b', action: 'renamed', who: 'ana', kind: 'plain' },
    ]);
    const lines = l.audits.map((a) => logLine({}, 'secret_changed', { node: 'HQ', ...a }));
    expect(lines[0]).toBe('🔐 HQ · secret a created by ana (plain)');
    expect(lines.join('\n')).not.toMatch(/SECRET-VALUE|enc:v1/);
    expect(logLine({ language: 'es_VE' }, 'secret_changed', { node: 'HQ', name: 'a', action: 'changed', who: 'ana', kind: 'plain' })).toBe('🔐 HQ · secreto a changed por ana (plain)');
  });

  it('no secretSessions: no page; the chatbox path overlapping it turns it off', async () => {
    const l = await limb({ secretSessions: null });
    expect((await l.get('/api/list')).status).toBe(404);
    const lines = [];
    const o = await limb({ path: '/ayde/x', onLog: (m) => lines.push(m) });
    expect((await o.get('/api/list')).status).toBe(404);
    expect(lines.join('\n')).toMatch(/secrets page off/);
  });

  it('sessions: unique, 15 minutes fixed from opening (several saves within), constant-time compare on a live set', () => {
    const s = createSecretSessions({ now: () => clock });
    const a = s.open({ who: 'ana', operator: '@a', chatId: '!c' }), b = s.open({ who: 'bo', operator: '@b', chatId: '!c' });
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.expires - clock).toBe(15 * 60_000);
    clock += 14 * 60_000;
    expect(s.check(a.token)).toMatchObject({ who: 'ana' });
    expect(s.check(b.token)).toMatchObject({ who: 'bo' });
    clock += 60_000;
    expect(s.check(a.token)).toBeNull();
  });
});

describe('the claim: the first browser to open the link owns it', () => {
  it('before the claim a GET shows only the Open button, and nothing else answers', async () => {
    const l = await limb({ claim: false });
    for (const sub of ['', '/', '?name=bot.token']) {
      const r = await l.get(sub);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain('<button');
      expect(html).not.toMatch(/id="(secret|name|value)"|page\.js|api\//);
    }
    for (const sub of ['/api/list', '/api/secret?name=a', '/page.js', '/crypto.js']) expect((await l.get(sub)).status, sub).toBe(404);
    expect((await l.post({ name: 'a', value: 'v' })).status).toBe(404);
    expect((await l.get('')).headers.get('set-cookie')).toBeNull();
    expect(l.audits).toEqual([]);   // a GET (a link-preview bot) claims nothing
  });

  it('the claim sets the owner cookie and shows the code, and the page opens only once the chat confirms it', async () => {
    const l = await limb({ claim: false });
    const r = await l.claimIt();
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`/ayde/secret/${l.token}`);
    const set = r.headers.get('set-cookie');
    expect(set).toMatch(/^secret_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/ayde\/secret\/[A-Za-z0-9_-]{43}; Max-Age=900$/);
    expect(l.audits).toEqual([]);   // claimed, not confirmed: nothing is opened yet
    expect((await l.get('/api/list')).status).toBe(403);
    expect(await (await l.get('')).text()).toContain(l.codeOf());
    l.confirmIt(l.codeOf());
    expect(l.audits).toEqual([{ action: 'opened', who: 'ana' }]);
    expect(logLine({}, 'secret_opened', { node: 'HQ', ...l.audits[0] })).toBe("🔐 HQ · secrets page opened by ana's link");
    const page = await l.get('');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="secret"');
    expect((await l.get('/api/list')).status).toBe(200);
  });

  it('without the cookie, or with another, every route is 404; a second claim is 404 and changes nothing', async () => {
    const l = await limb();
    const owner = l.cookieOf();
    l.as({});
    for (const sub of ['', '/api/list', '/page.js']) expect((await l.get(sub)).status, sub).toBe(404);
    expect((await l.post({ name: 'a', value: 'v' })).status).toBe(404);
    l.as({ Cookie: 'secret_session=nope' });
    expect((await l.get('/api/list')).status).toBe(404);
    expect((await l.claimIt()).status).toBe(404);
    expect(l.audits).toEqual([]);
    l.as(owner);
    expect((await l.get('/api/list')).status).toBe(200);
  });

  it('the cookie works until the session expires, then 404 even with it', async () => {
    const l = await limb();
    clock += 14 * 60_000;
    expect((await l.get('/api/list')).status).toBe(200);
    clock += 60_000;
    expect((await l.get('/api/list')).status).toBe(404);
  });

  it('Max-Age follows the time left of the session', async () => {
    const l = await limb({ claim: false });
    clock += 5 * 60_000;
    expect((await l.claimIt()).headers.get('set-cookie')).toMatch(/Max-Age=600$/);
  });
});

describe('the page lock (http-secrets-crypto.mjs)', () => {
  it('round-trips: enc:v1:<salt 16>:<iv 12>:<ct>, a fresh salt and iv each time', async () => {
    const a = await encryptValue('correct horse', 'multi\nline ünïcode value'), b = await encryptValue('correct horse', 'multi\nline ünïcode value');
    expect(isEncrypted(a)).toBe(true);
    const [, , salt, iv, ct] = a.split(':');
    expect(Buffer.from(salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(ct, 'base64').length).toBeGreaterThan(16);
    expect(a).not.toBe(b);
    expect(a).not.toContain('ünïcode');
    expect(await decryptValue('correct horse', a)).toBe('multi\nline ünïcode value');
  });

  it('round-trips a ~64 KB value (b64 is built in chunks: no argument-limit overflow)', async () => {
    const big = 'é'.repeat(32 * 1024);
    const enc = await encryptValue('pw', big);
    expect(await decryptValue('pw', enc)).toBe(big);
  });

  it('a wrong password fails the GCM check; a tampered value too', async () => {
    const a = await encryptValue('right', 'v');
    await expect(decryptValue('wrong', a)).rejects.toMatchObject({ name: 'OperationError' });
    const parts = a.split(':'); parts[4] = Buffer.from('tampered-bytes-tampered').toString('base64');
    await expect(decryptValue('right', parts.join(':'))).rejects.toBeTruthy();
    expect(isEncrypted('plain')).toBe(false);
  });
});
