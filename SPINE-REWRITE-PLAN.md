# egpt — True-Spine Rewrite Plan

> Branch `rewrite` in `C:\Users\an\src\egpt2`. The live nodes (REVE/DOLLY) keep
> running the old spine from `C:\Users\an\src\egpt` until cutover. Nothing here
> touches them. When done: park `main`, rename `rewrite` → `main`.

---

## 0. The one-sentence goal

> **egpt should be a simple loop that executes heartbeats and receives/sends
> messages through a brain.**

Everything below serves that sentence. The rewrite is **structural, not a feature
cull** — every current capability is kept (see §5). What changes is the *shape*:
one legible loop with explicitly-wired layers, instead of one 7,000-line closure.

---

## 1. Diagnosis — why it feels over-complicated (measured)

- `egpt-spine.mjs` is **8,960 lines**, and `startSpineRuntime()` alone is
  **~7,000 of them** (lines 1895–8843). The *entire* runtime — bridge wiring, bus
  handlers, every heartbeat tick, mesh relay, dispatch, slash handling — lives in
  **one closure**, glued by shared mutable refs (`waBridgeRef`, `setItems`,
  `sessions`, `meshRelayRef`, …). That closure-coupling is the complexity engine.
- **There is no loop to point at.** The "loop" is ~6 scattered `setInterval`s
  (alive heartbeat, the 5-min `tick`, play-rotate, room-save debounce, mesh
  timers) plus bridge callbacks. The user's mental model (one loop) is exactly
  what's missing.
- **50 slash-command files** + a console layer (`/e` steps 1–6) on top.
- The **extracted libs are fine and small** — `dispatch.mjs` 1.3k, `auto-mode.mjs`
  146, `mesh/relay.mjs` 392, `warm-sessions.mjs` 158, `transcript-log.mjs`,
  `conversations-state.mjs` 1.4k. The rot is concentrated in the god-closure and
  the feature sprawl it orchestrates, **not** in the modules. This is good news:
  most leaf modules can be **kept**; the win is replacing their orchestrator.

---

## 2. Target architecture — the true spine

Three things, sharply separated:

### 2a. The loop (the heart — a few hundred lines, `spine.mjs`)

```
boot():
  cfg      = loadConfig()
  ports    = wirePorts(cfg)          // Bridge, BrainPool, Store, Clock, Log
  services = wireServices(cfg, ports) // gating, transcript, mesh, media, heartbeats, shell
  bridge.onMessage(msg => queue.push(msg))
  every(cfg.tick): tick()
  drain queue forever: handleInbound(msg)

tick():
  heartbeats.runDue(now)             // due command/being heartbeats + accum flush
  // inbound is event-driven via the queue; tick is the time-driven half

handleInbound(msg):                  // the receive → brain → reply → send pipe
  ev   = identity.build(msg)         // classify + dispatch line (sender@[chat].node (HH:MM) #id)
  to   = router.resolve(ev)          // which being(s) / mesh target
  if !gating.mayReceive(to, ev): transcript.log(ev); return
  if  gating.isMeshTarget(to): return mesh.forward(ev, to)
  if !gating.mayReply(to, ev): transcript.log(ev); return            // mode + pause + mention
  reply = await brain.turn(to, ev)   // warm pool, streaming via sender
  sender.deliver(ev.chat, reply)     // stream-edit OR one-shot outbox
  transcript.log(ev, reply); store.recordThread(...)
```

That's the whole spine. If a reader can hold this in their head, we've won.

### 2b. Ports (interfaces the loop depends on — injected, never global)

```
Bridge   { onMessage(cb); onEdit(cb); onMedia(cb); send(chat, text); startStream(chat, init) -> {update, finish}; stop() }
Brain    { turn(being, prompt, onPartial, ctx) -> { text, sessionId } }   // warm pool hides behind this
Store    { contact ops, recordThread, readState/writeState }              // conversations-state
Clock    { now() }                                                        // testability
Log      { line(s), file(name, s) }
```

The loop knows only these. A **fake Bridge + fake Brain** makes the entire pipe
unit-testable with no network and no Claude process (this is how v1 is verified).

### 2c. Services (domain logic — each a narrow module, DI-wired at boot)

