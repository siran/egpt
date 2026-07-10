// echo-hrw.mjs — the 👂-echo deterministic PICK (operator 2026-07-10, Phase 3a;
// plans/2607101713-HRW-ECHO-PLAN.md). NOT dedup.
//
// The problem: two co-account spines (REVE `kg`, DOLLY `do`) share ONE Beeper
// account, so BOTH see the same voice note and BOTH would post its 👂 transcript
// → double-👂. This module makes exactly ONE of them post each note, rotating per
// note, with NO coordination and NO watch-and-cancel.
//
// The mechanism is RENDEZVOUS HASHING (HRW): each node computes, PER NOTE and
// UPFRONT, whether IT is the winner — hash(note_id + ' ' + candidate) for every
// candidate, the MAX-hash candidate posts. Coordination-free correctness rests on
// two things being IDENTICAL across the nodes (see the plan), so both independently
// pick the same winner:
//   1. the note_id — the voice note's shared Beeper message id (one account → the
//      same message → the same per-chat sequence id on both nodes), and
//   2. the candidate set — `account_peers`, listed identically in both configs.
//
// NOT-DEDUP INVARIANT (the operator's hard line): there is no act-then-suppress and
// no message exchanged. Each node decides on its own whether it is the one; the only
// "coordination" is that the shared note_id + shared peer set make the deterministic
// pick agree. (Phase 3b timeout-promotion — failover for an OFFLINE winner — is a
// separate later chunk and is NOT built here.)
//
// Pure + process-independent by construction: FNV-1a is a plain arithmetic string
// hash (no Math.random, no Date, no platform floats), so two processes compute the
// identical winner. Fully unit-testable (tests/echo-hrw.test.mjs).

// FNV-1a 32-bit — a well-distributed, deterministic string hash. Math.imul does the
// 32-bit-wrapping multiply by the FNV prime; `>>> 0` keeps it an unsigned 32-bit int
// so comparisons are stable across engines.
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Rendezvous hash: return the candidate with the MAX hash of `key + ' ' + candidate`.
// Ties (equal hash) break on the lexicographically SMALLER candidate string, so the
// winner is independent of the order candidates are passed in — the property both
// nodes rely on to agree. null for an empty/absent candidate list.
export function hrwWinner(key, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const k = String(key);
  let best = null;
  let bestHash = -1;
  for (const c of candidates) {
    const cand = String(c);
    const h = fnv1a32(`${k} ${cand}`);
    if (best === null || h > bestHash || (h === bestHash && cand < best)) {
      best = cand;
      bestHash = h;
    }
  }
  return best;
}

// Is THIS node the one to echo `noteId`? True iff it is the HRW winner over the
// co-account peer set. Peers fall back to `[selfNode]` when account_peers is
// empty/absent → a solo node is always its own winner (always echoes, the lone-node
// behavior). All comparison is lowercased so config casing never splits the pick.
export function isEchoWinner(noteId, selfNode, accountPeers) {
  const self = String(selfNode).toLowerCase();
  const peers = (Array.isArray(accountPeers) && accountPeers.length ? accountPeers : [selfNode])
    .map((p) => String(p).toLowerCase());
  return hrwWinner(String(noteId), peers) === self;
}
