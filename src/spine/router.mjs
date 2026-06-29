// router.mjs — the §2c router service: resolve an InboundEvent to the being that
// should answer. v1 routes every auto-dispatched chat to the E persona — the one
// being in the v1 scope. Sibling-being routing (@wren / @don / @l by per-being
// mode) and mesh-target resolution (gating.isMeshTarget → mesh.forward) layer in
// at Phase 4b, behind this same resolve() seam.
export function createRouter({ defaultBeing = 'e' } = {}) {
  return {
    resolve(_ev) { return defaultBeing; },
  };
}
