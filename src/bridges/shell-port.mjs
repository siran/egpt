// shell-port.mjs — the operator-console LIMB: a WebSocket CLIENT that dials OUT to
// an external interactive EDITOR (the "shell"), mirroring EXACTLY how the beeper limb
// dials Beeper Desktop. The editor SERVES ws://127.0.0.1:23375; the spine connects to
// it (invariant — the spine is a CLIENT of its surface apps; see plans/2607191835-
// SHELL-LIMB-S1-PLAN.md §1). A text frame the editor sends becomes an inbound event on
// the `shell` surface, handed to the SAME dispatch the spine runs for Beeper messages;
// the reply is pushed back over the same socket. Closing the editor NEVER touches the
// spine — the socket just closes and the limb idles + reconnects, exactly as the beeper
// limb rides out a down Beeper Desktop (beeper.mjs `connect()` reconnect/backoff).
//
// A STRIPPED-DOWN sibling of beeper.mjs: TEXT in, TEXT out — no media, no reactions,
// no edit-streaming, no REST. The limb carries ZERO command logic and ZERO fan-out; it
// is a dumb pipe, exactly like beeper-port (plan §2, §8). Everything after the inbound
// event — interpreter, gating, fan-out — is the spine's, shared with every limb.
import WS from 'ws';

// The editor serves this fixed port; the spine dials out (like Beeper's fixed 23373).
// Exported so boot + tests share the one number (plan §3, §9 — fixed port, not discovery).
export const SHELL_WS_PORT = 23375;
// Reconnect backoff — IDENTICAL shape to beeper.mjs (3s→60s): a closed editor must not
// spin the reconnect (or the log) every few ms while the operator's editor is shut.
const RECONNECT_MIN_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;
// The single console's default chat id + participant. The shell surface has one console,
// so a frame that omits `chatId` lands on this seat; the operator at the shell is a
// PARTICIPANT (authorized), symmetric with a WhatsApp sender — NOT an admin at a special
// console (plan §2). It is the outbound-routing key too (boot routes a shell-surface chat
// back to this socket).
const SHELL_CHAT_ID = 'main';
const SHELL_USER = 'operator';

/**
 * @param {object} opts
 * @param {string} [opts.url]                 the editor's ws endpoint (default ws://127.0.0.1:23375)
 * @param {typeof WS} [opts.WebSocket]        INJECTION SEAM — the `ws` client constructor (default the real import; tests pass a fake editor so NO real socket opens)
 * @param {(m: string) => void} [opts.onLog]
 * @param {typeof globalThis.setTimeout} [opts.setTimeout]     reconnect-timer seam (tests inject a fake clock so no real wait blocks)
 * @param {typeof globalThis.clearTimeout} [opts.clearTimeout]
 */
