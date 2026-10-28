// http-ayde.mjs — /ayde: the EduWeb team's read-only browser of EGPT_HOME, by level (limbs.http.ayde).
// http.mjs checks the login (HTTP Basic against secrets/ayde.users: checkUser) and, on a public request
// (one through the site's proxy), refuses a user above limbs.http.ayde.public_max_level; under <ayde path>/:
//   (none)                          the page (http-ayde.html)
//   search?q=&abrin=                {user, level, conversations: [{id, path, usuario, last}]} newest first (conversations/http/*/usuario.json; below root the scope's)
//   tree[?p=<path>]                 {user, level, path, entries: [{name, dir, size, mtime, level, link?}], truncated}; one folder
//   tree (no p)                     root: EGPT_HOME; below root {user, level, path: '', scope: true, entries: [{name, path, chats, …}]}
//   file?p=<path>[&download=1]      {path, size, text, truncated} | {path, size, binary} | the bytes
// Paths are relative to EGPT_HOME and resolve (realpath) inside it. levelOf, on the asked path and on the
// real one, decides who reads it; above the user's level: refuse(level), a 401 in that level's realm.
// The scope (limbs.http.ayde.scope): chat ids; their folders by conversations.yaml (registry()) are all that
// team, devs and admin read, everything else is root's. In them a .secrets segment is root's, another dot
// segment devs'. Each tree, view and download is a line in the log, and in the conversation's
// admin-access.log when inside one.
import { readFileSync, createReadStream, constants } from 'node:fs';
import { readdir, readFile, realpath, stat, lstat, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join, sep, relative } from 'node:path';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { EGPT_HOME } from '../egpt-home.mjs';
import { getContact, slugDir } from '../conversations-state.mjs';

const PAGE = readFileSync(new URL('./http-ayde.html', import.meta.url), 'utf8');
const TEXT_MAX = 256 * 1024;
const LIST_MAX = 2000;
const FOUND_MAX = 100;
export const AUDIT_FILE = 'admin-access.log';
const USUARIO_KEYS = ['abrin', 'user_type', 'short_name', 'username', 'user_id'];
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, '?');
const inside = (dir, p) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
const rfc5987 = (s) => encodeURIComponent(s).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

// Lowest first; each level reads all the lower ones read.
export const LEVELS = Object.freeze(['team', 'devs', 'admin', 'root']);
const rank = (level) => LEVELS.indexOf(level);
// Who reads a path (its parts under EGPT_HOME), given the scope's folders (each its parts).
export function levelOf(parts, homes) {
  const home = homes.find((h) => h.length && h.every((x, i) => parts[i] === x));
  if (!home) return 'root';
  const sub = parts.slice(home.length);
  if (sub.includes('.secrets')) return 'root';   // credentials
  return sub.some((p) => p.startsWith('.')) ? 'devs' : 'team';
}
// A scope entry covers its chat id and that chat's sub-chats (<id>/<n>: Telegram topics); one ending in "-" every id it starts.
const covers = (entry, id) => (entry.endsWith('-') ? id.startsWith(entry) : id === entry || id.startsWith(`${entry}/`));

// The users: secrets/ayde.users, one line each: <user>:<level>:N=<n>,r=<r>,p=<p>:<salt base64>:<scrypt hash base64>.
export const AYDE_USERS_FILE = 'ayde.users';
export const USER_RE = /^[A-Za-z0-9._@-]{1,64}$/;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const LINE_RE = /^([^:]+):(team|devs|admin|root):N=(\d+),r=(\d+),p=(\d+):([A-Za-z0-9+/]+=*):([A-Za-z0-9+/]+=*)$/;
const derive = promisify(scrypt);
const kdf = (password, salt, len, { N, r, p }) => derive(String(password), salt, len, { N, r, p, maxmem: 256 * N * r });
export async function userLine(user, level, password) {
  const salt = randomBytes(16);
  return `${user}:${level}:N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}:${salt.toString('base64')}:${(await kdf(password, salt, 32, SCRYPT)).toString('base64')}`;
}
// The user's level when the password is right, else null. An unknown user costs the same scrypt.
export async function checkUser(text, user, password) {
  const m = String(text ?? '').split('\n').map((l) => LINE_RE.exec(l.trim())).find((x) => x?.[1] === user);
  const want = m ? Buffer.from(m[7], 'base64') : null;
  const ok = want?.length >= 16;
  const got = await kdf(password, ok ? Buffer.from(m[6], 'base64') : Buffer.alloc(16), ok ? want.length : 32, ok ? { N: +m[3], r: +m[4], p: +m[5] } : SCRYPT).catch(() => null);
  return ok && got && timingSafeEqual(got, want) ? m[2] : null;
}

