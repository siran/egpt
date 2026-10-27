// http-ayde.mjs — /ayde: the EduWeb team's read-only browser of EGPT_HOME, by level (limbs.http.ayde).
// http.mjs checks the login (HTTP Basic against secrets/ayde.users: checkUser); under <ayde path>/:
//   (none)                          the page (http-ayde.html)
//   search?q=&abrin=                {user, level, conversations: [{id, path, usuario, last}]} newest first (conversations/http/*/usuario.json)
//   tree[?p=<path>]                 {user, level, path, entries: [{name, dir, size, mtime, level, link?}], truncated}; one folder; no p: the user's top
//   file?p=<path>[&download=1]      {path, size, text, truncated, masked?} | {path, size, binary} | the bytes
// Paths are relative to EGPT_HOME and resolve (realpath) inside it. levelOf, on the asked path and on the
// real one, decides who reads it; above the user's level: refuse(level), a 401 in that level's realm.
// Each tree, view and download is a line in the log, and in the conversation's admin-access.log when inside one.
import { readFileSync, createReadStream, constants } from 'node:fs';
import { readdir, readFile, realpath, stat, lstat, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join, sep, relative } from 'node:path';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { parseDocument, visit, isScalar, isCollection, isPair, isAlias } from 'yaml';

const PAGE = readFileSync(new URL('./http-ayde.html', import.meta.url), 'utf8');
const TEXT_MAX = 256 * 1024;
const LIST_MAX = 2000;
const FOUND_MAX = 100;
const MASK_MAX = 4 * 1024 * 1024;
export const AUDIT_FILE = 'admin-access.log';
const USUARIO_KEYS = ['abrin', 'user_type', 'short_name', 'username', 'user_id'];
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, '?');
const inside = (dir, p) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
const rfc5987 = (s) => encodeURIComponent(s).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

// Lowest first; each level reads all the lower ones read.
export const LEVELS = Object.freeze(['team', 'devs', 'admin', 'root']);
const rank = (level) => LEVELS.indexOf(level);
// Who reads a path (its parts under EGPT_HOME): the first matching rule.
export function levelOf(parts) {
  if (parts[0] === 'secrets' || parts[0] === 'chrome') return 'root';   // chrome/: browser profiles hold signed-in sessions
  if (parts[0] !== 'conversations') return 'admin';
  return parts.some((p) => p.startsWith('.')) ? 'devs' : 'team';
}
const topOf = (level) => (rank(level) < rank('admin') ? ['conversations'] : []);

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

