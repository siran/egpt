// http-ayde.mjs — /ayde: the EduWeb team's read-only browser of EGPT_HOME, by level (limbs.http.ayde).
// http.mjs checks the login (HTTP Basic against secrets/ayde.users: checkUser) and, on a public request
// (one through the site's proxy), refuses a user above limbs.http.ayde.public_max_level; under <ayde path>/:
//   (none)                          the page (http-ayde.html)
//   tree[?p=<path>]                 {user, level, path, entries: [{name, dir, size, mtime, level, link?}], truncated}; one folder
//   tree (no p)                     root: EGPT_HOME; below root the scope's conversations, as tree?scope=1
//   tree?scope=1                    {user, level, path: '', scope: true, sections: [{id, kind, label}], entries: [{name, path, chats,
//                                   section, label, kind, title, usuario, preview, last, …}]}: the scope's conversations, any level
//   file?p=<path>[&download=1]      {path, size, text, truncated} | {path, size, binary} | the bytes
//   logout[?n=]                     401 + SIGNED_OUT, no challenge (http.mjs, before the lockout); its script overwrites each cached login (Firefox) and reloads to drop them (Chrome)
//   logout?realm=<level>            with the reserved logout user: 401 in that realm so the browser replaces the credential it cached there
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
import { stripFrontMatter } from '../transcript-meta.mjs';
import { stripInvisible } from '../invisible.mjs';

