// shell-port.mjs — the operator-console LIMB: a WebSocket SERVER the spine binds AT BOOT and
// HOLDS on 127.0.0.1:<shell.port>, 23475 by default. The EDITOR (the "shell") is the CLIENT: it
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
// TWO ROLES ON ONE PORT (operator 2026-09-05). The same listener also serves the MOUTH LINK: a
// second spine on this machine, holding the OTHER Beeper account, dials MOUTH_PATH here, proves it
// holds the same shell token, and has a FINISHED line posted on this node's account. It rides this
// port because the handshake, the bind-at-boot-and-hold property and the squatter protection are
// already solved here and must not be re-solved on a second listener. The role is the dial PATH,
// read before a byte is exchanged, and a peer NEVER takes the console seat — so an open editor
// cannot lock the mouth out and the mouth cannot lock the operator out. The limb stays a dumb pipe:
// it recognizes the frame and hands it to the injected onPeerSay, which owns every decision.
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
// prior spine still holding this port on Windows would otherwise leave the console dead with
// no self-healing, and that spine is still reaped.
// A SQUATTER IS NO LONGER EVICTED, and the sentence that used to stand here — "a SQUATTER
// holding it is exactly the attack this inversion closes, so evicting it is the correct
// response, not a warning" — was retired by the operator on 2026-09-11. Beeper Desktop claims
// ports upward from 23373 and is the squatter on this machine, so that reap would taskkill the
// messaging backend to reclaim a port the daemon has just been told the spine does not need in
// order to serve. reap-port.mjs's `mine` guard is where that decision lives now.
// …and, from the same module and the same parser, the READ-ONLY half: who is holding it. A
// bind that fails must be able to NAME the squatter, or the operator is back to running
// netstat by hand (see noteUnbound below — that is exactly what happened on 2026-09-11).
import { reapPort, portHolders, isOwnSpine, OWN_SPINE_LABEL, PORT_LOOKUP_TOOL } from '../tools/reap-port.mjs';
// The shell socket's ONE authentication definition (src/shell/auth.mjs — header there for the
// vulnerability this closes). Loopback is NOT an authenticator: the sandboxed CLI accounts can
// dial 127.0.0.1:23375 as freely as the operator's editor can. The peer that dials this port
// must PROVE it holds the node's shell token before this limb trusts a byte of it. The
// algorithm is imported, never re-implemented — the editor end runs the same module.
import { newNonce, challengeFrame, parseAuthFrame, authMac, macMatches, SHELL_TOKEN_HELP } from '../shell/auth.mjs';
// The MOUTH wire (src/shell/mouth.mjs — header there for the whole arrangement). A second spine on
// this machine, holding the OTHER Beeper account, dials this same port on MOUTH_PATH to have a
// finished line said on its behalf. Its frames carry a `say` discriminator and are recognized
// BEFORE the console parse, for the same reason auth frames are: a console frame means "a human
// said this" and would RUN A TURN, and the mouth means the exact opposite — "post this verbatim".
// The wire is imported, never re-implemented; the peer end reads the same module.
import { MOUTH_PATH, isMouthDial, parseMouthFrame, sayResultFrame, sayOpenedFrame } from '../shell/mouth.mjs';

