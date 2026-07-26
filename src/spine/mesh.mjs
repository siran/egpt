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
import { createMeshRelay, encodeMesh, parseMesh, agentPaths } from '../mesh/relay.mjs';
// The ONE definition of the persona stamp + concentric wrap every surface port renders through
// ("the bridge must have ONE path", 2026-07-25). The RESPONDER renders its reply through THIS —
// the same renderer a local reply gets — before encodeMesh, because the payload is what travels.
import { personaStamp, makeWrapPersona } from '../bridges/persona-wrap.mjs';
// THE routing table, derived from the AGENTS block (there is no mesh.nodes since 2026-07-25):
// an agent with a relay_channel and `to: <being>.<node>` IS the statement that its channel
// reaches that node. The SAME derivation the command service reads to know what a node name is.
import { agentRoutes } from './node-names.mjs';
// THE wake vocabulary (declared `handles:`, else the map key) — the ONE rule the router applies to
// a typed @token, imported so an envelope's `<being>.<node>` resolves identically. This file used
// to carry its own copy, which is how the two could drift.
import { wakeTokens } from './router.mjs';

const PLACEHOLDER = '🤔 thinking…';
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
  const renderReply = (being, text) => makeWrapPersona({ bridgeSignatureOpen: cfg().bridge_signature_open ?? '', bridgeSignatureClose: cfg().bridge_signature_close ?? '' })({ bodyEmoji: bodyEmojiOf(being), label: being }, text);
  const timeoutMs = () => Number(cfg().mesh?.timeout_ms ?? 60_000) || 60_000;

  // Find the non-comment agent whose WAKE TOKEN matches `token` → { name, agent }
  // (name = canonical lowercased key = the BEING-ID that runs) or null. Runs THE wake vocabulary
  // (router.mjs wakeTokens — declared `handles:`, else the map key), the same rule the router
  // applies to a direct @mention, so an envelope's `<being>.<node>` and a typed @token can never
  // disagree about who is addressed. Since 2026-07-26 the map KEY is NOT a token when handles are
  // declared: an envelope to `egpt.do` no longer wakes DOLLY (keyed `egpt`, handles [d, don]) —
  // answering it would stamp `by: egpt.do`, exactly what the ruling forbids — while `don.do` still
  // resolves to the being-id `egpt` and runs.
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
  const findAgentByToken = (token) => {
    const t = String(token ?? '').toLowerCase();
    for (const [name, agent] of Object.entries(agents())) {
      if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
      if (wakeTokens(name, agent).includes(t)) return { name: name.toLowerCase(), agent };
    }
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
  const pending = new Map();   // originChatId -> timer handle
  function armTimeout(chatId, targetLabel) {
    clearTimeoutFor(chatId);
    const t = setTimer(() => {
      pending.delete(String(chatId));
      Promise.resolve(bridge.send(String(chatId), `⏱️ ${targetLabel} did not answer`)).catch(() => {});
    }, timeoutMs());
    pending.set(String(chatId), t);
  }
  function clearTimeoutFor(chatId) {
    const t = pending.get(String(chatId));
    if (t !== undefined) { clearTimer(t); pending.delete(String(chatId)); }
  }

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

  // A synthetic InboundEvent for the RESPONDER's brain.turn: the being answers in the
  // context of the relay chat it was addressed in (surface + chatId = that channel).
  function meshEv(route, prompt) {
    const chat = chatOf(route);
    const surface = route?.limb ?? route?.surface ?? 'whatsapp';
    return { surface, node, chatId: chat, chatName: chat, senderId: null, senderName: null, msgId: null, ts: Date.now(), body: prompt, line: prompt, kind: 'text', raw: null };
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
  async function commandReply(route, prompt) {
    if (!commands?.nodeCommandForMe?.(prompt)) return null;
    const src = route?.ev ?? {};
    const ev = {
      ...meshEv(route, prompt),
      chatId: `${chatOf(route)}#cmd${++cmdSeq}`,   // a private id: the captured replies key off it
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
      if (chat != null) clearTimeoutFor(chat);
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
    relayDispatch: async ({ being, prompt, route, re, post_id, by, via }) => {
      const chat = chatOf(route);
      if (chat == null) return;
      const wrap = (body, done = false) => {
        const b = String(body ?? '').trim();
        // Live frames carry the bare stamp, the FINAL carries the full wrap — the once-at-the-end
        // convention both ports already follow for a local reply (placeholder/updates un-wrapped).
        const out = (!b || b === PLACEHOLDER || b === '🤔') ? PLACEHOLDER
          : done ? renderReply(being, b) : personaStamp(bodyEmojiOf(being), being, b);
        // echo `via` (the forward trail) home so the origin can show the traceroute path.
        return encodeMesh({ by, body: out, re, post_id, via, done });
      };
      const stream = bridge.startStream(chat, wrap(''), {});
      let final = '';
      try {
        const cmd = await commandReply(route, prompt);
        if (cmd != null) final = cmd;
        else {
          const r = await brain.turn(being, meshEv(route, prompt), (partial) => { try { stream?.update?.(wrap(textOf(partial))); } catch {} });
          final = textOf(r);
        }
      } catch (e) { final = `(${being}.${node} error: ${e?.message ?? e})`; }
      final = String(final ?? '').trim() || '…';
      if (stream) await stream.finish(wrap(final, true));
      else await bridge.send(chat, wrap(final, true));
    },
    // ORIGIN mirror: edit the origin placeholder (post_id) in place as the reply
    // streams home. The body already carries the being's body_emoji (stamped by the
    // responder), so mirror verbatim. showThink → "✅ Done" on the done frame.
    openOriginStream: (returnTo, info = {}) => {
      const chat = returnTo?.chat_id ?? returnTo?.chatId ?? (typeof returnTo === 'string' ? returnTo : null);
      if (chat == null) return null;
      clearTimeoutFor(chat);                                     // the reply is streaming — the wait is over
      const render = (body) => { const b = String(body ?? '').trim(); return b || PLACEHOLDER; };
      const stream = bridge.startStream(String(chat), '', { existingMsgId: info.msgId || null, showThink: true });
      if (!stream) return null;
      return {
        update: (body) => stream.update(render(body)),
        finish: async (body) => { await stream.finish(render(body)); },
      };
    },
  });

  const api = {
    // A message carrying a provenance tail is relay traffic (request or reply), not chat.
    isEnvelope(ev) { return parseMesh(ev?.body ?? '') != null; },

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
    async forward(ev, target) {
      const being = target?.being;
      // MULTIPATH (operator 2026-07-06: multipath is configuration — an agent declares a list of
      // paths, every message through every path). The router hands a `paths` array; resolve EACH path's
      // relay_channel NAME → canonical id with its OWN network pin (canonRoute) and fan out via
      // relay.relayOut({paths}) — ONE 🤔 placeholder + one envelope per path, first reply home wins.
      if (Array.isArray(target?.paths)) {
        if (!being || !target.paths.length) { onLog(`forward: bad multipath target ${JSON.stringify(target)}`); return false; }
        const paths = [];
        for (const p of target.paths) paths.push({ route: await canonRoute(p.route), to: p.to, label: p.label });
        const origin = { surface: ev.surface, chat_id: ev.chatId, name: ev.chatName ?? ev.chatId };
        const sender = ev.senderName ?? 'someone';
        armTimeout(ev.chatId, `${being} (${paths.length} paths)`);
        const ok = await relay.relayOut({ being, paths, body: ev.body, origin, sender });
        if (!ok) clearTimeoutFor(ev.chatId);
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
      const origin = { surface: ev.surface, chat_id: ev.chatId, name: ev.chatName ?? ev.chatId };
      const sender = ev.senderName ?? 'someone';
      const label = to || `${being} (${chatOf(route)})`;
      armTimeout(ev.chatId, label);
      const ok = await relay.relayOut({ being, route, to, body: ev.body, origin, sender });
      if (!ok) clearTimeoutFor(ev.chatId);                      // relayOut already surfaced the failure
      return ok;
    },

    // ORIGIN: a node-addressed COMMAND for a node that cannot hear where it was typed (operator
    // 2026-07-26 — "i open a local shell, type '/chrome mo' and a chrome in mo's spine … opens.
    // i can drive it by typing commands on the egpt shell"). It travels as the SAME envelope a
    // `@don` being-prompt travels in, so the reply mirrors home the same way. NEVER silence: a
    // node no agent routes to is reported to the operator, in the chat he typed it in.
    async forwardCommand(ev, node) {
      const target = routeToNode(node, ev.surface);
      if (!target) {
        onLog(`no agent routes to node "${node}" on surface ${ev.surface}`);
        await bridge.send(ev.chatId, `⚠️ no agent routes to node "${node}" — add an agent with a relay_channel and "to: <being>.${node}" to reach it.`);
        return false;
      }
      return api.forward(ev, target);
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
