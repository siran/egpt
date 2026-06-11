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

## HANDOFF (2026-06-11, Wren → next agent) — READ THIS FIRST

**What we're doing:** make every brain (conversation-e, system-e, siblings)
RESPONSIVE by reusing a warm persistent SDK session instead of a cold per-turn
start. Plus two safety guards (live-terminal, timeout). Parts 1/2/3 are built +
green; the *wiring* is in progress and has two bugs — one fixed, one open.

**State of the daemon:** running on this branch `feat/sibling-reply` (the daemon
runs the working-tree checkout — a plain restart picks up edits; do NOT `/upgrade`
or it jumps to main). Config: `jay.type: claude-sdk` (warmable), `wren.live_terminal: true`.

**Restart + test loop:**
- Restart (elevated): `sc stop egpt-daemon; taskkill /F /T /IM egpt-service.exe; sc start egpt-daemon` (UAC).
- Trace file: `~/.egpt/logs/warm-trace.log` (BROADCAST/dispatch/WARM-TURN + POOL lines). headless.log is useless frame-dumps — use the trace.
- Test: from mobile send `@jay uno` then `@jay dos` (no restart between).

**FIXED — double @jay reply:** the meta path (egpt.mjs ~7880) skips its fallback
send only when the stream handle reports `delivered`. The Beeper limb's
`startStreamMessage` had a *local-only* `delivered`, so the fallback always fired
→ every sibling reply sent twice. Fixed: the handle now exposes `delivered` +
`lastError` (src/bridges/beeper.mjs). NOTE: whatsapp-cdp.mjs has the SAME shim
bug — fix it identically before CDP is used for siblings.

**OPEN — warm session not reused (still cold/slow each turn).** Trace signature:
every `@jay` turn logs `WARM-TURN ... warm=false` then `POOL warm: opened ...
size=1/6`, and there is **NO `POOL ... evicted` line**. So the pool entry is
gone by the next turn without _evict being called. Two hypotheses to chase:
  1. **The SDK streaming-input query ENDS after one `result`** (so the warm
     primitive is single-use). The fresh-session spike worked across 2 turns
     ONLY because they were back-to-back; with an 8s gap (real messages) the
     query may close. Verify by instrumenting createWarmSession's reader loop:
     does `for await (const m of q)` exit after the first result? If so, the
     fix is to keep the query genuinely open (the input generator must keep
     awaiting; confirm the SDK doesn't auto-close on idle, or use
     `q.streamInput()` / `pushPrompt()` instead of the async-generator prompt).
  2. **The pool singleton (`_warmPool()`/`_warmPoolInstance` in egpt.mjs) isn't
     persisting across dispatches.** Less likely (module-scope let), but the
     "no evict + has=false" pattern could mean a new/empty pool each turn.
     Verify: log the pool object identity at run().
  Resolve #1 first — it's the most likely (warm primitive single-use).

**ALSO confirmed:** claude-sdk DOES resume the CLI-created `825b` in the daemon
(jay replies with context, e.g. it counted uno→dos→tres). The earlier
"failed to launch" was an MSYS2-dev-shell false-negative ONLY.

**STILL TODO (the bigger win):** wire conversation-e/system-e through the pool in
`runDefaultBrainTurn` → dispatch.mjs (per-conversation key = chatId/slug,
klass=conversation; Self=system). HOT @e PATH — regression-test @e first. @e
already uses claude-sdk + SDK sessions, so no CLI-resume issue there.

**OPERATOR REQUEST:** `@e` should move to **codex-mini** (`default_brain.type:
codex`, model codex-mini). Arrange that (config + verify the codex brain resumes).

**CLEANUP before merge:** remove the debug traces (the `appendFileSync(... warm-trace.log ...)`
lines in egpt.mjs at the resident loop + the warm branch, and the file-route in
the `_warmPool()` onLog). Then squash-review the branch and PR → main.

## Test gate
Repo has a pre-push hook running the suite. Add unit tests: warm reuse (no
re-spawn on 2nd turn), idle eviction frees the session, maxWarm LRU, lock refusal,
timeout fails-and-evicts.
