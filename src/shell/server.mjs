// src/shell/server.mjs — the operator EDITOR's WebSocket SERVER on 23375.
//
// Topology invariant (plans/2607191835-SHELL-LIMB-S1-PLAN.md §1): the spine is a CLIENT
// of its surface apps. So the EDITOR serves the port and the spine's `shell-port` limb
// (src/bridges/shell-port.mjs) dials INTO it. This module is that server, kept to pure
// transport with no Ink — the frame protocol is the ONLY contract with the spine:
//   • spine → editor : a JSON line `{ text, chatId }`  → surfaced via onSpineMessage()
//   • editor → spine : a JSON line `{ text, chatId? }` → pushed by send() (MVP: `{ text }`)
// Exactly mirrors shell-port's `send(chatId, text)` / `toInbound(raw)` shapes so the two
// ends align. One console → one connected spine socket; a second connection replaces it.
//
// Nudge: the moment the WS server is listening, this editor drops a `/shell-connect`
// marker into EGPT_HOME/state/ingest — the spine's ingest watcher (polls every 1s) reads
// it and pokes the shell-port limb to dial in immediately, instead of riding out its
// reconnect backoff (up to 60s, src/bridges/shell-port.mjs).
import { WebSocketServer } from 'ws';
import { mkdir as fsMkdir, writeFile as fsWriteFile, rename as fsRename } from 'node:fs/promises';
import { join } from 'node:path';
import { EGPT_HOME } from '../egpt-home.mjs';
import { reapPort } from '../tools/reap-port.mjs';

// The fixed port the editor serves; the spine dials out to it (shell-port SHELL_WS_PORT).
export const SHELL_WS_PORT = 23375;
// Content the spine's ingest handle recognizes (src/spine/ingest.mjs isShellConnectMarker).
const SHELL_CONNECT_MARKER = '/shell-connect';
// Re-listen backoff (after the wss listener closes unexpectedly) — IDENTICAL shape to
// shell-port.mjs's reconnect backoff (3s→60s), the client-side mirror of this same problem.
const RECONNECT_MIN_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * @param {object} opts
 * @param {number} [opts.port]                        the port to serve (default 23375; pass 0 for an ephemeral test port)
 * @param {typeof WebSocketServer} [opts.WebSocketServer]  INJECTION SEAM — the `ws` server constructor (default the real import)
 * @param {(m: string) => void} [opts.onLog]
 * @param {object} [opts.io]                          fs seam for the ingest announce ({mkdir,writeFile,rename}); real fs by default — tests inject fakes so no real ~/.egpt write happens
 * @param {typeof globalThis.setTimeout} [opts.setTimeout]     re-listen timer seam (tests inject a fake clock so no real wait blocks)
 * @param {typeof globalThis.clearTimeout} [opts.clearTimeout]
 * @param {typeof reapPort} [opts.reapPort]            port-killer seam (see start()) — real reapPort by default; tests inject a fake so no real netstat/taskkill runs
 */
