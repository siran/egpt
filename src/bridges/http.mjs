// http.mjs — the website chatbox limb (limbs.http): node:http under a path prefix, one conversation
// per visitor session. It is the "real" bridge behind the port adapter (beeper-port.mjs), as
// telegram.mjs is, so replies leave through the one sender path.
// Inside the spine a chat id is `http:<client>-<sid>`; sid is a hash of the session token, so the
// token (the visitor's credential) never reaches a log, a folder name or a transcript.
//   POST <path>/<client>/messages        {session?, text} → {session, message}
//   GET  <path>/<client>/messages?session=&since=   → {session, seq, messages}
//   GET  <path>/<client>/events?session=&since=     SSE: each message as it is posted, edited, settled
//   GET  <path>/<client>/widget.js
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { mentionStatus } from '../auto-mode.mjs';
import { stripInvisible } from '../invisible.mjs';

export const HTTP_PREFIX = 'http:';
export const isHttpChatId = (id) => String(id ?? '').startsWith(HTTP_PREFIX);
const CHAT_RE = /^http:([a-z0-9][a-z0-9_-]*)-([0-9a-f]{16})$/;
// The client a chatbox chat belongs to, or null.
export const httpClientOf = (chatId) => CHAT_RE.exec(String(chatId ?? ''))?.[1] ?? null;
const CLIENT_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const HTTP_DEFAULTS = Object.freeze({ path: '/chat', maxChars: 4000, rateMessages: 30, rateMinutes: 10, newSessions: 30, newSessionsMinutes: 60 });
export const HTTP_STRINGS = Object.freeze({
  title: 'Chat', open: 'Abrir chat', close: 'Cerrar', placeholder: 'Escribe tu mensaje…', send: 'Enviar',
  error: 'No se pudo enviar. Intenta de nuevo.', too_long: 'El mensaje es demasiado largo.', too_many: 'Demasiados mensajes. Espera unos minutos.',
});
const SESSION_IDLE_MS = 30 * 24 * 3600_000;   // an idle session past this is expired: its token starts a new one
const LOG_MAX = 200;                           // messages a session keeps for replay
const PING_MS = 25_000;                        // SSE keep-alive, under common proxy idle timeouts
const SESSIONS_FILE = 'http-sessions.json';
const WIDGET_SRC = readFileSync(new URL('./http-widget.js', import.meta.url), 'utf8');

const sidOf = (token) => createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);

