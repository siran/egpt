// http.mjs — the website chatbox limb (limbs.http): node:http under a path prefix, one conversation
// per visitor session (conversation_by: identity — per signed identity). It is the "real" bridge behind
// the port adapter (beeper-port.mjs), as telegram.mjs is, so replies leave through the one sender path.
// Inside the spine a chat id is `http:<client>-<sid>`; sid is a hash of the session token, so the
// token (the visitor's credential) never reaches a log, a folder name or a transcript.
//   POST <path>/<client>/messages        {session?, text, id?, identity?} → {session, message}; a repeated id (a retry) gets the first answer;
//                                        {kind: init, session?, identity} → {session} (init: the widget's page load; init: true records
//                                        one line, init: prime also wakes the being so it is warm before the first line)
//   GET  <path>/<client>/messages?session=&since=&identity=   → {session, seq, messages}
//   GET  <path>/<client>/events?session=&since=&identity=     SSE: each message as it is posted, edited, settled
//   POST <path>/<client>/end             {session, identity?} → {ok}: a fresh thread in the same conversation (onEnd), history cleared
//   GET  <path>/<client>/widget.js                  a loader: Deep Chat (DEEP_CHAT) wired to the four above
//   GET  <ayde.path>/                    the Contoso team's read-only browser of EGPT_HOME (ayde.on; http-ayde.mjs), HTTP Basic;
//                                        through the proxy (X-Forwarded-For or Forwarded) only up to ayde.public_max_level (default team)
//   GET  <ayde.path>/logout              401 + a signed-out page whose script overwrites each cached login so the next visit is challenged
// A session's messages (the last LOG_MAX) are kept in <stateDir>/http-messages/<sid>.json, so the
// GET after a restart still returns them.
// identity (per client, off by default): the host page's signed user, base64url(JSON).base64url(HMAC-SHA256);
// a session belongs to the identity it started with, and every call on it must present that identity.
import { createServer } from 'node:http';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { mentionStatus } from '../auto-mode.mjs';
import { stripInvisible } from '../invisible.mjs';
import { createBrowser, checkUser, LEVELS, RESERVED_USER } from './http-ayde.mjs';

export const HTTP_PREFIX = 'http:';
export const isHttpChatId = (id) => String(id ?? '').startsWith(HTTP_PREFIX);
const CHAT_RE = /^http:([a-z0-9][a-z0-9_-]*)-([0-9a-f]{16})$/;
// The client a chatbox chat belongs to, or null.
export const httpClientOf = (chatId) => CHAT_RE.exec(String(chatId ?? ''))?.[1] ?? null;
export const CLIENT_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const HTTP_DEFAULTS = Object.freeze({ path: '/chat', maxChars: 4000, rateMessages: 30, rateMinutes: 10, newSessions: 30, newSessionsMinutes: 60, sessionDays: 365 });
export const HTTP_STRINGS = Object.freeze({
  title: 'Chat', open: 'Abrir chat', close: 'Cerrar', placeholder: 'Escribe tu mensaje…', send: 'Enviar',
  error: 'No se pudo enviar. Intenta de nuevo.', too_long: 'El mensaje es demasiado largo.', too_many: 'Demasiados mensajes. Espera unos minutos.',
  unavailable: 'No se pudo abrir el chat. Intenta de nuevo.',
  identity: 'No pudimos verificar tu sesión. Recarga la página o vuelve a iniciar sesión.',
  end: 'Terminar conversación', end_confirm: '¿Terminar esta conversación? El chat empezará de nuevo.', end_yes: 'Sí, terminar', cancel: 'Cancelar',
  ended: '🔚 El visitante terminó la conversación. Lo siguiente es una conversación nueva.',   // to the team topic
  earlier: '(conversación iniciada antes: {n} mensajes)',   // heads the recap a team topic gets when seated
  intro: '',   // the panel's first line (Deep Chat introMessage), shown again after an end; empty: none
  waiting: [],   // short phrases rotating in the loading bubble instead of ⏳; empty: ⏳
});
const LOG_MAX = 200;                           // messages a session keeps for replay
const RECAP_LINES = 5, RECAP_CHARS = 300;
const RETRY_MS = 10 * 60_000;                  // a POST's id is remembered this long
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PING_MS = 25_000;                        // SSE keep-alive, under common proxy idle timeouts
const SESSIONS_FILE = 'http-sessions.json';
const MESSAGES_DIR = 'http-messages';
const WIDGET_SRC = readFileSync(new URL('./http-widget.js', import.meta.url), 'utf8');
// github.com/OvidijusParsiunas/deep-chat (MIT), 2.5.1 of 2026-08-27; integrity = sha384 of that file.
export const DEEP_CHAT = Object.freeze({
  url: 'https://cdn.jsdelivr.net/npm/deep-chat@2.5.1/dist/deepChat.bundle.js',
  integrity: 'sha384-djz34nrOoloJkHQBH1qoINnqdsX56zqoFpMpT0m3ghPF0o0otOUvWZEFwUViT9iF',
});

const sidOf = (token) => createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);

export const IDENTITY_MODES = Object.freeze(['off', 'optional', 'required']);
export const IDENTITY_CLAIMS = Object.freeze(['abrin', 'username']);   // the default required claims, and the default key
const IDENTITY_MAX = 2048;                     // characters of a signed identity
const IDENTITY_RE = /^([A-Za-z0-9_-]+={0,2})\.([A-Za-z0-9_-]+={0,2})$/;
const FIELD_MAX = 80;
const field = (v) => ((typeof v === 'string' || typeof v === 'number')
  ? [...stripInvisible(String(v)).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, FIELD_MAX).join('')
  : '');
