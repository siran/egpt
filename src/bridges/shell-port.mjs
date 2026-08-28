// shell-port.mjs — the operator-console LIMB: a WebSocket SERVER the spine binds AT BOOT and
// HOLDS on 127.0.0.1:23375. The external interactive EDITOR (the "shell") is the CLIENT: it
// dials in and PROVES it holds the node's shell token before this limb accepts a byte from it
// or sends it one. A text frame the editor sends becomes an inbound event on the `shell`
// surface, handed to the SAME dispatch the spine runs for Beeper messages; the reply is pushed
// back over the same socket. Closing the editor NEVER touches the spine — the client socket
// closes, the listener stays bound, and the next editor to dial in gets the seat.
//
// INVERTED 2026-08-26 (operator ruling). It used to be the other way round — the editor served
// and the spine dialled out, modelled on the beeper limb dialling Beeper Desktop's 23373. Three
// reasons it is now the spine that serves:
//   1. the DURABLE process should be the server and the TRANSIENT one the client; the spine is
//      always running, the editor is opened and closed;
//   2. auth becomes client-proves-to-server, the conventional direction;
//   3. THE DECISIVE ONE — the spine binds at boot and HOLDS the port, so there is no unbound
//      window to squat. When the editor served, 23375 was free whenever the operator's editor
//      was closed (the usual state), and any local process — notably a sandboxed pool account,
//      which can bind loopback freely, Windows having no per-user loopback namespace — could
//      take the port and receive the spine's outbound connection. Holding the port kills that
//      structurally instead of detecting it after the fact.
// The old plan's stated reason for the other direction ("Close it → spine lives",
// plans/2607191835-SHELL-LIMB-S1-PLAN.md §1) conflated who SERVES with whose lifetime dominates:
// a server with no clients is fine, and the editor's lifetime is still entirely its own.
//
// A STRIPPED-DOWN sibling of beeper.mjs: TEXT in, TEXT out — no media, no reactions,
// no edit-streaming, no REST. The limb carries ZERO command logic and ZERO fan-out; it
// is a dumb pipe, exactly like beeper-port (plan §2, §8). Everything after the inbound
// event — interpreter, gating, fan-out — is the spine's, shared with every limb.
import { WebSocketServer as WSS } from 'ws';
// The SAME wake matcher the beeper limb uses (auto-mode.mjs) — reused, never duplicated,
// so a shell `@e` is recognized by identical rules (code-fence-stripped, word-boundary).
import { mentionStatus } from '../auto-mode.mjs';
// The SAME persona stamp + concentric wrap the beeper limb renders through — ONE definition
// (operator 2026-07-25: "the bridge must have ONE path"). The shell reply carries its ⏳
// thinking train, its persona stamp, and the agent/bridge signatures on EVERY frame,
// identical to Beeper — because it runs the identical machinery, not a shell-specific copy.
import { makeWrapPersona } from './persona-wrap.mjs';
// Free the port before binding it — the SERVER-role recovery, moved here with the server role
// (it used to live in src/shell/server.mjs, back when the editor bound this port). A stale
// prior spine still holding :23375 on Windows would otherwise leave the console dead with no
// self-healing; and a SQUATTER holding it is exactly the attack this inversion closes, so
// evicting it is the correct response, not a warning.
import { reapPort } from '../tools/reap-port.mjs';
// The shell socket's ONE authentication definition (src/shell/auth.mjs — header there for the
// vulnerability this closes). Loopback is NOT an authenticator: the sandboxed CLI accounts can
// dial 127.0.0.1:23375 as freely as the operator's editor can. The peer that dials this port
// must PROVE it holds the node's shell token before this limb trusts a byte of it. The
// algorithm is imported, never re-implemented — the editor end runs the same module.
import { newNonce, challengeFrame, parseAuthFrame, authMac, macMatches, SHELL_TOKEN_HELP } from '../shell/auth.mjs';

