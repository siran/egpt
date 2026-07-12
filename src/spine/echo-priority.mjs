// echo-priority.mjs — the 👂-echo STATIC PRIORITY rank (operator 2026-07-11, Phase 3b; replaces
// echo-hrw.mjs; plans/2607101713-HRW-ECHO-PLAN.md). NOT dedup.
//
// The problem: two co-account spines (REVE `kg`, DOLLY `do`) share ONE Beeper account, so BOTH see
// each voice note and BOTH would post its 👂 transcript → double-👂. This module makes exactly ONE of
// them post, with NO coordination and NO watch-and-cancel.
//
// Why NOT HRW (the deleted echo-hrw.mjs): rendezvous hashing picked the poster PER NOTE by hashing the
// note's Beeper message id, ASSUMING that id is IDENTICAL on both co-account nodes. It is NOT — Beeper
// message ids are NODE-LOCAL (REVE sees ~160700 for a note DOLLY sees as ~1382 in the same chat), so
// the two nodes hashed different strings, disagreed on the winner, and ~1/4 of notes had BOTH compute
// rank-1 → double-👂. The shared-id premise was false, so the whole per-note pick is dropped.
//
// The mechanism now is a STATIC PRIORITY order (config `echo_priority`, e.g. [do, kg]) listed
// IDENTICALLY in both configs and NOTE-INDEPENDENT: each node's rank is just its fixed 1-indexed
// position in that list. Rank 1 (the primary, e.g. DOLLY) posts EVERY note; a lower rank promotes only
// if the higher ranks stay OFFLINE/silent (the staggered timeout-failover lives in the bridge +
// incoming-media, NOT here — this module stays pure). Because the rank does not depend on the note,
// the two nodes can NEVER disagree on who is rank 1 — the divergence class HRW suffered is impossible.
//
// NOT-DEDUP INVARIANT (the operator's hard line): there is no act-then-suppress and no message
// exchanged. Each node knows its own fixed rank; the primary always posts, and a standby's promotion
// timer only covers an offline/slow primary (the observe-and-cancel lives in the bridge). Still not
// dedup: the rank is a deterministic UPFRONT pre-assignment.
//
// Pure + process-independent by construction: no Node imports, no Math.random, no Date — the rank is a
// plain array index, so two processes compute the identical order. Fully unit-testable
// (tests/echo-priority.test.mjs).

// This node's 1-INDEXED RANK in the STATIC echo priority order (Phase 3b ordered failover): 1 = the
// primary (posts every note now), 2 = first failover (posts only if rank-1 is silent), … There is NO
// noteId argument — that is the whole point: the rank is note-INDEPENDENT, so the order can't diverge
// across nodes the way HRW's per-note hash did. `priority` falls back to `[selfNode]` when empty/absent
// → a solo node is always rank 1 (the lone-node echo behavior). All lowercased so config casing never
// splits the order. 0 iff selfNode isn't in the priority list (defensive never-post sentinel —
// echo_priority is documented to include self; boot turns a rank-0 into a fatal so it can't happen
// silently).
export function echoRank(selfNode, priority) {
  const self = String(selfNode).toLowerCase();
  const order = (Array.isArray(priority) && priority.length ? priority : [selfNode])
    .map((p) => String(p).toLowerCase());
  const idx = order.indexOf(self);
  return idx < 0 ? 0 : idx + 1;
}
