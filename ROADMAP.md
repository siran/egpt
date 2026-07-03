# ROADMAP — v2 state + what's next

> Written 2026-07-02 (session: the big feature push). Purpose: survive context
> compaction — everything decided-but-not-yet-done lives HERE, not in a chat
> buffer. Update this file as items land; delete sections that ship.
> Companion: SPINE-REWRITE-PLAN.md (the architecture + phase plan, mostly done).

## 0. HANDOFF (written 2026-07-02 ~21:30, for the next conversation — read this first)

**In flight: CONFIG LEGACY EXCISION.** Operator directive: the code must ONLY
accept the new config — no legacy fallbacks, no boot migrations, no dual-reads.
The complete spec is **CONFIG-LEGACY-EXCISION.md** (inventory groups A–K with
file:line + which tests lock each behavior, PLUS the "Operator vocabulary"
section that amends them — notably: `agents.<name>.configuration:` REPLACES
`.type` as the registry key; `transcription_service` is canonical;
per-network `user_name` override is KEPT; no `agents` block = fatal boot).
The operator's own 2026-07-02 20:32 edit of ~/.egpt2/config/config.yaml IS the
vocabulary spec — read that file, don't infer.

**CRITICAL — working-tree state:** a background Opus agent was dispatched from
the previous session (~21:00) to implement the spec. Its changes land
UNCOMMITTED in this working tree; the old session will NOT commit anything
further (doc commits only). Before doing anything: `git status` + `git log
--oneline -3`. If the tree has excision-shaped src/test changes: review against
the spec, run `npx vitest run` (two known flakes under full-suite contention:
tests/transcriptor.test.mjs, tests/beeper-bridge.test.mjs "newest isSender
match" — both pass in isolation), then commit+push. If the tree is clean and no
excision commit exists, the agent died — re-dispatch per the spec doc. The old
session may append the agent's completion report to the END of
CONFIG-LEGACY-EXCISION.md (uncommitted) — check there for its test results.
NEVER /restart the node with uncommitted edits (the daemon boots this checkout).

**After the excision lands (port step, §CONFIG-LEGacy doc step 3-4):** delete
`~/.egpt2/conversations.yaml.bak` (stale); the 4 stray `threadCwd:` keys in
~/.egpt2/conversations.yaml purge themselves on the next registry write once
`_SLIM_DROP` includes threadCwd. Then restart via ingest (below) and verify:
`state/alive.txt` mtime advances, `/status` in the egpt-an chat.

**Next feature after that: the /e wizard (v1 parity) — see §3 first entry.**
Operator (2026-07-02): `/e` and `/e <slug>` must invoke a WIZARD like v1 —
explicitly NOT a flag-style command (`/e model <target>` was proposed and
rejected as a hallucination). Reuse `src/agent-wizard.mjs` (live module);
v1's wiring shape is in egpt-spine.mjs (`armAgentWizard`, `_maybeHandleWizard`,
5-min TTL, wizard gets first refusal on operator input). Do not invent UX —
when in doubt, check how v1 did it and ask.

**The ingest/ feature (how agents drive the live node — verified 2026-07-02):**
`src/spine/ingest.mjs`, wired in `src/spine/boot.mjs:366-379`. The node sweeps
`~/.egpt2/ingest/` every 1s; a dropped file's CONTENT is the command line; the
file is consumed (deleted) once read; dotfiles and `*.tmp` are skipped, so
write atomically (write `x.tmp`, rename to `x`). Handled commands map to daemon
respawn exit codes: `/restart` → 43 (respawn current checkout), `/upgrade` → 42
(git pull + npm + build, respawn), `/rewind <ref>` → 44. Anything else is
logged "ignored" — ingest is lifecycle-only today.

**Live node right now:** service `egpt2-daemon` alive (beat = alive.txt mtime),
spine pid 10044, up since 2026-07-02 19:23. Profile ~/.egpt2 is ALREADY
new-shape (operator-styled config.yaml, slim conversations.yaml,
config/agents/{egpt,default,sonnet-high}.yaml). Working agreements: §5 below.
Operator flagged repeated hallucination this session — verify in code before
asserting; v1 (egpt-spine.mjs) is the precedent for operator UX.

## 1. Where we are

Branch `rewrite`, suite ~1403 tests / 0 fail. The node runs live as the
`egpt2-daemon` service, profile `~/.egpt2`, from this working tree. All of the
following is LANDED, test-locked, and (where marked) live-verified:

- Core pipe (receive → gate → brain → stream-reply → send), gating modes
  (accum retired), reply train (persona line, ∎, no nonce), flood guard — live-verified
- Voice chain + per-conversation transcription policy; media per origin surface;
  video Route A
