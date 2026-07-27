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
// The SAME wake matcher the beeper limb uses (auto-mode.mjs) — reused, never duplicated,
// so a shell `@e` is recognized by identical rules (code-fence-stripped, word-boundary).
import { mentionStatus } from '../auto-mode.mjs';
// The SAME persona stamp + concentric wrap the beeper limb renders through — ONE definition
// (operator 2026-07-25: "the bridge must have ONE path"). The shell reply carries its ⏳
// thinking train, its persona stamp, and the agent/bridge signatures on EVERY frame,
// identical to Beeper — because it runs the identical machinery, not a shell-specific copy.
import { makeWrapPersona } from './persona-wrap.mjs';

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
 * @param {string[]} [opts.wakeWords]         the persona's wake-word set (its declared handles, else its map key — router.mjs wakeTokens), SAME set boot hands the beeper bridge. Undefined → mentionStatus' built-in e/egpt defaults.
 * @param {boolean} [opts.addressWithoutAt]   the node's dispatch.address_without_at (DEFAULT true): may a BARE leading handle ("d hola") address, or is the '@' required? Rides beside wakeWords into the SAME mentionStatus call — the same value boot hands the beeper bridge and the router.
 * @param {string} [opts.bridgeSignatureOpen]  per-NODE outer wrap layer — the SAME value boot hands the beeper bridge, so a shell reply's wrap matches the Beeper wrap. Default ''.
 * @param {string} [opts.bridgeSignatureClose]
 * @param {string} [opts.nodeName]            the STRUCTURAL node id (cfg.node_name), tag-encoded invisibly onto every frame — same value boot hands the beeper bridge. Default ''.
 * @param {string} [opts.header]              the PERMANENT shell header line (boot's computeShellHeader) — a static string handed in at boot, pushed as a header-only frame on every (re)connect. Default '' → no header frame ever sent.
 * @param {(m: string) => void} [opts.onLog]
 * @param {typeof globalThis.setTimeout} [opts.setTimeout]     reconnect-timer seam (tests inject a fake clock so no real wait blocks)
 * @param {typeof globalThis.clearTimeout} [opts.clearTimeout]
 */
export function createShellPort({
  url = `ws://127.0.0.1:${SHELL_WS_PORT}`,
  WebSocket = WS,
  wakeWords,
  addressWithoutAt = true,
  bridgeSignatureOpen = '',
  bridgeSignatureClose = '',
  nodeName = '',
  header = '',
  onLog = () => {},
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  // The SAME wrap the beeper limb binds (boot hands both ports the node's bridge_signature_*),
  // so a persona reply rendered to the shell is wrapped identically to one rendered to Beeper.
  const wrapPersona = makeWrapPersona({ bridgeSignatureOpen, bridgeSignatureClose, nodeName });
  // The PERMANENT header line (boot's computeShellHeader) — static for this task, no
  // live-update requirement. Pushed on every (re)connect from the ONE ws.on('open') hook
  // below, so first-connect, every reconnect, AND poke() (all funnel through connect()) are
  // covered without any separate "is this a reconnect" tracking in boot.mjs.
  const _header = header;
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
    ws.on('open', () => {
      _wsReady = true; _reconnectMs = RECONNECT_MIN_MS; onLog('shell: WS open');
      // The permanent header, resent on EVERY (re)connect — a header that only ever sends
      // once would go blank forever after the first reconnect.
      if (_header) pushFrame(SHELL_CHAT_ID, '', { header: _header });
    });
    ws.on('message', (buf) => {
      const { text, chatId } = toInbound(buf);
      if (!text) return;
      _chatIds.add(chatId);
      // The `from` the identity service consumes: network 'shell' → the shell SURFACE +
      // the 'sh' transport tag; authorized so an operator slash command (`/status`, `/chrome kg`) is
      // recognized (the shell is the operator's own trusted local console). MENTION FLAGS
      // computed here (mirrors beeper.mjs' `mentionStatus(text, wakeWords)`): without them
      // a shell `@e` arrived with atEAnywhere unset → identity.build → the mention gate
      // stayed false → E was gated out and never woke. reply-to stays null (no quoting on
      // the shell surface).
      const st = mentionStatus(text, wakeWords, { addressWithoutAt });
      const from = { chatId, chatName: 'shell', network: 'shell', userId: SHELL_USER, senderName: SHELL_USER, authorized: true, msgKey: null, atEStart: st.atEStart, atEAnywhere: st.atEAnywhere };
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

  // One outbound frame to the editor. Drops (never throws) when the editor is not connected
  // — a reply with nowhere to go must not crash the spine, same as beeper dropping a send to
  // an unresolvable chat. Carries `streaming` (a live, in-place edit the editor replaces vs a
  // committed final) and, on a withheld reply, `delete` (clear the live line, commit nothing)
  // — the shell's edit-in-place primitive, mirroring the beeper limb's startStreamMessage.
  // Both the plain `send` and the streaming `startStream` render through this single push.
  // `header` is the ONE new optional field (the permanent header line, above): attached only
  // when non-null, so every other caller's frame shape is byte-identical to before.
  function pushFrame(chatId, text, { streaming = false, delete: del = false, header = null } = {}) {
    if (!ws || !_wsReady) { onLog('shell: send dropped — editor not connected'); return false; }
    try {
      const frame = { text: String(text), chatId, streaming: !!streaming };
      if (del) frame.delete = true;
      if (header != null) frame.header = header;
      ws.send(JSON.stringify(frame));
      return true;
    }
    catch (e) { onLog(`shell: send failed — ${e?.message ?? e}`); return false; }
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
    // Is the operator's editor currently dialed in? /status's `shell:` field reads this
    // (boot wires shellConnected: () => shellPort.isConnected).
    get isConnected() { return _wsReady; },
    // Push a reply frame back to the editor. WRAPPED exactly like the beeper limb's send — a
    // persona reply (tag carries bodyEmoji + label), the §7 non-streamed fallback, a plain system
    // reply (/status), a relayed mesh nugget: every one carries this node's bridge layer (operator
    // 2026-07-25: "all messages coming out from a spine to any surface are signed. period."). Drops
    // (never throws) when the editor is not connected, same as beeper dropping an unresolvable send.
    send(chatId, text, opts = {}) { return pushFrame(chatId, wrapPersona(opts, text)); },
    // The mesh posts its ORIGIN placeholder ("🤔 thinking…") via postStatus and rides the
    // returned message id as post_id (the responder echoes it so the origin edits the RIGHT
    // message as the living-mirror reply streams). A shell-origin relay (`@don` typed in the
    // shell) lands here via the shell-aware bridge facade. The shell has NO editable message id
    // — unlike Beeper there is no msgId to edit later — so a COMMITTED (streaming:false) frame
    // here would sit in the transcript FOREVER: the shell's only replace-in-place primitive is
    // the live line, and a committed line is never revisited. Push it LIVE instead (streaming:
    // true), the SAME primitive startStream uses for its own placeholder — the reply's later
    // openOriginStream → startStream posts its own live frame, which REPLACES this one in place
    // (src/shell/app.mjs holds ONE `live` slot), so exactly one thinking indicator is ever shown
    // and nothing is left behind once the reply commits (operator: "double-thinking, one
    // lingers"). Still RETURN null: with no post_id the mesh's later edit/delete of the
    // placeholder is a guarded no-op and openOriginStream opens a fresh shell stream (existingMsgId
    // null) that streams the reply in via startStream — unchanged. Drops (never throws) when the
    // editor is not connected, same as send.
    // SIGNED like every other frame (C13, operator 2026-07-26). "Uncommitted live line on the
    // operator's own console" stopped being a reason the moment the ⏳ placeholder — the same
    // streaming:true primitive, on the same surface — started signing: two live frames on one
    // surface under two different rules is the hole, not the exemption.
    postStatus(chatId, text) { pushFrame(chatId, wrapPersona({}, String(text)), { streaming: true }); return null; },
    // A STREAMING reply target with the shape createSender consumes off the beeper bridge
    // (beeper-port.startStream → { update, finish, delete, fail, delivered, lastError }) — now
    // rendered through the IDENTICAL machinery (operator 2026-07-25): the ⏳ thinking placeholder
    // and the progressive edits stream live (streaming:true frames the editor replaces in place),
    // and the FULL concentric wrap (persona stamp + agent + bridge signatures) rides EVERY one of
    // them as well as the committed final (streaming:false) — exactly as beeper-port does over its
    // startStreamMessage edit-in-place primitive. delivered flips true only when the FINAL lands,
    // so the sender's §7 fallback send is skipped instead of double-posting. A push failure
    // surfaces on lastError; fail() posts an explicit error line (never swallowed).
    startStream(chatId, initial = '', tag = {}) {
      const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? '');
      // EVERY frame through the ONE wrap — placeholder, each live edit, the committed final
      // (C13, operator 2026-07-26), identical to beeper-port. Built from the RAW core each time,
      // so a frame replacing a signed frame cannot accumulate signatures.
      const frame = (t) => wrapPersona(tag, t);
      let _delivered = false;
      let _lastError = null;
      // Post the placeholder immediately — the signed "⏳ Thinking…", live (mirrors
      // beeper-port posting its placeholder via startStreamMessage).
      pushFrame(chatId, frame(initial), { streaming: true });
      return {
        // Live intermediate frame — the sender supplies the ⏳ marker, the port signs it.
        update(v) { const t = textOf(v); pushFrame(chatId, frame(t), { streaming: true }); },
        // The committed final: the FULL wrap (stamp + agent + bridge) on a streaming:false frame.
        finish(reply, _opts = {}) {
          const ok = pushFrame(chatId, frame(textOf(reply)), { streaming: false });
          if (ok) _delivered = true; else _lastError = 'shell: editor not connected';
        },
        // A withheld reply: clear the live line, commit nothing. No text → nothing to sign.
        delete() { pushFrame(chatId, '', { streaming: false, delete: true }); },
        fail(err) { _lastError = err?.message ?? String(err ?? 'shell stream failed'); pushFrame(chatId, frame(`❌ ${_lastError}`), { streaming: false }); },
        get delivered() { return _delivered; },
        get lastError() { return _lastError; },
      };
    },
    isAlive: () => _wsReady,
    stop: () => { _stopped = true; if (_reconnectTimer) clearTimeoutFn(_reconnectTimer); try { ws?.close(); } catch { /* closing */ } },
  };
}
