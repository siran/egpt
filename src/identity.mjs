// src/identity.mjs — surface-agnostic identity + permission layer (Layer B).
//
// Proven from operator data (2026-06-02, baileys sender-key files + the
// @lid name-debug log):
//   - a user's WhatsApp lid is IDENTICAL across every group AND 1:1 (e.g. the
//     operator's lid 34836563681438 appeared in 17 different groups);
//   - lid ↔ phone is a 1:1 bijection (26/26, zero violations);
//   - identity is `‹user›[:‹deviceId›]@‹server›`, sometimes with a group-
//     participant `_N` suffix; the SAME human spans multiple deviceIds
//     (the operator: devices 0, 36, 45 = primary + Beeper + web).
//
// Therefore the CANONICAL user key is the base number with server, deviceId and
// the `_N` suffix stripped. It is stable across groups, 1:1, and devices.
//
//   - lid and phone are DIFFERENT canonical numbers for the same human, so the
//     allowlist must carry whichever form(s) you have; we canonicalize BOTH
//     sides and compare (the operator's config already lists phone + lid).
//   - the deviceId ("from Beeper" vs "from this phone") is INFORMATIONAL ONLY —
//     it must never gate a permission.
//
// Layering:
//   Layer A (coarse, surface/room) — governs CHAT: is this surface a room
//     member? handled by the room model, not here.
//   Layer B (fine, this module) — governs COMMANDS: is the sender's canonical
//     id in allowed_users?

/**
 * Canonicalize any surface identity to a stable, device- and group-independent
 * user key (digits only). Returns null for an unusable input.
 *
 * Strips, in order: a `wa:`/`tg:` scheme prefix, the `@server` part, the
 * `:deviceId` segment, and the group-participant `_N` suffix.
 *
 *   '34836563681438:45@lid'        -> '34836563681438'
 *   '34836563681438_1'             -> '34836563681438'   (group sender-key form)
 *   'wa:16468217865@s.whatsapp.net'-> '16468217865'
 *   '16468217865:42@s.whatsapp.net'-> '16468217865'
 */
export function canonicalUserId(jid) {
  if (jid == null) return null;
  let s = String(jid).trim();
  if (!s) return null;
  s = s.replace(/^(wa|tg|xmpp):/i, '');   // optional surface scheme
  s = s.split('@')[0];                    // drop @server
  s = s.split(':')[0];                    // drop :deviceId
  s = s.split('_')[0];                    // drop group-participant _N suffix
  const digits = s.replace(/[^0-9]/g, '');
  return digits || null;
}

/**
 * The device/source segment — informational only (never a permission input).
 * Primary device is '0' (no explicit segment).
 *
 *   '34836563681438:45@lid' -> '45'
 *   '34836563681438@lid'    -> '0'
 */
export function deviceId(jid) {
  if (jid == null) return '0';
  const user = String(jid).replace(/^(wa|tg|xmpp):/i, '').split('@')[0];
  return user.includes(':') ? user.split(':')[1] : '0';
}

/**
 * Layer B check: may this sender run COMMANDS?
 *
 * True iff the sender's canonical id matches the canonical id of any entry in
 * allowedUsers. Canonicalizing both sides means the allowlist can hold lid or
 * phone form, with or without device/suffix decoration, and any device of the
 * same user is recognised.
 *
 * @param {string} jid                  the sender's native id (any surface form)
 * @param {string[]} allowedUsers       allow-list (canonical ids; lid and/or phone)
 * @returns {boolean}
 */
export function isAuthorizedUser(jid, allowedUsers = []) {
  const me = canonicalUserId(jid);
  if (!me) return false;
  const list = Array.isArray(allowedUsers) ? allowedUsers : [];
  for (const u of list) {
    if (canonicalUserId(u) === me) return true;
  }
  return false;
}

/**
 * Whether two identities are the SAME human, regardless of group, device, or
 * lid-vs-phone *form* — true only when both canonicalize to the same number.
 * (Cross-form equivalence — a user's lid vs their phone — is NOT inferred here;
 * that needs the lid↔phone mapping and is the resolver's job, not this pure
 * comparison.)
 */
export function sameUser(a, b) {
  const ca = canonicalUserId(a);
  return !!ca && ca === canonicalUserId(b);
}
