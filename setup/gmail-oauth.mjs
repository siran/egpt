#!/usr/bin/env node
// setup/gmail-oauth.mjs - one-time Gmail OAuth setup for eGPT.
//
// This helper uses Google's installed-app loopback flow. It never asks for a
// Gmail password; Google returns an authorization code to a localhost callback,
// then this script exchanges it for a refresh token and stores that token in
// ~/.egpt/config.local.json.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const PROFILE_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';

const DEFAULT_QUERY = 'in:inbox newer_than:7d';
const DEFAULT_POLL_SECONDS = 60;
const DEFAULT_MAX_RESULTS = 10;

const EGPT_HOME = join(homedir(), '.egpt');
const LOCAL_CONFIG_PATH = join(EGPT_HOME, 'config.local.json');

function usage() {
  return `Usage:
  node setup/gmail-oauth.mjs [options]
  npm run setup:gmail -- [options]

Options:
  --client-id <id>          Google OAuth desktop client ID
  --client-secret <secret>  Google OAuth client secret
  --refresh-token <token>   Use an existing refresh token instead of browser auth
  --login-hint <email>      Hint which Google account to show in the browser
  --compose                 Request gmail.compose and enable draft creation
  --no-compose              Request gmail.readonly only and disable draft creation
  --query <query>           Gmail search query (default: "${DEFAULT_QUERY}")
  --poll-seconds <n>        Poll cadence in seconds (default: ${DEFAULT_POLL_SECONDS})
  --max-results <n>         Messages to inspect per poll (default: ${DEFAULT_MAX_RESULTS})
  --notify-all              Notify on every new matching message
  --no-notify-all           Use importance rules only
  --no-browser              Print the consent URL instead of opening it
  --yes                     Use defaults for non-secret prompts
  --help                    Show this help

Environment fallbacks:
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN

Writes:
  ${LOCAL_CONFIG_PATH}
`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (key.startsWith('no-')) {
      out[key.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function makePkce() {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthUrl({ clientId, redirectUri, scopes, state, codeChallenge, loginHint }) {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scopes.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

async function createLoopbackReceiver(expectedState) {
  let settled = false;
  let timeout = null;
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    const finish = (status, body) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
      if (timeout) clearTimeout(timeout);
      server.close();
    };

    if (url.pathname !== '/oauth2/callback') {
      finish(404, '<h1>Not found</h1>');
      return;
    }
    if (settled) {
      finish(200, '<h1>Already handled</h1><p>You can close this tab.</p>');
      return;
    }

    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    settled = true;

    if (state !== expectedState) {
      rejectCode(new Error('OAuth state mismatch; refusing callback'));
      finish(400, '<h1>eGPT Gmail setup failed</h1><p>State mismatch. Return to the terminal.</p>');
      return;
    }
    if (error) {
      rejectCode(new Error(`Google OAuth returned ${error}`));
      finish(400, '<h1>eGPT Gmail setup cancelled</h1><p>Return to the terminal.</p>');
      return;
    }
    if (!code) {
      rejectCode(new Error('Google OAuth callback did not include a code'));
      finish(400, '<h1>eGPT Gmail setup failed</h1><p>No authorization code. Return to the terminal.</p>');
      return;
    }

    resolveCode(code);
    finish(200, '<h1>eGPT Gmail setup authorized</h1><p>You can close this tab and return to the terminal.</p>');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      server.close();
      rejectCode(new Error('Timed out waiting for the Google OAuth callback'));
    }
  }, 10 * 60 * 1000);
  timeout.unref?.();

  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('Could not open localhost OAuth listener');
  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth2/callback`,
    codePromise,
    close: () => server.close(),
  };
}

function openBrowser(url) {
  const stdio = 'ignore';
  const detached = true;
  const windowsHide = true;
  let child;
  if (platform() === 'win32') {
    child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached, stdio, windowsHide });
  } else if (platform() === 'darwin') {
    child = spawn('open', [url], { detached, stdio });
  } else {
    child = spawn('xdg-open', [url], { detached, stdio });
  }
  child.unref();
}

async function exchangeCodeForTokens({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.error_description ?? json.error ?? `${res.status} ${res.statusText}`;
    throw new Error(`OAuth token exchange failed: ${detail}`);
  }
  if (!json.refresh_token) {
    throw new Error('Google did not return a refresh_token. Re-run setup and approve consent, or revoke the old test grant first.');
  }
  return json;
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.error_description ?? json.error ?? `${res.status} ${res.statusText}`;
    throw new Error(`OAuth refresh failed: ${detail}`);
  }
  return json.access_token;
}

async function readGmailProfile(accessToken) {
  const res = await fetch(PROFILE_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.error?.message ?? `${res.status} ${res.statusText}`;
    throw new Error(`Gmail profile check failed: ${detail}`);
  }
  return json;
}

async function readLocalConfig() {
  try {
    const raw = await readFile(LOCAL_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e?.code === 'ENOENT') return {};
    throw new Error(`${LOCAL_CONFIG_PATH} is not valid JSON: ${e?.message ?? e}`);
  }
}

function mergeGmailConfig(existing, gmailPatch) {
  const out = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const prev = out.gmail && typeof out.gmail === 'object' && !Array.isArray(out.gmail) ? out.gmail : {};
  out.gmail = { ...prev, ...gmailPatch };
  return out;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function writeLocalConfig(config) {
  await mkdir(dirname(LOCAL_CONFIG_PATH), { recursive: true });
  if (existsSync(LOCAL_CONFIG_PATH)) {
    await copyFile(LOCAL_CONFIG_PATH, `${LOCAL_CONFIG_PATH}.bak-${timestamp()}`);
  }
  await writeFile(LOCAL_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function asInt(value, fallback, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    if (value !== undefined && value !== null && value !== '') throw new Error(`${label} must be a positive number`);
    return fallback;
  }
  return Math.round(n);
}

async function promptText(rl, label, fallback = '') {
  const suffix = fallback ? ` [${fallback}]` : '';
  const value = (await rl.question(`${label}${suffix}: `)).trim();
  return value || fallback;
}

async function promptRequired(rl, label, fallback = '') {
  const value = await promptText(rl, label, fallback);
  if (!value) throw new Error(`${label} is required`);
  return value;
}

async function promptSecret(rl, label, fallback = '') {
  const suffix = fallback ? ' [leave blank to keep existing]' : '';
  const value = (await rl.question(`${label}${suffix}: `)).trim();
  return value || fallback;
}

async function promptBool(rl, label, fallback) {
  const suffix = fallback ? ' [Y/n]' : ' [y/N]';
  const value = (await rl.question(`${label}${suffix}: `)).trim().toLowerCase();
  if (!value) return fallback;
  if (['y', 'yes', 'true', '1', 'on'].includes(value)) return true;
  if (['n', 'no', 'false', '0', 'off'].includes(value)) return false;
  throw new Error(`Expected yes or no for: ${label}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const existing = await readLocalConfig();
  const existingGmail = existing.gmail && typeof existing.gmail === 'object' ? existing.gmail : {};
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const nonInteractive = args.yes === true;
    const canPrompt = process.stdin.isTTY && process.stdout.isTTY && !nonInteractive;

    const requireValue = async (key, label, fallback = '') => {
      const cli = args[key];
      const value = typeof cli === 'string' ? cli.trim() : '';
      if (value) return value;
      if (fallback) return fallback;
      if (!canPrompt) throw new Error(`${label} required; pass --${key} or set an environment variable`);
      return promptRequired(rl, label);
    };

    const clientId = await requireValue(
      'client-id',
      'Google OAuth client ID',
      process.env.GOOGLE_CLIENT_ID ?? existingGmail.client_id ?? existingGmail.clientId ?? '',
    );
    const secretFromArg = typeof args['client-secret'] === 'string' ? args['client-secret'].trim() : '';
    const clientSecret = secretFromArg
      || process.env.GOOGLE_CLIENT_SECRET
      || (canPrompt
        ? await promptSecret(rl, 'Google OAuth client secret', existingGmail.client_secret ?? existingGmail.clientSecret ?? '')
        : (existingGmail.client_secret ?? existingGmail.clientSecret ?? ''));
    if (!clientSecret) throw new Error('Google OAuth client secret is required');

    const compose = args.compose === true
      ? true
      : args.compose === false
        ? false
        : canPrompt
          ? await promptBool(rl, 'Allow eGPT to create Gmail drafts', existingGmail.create_drafts === true)
          : existingGmail.create_drafts === true;
    const notifyAll = args['notify-all'] === true
      ? true
      : args['notify-all'] === false
        ? false
        : canPrompt
          ? await promptBool(rl, 'Notify on every matching message for smoke testing', existingGmail.notify_all ?? true)
          : (existingGmail.notify_all ?? true);
    const query = typeof args.query === 'string'
      ? args.query
      : canPrompt
        ? await promptText(rl, 'Gmail search query', existingGmail.query ?? DEFAULT_QUERY)
        : (existingGmail.query ?? DEFAULT_QUERY);
    const pollSeconds = asInt(args['poll-seconds'] ?? existingGmail.poll_seconds, DEFAULT_POLL_SECONDS, 'poll-seconds');
    const maxResults = asInt(args['max-results'] ?? existingGmail.max_results, DEFAULT_MAX_RESULTS, 'max-results');
    const loginHint = typeof args['login-hint'] === 'string' ? args['login-hint'].trim() : '';

    let refreshToken = typeof args['refresh-token'] === 'string'
      ? args['refresh-token'].trim()
      : process.env.GOOGLE_REFRESH_TOKEN ?? '';
    let accessToken = null;
    const scopes = compose ? [READONLY_SCOPE, COMPOSE_SCOPE] : [READONLY_SCOPE];

    if (!refreshToken) {
      const state = base64url(randomBytes(24));
      const pkce = makePkce();
      const receiver = await createLoopbackReceiver(state);
      const authUrl = buildAuthUrl({
        clientId,
        redirectUri: receiver.redirectUri,
        scopes,
        state,
        codeChallenge: pkce.challenge,
        loginHint,
      });

      process.stdout.write(`\nOpening Google consent in your browser.\n`);
      process.stdout.write(`If it does not open, paste this URL into a browser:\n\n${authUrl}\n\n`);
      if (args.browser !== false) {
        try { openBrowser(authUrl); } catch (e) { process.stderr.write(`Could not open browser: ${e?.message ?? e}\n`); }
      }

      const code = await receiver.codePromise;
      const tokens = await exchangeCodeForTokens({
        clientId,
        clientSecret,
        code,
        redirectUri: receiver.redirectUri,
        codeVerifier: pkce.verifier,
      });
      refreshToken = tokens.refresh_token;
      accessToken = tokens.access_token;
    }

    if (!accessToken) {
      accessToken = await refreshAccessToken({ clientId, clientSecret, refreshToken });
    }
    const profile = await readGmailProfile(accessToken);

    const next = mergeGmailConfig(existing, {
      enabled: true,
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      query,
      poll_seconds: pollSeconds,
      max_results: maxResults,
      notify_all: notifyAll,
      propose_response: existingGmail.propose_response ?? true,
      create_drafts: compose,
    });
    await writeLocalConfig(next);

    process.stdout.write(`\nGmail OAuth configured for ${profile.emailAddress ?? 'the selected account'}.\n`);
    process.stdout.write(`Wrote ${LOCAL_CONFIG_PATH}\n`);
    process.stdout.write(`Next: restart eGPT, then run /gmail status and /gmail poll.\n`);
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`\nsetup:gmail failed: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}

export {
  READONLY_SCOPE,
  COMPOSE_SCOPE,
  buildAuthUrl,
  makePkce,
  mergeGmailConfig,
  parseArgs,
};
