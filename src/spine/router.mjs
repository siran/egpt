// router.mjs — the §2c router service: resolve an InboundEvent to the being that
// should answer. E (the persona) is the default voice.
//
// The `agents:` config block is the ONE registry (operator 2026-07-02, new-config-only):
// resolve() matches a leading @token (word-boundary, case-insensitive) against an agent's
// name or any handle. A LOCAL agent (configuration ≠ 'relay') routes like a being (being =
// agent name); a RELAY agent (configuration: relay) routes to a mesh target whose ROUTE is
// the agent's relay_channel; the DEFAULT (persona) agent — the one carrying `default: true`,
// whose KEY boot injects as `defaultBeing` — routes to its own key (operator 2026-07-10: the
// being-id IS the map key, no hardcoded 'e'/'egpt'). An unknown / disabled @token falls
// through to the persona (defaultBeing).
//
// resolve() returns { being, mention }. The mention RIDE-ALONG matters because ev.mention is
// @e-specific (the bridge computes it for the persona wake-word): a local agent picked by its
// OWN @name would otherwise look un-mentioned to its gate, so we hand its gate a synthetic
// mention (atEStart/atEAnywhere true). E keeps ev.mention unchanged.
//
// Mesh-target resolution (Phase 4b): a leading @being.node reaches a being on ANOTHER machine.
// resolve() then returns { being: null, mesh: <target>, mention } and the spine forwards it
// (mesh.forward). Gated on meshEnabled() so an unconfigured node never mints a phantom target.
import { resolveMeshAddress } from '../mesh/names.mjs';
import { agentPaths } from '../mesh/relay.mjs';

// The mention a mesh (or agent) @name synthesizes for its gate: it IS addressed.
const MENTION = { atEStart: true, atEAnywhere: true, replyToBot: false };

// An agent's routable identity tokens: its map KEY plus any `handles:` aliases, all
// lowercased. Used to match a leading @token and to spot the persona agent.
function agentIds(name, agent) {
  const hs = Array.isArray(agent?.handles) ? agent.handles : [];
  return [name, ...hs].map((h) => String(h).toLowerCase());
}

// Find the agent whose name/handle matches `token` (case-insensitive). Skips `_note`
// comment keys and disabled agents (enabled:false) so they fall through to legacy.
// Returns { name, agent } with `name` = the canonical (lowercased) key, or null.
// An ARRAY-shaped agent is a MULTI-PATH relay agent (operator 2026-07-06: an agent is a list of
// paths) — it has no handles, so it routes by its map KEY alone; agentIds tolerates the array shape
// (agent.handles is undefined → just the name). It is matched here so resolve() can fan it out.
function findAgent(agents, token) {
  for (const [name, agent] of Object.entries(agents)) {
    if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
    if (agent.enabled === false) continue;
    if (agentIds(name, agent).includes(token)) return { name: name.toLowerCase(), agent };
  }
  return null;
}

export function createRouter({ getAgents = () => ({}), defaultBeing = 'e', getNode = () => null, getAliases = () => [], meshEnabled = () => false } = {}) {
  return {
    /** @param {import('../../spine.mjs').InboundEvent} ev
     *  @returns {{ being: string|null, mesh?: object, mention: object|undefined }} */
    resolve(ev) {
      const body = ev?.body ?? '';

      // Agents FIRST. A leading @token (word-boundary; hyphens allowed since agent
      // names may carry them, e.g. `don-local`) that matches an agent's name/handle
      // wins over everything below.
      const agents = getAgents() ?? {};
      if (agents && typeof agents === 'object' && Object.keys(agents).length) {
        const at = /^@([a-z0-9_-]+)/i.exec(body);
        if (at) {
          const found = findAgent(agents, at[1].toLowerCase());
          if (found) {
            const { name, agent } = found;
            // MULTIPATH (operator 2026-07-06: multipath is configuration — an agent is a list of
            // paths, every message through every path). A LIST-shaped agent is a relay whose every
            // element posts the SAME message into its own relay_channel with its own network pin.
            // Return the mesh target carrying ALL paths; mesh.forward posts one envelope per path
            // (one 🤔 placeholder for the human, same re:/post_id). Handled BEFORE the scalar check
            // (a list has no top-level relay_channel). Each path: { route:{room_id,network?}, to?, label }.
            if (Array.isArray(agent)) {
              const paths = agentPaths(agent).map((p) => ({
                route: { room_id: p.relay_channel, ...(p.network ? { network: String(p.network).toLowerCase() } : {}) },
                ...(String(p.to ?? '').trim() ? { to: String(p.to).trim() } : {}),
                label: p.label,
              }));
              return { being: null, mesh: { being: name, paths }, mention: { ...MENTION } };
            }
            // A RELAY agent is one carrying a `relay_channel:` (or the legacy explicit
            // `configuration: relay`). It forwards rather than answers: the message goes
            // into the relay_channel as a mesh envelope. An optional `to: <being>.<node>`
            // names the NEXT hop (a declarative relay chain — the next node re-addresses
            // onward via its own agent entry); no `to` = open-channel (the owner of this
            // being on the far end answers). mesh.forward uses the route directly.
            if (agent.relay_channel || String(agent.configuration ?? '').toLowerCase() === 'relay') {
              const to = String(agent.to ?? '').trim();
              // NETWORK PIN (operator 2026-07-06: multi-network mesh) — the same chat name
              // can exist on several networks under one Beeper account; carry an optional
              // `network:` beside room_id so the bridge resolves the name to the pinned one.
              const mesh = { being: name, route: { room_id: agent.relay_channel, ...(agent.network ? { network: String(agent.network).toLowerCase() } : {}) }, ...(to ? { to } : {}) };
              return { being: null, mesh, mention: { ...MENTION } };
            }
            // The DEFAULT (persona) agent routes to its own key (= defaultBeing), keeping
            // the bridge-computed ev.mention. Matched by key OR the `default: true` marker —
            // no 'e'/'egpt' literals (operator 2026-07-10).
            if (name === defaultBeing || agent.default === true) {
              return { being: defaultBeing, mention: ev?.mention };
            }
            // Any other LOCAL agent → being = its name, with a synthetic mention.
            return { being: name, mention: { ...MENTION } };
          }
        }
      }

      // Mesh next: a leading @being.node (dot allowed) that resolves to ANOTHER node reaches
      // a being cross-machine. Inert unless mesh is configured. A qualified @being.node whose
      // node isn't this one → a foreign mesh target; anything else falls through to E. Remote
      // beings addressable by a bare @name are RELAY AGENTS (handled by the agents block above),
      // so no sibling registry is consulted here.
      if (meshEnabled()) {
        const mt = /^@([a-z0-9_-]+(?:\.[a-z0-9_-]+)?)/i.exec(body);
        if (mt) {
          const a = resolveMeshAddress(mt[1], { localNode: getNode(), localAliases: getAliases() });
          if (a.kind === 'foreign') return { being: null, mesh: { being: a.name, node: a.node, target: a.fqid ?? `${a.name}.${a.node}` }, mention: MENTION };
        }
      }

      return { being: defaultBeing, mention: ev?.mention };
    },
  };
}
