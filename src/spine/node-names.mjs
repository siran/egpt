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
