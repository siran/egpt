# feat/sibling-reply — warm brains + safe sibling dispatch

Goal: make every brain (conversation-e, system-e, siblings) **responsive** by
removing the per-turn cold start, while keeping memory bounded and never letting
a brain dispatch wedge the spine.

## Architecture facts (load-bearing — do not re-derive wrong)
- **conversation-e is STRICTLY one thread per conversation.** Each has its own
  session, sandboxed to `~/.egpt/conversations/<surface>/<slug>/` (confined:
  read-only default tools + operator-granted dirs, see `conv-grants.mjs` +
  `claude-sdk.mjs` confinement). Verified live: cross-contact + `~/.egpt/config.yaml`
  reads are denied.
- **system-e = `@e` in Self** = the operator's OWN thread → unconfined, full
  permissions. The single trusted e-thread. (This is *why* per-conversation
  isolation matters: only Self gets `all`.)
- **siblings** (`@jay`, `@me`, `@l`, `@l2`, …) = named brains, full permission,
  resumed sessions. `@me`→`121ab` is the LIVE terminal (do not daemon-resume).

## Why it's slow today
Each turn cold-spawns `claude --resume <id>` (or a fresh SDK query): boot the
CLI/SDK, load the session JSONL, run the turn, exit. The startup tax is paid
**per message**. A live terminal is fast because it's a **persistent warm
process** — the prompt is just the next turn.

## Build (three parts)

### 1. Warm-session manager (`src/warm-sessions.mjs`)
- `Map<sessionKey, WarmSession>`; each holds an **open Agent-SDK query in
  streaming-input mode** — keep the prompt iterator open, feed successive user
  turns without re-spawning. First turn boots; every turn after is warm.
- Wire into `runDefaultBrainTurn` (conversation-e / system-e) and
  `runMetaBrainTurn` (siblings): get-or-create a warm session, push the turn,
  await the reply.
- **Warm policy = LAZY + IDLE-EVICT (operator 2026-06-10):**
  - Warm on first interaction; keep warm briefly for a likely **follow-up**;
    **evict on idle.** Never keep all conversation-e warm.
  - Per-class idle TTL (config): `system-e` long/persistent (operator's primary);
    per-contact `conversation-e` short (a follow-up window, then let go);
    siblings medium.
  - Hard `maxWarm` ceiling → LRU-evict beyond it. Memory bounded absolutely by
    `maxWarm`, NOT by total conversations.
- **Memory (measured on this box):** a warm Claude session ≈ 300–600 MB (Node +
  context; model is server-side). `maxWarm=6` ≈ ~2–3 GB worst case. Llama
  (`@l`/`@l2`) is the exception — warm = **local model weights resident (GBs)** →
  keep on-demand or on the worker-spine, NOT in this pool.

### 2. Live-session lock (kills the `@me`→`121ab` wedge)
- Per-session lockfile (e.g. `~/.egpt/state/session-locks/<id>.lock`). A live
  owner (terminal) holds it; the warm manager **refuses to resume a locked
  session** and replies "that one is live in a terminal — use `@jay`." A
  daemon-`resume` of a live claude session corrupts/hangs — this prevents it.

### 3. Dispatch timeout
- Wrap each brain turn: no first token within `dispatchTimeoutMs` → fail the turn
  (+ evict that warm session) so a hung/slow resume can **never** freeze the
  message-processing queue (heartbeat stays up but turns stall today).

## Config (proposed)
```yaml
brains:
  warm:
    max: 6                 # hard ceiling on concurrent warm sessions
    idle_ttl_ms: 180000    # default follow-up window before evict
    idle_ttl_by_class:     # overrides
      system: 0            # 0 = never idle-evict (persistent)
      conversation: 120000
      sibling: 300000
    dispatch_timeout_ms: 90000
```

## Status (2026-06-10, Wren)
BUILT + GREEN on this branch:
- **Part 1 — warm primitive** `claude-sdk.createWarmSession` (streaming-input,
  persistent). Live-verified (spike): 2 turns / 1 query, context retained.
- **Part 1 — warm pool** `src/warm-sessions.mjs` (lazy, per-class idle-evict,
  maxWarm LRU, per-key serialize). 8 vitest cases green.
- **Part 2 — live-terminal guard** in `runMetaBrainTurn` (+ `live_terminal:true`
  on wren). @me/@wren refused a daemon resume → no more wedge.
- **Part 3 — dispatch timeout** folded into the pool (fail + evict, never wedge).

REMAINING — the WIRING (the hot path, do it fresh + with a live regression):
1. Instantiate the pool in egpt.mjs from `EGPT_CONFIG.brains.warm`.
2. Route **siblings** (`runMetaBrainTurn`) through the pool for claude-sdk brains;
   **switch siblings to `type: claude-sdk`** (jay is claude-code/CLI today — that
   subprocess spawn is the main lag). Key = sibling name, klass=sibling.
3. Route **conversation-e / system-e** (`runDefaultBrainTurn` → dispatch.mjs)
   through the pool. Key = chatId/slug (per-conversation!), klass=conversation;
   Self = klass=system. THIS TOUCHES THE LIVE @e PATH — regression-test @e first.
4. Live: `@jay` warm + snappy; confirm claude-sdk resumes `825b`; @e unbroken.

## Test gate
Repo has a pre-push hook running the suite. Add unit tests: warm reuse (no
re-spawn on 2nd turn), idle eviction frees the session, maxWarm LRU, lock refusal,
timeout fails-and-evicts.