| Service | Module(s) today | Role |
|---|---|---|
| `gating` | `auto-mode.mjs` (keep ~as-is) | per-chat mode + pause + mention gate |
| `identity` | `dispatch-line.mjs`, `whatsapp-classify.mjs` | classify chat, build the dispatch line |
| `router` | `room*.mjs`, `mesh/names.mjs` | `@being` → local being / mesh target |
| `transcript` | `transcript-log.mjs`, `conversations-state.mjs` | "file is the conversation" |
| `brainpool` | `warm-sessions.mjs`, `warm-cli-session.mjs`, brains | warm/cold turn execution |
| `mesh` | `mesh/{relay,envelope,names}.mjs` | cross-node being relay |
| `media` | `incoming-media.mjs`, `transcription-pipeline.mjs`, `video-frames.mjs` | download/save + voice/video |
| `heartbeats` | (extract from spine) `heartbeats.mjs` | due-heartbeat scan + accum flush |
| `sender` | (extract) outbox + `egpt-comm-handler.mjs` | stream-edit / one-shot delivery |
| `shell` | `attach/*`, `nucleus.mjs`, `shell/ink-limb.mjs`, `slash/*` | UI surface + commands |

**The discipline that prevents re-drift:** every service is constructed with an
explicit dependency list (`createX({ bridge, store, log, ... })`) and returns a
small object. **No service reaches into another via a shared closure.** If two
services need to talk, the loop wires the call. This is the single rule that keeps
`spine.mjs` from regrowing into `startSpineRuntime()`.

---

## 3. The spine contract (preserve verbatim)

These are not negotiable — they're locked by `CONTRACTS.md` and the test suite:

1. **Every reply is logged** to `conversations/<surface>/<slug>/transcript.md`,
   surfaced or not (C1.2, C1.4).
2. **Every brain reply is gated** by per-chat mode; `paused` = absolute kill
   (C4.1–C4.5). `gating` runs *before* `brain.turn`.
3. **All media saved** per chat with meaningful filenames (C2.1–C2.2).
4. **Dispatch line is well-identified**: `Sender@[chat].{node} (HH:MM) #id: body`,
   node + UTC time (C7.6). Built **once**, consumed by all paths (C7.6e).
5. **Reactions/edits as stage-directions** — `[ Name … reacted 👍 to #id "…" ]`
   (C7.8).
6. **Scoped Bash only** for beings (`Bash(<bin>:*)`), no bare-Bash elevation.

The **message envelope** (what flows through the loop) is the carrier of all of
this — define it once, early:

```
InboundEvent {
  surface, node, chatId, chatName, senderId, senderName,
  msgId, ts, body, quoted?, kind: 'text'|'media'|'reaction'|'edit', raw
}
```

---

## 4. v1 scope (your choice: receive → brain → reply, **gated**)

v1 is "done" when, on a test chat:
- an inbound message is classified + dispatch-lined,
- gated by the per-chat mode (on/mention/mute/paused honored),
- routed through the **warm** brain pool to a streamed reply,
- delivered back (stream-edit), and
- transcript + state written.

Heartbeats run on the tick (accum flush + due per-conversation heartbeats). Mesh,
voice/media, and the shell/slash console are **layered in after v1** (§6 phase 4),
each behind its service interface — not part of the v1 core.

---

## 5. Keep vs rewrite (you kept all four subsystems)

**Keep, port nearly verbatim** (good small modules, contract-locked):
`auto-mode.mjs`, `dispatch-line.mjs`, `whatsapp-classify.mjs`, `transcript-log.mjs`,
`conversations-state.mjs`, `warm-sessions.mjs`, `warm-cli-session.mjs`,
`mesh/{relay,envelope,names}.mjs`, `incoming-media.mjs`, `transcription-pipeline.mjs`,
`config-schema.mjs`, `nucleus.mjs`, `attach/*`. The brains in `config/brains/*`.

**Rewrite** (this is the actual work):
- `egpt-spine.mjs` → split into `spine.mjs` (loop+boot) + the extracted services
  `sender.mjs`, `heartbeats.mjs`, `router.mjs`, `brainpool.mjs` (thin wrappers that
  expose the kept libs behind the §2 ports).
- The **inline slash dispatch / `/e` console** → a `commands` service with a
  registry (the 50 `slash/*.mjs` already export `meta`+`run`; wire them through a
  single dispatcher instead of the god-closure threading `ctx`).