// The spine serves this fixed port; the editor dials in. Exported so boot + tests share the
// one number (plan §3, §9 — fixed port, not discovery).
export const SHELL_WS_PORT = 23375;
// The listener only ever binds LOOPBACK — the operator's console is a local device, never a
// network service.
const SHELL_WS_HOST = '127.0.0.1';
// RE-LISTEN backoff — the SERVER-role recovery, moved here from src/shell/server.mjs with the
// server role (a listener died twice with zero logging and zero recovery; that is the bug this
// shape exists for). NOT the deleted dial-out reconnect: a server never dials, so the limb has
// no reconnect logic at all any more. This arms only when a BIND fails or the listener dies
// unexpectedly, never when a client drops.
const RELISTEN_MIN_MS = 3_000;
const RELISTEN_MAX_MS = 60_000;
// The single console's default chat id + participant. The shell surface has one console,
// so a frame that omits `chatId` lands on this seat; the operator at the shell is a
// PARTICIPANT (authorized), symmetric with a WhatsApp sender — NOT an admin at a special
// console (plan §2). It is the outbound-routing key too (boot routes a shell-surface chat
// back to this socket). That `authorized: true` is EARNED, not assumed: it is stamped only
// on frames from a peer that already passed the auth handshake below (src/shell/auth.mjs).
//
// The seat is `lobby`, not `main` (operator 2026-08-28: the shell is a transport and what it
// opens into is a ROOM — rooms/lobby beside rooms/dj-son, rooms/radio). The chat id IS the
// room's name, exactly as it is for every other room: fixedSlugFor('room','lobby') is a pure
// function of it, so ONE string is the chatId, the slug, the folder rooms/lobby/ and the
// config key room/lobby — resolvable with no registry row at all. `main` would have made
// fixedSlugFor('room','main') yield `main`, splitting the name from the folder and colliding
// with a room an operator could legitimately create. The NETWORK stays 'shell' (below): the
// console's authority is unchanged, only where its files land.
const SHELL_CHAT_ID = 'lobby';
const SHELL_USER = 'operator';

/**
 * @param {object} opts
 * @param {number} [opts.port]                the port to SERVE (default 23375; tests pass 0 for an ephemeral port)
 * @param {typeof WSS} [opts.WebSocketServer] INJECTION SEAM — the `ws` server constructor (default the real import; tests pass a fake so NO real socket opens)
 * @param {string[]} [opts.wakeWords]         the persona's wake-word set (its declared handles, else its map key — router.mjs wakeTokens), SAME set boot hands the beeper bridge. Undefined → mentionStatus' built-in e/egpt defaults.
 * @param {boolean} [opts.addressWithoutAt]   the node's dispatch.address_without_at (DEFAULT true): may a BARE leading handle ("d hola") address, or is the '@' required? Rides beside wakeWords into the SAME mentionStatus call — the same value boot hands the beeper bridge and the router.
 * @param {string} [opts.bridgeSignatureOpen]  per-NODE outer wrap layer — the SAME value boot hands the beeper bridge, so a shell reply's wrap matches the Beeper wrap. Default ''.
 * @param {string} [opts.bridgeSignatureClose]
 * @param {string} [opts.token]               the node's SHELL TOKEN (cfg.shell.token, handed in by boot exactly like bridgeSignatureOpen/nodeName — this limb never reads config itself). The editor that dials in must prove it knows this secret before a single frame is sent to it or accepted from it. UNSET → the limb FAILS CLOSED: it does not SERVE at all and logs what to add to config. No default, no auto-generation, no unauthenticated mode.
 * @param {string} [opts.nodeName]            the STRUCTURAL node id (cfg.node_name), tag-encoded invisibly onto every frame — same value boot hands the beeper bridge. Default ''.
 * @param {string} [opts.header]              the shell status-line header (boot's computeShellHeader) — the initial value handed in at boot, pushed as a header-only frame the moment an editor authenticates. Updatable later via setHeader() (e.g. /room join|leave). Default '' → no header frame sent until setHeader() is called.
 * @param {(m: string) => void} [opts.onLog]
 * @param {typeof reapPort} [opts.reapPort]   port-killer seam (see start()) — real reapPort by default; tests inject a fake so no real netstat/taskkill runs
 * @param {typeof globalThis.setTimeout} [opts.setTimeout]     re-listen timer seam (tests inject a fake clock so no real wait blocks)
 * @param {typeof globalThis.clearTimeout} [opts.clearTimeout]
 */
