// src/shell/spine-link.mjs — the operator EDITOR's WebSocket CLIENT link to the spine.
//
// Topology (operator ruling 2026-08-26 — INVERTED from the original plan): the SPINE serves
// ws://127.0.0.1:23375 and holds that port from boot; this editor DIALS IN and proves it holds
// the node's shell token. The durable process serves, the transient one connects — and because
// the spine never lets the port go unbound, there is no window for a local squatter to take it
// and receive the operator's console traffic (src/bridges/shell-port.mjs header for the full
// reasoning). This module is that client, kept to pure transport with no Ink — the frame
// protocol is the ONLY contract with the spine:
//   • spine → editor : a JSON line `{ text, chatId }`  → surfaced via onSpineMessage()
//   • editor → spine : a JSON line `{ text, chatId? }` → pushed by send() (MVP: `{ text }`)
// Exactly mirrors shell-port's `send(chatId, text)` / `toInbound(raw)` shapes so the two
// ends align. One console → one spine connection.
//
// Nudge: on start this editor drops a `/shell-connect` marker into EGPT_HOME/state/ingest —
// the spine's ingest watcher (polls every 1s) reads it and pokes the shell-port limb. Normally
// that limb is already listening and the poke is a no-op; it matters when the spine's BIND
// failed (something else held 23375) and it is backing off — the announce makes it retry now
// instead of leaving the operator's editor dialing a port nobody serves.
import { WebSocket as WS } from 'ws';
import { mkdir as fsMkdir, writeFile as fsWriteFile, rename as fsRename } from 'node:fs/promises';
import { join } from 'node:path';
import { EGPT_HOME } from '../egpt-home.mjs';
// The editor's half of the shell handshake — the SAME module the spine's limb runs (auth.mjs
// header: loopback is not an authenticator now that sandboxed local accounts exist). The spine
// challenges with a nonce; this client proves it holds the operator's shell token by answering
// with the HMAC. It cannot answer without the token, and an editor that cannot answer is not
// trusted — by design.
import { parseAuthFrame, responseFrame, SHELL_TOKEN_HELP } from './auth.mjs';

// The fixed port the SPINE serves; this editor dials it (shell-port SHELL_WS_PORT).
export const SHELL_WS_PORT = 23375;
// Content the spine's ingest handle recognizes (src/spine/ingest.mjs isShellConnectMarker).
const SHELL_CONNECT_MARKER = '/shell-connect';
// Reconnect backoff — a spine that is down (or restarting) must not spin the dial (or the log)
// every few ms. Same 3s→60s shape the spine's re-listen backoff uses.
const RECONNECT_MIN_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * @param {object} opts
 * @param {number} [opts.port]                  the spine's console port (default 23375)
 * @param {string} [opts.url]                   the spine's ws endpoint (default ws://127.0.0.1:<port>) — tests point it at an ephemeral port
 * @param {string} [opts.token]                 the node's SHELL TOKEN (cfg.shell.token) — the shared secret this editor answers the spine's auth challenge with. UNSET → the challenge goes unanswered and the spine refuses this editor (fail closed); the log line says what to add.
 * @param {typeof WS} [opts.WebSocket]          INJECTION SEAM — the `ws` client constructor (default the real import)
 * @param {(m: string) => void} [opts.onLog]
 * @param {object} [opts.io]                    fs seam for the ingest announce ({mkdir,writeFile,rename}); real fs by default — tests inject fakes so no real ~/.egpt write happens
 * @param {typeof globalThis.setTimeout} [opts.setTimeout]     reconnect-timer seam (tests inject a fake clock so no real wait blocks)
 * @param {typeof globalThis.clearTimeout} [opts.clearTimeout]
 */
