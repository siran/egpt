// echo-priority.mjs — the 👂-echo WINNER-SELECTION rank, REAL HRW (rendezvous hashing) keyed on a
// NODE-STABLE audio-content hash (operator 2026-07-24; revives HRW, replaces the static-priority
// stopgap; plans/2607101713-HRW-ECHO-PLAN.md, plans/260722-COMMAND-SURFACE-REVIVAL.md). NOT dedup.
//
// The problem: two co-account spines (REVE `kg`, DOLLY `do`) share ONE Beeper account, so BOTH see
// each voice note and BOTH would post its 👂 transcript → double-👂. This module makes exactly ONE of
// them post, per note, with NO coordination and NO watch-and-cancel: each node computes the SAME HRW
// ordering of the co-account peers for the note and reads off its own 1-indexed rank. Rank 1 posts
// immediately; a lower rank arms an ordered-failover promotion (the staggered timeout-failover lives
// in the bridge + incoming-media, NOT here — this module stays pure).
//
// Why HRW was REMOVED before, and why THIS revival is safe: the deleted echo-hrw.mjs hashed the note's
// Beeper MESSAGE ID, assuming that id is identical on both co-account nodes. It is NOT — Beeper message
// ids are NODE-LOCAL (REVE sees ~160700 for a note DOLLY sees as ~1382 in the same chat), so the two
// nodes hashed DIFFERENT strings, disagreed on the winner, and ~1/4 of notes had both compute rank-1 →
// double-👂. The static-priority stopgap that replaced it fixed correctness but gave up per-note
// rotation. We now revive HRW keyed on the sha256 of the DOWNLOADED VOICE-NOTE AUDIO BYTES: the media
// is byte-identical on both nodes (same Beeper attachment), so the key is truly node-stable regardless
// of transcription engine or id semantics. The bridge computes that hash and passes it as `noteKey`
// (crypto lives in the bridge, NEVER here). Do NOT key on the transcript text (whisper engines can
// differ) and do NOT key on msg.id (node-local).
//
// NOT-DEDUP INVARIANT (the operator's hard line): there is no act-then-suppress and no message
// exchanged. Each node knows its own HRW rank for the note; the winner posts, and a standby's promotion
// timer only covers an offline/slow winner (the observe-and-cancel lives in the bridge). Still not
// dedup: the rank is a deterministic UPFRONT pre-assignment, now per note instead of static.
//
// Pure + process-independent by construction: the hash is an INLINE FNV-1a (no node:crypto, no
// Math.random, no Date), so two processes compute the identical ordering. Fully unit-testable
// (tests/echo-priority.test.mjs). The peer order in `peers` is the deterministic COLLISION TIEBREAK
// (earlier = higher), so the HRW winner is otherwise independent of how the list is ordered.

// FNV-1a 32-bit — a pure, deterministic string hash (offset 2166136261, prime 16777619). Math.imul
// gives the 32-bit multiply; `>>> 0` yields an unsigned 32-bit score. Same result in every process, so
// both co-account nodes score each peer identically for a given noteKey.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// This node's 1-INDEXED RANK in the HRW (rendezvous) ordering of `peers` for `noteKey`: 1 = the winner
// (posts this note's 👂 now), 2 = first failover (posts only if rank-1 stays silent), … The rank is
// PER-NOTE — reshuffled by noteKey — so the echoer rotates across co-account nodes note by note, yet
// both nodes AGREE because noteKey (the sha256 of the audio bytes) is node-stable. Score each peer by
// fnv1a(peer + '\0' + noteKey); sort by score DESC; break ties by the peer's index in `peers` (earlier
// = higher rank, so peer_priority order is the deterministic tiebreak). `peers` falls back to
// `[selfNode]` when empty/absent → a solo node is always rank 1 (the lone-node echo behavior). All
// lowercased so config casing never splits the order. Returns 0 iff selfNode isn't in `peers`
// (defensive never-post sentinel — peer_priority is documented to include self; boot turns a rank-0
// into a fatal so it can't happen silently).
export function echoRank(selfNode, peers, noteKey) {
  const self = String(selfNode).toLowerCase();
  const order = (Array.isArray(peers) && peers.length ? peers : [selfNode])
    .map((p) => String(p).toLowerCase());
  if (!order.includes(self)) return 0;
  const key = noteKey == null ? '' : String(noteKey);
  const scored = order.map((peer, index) => ({ peer, index, score: fnv1a(`${peer}\0${key}`) }));
  // Higher score wins; ties fall to the earlier peer index (peer_priority order).
  scored.sort((a, b) => (a.score < b.score ? 1 : a.score > b.score ? -1 : a.index - b.index));
  return 1 + scored.findIndex((s) => s.peer === self);
}