export function createBrowser({ root, json, log = () => {}, now = () => Date.now(), scope = null, registry = async () => null }) {
  const ids = Array.isArray(scope) ? scope.filter((e) => typeof e === 'string' && e.trim()).map((e) => e.trim()) : [];
  if (!ids.length) log('ayde: limbs.http.ayde.scope is empty — below root, nobody sees a conversation');
  // The scope's folders, [{ parts, chats }] by path: the folder of each registry chat an entry covers.
  async function scoped() {
    const state = await registry();
    const byPath = new Map();
    for (const [surface, bucket] of Object.entries(state?.contacts ?? {})) {
      for (const id of Object.keys(bucket ?? {})) {
        const slug = ids.some((e) => covers(e, id)) && getContact(state, surface, id)?.slug;
        if (!slug) continue;
        let parts;
        try { parts = relative(EGPT_HOME, slugDir(surface, slug)).split(sep); } catch { continue; }   // a surface unsafe as a path
        const path = parts.join('/');
        byPath.set(path, { parts, chats: [...(byPath.get(path)?.chats ?? []), id] });
      }
    }
    return [...byPath].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, f]) => f);
  }
  const partsOf = (p) => {
    const parts = String(p).split('/').filter(Boolean);
    return parts.some((x) => x === '.' || x === '..' || /[\\\0:]/.test(x)) ? null : parts;
  };
  // { base, real, parts }: the path with its links followed, inside EGPT_HOME, parts relative to it; else null.
  async function resolve(parts) {
    const base = await realpath(root).catch(() => null);
    const real = base && await realpath(join(base, ...parts)).catch(() => null);
    return real && inside(base, real) ? { base, real, parts: relative(base, real).split(sep).filter(Boolean) } : null;
  }

  // Inside a conversation (conversations/<surface>/<name>/): also its admin-access.log, O_NOFOLLOW so a
  // planted link never redirects the append.
  async function audit(who, hit, verb, dir) {
    const line = clean(`${who.user} (${who.level}) ${verb} ${hit.parts.join('/')}${dir ? '/' : ''}`);
    log(`ayde: ${line}`);
    if (hit.parts[0] !== 'conversations' || hit.parts.length < (dir ? 3 : 4)) return;
    const fh = await open(join(hit.base, ...hit.parts.slice(0, 3), AUDIT_FILE), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0));
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

  // folders: the scope's (below root), else null: every conversations/http/ folder.
  async function search(q, abrin, folders) {
    const dir = join(root, 'conversations', 'http');
    const names = folders
      ? folders.filter((f) => f.parts.length === 3 && f.parts[0] === 'conversations' && f.parts[1] === 'http').map((f) => f.parts[2])
      : (await readdir(dir).catch(() => [])).filter((name) => !name.startsWith('.'));
    const found = [];
    for (const name of names) {
      if (!(await lstat(join(dir, name)).catch(() => null))?.isDirectory()) continue;
      const usuario = await usuarioOf(join(dir, name));
      if (q && !String(usuario?.username ?? '').toLowerCase().includes(q)) continue;
      if (abrin && String(usuario?.abrin ?? '').toLowerCase() !== abrin) continue;
      found.push({ id: name, path: `conversations/http/${name}`, usuario, last: await lastOf(join(dir, name)) });
    }
    return found.sort((a, b) => b.last - a.last).slice(0, FOUND_MAX);
  }

  // Below root, the top: each scope folder there is, by name, with the chat ids it serves.
  async function tops(folders) {
    const out = [];
    for (const { parts, chats } of folders) {
      const st = await lstat(join(root, ...parts)).catch(() => null);
      if (st?.isDirectory()) out.push({ name: parts.at(-1), path: parts.join('/'), chats, dir: true, size: null, mtime: st.mtimeMs, level: 'team' });
    }
    return out;
  }

  // One folder; a dot entry is invisible to team.
  async function list(hit, who, homes) {
    const entries = [];
    for (const name of (await readdir(hit.real)).sort()) {
      if (entries.length >= LIST_MAX) break;
      if (who.level === 'team' && name.startsWith('.')) continue;
      const st = await lstat(join(hit.real, name)).catch(() => null);
      if (!st) continue;
      const to = st.isSymbolicLink() ? await stat(join(hit.real, name)).catch(() => null) : st;
      entries.push({ name, dir: !!to?.isDirectory(), size: to?.isFile() ? to.size : null, mtime: st.mtimeMs, level: levelOf([...hit.parts, name], homes), ...(st.isSymbolicLink() ? { link: true } : {}) });
    }
    return { entries, truncated: entries.length >= LIST_MAX };
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

  // who: { user, level } or null (no valid login: the team realm, whatever the path); refuse(level) answers
  // 401 in that level's realm.
  async function serve(call, req, res, url, who, refuse) {
    const q = url.searchParams;
    const asked = (call === 'tree' || call === 'file') && q.has('p') ? partsOf(q.get('p')) : null;
    const denied = (need, path) => {
      if (who) log(`ayde: ${clean(`${who.user} (${who.level}) refused ${path}`)} — needs ${need}`);
      return refuse(need);
    };
    if (!who) return denied('team', call);
    if (call == null) return page(res);
    const folders = await scoped();
    const homes = folders.map((f) => f.parts);
    const need = asked ? levelOf(asked, homes) : 'team';
    if (rank(need) > rank(who.level)) return denied(need, asked.join('/'));
    if (call === 'search') {
      const text = String(q.get('q') ?? '').trim().toLowerCase(), abrin = String(q.get('abrin') ?? '').trim().toLowerCase();
      log(`ayde: ${clean(`${who.user} (${who.level}) searched ${JSON.stringify(text)}${abrin ? ` abrin ${JSON.stringify(abrin)}` : ''}`)}`);
      return json(res, 200, { user: who.user, level: who.level, conversations: await search(text, abrin, who.level === 'root' ? null : folders) });
    }
    if (call !== 'tree' && call !== 'file') return json(res, 404, { error: 'not found' });
    if (call === 'tree' && !q.has('p') && who.level !== 'root') {
      log(`ayde: ${clean(`${who.user} (${who.level}) listed the scope`)}`);
      return json(res, 200, { user: who.user, level: who.level, path: '', scope: true, entries: await tops(folders), truncated: false });
    }
    const parts = q.has('p') ? asked : call === 'tree' ? [] : null;
    const hit = parts && await resolve(parts);
    if (!hit) return json(res, 404, { error: 'not found' });
    const real = levelOf(hit.parts, homes);
    if (rank(real) > rank(who.level)) return denied(real, hit.parts.join('/'));
    const st = await stat(hit.real);
    if (call === 'tree') {
      if (!st.isDirectory()) return json(res, 404, { error: 'not found' });
      await audit(who, hit, 'listed', true);
      return json(res, 200, { user: who.user, level: who.level, path: hit.parts.join('/'), ...(await list(hit, who, homes)) });
    }
    if (!st.isFile()) return json(res, 404, { error: 'not found' });
    const path = hit.parts.join('/');
    const download = q.get('download') === '1';
    await audit(who, hit, download ? 'downloaded' : 'viewed', false);
    if (download) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': String(st.size), 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename*=UTF-8''${rfc5987(hit.parts.at(-1))}`, 'X-Content-Type-Options': 'nosniff',
      });
      return pipeline(createReadStream(hit.real), res);
    }
    const fh = await open(hit.real, 'r');
    let buf;
    try {
      buf = Buffer.alloc(Math.min(st.size, TEXT_MAX));
      buf = buf.subarray(0, (await fh.read(buf, 0, buf.length, 0)).bytesRead);
    } finally { await fh.close(); }
    if (buf.includes(0)) return json(res, 200, { path, size: st.size, binary: true });
    return json(res, 200, { path, size: st.size, text: buf.toString('utf8'), truncated: st.size > buf.length });
  }

  return { serve };
}
