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
// One record per PATH (a multipath agent is a list of paths, operator 2026-07-06), each:
//   { name, being, node, relay_channel, network?, surface, label }
// `surface` is the agent's SURFACE PIN (null when unpinned) — the operator's declaration of
// where this relay applies (kg pins `don` to `surface: shell` because on Beeper `do` hears
// him directly). A LIST-shaped agent is an Array and carries no pin, so it is always null.
// Paths with no `to:` or no `relay_channel` are not routes and are skipped, as are
// `_`-comment keys and disabled agents.
/** @returns {{name:string,being:string,node:string,relay_channel:string,network?:string,surface:string|null,label:string,to:string}[]} */
export function agentRoutes(cfg) {
  const out = [];
  for (const [name, agent] of Object.entries(cfg?.agents ?? {})) {
    if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
    if (!Array.isArray(agent) && agent.enabled === false) continue;
    const surface = (!Array.isArray(agent) && agent.surface != null) ? String(agent.surface).toLowerCase() : null;
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
