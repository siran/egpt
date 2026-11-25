// http-secrets.mjs — the operator's secrets page (/<handle> secret): the node's and the team's secrets (secrets.mjs, the
// secrets/managed/ folder), edited from a browser. It is reached one of two ways, both serving the same routes under
// <base>secret/<session token>/:
//   - THE TUNNEL (default): a random *.trycloudflare.com link, like #45's browser screens. cloudflared (screen-tunnel.mjs) is
//     pointed at THE DOOR (createSecretsDoor), a loopback listener that serves nothing but /secret/…: not the http limb,
//     not ayde, not the chatbox. The tunnel opens with the first session and closes when the last one ends or expires.
//   - limbs.http.public_url: the http limb mounts the same page at <ayde.path>/secret/…, behind the site's own proxy.
// Auth is the session token, NOT ayde's Basic login, and a link alone does nothing: the session is bound to the chat and
// the operator that ran /secret, and activates only when that operator types the page's one-time code there:
//   <token>/claim         POST, once: the first browser to press Open gets the owner cookie (secret_session, HttpOnly, Secure,
//                         SameSite=Strict, Path=<prefix>, a hash of it kept here) AND the page then shows a one-time code;
//                         until then <token>[/] shows only an Open button (link-preview bots GET it), every other route is 404
//   <token>[/]            owner, not yet confirmed: "waiting for confirmation in chat" and the code, nothing else works;
//                         confirmed: the page (http-secrets.html; ?name=<secret> opens on that one)
//   /<handle> secret confirm <code>   typed in the chat /secret was run in, by the operator who ran it (sessions.confirm)
//   <token>/page.js       its script;  <token>/crypto.js  http-secrets-crypto.mjs: what locks a value in the browser
//   <token>/api/list      {who, expires, secrets: [{name, locked, created_by, created_at, changed_by, changed_at}]}
//   <token>/api/secret?name=<name>   {secret: {name, value (as stored), locked, …meta}, history: [{stamp, kind, fingerprint, …}]}
//   <token>/api/save      POST {name, value[, from]}: stores the value as sent (the browser sends an enc:v1: string when a password
//                         was typed; the password never reaches here); the old one is kept as metadata only (secrets.mjs); from ≠ name renames first
//   <token>/api/purge     POST {name}: forgets that secret's history;  <token>/api/end  POST: ends the session (closes the link)
// A session (createSecretSessions): 32 random bytes, base64url, in memory, 15 minutes from /secret. Unknown or expired → 404,
// nothing revealed; wrong-token hits are logged and rate-limited. Every save, rename, purge is audited (audit(), never the value).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';
import { getSecret, listSecrets, saveSecret, secretHistory, purgeHistory, MAX_SECRET_BYTES } from '../secrets.mjs';

export const SECRET_SESSION_MS = 15 * 60_000;
export const SECRET_KEY = 'secrets';        // the tunnel's key (its entry under state/secret-link)
const MAX_CODE_TRIES = 5, MISS_LIMIT = 20, MISS_WINDOW_MS = 60_000;
const file = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const COOKIE = 'secret_session';
const sha = (v) => createHash('sha256').update(String(v)).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));
const CLAIM_PAGE = (action) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>Secrets</title>
<form method="post" action="${action}"><p>The first browser to open this link owns it. Then you confirm it in the chat.</p><button type="submit">Open</button></form></html>
`;
const WAIT_PAGE = (code) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="3"><title>Secrets</title>
<p>Waiting for confirmation in chat.</p><p>In the chat where you asked for this link, type:</p><p><code>secret confirm ${code}</code></p><p>(after the same /&lt;handle&gt; you used for <code>secret</code>). This page opens by itself once you do.</p></html>
`;
const PAGE = file('http-secrets.html'), SCRIPT = file('http-secrets.js'), CRYPTO = file('http-secrets-crypto.mjs');

/**
 * The sessions of the secrets page. A session: { who, operator, chatId, expires, claim?, code?, confirmed, tries }.
 * onOpened(session): a session was confirmed. onEnd(session, remaining): it ended or expired; remaining = sessions left.
 */
