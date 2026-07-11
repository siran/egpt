# Phase 3: HRW 👂 echo (operator 2026-07-10)

## Problem
The per-node `echo` gate was removed, so BOTH co-account spines (REVE `kg`, DOLLY `do`)
post a voice note's 👂 transcript → **double-👂**. We need exactly ONE node to echo each
note — without a watch-and-cancel dedup.

## Design — HRW (rendezvous hashing), NOT dedup
Each node computes, PER NOTE, whether IT is the one to post — deterministic pre-assignment,
no act-then-cancel:
- `weight(node, note) = hash(note_id + node_name)`; the MAX-weight node is rank-1 → it posts.
- Both nodes hash the SAME `note_id` over the SAME candidate set → they independently agree
  on the winner. NO coordination, no messages exchanged.
- Coordination-free correctness rests on two things being IDENTICAL across nodes:
  1. **note_id** = the voice note's Beeper message id — identical on both (ONE shared Beeper
     account → the same message → the same id).
  2. **candidate set** = `account_peers` (config `account_peers: [kg, do]`, identical on both
     nodes — verified).

## Candidate set
= `account_peers` (the co-account eGPT nodes; co-account nodes collapse to ONE Beeper room
member, which is why config lists them). Current 2-node/one-account setup → `{kg, do}`. A solo
node (empty/absent `account_peers`) → `[node_name]` → always the winner (always echoes, current
behavior for a lone node). Cross-account eGPT nodes sharing a room are OUT of scope for now
(different accounts → different message ids, can't coordinate) — a future extension.

## Phase 3a — deterministic PICK  ← THIS BUILD
Replace the static per-node echo decision with the HRW pick:
- **New pure module** (`src/spine/echo-hrw.mjs`, or a mesh util — implementer's call):
  `hrwWinner(key, candidates)` (rendezvous hash over candidates, deterministic string tie-break)
  + `isEchoWinner(noteId, selfNode, accountPeers)` = `hrwWinner(noteId, peers) === selfNode`,
  where `peers = accountPeers?.length ? accountPeers : [selfNode]`.
- **boot.mjs**: build `peers` from `cfg.account_peers` (fallback `[node_name]`); pass an
  `echoDecider(noteId) => isEchoWinner(noteId, node_name, peers)` into the bridge, REPLACING the
  static `echo` boolean in the 👂-post decision. Keep `echo_max_age_ms` (orthogonal age bound).
- **bridge (src/bridges/beeper.mjs + src/incoming-media.mjs)**: post the 👂 for a note IFF
  `echoDecider(noteId)` is true — AND the existing `postsBack` + `echo_max_age_ms` gates still
  apply. A NON-winner still transcribes + logs (the transcript reaches the model) — it only
  skips the in-chat 👂 POST. `noteId` = the voice note's stable Beeper message id.
- Result: exactly ONE node echoes each note; the echoer ROTATES per note (the hash spreads
  across note ids), so neither node is the fixed echoer.

## Phase 3b — timeout-promotion (ordered failover)  ← BUILD (operator 2026-07-11)
Covers an OFFLINE (or silent) rank-1: a lower-ranked node posts the 👂 so the echo isn't dropped
when the picked node is down. Ordered failover — still exactly ONE node posts.

Mechanism:
- **Rank, don't just pick.** `hrwRanked(key, candidates)` → the candidates sorted by DESCENDING
  weight (deterministic; identical on every node). This node's rank `R` = its 1-indexed position
  over `account_peers` (self included). `isEchoWinner` becomes `rank === 1`.
- **Every node still transcribes + logs** each note (unchanged from 3a — the transcript always
  reaches the model/log; only the POST is gated).
- **rank-1 posts** the 👂 normally (after `posts_back_delay_ms`).
- **R>1 arms a PROMOTION TIMER** instead of silently dropping the post (3a's behavior): once its
  own transcript is ready, it schedules a post at `(R-1) * echo_timeout_ms` and WATCHES for the
  note's 👂 to appear. If the 👂 is observed before the timer → CANCEL (a higher rank posted,
  stand down). If the timer fires unobserved → POST the (already-transcribed) 👂 (promote).
- **Staggered by rank** so failover is ordered: rank-2 fires at `+T`, rank-3 at `+2T`, … When
  rank-2 posts, rank-3 observes it before its `+2T` and cancels → exactly one posts even if
  several top ranks are down.
- **Observation = correlate by reply-to id.** rank-1's 👂 is a quoted reply (`replyToMessageID =
  note.id`); a co-account peer sees that post as a normal inbound. So a waiter keeps a per-note
  pending map (note.id → {rank, timer}) and CANCELS when an inbound arrives that (a) replies to a
  pending note.id AND (b) is a 👂 (starts with the echo marker). Unrelated inbound → no cancel.

Timing knobs + the one real hazard:
- `posts_back_delay_ms` (rank-1's post timing; 0 = immediate) and `echo_timeout_ms` (the per-rank
  promotion step). Both tunable per node.
- HAZARD (false-positive promotion): rank-2 can't tell "rank-1 DOWN" from "rank-1 SLOW." If
  `echo_timeout_ms` is shorter than rank-1's worst-case transcribe+post+network latency, rank-2
  pre-empts and you get a DOUBLE 👂. So default `echo_timeout_ms` GENEROUS (start ~20s) and TUNE
  from live tests (operator: "increase posts_back_delay if necessary, then adjust"; "test taking
  down any spine, or both, and see the reaction"). Too-long = slow failover; too-short = double.

## Tests (reproduce-first)
- `hrwWinner`: deterministic (same key + candidates → same winner regardless of caller order);
  rotates across keys (roughly balanced over many note ids); stable tie-break.
- `isEchoWinner`: solo (`[self]` / empty peers) → always true; 2-node → exactly one peer true
  for a given note, the OTHER false for the SAME note.
- bridge: posts the 👂 only when `echoDecider` true; a non-winner transcribes + logs but does
  NOT post; `echo_max_age_ms` + `postsBack` still gate independently.
- Double-👂 reproduction lock: peers `[kg, do]` + a note id → exactly ONE of `kg`/`do` echoes.

## Not-dedup invariant (the operator's hard line)
No watch-and-cancel, no act-then-suppress. Each node decides UPFRONT whether it's the one. The
only "coordination" is the shared `note_id` + shared `account_peers` making the deterministic
pick agree. (3b's timeout-promotion is failover for an offline winner, still not dedup.)
