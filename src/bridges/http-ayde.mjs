// http-ayde.mjs — /ayde: the Contoso team's read-only browser of EGPT_HOME, by level (limbs.http.ayde).
// http.mjs checks the login (HTTP Basic against secrets/ayde.users: checkUser) and, on a public request
// (one through the site's proxy), refuses a user above limbs.http.ayde.public_max_level; under <ayde path>/:
//   (none)                          the page (http-ayde.html)
//   tree[?p=<path>]                 {user, level, path, entries: [{name, dir, size, mtime, level, link?}], truncated}; one folder
//   tree (no p)                     root: EGPT_HOME; below root the scope's conversations, as tree?scope=1
//   tree?scope=1                    {user, level, path: '', scope: true, sections: [{id, kind, label}], entries: [{name, path, chats,
//                                   section, label, kind, title, usuario, preview, last, …}]}: the scope's conversations, any level
//   file?p=<path>[&download=1]      {path, size, text, truncated} | {path, size, binary} | the bytes
//   home                            {user, level, zone, now, menu: [{id}], chatboxes: [{client, label, active, today, total, last}]}: the dashboard;
//                                   the menu holds only what the user's level reaches (levelOf, on the same paths as the pages below)
//   chatbox?c=<client>              {client, label, idleMs, now, chats: [{key, path, title, subtitle, userType, last, active, count, more, snippet, from}]}
//                                   a chatbox's chats, newest first; active: its last line is within the client's idle window (session_days)
//   room?p=<conversation folder>    {path, title, subtitle, section, messages: [{who, side, date, time, text}], partial}: its transcript.md as a conversation
//   area?k=heartbeats|scripts|desktop|credentials   {kind, groups: [{title, path, rows: [{name, path, dir, size, mtime, info, ran}]}]}: that folder
//                                   in each scoped conversation (heartbeats/*.yaml, scripts/*.x.md, desktop/, .credentials/); opening a row is tree/file
//   logout[?n=]                     401 + SIGNED_OUT, no challenge (http.mjs, before the lockout); its script overwrites each cached login (Firefox) and reloads to drop them (Chrome)
//   logout?realm=<level>            with the reserved logout user: 401 in that realm so the browser replaces the credential it cached there
// Paths are relative to EGPT_HOME and resolve (realpath) inside it. levelOf, on the asked path and on the
// real one, decides who reads it; above the user's level: refuse(level), a 401 in that level's realm.
// The scope (limbs.http.ayde.scope): chat ids; their folders by conversations.yaml (registry()) are all that
// team, devs and admin read, everything else is root's. In them a .secrets segment is root's, another dot
// segment devs'. Each tree, view, download and room is a line in the log, and in the conversation's
// admin-access.log when inside one; each chatbox and area list is a line in the log.
import { readFileSync, createReadStream, constants } from 'node:fs';
import { readdir, readFile, realpath, stat, lstat, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join, sep, relative } from 'node:path';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { EGPT_HOME } from '../egpt-home.mjs';
import { getContact, slugDir } from '../conversations-state.mjs';
import { parse as parseYaml } from 'yaml';
import { stripFrontMatter } from '../transcript-meta.mjs';
import { isDayBoundary } from '../dispatch-line.mjs';
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
const SESSION_RE = /^http:([a-z0-9][a-z0-9_-]*)-([0-9a-f]{16})$/;   // a chatbox conversation: client, key (a session's sid, or with conversation_by: identity the identity's)
const VISITOR_RE = /^visitor@\[[^\]]*\]\.\S+\s+\(\d{1,2}:\d{2}\)(?:\s+#[^\s:]+)?: ?(.*)$/;
const HEAD_RE = /^(?:\[\s*)?@?[^@\n]+@\[[^\]]*\]\.\S+\s+\(\d{1,2}:\d{2}\)/;
const TELEGRAM_LABEL = 'Team groups (Telegram)', OTHER_LABEL = 'Other';
export const AUDIT_FILE = 'admin-access.log';
// The username the logout page sends to overwrite a cached login; never a real user (ayde-user.mjs refuses it).
export const RESERVED_USER = 'logout';
const USUARIO_KEYS = ['abrin', 'user_type', 'short_name', 'username', 'user_id', 'title', 'subtitle'];
const TRANSCRIPT_MAX = 1024 * 1024, TRANSCRIPT_CACHE = 200, ROOM_MAX = 500, BEAT_MAX = 32 * 1024;
// A transcript line: <who>@[<chat>].<node> (HH:MM)[ #<id>]: <text>. A stage direction opens with "[", a day boundary is "[ 2026-09-01 ]".
const ENTRY_RE = /^([^@\n]+)@\[[^\]]*\]\.\S+\s+\((\d{1,2}):(\d{2})\)(?:\s+#[^\s:]+)?: ?(.*)$/;
// What each area page lists: the folder in a scoped conversation, and which of its entries.
const AREAS = {
  heartbeats: { sub: 'heartbeats', match: /\.ya?ml(\.pausado)?$/ },
  scripts: { sub: 'scripts', match: /\.x\.md$/ },
  desktop: { sub: 'desktop', match: null },
  credentials: { sub: '.credentials', match: null },
  outbox: { sub: 'outbox', match: null },
};
// A support line's speaker in the transcript is SUPPORT + the ayde user (http.mjs).
export const SUPPORT = 'support:';
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

// clients: [{ name, label, idleMs }], the chatboxes in order (http.mjs chatboxesOf); timeZone: the zone of the dashboard's clock and "today"; say({ client, key, user, text }) → the line on the chat's live session (http.mjs), or null; messagesDir: the chatbox's session histories (<sid>.json).
export function createBrowser({ root, json, log = () => {}, now = () => Date.now(), scope = null, registry = async () => null, clients = [], messagesDir = null, timeZone = null, say = null }) {
  const zone = (() => { try { return new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone; } catch { return 'UTC'; } })();
  const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
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
        entries.push({ ...e, kind: 'chatbox', section: `chatbox:${session[1]}`, key: session[2], title: usuario?.title || usuario?.short_name || usuario?.username || 'Visitor', usuario, preview: clip(said ?? '') || null });
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

  // ── the dashboard: home, a chatbox's chats, a room, the areas, a support line ──
  // A transcript as a conversation: [{ who, date, time, text }], oldest first, and whether the file was longer
  // than TRANSCRIPT_MAX (then it is its tail). A stage direction, a day boundary and a being's raw byte train
  // ("(streaming) …") are not lines; a day boundary dates the lines after it.
  function parseTranscript(text) {
    const lines = [];
    let cur = null, date = null;
    for (const line of stripFrontMatter(text.replace(/\r\n/g, '\n')).split('\n')) {
      if (isDayBoundary(line)) { date = line.replace(/[\[\]\s]/g, ''); cur = null; continue; }
      const m = line.startsWith('[') ? null : ENTRY_RE.exec(line);
      if (m) lines.push(cur = { who: m[1].trim(), date, time: `${m[2].padStart(2, '0')}:${m[3]}`, text: m[4] });
      else if (line.startsWith('[')) cur = null;
      else if (cur) cur.text += `\n${line}`;
    }
    return lines.filter((l) => !l.text.startsWith('(streaming)')).map((l) => ({ ...l, text: l.text.replace(/^\/reply\s+#\S+\s+/, '').trim() })).filter((l) => l.text);
  }
  const transcripts = new Map();   // real path → { stamp, lines, partial }: parsed again only when the file changed
  // A conversation's transcript.md, parsed, when its path (links followed) is a regular file the level may read; else null.
  async function transcriptOf(parts, homes, level) {
    const hit = await resolve([...parts, 'transcript.md']);
    if (!hit || rank(levelOf(hit.parts, homes)) > rank(level)) return null;
    const st = await stat(hit.real).catch(() => null);
    if (!st?.isFile()) return null;
    const stamp = `${st.mtimeMs}:${st.size}`;
    const hot = transcripts.get(hit.real);
    if (hot?.stamp === stamp) return hot;
    const fh = await open(hit.real, 'r');
    let text;
    try {
      const n = Math.min(st.size, TRANSCRIPT_MAX);
      const buf = Buffer.alloc(n);
      text = buf.subarray(0, (await fh.read(buf, 0, n, st.size - n)).bytesRead).toString('utf8');
    } finally { await fh.close(); }
    const partial = st.size > TRANSCRIPT_MAX;
    const got = { stamp, partial, lines: parseTranscript(partial ? text.slice(text.indexOf('\n') + 1) : text), hit };
    transcripts.delete(hit.real);
    transcripts.set(hit.real, got);
    if (transcripts.size > TRANSCRIPT_CACHE) transcripts.delete(transcripts.keys().next().value);
    return got;
  }
  const isVisitor = (who) => who === 'visitor';
  const dayKey = (ms) => dayOf.format(ms);

  // One chat of a chatbox, as its list shows it. Its last line is the newest of its transcript (what a team user reads).
  async function chatRow(e, idleMs, homes) {
    const t = await transcriptOf(e.path.split('/'), homes, 'team');
    const last = t?.lines.at(-1);
    const u = e.usuario;
    return {
      key: SESSION_RE.exec(e.chats.find((id) => SESSION_RE.test(id)))[2], path: e.path, title: e.title,
      subtitle: u?.subtitle ?? u?.username ?? '', userType: u?.user_type ?? null,
      last: e.last, active: now() - e.last < idleMs, count: t?.lines.length ?? 0, more: !!t?.partial,
      snippet: last ? clip(last.text) : e.preview, from: last ? (isVisitor(last.who) ? 'visitor' : 'being') : null,
    };
  }
  const chatboxRows = async (entries, section, idleMs, homes) => {
    const rows = [];
    for (const e of entries.filter((x) => x.section === section)) rows.push(await chatRow(e, idleMs, homes));
    return rows.sort((a, b) => b.last - a.last);
  };
  // What a folder of a scoped conversation is for, by the pages: the path a page needs, and so the level. No scope: root's.
  const needOf = (sub, homes) => (homes.length ? levelOf([...homes[0], sub], homes) : 'root');

  async function home(who, folders, homes) {
    const { sections, entries } = await conversations(folders);
    const today = dayKey(now());
    const chatboxes = [];
    for (const s of sections.filter((x) => x.kind === 'chatbox')) {
      const client = s.id.slice('chatbox:'.length);
      const idleMs = clients.find((c) => c.name === client)?.idleMs ?? 0;
      const mine = entries.filter((e) => e.section === s.id).sort((a, b) => b.last - a.last);
      const newest = mine[0] && await chatRow(mine[0], idleMs, homes);
      chatboxes.push({
        client, label: s.label, total: mine.length, active: mine.filter((e) => now() - e.last < idleMs).length,
        today: mine.filter((e) => dayKey(e.last) === today).length,
        last: newest ? { at: newest.last, title: newest.title, text: newest.snippet, from: newest.from } : null,
      });
    }
    // The pages by what each needs (the page words them): the folder's path decides, as for tree and file.
    const needs = { chatboxes: 'team', conversations: 'team', heartbeats: needOf('heartbeats', homes), scripts: needOf('scripts', homes), desktop: needOf('desktop', homes), credentials: needOf('.credentials', homes), files: 'team' };
    const menu = Object.entries(needs).filter(([, need]) => rank(need) <= rank(who.level)).map(([id]) => ({ id }));
    return { user: who.user, level: who.level, zone, now: now(), menu, chatboxes };
  }

  // A heartbeat file as one line: when it fires, who or what it runs, the last day or instant it fired (the node's daily
  // ledger, state/heartbeats-daily.json, by "<surface>/<slug>:<name>": only these rows of it leave).
  function beatInfo(text, last, paused) {
    let b;
    try { b = parseYaml(text); } catch { return 'unreadable'; }
    if (!b || typeof b !== 'object') return 'unreadable';
    const when = b.daily ? `daily ${b.daily}${b.time_zone ? ` ${b.time_zone}` : ''}` : b.frequency ? `every ${b.frequency}` : b.when ? `once ${b.when}` : null;
    const does = b.agent ? `agent ${b.agent}` : b.script_path ? 'script' : b.command ? 'command' : null;
    return [when, does, last && `last fired ${last}`, paused && 'paused'].filter(Boolean).map((x) => oneLine(x)).join(' · ');
  }
  // The area folder of each scoped conversation (or of one: only), with its rows. A folder the level may not read is not listed.
  async function area(kind, who, folders, homes, only) {
    const titles = new Map((await conversations(folders)).entries.map((e) => [e.path, e.title]));
    const { sub, match } = AREAS[kind];
    const ledger = kind === 'heartbeats' ? JSON.parse(await readFile(join(root, 'state', 'heartbeats-daily.json'), 'utf8').catch(() => '{}')) : {};
    const groups = [];
    for (const f of folders) {
      if (only && f.parts.join('/') !== only) continue;
      const hit = await resolve([...f.parts, sub]);
      if (!hit || rank(levelOf(hit.parts, homes)) > rank(who.level) || !(await stat(hit.real)).isDirectory()) continue;
      const { entries } = await list(hit, who, homes);
      const rows = [];
      for (const e of entries.filter((x) => rank(x.level) <= rank(who.level) && (!match || match.test(x.name)))) {
        const row = { name: e.name, path: [...hit.parts, e.name].join('/'), dir: e.dir, size: e.size, mtime: e.mtime, info: null, ran: null };
        if (kind === 'scripts') row.ran = entries.find((x) => x.name === `${e.name}.log`)?.mtime ?? null;
        if (kind === 'heartbeats' && !e.dir && !e.link && e.size <= BEAT_MAX) {
          const base = e.name.replace(/\.ya?ml(\.pausado)?$/, '');
          row.info = beatInfo(await readFile(join(hit.real, e.name), 'utf8').catch(() => ''), ledger[`${f.parts.slice(1).join('/')}:${base}`], e.name.endsWith('.pausado'));
        }
        rows.push(row);
      }
      if (rows.length) groups.push({ title: titles.get(f.parts.join('/')) ?? f.title, path: f.parts.join('/'), rows: rows.sort((a, b) => b.mtime - a.mtime) });
    }
    return { kind, groups: groups.sort((a, b) => Math.max(...b.rows.map((r) => r.mtime)) - Math.max(...a.rows.map((r) => r.mtime))) };
  }

  // The new calls. Each is a line in the log; a room is also a view of transcript.md, so also in the conversation's admin-access.log.
  async function dashboard(call, q, res, who, folders, homes, denied) {
    const said = (what) => log(`ayde: ${clean(`${who.user} (${who.level}) ${what}`)}`);
    if (call === 'home') { said('opened the dashboard'); return json(res, 200, await home(who, folders, homes)); }
    if (call === 'chatbox') {
      const { sections, entries } = await conversations(folders);
      const client = q.get('c') ?? '';
      const s = sections.find((x) => x.id === `chatbox:${client}`);
      if (!s) return json(res, 404, { error: 'not found' });
      const idleMs = clients.find((c) => c.name === client)?.idleMs ?? 0;
      said(`listed chatbox ${client}`);
      return json(res, 200, { client, label: s.label, idleMs, now: now(), chats: await chatboxRows(entries, s.id, idleMs, homes) });
    }
    if (call === 'area') {
      const kind = q.get('k');
      if (!Object.hasOwn(AREAS, kind)) return json(res, 404, { error: 'not found' });
      const need = needOf(AREAS[kind].sub, homes);
      if (rank(need) > rank(who.level)) return denied(need, kind);
      said(`listed ${kind}`);
      return json(res, 200, await area(kind, who, folders, homes, q.has('p') ? partsOf(q.get('p'))?.join('/') : null));
    }
    // room: the conversation at <p>, its transcript.md at the user's level (never through a link out of the scope)
    const parts = partsOf(q.get('p') ?? '');
    const t = parts?.length && await transcriptOf(parts, homes, who.level);
    if (!t) return json(res, 404, { error: 'not found' });
    await audit(who, t.hit, 'viewed', false);
    const [entry] = (await conversations(folders.filter((f) => f.parts.join('/') === parts.join('/')))).entries;
    const messages = t.lines.slice(-ROOM_MAX).map((l) => ({
      who: l.who, date: l.date, time: l.time, text: l.text,
      side: entry?.kind === 'chatbox' && isVisitor(l.who) ? 'visitor' : l.who.startsWith(SUPPORT) ? 'support' : 'other',
    }));
    return json(res, 200, {
      path: parts.join('/'), title: entry?.title ?? parts.at(-1), subtitle: entry?.usuario?.subtitle ?? entry?.usuario?.username ?? '',
      kind: entry?.kind ?? null, section: entry?.section ?? null, usuario: entry?.usuario ?? null, chats: entry?.chats ?? [],
      last: entry?.last ?? null, messages, partial: t.partial || t.lines.length > ROOM_MAX,
    });
  }
  // A support person's line (POST say {client, key, text}): into the chat's live session, through the limb (say). Refused
  // as a write is: the chat's folder must be one the user reads (scope, level), and a browser must have sent it itself.
  async function support(req, res, body, who, folders, homes, denied) {
    if (!say) return json(res, 404, { error: 'not found' });
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? '')) || (req.headers['sec-fetch-site'] ?? 'same-origin') !== 'same-origin') return json(res, 403, { error: 'forbidden' });
    const client = String(body?.client ?? ''), key = String(body?.key ?? ''), text = stripInvisible(String(body?.text ?? ''));
    if (!/^[0-9a-f]{16}$/.test(key) || !text.trim()) return json(res, 400, { error: 'say who and what' });
    const f = folders.find((x) => x.chats.includes(`http:${client}-${key}`));
    const need = f ? levelOf(f.parts, homes) : 'root';
    if (rank(need) > rank(who.level)) return denied(need, `http:${client}-${key}`);
    const message = await say({ client, key, user: who.user, text });
    if (message?.error) return json(res, message.status, { error: message.error, ...(message.max ? { max_chars: message.max } : {}) });
    if (!message) return json(res, 409, { error: 'no live session' });
    if (f) await audit(who, { base: await realpath(root), parts: f.parts }, 'said in', true);
    else log(`ayde: ${clean(`${who.user} (${who.level}) said in http:${client}-${key}`)}`);
    return json(res, 200, { ok: true, message });
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
  async function serve(call, req, res, url, who, refuse, body = null) {
    const q = url.searchParams;
    const asked = (call === 'tree' || call === 'file' || call === 'room') && q.has('p') ? partsOf(q.get('p')) : null;
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
    if (call === 'say') return support(req, res, body, who, folders, homes, denied);
    if (['home', 'chatbox', 'room', 'area'].includes(call)) return dashboard(call, q, res, who, folders, homes, denied);
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