// A signed token's payload object, unexpired, or { why: 'invalid' | 'expired' }.
function signedPayload(token, key, nowMs) {
  const m = typeof token === 'string' && token.length <= IDENTITY_MAX ? IDENTITY_RE.exec(token) : null;
  if (!m) return { why: 'invalid' };
  const want = createHmac('sha256', key).update(m[1]).digest();
  const got = Buffer.from(m[2], 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { why: 'invalid' };
  let p;
  try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return { why: 'invalid' }; }
  if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return { why: 'invalid' };
  if (p.exp * 1000 <= nowMs) return { why: 'expired' };
  return { p };
}
// { identity: {abrin, user_type, short_name, username, user_id?, claims} } or { why: 'invalid' | 'expired' }.
// claims: each string (as field), finite number or boolean claim, exp too; each `required` one non-empty.
export function verifyIdentity(token, key, nowMs = Date.now(), required = IDENTITY_CLAIMS) {
  const { p, why } = signedPayload(token, key, nowMs);
  if (why) return { why };
  const claims = Object.fromEntries(Object.entries(p)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'boolean' || Number.isFinite(v))
    .map(([k, v]) => [k, typeof v === 'string' ? field(v) : v]));
  if (required.some((k) => !field(claims[k]))) return { why: 'invalid' };
  const identity = { abrin: field(p.abrin), user_type: field(p.user_type), short_name: field(p.short_name), username: field(p.username) };
  if (field(p.user_id)) identity.user_id = field(p.user_id);
  identity.claims = claims;
  return { identity };
}
const AYDE_REFUSED = (level) => (level === 'team' ? 'Sign in with your ayde user.' : `This needs the ${level} level: sign in with a ${level} user.`);
const AYDE_LOCKED = 'Too many failed logins. Wait 15 minutes.';
const AYDE_INTERNAL = (level) => `The ${level} level opens only from the internal network.`;
const LOGIN_FAILS = 10, LOGIN_MS = 15 * 60_000;   // failed ayde logins per address in LOGIN_MS → 429 for LOGIN_MS
// A signed identity's key: a hash of its client's key claims (default abrin + username); null when unsigned.
const whoOf = (c, identity) => (identity ? createHash('sha256').update(JSON.stringify(c.key.map((k) => field(identity.claims[k])))).digest('hex').slice(0, 16) : null);

// A team topic's name: {abrin} {user_type} {short_name} {username} {title} {sid}, or any other value given
// (boot: the identity's claims); a missing value is empty, spaces collapse, empty brackets go. Nothing
// left: the default. At most Telegram's 128.
export const DEFAULT_TOPIC_TITLE = '{title} · {sid}';
export const TOPIC_TITLE_MAX = 128;
const TITLE_KEYS = ['abrin', 'user_type', 'short_name', 'username', 'title', 'sid'];
export function renderTopicTitle(template, values = {}) {
  const fill = (t) => t.replace(/\{(\w+)\}/g, (all, k) => (TITLE_KEYS.includes(k) || Object.hasOwn(values, k) ? field(values[k]) : all))
    .replace(/\(\s*\)|\[\s*\]/g, '').replace(/\s+/g, ' ').trim();
  const out = (typeof template === 'string' && fill(template)) || fill(DEFAULT_TOPIC_TITLE);
  if (out.length <= TOPIC_TITLE_MAX) return out;
  let cut = '';
  for (const ch of out) { if (cut.length + ch.length > TOPIC_TITLE_MAX - 1) break; cut += ch; }
  return `${cut}…`;
}

// A client's identity mode: `identity: <mode>`, or the mode of `identity: { mode, required, key }` (default
// required); not a mode: null.
export const identityModeOf = (v) => {
  const mode = isMap(v) ? v.mode ?? 'required' : v;
  return mode == null || mode === false ? 'off' : IDENTITY_MODES.includes(mode) ? mode : null;
};
const HOUR_MS = 3600_000;
const PRIME_GAP_MS = 4 * 60_000;   // a conversation warmed (primed or spoken to) this recently skips the prime: under the 5-minute prompt-cache lifetime
const PLACE_CSS_MAX = 20000;

function clientConfig(name, c = {}) {
  const strings = { ...HTTP_STRINGS, ...(c.strings && typeof c.strings === 'object' ? c.strings : {}), ...(c.title ? { title: String(c.title) } : {}) };
  strings.waiting = (Array.isArray(strings.waiting) ? strings.waiting : []).filter((w) => typeof w === 'string' && w.trim()).slice(0, 12).map((w) => w.trim().slice(0, 80));
  const maxChars = posInt(c.max_chars, HTTP_DEFAULTS.maxChars);
  const idc = isMap(c.identity) ? c.identity : {};
  const key = Array.isArray(idc.key) && idc.key.length ? idc.key.map(String) : IDENTITY_CLAIMS;
  const init = c.init === true || c.init === 'prime' ? c.init : false;   // prime: the init line wakes the being, true: record only
  const places = {};   // where the host page is: { <name>: { user_strip, css } }; the widget gets them as they are
  for (const [k, v] of Object.entries(isMap(c.places) ? c.places : {})) {
    if (CLIENT_RE.test(k) && isMap(v)) places[k] = { user_strip: v.user_strip === true, css: typeof v.css === 'string' ? v.css.slice(0, PLACE_CSS_MAX) : '' };
  }
  return {
    name,
    places,
    label: String(c.label ?? '').trim() || String(c.title ?? '').trim() || name,   // its section in /ayde
    being: c.being ? String(c.being) : null,
    origins: Array.isArray(c.allowed_origins) ? c.allowed_origins.map(String) : [],
    maxChars,
    rateMessages: posInt(c.rate?.messages, HTTP_DEFAULTS.rateMessages),
    rateMs: posInt(c.rate?.minutes, HTTP_DEFAULTS.rateMinutes) * 60_000,
    newCount: posInt(c.new_sessions?.count, HTTP_DEFAULTS.newSessions),
    newMs: posInt(c.new_sessions?.minutes, HTTP_DEFAULTS.newSessionsMinutes) * 60_000,
    idleMs: posInt(c.session_days, HTTP_DEFAULTS.sessionDays) * 24 * 3600_000,   // an idle session past this is expired: its token starts a new one
    identity: identityModeOf(c.identity),
    required: [...new Set([...(Array.isArray(idc.required) ? idc.required.map(String) : IDENTITY_CLAIMS), ...key])],   // a key claim is required too
    key,
    byIdentity: c.conversation_by === 'identity',   // one conversation per signed identity, not per session
    identityTurns: posInt(c.rate?.turns_per_identity_per_hour, 0),   // 0: no per-identity budget
    init,
    identityText: strings.identity,
    ended: strings.ended,
    earlier: strings.earlier,
    widget: `(${WIDGET_SRC.trim()})(${JSON.stringify({ client: name, maxChars, strings, deepChat: DEEP_CHAT, ...(init ? { init } : {}), ...(Object.keys(places).length ? { places } : {}) })});\n`,
  };
}