export function createShellPort({
  url = `ws://127.0.0.1:${SHELL_WS_PORT}`,
  WebSocket = WS,
  onLog = () => {},
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  // Late-bound inbound handler: the spine registers it AFTER construction (as it does
  // bridge.onMessage), so the message frame reads the ref at call time.
  let onMsg = null;
  let ws = null, _stopped = false, _wsReady = false, _reconnectTimer = null;
  let _reconnectMs = RECONNECT_MIN_MS;   // backs off to RECONNECT_MAX_MS while the editor is down
  // Chat ids seen inbound — the outbound-routing signal boot uses to send a shell-surface
  // reply back over THIS socket instead of the beeper bridge. A shell console uses the
  // deterministic `main` id (or whatever the frame carries), which never collides with a
  // Beeper Matrix room id.
  const _chatIds = new Set();

  // Editor frame → { text, chatId }. Minimal frame = a JSON line `{ text, chatId? }` (the
  // smallest shape that lets a caller target a specific console seat), degrading to a bare
  // text line when it isn't JSON — either is enough for the spine to treat it as an inbound
  // message. Text out is the symmetric `{ text, chatId }`.
  function toInbound(raw) {
    const s = (typeof raw === 'string') ? raw : (raw?.toString?.() ?? String(raw));
    let text = s, chatId = SHELL_CHAT_ID;
    try { const j = JSON.parse(s); if (j && typeof j === 'object' && typeof j.text === 'string') { text = j.text; if (j.chatId) chatId = String(j.chatId); } }
    catch { /* not JSON → treat the whole line as the message text */ }
    return { text, chatId };
  }

  function connect() {
    if (_stopped) return;
    try { ws = new WebSocket(url); }
    catch (e) { onLog(`shell: WS connect threw — ${e?.message ?? e}`); scheduleReconnect(); return; }
    ws.on('open', () => { _wsReady = true; _reconnectMs = RECONNECT_MIN_MS; onLog('shell: WS open'); });
    ws.on('message', (buf) => {
      const { text, chatId } = toInbound(buf);
      if (!text) return;
      _chatIds.add(chatId);
      // The `from` the identity service consumes: network 'shell' → the shell SURFACE +
      // 'kg' node; authorized so an operator slash command (`/status`, `/chrome kg`) is
      // recognized (the shell is the operator's own trusted local console). No mention
      // flags / reply-to — the interpreter reads the body.
      const from = { chatId, chatName: 'shell', network: 'shell', userId: SHELL_USER, senderName: SHELL_USER, authorized: true, msgKey: null };
      // Fire-and-forget into the spine (the beeper dispatch does the same): a slow turn
      // must not block the socket's read loop, and a handler throw is logged, never fatal.
      try { Promise.resolve(onMsg?.({ body: text, from })).catch((e) => onLog(`shell: onMessage threw — ${e?.message ?? e}`)); }
      catch (e) { onLog(`shell: onMessage threw — ${e?.message ?? e}`); }
    });
    ws.on('close', () => { _wsReady = false; if (_stopped) return; scheduleReconnect(); });
    ws.on('error', (e) => onLog(`shell: WS error — ${e?.message ?? e}`));
  }
  function scheduleReconnect() {
    onLog(`shell: editor absent — reconnecting in ${Math.round(_reconnectMs / 1000)}s`);
    _reconnectTimer = setTimeoutFn(connect, _reconnectMs);
    _reconnectMs = Math.min(_reconnectMs * 2, RECONNECT_MAX_MS);
  }

  return {
    // Dial out to the editor (idempotent-enough for boot: called once). If the editor
    // never answers, the error/close handlers just re-arm the backoff — start() never throws.
    start() { connect(); },
    // The operator's editor just announced itself (ingest marker, right after its WS
    // server started listening) — connect NOW instead of riding out the reconnect backoff
    // (up to 60s). No-op if already connected or stopped.
    poke() {
      if (_stopped || _wsReady) return;
      if (_reconnectTimer) { clearTimeoutFn(_reconnectTimer); _reconnectTimer = null; }
      _reconnectMs = RECONNECT_MIN_MS;
      connect();
    },
    onMessage(cb) { onMsg = cb; },
    // Does this chat id belong to the shell surface? boot's routed send consults this to
    // push a shell-surface reply back over the socket instead of the beeper bridge.
    owns(chatId) { return _chatIds.has(chatId); },
    // Push a reply frame back to the editor. Drops (never throws) when the editor is not
    // connected — a reply with nowhere to go must not crash the spine, same as beeper
    // dropping a send to an unresolvable chat.
    send(chatId, text) {
      if (!ws || !_wsReady) { onLog('shell: send dropped — editor not connected'); return false; }
      try { ws.send(JSON.stringify({ text: String(text), chatId })); return true; }
      catch (e) { onLog(`shell: send failed — ${e?.message ?? e}`); return false; }
    },
    isAlive: () => _wsReady,
    stop: () => { _stopped = true; if (_reconnectTimer) clearTimeoutFn(_reconnectTimer); try { ws?.close(); } catch { /* closing */ } },
  };
}