export function createSecretSessions({ now = () => Date.now(), ttlMs = SECRET_SESSION_MS, timer = setTimeout, untimer = clearTimeout, onOpened = () => {}, onEnd = () => {} } = {}) {
  const live = new Map();   // token → session
  const end = (token) => {
    const s = live.get(token);
    if (!s) return false;
    live.delete(token); untimer(s.timer);
    onEnd(s, live.size);
    return true;
  };
  const sweep = () => { const n = now(); for (const [t, s] of [...live]) if (s.expires <= n) end(t); };
  return {
    // → { token, expires (ms) }. who: its name in the page and the audit; operator + chatId: who may confirm it, and where.
    open({ who, operator, chatId }) {
      const token = randomBytes(32).toString('base64url'), expires = now() + ttlMs;
      const s = { who: String(who), operator: String(operator), chatId: String(chatId), expires, confirmed: false, tries: 0 };
      s.timer = timer(() => end(token), ttlMs); s.timer?.unref?.();
      live.set(token, s);
      return { token, expires };
    },
    // → the session or null; compared in constant time against every live token
    check(token) {
      sweep();
      const given = Buffer.from(String(token ?? ''));
      let hit = null;
      for (const [t, s] of live) {
        const have = Buffer.from(t);
        if (have.length === given.length && timingSafeEqual(have, given)) hit = s;
      }
      return hit;
    },
    // → { ok: true, who } or { error }: the code of the session this operator asked for in THIS chat, once its page was opened.
    confirm({ chatId, operator, code }) {
      sweep();
      for (const [t, s] of live) {
        if (s.chatId !== String(chatId) || s.operator !== String(operator) || !s.code || s.confirmed) continue;
        if (!same(s.code, String(code ?? '').trim())) {
          if (++s.tries >= MAX_CODE_TRIES) { end(t); return { error: 'too many wrong codes: the session is closed, ask for a new link' }; }
          return { error: 'that is not the code on the page' };
        }
        s.confirmed = true;
        try { onOpened(s); } catch { /* an audit line must not undo the confirmation */ }
        return { ok: true, who: s.who };
      }
      return { error: 'no secrets page is waiting for a code from you in this chat (open its link first, or ask for /secret again)' };
    },
    end,
    count: () => { sweep(); return live.size; },
  };
}

