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

export function createRouter({ getSiblings = () => ({}), defaultBeing = 'e', getNode = () => null, meshEnabled = () => false } = {}) {
  return {
    /** @param {import('../../spine.mjs').InboundEvent} ev
     *  @returns {{ being: string|null, mesh?: object, mention: object|undefined }} */
    resolve(ev) {
      const body = ev?.body ?? '';

      // Mesh first: a leading @being.node (dot allowed) that resolves to another node.
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
