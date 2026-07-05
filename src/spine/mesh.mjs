// mesh.mjs — the §2c mesh service: cross-node being relay (SPINE-REWRITE-PLAN.md
// Phase 4b). `@being.node` in a chat reaches a being on ANOTHER machine; the reply
// streams back into the origin chat as a LIVING MIRROR (an edit-streamed placeholder
// that fills in as the remote being answers).
//
// The engine is the battle-tested `src/mesh/relay.mjs` (createMeshRelay) — the wire
// format (base64 body + readable provenance tail), forward-once loop safety, and the
// streaming living-mirror all live there and are test-locked (tests/mesh-relay.test.mjs).
// This service's whole job is to supply the engine's host callbacks FROM v2 services:
//
//   send / surface / ackWithPostId   ->  the Bridge port (send / postStatus)
//   relayDispatch / openOriginStream ->  the Bridge port's startStream (edit-stream)
//   openRelayStream (transit)        ->  the Bridge port's startStream
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
import { createMeshRelay, encodeMesh, parseMesh } from '../mesh/relay.mjs';
import { normalizeMeshTtl } from '../mesh/envelope.mjs';

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
  const ttlCap = () => normalizeMeshTtl(cfg().mesh?.ttl);          // default 3 (max routed hops)
  const timeoutMs = () => Number(cfg().mesh?.timeout_ms ?? 60_000) || 60_000;

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

  // TTL hop-cap: a global belt-and-suspenders bound ATOP the engine's forward-once
  // (relay.mjs forwards each mid once per direction — the primary loop safety, per
  // EGPT-MESH-PROTOCOL "no ttl" in the wire). The wire carries no ttl slot, so we cap
  // at the SERVICE boundary: each REQUEST arrival for a mid is counted; past ttlCap
  // hops it is dropped + logged. Reply frames (re set) are exempt. Bounded Map.
  const hops = new Map();     // mid -> arrival count
  const HOPS_CAP = 500;
  function ttlExceeded(prov) {
    if (prov.re || !prov.mid) return false;           // replies exempt; no mid → engine won't forward
    const n = (hops.get(prov.mid) ?? 0) + 1;
    hops.set(prov.mid, n);
    if (hops.size > HOPS_CAP) hops.delete(hops.keys().next().value);
    if (n > ttlCap()) { onLog(`ttl expired for ${prov.mid} (hop ${n} > ${ttlCap()}) — dropped`); return true; }
    return false;
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
    // A local being: the persona (e/egpt), or a LOCAL agent (agents[<name>], configuration
    // ≠ 'relay') that is enabled. A hosted-but-disabled agent is treated as not-here (the
    // engine answers "no <being>.<node> here" — never silence), respecting availability.
    // (A relay agent forwards elsewhere via the route-direct path, so it is NOT local.)
    isLocalBeing: (name) => {
      const n = String(name).toLowerCase();
      if (n === 'e' || n === 'egpt') return true;
      const a = agents()[n];
      if (!a || typeof a !== 'object' || Array.isArray(a) || a.enabled === false) return false;
      // A relay agent (has relay_channel / to, or explicit configuration: relay) forwards
      // rather than answers — it is NOT a local being.
      const isRelay = !!a.relay_channel || !!a.to || String(a.configuration ?? '').toLowerCase() === 'relay';
      return !isRelay;
    },
    // RELAY-RECORD (declarative chain): a relay agent with `to: <being>.<node>` re-addresses
    // an arriving request onward. Returns { being, node, route } — the next hop's being/node
    // and the room to post into (this agent's own relay_channel; falls back to the mesh.nodes
    // route for `node` when relay_channel is absent). No `to` → not a relay-record (open-channel
    // or a terminal being). This wires the engine's existing relay-record branch to config.
    resolveBeingRelay: (being) => {
      const a = agents()[String(being).toLowerCase()];
      if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
      const to = String(a.to ?? '').trim();
      if (!to) return null;
      const parts = to.split('.');
      const b = parts[0].toLowerCase();
      const n = (parts.length >= 2 ? parts[parts.length - 1] : '').toLowerCase();
      const route = a.relay_channel ? { room_id: String(a.relay_channel) } : (n ? resolveRoute(n) : null);
      if (!route) return null;
      return { being: b, node: n, route };
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
    relayDispatch: async ({ being, prompt, route, re, post_id, by, mid }) => {
      const chat = chatOf(route);
      if (chat == null) return;
      const emoji = bodyEmojiOf(being) || '';
      const wrap = (body, done = false) => {
        const b = String(body ?? '').trim();
        const out = (!b || b === PLACEHOLDER || b === '🤔') ? PLACEHOLDER : (emoji ? `${emoji} ${b}` : b);
        return encodeMesh({ by, body: out, re, post_id, mid, done });
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
    // TRANSIT (multi-hop): re-mirror a forwarded reply toward the next hop — post a
    // copy into `route` and edit it as the upstream streams, wrapping each frame in the
    // mesh tail (re/mid) so the next hop recognises + mirrors it onward.
    openRelayStream: (route, info = {}) => {
      const chat = chatOf(route);
      if (chat == null) return null;
      const wrap = (body, done = false) => encodeMesh({ by: info.by, body: String(body ?? '').trim() || PLACEHOLDER, re: info.re, mid: info.mid, done });
      const stream = bridge.startStream(chat, wrap(''), {});
      if (!stream) return null;
      return {
        update: (body) => stream.update(wrap(body)),
        finish: async (body) => { await stream.finish(wrap(body, true)); },
      };
    },
  });

  return {
    // A message carrying a provenance tail is relay traffic (request or reply), not chat.
    isEnvelope(ev) { return parseMesh(ev?.body ?? '') != null; },

    // Process an inbound envelope. BOTH directions live in the engine's onRoomMessage;
    // we only gate the ttl hop-cap first. The route is the chat it arrived on (so the
    // reply/forward posts back there); msgId correlates a streamed reply's frames.
    async handle(ev) {
      const prov = parseMesh(ev?.body ?? '');
      if (!prov) return false;
      if (ttlExceeded(prov)) return true;                       // dropped (never re-relay)
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