- The **bus/outbox wiring** → fold into `sender` + `shell`; keep the outbox event
  shape (`{type:'wa-send', from, ts, jid, body}`) since DOLLY/tools depend on it.

**Fix on the way in:** the 2 failing integrity tests — `flood` and `persona_name`
read in the spine but absent from `CONFIG_SCHEMA`. Register `flood`; drop the dead
`?? EGPT_CONFIG.persona_name` fallback (`persona` is canonical).

---

## 6. Migration phases (goal-driven; each phase has a verify gate)

```
Phase 0 — Scaffold + inventory                → verify: plan reviewed; subtle-invariants list (§7) complete
Phase 1 — spine.mjs skeleton (loop+ports)     → verify: boots; fake Bridge+Brain round-trip a msg (unit test)
Phase 2 — real Bridge behind the port         → verify: live test chat echoes inbound→outbound (no brain)
Phase 3 — Brain pool + gating + transcript    → verify: gated receive→brain→reply→send live; transcript written  ← v1
Phase 4 — layer back the kept subsystems      → verify: each behind its service, suite green after each
          (4a voice/media · 4b mesh · 4c shell+slash console)
Phase 5 — parity + cutover                     → verify: full suite green; behavior diff vs old on test account; then cutover
```

Each phase keeps the **existing test suite as the oracle** (§9). A phase isn't
done until its verify gate is green.

---

## 7. Subtle invariants that MUST survive the rewrite (the hard-won behavior)

The biggest rewrite risk is silently losing battle-tested edge handling. Inventory
these and pin each to a test before deleting its old home:

- **Self-echo guard** — beings' own messages re-arriving (word-set fingerprint;
  normalizes before the word-bag; survived several reformat-bug fixes).
- **Self-edit suppression** in the bridge (`_ourStreamIds`) so our stream-edits
  don't re-surface as inbound.
- **Backlog hold** — messages older than `bridgeStart - holdGraceMs` are held and
  reviewed via `/wa-pending`, not auto-dispatched.
- **Bot↔bot loop prevention** — soft warning → hard auto-stop; `STOP/STOP ALL/RESUME`.
- **Baseline-on-first-sight for reactions** — reconnect re-syncs don't replay.
- **Outbox write-whitelist** — every `wa-send` gated by *chat*, never the `from` label.
- **Emitted-command allowlist** — a being may run only `e_commands` (default
  `["react"]`); unlisted are stripped+logged, never run/leaked.
- **Context-overflow backstop** — "Prompt is too long" is thrown (not returned);
  reset thread + retry once fresh; transcript is the durable record.
- **Warm-key identity guard** — evict+reopen when a different `sessionId` is
  requested (the `/e new` reset bug); key formats `e:ccode:<surface>:<slug>` and
  `sib:<name>:<session_id>` must match between pool/dispatch.
- **Markdown-link-tolerant matchers** (Beeper auto-linkifies `don.do`), used by
  send-id resolution and mesh `post_id`.

---

## 8. Cutover

1. Rewrite complete on `rewrite`, full suite green, behavior parity confirmed on a
   **test Beeper account** (not REVE/DOLLY).