- Contacts: slug-follows-name + folder move + renames.log (one shared resolver)
- Brains/agent-types: layered registry (src/brains ← config/brains ← config/agents ← conv)
- Auto-compaction (native /compact, 20%, 2-min cooling)
- Heartbeats: declarative (config + every conversation/room config.yaml),
  `frequency:` + `when:` one-shots (default_time_zone-aware), `command:` +
  `ai_run:` (textecutables), hot reload = DELETE state/heartbeats.readonly.yaml
  (staleness check rides runDue — no reload heartbeat), alive beat =
  `echo beat > state/alive.txt`, liveness = file MTIME, pid in state/spine.pid
- Daemon: mtime deadman, calm wedge backoff, singleton via spine.pid — live-verified
- Warm: conversation = background agent for 15m after last message (default),
  `warm.max` keeps N warm, per-conversation override `warm: { idle_ttl }` in the
  conv folder's config.yaml (0 = always warm)
- Per-surface auth: whatsapp/telegram/signal each own {chat_id, allowed_users};
  empty = deny; isSender = owner's global pass
- Siblings: @name routes to local beings, nested per-being thread persistence
- Mesh (Phase 4b): @being.node + relay agents; envelopes detected before gating;
  living mirror into the origin placeholder; forward-once per mid + service hop
  cap; `config.mesh.nodes` routes + route-direct via agents.relay_channel.
  UNIT-LOCKED ONLY — live 2-node smoke needs DOLLY awake.
- Agents registry: `agents: { <name>: { type, handles, relay_channel? } }` —
  ONE block for persona + local beings + relay targets; type files in the
  PROFILE's config/agents/; skeletons seed to ~/.egpt2/config/skeletons
  (copy-if-missing, operator edits sacred)
- Textecutables: `*.x.md` = plain-text script, one fresh claude turn executes it
  (CLI / heartbeat `ai_run:` / ask E — NO /x command, ever)
- Commands: /restart /upgrade /rewind, /e auto <mode> [target], /status (fenced yaml)
- Anti-drift: integrity tests scan v2 config reads; skeleton can't-rot tests

## 2. In flight right now

