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

## Phase 3b — timeout-promotion  ← FAST-FOLLOW, NOT this build
Covers an OFFLINE rank-1: if no 👂 for a note appears within `echo_timeout_ms`, rank-2 posts.
Needs the node to OBSERVE whether rank-1's 👂 appeared — a co-account peer's post arrives at the
other node as a normal inbound (not self-suppressed), so it's visible; rank-2 watches for the
transcript reply to the note, stands down if seen, posts if not by the timeout. This is the
subtle part; deferred to its own chunk.

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
