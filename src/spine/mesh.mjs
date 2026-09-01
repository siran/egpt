// mesh.mjs — the §2c mesh service: cross-node being relay (plans/2606291226-SPINE-REWRITE-PLAN.md
// Phase 4b). `@being.node` in a chat reaches a being on ANOTHER machine; the reply
// streams back into the origin chat as a LIVING MIRROR (an edit-streamed placeholder
// that fills in as the remote being answers).
//
// The engine is the battle-tested `src/mesh/relay.mjs` (createMeshRelay) — the wire
// format (base64 body + readable provenance tail) and the streaming living-mirror all
// live there and are test-locked (tests/mesh-relay.test.mjs). Loop safety is the bridge's:
// a node never re-sees its OWN posts (echo suppression) and a foreign re-delivery dedups by
// message id, so each node processes each envelope once (no minted request-id needed).
// This service's whole job is to supply the engine's host callbacks FROM v2 services:
//
//   send / surface / ackWithPostId   ->  the Bridge port (send / postStatus)
//   relayDispatch / openOriginStream ->  the Bridge port's startStream (edit-stream)
//   runBeing (via relayDispatch)     ->  the Brain port (brain.turn), streaming
//   isLocalBeing / resolveBeingRelay ->  config (node_name, agents)
//
// The spine wires the three entry points into handleInbound (spine.mjs):
//   isEnvelope(ev)  — a message carrying a provenance tail is relay traffic, not chat.
//   handle(ev)      — process an envelope (BOTH directions: a request at the responder,
//                     a reply/mirror-update at the origin).
//   forward(ev,tgt) — a human's "@being.node …" is relayed to the target's node.
//   onEdit(edit)    — a streamed edit in the relay chat mirrors onward (wired to
//                     bridge.onEdit at boot); returns truthy-if-consumed (bridge contract).
//
// Relay-chat resolution (which chat physically carries the envelope) is AGENT-BASED
// (operator 2026-07-25 — the `mesh.nodes` node routing table was evicted as dysfunctional
// legacy): the chat is a relay agent's own `relay_channel`, resolved name→id by the bridge.
// A node with no relay agents originates nothing; it can still answer what reaches it.
import { createMeshRelay, encodeMesh, parseMesh, agentPaths, ANON_SENDER } from '../mesh/relay.mjs';
// The ONE definition of the persona stamp + concentric wrap every surface port renders through
// ("the bridge must have ONE path", 2026-07-25). The RESPONDER renders its reply through THIS —
// the same renderer a local reply gets — before encodeMesh, because the payload is what travels.
import { personaStamp, makeWrapPersona } from '../bridges/persona-wrap.mjs';
// THE routing table, derived from the AGENTS block (there is no mesh.nodes since 2026-07-25):
// an agent with a relay_channel and `to: <being>.<node>` IS the statement that its channel
// reaches that node. The SAME derivation the command service reads to know what a node name is.
import { agentRoutes } from './node-names.mjs';
// addressed: THE mention matcher (declared `handles:`, else the map key — router.mjs's wake
// vocabulary), imported so an envelope's `<being>.<node>` resolves identically to a typed @token.
// findAgentByToken below is a single-already-parsed-token lookup (bare form, addressWithoutAt),
// not a free-text scan — this file used to carry its own hand-rolled wake-token loop, which is
// how the two could drift.
import { addressed } from './router.mjs';
// ALLOWED_USERS GATE (operator 2026-08-15) — the RESPONDER-side half of router.mjs's own
// two-tier reachability rule (see its ALLOWED_USERS GATE comment in resolve()): getBeing reads
// the per-conversation override, allowedUsersPermits (shared with router.mjs, operator
// 2026-08-16) does the sender-id match, including the "*" wildcard.
import { getBeing, allowedUsersPermits } from '../conversations-state.mjs';

const PLACEHOLDER = '🤔 thinking…';
// A relayed turn that lands BEHIND another turn on the same key says so, instead of showing a
// second identical "thinking" (operator 2026-08-31 — the second bare placeholder IS the fault
// report). Same vocabulary as the local queued placeholder (src/spine/sender.mjs's QUEUED),
// carried home by the mirror that already exists: no protocol change, because `wrap` below
// forces the idle text for an empty body and the origin renders whatever body arrives.
const QUEUED = (ahead) => `🤔 waiting behind ${ahead}…`;
const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? '');

