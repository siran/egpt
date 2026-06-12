// agent-endpoint.mjs — Don (@d): a Claude agent on DOLLY, reachable over the
// LAN as a remote egpt room member (operator 2026-06-11).
//
// Topology mirror of the transcriptor: the MAIN spine POSTs a room turn here,
// this worker resumes a pinned claude-code/SDK session and returns the reply
// text. Same HMAC-over-the-LAN auth as the transcriptor (see transcriptor.mjs),
// a DIFFERENT shared secret (agent_token) because this endpoint can run TOOLS —
// a narrower blast radius than reusing the transcription token.
//
// Why this and not a brand-new agent: @d IS a resumable Claude Code session
// (Don). egpt already resumes sessions by id (config/brains/claude-sdk.mjs's
// `stream({message},_,{sessionId})`), with a proven read-only/confinement model
// (buildSdkOptions + the PreToolUse write-deny hook). This endpoint is just the
// LAN doorway to that machinery — it adds NO new agent logic, only transport +
// auth + session-id threading.
//
// READ-ONLY FIRST (operator): the default runner confines tools to Read/Grep/
// Glob/WebFetch inside the repo and denies writes/bash. Widen deliberately once
// the loop is proven.
//
// Protocol:
//   GET  /v1/health            → 200 { ok, role:'agent', name }              (no auth)
//   POST /v1/turn  <json>      → 200 { ok, text, ms }
//        body: { message: "<the new room turn text>" }
//        headers: x-egpt-ts (epoch ms), x-egpt-sig (base64url HMAC over the body)
//        401 bad/stale sig · 400 missing message · 422 empty reply · 500 runner error

import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyFromString } from './bus-sign.mjs';

export const AGENT_DEFAULT_PORT = 23391;
const MAX_BODY_BYTES = 1 * 1024 * 1024;   // a room turn is text; 1MB is generous
const SIG_MAX_AGE_MS = 60_000;
const REPO_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', '..');   // src/tools/ -> repo root

// HMAC over `${ts}.${sha256(body)}` with the shared agent_token. Same scheme as
// the transcriptor's signer (kept as its own copy here so this endpoint's auth
// is self-contained; a later cleanup can unify the two into one lan-auth
// helper). Exported so a client (the spine's `don` brain adapter, and tests)
// signs identically.
export function signBody(keyB64, tsMs, body) {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', Buffer.from(keyFromString(keyB64)))
    .update(`${tsMs}.${bodyHash}`)
    .digest('base64url');
}

function _sigOk(keyB64, tsMs, body, sig) {
  if (!sig || !tsMs) return false;
  if (Math.abs(Date.now() - Number(tsMs)) > SIG_MAX_AGE_MS) return false;
  const expect = Buffer.from(signBody(keyB64, tsMs, body));
  const got = Buffer.from(String(sig));
  return expect.length === got.length && timingSafeEqual(expect, got);
}