// The spine serves this port; the editor dials in. Exported so boot + tests share the
// one number (plan §3, §9 — a KNOWN port, not discovery).
//
// 23375 UNTIL 2026-09-11, AND IT WAS INSIDE BEEPER'S SCAN RANGE. Beeper Desktop takes the next
// free port from 23373 upward (src/tools/beeper-whoami.mjs scans 23373..23385), so this default
// sat four ports into a range another program helps itself to. At the S0→S1 logon that night
// Beeper grabbed 23375 the instant the departing spine released it, the arriving spine could not
// bind its console at all, and the daemon's stand-down watch — which read that port as "is the
// profile held" — put a second spine on a held profile. The watch no longer trusts a port for
// that question (src/daemon-runtime.mjs), but a default that collides with a program on every
// one of these machines is still wrong. 23475 is the number the live nodes were moved to that
// night (kg 23475, kg2 23477), so the code default and the deployment now say the same thing —
// including when config.yaml is unreadable and the daemon falls back to this number.
export const SHELL_WS_PORT = 23475;
// ...but the number is no longer FIXED (operator 2026-09-02). Two spines can now run on one
// machine — one in Session 0 holding the agent's Beeper, one in Session 1 holding the
// operator's — and they cannot both bind 23375. The transcriptor and synthesizer ports were
// already config-driven (cfg.transcriptor.port, cfg.transcriptor.server.port); the console
// was the one limb that never got the same treatment, which is what made a second spine on a
// box impossible.
//
// Read HERE rather than in the limb: shell-port never touches config, boot hands it every
// option (see the token, same shape). A missing / malformed / out-of-range value falls back to
// SHELL_WS_PORT rather than throwing — a node with no shell.port must still serve a console,
// and a typo must not stop the spine from serving a console at all.
export function shellPortFrom(cfg) {
  const n = Number(cfg?.shell?.port);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : SHELL_WS_PORT;
}
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
 * @param {number} [opts.port]                the port to SERVE (default 23475; tests pass 0 for an ephemeral port)
 * @param {typeof WSS} [opts.WebSocketServer] INJECTION SEAM — the `ws` server constructor (default the real import; tests pass a fake so NO real socket opens)
 * @param {string[]} [opts.wakeWords]         the persona's wake-word set (its declared handles, else its map key — router.mjs wakeTokens), SAME set boot hands the beeper bridge. Undefined → mentionStatus' built-in e/egpt defaults.
 * @param {boolean} [opts.addressWithoutAt]   the node's dispatch.address_without_at (DEFAULT true): may a BARE leading handle ("d hola") address, or is the '@' required? Rides beside wakeWords into the SAME mentionStatus call — the same value boot hands the beeper bridge and the router.
 * @param {string} [opts.bridgeSignatureOpen]  per-NODE outer wrap layer — the SAME value boot hands the beeper bridge, so a shell reply's wrap matches the Beeper wrap. Default ''.
 * @param {string} [opts.bridgeSignatureClose]
 * @param {string} [opts.token]               the node's SHELL TOKEN (cfg.shell.token, handed in by boot exactly like bridgeSignatureOpen/nodeName — this limb never reads config itself). The editor that dials in must prove it knows this secret before a single frame is sent to it or accepted from it. UNSET → the limb FAILS CLOSED: it does not SERVE at all and logs what to add to config. No default, no auto-generation, no unauthenticated mode.
 * @param {string} [opts.nodeName]            the STRUCTURAL node id (cfg.node_name), tag-encoded invisibly onto every frame — same value boot hands the beeper bridge. Default ''.
 * @param {string} [opts.header]              the shell status-line header (boot's computeShellHeader) — the initial value handed in at boot, pushed as a header-only frame the moment an editor authenticates. Updatable later via setHeader() (e.g. /rooms join|leave). Default '' → no header frame sent until setHeader() is called.
 * @param {{post?: Function, open?: Function, update?: Function, finish?: Function, react?: Function, gone?: Function}} [opts.onPeerSay]
 *   THE MOUTH HANDLER (src/shell/peer-mouth.mjs createMouthReceiver), handed in by boot exactly
 *   like the token — this limb never builds it and never reads config. Given, a PEER SPINE may
 *   dial MOUTH_PATH on this port, prove it holds the same shell token, and have a line posted on
 *   THIS node's Beeper account — whole (`post`) or as a live reply train it opens, edits and
 *   settles (`open`/`update`/`finish`), or place a REACTION on one of this account's own messages
 *   (`react`). One entry per wire verb; MOUTH_ANSWER below is the
 *   routing table and also the ALLOWLIST, so a table entry that is not a verb — `gone`, which the
 *   limb calls itself when a peer connection closes — can never be reached from a frame. UNSET
 *   (the default, and every node that configures no peer): a mouth dial is closed immediately, so
 *   the limb behaves exactly as it did before this existed. Each handler's answer — success or
 *   refusal — is pushed straight back over the same socket so the peer can fall back to speaking
 *   on its own account.
 * @param {(m: string) => void} [opts.onLog]
 * @param {typeof reapPort} [opts.reapPort]   port-killer seam (see start()) — real reapPort by default; tests inject a fake so no real netstat/taskkill runs
 * @param {typeof portHolders} [opts.portHolders]   port-OWNER lookup seam, used ONLY on a failed bind to name the squatter in the log; real portHolders by default, tests inject a fake so no real netstat runs
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
  onPeerSay = null,
  onLog = () => {},
  reapPort: reapPortFn = reapPort,
  portHolders: portHoldersFn = portHolders,
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
  // Consecutive bind attempts that never reached 'listening', reset the moment one does. It is
  // in every NO-CONSOLE line because the count is the whole point: attempt 1 is an accident,
  // attempt 40 is a standing state nobody has been told about.
  let _bindFailures = 0;
  // Connections that have dialed in but not yet authenticated. Tracked ONLY so the winner of
  // the handshake can shut the door behind it — a stranger must not keep a foot in it.
  const _pending = new Set();
  // AUTHENTICATED PEER-SPINE connections (the mouth link). Kept separate from `sock` on purpose:
  // a peer is NOT at the console. It never takes the seat, so it can neither be locked out by a
  // seated editor nor lock the operator out by holding the seat itself — and every existing reader
  // of `sock` (pushFrame's drop guard, isConnected/isAlive, poke's already-serving check) keeps
  // meaning exactly what it meant, with no extra branch. Tracked only so stop() can close them.
  const _mouths = new Set();
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
  // `mouth` is the ONE branch this shared handshake grew (2026-09-05): a verified PEER SPINE is
  // trusted to have a line said, not to hold the console. So it takes no seat, gets no header, and
  // — deliberately — does NOT evict the other half-open strangers: a mouth dial arriving while the
  // operator's editor is mid-handshake must not knock that editor out.
  function verifyPeer(raw, nonce, ws, { mouth = false } = {}) {
    const f = parseAuthFrame(raw);
    if (!f || f.auth !== 'response') return false;               // pre-auth noise → dropped on the floor
    if (!macMatches(f.mac, authMac(_token, nonce))) {
      onLog(`shell: A CLIENT FAILED THE AUTH CHALLENGE${mouth ? ` (on ${MOUTH_PATH}, so it claimed to be a peer spine)` : ''} — refusing to trust whatever just dialed 127.0.0.1:${port}. `
        + 'Most likely an IMPOSTOR (a sandboxed account can dial loopback freely); otherwise the editor is '
        + 'running with a different shell.token. Dropping that connection; the console stays served.');
      dropPending(ws);
      return false;
    }
    if (mouth) {
      _pending.delete(ws);
      _mouths.add(ws);
      onLog('shell: a peer spine authenticated on the mouth link');
      return true;
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

  // One frame to a socket that is NOT the console seat (a peer on the mouth link). pushFrame is
  // bound to `sock` by design — a peer must never be reachable through the console's send path —
  // so the mouth answer needs its own one-liner. Never throws, same as every other push here.
  function pushTo(ws, raw) {
    try { ws.send(raw); return true; }
    catch (e) { onLog(`shell: mouth answer failed — ${e?.message ?? e}`); return false; }
  }

  // WHICH ANSWER EACH VERB GETS — the whole routing table for the mouth link, and deliberately the
  // ONLY way into the mouth handler. A verb absent from here is refused, so nothing the peer can
  // put on the wire reaches a handler that is not listed (the receiver's `gone` is not a verb and
  // is therefore unreachable from a frame — it is the LIMB's to call, on close, and nobody else's).
  // `update` maps to null: it is answered with nothing at all (src/shell/mouth.mjs — every frame
  // carries the whole text, so an ack per token would double the traffic for no information).
  // `react` answers with sayResultFrame for the same reason `post` does — the brain must learn
  // whether the 👀 was placed, because the ONLY safe alternative to the peer placing it is placing
  // none at all (src/shell/mouth.mjs).
  const MOUTH_ANSWER = { post: sayResultFrame, open: sayOpenedFrame, finish: sayResultFrame, update: null, react: sayResultFrame };

  // A mouth frame off an AUTHENTICATED peer connection: hand it to the verb the peer named and push
  // that verb's verdict straight back. THIS PATH NEVER REACHES onMsg — a peer's frame is a reply to
  // be POSTED or EDITED, not a message to be answered, and dispatching one as a turn is the exact
  // failure src/shell/mouth.mjs exists to prevent. A handler that throws still answers (a peer
  // holding an unsaid reply must learn it was not said, so it can fall back to its own account).
  //
  // AN UNKNOWN VERB IS REFUSED, NEVER IGNORED, and it is refused with `bad-frame` on purpose: that
  // is exactly what a peer running NEWER code hears from a node running older code, and it is the
  // signal it degrades on (a spine that asks for a reply train and is told `bad-frame` sends the
  // finished line instead). Silence would leave it waiting for its own timeout.
  function handleMouth(raw, ws) {
    const f = parseMouthFrame(raw);
    const verb = f?.say ?? '';
    const answerFrame = Object.hasOwn(MOUTH_ANSWER, verb) ? MOUTH_ANSWER[verb] : undefined;
    const handler = answerFrame !== undefined ? onPeerSay?.[verb] : null;
    if (!handler) {
      onLog(`shell: a peer sent a frame the mouth link does not serve (${verb ? `say:${verb}` : 'not a mouth frame'}) — refusing`);
      pushTo(ws, sayResultFrame({ ok: false, reason: 'bad-frame', detail: `the mouth link does not serve ${verb ? `say:${verb}` : 'that frame'}` }));
      return;
    }
    const answer = (r) => { if (answerFrame) pushTo(ws, answerFrame(r && typeof r === 'object' ? r : { ok: false, reason: 'send-failed', detail: 'the mouth handler answered nothing' })); };
    // try/catch AND .catch: a handler that throws SYNCHRONOUSLY would otherwise escape into the
    // socket's read loop, exactly as the console path guards its own onMsg call. `ws` is handed
    // along as the CONNECTION the frame arrived on — the mouth table keys its live streams by it,
    // which is what lets a close settle exactly the replies that connection left open.
    try {
      Promise.resolve(handler(f, ws))
        .then(answer)
        .catch((e) => { if (answerFrame) pushTo(ws, answerFrame({ ok: false, reason: 'send-failed', detail: e?.message ?? String(e) })); });
    } catch (e) { if (answerFrame) pushTo(ws, answerFrame({ ok: false, reason: 'send-failed', detail: e?.message ?? String(e) })); }
  }

  // A client dialed in. It is a STRANGER until it answers the challenge: it is sent nothing but
  // the nonce, and every frame it pushes is discarded until then.
  //
  // `req` is the upgrade request the `ws` server hands alongside the socket. Its PATH is the role
  // (src/shell/mouth.mjs): MOUTH_PATH = a peer spine wanting a line said, anything else = the
  // operator's editor, which is what every existing caller and every absent req reads as. The role
  // has to be known HERE, before a byte is exchanged, because the single-seat rule below is
  // decided at connection time — and a peer must neither be refused for a seat it does not want
  // nor take the seat away from the operator.
  function onConnection(ws, req) {
    if (_stopped) { try { ws.close(); } catch { /* closing */ } return; }
    const mouth = isMouthDial(req);
    // NO MOUTH CONFIGURED (the default, and every node with no peer): a peer dial is closed on
    // the spot. Not answered with a refusal frame — a stranger is told NOTHING before it
    // authenticates, and this decision is made before the handshake. It is also never demoted to
    // a console connection: a dial that asked to be a peer must not become an operator seat.
    if (mouth && !onPeerSay) {
      onLog(`shell: a client dialed ${MOUTH_PATH} but this node offers no mouth link (no peer configured) — refusing it`);
      try { ws.close(); } catch { /* closing */ }
      return;
    }
    // SINGLE SEAT, incumbent-holds. The seat is freed by its own socket closing, never taken
    // from it — so neither an unauthenticated client nor a second holder of the token can
    // displace an operator who is already at the console. A refused editor is not stranded:
    // its own reconnect backoff keeps retrying, so it takes over the moment the seat frees.
    // …for CONSOLE clients only. A peer on the mouth link is not asking for the seat, so a seated
    // editor must not lock the mouth out (the operator's editor is open most of the time, which
    // would otherwise mean the peer's replies stop whenever the console is in use).
    if (sock && !mouth) {
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
      if (!authed) { authed = verifyPeer(buf, nonce, ws, { mouth }); return; }
      if (mouth) { handleMouth(buf, ws); return; }
      // A MOUTH FRAME ON THE CONSOLE CONNECTION is discarded, never dispatched. It can only be a
      // misconfigured peer (one that dialled the root instead of MOUTH_PATH), and the console's
      // toInbound below would hand the raw JSON to the spine as something a human typed — a turn
      // run on a finished reply. Belt and braces beside the path check: nothing carrying `say`
      // reaches the dispatch, whichever door it came in.
      if (parseMouthFrame(buf)) { onLog(`shell: a mouth frame arrived on the CONSOLE connection (a peer must dial ${MOUTH_PATH}) — discarded, never dispatched`); return; }
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
      _mouths.delete(ws);
      // A PEER LINK THAT GOES MAY BE HOLDING A HALF-WRITTEN REPLY (src/shell/peer-mouth.mjs, THE
      // MID-STREAM DROP). The limb neither knows nor decides what is open — it reports the fact of
      // the close and the mouth table settles whatever that connection still had. A reply that
      // COMPLETED left nothing open, so this is a no-op for every ordinary close; only a link that
      // died mid-thought has anything to settle, which is exactly how the two are told apart.
      if (mouth) { try { onPeerSay?.gone?.(ws); } catch (e) { onLog(`shell: the mouth could not settle what a departing peer left open — ${e?.message ?? e}`); } }
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
    catch (e) { wss = null; noteUnbound(`the bind threw — ${e?.message ?? e}`); return; }
    wss.on('listening', () => {
      _listening = true; _relistenMs = RELISTEN_MIN_MS;
      // The recovery is as much news as the failure was: a node that has been consoleless for
      // an hour must say when the console came back, and after how many tries.
      if (_bindFailures) onLog(`shell: CONSOLE BACK — bound ws://${SHELL_WS_HOST}:${port} after ${_bindFailures} failed attempt${_bindFailures === 1 ? '' : 's'}. The operator's editor can dial in again.`);
      _bindFailures = 0;
      onLog(`shell: serving ws://${SHELL_WS_HOST}:${port} — waiting for the operator's editor to dial in`);
    });
    wss.on('connection', onConnection);
    wss.on('error', (e) => {
      onLog(`shell: WS SERVER ERROR — ${e?.message ?? e}`);
      // An error BEFORE we ever reached 'listening' means the bind itself failed (something
      // else holds the port) — the console is down and the port is unheld, which is exactly the
      // state this limb exists to prevent, so retry. An error once already listening is logged
      // only: the listener itself is still up.
      if (!_stopped && !_listening) noteUnbound(String(e?.message ?? e));
    });
    wss.on('close', () => {
      sock = null; _pending.clear(); _mouths.clear(); _listening = false;
      if (_stopped) return;   // deliberate stop() — never recover from our own shutdown
      onLog(`shell: WS SERVER CLOSED UNEXPECTEDLY — the console port is UNHELD until it re-listens (retrying in ${Math.round(_relistenMs / 1000)}s)`);
      scheduleRelisten();
    });
    return wss;
  }

  // Exponential backoff for the re-listen: schedule the next attempt at the current backoff,
  // then double it (capped); the reset to MIN happens on a successful 'listening' in bind().
  // Returns the delay it ARMED, or null when an attempt was already pending — so a caller can
  // state the real wait instead of guessing at it.
  function scheduleRelisten() {
    if (_relistenTimer) return null;   // an attempt is already scheduled
    const armedMs = _relistenMs;
    _relistenTimer = setTimeoutFn(() => { _relistenTimer = null; bind(); }, armedMs);
    _relistenMs = Math.min(_relistenMs * 2, RELISTEN_MAX_MS);
    return armedMs;
  }

  // --- A BIND THAT FAILS IS A STANDING STATE, NOT A TRANSIENT ERROR ------------------------
  // (reve, the night of 2026-09-11 — the silent half of the stand-down bug.)
  //
  // WHAT HAPPENED. Beeper Desktop claims the first free port upward from 23373 and took this
  // spine's console number. The limb did the right thing — it retried, and it kept retrying —
  // but every attempt logged the same bare `WS SERVER ERROR — listen EADDRINUSE`, 16 of them,
  // while the spine served 6 real turns in the same window. Nothing anywhere said the three
  // things a human needed: that this node HAS NO CONSOLE, that it is still answering messages
  // regardless, and WHAT is holding the port. A forever-loop that never states its own
  // condition is indistinguishable from a hang.
  //
  // AND IT IS NOW A NORMAL OUTCOME. The daemon's stand-down watch no longer lets a squatted
  // console port veto a respawn (src/daemon-runtime.mjs — spine.pid decides), so a spine being
  // started deliberately INTO a squatted port is the expected case, not a fault. This line is
  // the spine's half of that decision: it is a loud statement of fact, not an alarm.
  //
  // THE HOLDER LOOKUP is the read-only half of the reap the limb already does at start(), and
  // it runs only on a FAILED bind — never on a schedule — so at steady state it costs one
  // netstat per re-listen, i.e. one a minute once the backoff caps. When it comes back empty
  // the line SAYS it came back empty, and which tool it asked; it never renders as a blank.
  function describeHolder() {
    let who = [];
    try { who = portHoldersFn(port) ?? []; }
    catch (e) { return `and looking up what holds it FAILED (${e?.message ?? e}), so it cannot be named here`; }
    if (!who.length) return `and I could not name what holds it — ${PORT_LOOKUP_TOOL} reported no LISTENING owner for :${port}, so look by hand`;
    return `held by ${who.map((h) => (h?.name ? `pid ${h.pid} (${h.name})` : `pid ${h?.pid}`)).join(', ')}`;
  }

  function noteUnbound(reason) {
    _bindFailures += 1;
    const armedMs = scheduleRelisten();
    const next = armedMs == null ? 'a retry is already pending' : `retrying in ${Math.round(armedMs / 1000)}s`;
    onLog(`shell: NO CONSOLE — could not bind ws://${SHELL_WS_HOST}:${port} (attempt ${_bindFailures}: ${reason}), ${describeHolder()}. THE SPINE IS STILL SERVING: messages, the heartbeat and the mouth link do not touch this port — only the operator's editor does. ${next}, and I will not stop.`);
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
    // A STALE PRIOR SPINE OF OURS off it FIRST — that one orphans this exact port on Windows,
    // where a child outlives its parent — and reaps nothing else: see the guard below and
    // reap-port.mjs's `mine`. Runs once, before the FIRST bind only: the
    // re-listen backoff handles any other reason a later attempt fails and needn't re-reap
    // (reapPort's own port===0 guard makes it a no-op for tests' ephemeral `port: 0`).
    // FAIL CLOSED with no token: the limb does not serve AT ALL and says exactly what to add.
    // Deliberately not an auto-generated secret and not a warn-and-continue — an unauthenticated
    // shell socket is a sandbox escape (src/shell/auth.mjs header), so "off" is the safe state.
    // Returns the underlying listener so a caller/test can await 'listening' and read the bound
    // port (ephemeral when `port: 0`); null when the limb is disabled.
    start() {
      if (!_token) { onLog(`shell: DISABLED — no shell token configured, so the operator console cannot be authenticated (an unauthenticated 127.0.0.1:${port} is dialable by any local account). To enable it, ${SHELL_TOKEN_HELP}.`); return null; }
      // THE REAP ONLY EVICTS ONE OF OUR OWN (operator, the night of 2026-09-11). This line used
      // to be `reapPortFn(port, onLog)`, which killed WHATEVER was listening — and on this
      // machine that is Beeper Desktop, the messaging backend, which claims ports upward from
      // 23373. It would have been taskkill'd to reclaim a number the daemon has just been told
      // the spine does not need in order to serve. So: a stale prior spine of ours is still
      // reaped, and anything else is named and left alone. Whatever survives ends up in
      // noteUnbound's NO CONSOLE line a moment later, by name.
      reapPortFn(port, onLog, { mine: isOwnSpine, mineLabel: OWN_SPINE_LABEL });
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
    // e.g. after /rooms join|leave) — boot.mjs's onRoomChange calls this with a freshly
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
      for (const m of _mouths) { try { m.close(); } catch { /* closing */ } }
      _mouths.clear();
      try { wss?.close?.(); } catch { /* closing */ }
      sock = null; wss = null; _listening = false;
    },
  };
}
