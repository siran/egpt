// http-admin.test.mjs — the team's read-only folder browser on the chatbox limb (clients.<c>.admin):
// AyDE signs {role: "admin", staff, exp} with the client's ADMIN key; the page and its calls show the
// client's conversation folders (search by username → tree → file), never outside them, never writing.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpBridge } from '../src/bridges/http.mjs';
import { freeSafeHttpPort } from './free-safe-http-port.mjs';

const ADMIN_KEY = 'dummy-admin-key-not-a-secret';
const VISITOR_KEY = 'dummy-visitor-key-not-a-secret';
const sign = (payload, key = ADMIN_KEY) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
};
const exp = (s = 600) => Math.floor(Date.now() / 1000) + s;
const tok = (over = {}) => sign({ role: 'admin', staff: 'jaime', exp: exp(), ...over });

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

async function limb({ admin = 'on', key = ADMIN_KEY } = {}) {
  const port = await freeSafeHttpPort();
  const lines = [];
  const b = await startHttpBridge({
    port, clients: { acme: { being: 'ed', admin, identity: 'optional' }, zeta: { being: 'ed', admin: 'on' } },
    identityKey: () => VISITOR_KEY, adminKey: (c) => key, conversationsDir: root, onLog: (m) => lines.push(m),
  });
  live.push(() => b.stop());
  const base = `http://127.0.0.1:${port}/chat/acme/admin`;
  const api = (sub, params = {}, t = tok(), init = {}) => fetch(`${base}/${sub}?${new URLSearchParams(params)}`, { ...init, headers: t ? { Authorization: `Bearer ${t}` } : {} });
  const get = async (sub, params, t) => { const r = await api(sub, params, t); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; };
  return { base, api, get, lines };
}

describe('clients.<c>.admin — the folder browser', () => {
  it('off (default), or on without a key file: 404 everywhere, the method no matter', async () => {
    for (const opts of [{ admin: 'off' }, { admin: null }, { key: null }]) {
      const { base, api } = await limb(opts);
      expect((await fetch(`${base}?t=${tok()}`)).status).toBe(404);
      expect((await api('search', { q: '' })).status).toBe(404);
      expect((await api('file', { c: A, f: 'transcript.md' }, tok(), { method: 'POST' })).status).toBe(404);
    }
  });

  it('a bad, expired, too long-lived, non-admin or visitor-key token is 401 with a Spanish line; the token never reaches the log', async () => {
    const { base, get, lines } = await limb();
    const good = tok();
    const [body, mac] = good.split('.');
    const bad = [
      sign({ role: 'admin', staff: 'jaime', exp: exp() }, VISITOR_KEY),
      sign({ abrin: 'IEV', username: 'mlopez', exp: exp() }, VISITOR_KEY),
      sign({ abrin: 'IEV', username: 'mlopez', exp: exp() }),
      tok({ exp: exp(-5) }), tok({ exp: exp(2 * 3600) }), tok({ role: 'staff' }), tok({ staff: '' }), tok({ exp: 'luego' }),
      `${body}.${mac}x`, 'abc', '',
    ];
    for (const t of bad) {
      const page = await fetch(`${base}?t=${encodeURIComponent(t)}`);
      expect(page.status, t.slice(0, 30)).toBe(401);
      expect(await page.text()).toMatch(/AyDE/);
      const r = await get('search', { q: '' }, t);
      expect(r.status, t.slice(0, 30)).toBe(401);
      expect(r.body.message).toMatch(/AyDE/);
    }
    // the calls take the token from the header only, never the URL
    expect((await get('search', { q: '', t: good }, null)).status).toBe(401);
    expect(lines.join('\n')).not.toContain(body);
  });

  it('the page: one self-contained Spanish HTML, no external asset, a nonce CSP, no referrer', async () => {
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
    expect(t).toEqual({ status: 200, body: { path: '.secrets/db.env', size: 13, text: 'PGUSER=dummy\n', truncated: false } });
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

  it('an unknown call under admin is 404', async () => {
    const { get } = await limb();
    expect((await get('rename', { c: A })).status).toBe(404);
    expect((await get('file/extra', { c: A })).status).toBe(404);
  });

  it('a client named <c>-admin would share <c>\'s admin key file: <c>\'s browser stays off', async () => {
    const port = await freeSafeHttpPort();
    const lines = [];
    const b = await startHttpBridge({ port, clients: { acme: { admin: 'on' }, 'acme-admin': {} }, adminKey: () => ADMIN_KEY, conversationsDir: root, onLog: (m) => lines.push(m) });
    live.push(() => b.stop());
    expect((await fetch(`http://127.0.0.1:${port}/chat/acme/admin?t=${tok()}`)).status).toBe(404);
    expect(lines).toContain("acme: admin off — client 'acme-admin' would share its key file");
  });
});
