// chat-id.mjs — the short/full Beeper room-id normalizer pair (ONE place).
//
// Beeper chatIDs are Matrix room ids: '!<opaque>:beeper.local'. Operator
// 2026-07-03: neither the leading '!' nor the trailing ':beeper.local' is part
// of the chat's real identity — ':beeper.local' specifically names Beeper's
// OWN local bridge server, nothing about the chat, and a Matrix USER id can
// legitimately live on a DIFFERENT server ('@anrodriguez:beeper.com' — a
// different sigil AND a different suffix, verified live in the operator's own
// config.yaml allowed_users). So: SHORT ids everywhere inside egpt (registry
// keys, config, gating, transcripts, mesh); the full Matrix form is expanded
// back ONLY at the Beeper API boundary (src/bridges/beeper.mjs call sites).
//
// Strips/re-adds EXACTLY ':beeper.local' — not a wildcard ':<server>'. Other
// servers don't occur on CHAT ids from the local Beeper API (only on USER ids,
// a different namespace entirely — '@user:...', never '!room:...'), so a
// narrower match would be speculative; this one is verified against the live
// registry.
const SUFFIX = ':beeper.local';

// '!xxxx:beeper.local' -> 'xxxx'. Idempotent (a short id, or anything that
// isn't a Beeper room id shaped like this — a phone number, a '@user:...' id,
// a plain name/slug — passes through unchanged).
export function shortChatId(id) {
  const s = String(id ?? '');
  if (s.startsWith('!') && s.endsWith(SUFFIX)) return s.slice(1, -SUFFIX.length);
  return s;
}

// 'xxxx' -> '!xxxx:beeper.local'. Idempotent (an already-full id — on
// ':beeper.local' OR any other homeserver, e.g. a Beeper-cloud-hosted chat
// living on ':beeper.com' — or an empty string, passes through unchanged).
// A chat NOT homed on beeper.local isn't shortened by shortChatId (see its
// comment), so its id already circulates in full '!xxxx:<server>' form; only
// a bare short id (no leading '!') gets wrapped here. Without this check, an
// already-full non-beeper.local id gets wrapped AGAIN — '!!xxxx:beeper.com:
// beeper.local' — 404ing every API call for that chat (verified live,
// operator 2026-07-04). Callers must only pass an ACTUAL room id
// (post-resolution) — never a name/slug, which this does not know how to expand.
export function fullChatId(id) {
  const s = String(id ?? '');
  if (!s || (s.startsWith('!') && s.slice(1).includes(':'))) return s;
  return `!${s}${SUFFIX}`;
}
