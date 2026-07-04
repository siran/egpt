// sanitize.mjs — leaf module: filesystem-safe name/slug sanitizers.
//
// A LEAF on purpose: it imports nothing from the project, so the Room
// abstraction (src/room-core.mjs) and both entity roots (conversations-state.mjs
// → slugDir, src/rooms.mjs → roomDir) can all share these without an import
// cycle. The implementations were extracted VERBATIM from their old homes
// (conversations-state.sanitizeSlug, rooms.sanitizeName) and those modules now
// re-export from here, so every existing importer is unaffected (no behavior
// change — Phase 0a of the conversations↔rooms merge, GENOME §2.5).

// ── Slug sanitization (Windows-path-safe) ──────────────────────────────────
//
// Operator (2026-06-14): "slugs must substitute ONLY for windows path-unfriendly
// characters. accents and spaces and more are allowed; slashes etc. can be
// substituted." So the slug stays as close to the real contact/group NAME as
// possible — "Tío Jesús Palma", "+1 (646) 821-7865", "premise-driven bitcoin"
// — and only the characters Windows forbids in a filename are removed:
//   < > : " / \ | ? *   and the ASCII control range, plus the trailing-dot /
//   trailing-space rule and the reserved device names (CON, PRN, …).
// Illegal chars collapse to a single space so tokens don't fuse oddly. Idempotent
// (re-sanitizing a clean slug is a no-op) so slugDir() can re-apply it freely.
// `cap` (default 80, the historic slug cap) is overridable so other name consumers
// (stats filenames want ~120 with their own word-boundary trim, operator 2026-07-04)
// share this ONE implementation instead of reimplementing the char rules.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export function sanitizeSlug(s, cap = 80) {
  let out = String(s ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')   // Windows-illegal + control → space
    .replace(/\s+/g, ' ')                       // collapse whitespace runs
    .replace(/^[.\s]+|[.\s]+$/g, '')            // no leading/trailing dot or space
    .slice(0, cap)
    .replace(/[.\s]+$/g, '');                   // re-trim if slice landed on a dot/space
  if (!out || out === '.' || out === '..') return '';
  if (WIN_RESERVED.test(out)) out += '_';       // CON → CON_ (reserved device name)
  return out;
}

// ── Room-name sanitization (kebab token) ────────────────────────────────────
// A room's NAME is an operator-chosen handle (e.g. "work", "chatgpt-cdp"); it
// reduces to a lowercase kebab token. Empty → "room" so a folder always exists.
export function sanitizeName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'room';
}