const PAGE = readFileSync(new URL('./http-ayde.html', import.meta.url), 'utf8');
// A signed out login means answering 401 — the browser holds the credential and only a refusal makes it
// let go — but a bare 401 lands on the browser's own error page. So the refusal carries this page, and a
// script overwrites each realm's cached credential with the reserved 'logout' user (granted nothing) so
// the next visit is challenged again. Firefox keeps a credential until all its windows close; when the
// overwrite does not take (a follow-up still carries the real user) the page says so instead.
const SIGNED_OUT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Signed out · ayde</title>
<style>
  :root { --bg: #f6f7f9; --card: #fff; --ink: #1d2330; --muted: #667085; --line: #e3e6ec; --accent: #1f6feb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14171c; --card: #1c2027; --ink: #e6e8ec; --muted: #98a2b3; --line: #2c323c; --accent: #58a6ff; } }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--ink); font: 14px/1.4 system-ui, sans-serif; }
  main { max-width: 420px; margin: 10vh auto 0; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px 20px; }
  h1 { font-size: 16px; margin: 0 0 8px; }
  p { margin: 8px 0 0; }
  a { color: var(--accent); }
  .muted { color: var(--muted); }
</style>
</head>
<body>
<main>
<h1 id="h">Signed out</h1>
<div id="out">
<p><a href="./">Sign in again</a></p>
<p class="muted">You can also sign in as another user: follow the link and enter that user's name and password.</p>
</div>
<div id="kept" hidden>
<p>This browser keeps your login until all its windows close. Close them to sign out, or <a href="./">go back to ayde</a>.</p>
</div>
</main>
<script>
(() => {
  var realms = ['team', 'devs', 'admin', 'root'];
  var dummy = Math.random().toString(36).slice(2);
  var n = +(new URLSearchParams(location.search).get('n')) || 0;
  // One request per realm with the reserved 'logout' user: the server answers 401 for that realm. Firefox
  // replaces the credential it cached there; Chrome ignores a 401 it did not prompt for, so for Chrome each
  // reload below drops one cached login (Chrome forgets the credential a navigation's 401 refused).
  function poison(realm) {
    return new Promise(function (done) {
      var x = new XMLHttpRequest();
      x.open('GET', 'logout?realm=' + realm, true, 'logout', dummy);
      x.withCredentials = true;
      x.onloadend = done; x.onerror = done;
      x.send();
    });
  }
  // Does a login still open the console? fetch never shows the browser's own prompt, so a surviving
  // credential answers 200 and a cleared one 401.
  function signedIn() {
    return fetch('./', { cache: 'no-store' }).then(function (r) { return r.status === 200; }, function () { return false; });
  }
  Promise.all(realms.map(poison)).then(signedIn).then(function (still) {
    if (!still) return;                                       // cleared → the page stays "Signed out"
    if (n < realms.length) { location.replace('logout?n=' + (n + 1)); return; }   // Chrome: drop the next cached login
    document.getElementById('h').textContent = 'Still signed in';                 // gave up (a browser that keeps it)
    document.getElementById('out').hidden = true; document.getElementById('kept').hidden = false;
  });
})();
</script>
</body>
</html>
`;
const TEXT_MAX = 256 * 1024;
const LIST_MAX = 2000;
const HEAD_MAX = 64 * 1024, HISTORY_MAX = 1024 * 1024, PREVIEW_MAX = 80;
const SESSION_RE = /^http:([a-z0-9][a-z0-9_-]*)-([0-9a-f]{16})$/;   // a chatbox session: client, sid
const VISITOR_RE = /^visitor@\[[^\]]*\]\.\S+\s+\(\d{1,2}:\d{2}\)(?:\s+#[^\s:]+)?: ?(.*)$/;
const HEAD_RE = /^(?:\[\s*)?@?[^@\n]+@\[[^\]]*\]\.\S+\s+\(\d{1,2}:\d{2}\)/;
const TELEGRAM_LABEL = 'Team groups (Telegram)', OTHER_LABEL = 'Other';
export const AUDIT_FILE = 'admin-access.log';
// The username the logout page sends to overwrite a cached login; never a real user (ayde-user.mjs refuses it).
export const RESERVED_USER = 'logout';
const USUARIO_KEYS = ['abrin', 'user_type', 'short_name', 'username', 'user_id'];
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, '?');
const oneLine = (s) => stripInvisible(String(s)).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s) => { const cs = [...oneLine(s)]; return cs.length > PREVIEW_MAX ? `${cs.slice(0, PREVIEW_MAX - 1).join('').trimEnd()}…` : cs.join(''); };
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

// clients: [{ name, label }], the chatboxes in order (http.mjs chatboxesOf); messagesDir: the chatbox's session histories (<sid>.json).
export function createBrowser({ root, json, log = () => {}, now = () => Date.now(), scope = null, registry = async () => null, clients = [], messagesDir = null }) {
  const ids = Array.isArray(scope) ? scope.filter((e) => typeof e === 'string' && e.trim()).map((e) => e.trim()) : [];
  if (!ids.length) log('ayde: limbs.http.ayde.scope is empty — below root, nobody sees a conversation');
  // The scope's folders, [{ parts, chats, title }] by path: the folder of each registry chat an entry covers.
  // title: its chat's name in the registry (never a /split fork's), else the folder's without its -<datestamp>.
  async function scoped() {
    const state = await registry();
    const byPath = new Map();
    for (const [surface, bucket] of Object.entries(state?.contacts ?? {})) {
      for (const id of Object.keys(bucket ?? {})) {
        const hit = ids.some((e) => covers(e, id)) && getContact(state, surface, id);
        if (!hit?.slug) continue;
        let parts;
        try { parts = relative(EGPT_HOME, slugDir(surface, hit.slug)).split(sep); } catch { continue; }   // a surface unsafe as a path
        const path = parts.join('/');
        const f = byPath.get(path) ?? { parts, chats: [], names: [] };
        f.chats.push(id);
        const name = oneLine(hit.entry?.pushedName ?? '');
        if (name && !hit.entry?.parent_chat) f.names.push(name);
        byPath.set(path, f);
      }
    }
    return [...byPath].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, { parts, chats, names }]) => ({
      parts, chats, title: names[0] || parts.at(-1).replace(/-\d{10}$/, ''),
    }));
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

  async function headOf(file, n) {
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(n);
      return buf.subarray(0, (await fh.read(buf, 0, n, 0)).bytesRead).toString('utf8');
    } finally { await fh.close(); }
  }
  // An anonymous session's first visitor line: its history (<messagesDir>/<sid>.json, never through a
  // link), else its transcript.md where a team user may read it (inside the scope). Never logged.
  async function firstSaid(parts, sid, homes) {
    const file = messagesDir && join(messagesDir, `${sid}.json`);
    const st = file && await lstat(file).catch(() => null);
    if (st?.isFile() && st.size <= HISTORY_MAX) {
      try {
        const said = JSON.parse(await readFile(file, 'utf8'));
        const m = Array.isArray(said) && said.find((x) => x?.from === 'visitor' && typeof x.text === 'string' && x.text.trim());
        if (m) return m.text;
      } catch { /* unreadable: the transcript */ }
    }
    const hit = await resolve([...parts, 'transcript.md']);
    if (!hit || levelOf(hit.parts, homes) !== 'team' || !(await stat(hit.real).catch(() => null))?.isFile()) return null;
    const lines = stripFrontMatter((await headOf(hit.real, HEAD_MAX)).replace(/\r\n/g, '\n')).split('\n');
    const at = lines.findIndex((l) => VISITOR_RE.test(l));
    if (at < 0) return null;
    const said = [VISITOR_RE.exec(lines[at])[1]];
    for (const l of lines.slice(at + 1)) { if (!l.trim() || HEAD_RE.test(l)) break; said.push(l); }
    return said.join(' ');
  }

  // The scope's conversations as the page lists them: a section per chatbox client (chatboxesOf's
  // order, its label), then the Telegram groups and topics, then any other chat. Entries by path.
  async function conversations(folders) {
    const homes = folders.map((f) => f.parts);
    const entries = [];
    for (const { parts, chats, title } of folders) {
      const dir = join(root, ...parts);
      const st = await lstat(dir).catch(() => null);
      if (!st?.isDirectory()) continue;
      const e = { name: parts.at(-1), path: parts.join('/'), chats, dir: true, size: null, mtime: st.mtimeMs, level: 'team', last: await lastOf(dir) };
      const session = chats.map((id) => SESSION_RE.exec(id)).find(Boolean);
      if (session) {
        const usuario = await usuarioOf(dir);
        const said = usuario ? null : await firstSaid(parts, session[2], homes);
        entries.push({ ...e, kind: 'chatbox', section: `chatbox:${session[1]}`, title: usuario?.short_name || usuario?.username || 'Visitor', usuario, preview: clip(said ?? '') || null });
      } else {
        const kind = chats.every((id) => id.startsWith('tg:')) ? 'telegram' : 'other';
        entries.push({ ...e, kind, section: kind, title, usuario: null, preview: null });
      }
    }
    // A client is in the scope when an entry covers any of its session ids, even before its first session.
    const reaches = (name) => ids.some((x) => { const p = `http:${name}-`; return x.endsWith('-') ? p.startsWith(x) || x.startsWith(p) : x.startsWith(p); });
    const sections = clients.filter((c) => reaches(c.name)).map((c) => ({ id: `chatbox:${c.name}`, kind: 'chatbox', label: c.label || c.name }));
    for (const e of entries) {
      if (e.kind === 'chatbox' && !sections.some((s) => s.id === e.section)) sections.push({ id: e.section, kind: 'chatbox', label: e.section.slice('chatbox:'.length) });
    }
    if (ids.some((x) => x.startsWith('tg:')) || entries.some((e) => e.kind === 'telegram')) sections.push({ id: 'telegram', kind: 'telegram', label: TELEGRAM_LABEL });
    if (entries.some((e) => e.kind === 'other')) sections.push({ id: 'other', kind: 'other', label: OTHER_LABEL });
    for (const e of entries) e.label = sections.find((s) => s.id === e.section).label;
    return { sections, entries };
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

  function html(res, status, text) {
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.end(text.replace('<script>', `<script nonce="${nonce}">`).replace('<style>', `<style nonce="${nonce}">`));
  }
  const page = (res) => html(res, 200, PAGE);
  // The signed-out page. user: the name the request carried, unchecked (no scrypt here, so no lockout to
  // keep). The reserved logout user is the overwrite's own probe, not a person: no "signed out" line for it.
  function signOut(res, user) {
    if (user && user !== RESERVED_USER) log(`ayde: ${clean(user)} signed out`);
    return html(res, 401, SIGNED_OUT);
  }
  // The credential-overwrite request (reserved logout user, a realm): 401 in that realm so the browser
  // replaces the credential it cached there. Never a login, never counted, grants nothing.
  function overwrite(res, realm) {
    res.writeHead(401, {
      'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      'WWW-Authenticate': `Basic realm="ayde ${LEVELS.includes(realm) ? realm : 'team'}", charset="UTF-8"`,
    });
    res.end('signed out\n');
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
    if (call !== 'tree' && call !== 'file') return json(res, 404, { error: 'not found' });
    if (call === 'tree' && !q.has('p') && (who.level !== 'root' || q.get('scope') === '1')) {
      log(`ayde: ${clean(`${who.user} (${who.level}) listed the scope`)}`);
      return json(res, 200, { user: who.user, level: who.level, path: '', scope: true, ...(await conversations(folders)), truncated: false });
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

  return { serve, signOut, overwrite };
}
