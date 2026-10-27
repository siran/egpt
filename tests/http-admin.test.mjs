// http-admin.test.mjs — the escritorio: the team's read-only folder browser on the chatbox limb
// (clients.<c>.escritorio), at <path>/<client>/escritorio/. In by HTTP Basic (the client's users file)
// or by AyDE's link ({role: "admin", staff, exp} signed with the client's escritorio key). It shows the
// client's conversation folders (search by username → tree → file), never outside them, never writing.
import { describe, it, expect, afterEach, beforeEach, beforeAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpBridge } from '../src/bridges/http.mjs';
import { staffLine } from '../src/bridges/http-admin.mjs';
import { freeSafeHttpPort } from './free-safe-http-port.mjs';

const ADMIN_KEY = 'dummy-admin-key-not-a-secret';
const VISITOR_KEY = 'dummy-visitor-key-not-a-secret';
const PASSWORD = 'dummy-password-not-a-secret';
const CHALLENGE = 'Basic realm="escritorio acme", charset="UTF-8"';
const sign = (payload, key = ADMIN_KEY) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
};
const exp = (s = 600) => Math.floor(Date.now() / 1000) + s;
const tok = (over = {}) => sign({ role: 'admin', staff: 'jaime', exp: exp(), ...over });
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

let USERS;
beforeAll(async () => { USERS = `${await staffLine('ana', PASSWORD)}\n${await staffLine('luis', 'otra-clave-de-prueba')}`; });

const A = 'acme-00000000000000a1', B = 'acme-00000000000000b2', C = 'acme-00000000000000c3', OTHER = 'zeta-00000000000000d4';
let root, outside;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'egpt-http-admin-'));
  outside = await mkdtemp(join(tmpdir(), 'egpt-http-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'outside the conversations', 'utf8');
  const conv = async (id, usuario, files, t) => {
    const dir = join(root, id);
    await mkdir(join(dir, 'gavetas'), { recursive: true });
    await mkdir(join(dir, '.secrets'), { recursive: true });
    if (usuario) await writeFile(join(dir, 'usuario.json'), JSON.stringify(usuario), 'utf8');
    for (const [f, text] of Object.entries(files)) await writeFile(join(dir, f), text);
    await writeFile(join(dir, 'transcript.md'), `transcript of ${id}\n`, 'utf8');
    const at = new Date(t);
    await utimes(join(dir, 'transcript.md'), at, at);
  };
  await conv(A, { abrin: 'IEV', user_type: 'R', short_name: 'María López', username: 'mlopez' }, { 'gavetas/notas.md': 'notas de María\n', '.secrets/db.env': 'PGUSER=dummy\n', 'gavetas/foto.bin': Buffer.from([0x89, 0x50, 0, 1, 2, 0]) }, '2026-10-26T10:00:00Z');
  await conv(B, { abrin: 'IEV', user_type: 'R', short_name: 'María López', username: 'mlopez' }, {}, '2026-10-20T10:00:00Z');
  await conv(C, { abrin: 'CSJ', user_type: 'P', short_name: 'Juan Pérez', username: 'jperez' }, {}, '2026-10-25T10:00:00Z');
  await conv(OTHER, { abrin: 'IEV', user_type: 'R', short_name: 'María López', username: 'mlopez' }, {}, '2026-10-27T10:00:00Z');
});

