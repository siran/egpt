// 0013 — warm.idle_ttl_by_class: a -1 class became 12h. Superseded (operator 2026-11-08: memory-only
// eviction; -1 = no timer, the default): nodes that ran it keep what it wrote; anywhere else it is a
// no-op, so a -1 stays -1.
export const elevated = false;
export const summary = 'warm.idle_ttl_by_class -1 → 12h (superseded by memory-only eviction; a no-op)';

export async function plan() {
  return { satisfied: true, notes: ['superseded (operator 2026-11-08: memory-only eviction) - a -1 class TTL stays -1'] };
}