- **CONFIG LEGACY EXCISION — new-config-only** (operator 2026-07-02: "only
  accept the new config, port it, no legacy nothing"). Inventory DONE, spec +
  execution plan live in **CONFIG-LEGACY-EXCISION.md** (groups A–K: default_brain,
  readonly.brain back-read, boot migrations, siblings/persona fallbacks, legacy
  config locations, personality/threadCwd residue, config/brains layer, schema
  legacy keys, old-spine integrity-scan retirement). Implementation NOT yet
  dispatched — session hit the Fable limit right after the inventory. NEXT
  SESSION: read that doc, dispatch one background Opus agent per its plan.
  Live profile ~/.egpt2 is ALREADY ported (agents-first config, slim
  conversations.yaml) — only residue: 4 stray threadCwd keys + a stale
  conversations.yaml.bak (plan step 3).
  Landed precursor: agents-first config migration ran live; `default_brain`
  removed from live config; `user_name` top-level; readonly.agent everywhere.

## 3. Decided, not yet dispatched

- **/e wizard — v1 parity** (operator 2026-07-02): `/e` (bare, current chat) and
  `/e <slug>` (target chat, resolved like /e auto's target) INVOKE THE WIZARD,
  like v1. NOT a flag-style command (`/e model <target>` was proposed and
  REJECTED — operator: v1's wizard is the UX). Reuse `src/agent-wizard.mjs`
  (live, renderer-neutral state machine: numbered picks, b back / x cancel;
  v1 armed it per chat with a 5-min TTL and gave it first refusal on operator
  messages — see egpt-spine.mjs `_maybeHandleWizard`/`armAgentWizard` for the
  wiring shape). Steps adapt to v2 vocabulary: agent-type pick from
  config/agents/*.yaml, model, effort (per-conversation personality/identity is
  retired — it's the agent type's). On done: write the conversation's readonly
  block + evict/respawn its warm proc so the change takes effect without a full
  /restart. Dispatch AFTER the config-legacy-excision agent lands (same files).

- **conversations.yaml reshape — DONE** (operator 2026-07-02): the registry is SLIM
  now. Each contact entry's `pushedName` rides as the jid-key INLINE COMMENT (not a
  data key); `slug` is dropped (derived from `conversation_path`'s basename); the
  lifecycle timestamps (firstSeenAt/threadCreatedAt/identityInjectedAt) MOVED into the
  conversation's own `stats.yaml`. Each entry stores `home_dir` (msys-style user home)
  + a home-relative `conversation_path` (`<profile>/conversations/<surface>/<slug>`) so a
  conversation is individually relocatable (resolution still runs through EGPT_HOME/
  slugDir — the pointer is self-describing, not the resolver). `readonly` snapshots are
  DETERMINISTIC (concrete model/effort, never null — falls back to sonnet/high). The
  one-pass boot migration (`migrateConversationVocabulary`) does the whole conversion +
  writes stats.yaml, idempotently. parse/serialize round-trip the comment shape (yaml
  Document API); in-memory state shape is UNCHANGED so every consumer keeps working.

- **Stats module + `/status <target>`** (operator 2026-07-02): `stats.yaml` now EXISTS
  in each conversation folder (spine-written), created by the reshape migration and
  appended by the brainpool on every new thread id (branchable `threads:` history):
  ```yaml
  # stats.yaml — the conversation's stats module (spine-written)
  name: <pushedName>
  first_seen: <iso>
  threads:
    - id: <threadId>
      created: <iso>
      identity_injected: <iso>
  ```
  Builds on this: a `stats` service the loop notifies after transcript.log(ev) —
  in-memory per-conversation counters (messages per sender, member first/last-seen =
  member history, devices when the payload carries them), debounced flush INTO this same
  stats.yaml (merge, never clobber — `mergeStats`/`appendThreadStat` already do this).
  Slow facts (admin permissions, bio, participant list) fetched from Beeper ON DEMAND,
  not tracked per message. `/status <name-fragment|id>` resolves like /e auto's target
  and replies fenced yaml: name/surface/slug, mode, instanced agent, members + counts +
  last-seen, that folder's heartbeats, media count, live participants/admins when the API
  exposes them. Existing pure libs to reuse: conversation-stats.mjs (file-derived render),
  conversation-members.mjs (roster). Name history = renames.log (done).

- **CUTOVER — main becomes v2** (held for operator "go" AFTER re-inspection):
  ```
  git tag pre-rewrite origin/main && git push origin pre-rewrite
  git push origin rewrite:main          # fast-forward, no force
  git branch -D main && git branch -m rewrite main
  git branch -u origin/main main        # /upgrade's git pull keeps working
  ```
  Keep origin/rewrite for a few days. Old-spine deletion (egpt-spine.mjs,
  dispatch.mjs, slash/, attic) is a SEPARATE commit after cutover soak — the
  integrity tests that scan egpt-spine.mjs get retired with it.

- **Live mesh smoke**: needs DOLLY (2nd node). Config: mesh.nodes routes or an
  agents relay entry pointing at a shared chat. Unit tests cover the machinery.

- **Chrome/CDP textecutable test** (operator-driven, everything ready): copy
  ~/.egpt2/config/skeletons/{script.x.md, heartbeats block} into a chat folder,
  set `when:` a few minutes out, delete state/heartbeats.readonly.yaml, watch.
  Note: CDP attaches only to a Chrome started with --remote-debugging-port
  (chrome-launcher.mjs starts a visible one; the daily browser needs the flag).

## 4. Backlog (known warts, smallest last)

- Test flakes under full-suite port/timing contention: tests/transcriptor.test.mjs,
  tests/beeper-bridge.test.mjs "newest isSender match" (real retry timers).
  Both pass in isolation. Fix: fake timers / serialize the port-binding tests.
- Node-level `heartbeats:` config block is boot-cached — hot reload re-reads
  entity folders but NOT config.yaml (needs /restart). Offered to make the
  loader re-read config on reload; operator hasn't ruled.
- spine.stats() counts the WAITING queue only — a lone hung turn shows q=0
  (visible only once backlog accumulates). Two-line fix if ever wanted.
- warm-cli: a claude proc that exits cleanly between turns respawns from
  creation-time options (loses --resume; sessionId getter goes stale).
- Double context-overflow (retry also overflows) would surface the error string.
- Reactions/edits bypass the whatsapp.networks scope gate (moot at default []).
- Eventual: move the profile ~/.egpt2 → ~/.egpt ("main" profile);
  install/setup docs after testing an install on another computer.

## 5. Operational facts (for any future session)

- Node: Windows service `egpt2-daemon` → egpt-daemon.mjs → spawns `node egpt.mjs`
  from THIS working tree (a /restart boots whatever is checked out — never
  restart with uncommitted edits in flight).
- Profile: EGPT_HOME=~/.egpt2. Config: ~/.egpt2/config/config.yaml (canonical;
  root config.yaml is the legacy location). Old production (egpt-daemon service,
  ~/.egpt, C:\Users\an\src\egpt) is STOPPED — both ride the same local Beeper
  Desktop (127.0.0.1:23373), so running both double-answers every @e.
- Restart: drop a file containing `/restart` into ~/.egpt2/ingest/ (temp→rename).
  Hot-reload heartbeats: delete ~/.egpt2/state/heartbeats.readonly.yaml.
- Live self-testing: the egpt-an chat is operator-authorized for agent testing
  (pace sends ≥8s, small counts; each @e is a real claude turn; /status is free).
- Working agreements: operator = An; all implementation via background Opus
  agents (Fable orchestrates/reviews/commits); descriptive commits, no AI
  attribution; no continuity-diary logging for egpt work; commit+push without
  asking when work is done; comments carry the WHY (operator-dated decisions).