function clientConfig(name, c = {}) {
  const strings = { ...HTTP_STRINGS, ...(c.strings && typeof c.strings === 'object' ? c.strings : {}), ...(c.title ? { title: String(c.title) } : {}) };
  const maxChars = posInt(c.max_chars, HTTP_DEFAULTS.maxChars);
  return {
    name,
    origins: Array.isArray(c.allowed_origins) ? c.allowed_origins.map(String) : [],
    maxChars,
    rateMessages: posInt(c.rate?.messages, HTTP_DEFAULTS.rateMessages),
    rateMs: posInt(c.rate?.minutes, HTTP_DEFAULTS.rateMinutes) * 60_000,
    newCount: posInt(c.new_sessions?.count, HTTP_DEFAULTS.newSessions),
    newMs: posInt(c.new_sessions?.minutes, HTTP_DEFAULTS.newSessionsMinutes) * 60_000,
    widget: `(${WIDGET_SRC.trim()})(${JSON.stringify({ client: name, maxChars, strings })});\n`,
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
  onNewSession = null,    // ({ client, chatId }), awaited before a new session's first line enters
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

  // sid → { client, lastAt, log, subs, posts }; client + lastAt persist across restarts.
  const sessions = new Map();
  const sessionsPath = stateDir ? join(stateDir, SESSIONS_FILE) : null;
  const live = (s, n = now()) => !!s && n - s.lastAt < SESSION_IDLE_MS;
  const fresh = (client, lastAt) => ({ client, lastAt, log: [], subs: new Set(), posts: [] });
  if (sessionsPath) {
    try {
      const saved = JSON.parse(await readFile(sessionsPath, 'utf8'));
      for (const [sid, s] of Object.entries(saved ?? {})) if (clients.has(s?.client) && live(s)) sessions.set(sid, fresh(s.client, s.lastAt));
    } catch (e) { if (e?.code !== 'ENOENT') log(`${sessionsPath} unreadable (${e?.message ?? e}) — starting with no sessions`); }
  }
  let saving = Promise.resolve();
  const persist = () => {
    if (!sessionsPath) return;
    const n = now();
    const out = {};
    for (const [sid, s] of sessions) {
      if (live(s, n)) out[sid] = { client: s.client, lastAt: s.lastAt };
      else if (!s.subs.size) sessions.delete(sid);
    }
    saving = saving.then(() => mkdir(stateDir, { recursive: true }).then(() => writeFile(sessionsPath, JSON.stringify(out), 'utf8')))
      .catch((e) => log(`could not save ${sessionsPath} — ${e?.message ?? e}`));
  };

  // One clock for ids and cursors: increasing, and past every value from before a restart.
  let tick = 0;
  const nextTick = () => (tick = Math.max(tick + 1, now()));
  const put = (res, chunk) => { if (!res.writableEnded) res.write(chunk); };
  const view = (m) => (m.deleted ? { id: m.id, deleted: true, seq: m.seq } : { id: m.id, from: m.from, text: m.text, done: m.done, seq: m.seq });
  const changed = (s, m) => {
    m.seq = nextTick();
    m.id ??= String(m.seq);
    const frame = `id: ${m.seq}\ndata: ${JSON.stringify(view(m))}\n\n`;
    for (const res of s.subs) put(res, frame);
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
  const ownMessage = (s, msgId) => s?.log.find((m) => m.id === String(msgId) && m.from === 'being' && !m.deleted) ?? null;
  // A known, unexpired token of this client → its session; else null.
  const sessionOfToken = (c, token) => {
    if (typeof token !== 'string' || !token || token.length > 200) return null;
    const sid = sidOf(token);
    const s = sessions.get(sid);
    if (s?.client !== c.name) return null;
    if (live(s)) return { sid, s };
    sessions.delete(sid);
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
    const n = now();
    let token = body?.session, hit = sessionOfToken(c, token);
    if (hit) {
      hit.s.posts = hit.s.posts.filter((t) => n - t < c.rateMs);
      if (hit.s.posts.length >= c.rateMessages) {
        const wait = Math.ceil((hit.s.posts[0] + c.rateMs - n) / 1000);
        return json(res, 429, { error: 'too many messages', retry_after_s: wait }, { ...cors, 'Retry-After': String(wait) });
      }
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
      hit = { sid: sidOf(token), s: fresh(c.name, n), isNew: true };
      sessions.set(hit.sid, hit.s);
      log(`new session ${c.name}-${hit.sid}`);
    }
    const { sid, s } = hit;
    const chatId = chatIdOf(c.name, sid);
    s.posts.push(n);
    s.lastAt = n;
    persist();
    if (hit.isNew) {
      try { await onNewSession?.({ client: c.name, chatId }); }
      catch (e) { log(`new session ${c.name}-${sid}: ${e?.message ?? e}`); }
    }
    const m = append(s, 'visitor', text, true);
    const st = mentionStatus(text, wakeWords, { addressWithoutAt });
    log(`incoming [${c.name}-${sid}] visitor: ${JSON.stringify(text.slice(0, 60))}`);
    deliver(text, {
      chatId, chatName: `${c.name}-${sid}`, chatType: 'private', network: 'http',
      userId: chatId, senderName: 'visitor', firstName: 'visitor',
      isSender: false, authorized: false,   // a visitor is a stranger by design; the conversation's allowed_users admits it
      atEStart: st.atEStart, atEAnywhere: st.atEAnywhere,
      backlog: false, replyToBot: false, isReaction: false, isTranscriptFromVoice: false,
      msgKey: m.id, msgTs: n,
    });
    return json(res, 200, { session: token, message: view(m) }, cors);
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
    if (route === 'GET widget.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=300', ...cors });
      return res.end(c.widget);
    }
    const known = ['messages', 'events', 'widget.js'].includes(action);
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
  function deleteMessage(chatId, msgId) {
    const s = sessionOfChat(chatId);
    const m = ownMessage(s, msgId);
    if (!m) return false;
    Object.assign(m, { deleted: true, text: '' });
    changed(s, m);
    return true;
  }
  // The placeholder at once, each update an edit, the final text in the same message (done).
  function startStreamMessage(initialText, { chatId, existingMsgId = null } = {}) {
    const s = sessionOfChat(chatId);
    let m = existingMsgId != null ? ownMessage(s, existingMsgId) : null;
    let finished = false;
    const h = { delivered: false, lastError: null, get confirmedId() { return m && !m.deleted ? m.id : null; } };
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
    h.delete = async () => {
      if (finished || !m) return false;
      finished = true;
      return deleteMessage(chatId, m.id);
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
    deleteMessage,
    startStreamMessage,
    wasSentByUs: (chatId, msgId) => !!ownMessage(sessionOfChat(chatId), msgId),
    sendFailure: (chatId) => failures.get(chatId) ?? null,
    getChatName: (chatId) => { const hit = CHAT_RE.exec(String(chatId ?? '')); return hit ? `${hit[1]}-${hit[2]}` : null; },
    isAlive: () => alive && !stopped,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(ping);
      for (const s of sessions.values()) { for (const res of s.subs) res.end(); s.subs.clear(); }
      server.close();
      server.closeAllConnections?.();
    },
  };
}