export function createSpineLink({
  port = SHELL_WS_PORT,
  url = `ws://127.0.0.1:${port}`,
  token = '',
  WebSocket = WS,
  onLog = () => {},
  io = {},
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  const mkdir = io.mkdir ?? fsMkdir;
  const writeFile = io.writeFile ?? fsWriteFile;
  const rename = io.rename ?? fsRename;
  let sock = null;       // the current socket to the spine
  let onMsg = null;      // late-bound: the app registers it after construction
  let stopped = false;   // set by stop() BEFORE closing the socket, so its 'close' handler can
                         // tell a deliberate shutdown from the spine going away
  // `answered` means WE HAVE PROVEN OURSELVES — not merely "socket open". The spine discards
  // every frame from an unauthenticated client, so a send before we have answered the challenge
  // would vanish silently; gating isConnected/send on this turns that into an honest
  // "not delivered" line instead (src/shell/delivery.mjs).
  let answered = false;
  let reconnectTimer = null;
  let reconnectMs = RECONNECT_MIN_MS;
  // Frames that landed BEFORE the app had a handler for them. MEASURED against the live spine:
  // dial→open 8ms, open→challenge 1ms, answer→HEADER 1ms — the spine pushes its header-only
  // frame ~10ms after the dial. egpt.mjs dials FIRST (deliberately: the link starts as early as
  // possible), THEN awaits listThemes() and mounts Ink, and app.mjs registers onSpineMessage
  // from a useEffect — >100ms later. So the frame arrives while `onMsg` is still null, and
  // `onMsg?.(m)` used to make it VANISH. The app's header is useState('') fed ONLY by a spine
  // frame, so losing that one frame left the shell header line blank until something called
  // setHeader() again or the link reconnected. Hold what arrives early and flush it, in order,
  // the moment a handler registers — that closes the race whichever side wins, which reordering
  // the two never could. Do not "simplify" this away.
  let pending = [];
  // The bound: an editor that never registers a handler (or a spine that floods before the app
  // mounts) must not grow `pending` without limit. 32 is far more than the handful the handshake
  // produces; past it the OLDEST is dropped, so the most RECENT state is what survives.
  const PENDING_MAX = 32;

  // Announce into the ingest box. Temp-name then rename so the ingest sweep — which skips
  // dotfiles and *.tmp — never reads a half-written file. Never throws: a failed announce just
  // leaves the spine on its own re-listen backoff.
  async function announce() {
    try {
      const dir = join(EGPT_HOME, 'state', 'ingest');
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, 'shell-connect.tmp');
      await writeFile(tmp, SHELL_CONNECT_MARKER, 'utf8');
      await rename(tmp, join(dir, 'shell-connect'));
      onLog('shell-editor: announced via ingest');
    } catch (e) { onLog(`shell-editor: announce failed — ${e?.message ?? e}`); }
  }

  // Spine frame → { text, chatId, streaming[, delete][, header] }. The symmetric read of
  // shell-port's outbound `JSON.stringify({ text, chatId, streaming })`. `streaming`
  // distinguishes a live, in-place edit (the ⏳ thinking train — the app replaces its live
  // line) from a committed final (streaming:false → commit to the transcript); a `delete`
  // frame clears the live line and commits nothing (a withheld reply). `header` carries the
  // PERMANENT shell header line (boot's computeShellHeader) on an otherwise-empty frame — a
  // header-only frame has neither text nor delete, so the message handler below must not
  // drop it. A non-JSON line degrades to a committed bare text.
  function parse(raw) {
    const s = (typeof raw === 'string') ? raw : (raw?.toString?.() ?? String(raw));
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object' && typeof j.text === 'string') {
        const m = { text: j.text, chatId: j.chatId ? String(j.chatId) : 'main', streaming: !!j.streaming };
        if (j.delete) m.delete = true;
        if (j.header != null) m.header = String(j.header);
        return m;
      }
    } catch { /* not JSON → treat the whole line as the message text */ }
    return { text: s, chatId: 'main', streaming: false };
  }

  // Answer the spine's auth challenge (src/shell/auth.mjs): HMAC the nonce under the shared
  // token. This is the whole editor side of the handshake — the secret itself never rides the
  // wire, and a nonce is good for exactly the one connection that issued it. With no token
  // configured we answer NOTHING: the spine then refuses this editor, which is the correct
  // outcome (an editor nobody can verify is indistinguishable from an impostor). The message
  // says FAIL so egpt.mjs's fault filter surfaces it in the transcript instead of swallowing it.
  function answerChallenge(ws, frame) {
    if (frame.auth !== 'challenge' || !frame.nonce) return;
    if (!token) {
      onLog(`shell-editor: auth handshake will FAIL — no shell token configured, so the spine cannot verify this editor and will refuse it. To fix, ${SHELL_TOKEN_HELP}.`);
      return;
    }
    try { ws.send(responseFrame(token, frame.nonce)); answered = true; onLog('shell-editor: answered the spine auth challenge'); }
    catch (e) { onLog(`shell-editor: auth response send failed — ${e?.message ?? e}`); }
  }

  // Dial the spine and wire the handlers. THE ONE place this wiring exists — start() calls it
  // for the first dial and the reconnect backoff calls it for every retry.
  function connect() {
    if (stopped) return;
    answered = false;
    // Anything still queued belongs to the socket we just LOST. The spine process may have
    // restarted in between (wiping the state that frame reported), and this fresh connection
    // pushes its own header off its own handshake — so a previous session's frame must never be
    // flushed as if it were current. Drop it here, beside the `answered` reset, for the same reason.
    pending = [];
    try { sock = new WebSocket(url); }
    catch (e) { sock = null; onLog(`shell-editor: dial threw — ${e?.message ?? e}`); scheduleReconnect(); return; }
    const ws = sock;
    ws.on('open', () => { reconnectMs = RECONNECT_MIN_MS; onLog('shell-editor: connected to the spine — awaiting its auth challenge'); });
    // An AUTH frame is TRANSPORT, never transcript: it is intercepted here, before parse(),
    // so the spine's challenge is answered rather than rendered as a line of chat text
    // (parse() would degrade the unrecognized JSON to a bare message and print it).
    ws.on('message', (buf) => {
      const auth = parseAuthFrame(buf);
      if (auth) { answerChallenge(ws, auth); return; }
      const m = parse(buf);
      if (!(m.text || m.delete || m.header != null)) return;
      if (onMsg) { onMsg(m); return; }             // handler registered → straight through, no queue
      pending.push(m);                              // …not yet: hold it for the flush (see `pending`)
      if (pending.length > PENDING_MAX) pending.shift();
    });
    ws.on('close', () => {
      if (sock === ws) { sock = null; answered = false; }
      if (stopped) return;
      onLog(`shell-editor: spine link closed — reconnecting in ${Math.round(reconnectMs / 1000)}s`);
      scheduleReconnect();
    });
    ws.on('error', (e) => onLog(`shell-editor: socket error — ${e?.message ?? e}`));
    return ws;
  }

  // Exponential backoff: schedule the next dial at the current backoff, then double it (capped);
  // the reset to MIN happens on a successful 'open' in connect() above.
  function scheduleReconnect() {
    if (reconnectTimer) return;   // an attempt is already scheduled
    reconnectTimer = setTimeoutFn(() => { reconnectTimer = null; connect(); }, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
  }

  return {
    // Announce, then dial. The announce is fire-and-forget (it only matters when the spine
    // failed to bind); the dial never throws — an absent spine just backs off and retries.
    // Returns the underlying socket so a caller/test can await its 'open'.
    start() { announce(); return connect(); },
    // Register the inbound handler (fires `{ text, chatId }` the spine pushed). Flushes, in
    // order, whatever landed before this call — see `pending`: the app mounts long after the
    // dial, and the spine's header frame is already here by then. After the flush the queue is
    // out of the path for good; every later frame goes straight through.
    onSpineMessage(cb) { onMsg = cb; for (const m of pending.splice(0)) cb(m); },
    // Push a frame to the spine. MVP omits chatId → `{ text }` (shell-port defaults it to
    // 'main'). Drops (returns false, never throws) when the link is not up OR we have not yet
    // answered the challenge — the spine discards a pre-auth frame, so pretending it was sent
    // would be a silent loss.
    send(text, chatId) {
      if (!sock || !answered || sock.readyState !== 1) return false;   // 1 = WebSocket.OPEN
      try { sock.send(JSON.stringify(chatId ? { text: String(text), chatId } : { text: String(text) })); return true; }
      catch (e) { onLog(`shell-editor: send failed — ${e?.message ?? e}`); return false; }
    },
    get isConnected() { return !!sock && answered && sock.readyState === 1; },
    stop() {
      stopped = true;   // BEFORE closing the socket, so its 'close' handler sees a deliberate stop
      if (reconnectTimer) { clearTimeoutFn(reconnectTimer); reconnectTimer = null; }
      try { sock?.close?.(); } catch { /* closing */ }
      sock = null; answered = false;
      pending = [];   // a deliberately stopped link owes nobody a backlog (same reason as connect())
    },
  };
}
