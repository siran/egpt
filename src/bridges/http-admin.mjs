// http-admin.mjs — the team's read-only folder browser of a chatbox client (limbs.http clients.<c>.admin).
// http.mjs checks the token (verifyAdmin); under <path>/<client>/admin:
//   (none)                          the page (http-admin.html)
//   search?q=&abrin=                {staff, conversations: [{id, usuario, last}]} newest first; q: part of a username
//   tree?c=<conversation>           {id, entries: [{path, dir, size, mtime, link?}], truncated}; links not followed
//   file?c=&f=<path>[&download=1]   {path, size, text, truncated} | {path, size, binary} | the bytes
// Every path resolves (realpath) inside <root>/<client>-<sid>. Each tree, view and download is a line in
// the log and in that conversation's admin-access.log.
import { readFileSync, createReadStream, constants } from 'node:fs';
import { readdir, readFile, realpath, stat, lstat, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join, sep, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

const PAGE = readFileSync(new URL('./http-admin.html', import.meta.url), 'utf8');
const TEXT_MAX = 256 * 1024;
const TREE_MAX = 2000;
const FOUND_MAX = 100;
export const AUDIT_FILE = 'admin-access.log';
const USUARIO_KEYS = ['abrin', 'user_type', 'short_name', 'username', 'user_id'];
const SID_RE = /^[0-9a-f]{16}$/;
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, '?');
const inside = (dir, p) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
const rfc5987 = (s) => encodeURIComponent(s).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

export function createFolderBrowser({ root, json, log = () => {}, now = () => Date.now() }) {
  const isConv = (client, id) => typeof id === 'string' && id.startsWith(`${client}-`) && SID_RE.test(id.slice(client.length + 1));

  // { top, real, rel }: the conversation's own folder (not a link) and a path in it, or null.
  async function resolve(client, id, rel = '') {
    if (!isConv(client, id)) return null;
    const parts = String(rel).split('/').filter(Boolean);
    if (parts.some((p) => p === '.' || p === '..' || /[\\\0]/.test(p))) return null;
    const base = await realpath(root).catch(() => null);
    const top = base && await realpath(join(base, id)).catch(() => null);
    if (!top || top !== join(base, id)) return null;
    const real = await realpath(join(top, ...parts)).catch(() => null);
    return real && inside(top, real) ? { top, real, rel: parts.join('/') } : null;
  }

  // O_NOFOLLOW: a link planted in the folder never redirects the append.
  async function audit(client, top, staff, verb, what) {
    const line = `staff ${staff} ${verb} ${clean(what)}`;
    log(`${client}: ${line}`);
    const fh = await open(join(top, AUDIT_FILE), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0));
    try { await fh.writeFile(`${new Date(now()).toISOString()} ${line}\n`, 'utf8'); } finally { await fh.close(); }
  }

  const usuarioOf = async (dir) => {
    const p = join(dir, 'usuario.json');
    try {
      if (!(await lstat(p)).isFile()) return null;
      const u = JSON.parse(await readFile(p, 'utf8'));
      return Object.fromEntries(USUARIO_KEYS.filter((k) => u?.[k] != null).map((k) => [k, String(u[k])]));
    } catch { return null; }
  };
  // The last line said: transcript.md's time, else the folder's.
  const lastOf = async (dir) => (await lstat(join(dir, 'transcript.md')).catch(() => lstat(dir))).mtimeMs;

  async function search(client, q, abrin) {
    const found = [];
    for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || !isConv(client, e.name)) continue;
      const dir = join(root, e.name);
      const usuario = await usuarioOf(dir);
      if (q && !String(usuario?.username ?? '').toLowerCase().includes(q)) continue;
      if (abrin && String(usuario?.abrin ?? '').toLowerCase() !== abrin) continue;
      found.push({ id: e.name, usuario, last: await lastOf(dir) });
    }
    return found.sort((a, b) => b.last - a.last).slice(0, FOUND_MAX);
  }

  async function tree(top) {
    const entries = [];
    const walk = async (dir, prefix) => {
      const names = (await readdir(dir).catch(() => [])).sort();
      for (const name of names) {
        if (entries.length >= TREE_MAX) return;
        const st = await lstat(join(dir, name)).catch(() => null);
        if (!st) continue;
        const path = `${prefix}${name}`;
        entries.push({ path, dir: st.isDirectory(), size: st.isFile() ? st.size : null, mtime: st.mtimeMs, ...(st.isSymbolicLink() ? { link: true } : {}) });
        if (st.isDirectory()) await walk(join(dir, name), `${path}/`);
      }
    };
    await walk(top, '');
    return { entries, truncated: entries.length >= TREE_MAX };
  }

  function page(res) {
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.end(PAGE.replace('<script>', `<script nonce="${nonce}">`).replace('<style>', `<style nonce="${nonce}">`));
  }

  async function serve(client, call, req, res, url, staff) {
    if (call == null) return page(res);
    const q = url.searchParams;
    if (call === 'search') {
      const text = String(q.get('q') ?? '').trim().toLowerCase(), abrin = String(q.get('abrin') ?? '').trim().toLowerCase();
      log(`${client}: staff ${staff} searched ${clean(JSON.stringify(text))}${abrin ? ` abrin ${clean(JSON.stringify(abrin))}` : ''}`);
      return json(res, 200, { staff, conversations: await search(client, text, abrin) });
    }
    if (call !== 'tree' && call !== 'file') return json(res, 404, { error: 'not found' });
    const id = q.get('c');
    const hit = await resolve(client, id, call === 'file' ? q.get('f') ?? '' : '');
    if (!hit || (call === 'file' && !hit.rel)) return json(res, 404, { error: 'not found' });
    if (call === 'tree') {
      await audit(client, hit.top, staff, 'viewed', `${id}/`);
      return json(res, 200, { id, ...(await tree(hit.top)) });
    }
    const st = await stat(hit.real);
    if (!st.isFile()) return json(res, 404, { error: 'not found' });
    const download = q.get('download') === '1';
    await audit(client, hit.top, staff, download ? 'downloaded' : 'viewed', `${id}/${hit.rel}`);
    if (download) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': String(st.size), 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename*=UTF-8''${rfc5987(basename(hit.rel))}`, 'X-Content-Type-Options': 'nosniff',
      });
      return pipeline(createReadStream(hit.real), res);
    }
    const fh = await open(hit.real, 'r');
    let buf;
    try {
      buf = Buffer.alloc(Math.min(st.size, TEXT_MAX));
      buf = buf.subarray(0, (await fh.read(buf, 0, buf.length, 0)).bytesRead);
    } finally { await fh.close(); }
    if (buf.includes(0)) return json(res, 200, { path: hit.rel, size: st.size, binary: true });
    return json(res, 200, { path: hit.rel, size: st.size, text: buf.toString('utf8'), truncated: st.size > buf.length });
  }

  return { serve };
}
