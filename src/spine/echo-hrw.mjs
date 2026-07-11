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
// pick agree. Phase 3b (timeout-promotion — ORDERED FAILOVER for an OFFLINE/silent
// winner) is built on this SAME hash: hrwRanked returns the FULL failover order and
// echoRank gives this node's 1-indexed position, so a lower rank posts only if the
// higher ranks stay silent (the timer + observe-and-cancel live in the bridge +
// incoming-media, NOT here — this module stays pure). Still not dedup: the rank is a
// deterministic UPFRONT pre-assignment; the observe only covers an offline higher rank.
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

// Rendezvous RANKING (Phase 3b): return ALL candidates sorted by DESCENDING hash of
// `key + ' ' + candidate` — the full FAILOVER ORDER, deterministic + identical on every
// node (the same coordination-free property hrwWinner relies on, extended to the whole
// list). Ties (equal hash) break on the lexicographically SMALLER candidate string, so
// the order is a total order independent of the order candidates are passed in. [] for an
// empty/absent candidate list. hrwWinner is now exactly `hrwRanked(...)[0]`.
export function hrwRanked(key, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const k = String(key);
  return candidates
    .map((c) => { const cand = String(c); return { cand, h: fnv1a32(`${k} ${cand}`) }; })
    .sort((x, y) => (y.h !== x.h)
      ? y.h - x.h                                        // DESCENDING hash (max-hash = rank 1)
      : (x.cand < y.cand ? -1 : x.cand > y.cand ? 1 : 0))// stable lexicographic tie-break (smaller first)
    .map((e) => e.cand);
}

// Rendezvous hash: the candidate with the MAX hash of `key + ' ' + candidate` — rank 1 of
// the failover order. Reimplemented on hrwRanked so the pick and the order can never
// diverge. null for an empty/absent candidate list.
export function hrwWinner(key, candidates) {
  const ranked = hrwRanked(key, candidates);
  return ranked.length ? ranked[0] : null;
}

// This node's 1-INDEXED RANK for `noteId` over the co-account peer set (Phase 3b ordered
// failover): 1 = the HRW winner (posts now), 2 = first failover (posts only if rank-1 is
// silent), … Peers fall back to `[selfNode]` when account_peers is empty/absent → a solo
// node is always rank 1 (the lone-node echo behavior). All lowercased so config casing
// never splits the order. 0 iff selfNode isn't among the peers (defensive — account_peers
// is documented to include self; a caller that violates that gets a never-post sentinel).
export function echoRank(noteId, selfNode, accountPeers) {
  const self = String(selfNode).toLowerCase();
  const peers = (Array.isArray(accountPeers) && accountPeers.length ? accountPeers : [selfNode])
    .map((p) => String(p).toLowerCase());
  const idx = hrwRanked(String(noteId), peers).indexOf(self);
  return idx < 0 ? 0 : idx + 1;
}

// Is THIS node the one to echo `noteId`? True iff it is rank 1 (the HRW winner) — kept as
// a thin wrapper over echoRank so 3a behavior is unchanged (exactly one rank-1 node per
// note, rotating per note). Peers fall back to `[selfNode]` (solo → always the winner).
export function isEchoWinner(noteId, selfNode, accountPeers) {
  return echoRank(noteId, selfNode, accountPeers) === 1;
}
