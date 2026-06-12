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
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
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
  // transcriptPath: when set, every turn (incoming + Don's reply) is appended
  // here, and the server SHOWS it — GET /transcript (raw markdown) and GET /
  // (a dead-simple auto-refreshing view). Operator 2026-06-11: "the server
  // could be showing transcript.md" — so the Wren<->Don chatter is watchable
  // in a browser, no surface/bot/WhatsApp needed. The view is UNAUTHENTICATED
  // (read-only, LAN-firewalled); only /v1/turn (which runs tools) is HMAC-gated.
  transcriptPath = null,
  onLog = () => {},
} = {}) {
  if (!keyB64) throw new Error('startAgentServer: keyB64 (agent_token) is required');
  if (typeof runTurn !== 'function') throw new Error('startAgentServer: runTurn is required');

  const logTurn = (who, text) => {
    if (!transcriptPath) return;
    try { mkdirSync(dirname(transcriptPath), { recursive: true }); appendFileSync(transcriptPath, `## ${new Date().toISOString()} — ${who}\n${text}\n\n`); }
    catch (e) { onLog(`agent: transcript append failed — ${e?.message ?? e}`); }
  };
  const readTranscript = () => { try { return readFileSync(transcriptPath, 'utf8'); } catch { return '(no turns yet)'; } };

  const server = createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && req.url === '/v1/health') {
      return json(200, { ok: true, role: 'agent', name });
    }
    // Live transcript view (unauthenticated read-only) — the server showing
    // transcript.md. GET /transcript = raw; GET / = auto-refreshing page.
    if (req.method === 'GET' && transcriptPath && (req.url === '/transcript' || req.url === '/')) {
      const md = readTranscript();
      if (req.url === '/transcript') { res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' }); return res.end(md); }
      const esc = md.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=3><title>${name} transcript</title><body style="font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;background:#111;color:#ddd;margin:0;padding:1rem"><pre>${esc}</pre>`);
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
      let message, from;
      try { const o = JSON.parse(body.toString('utf8')); message = o.message; from = typeof o.from === 'string' && o.from.trim() ? o.from.trim() : 'spine'; } catch { return json(400, { ok: false, error: 'bad json' }); }
      if (!message || typeof message !== 'string') return json(400, { ok: false, error: 'missing message' });

      const t0 = Date.now();
      try {
        logTurn(from, message);                 // record the incoming turn before Don answers
        const out = await runTurn(message);
        const text = String(out?.text ?? '').trim();
        const ms = Date.now() - t0;
        if (!text) { onLog(`agent: turn produced no text (${ms}ms)`); return json(422, { ok: false, error: 'empty reply', ms }); }
        logTurn(name, text);                     // record Don's reply
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
// Uses the claude-code (CLI) brain — NOT claude-sdk — on purpose: the SDK's
// query({resume}) re-sends the full conversation history client-side, and a
// long tool-heavy session (Don / 23dfef93) trips the API on a legacy content
// block ("Input tag 'fallback'", verified 2026-06-12). The CLI's `--resume`
// resumes SERVER-SIDE (the server holds the history) and survives. So @d can
// be a warm pre-existing session, not just a clean one.
//
// CHAT-ONLY by default (step 1): no allowedTools passed → the CLI in --print
// mode refuses every tool. This is deliberately even tighter than read-only,
// because the CLI's `--allowedTools Read` BYPASSES path scoping (the ~/.egpt
// secret-read leak the SDK brain's settingSources:[] was built to close — see
// claude-sdk.mjs). Read tools wait until that confinement is solved on the CLI
// path (or @d moves to the SDK brain + a clean session). Step 1 only needs Don
// to talk. The brain import is LAZY so this module/tests never load it unless
// the real runner is constructed.
export function makeClaudeResumeRunner({
  sessionId,
  cwd = REPO_DIR,
  allowedTools = [],
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
  const tools = Array.isArray(allowedTools) ? allowedTools : String(allowedTools).trim().split(/\s+/).filter(Boolean);

  return async function runTurn(message) {
    const brain = await import('../../config/brains/claude-code.mjs');
    // Resume mode sends the new turn as `message`; a fresh start (no session
    // yet) sends it as `history` (the initial prompt), then threads the
    // server-assigned id forward.
    const res = await brain.stream(
      current ? { message } : { history: message },
      () => {},
      { sessionId: current, cwd, ...(tools.length ? { allowedTools: tools } : {}), ...(model ? { model } : {}), onLog },
    );
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
export async function postAgentTurn(message, { endpoint, keyB64, from, timeoutMs = 600_000 }, log = () => {}) {
  const body = Buffer.from(JSON.stringify({ message: String(message ?? ''), ...(from ? { from } : {}) }), 'utf8');
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