export function createShellPort({
  port = SHELL_WS_PORT,
  WebSocketServer = WSS,
  wakeWords,
  addressWithoutAt = true,
  bridgeSignatureOpen = '',
  bridgeSignatureClose = '',
  token = '',
  nodeName = '',
  header = '',
  onLog = () => {},
  reapPort: reapPortFn = reapPort,
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  // The SAME wrap the beeper limb binds (boot hands both ports the node's bridge_signature_*),
  // so a persona reply rendered to the shell is wrapped identically to one rendered to Beeper.
  const wrapPersona = makeWrapPersona({ bridgeSignatureOpen, bridgeSignatureClose, nodeName });
  // The PERMANENT header line (boot's computeShellHeader). Pushed the moment an editor passes
  // the handshake — from the ONE place trust is granted below, so first-connect, a reconnecting
  // editor, AND a replacement editor are all covered without any "is this a reconnect" tracking
  // in boot.mjs. `let`, not `const` (operator 2026-08-16: live status-line room reflection) —
  // setHeader() below reassigns it so a LATER editor also carries the latest header, not just
  // the one boot computed at construction time.
  let _header = header;
  // Late-bound inbound handler: the spine registers it AFTER construction (as it does
  // bridge.onMessage), so the message frame reads the ref at call time.
  let onMsg = null;
  // The shared secret an editor must prove it holds. Empty → the limb is DISABLED (fail
  // closed): see start() below.
  const _token = String(token ?? '');
  // `sock` is the AUTHENTICATED console seat — not merely "a socket connected". It is set only
  // by verifyPeer() below, so every existing reader of it (pushFrame's drop guard,
  // isConnected/isAlive, poke's already-serving check) refuses to touch an unverified peer
  // without a single extra branch of its own.
  let wss = null, sock = null, _stopped = false, _listening = false, _relistenTimer = null;
  let _relistenMs = RELISTEN_MIN_MS;   // backs off to RELISTEN_MAX_MS while the port cannot be held
  // Connections that have dialed in but not yet authenticated. Tracked ONLY so the winner of
  // the handshake can shut the door behind it — a stranger must not keep a foot in it.
  const _pending = new Set();
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

  // THE HANDSHAKE, spine side. Called for every frame that arrives on a connection before its
  // peer is trusted; returns true the moment it is. A frame that is not the answer to THAT
  // connection's nonce is DISCARDED — never queued, never replayed once authentication later
  // succeeds, so an impostor cannot front-load a `/upgrade` and have it delivered the instant a
  // genuine editor authenticates. A WRONG answer is fatal for that connection: close it, and
  // LEAVE THE LISTENER SERVING — one bad client must never take the console down.
  function verifyPeer(raw, nonce, ws) {
    const f = parseAuthFrame(raw);
    if (!f || f.auth !== 'response') return false;               // pre-auth noise → dropped on the floor
    if (!macMatches(f.mac, authMac(_token, nonce))) {
      onLog('shell: A CLIENT FAILED THE AUTH CHALLENGE — refusing to trust whatever just dialed 127.0.0.1:23375. '
        + 'Most likely an IMPOSTOR (a sandboxed account can dial loopback freely); otherwise the editor is '
        + 'running with a different shell.token. Dropping that connection; the console stays served.');
      dropPending(ws);
      return false;
    }
    // Trusted from here on: NOW the limb may speak. The header push (the first frame this limb
    // ever sends a peer) is deliberately deferred to this point — before it, the peer is a
    // stranger. Shut the door on every other half-open stranger while we are at it.
    _pending.delete(ws);
    for (const other of _pending) { try { other.close(); } catch { /* closing */ } }
    _pending.clear();
    sock = ws;
    onLog('shell: editor authenticated — console seat live');
    // The permanent header, resent to EVERY editor that takes the seat — a header that only
    // ever sends once would go blank forever after the first editor closed.
    if (_header) pushFrame(SHELL_CHAT_ID, '', { header: _header });
    return true;
  }

  // Close a connection that never earned the seat. Never touches `sock`: an impostor dialing in
  // must not be able to disturb an operator who is already authenticated.
  function dropPending(ws) {
    _pending.delete(ws);
    try { ws?.close?.(); } catch { /* closing */ }
  }

  // A client dialed in. It is a STRANGER until it answers the challenge: it is sent nothing but
  // the nonce, and every frame it pushes is discarded until then.
  function onConnection(ws) {
    if (_stopped) { try { ws.close(); } catch { /* closing */ } return; }
    // SINGLE SEAT, incumbent-holds. The seat is freed by its own socket closing, never taken
    // from it — so neither an unauthenticated client nor a second holder of the token can
    // displace an operator who is already at the console. A refused editor is not stranded:
    // its own reconnect backoff keeps retrying, so it takes over the moment the seat frees.
    if (sock) {
      onLog('shell: a second client dialed in while the console seat is held — refusing it (the seated editor keeps the console)');
      try { ws.close(); } catch { /* closing */ }
      return;
    }
    // Per-CONNECTION handshake state: a fresh nonce every connection, so a recorded answer is
    // useless on the next one.
    const nonce = newNonce();
    let authed = false;
    _pending.add(ws);
    onLog('shell: a client dialed in — challenging it');
    // Handlers FIRST, challenge second: a peer that answers the instant it is challenged must
    // not answer into a socket we have not started listening to yet.
    ws.on('message', (buf) => {
      if (!authed) { authed = verifyPeer(buf, nonce, ws); return; }
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
    ws.on('close', () => {
      _pending.delete(ws);
      if (sock === ws) { sock = null; onLog('shell: editor disconnected — console seat free'); }
    });
    ws.on('error', (e) => onLog(`shell: socket error — ${e?.message ?? e}`));
    try { ws.send(challengeFrame(nonce)); }
    catch (e) { onLog(`shell: challenge send failed — ${e?.message ?? e}`); dropPending(ws); }
  }

  // Bind (or re-bind) the listener and wire its handlers. THE ONE place this wiring exists —
  // start() calls it for the initial bind, and the re-listen recovery below calls it again for
  // every retry, so listening/connection/error/close are never wired twice in two places.
  function bind() {
    _listening = false;
    try { wss = new WebSocketServer({ host: SHELL_WS_HOST, port }); }
    catch (e) { wss = null; onLog(`shell: bind threw — ${e?.message ?? e}`); scheduleRelisten(); return; }
    wss.on('listening', () => { _listening = true; _relistenMs = RELISTEN_MIN_MS; onLog(`shell: serving ws://${SHELL_WS_HOST}:${port} — waiting for the operator's editor to dial in`); });
    wss.on('connection', onConnection);
    wss.on('error', (e) => {
      onLog(`shell: WS SERVER ERROR — ${e?.message ?? e}`);
      // An error BEFORE we ever reached 'listening' means the bind itself failed (something
      // else holds the port) — the console is down and the port is unheld, which is exactly the
      // state this limb exists to prevent, so retry. An error once already listening is logged
      // only: the listener itself is still up.
      if (!_stopped && !_listening) scheduleRelisten();
    });
    wss.on('close', () => {
      sock = null; _pending.clear(); _listening = false;
      if (_stopped) return;   // deliberate stop() — never recover from our own shutdown
      onLog(`shell: WS SERVER CLOSED UNEXPECTEDLY — the console port is UNHELD until it re-listens (retrying in ${Math.round(_relistenMs / 1000)}s)`);
      scheduleRelisten();
    });
    return wss;
  }

  // Exponential backoff for the re-listen: schedule the next attempt at the current backoff,
  // then double it (capped); the reset to MIN happens on a successful 'listening' in bind().
  function scheduleRelisten() {
    if (_relistenTimer) return;   // an attempt is already scheduled
    _relistenTimer = setTimeoutFn(() => { _relistenTimer = null; bind(); }, _relistenMs);
    _relistenMs = Math.min(_relistenMs * 2, RELISTEN_MAX_MS);
  }

  // One outbound frame to the seated editor. Drops (never throws) when no editor holds the seat
  // — a reply with nowhere to go must not crash the spine, same as beeper dropping a send to
  // an unresolvable chat. Carries `streaming` (a live, in-place edit the editor replaces vs a
  // committed final) and, on a withheld reply, `delete` (clear the live line, commit nothing)
  // — the shell's edit-in-place primitive, mirroring the beeper limb's startStreamMessage.
  // Both the plain `send` and the streaming `startStream` render through this single push.
  // `header` is the ONE new optional field (the permanent header line, above): attached only
  // when non-null, so every other caller's frame shape is byte-identical to before.
  function pushFrame(chatId, text, { streaming = false, delete: del = false, header = null } = {}) {
    if (!sock) { onLog('shell: send dropped — editor not connected'); return false; }
    try {
      const frame = { text: String(text), chatId, streaming: !!streaming };
      if (del) frame.delete = true;
      if (header != null) frame.header = header;
      sock.send(JSON.stringify(frame));
      return true;
    }
    catch (e) { onLog(`shell: send failed — ${e?.message ?? e}`); return false; }
  }

  return {
    // BIND the console port and hold it (idempotent-enough for boot: called once). Reaps
    // whatever already holds it FIRST — a stale prior spine orphans this exact port on Windows,
    // and a SQUATTER holding it is the attack this limb's whole shape exists to close, so
    // evicting it is the right answer either way. Runs once, before the FIRST bind only: the
    // re-listen backoff handles any other reason a later attempt fails and needn't re-reap
    // (reapPort's own port===0 guard makes it a no-op for tests' ephemeral `port: 0`).
    // FAIL CLOSED with no token: the limb does not serve AT ALL and says exactly what to add.
    // Deliberately not an auto-generated secret and not a warn-and-continue — an unauthenticated
    // shell socket is a sandbox escape (src/shell/auth.mjs header), so "off" is the safe state.
    // Returns the underlying listener so a caller/test can await 'listening' and read the bound
    // port (ephemeral when `port: 0`); null when the limb is disabled.
    start() {
      if (!_token) { onLog(`shell: DISABLED — no shell token configured, so the operator console cannot be authenticated (an unauthenticated 127.0.0.1:23375 is dialable by any local account). To enable it, ${SHELL_TOKEN_HELP}.`); return null; }
      reapPortFn(port, onLog);
      return bind();
    },
    // The operator's editor just announced itself (ingest marker, right before it starts
    // dialing) — if a bind FAILED and a re-listen is backing off (up to 60s), try NOW instead of
    // riding it out, so the operator's editor has something to dial into. No-op when the
    // listener is already up (the normal case, since the spine binds at boot), when stopped, or
    // when the limb is disabled.
    poke() {
      if (_stopped || _listening || !_token) return;   // no secret → stays disabled, an announce cannot re-enable it
      if (_relistenTimer) { clearTimeoutFn(_relistenTimer); _relistenTimer = null; }
      _relistenMs = RELISTEN_MIN_MS;
      bind();
    },
    onMessage(cb) { onMsg = cb; },
    // Does this chat id belong to the shell surface? boot's routed send consults this to
    // push a shell-surface reply back over the socket instead of the beeper bridge.
    owns(chatId) { return _chatIds.has(chatId); },
    // Register a chat id as shell-owned WITHOUT it having arrived inbound — boot's room
    // redirect (a shell turn dispatched as room <slug> instead of the native lobby seat)
    // sends its reply to ev.chatId, which is now the room slug, not the id this socket last
    // saw. owns() must recognize it too, or the reply would be handed to the wrong bridge.
    // Generic on purpose: this limb still carries zero room logic, only the registry itself.
    claim(chatId) { _chatIds.add(chatId); },
    // Push an UPDATED header line now (operator 2026-08-16: live status-line room reflection,
    // e.g. after /room join|leave) — boot.mjs's onRoomChange calls this with a freshly
    // recomputed computeShellHeader(). Reassigns _header so the NEXT editor to take the seat
    // resends the NEW line too, not the one captured at construction. Drops (never throws)
    // when no editor holds the seat, same as any other push — the next editor's handshake
    // still carries the latest _header.
    setHeader(newHeader) { _header = newHeader ?? ''; return pushFrame(SHELL_CHAT_ID, '', { header: _header }); },
    // Is the operator's editor currently dialed in AND authenticated? /status's `shell:` field
    // reads this (boot wires shellConnected: () => shellPort.isConnected).
    get isConnected() { return !!sock; },
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
    isAlive: () => !!sock,
    // The CURRENT underlying listener — reassigned on every re-listen, so a caller that needs
    // the live instance (a test awaiting a re-listened server's 'listening' event) always reads
    // the up-to-date one rather than the one start() first returned.
    get wss() { return wss; },
    stop: () => {
      _stopped = true;   // BEFORE closing wss, so its 'close' handler sees a deliberate stop
      if (_relistenTimer) { clearTimeoutFn(_relistenTimer); _relistenTimer = null; }
      try { sock?.close?.(); } catch { /* closing */ }
      for (const p of _pending) { try { p.close(); } catch { /* closing */ } }
      _pending.clear();
      try { wss?.close?.(); } catch { /* closing */ }
      sock = null; wss = null; _listening = false;
    },
  };
}