2. `npm install` in `egpt2` (node_modules wasn't cloned).
3. Park old `main` (tag it, e.g. `pre-rewrite`), `git branch -m rewrite main`.
4. Point REVE at the new checkout, deploy (`/restart`); then DOLLY (`/upgrade`)
   once pushed. One node first, watch, then the second.

---

## 9. Testing / parity strategy

- The **97 test files / ~1119 tests** are the contract oracle. Behavior tests
  (auto-mode, dispatch-line, beeper-bridge, mesh-relay, integrity) lock the
  invariants — keep them green throughout.
- Tests that import spine internals get re-pointed at the new service modules;
  pure-lib tests (auto-mode, mesh, transcript-log) should pass **untouched** —
  treat any churn there as a smell that a kept module drifted.
- `integrity.test.mjs` will need its source path updated (`egpt-spine.mjs` →
  `spine.mjs` + services) but its *checks* (schema coverage, dispatch coverage,
  bridge-surface coverage) stay — they're how we prevent re-drift.
- New: a **pipe test** that runs `handleInbound` end-to-end against fake
  Bridge+Brain and asserts gating + transcript + delivery for each mode.

---

## 10. Durable design intent & working agreements (carried from the 10 deleted memories)

**North-star (the why):** egpt-mesh is *a federation protocol for situated AI
agents that rides existing consumer chat apps* (neighbors: Matrix, XMPP). The one
load-bearing value: **talk to AIs on different nodes** — reach *that* AI on *that*
machine (its files/GPU/model/person-context), zero-infra (behind NAT, no port to
open), in-channel (humans + AIs share rooms). Keep the mesh core **tiny/stable/
general**; apps (payments, audio, discovery) are *proofs the primitive is general*,
not a roadmap. Spec: `EGPT-MESH-PROTOCOL.md`.

**Mesh design notes:** a relayed reply is a *living mirror* (edit-stream one
message; origin mirrors each edit). Loop-safety is structural (forward-once per
`mid`). Wire tail is human-readable provenance (`by/from/to/re/post_id/mid/enc`).
2nd live hop needs a real **3rd computer** (2 nodes is degenerate).

**Config model:** each principal node is independent — **its own Beeper account**
(separate token in `config.local.json`). 3 essentials: `beeper_token`,
`whatsapp.chat_id` (self-DM room id), `whatsapp.allowed_users` (stable ids only,
never display names). Two nodes can't share one Beeper account.

**Compaction:** `/compact` is **intrinsic to Claude Code** — do NOT custom-code
summarize/reseed. Drive it headless as a **stream-json user message** (writes an
isCompactSummary boundary, compacts in place, same session id). The prompt-arg
form (`-p "/compact"`) is a no-op on the CLI.

**Working agreements (operator preferences — promote to `CLAUDE.md` if you want
them loaded every session):**
- **Fix config, don't bypass it.** When a configured mechanism fails live, fix or
  surface the config — don't re-architect to drop the dependency. Don't remove
  operator-relied-on configurability (same error class as *adding* unrequested
  config). Config comments/structure are the operator's design.
- **Keep config.yaml (and code) well-commented.** Comments encode structure and
  expose where config shape disagrees with how code reads it. Never strip for brevity.
- **No continuity log for egpt work.** Don't maintain/update/ask about the
  `notes-markdown` diary for this project (overrides the global `## Logging` rule).
- **Lifecycle:** NSSM service → `egpt-daemon.mjs` (supervisor) → spine. Supervisor
  owns in-band lifecycle (`/upgrade` = git pull+npm+build+respawn (exit 42);
  `/restart` = respawn from checkout (exit 43)). Deploy REVE via local outbox
  `/restart` (commit first — working tree ships); DOLLY via SMB-share outbox
  `/upgrade` (push first — it pulls). Outbox writes must be atomic temp→rename,
  UTF-8 no BOM.
- **DOLLY admin creds** exist (a local secrets file, not rotated) — intentionally
  kept out of version control; the operator holds the pointer privately.

---

## 11. Open decisions (resolve early in the new conversation)

1. **Slash console scope for the rewrite** — port all 50 commands, or start with a
   core set (`/e`, `/status`, `/help`, lifecycle) and migrate the long tail later?
2. **`spine.mjs` vs keep filename `egpt-spine.mjs`** — new clean name recommended
   (`spine.mjs`) so the diff is obviously a rewrite, with `egpt.mjs` launcher
   unchanged.
3. **Engine/surface split depth** — keep the attach server + Ink limb exactly, or
   simplify the surface registry while we're here?
4. **Heartbeats v2 method** — the operator said an auto-compact method is coming;
   leave `heartbeats` with a clean hook for it rather than re-add the removed
   in-spine 3-min compactor.

---

## 12. First steps for the new conversation (in `src/egpt2`, branch `rewrite`)

1. `npm install` (and confirm `npx vitest run` reproduces 1117 pass / 2 fail).
2. Lock §7 (subtle invariants) into a checklist — add a failing test for any that
   lack one *before* touching the spine.
3. Phase 1: write `spine.mjs` (boot + loop + the §2b port interfaces) + a fake
   Bridge/Brain unit test for `handleInbound`. Get the pipe green with stubs.
4. Then Phase 2 (real bridge) → Phase 3 (brain+gating = v1).

> Keep the loop legible. The rule that prevents re-drift: **services are wired by
> the loop with explicit dependencies; no service closes over another.** The day
> `spine.mjs` needs a shared mutable ref to make two features talk, stop and add a
> seam instead.
