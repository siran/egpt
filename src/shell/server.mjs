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

// The fixed port the editor serves; the spine dials out to it (shell-port SHELL_WS_PORT).
export const SHELL_WS_PORT = 23375;
// Content the spine's ingest handle recognizes (src/spine/ingest.mjs isShellConnectMarker).
const SHELL_CONNECT_MARKER = '/shell-connect';

/**
 * @param {object} opts
 * @param {number} [opts.port]                        the port to serve (default 23375; pass 0 for an ephemeral test port)
 * @param {typeof WebSocketServer} [opts.WebSocketServer]  INJECTION SEAM — the `ws` server constructor (default the real import)
 * @param {(m: string) => void} [opts.onLog]
 * @param {object} [opts.io]                          fs seam for the ingest announce ({mkdir,writeFile,rename}); real fs by default — tests inject fakes so no real ~/.egpt write happens
 */
export function createShellServer({
  port = SHELL_WS_PORT,
  WebSocketServer: WSS = WebSocketServer,
  onLog = () => {},
  io = {},
} = {}) {
  const mkdir = io.mkdir ?? fsMkdir;
  const writeFile = io.writeFile ?? fsWriteFile;
  const rename = io.rename ?? fsRename;
  let wss = null;
  let sock = null;       // the single connected spine socket (one console → one client)
  let onMsg = null;      // late-bound: the app registers it after construction

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

  // Spine frame → { text, chatId }. The symmetric read of shell-port's outbound
  // `JSON.stringify({ text, chatId })`; a non-JSON line degrades to bare text on 'main'.
  function parse(raw) {
    const s = (typeof raw === 'string') ? raw : (raw?.toString?.() ?? String(raw));
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object' && typeof j.text === 'string') {
        return { text: j.text, chatId: j.chatId ? String(j.chatId) : 'main' };
      }
    } catch { /* not JSON → treat the whole line as the message text */ }
    return { text: s, chatId: 'main' };
  }

  return {
    // Bind the server. Returns the underlying WebSocketServer so a caller/test can await
    // its 'listening' event and read the bound port (ephemeral when `port: 0`).
    start() {
      wss = new WSS({ host: '127.0.0.1', port });
      wss.on('listening', () => { announce(); });
      wss.on('connection', (ws) => {
        sock = ws;                                   // newest connection is THE console seat
        onLog('shell-editor: spine connected');
        ws.on('message', (buf) => { const m = parse(buf); if (m.text) onMsg?.(m); });
        ws.on('close', () => { if (sock === ws) sock = null; onLog('shell-editor: spine disconnected'); });
        ws.on('error', (e) => onLog(`shell-editor: socket error — ${e?.message ?? e}`));
      });
      wss.on('error', (e) => onLog(`shell-editor: server error — ${e?.message ?? e}`));
      return wss;
    },
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
    stop() {
      try { sock?.close?.(); } catch { /* closing */ }
      try { wss?.close?.(); } catch { /* closing */ }
      sock = null; wss = null;
    },
  };
}
