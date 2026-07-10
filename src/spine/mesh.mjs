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
//   resolveRoute / isLocalBeing / …  ->  config (node_name, agents, mesh.nodes)
//
// The spine wires the three entry points into handleInbound (spine.mjs):
//   isEnvelope(ev)  — a message carrying a provenance tail is relay traffic, not chat.
//   handle(ev)      — process an envelope (BOTH directions: a request at the responder,
//                     a reply/mirror-update at the origin).
//   forward(ev,tgt) — a human's "@being.node …" is relayed to the target's node.
//   onEdit(edit)    — a streamed edit in the relay chat mirrors onward (wired to
//                     bridge.onEdit at boot); returns truthy-if-consumed (bridge contract).
//
// Relay-chat resolution (which chat physically carries the envelope) follows the old
// wiring exactly: config.mesh.nodes.<node>.routes[0].room_id (names→chat via config,
// not a new scheme). Inert until mesh.nodes is configured (resolveRoute → null →
// relayOut surfaces "no route").
import { createMeshRelay, encodeMesh, parseMesh, agentPaths } from '../mesh/relay.mjs';

const PLACEHOLDER = '🤔 thinking…';
const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? '');

export function createMeshService({
  bridge,                              // the Bridge port (send, startStream, postStatus, onEdit)
  brain,                               // the Brain port (turn) — runs the local being for the responder
  getConfig = () => ({}),
  bodyEmojiOf = () => '',              // (being) => body_emoji — stamps the relayed reply
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
  const timeoutMs = () => Number(cfg().mesh?.timeout_ms ?? 60_000) || 60_000;

  // An agent's routable tokens: its map KEY plus any `handles:` aliases (lowercased) —
  // MIRRORS the router (src/spine/router.mjs findAgent) so the mesh resolves a being addressed
  // by a HANDLE (e.g. `ed` for the egpt persona) exactly as the router does for a direct @mention.
  const agentIds = (name, agent) => {
    const hs = Array.isArray(agent?.handles) ? agent.handles : [];
    return [name, ...hs].map((h) => String(h ?? '').toLowerCase());
  };
  // Find the enabled, non-comment agent whose key/handle matches `token` → { name, agent }
  // (name = canonical lowercased key) or null.
  const findAgentByToken = (token) => {
    const t = String(token ?? '').toLowerCase();
    for (const [name, agent] of Object.entries(agents())) {
      if (!agent || typeof agent !== 'object' || Array.isArray(agent) || name.startsWith('_')) continue;
      if (agent.enabled === false) continue;
      if (agentIds(name, agent).includes(t)) return { name: name.toLowerCase(), agent };
    }
    return null;
  };
  // The PERSONA agent is the one whose key/handle includes e/egpt (same test the router uses).
  const isPersonaAgent = (name, agent) => agentIds(name, agent).some((h) => h === 'e' || h === 'egpt');

  // Relay-chat resolution (unchanged from the old wiring): a node's listen route is
  // config.mesh.nodes.<node>.routes[0]; its room_id is the chat the envelope rides.
  const resolveRoute = (toNode) => {
    const routes = cfg().mesh?.nodes?.[String(toNode).toLowerCase()]?.routes;
    return Array.isArray(routes) && routes.length ? routes[0] : null;
  };
  const chatOf = (route) => {
    const c = route?.room_id ?? route?.chat ?? route;
    return c == null ? null : String(c);
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
    try { const id = await bridge.resolveChatId?.(c, network ? { network } : undefined); return id ? { ...route, room_id: id } : route; }
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

  // A synthetic InboundEvent for the RESPONDER's brain.turn: the being answers in the
  // context of the relay chat it was addressed in (surface + chatId = that channel).
  function meshEv(route, prompt) {
    const chat = chatOf(route);
    const surface = route?.limb ?? route?.surface ?? 'whatsapp';
    return { surface, node, chatId: chat, chatName: chat, senderId: null, senderName: null, msgId: null, ts: Date.now(), body: prompt, line: prompt, kind: 'text', raw: null };
  }

  const relay = createMeshRelay({
    node,
    isSelfNode,                          // node_name ∪ node_alias → several identities on one process
    log: onLog,
    resolveRoute,
    // A local being: the persona (e/egpt), or a LOCAL agent (enabled, configuration ≠ 'relay')
    // matched by its KEY *or any of its handles* (so `ed`, a handle of the egpt persona, is
    // recognized here just as the router recognizes a bare @ed). A hosted-but-disabled agent is
    // treated as not-here (the engine answers "no <being>.<node> here" — never silence),
    // respecting availability. (A relay agent forwards elsewhere via the route-direct path, so
    // it is NOT local.)
    isLocalBeing: (name) => {
      const n = String(name).toLowerCase();
      if (n === 'e' || n === 'egpt') return true;
      const found = findAgentByToken(n);
      if (!found) return false;
      const a = found.agent;
      // A relay agent (has relay_channel / to, or explicit configuration: relay) forwards
      // rather than answers — it is NOT a local being.
      const isRelay = !!a.relay_channel || !!a.to || String(a.configuration ?? '').toLowerCase() === 'relay';
      return !isRelay;
    },
    // Resolve a local being addressed by a HANDLE to the canonical being that actually RUNS:
    // a persona handle (`ed`, `egptd`) runs the persona being `e` (stable warm keys/threads,
    // the same mapping the router applies to persona handles → defaultBeing); any other local
    // agent's handle runs that agent's own key. The reply is still STAMPED with the addressed-as
    // handle (the engine keeps `by: <handle>.<node>`) — only the run-being is resolved.
    resolveLocalBeing: (name) => {
      const n = String(name).toLowerCase();
      if (n === 'e' || n === 'egpt') return 'e';
      const found = findAgentByToken(n);
      if (!found) return n;
      if (isPersonaAgent(found.name, found.agent)) return 'e';
      return found.name;
    },
    // RELAY-RECORD (declarative chain): a relay agent with `to: <being>.<node>` re-addresses
    // an arriving request onward. Returns { being, node, route } — the next hop's being/node
    // and the room to post into (this agent's own relay_channel; falls back to the mesh.nodes
    // route for `node` when relay_channel is absent). No `to` → not a relay-record (open-channel
    // or a terminal being). This wires the engine's existing relay-record branch to config.
    resolveBeingRelay: async (being) => {
      const a = agents()[String(being).toLowerCase()];
      if (!a || typeof a !== 'object') return null;
      // Resolve ONE path config → a next-hop record (or null when it carries no `to`). Carries the
      // optional NETWORK PIN (operator 2026-07-06: multi-network mesh) so a relay_channel NAME shared
      // across networks resolves to the pinned one (see canonRoute).
      const recordOf = async (p) => {
        const to = String(p.to ?? '').trim();
        if (!to) return null;
        const parts = to.split('.');
        const b = parts[0].toLowerCase();
        const n = (parts.length >= 2 ? parts[parts.length - 1] : '').toLowerCase();
        const raw = p.relay_channel ? { room_id: String(p.relay_channel), ...(p.network ? { network: String(p.network).toLowerCase() } : {}) } : (n ? resolveRoute(n) : null);
        if (!raw) return null;
        return { being: b, node: n, route: await canonRoute(raw) };   // relay_channel NAME → canonical id
      };
      // MULTIPATH (operator 2026-07-06: an agent is a list of paths, every message through every
      // path). A LIST-shaped relay record forwards an arriving envelope onward through EVERY path →
      // an ARRAY of next-hop records (the engine fans out into all of them). A scalar agent → a
      // single record (unchanged). agentPaths normalizes both shapes to a [{relay_channel,network,to}].
      if (Array.isArray(a)) {
        const recs = (await Promise.all(agentPaths(a).map(recordOf))).filter(Boolean);
        return recs.length ? recs : null;
      }
      return recordOf(a);
    },
    // Post an envelope into a relay channel. No body_emoji → the port passes the text
    // (the full mesh envelope) through verbatim; the tail must survive untouched.
    send: async (route, text) => {
      const chat = chatOf(route);
      if (chat == null) throw new Error('mesh: route has no chat');
      await bridge.send(chat, text);
    },
    // ORIGIN one-shot (no stream primitive) OR an error/status home. A being reply
    // (info.by set) is stamped with the being's body_emoji so it reads as the being's
    // voice, never bare operator text. Any surface home ends the origin wait.
    surface: async (returnTo, text, info = {}) => {
      const chat = returnTo?.chat_id ?? returnTo?.chatId ?? (typeof returnTo === 'string' ? returnTo : null);
      if (chat != null) clearTimeoutFor(chat);
      const being = info.by ? String(info.by).split('.')[0].toLowerCase() : '';
      const emoji = being ? (bodyEmojiOf(being) || '') : (info.by ? '🔗' : '');
      const body = emoji ? `${emoji} ${text}` : text;
      if (chat != null) await bridge.send(String(chat), body);
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
      const emoji = bodyEmojiOf(being) || '';
      const wrap = (body, done = false) => {
        const b = String(body ?? '').trim();
        const out = (!b || b === PLACEHOLDER || b === '🤔') ? PLACEHOLDER : (emoji ? `${emoji} ${b}` : b);
        // echo `via` (the forward trail) home so the origin can show the traceroute path.
        return encodeMesh({ by, body: out, re, post_id, via, done });
      };
      const stream = bridge.startStream(chat, wrap(''), {});
      let final = '';
      try {
        const r = await brain.turn(being, meshEv(route, prompt), (partial) => { try { stream?.update?.(wrap(textOf(partial))); } catch {} });
        final = textOf(r);
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

  return {
    // A message carrying a provenance tail is relay traffic (request or reply), not chat.
    isEnvelope(ev) { return parseMesh(ev?.body ?? '') != null; },

    // Process an inbound envelope. BOTH directions live in the engine's onRoomMessage.
    // The route is the chat it arrived on (so the reply/forward posts back there); msgId
    // correlates a streamed reply's frames.
    async handle(ev) {
      const prov = parseMesh(ev?.body ?? '');
      if (!prov) return false;
      const route = { limb: ev.surface, room_id: ev.chatId };
      return relay.onRoomMessage({ route, text: ev.body, msgId: ev.msgId });
    },

    // ORIGIN: relay a human's "@being.node …" to the target's node. Arms the origin-
    // wait timeout; relayOut posts the "🤔" placeholder + the request envelope.
    //
    // Two target shapes are accepted:
    //   { being, node }            — the mesh.nodes scheme: relayOut resolves the route
    //                                via config.mesh.nodes.<node>.routes[0].
    //   { being, route:{room_id} } — the ROUTE-DIRECT variant (a `type: relay` agent):
    //                                the relay_channel IS the route, so relayOut posts
    //                                the envelope straight into that chat. No node; the
    //                                envelope carries no `to:` → the owner of `being` on
    //                                the other end answers (open-channel), reply mirrors
    //                                home through the same awaiting/re: machinery.
    async forward(ev, target) {
      const being = target?.being;
      // MULTIPATH (operator 2026-07-06: multipath is configuration — an agent is a list of paths,
      // every message through every path). The router hands a `paths` array; resolve EACH path's
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
      const toNode = target?.node;
      const route = target?.route;                              // route-direct (relay agent)
      const to = String(target?.to ?? '').trim();               // declarative next-hop (chain)
      if (!being || (!toNode && !route)) { onLog(`forward: bad target ${JSON.stringify(target)}`); return false; }
      const origin = { surface: ev.surface, chat_id: ev.chatId, name: ev.chatName ?? ev.chatId };
      const sender = ev.senderName ?? 'someone';
      const label = to || (toNode ? `${being}.${toNode}` : `${being} (${chatOf(route)})`);
      armTimeout(ev.chatId, label);
      const ok = await relay.relayOut({ being, toNode, route, to, body: ev.body, origin, sender });
      if (!ok) clearTimeoutFor(ev.chatId);                      // relayOut already surfaced the failure
      return ok;
    },

    // A streamed edit in a relay chat mirrors onward (responder edits → origin mirror,
    // transit re-mirror). Returns truthy-if-consumed straight to the bridge (its
    // onMessageEdit contract); an untracked edit → false → the bridge handles it.
    async onEdit({ msgId, newText } = {}) {
      return relay.onRoomMessageEdit({ msgId, text: newText });
    },
  };
}