// serve(req, res, url, sub): sub = the path parts after <base>secret/ ([token, …rest]). base: '/ayde/', or '/' at the door.
export function createSecretsPage({ home, sessions, base, json, readBody, audit = () => {}, now = () => Date.now(), log = () => {} }) {
  const headers = (type, csp = "default-src 'none'") => ({
    'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp,
  });
  const text = (res, type, body, csp) => { res.writeHead(200, headers(type, csp)); res.end(body); };
  const fail = (res, status, error, extra = {}) => json(res, status, { error }, { ...headers('application/json; charset=utf-8'), ...extra });
  const send = (res, body) => json(res, 200, body, headers('application/json; charset=utf-8'));
  const auditSafe = (a) => { try { audit(a); } catch (e) { log(`secret audit failed — ${e?.message ?? e}`); } };
  let misses = [];   // when each wrong-token hit happened, within MISS_WINDOW_MS

  return async function serve(req, res, url, [token, ...rest]) {
    const session = sessions.check(token);
    if (!session) {
      const n = now();
      misses = misses.filter((t) => t > n - MISS_WINDOW_MS); misses.push(n);
      if (misses.length <= MISS_LIMIT) log(`secrets page: unknown or expired token from ${req.headers?.['cf-connecting-ip'] ?? req.socket?.remoteAddress ?? '?'} (${misses.length} in the last minute)`);
      else if (misses.length === MISS_LIMIT + 1) log(`secrets page: over ${MISS_LIMIT} wrong tokens in a minute, refusing more`);
      if (misses.length > MISS_LIMIT) return fail(res, 429, 'too many requests', { 'Retry-After': String(MISS_WINDOW_MS / 1000) });
      return fail(res, 404, 'not found');
    }
    const route = rest.join('/');
    const prefix = `${base}secret/${token}`;
    if (!session.claim) {   // not claimed: the Open button (a GET changes nothing) or the claim itself, nothing else
      if (route === '' && req.method === 'GET') return text(res, 'text/html; charset=utf-8', CLAIM_PAGE(`${prefix}/claim${url.search.replace(/[^?&=\w.%-]/g, '')}`), "default-src 'none'; form-action 'self'");
      if (route !== 'claim' || req.method !== 'POST') return fail(res, 404, 'not found');
      const cookie = randomBytes(32).toString('base64url');
      session.claim = sha(cookie);
      session.code = String(randomInt(0, 100_000_000)).padStart(8, '0');   // shown to the owner of this browser, typed in the chat by the operator
      const maxAge = Math.max(1, Math.ceil((session.expires - now()) / 1000));
      log(`secrets page opened in a browser for ${session.who}'s link; waiting for the code in chat`);
      res.writeHead(303, { ...headers('text/plain'), Location: `${prefix}${url.search}`, 'Set-Cookie': `${COOKIE}=${cookie}; HttpOnly; Secure; SameSite=Strict; Path=${prefix}; Max-Age=${maxAge}` });
      return res.end();
    }
    const given = /(?:^|;\s*)secret_session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
    if (!given || !timingSafeEqual(sha(given), session.claim)) return fail(res, 404, 'not found');   // claimed by another browser, or a second claim
    if (!session.confirmed) {   // the owner's browser, the operator has not typed the code: accepts nothing
      if (route === '' && req.method === 'GET') return text(res, 'text/html; charset=utf-8', WAIT_PAGE(session.code), "default-src 'none'");
      return fail(res, 403, 'waiting for confirmation in chat');
    }
    const method = (m) => (req.method === m ? true : (json(res, 405, { error: 'method not allowed' }, { ...headers('application/json; charset=utf-8'), Allow: m }), false));
    if (route === '' || route === 'page.js' || route === 'crypto.js') {
      if (!method('GET')) return;
      if (route === 'page.js') return text(res, 'text/javascript; charset=utf-8', SCRIPT.replaceAll('__PREFIX__', prefix), "default-src 'none'");
      if (route === 'crypto.js') return text(res, 'text/javascript; charset=utf-8', CRYPTO, "default-src 'none'");
      const nonce = randomBytes(16).toString('base64');
      return text(res, 'text/html; charset=utf-8', PAGE.replaceAll('__PREFIX__', prefix).replaceAll('__NONCE__', nonce),
        `default-src 'none'; script-src 'self'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    }
    if (route === 'api/list') {
      if (!method('GET')) return;
      return send(res, { who: session.who, expires: session.expires, secrets: listSecrets(home) });
    }
    if (route === 'api/secret') {
      if (!method('GET')) return;
      const name = url.searchParams.get('name') ?? '';
      const secret = getSecret(home, name);
      return secret ? send(res, { secret, history: secretHistory(home, name) }) : fail(res, 404, 'no such secret');
    }
    if (route === 'api/end') {
      if (!method('POST')) return;
      send(res, { ok: true });
      sessions.end(token);
      return;
    }
    if (route === 'api/purge') {
      if (!method('POST')) return;
      const raw = await readBody(req, 4096);
      let name = null;
      try { name = JSON.parse(raw ?? 'null')?.name; } catch { /* answered below */ }
      try {
        const n = purgeHistory(home, typeof name === 'string' ? name : undefined);
        log(`secret ${name} history forgotten by ${session.who} (${n})`);
        auditSafe({ name, action: 'forgot history', who: session.who, kind: 'history' });
        return send(res, { ok: true, forgotten: n, history: secretHistory(home, name) });
      } catch (e) { return fail(res, 400, e?.message ?? String(e)); }
    }
    if (route === 'api/save') {
      if (!method('POST')) return;
      const raw = await readBody(req, MAX_SECRET_BYTES + 4096);
      let body = null;
      try { body = raw == null ? null : JSON.parse(raw); } catch { /* answered below */ }
      if (raw == null) return fail(res, 413, 'value over 64 KB');
      if (!body || typeof body !== 'object') return fail(res, 400, 'bad request');
      const { name, value, from } = body;
      try {
        const r = saveSecret(home, name, value, session.who, { from: typeof from === 'string' && from ? from : null, now });
        const kind = r.locked ? 'encrypted' : 'plain';
        log(`secret ${name} ${r.action} by ${session.who} (${kind})`);
        auditSafe({ name: r.action === 'renamed' ? `${from} → ${name}` : name, action: r.action, who: session.who, kind });
        return send(res, { ok: true, action: r.action, secret: getSecret(home, name), history: secretHistory(home, name) });
      } catch (e) { return fail(res, 400, e?.message ?? String(e)); }
    }
    return fail(res, 404, 'not found');
  };
}

/**
 * THE DOOR: the one local listener the tunnel is pointed at. 127.0.0.1, an ephemeral port, started with the first
 * session and stopped with the last. It serves <page>'s routes under /secret/<token>/… and answers 404 to every other path,
 * so what the public tunnel URL reaches is the secrets page and nothing else on this node.
 */
export function createSecretsDoor({ page, json, host = '127.0.0.1' }) {
  let server = null, port = null;
  const plain = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  return {
    get port() { return port; },
    async start() {
      if (server) return port;
      const s = createServer((req, res) => {
        const url = new URL(req.url, 'http://door');
        if (!url.pathname.startsWith('/secret/')) return json(res, 404, { error: 'not found' }, plain);
        Promise.resolve(page(req, res, url, url.pathname.slice('/secret/'.length).split('/'))).catch(() => { if (!res.headersSent) json(res, 500, { error: 'error' }, plain); else res.end(); });
      });
      await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, host, resolve); });
      server = s; port = s.address().port;
      return port;
    },
    stop() { const s = server; server = null; port = null; s?.closeAllConnections?.(); return new Promise((r) => (s ? s.close(() => r()) : r())); },
    isOpen: () => !!server,
  };
}

/**
 * What /<handle> secret calls: open(…) → { url, expires, via }, confirm(…). With a publicUrl (limbs.http.public_url) the link is
 * the site's own, <publicUrl>/<path>/secret/<token>, served by the http limb; without, a tunnel to the door. Wire
 * createSecretSessions' onEnd to `ended`: the last session closes the tunnel and the door.
 */
export function createSecretLink({ sessions, door, tunnel, httpLimb = () => false }) {
  return {
    // publicUrl, path: limbs.http.public_url and ayde.path, read by the caller from the live config.
    async open({ who, operator, chatId, name, publicUrl = '', path = 'ayde' }) {
      const { token, expires } = sessions.open({ who, operator, chatId });
      const q = name ? `?name=${encodeURIComponent(name)}` : '';
      try {
        const site = String(publicUrl ?? '').trim().replace(/\/+$/, '');
        if (site) {
          if (!httpLimb()) throw new Error('limbs.http.public_url is set but this node has no http limb (limbs.http.port): unset it to use a tunnel');
          return { url: `${site}/${path}/secret/${token}${q}`, expires, via: 'public_url' };
        }
        await door.start();
        const t = await tunnel.open(SECRET_KEY);
        return { url: `${t.url}/secret/${token}${q}`, expires, via: 'tunnel' };
      } catch (e) { sessions.end(token); throw e; }
    },
    confirm: (o) => sessions.confirm(o),
    ended(_session, remaining) { if (remaining === 0) { tunnel?.close(SECRET_KEY); Promise.resolve(door?.stop()).catch(() => {}); } },
  };
}

// The tunnel's `screens` (screen-tunnel.mjs) for the key SECRET_KEY: the port it serves is the door's, and "viewers" are the
// live sessions, so a tunnel left behind by a restart (no sessions) closes by itself after the tunnel's GRACE/IDLE.
export const secretScreens = ({ door, sessions }) => ({ portsOf: () => (door.port ? { webPort: door.port } : null), viewers: () => sessions.count() });