// THE CHATBOXES OF A CONFIG, { <client>: its limbs.http.clients-shaped config }: the one reader of
// limbs.http.clients and limbs.http.chatboxes, what boot serves and reads. limbs.http.chatboxes names
// top-level blocks, one chatbox each: a clients entry's keys, its UI strings (HTTP_STRINGS) flat beside
// them, beating a `strings:` map there (`identity` is the mode; its text stays in strings:). Its client,
// in the URL and the chat ids, is its `url`, default its name. A block beats a clients entry of the
// same client; a name with no block (a map) is skipped. Both logged.
const FLAT_STRINGS = Object.keys(HTTP_STRINGS).filter((k) => k !== 'title' && k !== 'identity');
const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
export const chatboxNames = (cfg) => (Array.isArray(cfg?.limbs?.http?.chatboxes) ? cfg.limbs.http.chatboxes.map(String) : []);
export function chatboxesOf(cfg, log = () => {}) {
  const http = cfg?.limbs?.http;
  if (http?.chatboxes != null && !Array.isArray(http.chatboxes)) log('limbs.http.chatboxes is not a list of block names — ignored');
  const out = {}, blockOf = {};
  for (const name of chatboxNames(cfg)) {
    if (!isMap(cfg[name])) { log(`limbs.http.chatboxes names ${name}, but there is no ${name}: block — skipped`); continue; }
    const { url, strings, ...keys } = cfg[name];
    const client = url == null ? name : String(url);
    if (blockOf[client]) { log(`the ${name}: block's url '${client}' is the ${blockOf[client]}: block's too — skipped`); continue; }
    blockOf[client] = name;
    const own = {}, flat = {};
    for (const [k, v] of Object.entries(keys)) (FLAT_STRINGS.includes(k) ? flat : own)[k] = v;
    out[client] = { ...own, strings: { ...(isMap(strings) ? strings : {}), ...flat } };
  }
  for (const [client, c] of Object.entries(isMap(http?.clients) ? http.clients : {})) {
    if (blockOf[client]) log(`limbs.http.clients.${client} and the ${blockOf[client]}: block are both chatbox '${client}' — the block wins`);
    else out[client] = c;
  }
  return out;
}

