// src/tools/ask-spine.mjs — what a BOXED BEING runs to ask its spine for the browser:
//
//     node "$EGPT_ASK_SPINE" browser start
//     node "$EGPT_ASK_SPINE" browser login [site]
//
// The vocabulary is `browser start` (carries NOTHING: the spine decides what is launched, on which
// port, with which profile) and `browser login` (operator 2026-10-12: a being triggers the SAME
// auto-login /login runs, for its OWN group — it may name only the `site` it is stuck on, and the
// spine reads and types the credential, never the being; src/shell/being.mjs header). This script
// only carries the request:
// it reads the port and its own session secret from the environment the spine handed the boxed
// session (src/spine/being-link.mjs mints both), dials /being on 127.0.0.1, answers the challenge
// with that secret — which never leaves this process (src/shell/auth.mjs) — sends the request,
// prints ONE line, and exits 0 when the spine says ok and 1 otherwise.
//
// It runs AS THE BEING (a pool account), so where it lives decides nothing about what it may do;
// the spine's end is the enforcement point. It lives in the eGPT checkout every pool profile
// mounts, because that is the tree a pool account's Node can actually load a script from
// (askSpineClientPath's header, src/spine/being-link.mjs).
//
// It dials with Node's built-in WebSocket and imports only node: builtins and relative files, so an
// `npm install` emptying node_modules mid-turn cannot cut the link (2026-10-26). `ws` is loaded only
// when config shell.being_native_websocket is false.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAuthFrame, responseFrame } from '../shell/auth.mjs';
import { BEING_PATH, SPINE_PORT_ENV, BEING_TOKEN_ENV, NATIVE_WS_ENV, askFrame, parseAskFrame } from '../shell/being.mjs';

const USAGE = 'usage: node "$EGPT_ASK_SPINE" browser start | node "$EGPT_ASK_SPINE" browser login [site]';
// The spine waits up to 20 s for a cold Chrome to bind its CDP port (commands.mjs), so the client
// waits a good deal longer than that before it calls the spine silent.
const ANSWER_TIMEOUT_MS = 60_000;

/**
 * Ask the spine, once. Never throws; resolves { code, line } — the exit code and the one line.
 * @param {object} o
 * @param {string[]} o.argv   the words after the script: exactly `browser start`
 * @param {object}   o.env    the environment (process.env) — the spine's three variables live here
 * @param {typeof globalThis.WebSocket} [o.WebSocket]  INJECTION SEAM — default: the built-in, or `ws` when EGPT_NATIVE_WEBSOCKET=0
 * @param {number} [o.timeoutMs]
 */
export function askSpine({ argv = [], env = {}, WebSocket, timeoutMs = ANSWER_TIMEOUT_MS } = {}) {
  const fail = (line) => Promise.resolve({ code: 1, line: `ask-spine: ${line}` });
  const [ask = '', action = '', ...rest] = argv;
  // The requests, spelled exactly. Anything else is refused HERE rather than sent: the spine would
  // refuse it too, and a being should learn the vocabulary without a round trip. `browser login`
  // may carry the one site the being is stuck on (the same parameter /login takes); start carries
  // nothing.
  if (ask !== 'browser') return fail(`the spine serves browser requests — ${USAGE}`);
  let site = '';
  if (action === 'start') { if (rest.length) return fail(`browser start takes no arguments — ${USAGE}`); }
  else if (action === 'login') { if (rest.length > 1) return fail(`browser login takes at most a site — ${USAGE}`); site = rest[0] || ''; }
  else return fail(`the spine serves browser start and browser login — ${USAGE}`);
  return dialSpine({ env, ask, action, site, WebSocket, timeoutMs }).then(({ ws, result: r, line }) => {
    ws?.close();
    if (!r) return { code: 1, line: `ask-spine: ${line}` };
    if (action === 'login') {
      // r.detail is the limb's OUTCOME TOKEN (logged-in | needs-2fa | captcha-posted | no-credential
      // | failed), or the link's own detail on a refusal — never the credential (src/spine/login.mjs).
      if (r.ok) return { code: 0, line: `ask-spine: browser login — ${r.detail}` };
      return { code: 1, line: `ask-spine: browser login — ${r.reason && r.reason !== r.detail ? `${r.reason}: ` : ''}${r.detail || 'failed'}` };
    }
    if (r.ok) return { code: 0, line: `ask-spine: browser start — ${r.launched ? 'started' : 'already running'}: ${r.detail}` };
    if (r.reason === 'launch-failed') return { code: 1, line: `ask-spine: browser start FAILED — ${r.detail}` };
    return { code: 1, line: `ask-spine: browser start REFUSED (${r.reason || 'no reason given'}) — ${r.detail}` };
  });
}