const live = [];
afterEach(async () => {
  while (live.length) await live.pop()();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

// t: a signed token (sent as Bearer) or a "Basic …" header; null sends none.
async function limb({ escritorio = 'on', key = ADMIN_KEY, users = () => USERS, ...opts } = {}) {
  const port = await freeSafeHttpPort();
  const lines = [];
  const b = await startHttpBridge({
    port, clients: { acme: { being: 'ed', escritorio, identity: 'optional' }, zeta: { being: 'ed', escritorio: 'on' } },
    identityKey: () => VISITOR_KEY, escritorioKey: () => key, escritorioUsers: () => users?.() ?? null, conversationsDir: root, onLog: (m) => lines.push(m), ...opts,
  });
  live.push(() => b.stop());
  const base = `http://127.0.0.1:${port}/chat/acme/escritorio/`;
  const auth = (t) => (t ? { Authorization: t.startsWith('Basic ') ? t : `Bearer ${t}` } : {});
  const api = (sub, params = {}, t = tok(), init = {}) => fetch(`${base}${sub}?${new URLSearchParams(params)}`, { ...init, headers: { ...auth(t), ...init.headers } });
  const get = async (sub, params, t, init) => { const r = await api(sub, params, t, init); return { status: r.status, challenge: r.headers.get('www-authenticate'), body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; };
  const page = (t, init = {}) => fetch(base, { ...init, headers: { ...auth(t), ...init.headers } });
  return { port, base, api, get, page, lines };
}

describe('clients.<c>.escritorio — the folder browser', () => {
  it('off (default), or on with neither a users file nor a key: 404 everywhere, the method no matter', async () => {
    for (const opts of [{ escritorio: 'off' }, { escritorio: null }, { key: null, users: null }]) {
      const { base, api, page } = await limb(opts);
      expect((await fetch(`${base}?t=${tok()}`)).status).toBe(404);
      expect((await page(basic('ana', PASSWORD))).status).toBe(404);
      expect((await api('search', { q: '' })).status).toBe(404);
      expect((await api('file', { c: A, f: 'transcript.md' }, tok(), { method: 'POST' })).status).toBe(404);
    }
  });

  it('the admin route is gone: 404 with a good token, page and calls', async () => {
    const { port } = await limb();
    const old = `http://127.0.0.1:${port}/chat/acme/admin`;
    expect((await fetch(`${old}?t=${tok()}`)).status).toBe(404);
    expect((await fetch(`${old}/search?q=`, { headers: { Authorization: `Bearer ${tok()}` } })).status).toBe(404);
  });

  it('escritorio without its slash: 308 to escritorio/, the query kept', async () => {
    const { port } = await limb();
    const r = await fetch(`http://127.0.0.1:${port}/chat/acme/escritorio?t=abc`, { redirect: 'manual' });
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe('escritorio/?t=abc');
  });

  it('no credentials: 401 with the Basic challenge (the browser\'s own login), page and calls', async () => {
    const { base, get } = await limb();
    const p = await fetch(base);
    expect(p.status).toBe(401);
    expect(p.headers.get('www-authenticate')).toBe(CHALLENGE);
    expect(await p.text()).toMatch(/AyDE/);
    for (const sub of ['search', 'tree', 'file']) {
      const r = await get(sub, { c: A, f: 'transcript.md' }, null);
      expect(r.status, sub).toBe(401);
      expect(r.challenge, sub).toBe(CHALLENGE);
      expect(r.body.message).toMatch(/AyDE/);
    }
  });

  it('HTTP Basic: a wrong password or an unknown user is 401; the right one opens the page and the calls, and the audit names the user', async () => {
    const { get, page, lines } = await limb();
    for (const t of [basic('ana', 'wrong-password-x'), basic('nadie', PASSWORD), basic('ana', ''), basic('', PASSWORD), 'Basic ###', 'Basic ']) {
      const r = await page(t);
      expect(r.status, t).toBe(401);
      expect(r.headers.get('www-authenticate')).toBe(CHALLENGE);
    }
    expect((await get('search', { q: '' }, basic('ana', 'wrong-password-x'))).status).toBe(401);
    const ok = basic('ana', PASSWORD);
    const p = await page(ok);
    expect(p.status).toBe(200);
    expect(p.headers.get('content-type')).toMatch(/text\/html/);
    const s = await get('search', { q: 'mlop' }, ok);
    expect(s.status).toBe(200);
    expect(s.body.staff).toBe('ana');
    expect(s.body.conversations.map((c) => c.id)).toEqual([A, B]);
    expect((await get('tree', { c: A }, ok)).status).toBe(200);
    expect((await get('file', { c: A, f: 'gavetas/notas.md' }, ok)).body.text).toBe('notas de María\n');
    const audit = await readFile(join(root, A, 'admin-access.log'), 'utf8');
    expect(audit).toMatch(new RegExp(`staff ana viewed ${A}/\\n`));
    expect(audit).toMatch(new RegExp(`staff ana viewed ${A}/gavetas/notas\\.md\\n`));
    expect(lines.join('\n')).toMatch(/staff ana searched/);
    expect(lines.join('\n')).not.toMatch(/dummy-password|wrong-password/);
  });

  it('either credential: users file only takes Basic and refuses a token; key only takes the token', async () => {
    const usersOnly = await limb({ key: null });
    expect((await usersOnly.get('search', { q: '' }, tok())).status).toBe(401);
    expect((await usersOnly.get('search', { q: '' }, basic('luis', 'otra-clave-de-prueba'))).body.staff).toBe('luis');
    const keyOnly = await limb({ users: null });
    expect((await keyOnly.get('search', { q: '' }, basic('ana', PASSWORD))).status).toBe(401);
    expect((await keyOnly.get('search', { q: '' }, tok())).body.staff).toBe('jaime');
  });

  it('the users file is read on each request: a user added or removed applies without a restart', async () => {
    let text = USERS;
    const { get } = await limb({ users: () => text });
    const ana = basic('ana', PASSWORD);
    expect((await get('search', { q: '' }, ana)).status).toBe(200);
    text = await staffLine('luis', 'otra-clave-de-prueba');
    expect((await get('search', { q: '' }, ana)).status).toBe(401);
    text = `${text}\n${await staffLine('ana', 'nueva-clave-de-ana')}`;
    expect((await get('search', { q: '' }, basic('ana', 'nueva-clave-de-ana'))).body.staff).toBe('ana');
  });

  it('10 failed logins from one address in 15 min: 429 for 15 min, the right password too; another address and the signed link still open it; the log never has a password', async () => {
    let t = Date.now();
    const { get, lines } = await limb({ trustProxy: true, now: () => t });
    const from = (ip) => ({ headers: { 'X-Forwarded-For': ip } });
    const wrong = basic('ana', 'wrong-password-x'), right = basic('ana', PASSWORD);
    for (let i = 0; i < 10; i++) expect((await get('search', { q: '' }, wrong, from('203.0.113.5'))).status, `try ${i + 1}`).toBe(401);
    const locked = await get('search', { q: '' }, right, from('203.0.113.5'));
    expect(locked.status).toBe(429);
    expect(locked.body.retry_after_s).toBe(900);
    expect(locked.body.message).toMatch(/15 minutos/);
    expect((await get('search', { q: '' }, null, from('203.0.113.5'))).status).toBe(429);
    expect((await get('search', { q: '' }, right, from('203.0.113.6'))).status).toBe(200);
    expect((await get('search', { q: '' }, tok(), from('203.0.113.5'))).status).toBe(200);
    t += 15 * 60_000;
    expect((await get('search', { q: '' }, right, from('203.0.113.5'))).status).toBe(200);
    expect(lines.filter((l) => /escritorio login refused for "ana" from 203\.0\.113\.5/.test(l))).toHaveLength(10);
    expect(lines.some((l) => /203\.0\.113\.5 locked out of the escritorio for 15 min/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/dummy-password|wrong-password/);
  });

  it('tries sent in parallel count too: of 15 at once, at most 10 reach the password check', async () => {
    const { get, lines } = await limb();
    const all = await Promise.all(Array.from({ length: 15 }, () => get('search', { q: '' }, basic('ana', 'wrong-password-x'))));
    expect(all.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(5);
    expect(lines.filter((l) => /escritorio login refused/.test(l)).length).toBeLessThanOrEqual(10);
  });

  it('failures older than 15 min no longer count', async () => {
    let t = Date.now();
    const { get } = await limb({ now: () => t });
    const wrong = basic('ana', 'wrong-password-x');
    for (let i = 0; i < 9; i++) expect((await get('search', { q: '' }, wrong)).status).toBe(401);
    t += 15 * 60_000 + 1;
    expect((await get('search', { q: '' }, wrong)).status).toBe(401);
    expect((await get('search', { q: '' }, basic('ana', PASSWORD))).status).toBe(200);
  });

  it('a bad, expired, too long-lived, non-admin or visitor-key token is 401 with the challenge and a Spanish line; the token never reaches the log', async () => {
    const { base, get, lines } = await limb();
    const good = tok();
    const [body, mac] = good.split('.');
    const bad = [
      sign({ role: 'admin', staff: 'jaime', exp: exp() }, VISITOR_KEY),
      sign({ abrin: 'IEV', username: 'mlopez', exp: exp() }, VISITOR_KEY),
      sign({ abrin: 'IEV', username: 'mlopez', exp: exp() }),
      tok({ exp: exp(-5) }), tok({ exp: exp(2 * 3600) }), tok({ role: 'staff' }), tok({ staff: '' }), tok({ exp: 'luego' }),
      `${body}.${mac}x`, 'abc',
    ];
    for (const t of bad) {
      const page = await fetch(`${base}?t=${encodeURIComponent(t)}`);
      expect(page.status, t.slice(0, 30)).toBe(401);
      expect(page.headers.get('www-authenticate')).toBe(CHALLENGE);
      expect(await page.text()).toMatch(/AyDE/);
      const r = await get('search', { q: '' }, t);
      expect(r.status, t.slice(0, 30)).toBe(401);
      expect(r.body.message).toMatch(/AyDE/);
    }
    // the calls take the token from the header only, never the URL
    expect((await get('search', { q: '', t: good }, null)).status).toBe(401);
    expect(lines.join('\n')).not.toContain(body);
  });

  it('the page: one self-contained Spanish HTML, no external asset, a nonce CSP, no referrer; its calls are relative to escritorio/', async () => {
    const { base } = await limb();
    const r = await fetch(`${base}?t=${tok()}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = r.headers.get('content-security-policy');
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(csp).toMatch(/default-src 'none'/);
    const html = await r.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toMatch(/lang="es"/);
    expect(html).not.toMatch(/(src|href)=["']?(https?:)?\/\//);
    expect(html).not.toContain('admin/');
  });

  it('search: by username (any case, part of it), optionally abrin; this client only, newest transcript first', async () => {
    const { get, lines } = await limb();
    const r = await get('search', { q: 'MLOP' });
    expect(r.status).toBe(200);
    expect(r.body.staff).toBe('jaime');
    expect(r.body.conversations.map((c) => c.id)).toEqual([A, B]);
    expect(r.body.conversations[0]).toMatchObject({ usuario: { username: 'mlopez', abrin: 'IEV', short_name: 'María López' } });
    expect(r.body.conversations[0].last).toBeGreaterThan(r.body.conversations[1].last);
    expect((await get('search', { q: 'perez' })).body.conversations.map((c) => c.id)).toEqual([C]);
    expect((await get('search', { q: '', abrin: 'csj' })).body.conversations.map((c) => c.id)).toEqual([C]);
    expect((await get('search', { q: 'mlopez', abrin: 'CSJ' })).body.conversations).toEqual([]);
    expect((await get('search', { q: '' })).body.conversations.map((c) => c.id)).toEqual([A, C, B]);
    expect(lines.join('\n')).toMatch(/staff jaime searched/);
  });

  it('tree: the whole folder, gavetas/ and .secrets/ included, and it is audited', async () => {
    const { get } = await limb();
    const r = await get('tree', { c: A });
    expect(r.status).toBe(200);
    const paths = r.body.entries.map((e) => `${e.path}${e.dir ? '/' : ''}`);
    expect(paths).toEqual(expect.arrayContaining(['.secrets/', '.secrets/db.env', 'gavetas/', 'gavetas/notas.md', 'transcript.md', 'usuario.json']));
    expect(r.body.entries.find((e) => e.path === 'gavetas/notas.md')).toMatchObject({ dir: false, size: 16 });
    expect(await readFile(join(root, A, 'admin-access.log'), 'utf8')).toMatch(new RegExp(`staff jaime viewed ${A}/\\n`));
  });

  it('a file: text escaped by the page (sent as JSON text), binary flagged, download as bytes; each audited, no contents in any log', async () => {
    const { get, api, lines } = await limb();
    const t = await get('file', { c: A, f: '.secrets/db.env' });
    expect({ status: t.status, body: t.body }).toEqual({ status: 200, body: { path: '.secrets/db.env', size: 13, text: 'PGUSER=dummy\n', truncated: false } });
    const bin = await get('file', { c: A, f: 'gavetas/foto.bin' });
    expect(bin.body).toEqual({ path: 'gavetas/foto.bin', size: 6, binary: true });
    const d = await api('file', { c: A, f: 'gavetas/foto.bin', download: '1' });
    expect(d.status).toBe(200);
    expect(d.headers.get('content-disposition')).toMatch(/^attachment; filename\*=UTF-8''foto\.bin$/);
    expect(d.headers.get('content-type')).toBe('application/octet-stream');
    expect([...new Uint8Array(await d.arrayBuffer())]).toEqual([0x89, 0x50, 0, 1, 2, 0]);
    const audit = await readFile(join(root, A, 'admin-access.log'), 'utf8');
    expect(audit).toMatch(/^\d{4}-\d\d-\d\dT\S+ staff jaime viewed acme-00000000000000a1\/\.secrets\/db\.env$/m);
    expect(audit).toMatch(/staff jaime downloaded acme-00000000000000a1\/gavetas\/foto\.bin$/m);
    expect(lines.join('\n')).toMatch(/staff jaime viewed acme-00000000000000a1\/\.secrets\/db\.env/);
    expect(`${lines.join('\n')}${audit}`).not.toContain('PGUSER');
  });

  it('a text file past the cap is cut and says so', async () => {
    await writeFile(join(root, A, 'gavetas', 'big.txt'), 'x'.repeat(300 * 1024), 'utf8');
    const { get } = await limb();
    const r = await get('file', { c: A, f: 'gavetas/big.txt' });
    expect(r.body).toMatchObject({ size: 300 * 1024, truncated: true });
    expect(r.body.text.length).toBe(256 * 1024);
  });

  it('paths stay inside this client\'s conversation folders: ../, absolute, another client, a directory, unknown: 404', async () => {
    const { get } = await limb();
    const refused = [
      { c: A, f: `../${B}/transcript.md` }, { c: A, f: 'gavetas/../../outside' }, { c: A, f: '..' }, { c: A, f: 'gavetas\\..\\..\\x' },
      { c: `../${A}`, f: 'transcript.md' }, { c: '..', f: `${A}/transcript.md` }, { c: OTHER, f: 'transcript.md' },
      { c: 'acme-nothex0000000000', f: 'transcript.md' }, { c: A, f: 'gavetas' }, { c: A, f: '' }, { c: A, f: 'nope.md' },
      { c: A, f: join(outside, 'secret.txt') },
    ];
    for (const p of refused) {
      expect((await get('file', p)).status, JSON.stringify(p)).toBe(404);
      expect((await get('file', { ...p, download: '1' })).status, JSON.stringify(p)).toBe(404);
    }
    expect((await get('tree', { c: OTHER })).status).toBe(404);
    expect((await get('tree', { c: `${A}/..` })).status).toBe(404);
  });

  it('a symlink (or junction) out of the folder is refused; one to another conversation too', async () => {
    await symlink(outside, join(root, A, 'gavetas', 'fuera'), 'junction');
    await symlink(join(root, B), join(root, A, 'gavetas', 'vecino'), 'junction');
    let fileLink = true;
    try { await symlink(join(outside, 'secret.txt'), join(root, A, 'gavetas', 'secreto.txt')); } catch { fileLink = false; }   // Windows without the privilege
    const { get } = await limb();
    expect((await get('file', { c: A, f: 'gavetas/fuera/secret.txt' })).status).toBe(404);
    expect((await get('file', { c: A, f: 'gavetas/vecino/transcript.md' })).status).toBe(404);
    if (fileLink) expect((await get('file', { c: A, f: 'gavetas/secreto.txt' })).status).toBe(404);
    const tree = (await get('tree', { c: A })).body.entries.map((e) => e.path);
    expect(tree).toContain('gavetas/fuera');
    expect(tree.some((p) => p.startsWith('gavetas/fuera/') || p.startsWith('gavetas/vecino/'))).toBe(false);
  });

  it('a conversation folder that is itself a link out is refused', async () => {
    const id = 'acme-00000000000000e5';
    await symlink(outside, join(root, id), 'junction');
    const { get } = await limb();
    expect((await get('tree', { c: id })).status).toBe(404);
    expect((await get('file', { c: id, f: 'secret.txt' })).status).toBe(404);
  });

  it('read-only: POST, PUT, DELETE, PATCH on the page or any call are 405', async () => {
    const { base, api } = await limb();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await fetch(`${base}?t=${tok()}`, { method })).status, method).toBe(405);
      for (const sub of ['search', 'tree', 'file']) expect((await api(sub, { c: A, f: 'transcript.md' }, tok(), { method })).status, `${method} ${sub}`).toBe(405);
    }
    expect(await readFile(join(root, A, 'transcript.md'), 'utf8')).toBe(`transcript of ${A}\n`);
  });

  it('an unknown call under escritorio/ is 404', async () => {
    const { get } = await limb();
    expect((await get('rename', { c: A })).status).toBe(404);
    expect((await get('file/extra', { c: A })).status).toBe(404);
  });

  it('a client named <c>-escritorio would share <c>\'s escritorio key file: <c>\'s escritorio stays off', async () => {
    const port = await freeSafeHttpPort();
    const lines = [];
    const b = await startHttpBridge({ port, clients: { acme: { escritorio: 'on' }, 'acme-escritorio': {} }, escritorioKey: () => ADMIN_KEY, escritorioUsers: () => USERS, conversationsDir: root, onLog: (m) => lines.push(m) });
    live.push(() => b.stop());
    expect((await fetch(`http://127.0.0.1:${port}/chat/acme/escritorio/?t=${tok()}`)).status).toBe(404);
    expect(lines).toContain("acme: escritorio off — client 'acme-escritorio' would share its key file");
  });
});