export function createMeshService({
  bridge,                              // the Bridge port (send, startStream, postStatus, onEdit)
  brain,                               // the Brain port (turn) — runs the local being for the responder
  // The command service (createCommands). A node-addressed command can travel as an envelope
  // (operator 2026-07-26 — egpt as a remote control for the network); at the RESPONDER the
  // arriving prompt is executed through this instead of being handed to the being. Null (tests,
  // standalone) → an arriving command is ordinary relayed text, exactly as before.
  commands = null,
  getConfig = () => ({}),
  bodyEmojiOf = () => '',              // (being) => body_emoji — stamps the relayed reply
  getSelfChatId = () => null,          // () => this node's Self chat id — the fallback transport when a relay channel doesn't resolve
  // `loadState` (operator 2026-08-15, allowed_users) — () => Promise<conv state>, the SAME
  // conversations-state IO router.mjs's createRouter and gating.mjs's createGating take, injected
  // the same way (mirrored, not duplicated). Absent (tests, a caller that doesn't need per-
  // conversation overrides) → relayDispatch's allowed_users gate simply never reads a per-
  // conversation override, and a being's reachability falls straight to its global
  // agents.<handle>.conversation_defaults.allowed_users default (or unrestricted, when neither
  // tier is set) — today's behaviour for a caller that supplies nothing.
  loadState = null,
  // THE SPINE'S OWN TURN MACHINERY (src/spine/turns.mjs, operator 2026-08-31), THE SAME INSTANCE
  // createSpine got — boot.mjs builds it once, above both. A relayed turn is a turn: it belongs on
  // the same per-conversation FIFO, under the same queued placeholder, behind the same
  // allow_new_input steer. It could not be, because all of that was private to createSpine, so
  // relayDispatch called brain.turn bare and a second envelope in one conversation opened a second
  // bare placeholder while both turns ran (the fault report's counters: scopeOf 0, allowNewInput 0,
  // steer 0). Since f70edce the turn runs in the ORIGIN conversation, so it derives the SAME key a
  // LOCAL message in that chat derives and the two collide correctly — which is the whole reason
  // ONE instance is required and a second private one would be a fresh defect.
  //
  // NULL (tests, a standalone caller) → relayDispatch is byte-for-byte the pre-2026-08-31 body: no
  // queue, no steer, no depth in the placeholder.
  turns = null,
  // Timer seams (injected so the origin-wait timeout is testable without real time).
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t?.unref) t.unref(); return t; },
  clearTimer = (t) => { if (t != null) clearTimeout(t); },
  onLog = () => {},
} = {}) {
  if (!bridge) throw new Error('createMeshService: bridge is required');
  const cfg = () => getConfig() ?? {};
  const node = String(cfg().node_name ?? 'node').toLowerCase();   // this spine's node (boot-stable)
  // SELF-set: node_name ∪ node_alias (operator 2026-07-05) — the identities THIS one
  // process answers to. A relay envelope targeting @being.<any-self-name> is handled
  // locally (never forwarded to ourselves); the reply is stamped with the addressed-as
  // name. Boot-stable like `node`. Absent/empty node_alias → just { node_name }.
  const selfNodes = new Set([node, ...(Array.isArray(cfg().node_alias) ? cfg().node_alias : [])
    .map((a) => String(a ?? '').trim().toLowerCase()).filter(Boolean)]);
  const isSelfNode = (n) => selfNodes.has(String(n ?? '').toLowerCase());
  const agents = () => cfg().agents ?? {};                         // the unified registry (new-config-only)
  // Render a being's reply the way EVERY other reply on this node is rendered — the shared stamp
  // + concentric wrap, bound to this node's own bridge_signature_* (the SAME cfg keys boot hands
  // beeper-port and shell-port). The RESPONDER renders BEFORE encodeMesh: the payload is the
  // message being transported (operator 2026-07-25 — "signing by do … is the message being
  // transported … a nugget"), so the stamp + this node's signature travel INSIDE it. Rendering at
  // send time instead would land them OUTSIDE the fence and make parseMesh reject the envelope.
  // nodeName carries the STRUCTURAL layer inside the nugget too — the same cfg key, read the same
  // lazy way as the visible ones. The ORIGIN re-wraps the nugget when it posts it, and the wrap
  // replaces rather than stacks markers, so the surfaced frame ends up naming the spine that put
  // it on the surface while the envelope's own provenance lines still name who answered.
  const renderReply = (being, text) => makeWrapPersona({ bridgeSignatureOpen: cfg().bridge_signature_open ?? '', bridgeSignatureClose: cfg().bridge_signature_close ?? '', nodeName: cfg().node_name ?? '' })({ bodyEmoji: bodyEmojiOf(being), label: being }, text);
  const timeoutMs = () => Number(cfg().mesh?.timeout_ms ?? 60_000) || 60_000;

  // Find the non-comment agent whose WAKE TOKEN matches `token` → { name, agent }
  // (name = canonical lowercased key = the BEING-ID that runs) or null. Runs the SAME mention
  // matcher the router's own @token scan uses (`addressed`, bare-form: the wire token never
  // carries an '@'), the same rule that applies to a direct @mention, so an envelope's
  // `<being>.<node>` and a typed @token can never disagree about who is addressed (they now share
  // ONE implementation, not just one RULE). Since 2026-07-26 the map KEY is NOT a token when
  // handles are declared: an envelope to `egpt.do` no longer wakes DOLLY (keyed `egpt`, handles
  // [d, don]) — answering it would stamp `by: egpt.do`, exactly what the ruling forbids — while
  // `don.do` still resolves to the being-id `egpt` and runs.
  //
  // THE ONE resolution for EVERY `<being>` token this service is handed — the wake gate
  // (isLocalBeing/resolveLocalBeing) AND relay ROUTING (resolveBeingRelay). Routing used to do a
  // bare `agents()[being]` (key only), so an agent addressed by a handle that differs from its key
  // passed the gate and then its `to:` chain missed — nothing travelled (operator 2026-07-26: "the
  // relay agent must route with the handle, not with the key").
  //
  // A MULTIPATH agent is included and needs no special case: since 2026-07-26 it is an ordinary
  // map carrying a `paths:` list, so it declares `handles:` like anyone else (and falls back to
  // its key when it doesn't).
  //
  // `addressed` returns EVERY hit in text order for a free-text scan; here the "text" is always
  // exactly one already-extracted token (no surrounding sentence, no possible second hit), so the
  // first (only) result is the answer — a single-token lookup riding the SAME implementation as
  // the free-text scanner, not a forced literal substitution of one for the other (operator 2026-08
  // consolidation: verified byte-identical against every existing mesh test before landing).
  const findAgentByToken = (token) => {
    const hit = addressed(String(token ?? ''), agents(), { addressWithoutAt: true })[0];
    return hit ? { name: hit.name, agent: hit.agent } : null;
  };
  // ALLOWED_USERS GATE (operator 2026-08-15), RESPONDER side: is `being` reachable by the
  // arriving envelope's REAL requester (route.ev.senderId — the original InboundEvent that
  // reached this node, NOT meshEv's synthetic senderId:null)? Replaces the evicted TYPE-FILE
  // `dangerous:true` reachability gate (old dangerousDenial, meta-engineer.yaml — see git
  // history) with the SAME two-tier allowed_users rule router.mjs's resolve() enforces at the
  // ORIGIN before a mesh envelope is ever sent: a per-conversation override (conversations.yaml
  // agents.<being>.allowed_users, read via getBeing off ONE state read) REPLACES — never merges
  // with — the node's global default (config.yaml's NESTED
  // agents.<handle>.conversation_defaults.allowed_users). UNSET at both tiers = no restriction
  // (today's default, unchanged). Returns the denial string to surface, or null when the turn
  // may proceed. Checked in relayDispatch BEFORE brain.turn ever runs for a local being — never
  // for a relay hop (those don't reach here) and never for a command (commandReply has its own,
  // separate authorization gate).
  //
  // EXPLICIT DENIAL, deliberately unlike router.mjs's silent drop: this file's own convention is
  // "NEVER silence" (see forwardCommand's docstring above) — the requester here is a DIFFERENT,
  // already-trusted node peer (it got this far through the mesh), so it gets a reason, the same
  // way commandReply answers "⚠️ not authorized to run …" instead of going quiet. The sender-id
  // match itself (including the "*" wildcard) is the shared allowedUsersPermits predicate
  // (conversations-state.mjs, operator 2026-08-16) — the same one router.mjs's resolve() uses.
  const allowedUsersDenial = async (being, route, surface, chatId) => {
    const state = loadState ? await loadState().catch(() => null) : null;
    const conv = state ? (() => { try { return getBeing(state, surface, chatId, being); } catch { return null; } })() : null;
    const convAllowed = Array.isArray(conv?.allowedUsers) ? conv.allowedUsers : null;
    const globalAllowed = Array.isArray(agents()[being]?.conversation_defaults?.allowed_users) ? agents()[being].conversation_defaults.allowed_users : null;
    const allowedUsers = convAllowed ?? globalAllowed;
    if (!allowedUsersPermits(allowedUsers, route?.ev?.senderId)) return `not authorized to reach ${being}.${node}`;
    return null;
  };
  const chatOf = (route) => {
    const c = route?.room_id ?? route?.chat ?? route;
    return c == null ? null : String(c);
  };
  // SELF-FALLBACK (operator 2026-07-25): a relay channel the bridge cannot resolve is a DEAD
  // transport — bridge.send drops the envelope ("send DROPPED … resolved=null") and the operator
  // sees nothing at all, just the eventual origin-wait "did not answer". Both spines ride ONE
  // Beeper account, so any chat both see is a valid two-node link and the Self chat qualifies:
  // relay through Self and post a notice naming the channel, ONCE per channel (a permanently
  // missing channel must not re-notice on every @mention). Unresolved ≠ absent — the bridge may
  // simply not see the chat yet — so the notice never asserts the group doesn't exist. No Self
  // configured → null, and the caller keeps today's behaviour (route unchanged).
  const noticedChannels = new Set();
  const selfRoute = async (route, chat) => {
    const self = String(getSelfChatId() ?? '').trim();
    if (!self) return null;
    if (!noticedChannels.has(chat)) {
      noticedChannels.add(chat);
      onLog(`relay channel ${JSON.stringify(chat)} did not resolve — relaying through Self`);
      try { await bridge.send(self, `⚠️ relay channel "${chat}" is unreachable (did not resolve) — create group ${chat} for relay. Relaying through this chat meanwhile.`); } catch {}
    }
    return { ...route, room_id: self };
  };
  // Can the bridge reach this chat? A bridge with no resolver (test fakes) is treated as
  // reachable so raw-id configs stay untouched; a throwing resolver likewise (fail safe).
  const chatResolves = async (chat, network) => {
    if (!bridge.resolveChatId) return true;
    try { return !!(await bridge.resolveChatId(chat, network ? { network } : undefined)); }
    catch { return true; }
  };
  // Resolve a route's room to the CANONICAL short chat id the bridge delivers under.
  // A relay_channel is configured by NAME (e.g. "rodz2"), but the bridge sends and delivers
  // under the RESOLVED id. Resolving the relay-record's room HERE makes the relay hop forward
  // into the SAME id the chat is observed as, so the terminal node listening there receives it
  // (and an origin present in that room catches the reply). bridge.resolveChatId caches (no
  // repeat lookup); a bridge without it (test fakes) → route unchanged (raw-id configs unaffected).
  // NETWORK PIN (operator 2026-07-06: multi-network mesh) — a route may carry a
  // `network:` (whatsapp|telegram|signal|matrix) beside room_id; the same chat name
  // can exist on several networks under one Beeper account, so pass the pin through
  // to resolveChatId so the NAME resolves to the pinned network's chat. The field
  // survives on the returned route (via the spread) — harmless once canonical.
  const canonRoute = async (route) => {
    if (!route) return route;
    const c = chatOf(route);
    if (c == null) return route;
    const network = route.network ? String(route.network).toLowerCase() : null;
    try {
      if (!bridge.resolveChatId) return route;
      const id = await bridge.resolveChatId(c, network ? { network } : undefined);
      if (id) return { ...route, room_id: id };
      return (await selfRoute(route, c)) ?? route;              // unresolved → Self transport (+ one-time notice)
    }
    catch { return route; }
  };

  // ORIGIN-wait timeout: after forward(), if no reply streams back in timeout_ms,
  // surface "<target> did not answer" home. Cleared the moment the reply opens its
  // origin mirror (openOriginStream) or otherwise surfaces (surface). Keyed by the
  // origin chatId — one in-flight relay per origin chat (matches "one relay per node").
  const pending = new Map();   // waitKey -> timer handle
  // KEYED BY THE PER-RELAY waitKey, not chatId alone (operator 2026-07-28): two concurrent relays
  // from the SAME chat used to collide on ONE chatId-keyed timer — the second armTimeout cleared
  // the first's timer before rearming, so a stranded relay never even surfaced "did not answer".
  // waitKey (relay.mjs's synthPostId/postId, stashed onto `origin.waitKey`) is unique per relay;
  // falls back to chatId when absent (relayOut never resolved / no waitKey — byte-identical to
  // the old single-timer behaviour for that case).
  function armTimeout(waitKey, chatId, targetLabel, surface = null, being = null) {
    const key = String(waitKey ?? chatId);
    clearTimeoutFor(key);
    const t = setTimer(() => {
      pending.delete(key);
      inFlight.delete(inFlightKey(surface, chatId, being));   // gave up waiting — nothing is in flight to weave into
      Promise.resolve(bridge.send(String(chatId), `⏱️ ${targetLabel} did not answer`)).catch(() => {});
    }, timeoutMs());
    pending.set(key, t);
  }
  function clearTimeoutFor(key) {
    const t = pending.get(String(key));
    if (t !== undefined) { clearTimer(t); pending.delete(String(key)); }
  }

  // RELAY IN FLIGHT — the ORIGIN's own answer to "is a turn running over there, and whose line
  // started it?" (operator 2026-08-31: "the mesh is only transport"). The previous design needed a
  // new wire frame so the responder could tell the origin it had woven a second line in; the
  // operator ruled against that, and he is right that nothing needs to travel: this node SENT
  // envelope #1 and has not seen its reply finish, which is exactly the fact allow_new_input needs,
  // known locally, without asking.
  //
  // NOT the `pending` timer map above and NOT relay.mjs's `awaiting`: both are cleared the moment
  // the reply STARTS coming home, and the window that matters is the whole time the remote turn is
  // streaming. So this one is opened by forward() and closed only at the terminal frames — the
  // mirror's `finish` (done:true), a one-shot `surface` home, or the origin-wait timeout firing.
  //
  // A record that outlives its turn (a responder that crashes mid-stream) degrades, it does not
  // break: the next line is forwarded quietly and its answer posts FRESH in the chat instead of
  // editing a placeholder. STRUCTURAL (command) relays are deliberately absent — a `/command` is
  // plumbing, not a turn, and must never make a later being-prompt look steerable.
  // KEYED BY BEING TOO, exactly as the local turn key is (turns.keyOf): `@don hola` followed by
  // `@wren hola` in one chat are two independent relays, and the second must get its own
  // placeholder rather than being folded into a turn `don` is running. The being travels back on
  // the origin object itself (`relayBeing`), the same way relayOut already stashes `waitKey` on it
  // — it is a local object, never encoded, so nothing new reaches the wire.
  const inFlight = new Map();   // `${surface}:${chatId}:${being}` -> { senderId } of the line that started it
  const inFlightKey = (surface, chatId, being) => `${String(surface ?? '')}:${String(chatId ?? '')}:${String(being ?? '')}`;
  const noteInFlight = (ev, being) => { inFlight.set(inFlightKey(ev?.surface, ev?.chatId, being), { senderId: ev?.senderId ?? null }); };
  const clearInFlight = (returnTo) => {
    const chat = returnTo?.chat_id ?? returnTo?.chatId ?? (typeof returnTo === 'string' ? returnTo : null);
    if (chat != null) inFlight.delete(inFlightKey(returnTo?.surface, chat, returnTo?.relayBeing));
  };

  // NODE → ROUTE (operator 2026-07-25: "we do agent-base routing"). Every relay path in the
  // AGENTS block that names <node> in its `to:` is a way to reach it; agentRoutes flattens them.
  // A SURFACE-PINNED agent wins on its own surface and is invisible on every other one — exactly
  // how the router treats a pin, and exactly what the pin means (kg pins `don` to `surface: shell`
  // because on Beeper `do` hears him directly, so the shell is where kg must relay). All of ONE
  // agent's paths to the node fan out together (multipath); no agent names it → null, and the
  // caller says so out loud rather than dropping the command in silence.
  function routeToNode(node, surface) {
    const n = String(node ?? '').toLowerCase();
    const s = String(surface ?? '').toLowerCase();
    const hits = agentRoutes(cfg()).filter((r) => r.node === n && (r.surface == null || r.surface === s));
    if (!hits.length) return null;
    const pinned = hits.filter((r) => r.surface != null);
    const use = pinned.length ? pinned : hits;
    const paths = use.filter((r) => r.name === use[0].name);
    const routeOf = (r) => ({ room_id: r.relay_channel, ...(r.network ? { network: r.network } : {}) });
    if (paths.length > 1) return { being: paths[0].name, paths: paths.map((r) => ({ route: routeOf(r), to: r.to, label: r.label })) };
    return { being: paths[0].name, route: routeOf(paths[0]), to: paths[0].to };
  }

  // THE ORIGIN CHAT'S NAME → THIS NODE'S OWN ADDRESS FOR IT (operator 2026-08-31: "the mesh tail
  // should get from/to agents separate, and so the threads. there should be relation between
  // thread-id and the egpt-mesh. mesh is transport, not mixing." / "E on the radio and E on acim
  // MUST BE DIFFERENT THREADS!"). Returns { chatId, name }, or null = "not addressable here".
  //
  // THE NAME IS THE ONLY THING THAT CROSSES. Beeper chat ids do NOT: the same WhatsApp group is
  // `!6ljZJkx0OaY9ZVhEzFgi` on anrodz42 and `!HuXFQeZSY1X4khNDWTzz` on dolly.egpt, and Radio WnL
  // is `!9M8Dhdj…` vs `!3yqv8ll…` (both measured on these two machines, 2026-08-31). So the
  // requester's chat id is meaningless on this node — config/rooms.yaml here lists its members by
  // THIS node's ids — while a WhatsApp group's TITLE is the same for both accounts. The tail has
  // carried that title as `from:` since the first envelope (relayOut sends origin.name =
  // ev.chatName ?? ev.chatId), so nothing new travels; we just resolve it locally, through the
  // SAME bridge resolver canonRoute already uses for a relay_channel name (live since c84deac).
  //
  // NEVER AN ID, AND NEVER A GUESS. An id-shaped `from:` is the requester's own chat id (the
  // ev.chatName ?? ev.chatId fallback fired at the origin), and resolveChatId's `!` branch hands a
  // full-form Matrix id straight back WITHOUT a lookup — which would key this node's thread, warm
  // process and access_level on another account's id. Refused out loud. Everything else that does
  // not resolve (we are not in that chat, the lookup fails) returns null and the caller keeps the
  // relay channel: being answered in the transport chat is what happened before today, so the
  // fallback is not a degradation, it is the status quo.
  //
  // NOT NETWORK-PINNED, unlike canonRoute: a relay_channel declares its `network:`, an arriving
  // envelope says nothing about the origin's, and the route's pin describes the TRANSPORT. An
  // ambiguous title therefore resolves the way every other name does here (bridge logs it, first
  // match wins) rather than by a pin invented on this side.
  const originConv = async (name) => {
    const n = String(name ?? '').trim();
    if (!n || !bridge.resolveChatId) return null;              // no name / no resolver (test fakes, raw-id configs) — unchanged
    if (n.startsWith('!')) { onLog(`mesh: origin ${JSON.stringify(n)} is a chat id, not a name — ids do not cross accounts, so answering in the relay channel`); return null; }
    let id = null;
    try { id = await bridge.resolveChatId(n); } catch { id = null; }
    if (!id) { onLog(`mesh: origin chat ${JSON.stringify(n)} does not resolve on ${node} — answering in the relay channel`); return null; }
    return { chatId: String(id), name: n };
  };

  // A synthetic InboundEvent for the RESPONDER's brain.turn — THE ONE PLACE the conversation a
  // relayed turn runs in is decided.
  //
  // It used to be the relay chat the envelope was addressed in, which made the transport decide
  // identity: every group reached through egpt-mesh-do-kg answered on ONE thread, one warm CLI and
  // one access_level, with the true origin present only as text inside the prompt. It also defeated
  // a569ada — a chat that is a `wa-group` member of a room resolves to the ROOM's identity, but a
  // group reached through the relay never presented its own address, so the membership rule could
  // not fire and relay-E had none of room/acim's memory or permissions. Now the turn runs in the
  // ORIGIN conversation (`from` = its name, resolved by originConv above) and everything downstream
  // — resolveConv, the a569ada scope lookup, the warm key, access_level — follows unchanged.
  //
  // `from` omitted (commandReply) or unresolvable → the relay channel, byte for byte as before.
  async function meshEv(route, prompt, from = null) {
    const surface = route?.limb ?? route?.surface ?? 'whatsapp';
    const conv = await originConv(from);
    const chat = conv?.chatId ?? chatOf(route);
    return { surface, node, chatId: chat, chatName: conv?.name ?? chat, senderId: null, senderName: null, msgId: null, ts: Date.now(), body: prompt, line: prompt, kind: 'text', raw: null };
  }

  // RESPONDER: is this arriving prompt a node-addressed command for THIS node, and if so what
  // does it answer? (operator 2026-07-26 — egpt as a remote control for the network.) The
  // ALLOWLIST is the command service's own (nodeCommandForMe): lifecycle and the STOP safe word
  // are not in it, so an envelope can never restart, upgrade, rewind or kill this node — a
  // non-addressable command is ordinary relayed text and goes to the being, exactly as today.
  //
  // AUTHORIZATION IS THE ONE THAT ALREADY EXISTS. The arriving envelope EVENT rides on the route
  // (mesh.handle), carrying the `authorized`/`isSender` the bridge computed for it — the peer
  // shares this Beeper account (isSender), or the sender's id sits in this node's allowed_users.
  // commands.isCommand reads exactly those, the same gate a typed command passes. Nothing is
  // added here.
  //
  // The reply is CAPTURED (runCaptured) rather than posted: it has to ride home inside the
  // envelope. It still passes the command service's no-self-parsing chokepoint, so the body the
  // origin mirrors into its own chat can never begin with '/' (the 2026-07-25 flood fix).
  let cmdSeq = 0;
  let askerSeq = 0;   // per-turn unique id for an UNNAMEABLE relayed asker (see relayDispatch's `who`)
  async function commandReply(route, prompt) {
    if (!commands?.nodeCommandForMe?.(prompt)) return null;
    const src = route?.ev ?? {};
    const ev = {
      // NO ORIGIN CONVERSATION, deliberately (operator 2026-08-31): a node-addressed command is
      // node plumbing, not a conversation — it is answered by THIS node about ITSELF, and the
      // chatId below is a private per-command id anyway. meshEv without a `from` is the
      // pre-2026-08-31 event exactly, so this path costs no lookup and cannot move.
      ...(await meshEv(route, prompt)),
      chatId: `${chatOf(route)}#cmd${++cmdSeq}`,   // a private id: the captured replies key off it
      mesh: true,   // EXPLICIT MARK (bug #23 half A, 2026-07-27): this chatId is a private
                    // per-command id, never a real room — a room-scoped command (/members,
                    // /activate) must resolve to THIS node's own lobby instead, so add and
                    // list agree and no throwaway contact-<ts> room gets minted. Read once,
                    // in commands.mjs's room-resolution seam.
      senderId: src.senderId ?? null, senderName: src.senderName ?? null,
      authorized: !!src.authorized, isSender: !!src.isSender,
    };
    if (!commands.isCommand(ev)) return `⚠️ not authorized to run "${prompt}" on ${node}`;
    const out = String(await commands.runCaptured(ev) ?? '').trim();
    return out || `(no output from "${prompt}" on ${node})`;
  }

  const relay = createMeshRelay({
    node,
    isSelfNode,                          // node_name ∪ node_alias → several identities on one process
    log: onLog,
    // A local being: any LOCAL agent (configuration ≠ 'relay') matched by its KEY *or any of its
    // handles* — including the persona, which lives in the registry like any other agent
    // (operator 2026-07-10: no e/egpt shortcut; a handle like `ed` resolves via findAgentByToken
    // exactly as the router resolves a bare @ed). A being this node does not host at all is
    // not-here (the engine answers "no <being>.<node> here" — never silence). (A relay agent
    // forwards elsewhere via the route-direct path, so it is NOT local.)
    isLocalBeing: (name) => {
      const found = findAgentByToken(name);
      if (!found) return false;
      const a = found.agent;
      // A relay agent (has relay_channel / to / paths, or explicit configuration: relay) forwards
      // rather than answers — it is NOT a local being. A MULTIPATH agent is a relay BY
      // CONSTRUCTION (its `paths:` carry the relay_channels), so `Array.isArray(a.paths)` leads
      // the test: 1da74ae added that clause the moment findAgentByToken stopped skipping the
      // multipath shape, and without it carol answers as a local being on the open-channel path.
      // It reads `a.paths`, NOT `a` — the multipath agent is a map now (2026-07-26).
      const isRelay = Array.isArray(a.paths) || !!a.relay_channel || !!a.to || String(a.configuration ?? '').toLowerCase() === 'relay';
      return !isRelay;
    },
    // Resolve a being addressed by a HANDLE to the KEY that actually RUNS: findAgentByToken
    // maps a handle (`ed`, `donny`) to its agent's canonical key, which IS the run-being now
    // (operator 2026-07-10 — the persona is no longer special-cased to 'e'; it runs its own
    // key like any agent). The reply is still STAMPED with the addressed-as handle (the engine
    // keeps `by: <handle>.<node>`) — only the run-being is resolved.
    resolveLocalBeing: (name) => {
      const found = findAgentByToken(name);
      return found ? found.name : String(name ?? '').toLowerCase();
    },
    // RELAY-RECORD (declarative chain): a relay agent with `to: <being>.<node>` re-addresses
    // an arriving request onward. Returns { being, node, route } — the next hop's being/node
    // and the room to post into (this agent's OWN relay_channel — the only source of a route
    // since mesh.nodes was evicted, operator 2026-07-25). No `to`, or no relay_channel to carry
    // it → not a relay-record (open-channel or a terminal being). This wires the engine's
    // existing relay-record branch to config.
    //
    // `being` is the `<being>` half of the envelope's `to:` — a WAKE TOKEN, the very same value
    // the engine hands isLocalBeing/resolveLocalBeing a few lines later. So it resolves through
    // findAgentByToken like they do (operator 2026-07-26: "the relay agent must route with the
    // handle, not with the key"); the bare `agents()[being]` it used to do meant a relay agent
    // whose handle differed from its key woke but never travelled.
    resolveBeingRelay: async (being) => {
      const a = findAgentByToken(being)?.agent;
      if (!a) return null;
      // Resolve ONE path config → a next-hop record (or null when it carries no `to`). Carries the
      // optional NETWORK PIN (operator 2026-07-06: multi-network mesh) so a relay_channel NAME shared
      // across networks resolves to the pinned one (see canonRoute).
      const recordOf = async (p) => {
        const to = String(p.to ?? '').trim();
        if (!to || !p.relay_channel) return null;
        const parts = to.split('.');
        const b = parts[0].toLowerCase();
        const n = (parts.length >= 2 ? parts[parts.length - 1] : '').toLowerCase();
        const raw = { room_id: String(p.relay_channel), ...(p.network ? { network: String(p.network).toLowerCase() } : {}) };
        return { being: b, node: n, route: await canonRoute(raw) };   // relay_channel NAME → canonical id
      };
      // MULTIPATH (operator 2026-07-06: every message through every path). A relay record carrying
      // a `paths:` list forwards an arriving envelope onward through EVERY path → an ARRAY of
      // next-hop records (the engine fans out into all of them). A scalar agent → a single record
      // (unchanged). agentPaths normalizes both shapes to a [{relay_channel,network,to}].
      if (Array.isArray(a.paths)) {
        const recs = (await Promise.all(agentPaths(a).map(recordOf))).filter(Boolean);
        return recs.length ? recs : null;
      }
      return recordOf(a);
    },
    // Post an envelope into a relay channel. The port passes an ENVELOPE through verbatim —
    // transport is not a surface send, so it is never signed (persona-wrap isMeshEnvelope); the
    // tail must survive untouched or parseMesh stops recognising it at the other end.
    send: async (route, text) => {
      const chat = chatOf(route);
      if (chat == null) throw new Error('mesh: route has no chat');
      await bridge.send(chat, text);
    },
    // ORIGIN one-shot (no stream primitive) OR an error/status home. A being reply arrives
    // RENDERED — the node that ran the being stamped and signed it before encoding — so this
    // node posts the nugget verbatim and never re-stamps it (the origin cannot know a remote
    // being's identity better than its own node did). Any surface home ends the origin wait.
    surface: async (returnTo, text) => {
      const chat = returnTo?.chat_id ?? returnTo?.chatId ?? (typeof returnTo === 'string' ? returnTo : null);
      if (chat != null) clearTimeoutFor(returnTo?.waitKey ?? chat);
      clearInFlight(returnTo);                                    // answered one-shot — nothing is running over there any more
      if (chat != null) await bridge.send(String(chat), text);
    },
    // ORIGIN placeholder: post "🤔 thinking…" and return its confirmed id. That id
    // rides the request as post_id; the responder echoes it in every reply frame so
    // the origin edits the RIGHT message as the mirror streams.
    ackWithPostId: async (origin, text) => {
      const chat = origin?.chat_id ?? origin?.chatId ?? (typeof origin === 'string' ? origin : null);
      if (chat == null) return null;
      try { return await bridge.postStatus(String(chat), text); } catch { return null; }
    },
    // RESPONDER: run the local being (brain.turn) and edit-stream its reply into the
    // relay channel as ONE message wrapped in the mesh tail (by/emoji/re/post_id). The
    // being's body_emoji is stamped INTO the body (the responder owns it; the origin
    // can't look up a remote being's). The FINAL frame carries done:true.
    relayDispatch: async ({ being, prompt, route, from, sender, re, post_id, by, via }) => {
      const chat = chatOf(route);
      if (chat == null) return;
      const surface = route?.limb ?? route?.surface ?? 'whatsapp';   // same derivation as meshEv
      const wrap = (body, done = false, ahead = 0) => {
        const b = String(body ?? '').trim();
        // Live frames carry the bare stamp, the FINAL carries the full wrap — the once-at-the-end
        // convention both ports already follow for a local reply (placeholder/updates un-wrapped).
        // `ahead` > 0 (operator 2026-08-31): this turn is QUEUED behind another on its key, so the
        // IDLE frame says how many are ahead of it instead of showing a second identical
        // "thinking". Only the idle frame changes — a real body renders exactly as before, and the
        // origin's mirror already posts whatever body arrives, so no protocol moved.
        const out = (!b || b === PLACEHOLDER || b === '🤔') ? (ahead > 0 ? QUEUED(ahead) : PLACEHOLDER)
          : done ? renderReply(being, b) : personaStamp(bodyEmojiOf(being), being, b);
        // echo `via` (the forward trail) home so the origin can show the traceroute path.
        return encodeMesh({ by, body: out, re, post_id, via, done });
      };
      let final = '';
      let stream = null;
      try {
        const cmd = await commandReply(route, prompt);
        if (cmd != null) final = cmd;
        else {
          // ALLOWED_USERS GATE: checked here, AFTER the command branch (a node-addressed command
          // is unrelated to which being was nominally addressed) but BEFORE the placeholder stream
          // opens and BEFORE brain.turn ever runs — an unauthorized envelope never starts a turn.
          //
          // KEYED ON THE CHANNEL, and it stays there (operator 2026-08-31, when the TURN moved to
          // the origin conversation). This is REACHABILITY — may this peer wake this being through
          // this transport — not identity: it is the responder-side half of the rule router.mjs
          // enforces at the origin, its per-conversation override is written against the relay chat
          // (locked in tests/spine-mesh.test.mjs), and re-keying it would silently re-scope who may
          // reach a being over the mesh. Only the conversation the turn RUNS in moved.
          const denial = await allowedUsersDenial(being, route, surface, chat);
          if (denial) final = denial;
          else {
            // Only the being path ever streams (onPartial below) — open the placeholder HERE, once
            // the branch is known, so a static command never pays for a "🤔" it never uses plus an
            // extra outbound edit against the lasso budget (operator 2026-07-27: "no AI involved,
            // it's static tubing").
            // THE ONE PLACE the origin conversation enters: `from` (the origin chat's name, off the
            // tail) reaches meshEv only on the being path, so a static command still pays for no
            // name lookup. `chat` above — the transport — is untouched: the reply streams home
            // exactly where it came from, whatever conversation the turn ran in.
            const ev = await meshEv(route, prompt, from);
            // THE TURN KEY — turns.keyOf, the SAME derivation (and the same brain.scopeOf lookup)
            // the spine's own dispatch uses. Since the turn runs in the ORIGIN conversation this
            // lands on the SAME key a LOCAL message in that chat lands on, which is the collision
            // that has to exist for one warm entry to see one turn at a time. Unwired → null, and
            // every `turns?.` below is inert: byte-for-byte the pre-2026-08-31 body.
            const turnKey = (await turns?.keyOf(being, ev)) ?? null;
            // WHO ASKED, as far as the wire knows (operator 2026-08-31). `by:` carries the origin
            // human's display NAME and has since the first envelope, so nothing new crosses. The
            // synthetic event's own senderId stays null BY DESIGN (the allowed_users gate reads the
            // REAL requester off route.ev and must keep doing so), hence the copy rather than a
            // mutation. Namespaced `mesh:` so it can never equal a surface id — which is what makes
            // allow_new_input's same_sender tier read a LOCAL message against a live RELAYED turn,
            // and the reverse, as "a different person": the safe direction, since we cannot prove
            // they are the same. An UNNAMEABLE asker gets a per-turn UNIQUE id rather than a shared
            // sentinel, because two anonymous envelopes must not read as one person — same_sender
            // then falls to queueing, which is what every gap here falls to.
            const asker = String(sender ?? '').trim();
            const who = asker && asker !== ANON_SENDER ? `mesh:${asker}` : `mesh:#${++askerSeq}`;
            const asked = { ...ev, senderId: who };
            // STEER FIRST, AND THE ORDER IS THE POINT (the same order spine.mjs takes it in): the
            // verdict is taken BEFORE anything opens a placeholder, because a woven message must
            // produce NOTHING NEW — here that means no stream, no envelope, no train. The ORIGIN
            // took the same verdict before forwarding and opened no placeholder for this line, so
            // nothing is left waiting on us. ack:false — the ack sits on the inbound message and the
            // real message lives on the ORIGIN node's account (meshEv has msgId: null), so there is
            // nothing here to react to, and the operator ruled that nothing new crosses.
            if (turnKey && await turns.steerLiveTurn({ to: being, ev: asked, turnKey, ack: false })) return;
            // Open the placeholder AT ARRIVAL — in the QUEUED state when a turn is already running
            // on this key — and let the turn WAIT its turn on the FIFO, exactly as a local mention
            // does. This is the fix: the two envelopes used to run brain.turn concurrently and both
            // showed a bare placeholder.
            const ahead = turns?.bump(turnKey) ?? 0;
            stream = bridge.startStream(chat, wrap('', false, ahead), {});
            const runTurn = async () => {
              // THIS turn is now the live one on this key, and this is whose message it answers.
              // Set here, not above: openAndRunReply's lesson — a QUEUED turn must not claim the
              // live slot from the turn actually streaming. Cleared in the `finally`, which is what
              // makes it correct on the throw path too.
              turns?.setLive(turnKey, { senderId: who });
              if (ahead > 0) { try { stream?.update?.(wrap('')); } catch {} }   // queued → live, the local activate()
              try {
                const r = await brain.turn(being, ev, (partial) => { try { stream?.update?.(wrap(textOf(partial))); } catch {} });
                return textOf(r);
              } finally { turns?.drop(turnKey); turns?.clearLive(turnKey); }
            };
            final = turnKey ? await turns.serial(turnKey, runTurn) : await runTurn();
          }
        }
      } catch (e) { final = `(${being}.${node} error: ${e?.message ?? e})`; }
      final = String(final ?? '').trim() || '…';
      if (stream) await stream.finish(wrap(final, true));
      else await bridge.send(chat, wrap(final, true));
    },
    // ORIGIN mirror: edit the origin placeholder (post_id) in place as the reply
    // streams home. The body already carries the being's body_emoji (stamped by the
    // responder), so mirror verbatim. showThink → "✅ Done" on the done frame — but a
    // structural (command) reply is plumbing, not an AI turn, so it finishes to just the
    // reply body (operator 2026-07-27: "an AI thinking, when it's actually water through
    // pipes"). info.structural rides from the ORIGINAL relayOut call via relay.mjs's
    // `awaiting` map — never re-derived here.
    openOriginStream: (returnTo, info = {}) => {
      const chat = returnTo?.chat_id ?? returnTo?.chatId ?? (typeof returnTo === 'string' ? returnTo : null);
      if (chat == null) return null;
      clearTimeoutFor(returnTo?.waitKey ?? chat);                 // the reply is streaming — the wait is over
      const render = (body) => { const b = String(body ?? '').trim(); return b || PLACEHOLDER; };
      const stream = bridge.startStream(String(chat), '', { existingMsgId: info.msgId || null, showThink: !info.structural });
      if (!stream) return null;
      return {
        update: (body) => stream.update(render(body)),
        // done:true — and ONLY here. The origin-wait timer is cleared when the reply STARTS
        // (above), but "is a turn running over there" stays true for the whole stream, which is
        // exactly the window a second line from this conversation has to be judged against.
        finish: async (body) => { clearInFlight(returnTo); await stream.finish(render(body)); },
      };
    },
  });

  const api = {
    // A message carrying a provenance tail is relay traffic (request or reply), not chat.
    isEnvelope(ev) { return parseMesh(ev?.body ?? '') != null; },

    // IS A RELAY FROM THIS CONVERSATION STILL UNANSWERED, and whose line started it?
    // { senderId } or null — the same shape turns.mjs's live-turn register holds, because it is
    // fed to exactly the same allow_new_input verdict (turns.steerRelayedTurn). This is the whole
    // of what the origin needs to decide the placeholder locally: the operator ruled that the
    // mesh is only transport, so the responder is never asked and nothing new crosses the wire.
    relayInFlight(ev, being) { return inFlight.get(inFlightKey(ev?.surface, ev?.chatId, being)) ?? null; },

    // Process an inbound envelope. BOTH directions live in the engine's onRoomMessage.
    // The route is the chat it arrived on (so the reply/forward posts back there); msgId
    // correlates a streamed reply's frames.
    async handle(ev) {
      const prov = parseMesh(ev?.body ?? '');
      if (!prov) return false;
      // The arriving EVENT rides along on the route — transparent to the engine (which reads
      // room_id and nothing else). The responder's command branch reads its authorization off
      // it: the existing allowed_users / same-account signal, never a fabricated one.
      const route = { limb: ev.surface, room_id: ev.chatId, ev };
      return relay.onRoomMessage({ route, text: ev.body, msgId: ev.msgId });
    },

    // ORIGIN: relay a human's "@<relay-agent> …" onward. Arms the origin-wait timeout;
    // relayOut posts the "🤔" placeholder + the request envelope.
    //
    // Two target shapes are accepted, both AGENT-BASED (operator 2026-07-25 — the
    // `{ being, node }` mesh.nodes shape was evicted along with the node routing table):
    //   { being, route:{room_id}, to? } — a scalar relay agent: its relay_channel IS the
    //                                route, so relayOut posts the envelope straight into
    //                                that chat. With `to: <being>.<node>` the next hop is
    //                                named; without it, open-channel (the owner of `being`
    //                                on the other end answers). The reply mirrors home
    //                                through the awaiting/re: machinery either way.
    //   { being, paths:[…] }       — a MULTIPATH relay agent (its `paths:` list); see below.
    //
    // `structural` (operator 2026-07-27): true only when this forward carries a `/command`
    // (forwardCommand sets it — it already knows, at the allowlist gate, that no AI turn is
    // involved). Threaded straight through to relay.relayOut, never re-derived here. Default
    // false leaves every existing `@being` being-prompt call site byte-identical.
    // `quiet` (operator 2026-08-31): the spine already took the allow_new_input verdict for this
    // line — a relay from this conversation is still unanswered and the policy admits it — so it
    // travels with NO placeholder and NO origin-wait timer. The bet is that the responder weaves
    // it into the turn already streaming; when the bet loses, the reply comes home carrying a
    // synthetic post_id and posts FRESH instead of resolving a placeholder nobody opened. See
    // relayOut's own note in src/mesh/relay.mjs for why the correlation id is still minted.
    async forward(ev, target, { structural = false, quiet = false } = {}) {
      const being = target?.being;
      // MULTIPATH (operator 2026-07-06: multipath is configuration — an agent declares a list of
      // paths, every message through every path). The router hands a `paths` array; resolve EACH path's
      // relay_channel NAME → canonical id with its OWN network pin (canonRoute) and fan out via
      // relay.relayOut({paths}) — ONE 🤔 placeholder + one envelope per path, first reply home wins.
      if (Array.isArray(target?.paths)) {
        if (!being || !target.paths.length) { onLog(`forward: bad multipath target ${JSON.stringify(target)}`); return false; }
        const paths = [];
        for (const p of target.paths) paths.push({ route: await canonRoute(p.route), to: p.to, label: p.label });
        const origin = { surface: ev.surface, chat_id: ev.chatId, name: ev.chatName ?? ev.chatId, relayBeing: being };
        const sender = ev.senderName ?? ANON_SENDER;
        const ok = await relay.relayOut({ being, paths, body: ev.body, origin, sender, structural, quiet });
        if (ok && !quiet) armTimeout(origin.waitKey, ev.chatId, `${being} (${paths.length} paths)`, ev.surface, being);
        if (ok && !quiet && !structural) noteInFlight(ev, being);
        return ok;
      }
      let route = target?.route;                                // the relay agent's channel
      const to = String(target?.to ?? '').trim();               // declarative next-hop (chain)
      if (!being || !route) { onLog(`forward: bad target ${JSON.stringify(target)}`); return false; }
      // The hop posts into the relay_channel exactly AS CONFIGURED (the bridge resolves the name
      // at send time), so an unresolvable channel is dropped there in silence. Check it here and
      // fall the transport back to Self; a channel that DOES resolve rides on unchanged.
      const chat = chatOf(route);
      if (chat != null && !(await chatResolves(chat, route.network ? String(route.network).toLowerCase() : null))) {
        route = (await selfRoute(route, chat)) ?? route;
      }
      const origin = { surface: ev.surface, chat_id: ev.chatId, name: ev.chatName ?? ev.chatId, relayBeing: being };
      const sender = ev.senderName ?? ANON_SENDER;
      const label = to || `${being} (${chatOf(route)})`;
      const ok = await relay.relayOut({ being, route, to, body: ev.body, origin, sender, structural, quiet });
      if (ok && !quiet) armTimeout(origin.waitKey, ev.chatId, label, ev.surface, being);   // relayOut already surfaced a failure
      if (ok && !quiet && !structural) noteInFlight(ev, being);
      return ok;
    },

    // ORIGIN: a node-addressed COMMAND for a node that cannot hear where it was typed (operator
    // 2026-07-26 — "i open a local shell, type '/chrome mo' and a chrome in mo's spine … opens.
    // i can drive it by typing commands on the egpt shell"). It travels as the SAME envelope a
    // `@don` being-prompt travels in, so the reply mirrors home the same way. NEVER silence: a
    // node no agent routes to is reported to the operator, in the chat he typed it in.
    //
    // structural: true — forwardCommand is ONLY ever reached for an allowlisted `/command`
    // (spine.mjs gates on commands.remoteNode before calling it), so the origin's placeholder
    // and done-marker are the plumbing ("🔗 relaying…" / no "✅ Done"), never the AI-thinking ones.
    async forwardCommand(ev, node) {
      const target = routeToNode(node, ev.surface);
      if (!target) {
        onLog(`no agent routes to node "${node}" on surface ${ev.surface}`);
        await bridge.send(ev.chatId, `⚠️ no agent routes to node "${node}" — add an agent with a relay_channel and "to: <being>.${node}" to reach it.`);
        return false;
      }
      // Resolution happens ONCE, here at the origin, and must travel EXPLICITLY (operator
      // 2026-07-27 — live miss: a bare command resolved via dispatch.default_node forwarded with
      // its ORIGINAL body, so the responder's own nodeCommandForMe re-parsed it bare, resolved no
      // node of its own, and fell through to the being). commands.makeNodeExplicit binds `=<node>`
      // to the command token; an already-explicit command (`/tabs=do`) comes back unchanged.
      const body = commands?.makeNodeExplicit?.(ev.body, node) ?? ev.body;
      return api.forward(body === ev.body ? ev : { ...ev, body }, target, { structural: true });
    },

    // A streamed edit in a relay chat mirrors onward (responder edits → origin mirror,
    // transit re-mirror). Returns truthy-if-consumed straight to the bridge (its
    // onMessageEdit contract); an untracked edit → false → the bridge handles it.
    async onEdit({ msgId, newText } = {}) {
      return relay.onRoomMessageEdit({ msgId, text: newText });
    },
  };
  return api;
}
