// tools/wa-bindings.mjs — stable @waN ↔ chat-jid bindings for the WA bridge.
//
// Before: @waN was position-in-the-latest-listing. /channels or /recap
// rebuilt the cache in whatever recency order the bridge currently
// reported, and a chat reorder between the operator looking and the
// operator typing /movie silently retargeted @wa1 to a different chat.
// Animations ran in the wrong group with no loud signal — reads as
// "broken" from where the operator was watching.
//
// Now: once a chat is shown at @waN (via /channels, /recap, or the
// on-connect recap), it stays @waN for the rest of the daemon session,
// regardless of how many times the chat list is rebuilt or how the
// recency order shifts. New chats append at the next free index.
// Bindings reset on daemon restart — the operator re-runs /channels
// or /recap to re-seed.
//
// Persistence-to-disk is intentionally NOT here yet. The frequent
// scenario the operator hit is intra-session drift (one session,
// multiple recaps); in-memory fixes that. Cross-session stability
// would need ~/.egpt/wa-bindings.json — straightforward to add when
// the same wrong-chat surprise survives a restart.

const _byJid = new Map();   // chat jid → stableIdx (1-based)
let   _nextIdx = 1;

// Look up or assign a stable index for `jid`. Returns 1-based index.
// Idempotent: subsequent calls for the same jid return the same index.
export function assignWaIndex(jid) {
  if (!jid) return null;
  const existing = _byJid.get(jid);
  if (existing != null) return existing;
  const idx = _nextIdx++;
  _byJid.set(jid, idx);
  return idx;
}

// Read-only lookup — does NOT assign. Useful for display paths that
// have already passed through `waListToStableCache` (which assigns
// for every chat in one pass).
export function getWaIndex(jid) {
  return _byJid.get(jid) ?? null;
}

// Reverse lookup: stableIdx → jid (null if no chat bound at that idx).
export function getJidByWaIndex(idx) {
  for (const [jid, i] of _byJid) if (i === idx) return jid;
  return null;
}

// Wrap a chat list (in any display order) into the sparse cache the
// /movie, /oracle, /pin, /react, ... slashes read via @waN. Returns an
// Array where out[stableIdx - 1] = chat object; slots for chats not
// in this list remain undefined (the slashes already handle that via
// their "no chat at @waN" error branch). Side effect: assigns
// indices to any jids not yet bound.
export function waListToStableCache(chats) {
  const out = [];
  if (!Array.isArray(chats)) return out;
  for (const c of chats) {
    if (!c?.jid) continue;
    const idx = assignWaIndex(c.jid);
    out[idx - 1] = c;
  }
  return out;
}
