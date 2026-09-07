// beeper-mint-token.mjs — GET A TOKEN FOR A RUNNING BEEPER DESKTOP WITHOUT TOUCHING ITS SETTINGS UI.
//
// A Beeper token belongs to ONE INSTALL, not to an account (see beeper-whoami.mjs). So a Desktop
// that is running, logged in and answering on loopback can still be unreachable to this node for
// the boring reason that nobody ever minted a token ON IT — beeper-whoami reports that install as
// "up, no token of ours works". The documented cure is Settings > Developer > Desktop API in that
// Desktop's own window, which is fine for the Session 1 GUI and useless for a Session 0 service
// that has no window to click in.
//
// There is a second door, and it is the same one MCP clients use: the Desktop API ships a local
// OAuth 2.1 authorization server (GET /.well-known/oauth-authorization-server on the API port).
// Dynamic client registration is open, the only grant is authorization_code + PKCE, and consent is
// not a web form — POSTing /oauth/authorize/callback raises the approve/deny prompt INSIDE the
// Beeper app and blocks until someone answers it. So this tool is scriptable end to end except for
// one click, and that click is the point: it is what stops any process on the box from minting
// itself a key to your messages.
//
//   node src/tools/beeper-mint-token.mjs                 # mint against 23373 (the usual S1 GUI)
//   node src/tools/beeper-mint-token.mjs --port 23378    # ...or whichever install needs a key
//   node src/tools/beeper-mint-token.mjs --name rodz-s1  # what the prompt calls the client
//   node src/tools/beeper-mint-token.mjs --json          # machine-readable {token, account, port}
//
// Prints the token and the account it turned out to belong to. It does NOT write config.yaml:
// which connection name it should land under, and whether it replaces one already there, is a
// decision with a blast radius, so paste it yourself under beeper.<name>.token.
//
// LIMIT, MEASURED not assumed (2026-09-07, reve): the approve prompt appears in the TARGET
// Desktop's window, so aimed at a Session 0 install it HANGS FOREVER rather than failing — there
// is no window on your desktop to answer it in. Verified: 23373 (S1 GUI) returned a token in ~7s
// once approved; 23374 (S0 service, same account) was still blocked at 20s with nothing shown
// anywhere. Kill it and use another route for S0: adopt the profile
// (setup/adopt-beeper-profile.ps1), or mint in S1 before handing the profile over.
//
// TO UNDO ONE (verified same day): POST /oauth/revoke with body token=<the token> answers 200 and
// the token 401s immediately after. Mint freely; the throwaways cost nothing to retire.

import { createHash, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const PORT = Number(flag('port', 23373));
const CLIENT_NAME = flag('name', 'egpt');
const JSON_OUT = args.includes('--json');
const REDIRECT_URI = 'http://127.0.0.1:1/egpt-mint';  // never dialled: we read the code off the POST
const BASE = `http://127.0.0.1:${PORT}`;

const say = (...m) => { if (!JSON_OUT) console.log(...m); };
const die = (msg) => { console.error(msg); process.exit(1); };

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function api(path, init = {}) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function main() {
  // 1. Is anything there, and does it speak OAuth? A Beeper API answers /.well-known even unauthed.
  let meta;
  try {
    const r = await api('/.well-known/oauth-authorization-server');
    if (r.status !== 200) die(`${BASE}: no OAuth metadata (HTTP ${r.status}) — is this a Beeper Desktop API port?`);
    meta = r.body;
  } catch (e) {
    die(`${BASE}: nothing listening (${e?.message ?? e}). Run beeper-whoami.mjs --ports for the live map.`);
  }
  say(`${BASE} — Beeper Desktop API, OAuth issuer ${meta.issuer}`);

  // 2. Register a client. Open registration, auth method "none" — the PKCE verifier is the secret.
  const reg = await api('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (reg.status !== 200 && reg.status !== 201) die(`register failed: HTTP ${reg.status} ${JSON.stringify(reg.body)}`);
  const clientID = reg.body.client_id;

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  // 3. Consent. This BLOCKS in the Beeper app until the human answers, so say so before waiting.
  say(`\n>>> APPROVE THE PROMPT IN BEEPER (it names the client "${CLIENT_NAME}"). Waiting...`);
  const auth = await api('/oauth/authorize/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'oauth2',
      clientInfo: { name: CLIENT_NAME, clientID },
      scopes: ['read', 'write'],
      redirectUri: REDIRECT_URI,
      scope: 'read write',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    }),
  });
  if (auth.status !== 200 || !auth.body?.code) {
    const why = auth.body?.error?.message || auth.body?.error || JSON.stringify(auth.body);
    die(`not authorized: ${why}\n(denied, timed out, or the prompt had no window to appear in — see LIMIT in this file's header)`);
  }

  // 4. Exchange. Public client: the verifier stands in for a client secret.
  const tok = await api('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: auth.body.code,
      redirect_uri: REDIRECT_URI,
      client_id: clientID,
      code_verifier: verifier,
    }),
  });
  if (tok.status !== 200 || !tok.body?.access_token) die(`token exchange failed: HTTP ${tok.status} ${JSON.stringify(tok.body)}`);
  const token = tok.body.access_token;

  // 5. Prove it. A token that cannot read /v1/accounts is not a token you want in config.yaml.
  const who = await api('/v1/accounts', { headers: { Authorization: `Bearer ${token}` } });
  if (who.status !== 200) die(`minted, but it does not authenticate: HTTP ${who.status} ${JSON.stringify(who.body)}`);
  const matrix = (Array.isArray(who.body) ? who.body : []).find((a) => a.accountID === 'matrix');
  const account = matrix?.user?.email || matrix?.loginID || '(unknown)';

  if (JSON_OUT) { console.log(JSON.stringify({ port: PORT, account, token }, null, 2)); return; }
  say(`\nAccount : ${account}`);
  say(`Port    : ${PORT}  (discovered at boot, not configured — do not pin it)`);
  say(`Token   : ${token}`);
  say(`\nPaste into ~/.egpt/config/config.yaml:\n`);
  say(`  beeper:\n    <name>:\n      account: ${account}\n      token: ${token}`);
}

main().catch((e) => die(String(e?.stack || e)));