// THE DIAL, shared with cdp.mjs's createLinkTransport: one request, resolved { ws, result } at an ok
// answer — the socket left open, so a `browser cdp` answer is a tunnel from then on — else
// { line, result? }. Never throws.
export async function dialSpine({ env, ask, action, site = '', WebSocket, timeoutMs = ANSWER_TIMEOUT_MS }) {
  const fail = (line) => Promise.resolve({ line });
  const secret = String(env[BEING_TOKEN_ENV] ?? '').trim();
  const port = Number(env[SPINE_PORT_ENV]);
  if (!secret || !Number.isInteger(port) || port <= 0 || port >= 65536) {
    return fail(`not a boxed session — this environment carries no ${BEING_TOKEN_ENV}/${SPINE_PORT_ENV}, which the spine hands only to a boxed being's session. Nothing was asked.`);
  }
  if (!WebSocket) {
    try { WebSocket = env[NATIVE_WS_ENV] === '0' ? (await import('ws')).WebSocket : globalThis.WebSocket; }
    catch (e) { return fail(`${NATIVE_WS_ENV}=0 and the ws package will not load — ${e?.message ?? e}`); }
  }

  const where = `127.0.0.1:${port}`;
  return new Promise((resolve) => {
    let settled = false, opened = false, timer = null, ws = null;
    const done = (line, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (result?.ok) { ws.removeEventListener('message', onMessage); resolve({ ws, result }); return; }
      try { ws?.close?.(); } catch { /* closing */ }
      resolve({ line, result });
    };
    try { ws = new WebSocket(`ws://${where}${BEING_PATH}`); }
    catch (e) { done(`spine unreachable on ${where} — ${e?.message ?? e}`); return; }
    timer = setTimeout(() => done(`the spine on ${where} gave no answer within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    // The built-in's error event carries no detail; ws's does.
    const why = (e) => (e?.message ? ` — ${e.message}` : '');
    ws.addEventListener('open', () => { opened = true; });
    ws.addEventListener('error', (e) => done(opened
      ? `the connection to the spine on ${where} failed${why(e)}`
      : `spine unreachable on ${where}${why(e)}`));
    // Text frames arrive as strings, from both clients.
    const onMessage = ({ data }) => {
      const auth = parseAuthFrame(data);
      if (auth?.auth === 'challenge') {
        // The answer and the request go out together: the limb reads them in order, and a request
        // it receives before trusting this connection is dropped, never replayed.
        ws.send(responseFrame(secret, auth.nonce));
        ws.send(askFrame({ ask, action, site }));
        return;
      }
      const r = parseAskFrame(data);
      if (r?.ask === 'result') done('', r);
    };
    ws.addEventListener('message', onMessage);
    // A close with no answer, after the connection was up: the limb drops a being whose secret it
    // does not recognise without a word — a stranger is told nothing — so this is the refusal.
    ws.addEventListener('close', () => done(opened
      ? `REFUSED — the spine on ${where} closed the connection without an answer: this session's credential is unknown to it or was revoked (a spine restart forgets every credential; the next turn's session gets a new one)`
      : `spine unreachable on ${where}`));
  });
}

// Run as a script. Compared through realpathSync.native, which a pool account CAN do (it resolves
// by handle — setup/SANDBOX.md's traverse table), and case-folded on Windows, so a path handed in
// through a junction or in another case still counts as "this file".
const invokedDirectly = (() => {
  try {
    const norm = (p) => { const r = realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
    return !!process.argv[1] && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
if (invokedDirectly) {
  const { code, line } = await askSpine({ argv: process.argv.slice(2), env: process.env });
  (code === 0 ? console.log : console.error)(line);
  process.exitCode = code;
}
