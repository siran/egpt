// extension/src/bridges/wa-routing.js — pure decision functions for
// WA-CDP auto-mirror gates. Two flows feed into this:
//
//   1. Extension-typed plain text → maybe auto-mirror to a WA chat.
//   2. Brain reply (from runBrain) → maybe mirror to a WA chat.
//
// Both must NOT leak into WA unless the user has explicitly opted in.
// Opt-in signals:
//   - /join @waN  — persistent binding via waJoinedRef.
//   - replyTo set — the request originated from a specific WA chat;
//                   the reply travels back to that exact chat.
//
// The legacy gate "whatsapp_cdp.chat_name is set" used to imply auto-
// mirror, but chat_name's only role is identifying the self-DM for the
// wake-word bypass (incoming side); it's NOT an outbound destination.
// Treating it as one made any extension-typed message leak to the
// user's self-DM whenever chat_name was configured. Pinning these
// rules in pure functions + tests so the invariant can't regress.

/**
 * Decide whether locally-typed plain-text input should be mirrored
 * to a WA chat.
 *
 *   fromBridge — when set, the input came FROM a bridge (e.g., WA
 *                content script). The bridge already published the
 *                message; mirroring back would loop. Always false.
 *   waJoined   — true when /join @waN is currently bound. Mirrors
 *                outbound to that chat.
 *
 * Returns: boolean.
 */
export function shouldMirrorTypedToWa({ fromBridge, waJoined } = {}) {
  if (fromBridge) return false;
  return !!waJoined;
}

/**
 * Decide whether a brain reply should be mirrored to a WA chat.
 *
 *   replyTo  — when set, the reply targets a SPECIFIC chat (because
 *              the request came from a bridge with that chatId).
 *              Always mirror — that's where the user is waiting.
 *   waJoined — true when /join @waN is bound. Mirror outbound replies
 *              there even when no specific replyTo is given (e.g.,
 *              extension-typed @e while joined to a chat).
 *
 * Returns: boolean.
 */
export function shouldMirrorBrainReplyToWa({ replyTo, waJoined } = {}) {
  return !!replyTo || !!waJoined;
}
