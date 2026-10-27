// http.mjs — the website chatbox limb (limbs.http): node:http under a path prefix, one conversation
// per visitor session. It is the "real" bridge behind the port adapter (beeper-port.mjs), as
// telegram.mjs is, so replies leave through the one sender path.
// Inside the spine a chat id is `http:<client>-<sid>`; sid is a hash of the session token, so the
// token (the visitor's credential) never reaches a log, a folder name or a transcript.
//   POST <path>/<client>/messages        {session?, text, id?} → {session, message}; a repeated id (a retry) gets the first answer
//   GET  <path>/<client>/messages?session=&since=   → {session, seq, messages}
//   GET  <path>/<client>/events?session=&since=     SSE: each message as it is posted, edited, settled
//   POST <path>/<client>/end             {session} → {ok}: a fresh thread in the same conversation (onEnd), history cleared
//   GET  <path>/<client>/widget.js                  a loader: Deep Chat (DEEP_CHAT) wired to the four above
// A session's messages (the last LOG_MAX) are kept in <stateDir>/http-messages/<sid>.json, so the
// GET after a restart still returns them.
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { mentionStatus } from '../auto-mode.mjs';
import { stripInvisible } from '../invisible.mjs';

export const HTTP_PREFIX = 'http:';
export const isHttpChatId = (id) => String(id ?? '').startsWith(HTTP_PREFIX);
const CHAT_RE = /^http:([a-z0-9][a-z0-9_-]*)-([0-9a-f]{16})$/;
// The client a chatbox chat belongs to, or null.
export const httpClientOf = (chatId) => CHAT_RE.exec(String(chatId ?? ''))?.[1] ?? null;
const CLIENT_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const HTTP_DEFAULTS = Object.freeze({ path: '/chat', maxChars: 4000, rateMessages: 30, rateMinutes: 10, newSessions: 30, newSessionsMinutes: 60, sessionDays: 365 });
export const HTTP_STRINGS = Object.freeze({
  title: 'Chat', open: 'Abrir chat', close: 'Cerrar', placeholder: 'Escribe tu mensaje…', send: 'Enviar',
  error: 'No se pudo enviar. Intenta de nuevo.', too_long: 'El mensaje es demasiado largo.', too_many: 'Demasiados mensajes. Espera unos minutos.',
  unavailable: 'No se pudo abrir el chat. Intenta de nuevo.',
  end: 'Terminar conversación', end_confirm: '¿Terminar esta conversación? El chat empezará de nuevo.', end_yes: 'Sí, terminar', cancel: 'Cancelar',
  ended: '🔚 El visitante terminó la conversación. Lo siguiente es una conversación nueva.',   // to the team topic
  earlier: '(conversación iniciada antes: {n} mensajes)',   // heads the recap a team topic gets when seated
  intro: '',   // the panel's first line (Deep Chat introMessage), shown again after an end; empty: none
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

function clientConfig(name, c = {}) {
  const strings = { ...HTTP_STRINGS, ...(c.strings && typeof c.strings === 'object' ? c.strings : {}), ...(c.title ? { title: String(c.title) } : {}) };
  const maxChars = posInt(c.max_chars, HTTP_DEFAULTS.maxChars);
  return {
    name,
    being: c.being ? String(c.being) : null,
    origins: Array.isArray(c.allowed_origins) ? c.allowed_origins.map(String) : [],
    maxChars,
    rateMessages: posInt(c.rate?.messages, HTTP_DEFAULTS.rateMessages),
    rateMs: posInt(c.rate?.minutes, HTTP_DEFAULTS.rateMinutes) * 60_000,
    newCount: posInt(c.new_sessions?.count, HTTP_DEFAULTS.newSessions),
    newMs: posInt(c.new_sessions?.minutes, HTTP_DEFAULTS.newSessionsMinutes) * 60_000,
    idleMs: posInt(c.session_days, HTTP_DEFAULTS.sessionDays) * 24 * 3600_000,   // an idle session past this is expired: its token starts a new one
    ended: strings.ended,
    earlier: strings.earlier,
    widget: `(${WIDGET_SRC.trim()})(${JSON.stringify({ client: name, maxChars, strings, deepChat: DEEP_CHAT })});\n`,
  };
}

export async function startHttpBridge({
  bind = '127.0.0.1',
  port,
  path = HTTP_DEFAULTS.path,
  clients: clientsCfg = {},
  wakeWords,
  addressWithoutAt = true,
  trustProxy = false,      // the visitor's address: the last X-Forwarded-For entry, else the socket's
  stateDir = null,
  beforeLine = null,      // ({ client, chatId, isNew, recap }), awaited before each line enters; recap() → the panel's lines so far as text, or null
  onEnd = null,           // ({ client, chatId, ended }), awaited by POST end before the history is cleared
  onIncoming,
  onLog: log = () => {},   // boot tags each line [http]
  now = () => Date.now(),
} = {}) {
  const base = `/${String(path ?? '').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  const clients = new Map();
  for (const [name, c] of Object.entries(clientsCfg && typeof clientsCfg === 'object' ? clientsCfg : {})) {
    if (!CLIENT_RE.test(name)) { log(`client '${name}' skipped — a client name is lowercase letters, digits, - and _`); continue; }
    clients.set(name, clientConfig(name, c));
  }

  // sid → { sid, client, lastAt, log, subs, posts }; client + lastAt persist across restarts, log in its own file.
  const sessions = new Map();
  const sessionsPath = stateDir ? join(stateDir, SESSIONS_FILE) : null;
  const messagesDir = stateDir ? join(stateDir, MESSAGES_DIR) : null;
  const logPath = (sid) => join(messagesDir, `${sid}.json`);
  const live = (s, n = now()) => !!s && n - s.lastAt < (clients.get(s.client)?.idleMs ?? 0);
  const fresh = (client, lastAt, sid, log = []) => ({ sid, client, lastAt, log, subs: new Set(), posts: [] });
  // A reply cut by the restart is settled as it stood.
  const readLog = async (sid) => {
    try { return JSON.parse(await readFile(logPath(sid), 'utf8')).slice(-LOG_MAX).map((m) => ({ ...m, done: true })); }
    catch (e) { if (e?.code !== 'ENOENT') log(`${logPath(sid)} unreadable (${e?.message ?? e}) — that session starts with no history`); return []; }
  };
  if (sessionsPath) {
    try {
      const saved = JSON.parse(await readFile(sessionsPath, 'utf8'));
      for (const [sid, s] of Object.entries(saved ?? {})) if (clients.has(s?.client) && live(s)) sessions.set(sid, fresh(s.client, s.lastAt, sid, await readLog(sid)));
    } catch (e) { if (e?.code !== 'ENOENT') log(`${sessionsPath} unreadable (${e?.message ?? e}) — starting with no sessions`); }
    for (const f of await readdir(messagesDir).catch(() => [])) {
      if (!sessions.has(f.replace(/\.json$/, ''))) await unlink(join(messagesDir, f)).catch((e) => log(`could not remove ${f} — ${e?.message ?? e}`));
    }
  }
  // Every state write goes through one chain. A change rewrites its session's file; changes made
  // before that write starts ride along in it.
  let saving = Promise.resolve();
  const saveLog = (s) => {
    if (!messagesDir || s.dirty) return;
    s.dirty = true;
    const file = logPath(s.sid);
    saving = saving.then(async () => {
      s.dirty = false;
      await mkdir(messagesDir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(s.log), 'utf8');
      await rename(`${file}.tmp`, file);
    }).catch((e) => log(`could not save ${file} — ${e?.message ?? e}`));
  };
  const forget = (sid) => {
    sessions.delete(sid);
    if (messagesDir) saving = saving.then(() => unlink(logPath(sid))).catch((e) => { if (e?.code !== 'ENOENT') log(`could not remove ${logPath(sid)} — ${e?.message ?? e}`); });
  };
  const persist = () => {
    if (!sessionsPath) return;
    const n = now();
    const out = {};
    for (const [sid, s] of sessions) {
      if (live(s, n)) out[sid] = { client: s.client, lastAt: s.lastAt };
      else if (!s.subs.size) forget(sid);
    }
    saving = saving.then(() => mkdir(stateDir, { recursive: true }).then(() => writeFile(sessionsPath, JSON.stringify(out), 'utf8')))
      .catch((e) => log(`could not save ${sessionsPath} — ${e?.message ?? e}`));
  };

  // One clock for ids and cursors: increasing, and past every value from before a restart.
  let tick = 0;
  for (const s of sessions.values()) for (const m of s.log) tick = Math.max(tick, m.seq);
  const nextTick = () => (tick = Math.max(tick + 1, now()));
  const put = (res, chunk) => { if (!res.writableEnded) res.write(chunk); };
  const view = (m) => ({ id: m.id, from: m.from, text: m.text, done: m.done, seq: m.seq });
  const changed = (s, m) => {
    if (m.ended) return;   // cleared by an end: a reply still streaming stays out of the fresh panel
    m.seq = nextTick();
    m.id ??= String(m.seq);
    const frame = `id: ${m.seq}\ndata: ${JSON.stringify(view(m))}\n\n`;
    for (const res of s.subs) put(res, frame);
    saveLog(s);
  };
  const append = (s, from, text, done) => {
    const m = { id: null, from, text, done, seq: 0 };
    changed(s, m);
    s.log.push(m);
    if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
    return m;
  };
  const chatIdOf = (client, sid) => `${HTTP_PREFIX}${client}-${sid}`;
  const sessionOfChat = (chatId) => {
    const hit = CHAT_RE.exec(String(chatId ?? ''));
    const s = hit && sessions.get(hit[2]);
    return s && s.client === hit[1] ? s : null;
  };
  const ownMessage = (s, msgId) => s?.log.find((m) => m.id === String(msgId) && m.from === 'being') ?? null;
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

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
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
  const posted = new Map();   // `<client> <id>` → { at, reply }: a retried POST gets the first one's answer
  // Seconds until this session may post again (its window pruned), or 0.
  const rateWait = (c, s, n) => {
    s.posts = s.posts.filter((t) => n - t < c.rateMs);
    return s.posts.length >= c.rateMessages ? Math.ceil((s.posts[0] + c.rateMs - n) / 1000) : 0;
  };
  // The panel's settled lines so far, for a team topic seated after them: their count, then the last few.
  const recapOf = (c, s, { header = true } = {}) => {
    const said = s.log.filter((m) => m.done && m.text);
    if (!said.length) return null;
    const clip = (t) => ([...t].length > RECAP_CHARS ? `${[...t].slice(0, RECAP_CHARS).join('')}…` : t);
    return [...(header ? [c.earlier.replaceAll('{n}', String(said.length))] : []), ...said.slice(-RECAP_LINES).map((m) => `${m.from === 'visitor' ? 'visitor' : c.being}: ${clip(m.text)}`)].join('\n');
  };
  const addressOf = (req) => (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',').map((a) => a.trim()).filter(Boolean).at(-1)) || req.socket.remoteAddress;

  async function post(c, req, res, cors) {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return json(res, 415, { error: 'send application/json' }, cors);
    const raw = await readBody(req, c.maxChars * 4 + 1024);
    if (raw == null) return json(res, 413, { error: 'too long', max_chars: c.maxChars }, cors);
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'not JSON' }, cors); }
    const text = stripInvisible(String(body?.text ?? ''));
    if (!text.trim()) return json(res, 400, { error: 'empty message' }, cors);
    if ([...text].length > c.maxChars) return json(res, 413, { error: 'too long', max_chars: c.maxChars }, cors);
    const key = typeof body?.id === 'string' && ID_RE.test(body.id) ? `${c.name} ${body.id}` : null;
    if (key && posted.has(key)) return json(res, 200, await posted.get(key).reply, cors);
    const n = now();
    let token = body?.session, hit = sessionOfToken(c, token);
    if (hit) {
      const wait = rateWait(c, hit.s, n);
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
      hit = { sid: sidOf(token), isNew: true };
      hit.s = fresh(c.name, n, hit.sid);
      sessions.set(hit.sid, hit.s);
      log(`new session ${c.name}-${hit.sid}`);
    }
    const { sid, s } = hit;
    const chatId = chatIdOf(c.name, sid);
    s.posts.push(n);
    s.lastAt = n;
    persist();
    const reply = (async () => {
      try { await beforeLine?.({ client: c.name, chatId, isNew: !!hit.isNew, recap: (o) => recapOf(c, s, o) }); }
      catch (e) { log(`${c.name}-${sid}: before the line — ${e?.message ?? e}`); }
      const m = append(s, 'visitor', text, true);
      const st = mentionStatus(text, wakeWords, { addressWithoutAt });
      log(`incoming [${c.name}-${sid}] visitor: ${JSON.stringify(text.slice(0, 60))}`);
      deliver(text, {
        chatId, chatName: `${c.name}-${sid}`, chatType: 'private', network: 'http',
        userId: chatId, senderName: 'visitor', firstName: 'visitor',
        isSender: false, authorized: false,   // a visitor is a stranger by design; the conversation's allowed_users admits it
        atEStart: st.atEStart, atEAnywhere: st.atEAnywhere,
        // the widget is a reply thread with the client's being: every visitor line addresses it
        backlog: false, replyToBot: !!c.being, replyToBeing: c.being, isReaction: false, isTranscriptFromVoice: false,
        msgKey: m.id, msgTs: n,
      });
      return { session: token, message: view(m) };
    })();
    if (key) { posted.set(key, { at: n, reply }); reply.catch(() => posted.delete(key)); }
    return json(res, 200, await reply, cors);
  }

  // The visitor's "end conversation": the same session, token and conversation; onEnd gives it a
  // fresh thread, then the panel's history is cleared. Nothing said since the last end: nothing to do.
  async function end(c, req, res, cors) {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return json(res, 415, { error: 'send application/json' }, cors);
    const raw = await readBody(req, 1024);
    if (raw == null) return json(res, 413, { error: 'too long' }, cors);
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'not JSON' }, cors); }
    const hit = sessionOfToken(c, body?.session);
    if (!hit) return json(res, 404, { error: 'unknown session' }, cors);
    const { sid, s } = hit;
    const n = now(), wait = rateWait(c, s, n);
    if (wait) return json(res, 429, { error: 'too many messages', retry_after_s: wait }, { ...cors, 'Retry-After': String(wait) });
    s.lastAt = n;
    persist();
    if (!s.log.length) return json(res, 200, { ok: true }, cors);
    s.posts.push(n);
    try { await onEnd?.({ client: c.name, chatId: chatIdOf(c.name, sid), ended: c.ended }); }
    catch (e) { log(`end ${c.name}-${sid}: ${e?.message ?? e}`); return json(res, 500, { error: 'could not end the conversation' }, cors); }
    for (const m of s.log) m.ended = true;
    s.log = [];
    saveLog(s);
    log(`${c.name}-${sid}: the visitor ended the conversation`);
    return json(res, 200, { ok: true }, cors);
  }

  const since = (req, url) => Number(req.headers['last-event-id'] ?? url.searchParams.get('since')) || 0;
  function list(c, req, res, url, cors) {
    const hit = sessionOfToken(c, url.searchParams.get('session'));
    if (!hit) return json(res, 404, { error: 'unknown session' }, cors);
    const after = since(req, url);
    const messages = hit.s.log.filter((m) => m.seq > after).map(view);
    return json(res, 200, { session: url.searchParams.get('session'), seq: Math.max(after, ...hit.s.log.map((m) => m.seq)), messages }, cors);
  }
  function events(c, req, res, url, cors) {
    const hit = sessionOfToken(c, url.searchParams.get('session'));
    if (!hit) return json(res, 404, { error: 'unknown session' }, cors);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...cors });
    res.write('retry: 3000\n\n');
    const after = since(req, url);
    for (const m of hit.s.log) if (m.seq > after) res.write(`id: ${m.seq}\ndata: ${JSON.stringify(view(m))}\n\n`);
    hit.s.subs.add(res);
    res.on('close', () => hit.s.subs.delete(res));
  }

  // CORS: an Origin must be on the client's list; an empty list sends no CORS headers (same-origin
  // only — the website's server proxies the path) and refuses every preflight.
  async function serve(req, res) {
    const url = new URL(req.url, 'http://chatbox');
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
        log(`listening on http://${bind}:${port}${base}<client>/ — clients: ${[...clients.keys()].join(', ') || 'none'}`);
        resolve(true);
      });
    });
  await startupReady;
  const windowMs = Math.max(0, ...[...clients.values()].map((c) => c.newMs));
  const ping = setInterval(() => {
    for (const s of sessions.values()) for (const res of s.subs) put(res, ': ping\n\n');
    const n = now();
    for (const [key, times] of opened) if (n - times.at(-1) >= windowMs) opened.delete(key);
    for (const [key, p] of posted) if (n - p.at >= RETRY_MS) posted.delete(key);
  }, PING_MS);
  ping.unref?.();

  // --- outbound (the port's interface, as telegram.mjs) ---
  async function send(text, { chatId } = {}) {
    const s = sessionOfChat(chatId);
    if (!s) { failures.set(chatId, 'no live chatbox session'); log(`send refused — ${chatId} is not a live chatbox session`); return null; }
    text = stripInvisible(text);
    if (!text.trim()) return null;
    const m = append(s, 'being', text, true);
    failures.delete(chatId);
    return { messageId: m.id, confirmedId: m.id };
  }
  function editMessage(chatId, msgId, text) {
    const s = sessionOfChat(chatId);
    const m = ownMessage(s, msgId);
    if (!m) return false;
    m.text = stripInvisible(text);
    changed(s, m);
    return true;
  }
  // The placeholder at once, each update an edit, the final text in the same message (done).
  function startStreamMessage(initialText, { chatId, existingMsgId = null } = {}) {
    const s = sessionOfChat(chatId);
    let m = existingMsgId != null ? ownMessage(s, existingMsgId) : null;
    let finished = false;
    const h = { delivered: false, lastError: null, get confirmedId() { return m ? m.id : null; } };
    if (!s) h.lastError = 'no live chatbox session';
    else if (m) { m.text = stripInvisible(initialText); m.done = false; changed(s, m); }
    else m = append(s, 'being', stripInvisible(initialText), false);
    h.update = (t) => { if (finished || !t || !m) return; m.text = stripInvisible(t); changed(s, m); };
    h.finish = async (t) => {
      if (finished) return;
      finished = true;
      if (!m) return;
      if (t) m.text = stripInvisible(t);
      m.done = true;
      changed(s, m);
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
    wasSentByUs: (chatId, msgId) => !!ownMessage(sessionOfChat(chatId), msgId),
    sendFailure: (chatId) => failures.get(chatId) ?? null,
    getChatName: (chatId) => { const hit = CHAT_RE.exec(String(chatId ?? '')); return hit ? `${hit[1]}-${hit[2]}` : null; },
    isAlive: () => alive && !stopped,
    // Settles once the state files are written.
    stop: () => {
      if (stopped) return saving;
      stopped = true;
      clearInterval(ping);
      for (const s of sessions.values()) { for (const res of s.subs) res.end(); s.subs.clear(); }
      server.close();
      server.closeAllConnections?.();
      return saving;
    },
  };
}
