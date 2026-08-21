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
// The shell socket's ONE authentication definition (src/shell/auth.mjs — header there for the
// vulnerability this closes). Loopback is NOT an authenticator: the sandboxed CLI accounts can
// bind 127.0.0.1:23375 while the editor is shut and impersonate the operator. The peer that
// answers this port must PROVE it holds the node's shell token before this limb trusts a byte
// of it. The algorithm is imported, never re-implemented — the editor end runs the same module.
import { newNonce, challengeFrame, parseAuthFrame, authMac, macMatches, SHELL_TOKEN_HELP } from '../shell/auth.mjs';

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
// back to this socket). That `authorized: true` is EARNED, not assumed: it is stamped only
// on frames from a peer that already passed the auth handshake below (src/shell/auth.mjs).
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
 * @param {string} [opts.token]               the node's SHELL TOKEN (cfg.shell.token, handed in by boot exactly like bridgeSignatureOpen/nodeName — this limb never reads config itself). The peer holding 127.0.0.1:23375 must prove it knows this secret before a single frame is sent to it or accepted from it. UNSET → the limb FAILS CLOSED: it does not dial at all and logs what to add to config. No default, no auto-generation, no unauthenticated mode.
 * @param {string} [opts.nodeName]            the STRUCTURAL node id (cfg.node_name), tag-encoded invisibly onto every frame — same value boot hands the beeper bridge. Default ''.
 * @param {string} [opts.header]              the shell status-line header (boot's computeShellHeader) — the initial value handed in at boot, pushed as a header-only frame on every (re)connect. Updatable later via setHeader() (e.g. /room join|leave). Default '' → no header frame sent until setHeader() is called.
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
  token = '',
  nodeName = '',
  header = '',
  onLog = () => {},
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  // The SAME wrap the beeper limb binds (boot hands both ports the node's bridge_signature_*),
  // so a persona reply rendered to the shell is wrapped identically to one rendered to Beeper.
  const wrapPersona = makeWrapPersona({ bridgeSignatureOpen, bridgeSignatureClose, nodeName });
  // The PERMANENT header line (boot's computeShellHeader). Pushed on every (re)connect from
  // the ONE ws.on('open') hook below, so first-connect, every reconnect, AND poke() (all
  // funnel through connect()) are covered without any separate "is this a reconnect" tracking
  // in boot.mjs. `let`, not `const` (operator 2026-08-16: live status-line room reflection) —
  // setHeader() below reassigns it so a LATER reconnect also carries the latest header, not
  // just the one boot computed at construction time.
  let _header = header;
  // Late-bound inbound handler: the spine registers it AFTER construction (as it does
  // bridge.onMessage), so the message frame reads the ref at call time.
  let onMsg = null;
  // The shared secret this limb challenges the editor with. Empty → the limb is DISABLED
  // (fail closed): see start() below.
  const _token = String(token ?? '');
  // _wsReady means AUTHENTICATED-and-ready, not merely "socket open" — it flips only after the
  // peer answers the challenge correctly, so every existing reader of it (pushFrame's drop
  // guard, isConnected/isAlive, poke's already-connected check) refuses to touch an unverified
  // peer without a single extra branch of its own.
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

  // THE HANDSHAKE, spine side. Called for every frame that arrives before the peer is trusted;
  // returns true the moment it is. A frame that is not the answer to OUR nonce is DISCARDED —
  // never queued, never replayed once authentication later succeeds, so an impostor cannot
  // front-load a `/upgrade` and have it delivered the instant a genuine editor takes the port.
  // A WRONG answer is fatal for this socket: close it and fall into the EXISTING reconnect
  // backoff (the 'close' handler below), never a second retry mechanism.
  function verifyPeer(raw, nonce, sock) {
    const f = parseAuthFrame(raw);
    if (!f || f.auth !== 'response') return false;               // pre-auth noise → dropped on the floor
    if (!macMatches(f.mac, authMac(_token, nonce))) {
      onLog('shell: EDITOR FAILED THE AUTH CHALLENGE — refusing to trust whatever holds 127.0.0.1:23375. '
        + 'Most likely an IMPOSTOR bound the port while the editor was closed (a sandboxed account can); '
        + 'otherwise the editor is running with a different shell.token. Dropping the socket.');
      try { sock?.close?.(); } catch { /* closing */ }
      return false;
    }
    // Trusted from here on: NOW the limb may speak. The header push (the first frame this limb
    // ever sends) is deliberately deferred to this point — before it, the peer is a stranger.
    _wsReady = true; _reconnectMs = RECONNECT_MIN_MS;
    onLog('shell: WS open — editor authenticated');
    // The permanent header, resent on EVERY (re)connect — a header that only ever sends
    // once would go blank forever after the first reconnect.
    if (_header) pushFrame(SHELL_CHAT_ID, '', { header: _header });
    return true;
  }

  function connect() {
    if (_stopped || !_token) return;                              // no secret → never dial (fail closed)
    try { ws = new WebSocket(url); }
    catch (e) { onLog(`shell: WS connect threw — ${e?.message ?? e}`); scheduleReconnect(); return; }
    // Per-SOCKET handshake state: a fresh nonce every connection (so a recorded answer is
    // useless on the next one) and a trust flag that starts false on every reconnect.
    const nonce = newNonce();
    let authed = false;
    const sock = ws;
    ws.on('open', () => {
      // NOT ready yet — the socket being open says nothing about WHO answered. Send the
      // challenge and nothing else; _wsReady stays false, so every send drops meanwhile.
      onLog('shell: WS open — challenging the editor');
      try { sock.send(challengeFrame(nonce)); }
      catch (e) { onLog(`shell: challenge send failed — ${e?.message ?? e}`); try { sock.close(); } catch { /* closing */ } }
    });
    ws.on('message', (buf) => {
      if (!authed) { authed = verifyPeer(buf, nonce, sock); return; }
      const { text, chatId } = toInbound(buf);
      if (!text) return;
      _chatIds.add(chatId);
      // The `from` the identity service consumes: network 'shell' → the shell SURFACE +
      // the 'sh' transport tag; authorized so an operator slash command (`/status`, `/chrome kg`) is
      // recognized (the shell is the operator's own local console — PROVEN so by the handshake
      // above, not assumed from the loopback address). MENTION FLAGS
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
    // FAIL CLOSED with no token: the limb does not dial AT ALL and says exactly what to add.
    // Deliberately not an auto-generated secret and not a warn-and-continue — an unauthenticated
    // shell socket is a sandbox escape (src/shell/auth.mjs header), so "off" is the safe state.
    start() {
      if (!_token) { onLog(`shell: DISABLED — no shell token configured, so the operator console cannot be authenticated (an unauthenticated 127.0.0.1:23375 is impersonable by any local account). To enable it, ${SHELL_TOKEN_HELP}.`); return; }
      connect();
    },
    // The operator's editor just announced itself (ingest marker, right after its WS
    // server started listening) — connect NOW instead of riding out the reconnect backoff
    // (up to 60s). No-op if already connected or stopped.
    poke() {
      if (_stopped || _wsReady || !_token) return;   // no secret → stays disabled, an announce cannot re-enable it
      if (_reconnectTimer) { clearTimeoutFn(_reconnectTimer); _reconnectTimer = null; }
      _reconnectMs = RECONNECT_MIN_MS;
      connect();
    },
    onMessage(cb) { onMsg = cb; },
    // Does this chat id belong to the shell surface? boot's routed send consults this to
    // push a shell-surface reply back over the socket instead of the beeper bridge.
    owns(chatId) { return _chatIds.has(chatId); },
    // Register a chat id as shell-owned WITHOUT it having arrived inbound — boot's room
    // redirect (a shell turn dispatched as room <slug> instead of native (shell, 'main'))
    // sends its reply to ev.chatId, which is now the room slug, not the id this socket last
    // saw. owns() must recognize it too, or the reply would be handed to the wrong bridge.
    // Generic on purpose: this limb still carries zero room logic, only the registry itself.
    claim(chatId) { _chatIds.add(chatId); },
    // Push an UPDATED header line now (operator 2026-08-16: live status-line room reflection,
    // e.g. after /room join|leave) — boot.mjs's onRoomChange calls this with a freshly
    // recomputed computeShellHeader(). Reassigns _header so a LATER reconnect resends the
    // NEW line too, not the one captured at construction. Drops (never throws) when the
    // editor isn't connected right now, same as any other push — the next (re)connect's
    // ws.on('open') hook still carries the latest _header.
    setHeader(newHeader) { _header = newHeader ?? ''; return pushFrame(SHELL_CHAT_ID, '', { header: _header }); },
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