export async function startHttpBridge({
  bind = '127.0.0.1',
  port,
  path = HTTP_DEFAULTS.path,
  clients: clientsCfg = {},   // chatboxesOf(config)
  wakeWords,
  addressWithoutAt = true,
  trustProxy = false,      // the visitor's address: the last X-Forwarded-For entry, else the socket's
  stateDir = null,
  beforeLine = null,      // ({ client, chatId, isNew, recap }), awaited before each line enters; recap() → the panel's lines so far as text, or null
  onEnd = null,           // ({ client, chatId, ended }), awaited by POST end before the history is cleared
  identityKey = () => null,   // (client) → its HMAC key, or null
  ayde = null,                // { path, on, public_max_level, scope }: /ayde, the team's browser of aydeRoot
  aydeRoot = null,            // EGPT_HOME
  aydeUsers = () => null,     // () → secrets/ayde.users' text, or null; asked on each request
  aydeRegistry = async () => null,   // () → the conversations registry (conversations.yaml): ayde.scope's chat ids → folders; asked on each request
  onIncoming,
  onLog: log = () => {},   // boot tags each line [http]
  now = () => Date.now(),
} = {}) {
  const base = `/${String(path ?? '').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  const clients = new Map();
  for (const [name, c] of Object.entries(clientsCfg && typeof clientsCfg === 'object' ? clientsCfg : {})) {
    if (!CLIENT_RE.test(name)) { log(`client '${name}' skipped — a client name is lowercase letters, digits, - and _`); continue; }
    const cc = clientConfig(name, c);
    if (!cc.identity) { log(`${name}: identity '${isMap(c.identity) ? c.identity.mode : c.identity}' is not ${IDENTITY_MODES.join(' | ')} — treated as required`); cc.identity = 'required'; }
    if (c.conversation_by != null && !['session', 'identity'].includes(c.conversation_by)) log(`${name}: conversation_by '${c.conversation_by}' is not session | identity — session`);
    if ((cc.byIdentity || cc.init) && cc.identity === 'off') log(`${name}: ${cc.init ? 'init' : 'conversation_by: identity'} needs identity optional | required — it is off`);
    clients.set(name, cc);
  }
  let aydeBase = ayde && (ayde.on === true || ayde.on === 'on') && aydeRoot ? `/${String(ayde.path ?? '/ayde').replace(/^\/+|\/+$/g, '')}/` : null;
  if (aydeBase && (aydeBase === '//' || aydeBase.startsWith(base) || base.startsWith(aydeBase))) { log(`ayde off — its path ${aydeBase} overlaps the chatbox's ${base}`); aydeBase = null; }
  let aydeCap = ayde?.public_max_level ?? 'team';   // the highest level a public request opens
  if (aydeBase && !LEVELS.includes(aydeCap)) { log(`ayde: public_max_level '${aydeCap}' is not ${LEVELS.join(' | ')} — treated as team`); aydeCap = 'team'; }

  // sid → { sid, client, lastAt, who, posts, chat }; client + lastAt + who persist across restarts.
  // who: whoOf the identity the session started with, null when unsigned.
  // chat: its conversation's panel, { key, client, log, subs }, the log in its own file. key is the sid; with
  // conversation_by: identity a signed session's is its identity's, so that identity's sessions share one.
  const sessions = new Map(), chats = new Map();
  const sessionsPath = stateDir ? join(stateDir, SESSIONS_FILE) : null;
  const messagesDir = stateDir ? join(stateDir, MESSAGES_DIR) : null;
  const logPath = (key) => join(messagesDir, `${key}.json`);
  const live = (s, n = now()) => !!s && n - s.lastAt < (clients.get(s.client)?.idleMs ?? 0);
  const chatKeyOf = (client, sid, who) => (who && clients.get(client)?.byIdentity ? createHash('sha256').update(JSON.stringify([client, who])).digest('hex').slice(0, 16) : sid);
  const fresh = (client, lastAt, sid, log = [], who = null) => {
    const key = chatKeyOf(client, sid, who);
    if (!chats.has(key)) chats.set(key, { key, client, log, subs: new Set() });
    return { sid, client, lastAt, who, posts: [], chat: chats.get(key) };
  };
  // A reply cut by the restart is settled as it stood. No file: null.
  const readLog = async (key) => {
    try { return JSON.parse(await readFile(logPath(key), 'utf8')).slice(-LOG_MAX).map((m) => ({ ...m, done: true })); }
    catch (e) { if (e?.code === 'ENOENT') return null; log(`${logPath(key)} unreadable (${e?.message ?? e}) — that conversation starts with no history`); return []; }
  };
  if (sessionsPath) {
    try {
      const saved = JSON.parse(await readFile(sessionsPath, 'utf8'));
      for (const [sid, s] of Object.entries(saved ?? {})) {
        if (!clients.has(s?.client) || !live(s)) continue;
        const key = chatKeyOf(s.client, sid, s.who ?? null);
        const said = chats.has(key) ? [] : await readLog(key);
        sessions.set(sid, fresh(s.client, s.lastAt, sid, said ?? [], s.who ?? null));
        if (said === null && key !== sid) chats.get(key).isNew = true;   // conversation_by: identity switched on: its next line starts it
      }
    } catch (e) { if (e?.code !== 'ENOENT') log(`${sessionsPath} unreadable (${e?.message ?? e}) — starting with no sessions`); }
    for (const f of await readdir(messagesDir).catch(() => [])) {
      if (!chats.has(f.replace(/\.json$/, ''))) await unlink(join(messagesDir, f)).catch((e) => log(`could not remove ${f} — ${e?.message ?? e}`));
    }
  }
  // Every state write goes through one chain. A change rewrites its conversation's file; changes made
  // before that write starts ride along in it.
  let saving = Promise.resolve();
  const saveLog = (chat) => {
    if (!messagesDir || chat.dirty) return;
    chat.dirty = true;
    const file = logPath(chat.key);
    saving = saving.then(async () => {
      chat.dirty = false;
      await mkdir(messagesDir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(chat.log), 'utf8');
      await rename(`${file}.tmp`, file);
    }).catch((e) => log(`could not save ${file} — ${e?.message ?? e}`));
  };
  // A session goes; its conversation's panel with its last session.
  const forget = (sid) => {
    const { chat } = sessions.get(sid);
    sessions.delete(sid);
    if ([...sessions.values()].some((s) => s.chat === chat)) return;
    chats.delete(chat.key);
    if (messagesDir) saving = saving.then(() => unlink(logPath(chat.key))).catch((e) => { if (e?.code !== 'ENOENT') log(`could not remove ${logPath(chat.key)} — ${e?.message ?? e}`); });
  };
  const persist = () => {
    if (!sessionsPath) return;
    const n = now();
    const out = {};
    for (const [sid, s] of sessions) {
      if (live(s, n)) out[sid] = { client: s.client, lastAt: s.lastAt, ...(s.who ? { who: s.who } : {}) };
      else if (!s.chat.subs.size) forget(sid);
    }
    saving = saving.then(() => mkdir(stateDir, { recursive: true }).then(() => writeFile(sessionsPath, JSON.stringify(out), 'utf8')))
      .catch((e) => log(`could not save ${sessionsPath} — ${e?.message ?? e}`));
  };

  // One clock for ids and cursors: increasing, and past every value from before a restart.
  let tick = 0;
  for (const chat of chats.values()) for (const m of chat.log) tick = Math.max(tick, m.seq);
  const nextTick = () => (tick = Math.max(tick + 1, now()));
  const put = (res, chunk) => { if (!res.writableEnded) res.write(chunk); };
  const view = (m) => ({ id: m.id, from: m.from, text: m.text, done: m.done, seq: m.seq });
  // Each frame goes to every open stream of the conversation: each tab of each of its sessions.
  const changed = (chat, m) => {
    if (m.ended) return;   // cleared by an end: a reply still streaming stays out of the fresh panel
    m.seq = nextTick();
    m.id ??= String(m.seq);
    const frame = `id: ${m.seq}\ndata: ${JSON.stringify(view(m))}\n\n`;
    for (const res of chat.subs) put(res, frame);
    saveLog(chat);
  };
  const append = (chat, from, text, done) => {
    const m = { id: null, from, text, done, seq: 0 };
    changed(chat, m);
    chat.log.push(m);
    if (chat.log.length > LOG_MAX) chat.log.splice(0, chat.log.length - LOG_MAX);
    return m;
  };
  const chatIdOf = (chat) => `${HTTP_PREFIX}${chat.client}-${chat.key}`;
  const chatOf = (chatId) => {
    const hit = CHAT_RE.exec(String(chatId ?? ''));
    const chat = hit && chats.get(hit[2]);
    return chat && chat.client === hit[1] ? chat : null;
  };
  const ownMessage = (chat, msgId) => chat?.log.find((m) => m.id === String(msgId) && m.from === 'being') ?? null;
  // A known, unexpired token of this client → its session; else null.
  const sessionOfToken = (c, token) => {
    if (typeof token !== 'string' || !token || token.length > 200) return null;
    const sid = sidOf(token);
    const s = sessions.get(sid);
    if (s?.client !== c.name) return null;
    if (live(s)) return { sid, s };
    forget(sid);
    return null;
  };
  // The request's identity: { identity } (null when unsigned and allowed), else { status, error } to refuse.
  const identityOf = (c, token) => {
    if (c.identity === 'off') return { identity: null };
    if (token == null || token === '') return c.identity === 'required' ? { status: 401, error: 'identity required' } : { identity: null };
    const key = identityKey(c.name);
    if (!key) { log(`${c.name}: a signed visitor refused — no key for this client`); return { status: 503, error: 'identity unavailable' }; }
    const r = verifyIdentity(token, key, now(), c.required);
    if (r.why) { log(`${c.name}: an ${r.why} identity refused`); return { status: 401, error: `identity ${r.why}` }; }
    return r;
  };
  const refuse = (c, res, idn, cors) => json(res, idn.status, { error: idn.error, ...(idn.status === 401 ? { message: c.identityText } : {}) }, cors);
  // A read's or an end's session: only with the identity it started with.
  const ownSession = (c, token, idn) => {
    const hit = sessionOfToken(c, token);
    return hit && (c.identity === 'off' || hit.s.who === whoOf(c, idn.identity)) ? hit : null;
  };

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const browser = aydeBase ? createBrowser({
    root: aydeRoot, json, log, now, scope: ayde.scope, registry: aydeRegistry, messagesDir,
    clients: [...clients.values()].map(({ name, label }) => ({ name, label })),
  }) : null;
  const readBody = (req, limit) => new Promise((resolve, reject) => {
    let size = 0, over = false;
    const parts = [];
    req.on('data', (b) => { size += b.length; if (size > limit) over = true; else parts.push(b); });
    req.on('end', () => resolve(over ? null : Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
  const failures = new Map();
  const deliver = (body, from) => {
    try { Promise.resolve(onIncoming?.(body, from)).catch((e) => log(`onIncoming threw — ${e?.message ?? e}`)); }
    catch (e) { log(`onIncoming threw — ${e?.message ?? e}`); }
  };

  const opened = new Map();   // `<client> <address>` → when it opened new sessions, within the window
  const turns = new Map();    // `<client> <who>` → its lines' times within the hour (rate.turns_per_identity_per_hour)
  const posted = new Map();   // `<client> <id>` → { at, reply }: a retried POST gets the first one's answer
  // Seconds until this session may post again (its window pruned), or 0.
  const rateWait = (c, s, n) => {
    s.posts = s.posts.filter((t) => n - t < c.rateMs);
    return s.posts.length >= c.rateMessages ? Math.ceil((s.posts[0] + c.rateMs - n) / 1000) : 0;
  };
  // The panel's settled lines so far, for a team topic seated after them: their count, then the last few.
  const recapOf = (c, chat, { header = true } = {}) => {
    const said = chat.log.filter((m) => m.done && m.text);
    if (!said.length) return null;
    const clip = (t) => ([...t].length > RECAP_CHARS ? `${[...t].slice(0, RECAP_CHARS).join('')}…` : t);
    return [...(header ? [c.earlier.replaceAll('{n}', String(said.length))] : []), ...said.slice(-RECAP_LINES).map((m) => `${m.from === 'visitor' ? 'visitor' : c.being}: ${clip(m.text)}`)].join('\n');
  };
  const addressOf = (req) => (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',').map((a) => a.trim()).filter(Boolean).at(-1)) || req.socket.remoteAddress;

  // The prime: a wake no person typed, so the being's process and prompt cache are warm before the first line.
  const prime = async (c, s, idn, { place, isNew }) => {
    s.chat.warmAt = now();
    const chatId = chatIdOf(s.chat), name = `${c.name}-${s.chat.key}`;
    try { await beforeLine?.({ client: c.name, chatId, isNew, init: true, recap: (o) => recapOf(c, s.chat, o), identity: idn.identity }); }
    catch (e) { log(`${name}: before the line — ${e?.message ?? e}`); }
    log(`incoming [${name}] the visitor opened the chatbox`);
    deliver(`(opened the chatbox${place ? ` in ${place}` : ''}, signed in as ${JSON.stringify({ ...idn.identity.claims, exp: undefined })}; nothing to answer yet — answer … alone)`, {
      chatId, chatName: name, chatType: 'private', network: 'http',
      userId: chatId, senderName: 'visitor', firstName: 'visitor',
      isSender: false, authorized: false,
      backlog: false, prime: true, replyToBot: !!c.being, replyToBeing: c.being, isReaction: false, isTranscriptFromVoice: false,
      msgKey: String(nextTick()), msgTs: now(),
    });
  };

  async function post(c, req, res, cors) {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return json(res, 415, { error: 'send application/json' }, cors);
    const raw = await readBody(req, c.maxChars * 4 + 1024 + IDENTITY_MAX);
    if (raw == null) return json(res, 413, { error: 'too long', max_chars: c.maxChars }, cors);
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'not JSON' }, cors); }
    // init (c.init): the widget's page load. A session as for a line; a new one's single transcript line
    // names its verified claims, recorded and never dispatched (backlog); init: prime delivers it as a wake
    // instead, so the being's process starts before the person types. Nothing on the panel.
    const init = c.init && body?.kind === 'init';
    const text = init ? '' : stripInvisible(String(body?.text ?? ''));
    if (!init && !text.trim()) return json(res, 400, { error: 'empty message' }, cors);
    if ([...text].length > c.maxChars) return json(res, 413, { error: 'too long', max_chars: c.maxChars }, cors);
    // place: the page's own name for where it is; only a configured one counts, a stale page keeps chatting
    const place = typeof body?.place === 'string' && Object.hasOwn(c.places, body.place) ? body.place : null;
    if (body?.place != null && !place) log(`${c.name}: place '${String(body.place).slice(0, 40)}' is not configured — no place`);
    const idn = identityOf(c, body?.identity);
    if (idn.status) return refuse(c, res, idn, cors);
    if (init && !idn.identity) return refuse(c, res, { status: 401, error: 'identity required' }, cors);
    const who = whoOf(c, idn.identity);
    const key = typeof body?.id === 'string' && ID_RE.test(body.id) ? `${c.name} ${body.id}` : null;
    if (key && posted.has(key)) return json(res, 200, await posted.get(key).reply, cors);
    const n = now();
    const budget = !init && c.identityTurns && who ? `${c.name} ${who}` : null;
    const spent = budget ? (turns.get(budget) ?? []).filter((t) => n - t < HOUR_MS) : [];
    if (budget && spent.length >= c.identityTurns) {
      const wait = Math.ceil((spent[0] + HOUR_MS - n) / 1000);
      log(`${c.name}: a line refused — ${c.identityTurns} already from one identity in 60 min`);
      return json(res, 429, { error: 'too many messages from this identity', retry_after_s: wait }, { ...cors, 'Retry-After': String(wait) });
    }
    let token = body?.session, hit = sessionOfToken(c, token);
    if (hit && c.identity !== 'off' && hit.s.who !== who) { log(`${c.name}-${hit.sid}: another identity — a new session`); hit = null; }
    if (hit) {
      const wait = init ? 0 : rateWait(c, hit.s, n);
      if (wait) return json(res, 429, { error: 'too many messages', retry_after_s: wait }, { ...cors, 'Retry-After': String(wait) });
    } else {
      const key = `${c.name} ${addressOf(req)}`;
      const times = (opened.get(key) ?? []).filter((t) => n - t < c.newMs);
      if (times.length >= c.newCount) {
        const wait = Math.ceil((times[0] + c.newMs - n) / 1000);
        log(`${c.name}: a new session refused — ${c.newCount} already opened from one address in ${c.newMs / 60_000} min`);
        return json(res, 429, { error: 'too many new sessions', retry_after_s: wait }, { ...cors, 'Retry-After': String(wait) });
      }
      opened.set(key, [...times, n]);
      do token = randomBytes(24).toString('base64url'); while (sessions.has(sidOf(token)));
      const sid = sidOf(token);
      hit = { sid, isNew: !chats.has(chatKeyOf(c.name, sid, who)), started: true };   // isNew: a new conversation
      hit.s = fresh(c.name, n, sid, [], who);
      sessions.set(sid, hit.s);
      log(`new session ${c.name}-${sid}`);
    }
    const { sid, s } = hit;
    const chatId = chatIdOf(s.chat), name = `${c.name}-${s.chat.key}`;
    if (!init) { s.posts.push(n); s.chat.warmAt = n; }
    if (budget) turns.set(budget, [...spent, n]);
    s.lastAt = n;
    persist();
    // a reload or another tab: resumed, nothing recorded; init: prime wakes it again unless it is still warm
    if (init && (c.init === 'prime' ? n - (s.chat.warmAt ?? -Infinity) < PRIME_GAP_MS : !hit.started)) return json(res, 200, { session: token }, cors);
    const isNew = !!(hit.isNew || s.chat.isNew);
    s.chat.isNew = false;
    if (init && c.init === 'prime') { await prime(c, s, idn, { place, isNew }); return json(res, 200, { session: token }, cors); }
    const reply = (async () => {
      try { await beforeLine?.({ client: c.name, chatId, isNew, init, recap: (o) => recapOf(c, s.chat, o), identity: idn.identity }); }
      catch (e) { log(`${c.name}-${sid}: before the line — ${e?.message ?? e}`); }
      const m = init ? { id: String(nextTick()) } : append(s.chat, 'visitor', text, true);
      const st = init ? {} : mentionStatus(text, wakeWords, { addressWithoutAt });
      log(init ? `incoming [${name}] the visitor opened the chatbox` : `incoming [${name}] visitor: ${JSON.stringify(text.slice(0, 60))}`);
      deliver(init ? `(opened the chatbox${place ? ` in ${place}` : ''}, signed in as ${JSON.stringify({ ...idn.identity.claims, exp: undefined })})` : place ? `(in ${place}) ${text}` : text, {
        chatId, chatName: name, chatType: 'private', network: 'http',
        userId: chatId, senderName: 'visitor', firstName: 'visitor',
        isSender: false, authorized: false,   // a visitor is a stranger by design; the conversation's allowed_users admits it
        atEStart: st.atEStart, atEAnywhere: st.atEAnywhere,
        // the widget is a reply thread with the client's being: every visitor line addresses it; an init's is on the record only
        backlog: init, prime: false, replyToBot: !!c.being, replyToBeing: c.being, isReaction: false, isTranscriptFromVoice: false,
        msgKey: m.id, msgTs: n,
      });
      return init ? { session: token } : { session: token, message: view(m) };
    })();
    if (key) { posted.set(key, { at: n, reply }); reply.catch(() => posted.delete(key)); }
    return json(res, 200, await reply, cors);
  }

  // The visitor's "end conversation": the same session, token and conversation; onEnd gives it a
  // fresh thread, then the panel's history is cleared. Nothing said since the last end: nothing to do.
  async function end(c, req, res, cors) {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return json(res, 415, { error: 'send application/json' }, cors);
    const raw = await readBody(req, 1024 + IDENTITY_MAX);
    if (raw == null) return json(res, 413, { error: 'too long' }, cors);
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'not JSON' }, cors); }
    const idn = identityOf(c, body?.identity);
    if (idn.status) return refuse(c, res, idn, cors);
    const hit = ownSession(c, body?.session, idn);
    if (!hit) return json(res, 404, { error: 'unknown session' }, cors);
    const { sid, s } = hit;
    const n = now(), wait = rateWait(c, s, n);
    if (wait) return json(res, 429, { error: 'too many messages', retry_after_s: wait }, { ...cors, 'Retry-After': String(wait) });
    s.lastAt = n;
    persist();
    if (!s.chat.log.length) return json(res, 200, { ok: true }, cors);
    s.posts.push(n);
    try { await onEnd?.({ client: c.name, chatId: chatIdOf(s.chat), ended: c.ended }); }
    catch (e) { log(`end ${c.name}-${sid}: ${e?.message ?? e}`); return json(res, 500, { error: 'could not end the conversation' }, cors); }
    for (const m of s.chat.log) m.ended = true;
    s.chat.log = [];
    saveLog(s.chat);
    log(`${c.name}-${sid}: the visitor ended the conversation`);
    if (c.init === 'prime' && idn.identity) await prime(c, s, idn, { place: null, isNew: false });   // a fresh thread is a cold one
    return json(res, 200, { ok: true }, cors);
  }

  const since = (req, url) => Number(req.headers['last-event-id'] ?? url.searchParams.get('since')) || 0;
  function list(c, req, res, url, cors) {
    const idn = identityOf(c, url.searchParams.get('identity'));
    if (idn.status) return refuse(c, res, idn, cors);
    const hit = ownSession(c, url.searchParams.get('session'), idn);
    if (!hit) return json(res, 404, { error: 'unknown session' }, cors);
    const after = since(req, url);
    const messages = hit.s.chat.log.filter((m) => m.seq > after).map(view);
    return json(res, 200, { session: url.searchParams.get('session'), seq: Math.max(after, ...hit.s.chat.log.map((m) => m.seq)), messages }, cors);
  }
  function events(c, req, res, url, cors) {
    const idn = identityOf(c, url.searchParams.get('identity'));
    if (idn.status) return refuse(c, res, idn, cors);
    const hit = ownSession(c, url.searchParams.get('session'), idn);
    if (!hit) return json(res, 404, { error: 'unknown session' }, cors);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...cors });
    res.write('retry: 3000\n\n');
    const after = since(req, url);
    const { chat } = hit.s;
    for (const m of chat.log) if (m.seq > after) res.write(`id: ${m.seq}\ndata: ${JSON.stringify(view(m))}\n\n`);
    chat.subs.add(res);
    res.on('close', () => chat.subs.delete(res));
  }

  // /ayde (http-ayde.mjs): off or no users file → 404. GET only, no CORS. HTTP Basic against the users
  // file; the browser decides the level a request needs and answers 401 in that level's realm.
  // LOGIN_FAILS failed logins from one address: 429 for LOGIN_MS. logout comes first: always its 401, never a
  // failed login, never locked out.
  // A request with X-Forwarded-For or Forwarded is public (the site's proxy always adds one; a forged one
  // only lowers its sender's reach): a right login above aydeCap is 403 (a 401 would prompt again), not a
  // failed login. Only a right password learns that, so a wrong one reveals no level.
  const logins = new Map();   // address → { times, until }: its failed logins
  async function aydeServe(req, res, url, sub) {
    const users = aydeUsers();
    if (!users || sub.length > 1) return json(res, 404, { error: 'not found' });
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
    if (!sub.length) { res.writeHead(308, { Location: `${aydeBase.split('/').at(-2)}/${url.search}` }); return res.end(); }
    const call = sub[0] || null;
    const basic = /^Basic\s+(\S*)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const [user, ...rest] = basic == null ? [] : Buffer.from(basic, 'base64').toString('utf8').split(':');
    // The sign-out page's overwrite probe (reserved logout user), never a person: never granted, never
    // counted — so it precedes the lockout and the password check.
    if (field(user) === RESERVED_USER) {
      if (call === 'logout' && url.searchParams.has('realm')) return browser.overwrite(res, url.searchParams.get('realm'));
      return browser.signOut(res, RESERVED_USER);
    }
    if (call === 'logout') return browser.signOut(res, field(user));
    const deny = (status, message, headers, more = {}) => {
      if (call) return json(res, status, { error: status === 429 ? 'too many failed logins' : status === 403 ? 'forbidden' : 'unauthorized', message, ...more }, headers);
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers });
      return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>ayde</title><p>${message}</p></html>\n`);
    };
    const addr = addressOf(req), n = now();
    const rec = logins.get(addr) ?? { times: [], until: 0 };
    if (rec.until > n) {
      const wait = Math.ceil((rec.until - n) / 1000);
      return deny(429, AYDE_LOCKED, { 'Retry-After': String(wait) }, { retry_after_s: wait });
    }
    let who = null;
    if (basic != null) {
      // Counted before the slow check, so tries sent in parallel count too; a right one clears the count.
      rec.times = [...rec.times.filter((t) => n - t < LOGIN_MS), n];
      const tries = rec.times.length;
      if (tries >= LOGIN_FAILS) rec.until = n + LOGIN_MS;
      logins.set(addr, rec);
      const level = await checkUser(users, user, rest.join(':'));
      if (level) { logins.delete(addr); who = { user, level }; }
      else {
        log(`ayde: login refused for ${JSON.stringify(field(user))} from ${addr} (${tries}/${LOGIN_FAILS})`);
        if (tries >= LOGIN_FAILS) log(`ayde: ${addr} locked out for ${LOGIN_MS / 60_000} min`);
      }
    }
    if (who && (req.headers['x-forwarded-for'] != null || req.headers.forwarded != null) && LEVELS.indexOf(who.level) > LEVELS.indexOf(aydeCap)) {
      log(`ayde: ${field(who.user)} (${who.level}) refused from ${addr} — the ${who.level} level opens only from the internal network (public_max_level: ${aydeCap})`);
      return deny(403, AYDE_INTERNAL(who.level), {});
    }
    return browser.serve(call, req, res, url, who, (level) => deny(401, AYDE_REFUSED(level), { 'WWW-Authenticate': `Basic realm="ayde ${level}", charset="UTF-8"` }, { level }));
  }

  // CORS: an Origin must be on the client's list; an empty list sends no CORS headers (same-origin
  // only — the website's server proxies the path) and refuses every preflight.
  async function serve(req, res) {
    const url = new URL(req.url, 'http://chatbox');
    if (aydeBase && `${url.pathname}/` === aydeBase) return aydeServe(req, res, url, []);
    if (aydeBase && url.pathname.startsWith(aydeBase)) return aydeServe(req, res, url, url.pathname.slice(aydeBase.length).split('/'));
    if (!url.pathname.startsWith(base)) return json(res, 404, { error: 'not found' });
    const [name, action, ...more] = url.pathname.slice(base.length).split('/');
    const c = clients.get(name);
    if (!c || more.length) return json(res, 404, { error: 'not found' });
    const origin = req.headers.origin;
    const listed = !!origin && c.origins.includes(origin);
    if (origin && c.origins.length && !listed) return json(res, 403, { error: 'origin not allowed' });
    const cors = listed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      if (!listed) return json(res, 403, { error: 'origin not allowed' });
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    const route = `${req.method} ${action}`;
    if (route === 'POST messages') return post(c, req, res, cors);
    if (route === 'GET messages') return list(c, req, res, url, cors);
    if (route === 'GET events') return events(c, req, res, url, cors);
    if (route === 'POST end') return end(c, req, res, cors);
    if (route === 'GET widget.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=300', ...cors });
      return res.end(c.widget);
    }
    const known = ['messages', 'events', 'end', 'widget.js'].includes(action);
    return json(res, known ? 405 : 404, { error: known ? 'method not allowed' : 'not found' }, cors);
  }

  let alive = false, stopped = false;
  const server = createServer((req, res) => {
    serve(req, res).catch((e) => {
      log(`${req.method} ${req.url?.split('?')[0]} failed — ${e?.message ?? e}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' }); else res.end();
    });
  });
  const startupReady = !Number.isInteger(port)
    ? (log('no port — limb inert'), Promise.resolve(false))
    : new Promise((resolve) => {
      server.once('error', (e) => { log(`cannot listen on ${bind}:${port} — ${e?.message ?? e}; limb inert`); resolve(false); });
      server.listen(port, bind, () => {
        alive = true;
        server.on('error', (e) => log(`server error — ${e?.message ?? e}`));
        log(`listening on http://${bind}:${port}${base}<client>/ — clients: ${[...clients.keys()].join(', ') || 'none'}${aydeBase ? `; ayde at ${aydeBase}` : ''}`);
        resolve(true);
      });
    });
  await startupReady;
  const windowMs = Math.max(0, ...[...clients.values()].map((c) => c.newMs));
  const ping = setInterval(() => {
    for (const chat of chats.values()) for (const res of chat.subs) put(res, ': ping\n\n');
    const n = now();
    for (const [key, times] of opened) if (n - times.at(-1) >= windowMs) opened.delete(key);
    for (const [key, times] of turns) if (n - times.at(-1) >= HOUR_MS) turns.delete(key);
    for (const [key, p] of posted) if (n - p.at >= RETRY_MS) posted.delete(key);
    for (const [key, r] of logins) if (r.until <= n && r.times.every((t) => n - t >= LOGIN_MS)) logins.delete(key);
  }, PING_MS);
  ping.unref?.();

  // --- outbound (the port's interface, as telegram.mjs) ---
  async function send(text, { chatId } = {}) {
    const chat = chatOf(chatId);
    if (!chat) { failures.set(chatId, 'no live chatbox session'); log(`send refused — ${chatId} is not a live chatbox session`); return null; }
    text = stripInvisible(text);
    if (!text.trim()) return null;
    const m = append(chat, 'being', text, true);
    failures.delete(chatId);
    return { messageId: m.id, confirmedId: m.id };
  }
  function editMessage(chatId, msgId, text) {
    const chat = chatOf(chatId);
    const m = ownMessage(chat, msgId);
    if (!m) return false;
    m.text = stripInvisible(text);
    changed(chat, m);
    return true;
  }
  // The placeholder at once, each update an edit, the final text in the same message (done).
  function startStreamMessage(initialText, { chatId, existingMsgId = null } = {}) {
    const chat = chatOf(chatId);
    let m = existingMsgId != null ? ownMessage(chat, existingMsgId) : null;
    let finished = false;
    const h = { delivered: false, lastError: null, get confirmedId() { return m ? m.id : null; } };
    if (!chat) h.lastError = 'no live chatbox session';
    else if (m) { m.text = stripInvisible(initialText); m.done = false; changed(chat, m); }
    else m = append(chat, 'being', stripInvisible(initialText), false);
    h.update = (t) => { if (finished || !t || !m) return; m.text = stripInvisible(t); changed(chat, m); };
    h.finish = async (t) => {
      if (finished) return;
      finished = true;
      if (!m) return;
      if (t) m.text = stripInvisible(t);
      m.done = true;
      changed(chat, m);
      h.delivered = true;
    };
    h.fail = (e) => { finished = true; h.lastError = e?.message ?? String(e); log(`stream fail — ${h.lastError}`); };
    return h;
  }

  return {
    startupReady,
    visibleOnly: true,   // read by the port (beeper-port.mjs): a web page gets no invisible frame
    send,
    async sendAndGetId(text, { chatId } = {}) { return (await send(text, { chatId }))?.messageId ?? null; },
    editMessage,
    startStreamMessage,
    wasSentByUs: (chatId, msgId) => !!ownMessage(chatOf(chatId), msgId),
    sendFailure: (chatId) => failures.get(chatId) ?? null,
    getChatName: (chatId) => { const hit = CHAT_RE.exec(String(chatId ?? '')); return hit ? `${hit[1]}-${hit[2]}` : null; },
    isAlive: () => alive && !stopped,
    // Settles once the state files are written.
    stop: () => {
      if (stopped) return saving;
      stopped = true;
      clearInterval(ping);
      for (const chat of chats.values()) { for (const res of chat.subs) res.end(); chat.subs.clear(); }
      server.close();
      server.closeAllConnections?.();
      return saving;
    },
  };
}
