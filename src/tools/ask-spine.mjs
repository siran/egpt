// src/tools/ask-spine.mjs — what a BOXED BEING runs to ask its spine for the browser:
//
//     node "$EGPT_ASK_SPINE" browser start
//
// The whole vocabulary today is that one request (operator 2026-09-26: "for now only the
// browser"), and the being passes NOTHING with it: the spine decides what is launched, on which
// port, with which profile (src/shell/being.mjs header). This script only carries the request:
// it reads the port and its own session secret from the environment the spine handed the boxed
// session (src/spine/being-link.mjs mints both), dials /being on 127.0.0.1, answers the challenge
// with that secret — which never leaves this process (src/shell/auth.mjs) — sends the request,
// prints ONE line, and exits 0 when the spine says ok and 1 otherwise.
//
// It runs AS THE BEING (a pool account), so where it lives decides nothing about what it may do;
// the spine's end is the enforcement point. It lives in the eGPT checkout every pool profile
// mounts, because that is the tree a pool account's Node can actually load a script from
// (askSpineClientPath's header, src/spine/being-link.mjs).
import { WebSocket as WS } from 'ws';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAuthFrame, responseFrame } from '../shell/auth.mjs';
import { BEING_PATH, SPINE_PORT_ENV, BEING_TOKEN_ENV, askFrame, parseAskFrame } from '../shell/being.mjs';

const USAGE = 'usage: node "$EGPT_ASK_SPINE" browser start';
// The spine waits up to 20 s for a cold Chrome to bind its CDP port (commands.mjs), so the client
// waits a good deal longer than that before it calls the spine silent.
const ANSWER_TIMEOUT_MS = 60_000;

/**
 * Ask the spine, once. Never throws; resolves { code, line } — the exit code and the one line.
 * @param {object} o
 * @param {string[]} o.argv   the words after the script: exactly `browser start`
 * @param {object}   o.env    the environment (process.env) — the spine's three variables live here
 * @param {typeof WS} [o.WebSocket]  INJECTION SEAM — the `ws` client constructor
 * @param {number} [o.timeoutMs]
 */
export function askSpine({ argv = [], env = {}, WebSocket = WS, timeoutMs = ANSWER_TIMEOUT_MS } = {}) {
  const fail = (line) => Promise.resolve({ code: 1, line: `ask-spine: ${line}` });
  const [ask = '', action = '', ...rest] = argv;
  // The one request, spelled exactly. Anything else is refused HERE rather than sent: the spine
  // would refuse it too, and a being should learn the vocabulary without a round trip.
  if (ask !== 'browser' || action !== 'start' || rest.length) return fail(`the spine serves exactly one request — ${USAGE}`);

  const secret = String(env[BEING_TOKEN_ENV] ?? '').trim();
  const port = Number(env[SPINE_PORT_ENV]);
  if (!secret || !Number.isInteger(port) || port <= 0 || port >= 65536) {
    return fail(`not a boxed session — this environment carries no ${BEING_TOKEN_ENV}/${SPINE_PORT_ENV}, which the spine hands only to a boxed being's session. Nothing was asked.`);
  }

  const where = `127.0.0.1:${port}`;
  return new Promise((resolve) => {
    let settled = false, opened = false, timer = null, ws = null;
    const done = (code, line) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws?.close?.(); } catch { /* closing */ }
      resolve({ code, line: `ask-spine: ${line}` });
    };
    try { ws = new WebSocket(`ws://${where}${BEING_PATH}`); }
    catch (e) { done(1, `spine unreachable on ${where} — ${e?.message ?? e}`); return; }
    timer = setTimeout(() => done(1, `the spine on ${where} gave no answer within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    ws.on('open', () => { opened = true; });
    ws.on('error', (e) => done(1, opened
      ? `the connection to the spine on ${where} failed — ${e?.message ?? e}`
      : `spine unreachable on ${where} — ${e?.message ?? e}`));
    ws.on('message', (buf) => {
      const auth = parseAuthFrame(buf);
      if (auth?.auth === 'challenge') {
        // The answer and the request go out together: the limb reads them in order, and a request
        // it receives before trusting this connection is dropped, never replayed.
        ws.send(responseFrame(secret, auth.nonce));
        ws.send(askFrame({ ask, action }));
        return;
      }
      const r = parseAskFrame(buf);
      if (r?.ask !== 'result') return;
      if (r.ok) done(0, `browser start — ${r.launched ? 'started' : 'already running'}: ${r.detail}`);
      else if (r.reason === 'launch-failed') done(1, `browser start FAILED — ${r.detail}`);
      else done(1, `browser start REFUSED (${r.reason || 'no reason given'}) — ${r.detail}`);
    });
    // A close with no answer, after the connection was up: the limb drops a being whose secret it
    // does not recognise without a word — a stranger is told nothing — so this is the refusal.
    ws.on('close', () => done(1, opened
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
