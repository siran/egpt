// http-secrets.mjs — the operator's secrets page (/<handle> secret): the node's secrets (secrets.mjs) and the team's,
// edited from a browser. Mounted by http.mjs under <ayde.path>/secret/<session token>/ — the one prefix a public proxy
// already routes — but its auth is the session token, NOT ayde's Basic login:
//   <token>/claim         POST, once: the first browser to press Open owns the session (cookie secret_session, HttpOnly, Secure,
//                         SameSite=Strict, Path=<prefix>, a hash of it kept here); until then <token>[/] shows only an Open button
//                         (link-preview bots GET it), and every other route is 404; after it, every route needs the cookie
//   <token>[/]            the page (http-secrets.html; ?name=<secret> opens on that one)
//   <token>/page.js       its script;  <token>/crypto.js  http-secrets-crypto.mjs: what locks a value in the browser
//   <token>/api/list      {who, expires, secrets: [{name, locked, created_by, created_at, changed_by, changed_at}]}
//   <token>/api/secret?name=<name>   {secret: {name, value (as stored), locked, …meta}, history: [{stamp, value, …}]}
//   <token>/api/save      POST {name, value[, from]}: stores the value as sent (the browser sends an enc:v1: string when a password
//                         was typed; the password never reaches here), keeping the old one in the history; from ≠ name renames first
// A session (createSecretSessions): 32 random bytes, base64url, in memory, 15 minutes from /secret, bound to who asked.
// Unknown or expired → 404, nothing revealed. Every save and rename is audited (audit(), never the value).
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { getSecret, listSecrets, saveSecret, secretHistory, MAX_SECRET_BYTES } from '../secrets.mjs';

export const SECRET_SESSION_MS = 15 * 60_000;
const file = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const COOKIE = 'secret_session';
const sha = (v) => createHash('sha256').update(v).digest();
const CLAIM_PAGE = (action) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>Secrets</title>
<form method="post" action="${action}"><p>The first browser to open this link owns it.</p><button type="submit">Open</button></form></html>
`;
const PAGE = file('http-secrets.html'), SCRIPT = file('http-secrets.js'), CRYPTO = file('http-secrets-crypto.mjs');

export function createSecretSessions({ now = () => Date.now(), ttlMs = SECRET_SESSION_MS } = {}) {
  const live = new Map();   // token → { who, expires }
  return {
    // → { token, expires (ms) }
    open(who) {
      const token = randomBytes(32).toString('base64url'), expires = now() + ttlMs;
      live.set(token, { who: String(who), expires });
      return { token, expires };
    },
    // → { who, expires[, claim] } or null; claim: the owner cookie's sha256, once claimed; compared in constant time against every live token
    check(token) {
      const n = now();
      for (const [t, s] of live) if (s.expires <= n) live.delete(t);
      const given = Buffer.from(String(token ?? ''));
      let hit = null;
      for (const [t, s] of live) {
        const have = Buffer.from(t);
        if (have.length === given.length && timingSafeEqual(have, given)) hit = s;
      }
      return hit;
    },
  };
}

// serve(req, res, sub): sub = the path parts after <base>secret/ ([token, …rest]). base: '/ayde/'.
export function createSecretsPage({ home, sessions, base, json, readBody, audit = () => {}, now = () => Date.now(), log = () => {} }) {
  const headers = (type, csp = "default-src 'none'") => ({
    'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': csp,
  });
  const text = (res, type, body, csp) => { res.writeHead(200, headers(type, csp)); res.end(body); };
  const fail = (res, status, error) => json(res, status, { error }, headers('application/json; charset=utf-8'));
  const send = (res, body) => json(res, 200, body, headers('application/json; charset=utf-8'));

  return async function serve(req, res, url, [token, ...rest]) {
    const session = sessions.check(token);
    if (!session) return fail(res, 404, 'not found');
    const route = rest.join('/');
    const prefix = `${base}secret/${token}`;
    if (!session.claim) {   // not claimed: the Open button (a GET changes nothing) or the claim itself, nothing else
      if (route === '' && req.method === 'GET') return text(res, 'text/html; charset=utf-8', CLAIM_PAGE(`${prefix}/claim${url.search.replace(/[^?&=\w.%-]/g, '')}`), "default-src 'none'; form-action 'self'");
      if (route !== 'claim' || req.method !== 'POST') return fail(res, 404, 'not found');
      const cookie = randomBytes(32).toString('base64url');
      session.claim = sha(cookie);
      const maxAge = Math.max(1, Math.ceil((session.expires - now()) / 1000));
      log(`secrets page opened by ${session.who}'s link`);
      try { audit({ action: 'opened', who: session.who }); } catch (e) { log(`secret audit failed — ${e?.message ?? e}`); }
      res.writeHead(303, { ...headers('text/plain'), Location: `${prefix}${url.search}`, 'Set-Cookie': `${COOKIE}=${cookie}; HttpOnly; Secure; SameSite=Strict; Path=${prefix}; Max-Age=${maxAge}` });
      return res.end();
    }
    const given = /(?:^|;\s*)secret_session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
    if (!given || !timingSafeEqual(sha(given), session.claim)) return fail(res, 404, 'not found');   // claimed by another browser, or a second claim
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
        try { audit({ name: r.action === 'renamed' ? `${from} → ${name}` : name, action: r.action, who: session.who, kind }); } catch (e) { log(`secret audit failed — ${e?.message ?? e}`); }
        return send(res, { ok: true, action: r.action, secret: getSecret(home, name), history: secretHistory(home, name) });
      } catch (e) { return fail(res, 400, e?.message ?? String(e)); }
    }
    return fail(res, 404, 'not found');
  };
}