export function createShellServer({
  port = SHELL_WS_PORT,
  WebSocketServer: WSS = WebSocketServer,
  onLog = () => {},
  io = {},
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
  reapPort: reapPortFn = reapPort,
} = {}) {
  const mkdir = io.mkdir ?? fsMkdir;
  const writeFile = io.writeFile ?? fsWriteFile;
  const rename = io.rename ?? fsRename;
  let wss = null;
  let sock = null;       // the single connected spine socket (one console → one client)
  let onMsg = null;      // late-bound: the app registers it after construction
  let stopped = false;   // set by stop() BEFORE closing wss, so its 'close' handler can tell
                          // a deliberate shutdown from the listener dying out from under us
  let listening = false; // true only between this wss's 'listening' and its next close/error
  let reconnectTimer = null;
  let reconnectMs = RECONNECT_MIN_MS;

  // Drop the marker AFTER the server is listening (so the spine's poke has somewhere to
  // dial into). Temp-name then rename so the ingest sweep — which skips dotfiles and
  // *.tmp — never reads a half-written file. Never throws: a failed announce just leaves
  // the shell-port limb to its existing reconnect backoff.
  async function announce() {
    try {
      const dir = join(EGPT_HOME, 'state', 'ingest');
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, 'shell-connect.tmp');
      await writeFile(tmp, SHELL_CONNECT_MARKER, 'utf8');
      await rename(tmp, join(dir, 'shell-connect'));
      onLog('shell: announced via ingest');
    } catch (e) { onLog(`shell: announce failed — ${e?.message ?? e}`); }
  }

  // Spine frame → { text, chatId, streaming[, delete][, header] }. The symmetric read of
  // shell-port's outbound `JSON.stringify({ text, chatId, streaming })`. `streaming`
  // distinguishes a live, in-place edit (the ⏳ thinking train — the app replaces its live
  // line) from a committed final (streaming:false → commit to the transcript); a `delete`
  // frame clears the live line and commits nothing (a withheld reply). `header` carries the
  // PERMANENT shell header line (boot's computeShellHeader) on an otherwise-empty frame — a
  // header-only frame has neither text nor delete, so the connection handler below must not
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

  // Bind (or re-bind) the WebSocketServer and wire its handlers. THE ONE place this wiring
  // exists — start() calls it for the initial bind, and the unexpected-close recovery path
  // below calls it again for every re-listen attempt, so listening/connection/error/close
  // are never wired twice in two places.
  function bind() {
    listening = false;
    try {
      wss = new WSS({ host: '127.0.0.1', port });
    } catch (e) {
      onLog(`shell-editor: re-listen attempt threw — ${e?.message ?? e}`);
      scheduleRelisten();
      return wss;
    }
    wss.on('listening', () => { listening = true; reconnectMs = RECONNECT_MIN_MS; announce(); });
    wss.on('connection', (ws) => {
      sock = ws;                                   // newest connection is THE console seat
      onLog('shell-editor: spine connected');
      ws.on('message', (buf) => { const m = parse(buf); if (m.text || m.delete || m.header != null) onMsg?.(m); });
      ws.on('close', () => { if (sock === ws) sock = null; onLog('shell-editor: spine disconnected'); });
      ws.on('error', (e) => onLog(`shell-editor: socket error — ${e?.message ?? e}`));
    });
    wss.on('error', (e) => {
      onLog(`shell-editor: server error — ${e?.message ?? e}`);
      // A server-level error before we ever reached 'listening' means this (re-)listen
      // attempt itself failed (e.g. the port still momentarily held) — back off and retry,
      // same as an unexpected close. An error once already listening is left as before
      // (logged only): the listener itself is still up.
      if (!stopped && !listening) scheduleRelisten();
    });
    wss.on('close', () => {
      sock = null;
      if (stopped) return;   // deliberate stop() — never recover from our own shutdown
      onLog(`shell-editor: WS SERVER CLOSED UNEXPECTEDLY — spine cannot reach this console until it re-listens (retrying in ${Math.round(reconnectMs / 1000)}s)`);
      scheduleRelisten();
    });
    return wss;
  }

  // Exponential backoff, IDENTICAL shape to shell-port.mjs's scheduleReconnect(): schedule
  // the next re-listen attempt at the current backoff, then double it (capped) for next time;
  // reset back to MIN happens on a successful 'listening' inside bind() above.
  function scheduleRelisten() {
    if (reconnectTimer) return;   // an attempt is already scheduled
    reconnectTimer = setTimeoutFn(() => { reconnectTimer = null; bind(); }, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
  }

  return {
    // Bind the server. Reaps whatever already holds `port` FIRST — a stale prior editor
    // process (e.g. a forgotten `node egpt.mjs` from an earlier terminal) orphans this exact
    // port on Windows, and the fresh instance would otherwise EADDRINUSE-loop forever with no
    // self-healing (operator 2026-08-17). Runs once, before the FIRST bind attempt only — the
    // kill is synchronous (reapPort spawnSync's taskkill/lsof+kill), so by the time `bind()`
    // constructs the WebSocketServer the port is already free; the re-listen backoff in bind()
    // above handles any OTHER reason a later attempt fails and needn't re-reap. reapPortFn's
    // own port===0 guard (reap-port.mjs) makes this a no-op for tests' ephemeral `port: 0`.
    // Returns the underlying WebSocketServer so a caller/test can await its 'listening' event
    // and read the bound port (ephemeral when `port: 0`).
    start() { reapPortFn(port, onLog); return bind(); },
    // Register the inbound handler (fires `{ text, chatId }` the spine pushed).
    onSpineMessage(cb) { onMsg = cb; },
    // Push a frame to the connected spine. MVP omits chatId → `{ text }` (shell-port
    // defaults it to 'main'). Drops (returns false, never throws) when no spine is
    // connected, symmetric with shell-port dropping a send to a down editor.
    send(text, chatId) {
      if (!sock || sock.readyState !== 1) return false;   // 1 = WebSocket.OPEN
      try { sock.send(JSON.stringify(chatId ? { text: String(text), chatId } : { text: String(text) })); return true; }
      catch (e) { onLog(`shell-editor: send failed — ${e?.message ?? e}`); return false; }
    },
    get isConnected() { return !!sock && sock.readyState === 1; },
    // The CURRENT underlying WebSocketServer — reassigned on every re-listen, so a caller
    // that needs the live instance (e.g. a test awaiting a re-listened server's 'listening'
    // event) always reads the up-to-date one rather than the one start() first returned.
    get wss() { return wss; },
    stop() {
      stopped = true;   // BEFORE closing wss, so its 'close' handler sees a deliberate stop
      if (reconnectTimer) { clearTimeoutFn(reconnectTimer); reconnectTimer = null; }
      try { sock?.close?.(); } catch { /* closing */ }
      try { wss?.close?.(); } catch { /* closing */ }
      sock = null; wss = null;
    },
  };
}
