// router.mjs — the §2c router service: resolve an InboundEvent to the being that
// should answer. E (the persona) is the default voice; a message whose body
// STARTS with `@<name>` (word-boundary, case-insensitive) where `<name>` is a
// ROUTABLE local sibling — a config.siblings entry of type ccode/claude-code that
// is enabled — is routed to that sibling instead. Mid-body `@name` does NOT route
// (start-anchored, v1 semantics); an unknown / disabled / non-ccode `@name` falls
// through to E.
//
// resolve() returns { being, mention }. The mention RIDE-ALONG matters because
// ev.mention is @e-specific (the bridge computes it for the persona wake-word): a
// sibling picked by its OWN @name would otherwise look un-mentioned to its gate,
// so we hand its gate a synthetic mention (atEStart/atEAnywhere true). E keeps
// ev.mention unchanged.
//
// Mesh-target resolution (Phase 4b): a leading @being.node — or a bare @name that
// the ONE sibling registry maps to a remote/relay node — reaches a being on ANOTHER
// machine. resolve() then returns { being: null, mesh: <target>, mention } and the
// spine forwards it (mesh.forward); a LOCAL resolution falls through to the existing
// sibling/E routing unchanged. Gated on meshEnabled() so an unconfigured node behaves
// exactly as v1 (a bare @name never becomes a phantom mesh target).
//
// Agents (operator 2026-07-02): the `agents:` config block is the ONE registry that
// unifies the persona pointer + siblings + mesh addressing. resolve() consults it
// FIRST — a leading @token matching an agent's name or any handle wins over legacy
// siblings + mesh.nodes. A LOCAL agent (type ≠ 'relay') routes like a sibling being
// (being = agent name); a RELAY agent routes to a mesh target whose ROUTE is the
// agent's relay_channel; the PERSONA agent (handles include e/egpt) routes to the
// canonical default being 'e' (its key is display identity only — routing keeps 'e'
// so warm keys / threads / transcripts stay stable). BACK-COMPAT: no agents block →
// this whole branch is skipped and routing is byte-identical to v1 (siblings + mesh
// .nodes + persona). With a block, agents win but legacy siblings not shadowed by an
// agent name stay routable (both worlds during migration).
import { resolveMeshAddress } from '../mesh/names.mjs';

// Only a ccode/claude-code sibling is a local brain the pool can run; codex/URL
// siblings + the mesh are out of v1 scope.
const ROUTABLE_TYPES = new Set(['ccode', 'claude-code']);

// The mention a mesh (or sibling) @name synthesizes for its gate: it IS addressed.
const MENTION = { atEStart: true, atEAnywhere: true, replyToBot: false };

function isRoutable(def) {
  return !!def && typeof def === 'object' && !Array.isArray(def)
    && ROUTABLE_TYPES.has(String(def.type ?? '').toLowerCase())
    && def.enabled !== false;
}

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

export function createRouter({ getSiblings = () => ({}), getAgents = () => ({}), defaultBeing = 'e', getNode = () => null, meshEnabled = () => false } = {}) {
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
            if (String(agent.type ?? '').toLowerCase() === 'relay') {
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

      // Mesh next: a leading @being.node (dot allowed) that resolves to another node.
      // Inert unless mesh is configured. A local / missing / invalid resolution falls
      // through to the v1 local routing below (a bare local @wren keeps working).
      if (meshEnabled()) {
        const mt = /^@([a-z0-9_-]+(?:\.[a-z0-9_-]+)?)/i.exec(body);
        if (mt) {
          const a = resolveMeshAddress(mt[1], { localNode: getNode(), siblings: getSiblings() ?? {} });
          if (a.kind === 'foreign') return { being: null, mesh: { being: a.name, node: a.node, target: a.fqid ?? `${a.name}.${a.node}` }, mention: MENTION };
          if (a.kind === 'relay') return { being: null, mesh: { being: a.being, node: a.node, target: a.target }, mention: MENTION };
        }
      }

      // Leading @token, word-boundary: `\w+` stops at the first non-word char, so
      // `@wren do X` captures `wren` but `@wrenny` captures `wrenny` (no partial hit).
      const m = /^@(\w+)/.exec(body);
      if (m) {
        const name = m[1].toLowerCase();
        const sib = getSiblings() ?? {};
        // Not the persona, not a `_note` comment key, and a routable sibling def.
        if (name !== defaultBeing && !name.startsWith('_') && isRoutable(sib[name])) {
          return { being: name, mention: { ...MENTION } };
        }
      }
      return { being: defaultBeing, mention: ev?.mention };
    },
  };
}
