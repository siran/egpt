// node-names.mjs — this node's OWN names: node_name ∪ node_alias, lowercased.
//
// Two co-account spines (REVE `kg`, DOLLY `do`) share ONE Beeper account, so a
// message addressed to a node by name has to be matched against every identity
// THIS process answers to — its node_name plus any node_alias. That set is the
// wake-word gate: a node that isn't addressed stays silent, so exactly one node
// answers on the shared account.
//
// Extracted here so boot's node-identity line and the spine's /chrome gate resolve
// the set the SAME way (src/spine/mesh.mjs builds an equivalent selfNodes set from
// cfg inside its own closure; it predates this module and is left alone).
// Lives in its own file to stay importable from commands.mjs without an
// import cycle back through boot.mjs.
import { agentPaths } from '../mesh/relay.mjs';
import { surfaceOf } from './identity.mjs';

/** @returns {Set<string>} lowercased node_name ∪ node_alias (empty/absent entries dropped) */
export function ownNodeNames({ nodeName = null, nodeAlias = [] } = {}) {
  return new Set(
    [nodeName, ...(Array.isArray(nodeAlias) ? nodeAlias : [])]
      .map((s) => String(s ?? '').trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Read the own-names set straight off a config object (cfg.node_name / cfg.node_alias). */
export function ownNodeNamesOf(cfg) {
  return ownNodeNames({ nodeName: cfg?.node_name ?? null, nodeAlias: cfg?.node_alias ?? [] });
}

// ── THE ROUTING TABLE ───────────────────────────────────────────────────────
// There is no `mesh.nodes` any more (evicted 2026-07-25 on the operator's ruling "we do
// agent-base routing"). What reaches another node is a RELAY AGENT: an entry carrying a
// `relay_channel:` and a `to: <being>.<node>` IS the statement that its channel reaches
// <node>. Flattening every such path out of the AGENTS block therefore yields the routing
// table itself — derived, never declared twice.
//
// One record per PATH (a multipath agent declares a list under `paths:`, operator 2026-07-06),
// each:
//   { name, being, node, relay_channel, network?, surface, label }
// `surface` is the agent's SURFACE PIN (null when unpinned) — the operator's declaration of
// where this relay applies (kg pins `don` to `surface: shell` because on Beeper `do` hears
// him directly). Every agent is a MAP since 2026-07-26, multipath included, so a multipath
// agent can carry a pin like any other and it is read the same way.
// Paths with no `to:` or no `relay_channel` are not routes and are skipped, as are
// `_`-comment keys. (An agent-level `enabled:` key is NOT consulted — operator 2026-07-26,
// "disabling is just commenting the config".)
/** @returns {{name:string,being:string,node:string,relay_channel:string,network?:string,surface:string|null,label:string,to:string}[]} */
export function agentRoutes(cfg) {
  const out = [];
  for (const [name, agent] of Object.entries(cfg?.agents ?? {})) {
    if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
    // The pin names a NETWORK the operator types (`surface: shell`); resolve it through THE
    // network→surface map here, once, so routeToNode compares it against an ev.surface built
    // from the SAME map. router.mjs applies the identical resolution to the identical key.
    const surface = agent.surface != null ? surfaceOf(String(agent.surface).toLowerCase()) : null;
    for (const p of agentPaths(agent)) {
      const to = String(p.to ?? '').trim();
      if (!to || !p.relay_channel) continue;
      const parts = to.split('.');
      if (parts.length < 2) continue;
      out.push({
        name: name.toLowerCase(), being: parts[0].toLowerCase(), node: parts[parts.length - 1].toLowerCase(),
        relay_channel: String(p.relay_channel), ...(p.network ? { network: String(p.network).toLowerCase() } : {}),
        surface, label: p.label ?? '', to,
      });
    }
  }
  return out;
}

// ── TRANSIT: A RELAY CHANNEL IS NOT A CONVERSATION ──────────────────────────
// (operator 2026-08-31: "when a message arrived to a 'egpt-mesh-*' channel, it must be
// treated as a transit message. the log if required is in beeper itself".)
//
// THE LIVE EVIDENCE on kg: `~/.egpt/conversations/whatsapp/egpt-mesh-do-kg-2608311419/
// transcript.md`, and a conversations.yaml entry for the channel's chat id carrying
// `agents.egpt.threadId`. A relay channel carries ENVELOPES between spines; Beeper already
// holds every one of those messages, so a second copy on this node's record is not a log,
// it is a conversation that does not exist — with a slug, a thread and a stats block.
//
// DERIVED FROM THE ROUTING TABLE ITSELF (agentRoutes, above) — never a second walk of the
// agents block, which is how "which chats are relay channels" would start to drift from
// "where does this node relay to". A path with NO `to:` is not a route and so not transit
// here, deliberately and by the same rule agentRoutes already applies: `to: <being>.<node>`
// IS the statement that this channel reaches another node's spine, and that statement is
// exactly what makes the chat transport rather than a place people talk.
/** @returns {Set<string>} every relay_channel this node routes through, trimmed + lowercased */
export function relayChannels(cfg) {
  const out = new Set();
  for (const r of agentRoutes(cfg)) {
    const s = String(r.relay_channel ?? '').trim().toLowerCase();
    if (s) out.add(s);
  }
  return out;
}

// Is THIS event's chat one of them? A relay_channel is configured by NAME ("egpt-mesh-do-kg")
// and the bridge resolves that name to an id when it POSTS (mesh.mjs canonRoute) — but an
// arriving message carries both halves already (ev.chatName, ev.chatId), so the question is
// answered node-locally with no socket and no cache. BOTH are compared because a relay_channel
// may legitimately be configured as a raw id (test-locked in tests/spine-mesh.test.mjs,
// "a relay_channel configured as a RAW id … forwards unchanged").
/** @returns {boolean} true when this event arrived on a transit channel */
export function isRelayChannelChat(cfg, ev) {
  const chans = relayChannels(cfg);
  if (!chans.size) return false;                       // no relay agents → nothing is transit
  const k = (s) => String(s ?? '').trim().toLowerCase();
  return chans.has(k(ev?.chatName)) || chans.has(k(ev?.chatId));
}

// ── PROVENANCE: WHICH SPINE COMMITTED THIS FRAME ────────────────────────────
// (operator 2026-08-31: "a being does not wake on a frame committed by a DIFFERENT node's
// spine".) `ev.fromNode` is the structural node signature decoded at the ONE moment the raw
// text still carries it (src/spine/identity.mjs) — src/stop-guard.mjs already reads it to
// classify a turn NON-human, which bounds the COUNTING. This is the other question asked of
// the same fact: is that spine SOMEONE ELSE'S?
//
// `fromNode != null` IS THE WRONG TEST and the difference is not academic: it means "some
// spine posted this", which includes OUR OWN synthetics — the room relay re-addresses an
// invited group's line into the room it joined and carries `fromNode` across deliberately
// (src/spine/room-relay.mjs tunnelOf, 8227b99), because identity has already rendered the
// invisible frame away and the fact can no longer be re-read from the body. Silencing on mere
// presence would silence a multi-brain room's own traffic.
//
// So it is compared against THIS node's own names — ownNodeNamesOf, the SAME set the /chrome
// gate and the boot identity line match (node_name ∪ node_alias, lowercased), never a second
// notion of "who are we". '' (SIGNED BY A NODE WE CANNOT NAME — an empty or garbled frame) is
// therefore ANOTHER node: it is provably not this one, since boot refuses to start without a
// node_name and every frame we commit carries it.
/** @returns {boolean} true when this frame was committed by a spine that is NOT this node */
export function fromOtherNode(cfg, ev) {
  const from = ev?.fromNode;
  if (from == null) return false;                      // UNSIGNED — a person, the ordinary case
  return !ownNodeNamesOf(cfg).has(String(from).trim().toLowerCase());
}

/** Every node name this config KNOWS: our own ∪ account_peers ∪ every node an agent routes to. */
export function knownNodeNames(cfg) {
  const out = ownNodeNamesOf(cfg);
  for (const p of (Array.isArray(cfg?.account_peers) ? cfg.account_peers : [])) {
    const s = String(p ?? '').trim().toLowerCase();
    if (s) out.add(s);
  }
  for (const r of agentRoutes(cfg)) out.add(r.node);
  return out;
}
