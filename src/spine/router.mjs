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
// Mesh-target resolution (a @name that lives on ANOTHER node) is the later seam,
// behind this same resolve().

// Only a ccode/claude-code sibling is a local brain the pool can run; codex/URL
// siblings + the mesh are out of v1 scope.
const ROUTABLE_TYPES = new Set(['ccode', 'claude-code']);

function isRoutable(def) {
  return !!def && typeof def === 'object' && !Array.isArray(def)
    && ROUTABLE_TYPES.has(String(def.type ?? '').toLowerCase())
    && def.enabled !== false;
}

export function createRouter({ getSiblings = () => ({}), defaultBeing = 'e' } = {}) {
  return {
    /** @param {import('../../spine.mjs').InboundEvent} ev
     *  @returns {{ being: string, mention: object|undefined }} */
    resolve(ev) {
      // Leading @token, word-boundary: `\w+` stops at the first non-word char, so
      // `@wren do X` captures `wren` but `@wrenny` captures `wrenny` (no partial hit).
      const m = /^@(\w+)/.exec(ev?.body ?? '');
      if (m) {
        const name = m[1].toLowerCase();
        const sib = getSiblings() ?? {};
        // Not the persona, not a `_note` comment key, and a routable sibling def.
        if (name !== defaultBeing && !name.startsWith('_') && isRoutable(sib[name])) {
          return { being: name, mention: { atEStart: true, atEAnywhere: true, replyToBot: false } };
        }
      }
      return { being: defaultBeing, mention: ev?.mention };
    },
  };
}