// ── worker side ─────────────────────────────────────────────────────────
// Starts the agent HTTP server. `runTurn(message) -> { text }` is injectable;
// the default (makeClaudeResumeRunner) resumes the pinned session. Returns
// { port, close }.
export async function startAgentServer({
  port = AGENT_DEFAULT_PORT,
  bind = '127.0.0.1',
  keyB64,
  name = 'don',
  runTurn,
  onLog = () => {},
} = {}) {
  if (!keyB64) throw new Error('startAgentServer: keyB64 (agent_token) is required');
  if (typeof runTurn !== 'function') throw new Error('startAgentServer: runTurn is required');

  const server = createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && req.url === '/v1/health') {
      return json(200, { ok: true, role: 'agent', name });
    }
    if (req.method !== 'POST' || req.url !== '/v1/turn') {
      return json(404, { ok: false, error: 'not found' });
    }

    const chunks = [];
    let size = 0, overflow = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY_BYTES) { overflow = true; req.destroy(); return; } chunks.push(c); });
    req.on('error', () => { /* destroyed on overflow / client drop */ });
    req.on('end', async () => {
      if (overflow) return json(413, { ok: false, error: 'body too large' });
      const body = Buffer.concat(chunks);
      if (!_sigOk(keyB64, req.headers['x-egpt-ts'], body, req.headers['x-egpt-sig'])) {
        onLog(`agent: REJECTED unsigned/stale turn from ${req.socket.remoteAddress} (${body.length}b)`);
        return json(401, { ok: false, error: 'bad signature' });
      }
      let message;
      try { message = JSON.parse(body.toString('utf8')).message; } catch { return json(400, { ok: false, error: 'bad json' }); }
      if (!message || typeof message !== 'string') return json(400, { ok: false, error: 'missing message' });

      const t0 = Date.now();
      try {
        const out = await runTurn(message);
        const text = String(out?.text ?? '').trim();
        const ms = Date.now() - t0;
        if (!text) { onLog(`agent: turn produced no text (${ms}ms)`); return json(422, { ok: false, error: 'empty reply', ms }); }
        onLog(`agent: turn ${message.length}ch -> ${text.length}ch in ${ms}ms for ${req.socket.remoteAddress}`);
        return json(200, { ok: true, text, ms });
      } catch (e) {
        onLog(`agent: turn ERROR — ${e?.message ?? e}`);
        return json(500, { ok: false, error: String(e?.message ?? e) });
      }
    });
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, bind, resolveListen);
  });
  const actualPort = server.address().port;
  onLog(`agent: '${name}' listening on ${bind}:${actualPort}`);
  return {
    port: actualPort,
    close: () => { try { server.closeAllConnections?.(); } catch { /* node <18.2 */ } server.close(); },
  };
}

// Default runner: resume the pinned Claude session via the claude-sdk brain and
// return its reply. Threads the session id FORWARD across turns (claude resume
// may mint a fresh id each turn; without threading we'd keep resuming the
// original and lose intermediate turns) and persists it to a sidecar so an
// endpoint restart continues the latest, not the pinned origin.
//
// READ-ONLY by default: tools confined to Read/Grep/Glob/WebFetch inside the
// repo, writes + bash denied (buildSdkOptions confinement). The claude-sdk
// import is LAZY so this module (and its tests) never loads the SDK unless the
// real runner is actually constructed.
export function makeClaudeResumeRunner({
  sessionId,
  cwd = REPO_DIR,
  allowedTools = ['Read', 'Grep', 'Glob', 'WebFetch'],
  confineToDirs = [REPO_DIR],
  model,
  onLog = () => {},
  stateDir = join(homedir(), '.egpt', 'state'),
  sidecarName = 'agent-don-session.txt',
} = {}) {
  const sidecar = join(stateDir, sidecarName);
  let current = sessionId ?? null;
  // Sidecar (latest threaded id) wins over the configured origin — it's where
  // the conversation actually is after prior turns.
  try { const s = readFileSync(sidecar, 'utf8').trim(); if (s) current = s; } catch { /* fresh */ }

  return async function runTurn(message) {
    const sdk = await import('../../config/brains/claude-sdk.mjs');
    const res = await sdk.stream({ message }, () => {}, {
      sessionId: current,
      cwd,
      allowedTools,
      confineToDirs,
      ...(model ? { model } : {}),
      onLog,
    });
    const next = res?.optionsPatch?.sessionId;
    if (next && next !== current) {
      current = next;
      try { mkdirSync(stateDir, { recursive: true }); writeFileSync(sidecar, current + '\n', { mode: 0o600 }); }
      catch (e) { onLog(`agent: session-sidecar persist failed — ${e?.message ?? e}`); }
    }
    return { text: res?.text ?? '' };
  };
}

// ── spine side ──────────────────────────────────────────────────────────
// POST one room turn to a Don endpoint, return the reply text. Throws on
// transport/auth/empty so the caller (the spine's `don` brain) can surface it.
export async function postAgentTurn(message, { endpoint, keyB64, timeoutMs = 600_000 }, log = () => {}) {
  const body = Buffer.from(JSON.stringify({ message: String(message ?? '') }), 'utf8');
  const ts = Date.now();
  const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-egpt-ts': String(ts), 'x-egpt-sig': signBody(keyB64, ts, body) },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok || !j.text) throw new Error(`agent ${res.status}: ${j.error ?? 'no text'}`);
  log(`agent: remote turn -> ${j.text.length}ch in ${j.ms ?? '?'}ms`);
  return j.text;
}