// YAML/JSON with every value under a key matching SECRET_KEY, and the rest of a full-line comment
// naming one, as "•••(<length>)"; comments and layout kept. Null when it does not parse.
const SECRET_KEY = /token|secret|password|key|hash/i;
const SECRET_COMMENT = /^([ \t]*#.*?[\w.-]*(?:token|secret|password|key|hash)[\w.-]*[ \t]*:[ \t]*)\S.*$/gim;
export function maskSecrets(text) {
  const doc = parseDocument(text);
  if (doc.errors.length) return null;
  const cuts = new Map();
  const hide = (node) => {
    if (isAlias(node)) hide(node.resolve(doc));
    else if (isScalar(node)) { if (node.value != null && node.range) cuts.set(node.range[0], [node.range[1], String(node.value).length]); }
    else if (isCollection(node)) for (const it of node.items) hide(isPair(it) ? it.value : it);
  };
  visit(doc, { Pair(_, pair) { if (isScalar(pair.key) && SECRET_KEY.test(String(pair.key.value))) { hide(pair.value); return visit.SKIP; } } });
  let out = text;
  for (const [a, [b, n]] of [...cuts].sort((x, y) => y[0] - x[0])) out = `${out.slice(0, a)}"•••(${n})"${/\s*$/.exec(out.slice(a, b))[0]}${out.slice(b)}`;
  return out.replace(SECRET_COMMENT, (_, head) => `${head}•••`);
}

export function createBrowser({ root, json, log = () => {}, now = () => Date.now() }) {
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

  async function search(q, abrin) {
    const dir = join(root, 'conversations', 'http');
    const found = [];
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const usuario = await usuarioOf(join(dir, e.name));
      if (q && !String(usuario?.username ?? '').toLowerCase().includes(q)) continue;
      if (abrin && String(usuario?.abrin ?? '').toLowerCase() !== abrin) continue;
      found.push({ id: e.name, path: `conversations/http/${e.name}`, usuario, last: await lastOf(join(dir, e.name)) });
    }
    return found.sort((a, b) => b.last - a.last).slice(0, FOUND_MAX);
  }

  // One folder; a dot entry is invisible to team.
  async function list(hit, who) {
    const entries = [];
    for (const name of (await readdir(hit.real)).sort()) {
      if (entries.length >= LIST_MAX) break;
      if (who.level === 'team' && name.startsWith('.')) continue;
      const st = await lstat(join(hit.real, name)).catch(() => null);
      if (!st) continue;
      const to = st.isSymbolicLink() ? await stat(join(hit.real, name)).catch(() => null) : st;
      entries.push({ name, dir: !!to?.isDirectory(), size: to?.isFile() ? to.size : null, mtime: st.mtimeMs, level: levelOf([...hit.parts, name]), ...(st.isSymbolicLink() ? { link: true } : {}) });
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

  // who: { user, level } or null (no valid login); refuse(level) answers 401 in that level's realm.
  async function serve(call, req, res, url, who, refuse) {
    const q = url.searchParams;
    const asked = (call === 'tree' || call === 'file') && q.has('p') ? partsOf(q.get('p')) : null;
    const denied = (need, path) => {
      if (who) log(`ayde: ${clean(`${who.user} (${who.level}) refused ${path}`)} — needs ${need}`);
      return refuse(need);
    };
    const need = asked ? levelOf(asked) : 'team';
    if (!who || rank(need) > rank(who.level)) return denied(need, asked?.join('/') ?? call);
    if (call == null) return page(res);
    if (call === 'search') {
      const text = String(q.get('q') ?? '').trim().toLowerCase(), abrin = String(q.get('abrin') ?? '').trim().toLowerCase();
      log(`ayde: ${clean(`${who.user} (${who.level}) searched ${JSON.stringify(text)}${abrin ? ` abrin ${JSON.stringify(abrin)}` : ''}`)}`);
      return json(res, 200, { user: who.user, level: who.level, conversations: await search(text, abrin) });
    }
    if (call !== 'tree' && call !== 'file') return json(res, 404, { error: 'not found' });
    const parts = q.has('p') ? asked : call === 'tree' ? topOf(who.level) : null;
    const hit = parts && await resolve(parts);
    if (!hit) return json(res, 404, { error: 'not found' });
    const real = levelOf(hit.parts);
    if (rank(real) > rank(who.level)) return denied(real, hit.parts.join('/'));
    const st = await stat(hit.real);
    if (call === 'tree') {
      if (!st.isDirectory()) return json(res, 404, { error: 'not found' });
      await audit(who, hit, 'listed', true);
      return json(res, 200, { user: who.user, level: who.level, path: hit.parts.join('/'), ...(await list(hit, who)) });
    }
    if (!st.isFile()) return json(res, 404, { error: 'not found' });
    const path = hit.parts.join('/');
    let masked = null;
    if (who.level === 'admin' && real === 'admin' && /\.(ya?ml|json)$/i.test(path)) {
      masked = st.size <= MASK_MAX ? maskSecrets(await readFile(hit.real, 'utf8')) : null;
      if (masked == null) return denied('root', `${path} (cannot mask it)`);
    }
    const download = q.get('download') === '1';
    await audit(who, hit, download ? 'downloaded' : 'viewed', false);
    if (download) {
      const body = masked == null ? null : Buffer.from(masked, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': String(body?.length ?? st.size), 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename*=UTF-8''${rfc5987(hit.parts.at(-1))}`, 'X-Content-Type-Options': 'nosniff',
      });
      return body ? res.end(body) : pipeline(createReadStream(hit.real), res);
    }
    if (masked != null) return json(res, 200, { path, size: st.size, text: masked.slice(0, TEXT_MAX), truncated: masked.length > TEXT_MAX, masked: true });
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
