// src/lid-map.mjs — the learned LID↔PN resolver.
//
// WhatsApp gives the same human TWO numbers: a phone (PN, '<n>@s.whatsapp.net')
// and a LID ('<m>@lid'). They are DIFFERENT digit strings but a proven 1:1
// bijection (see identity.mjs). canonicalUserId() alone therefore CANNOT decide
// that a lid and a phone are the same person — that needs the actual pairing.
//
// baileys 7 surfaces the pairing from several authoritative sources (NOT guesses):
//   - sock.user                      → { id: <pn jid>, lid: <lid jid> }   (us)
//   - per message key                → remoteJid/remoteJidAlt,
//                                       participant/participantAlt/participantPn,
//                                       senderLid   (the sender, both forms)
//   - groupMetadata participants     → { id: <pn>, lid: <lid>, ... }
//   - signalRepository.lidMapping    → getPNForLID / getLIDForPN (async store)
//
// This module accumulates those pairings into an in-memory bijection so any lid
// can be normalized to its phone (for authorization against a phone allowlist,
// and for self-DM delivery) and vice-versa. It is pure + synchronous; the bridge
// owns persistence (load initial, save on change) and feeds it from the sources
// above. Only WhatsApp-provided pairings are learned — never inferred — so a
// normalization can never authorize a stranger.

import { canonicalUserId } from './identity.mjs';

const isLidJid = (j) => /@lid\b/i.test(String(j ?? ''));

/**
 * @param {{lidToPn?:Record<string,string>, pnToLid?:Record<string,string>}} [initial]
 */
export function createLidMap(initial = {}) {
  const lidToPn = new Map(Object.entries(initial?.lidToPn ?? {}));
  const pnToLid = new Map(Object.entries(initial?.pnToLid ?? {}));
  let dirty = false;

  // Record a lid↔pn pairing (canonical digits). Returns true if it added/changed
  // something. Rejects garbage and the degenerate lid===pn case.
  function learn(lidJid, pnJid) {
    const lid = canonicalUserId(lidJid);
    const pn = canonicalUserId(pnJid);
    if (!lid || !pn || lid === pn) return false;
    if (lidToPn.get(lid) === pn && pnToLid.get(pn) === lid) return false;
    lidToPn.set(lid, pn);
    pnToLid.set(pn, lid);
    dirty = true;
    return true;
  }

  // Learn from an unordered pair where exactly one side is a '@lid' jid.
  function learnPair(a, b) {
    const aLid = isLidJid(a), bLid = isLidJid(b);
    if (aLid && !bLid) return learn(a, b);
    if (bLid && !aLid) return learn(b, a);
    return false;   // both same kind / can't tell which is the lid
  }

  // Canonical PN digits for a lid jid (or null).
  function pnForLid(jid) { const l = canonicalUserId(jid); return l ? (lidToPn.get(l) ?? null) : null; }
  // Canonical LID digits for a phone jid (or null).
  function lidForPn(jid) { const p = canonicalUserId(jid); return p ? (pnToLid.get(p) ?? null) : null; }

  // The OTHER-form canonical digits for any jid: pn if jid is a known lid, lid if
  // jid is a known pn. null when unknown. Used by authorization to also try the
  // sender's counterpart against the allowlist.
  function counterpart(jid) {
    return isLidJid(jid) ? pnForLid(jid) : (lidForPn(jid) ?? pnForLid(jid));
  }

  // A sendable phone jid ('<pn>@s.whatsapp.net') for a lid jid, or null. Used to
  // normalize a self-DM that arrived as '@lid' back to the watched note-to-self.
  function pnJidForLid(jid, server = 's.whatsapp.net') {
    const pn = pnForLid(jid);
    return pn ? `${pn}@${server}` : null;
  }

  return {
    learn,
    learnPair,
    pnForLid,
    lidForPn,
    counterpart,
    pnJidForLid,
    get size() { return lidToPn.size; },
    get dirty() { return dirty; },
    clearDirty() { dirty = false; },
    toJSON() {
      return { lidToPn: Object.fromEntries(lidToPn), pnToLid: Object.fromEntries(pnToLid) };
    },
  };
}
