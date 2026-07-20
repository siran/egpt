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
// Known limitation (MVP): shell-port's reconnect backoff grows to 60s, so after the
// editor starts the spine may take up to ~60s to dial in. Accepted here (no-touch on
// shell-port). Layer-2 could add a nudge, but the MVP just waits it out.
import { WebSocketServer } from 'ws';

// The fixed port the editor serves; the spine dials out to it (shell-port SHELL_WS_PORT).
export const SHELL_WS_PORT = 23375;

/**
 * @param {object} opts
 * @param {number} [opts.port]                        the port to serve (default 23375; pass 0 for an ephemeral test port)
 * @param {typeof WebSocketServer} [opts.WebSocketServer]  INJECTION SEAM — the `ws` server constructor (default the real import)
 * @param {(m: string) => void} [opts.onLog]
 */
export function createShellServer({
  port = SHELL_WS_PORT,
  WebSocketServer: WSS = WebSocketServer,
  onLog = () => {},
} = {}) {
  let wss = null;
  let sock = null;       // the single connected spine socket (one console → one client)
  let onMsg = null;      // late-bound: the app registers it after construction

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
