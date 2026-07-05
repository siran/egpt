// router.mjs — the §2c router service: resolve an InboundEvent to the being that
// should answer. E (the persona) is the default voice.
//
// The `agents:` config block is the ONE registry (operator 2026-07-02, new-config-only):
// resolve() matches a leading @token (word-boundary, case-insensitive) against an agent's
// name or any handle. A LOCAL agent (configuration ≠ 'relay') routes like a being (being =
// agent name); a RELAY agent (configuration: relay) routes to a mesh target whose ROUTE is
// the agent's relay_channel; the PERSONA agent (handles include e/egpt) routes to the
// canonical default being 'e' (its key is display identity only — routing keeps 'e' so warm
// keys / threads / transcripts stay stable). An unknown / disabled @token falls through to E.
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
function findAgent(agents, token) {
  for (const [name, agent] of Object.entries(agents)) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent) || name.startsWith('_')) continue;
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
            if (String(agent.configuration ?? '').toLowerCase() === 'relay') {
              // RELAY agent → a mesh target whose ROUTE is the relay_channel (a chat
              // NAME or a raw room id — the bridge send/stream resolves names via
              // resolveChatId, so BOTH work; we pass it through as room_id). No node:
              // mesh.forward uses this route directly (route-direct variant).
              return { being: null, mesh: { being: name, route: { room_id: agent.relay_channel } }, mention: { ...MENTION } };
            }
            // The PERSONA agent routes to the canonical default being (stable keys).
            if (agentIds(name, agent).some((h) => h === defaultBeing || h === 'e' || h === 'egpt')) {
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
