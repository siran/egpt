# ROADMAP — v2 state + what's next

> Written 2026-07-02 (session: the big feature push). Purpose: survive context
> compaction — everything decided-but-not-yet-done lives HERE, not in a chat
> buffer. Update this file as items land; delete sections that ship.
> Companion: SPINE-REWRITE-PLAN.md (the architecture + phase plan, mostly done).

## 1. Where we are

Branch `rewrite`, suite ~1403 tests / 0 fail. The node runs live as the
`egpt2-daemon` service, profile `~/.egpt2`, from this working tree. All of the
following is LANDED, test-locked, and (where marked) live-verified:

- Core pipe (receive → gate → brain → stream-reply → send), gating modes
  (accum retired), reply train (persona line, ∎, no nonce), flood guard — live-verified
- Voice chain + per-conversation transcription policy; media per origin surface;
  video Route A
- Contacts: slug-follows-name + folder move + renames.log (one shared resolver)
- Brains/agent-types: layered registry (src/brains ← config/agents ← conv)
- **CONFIG LEGACY EXCISION landed (85a824e, 2026-07-02/03)** — the code accepts
  ONLY the new config: `agents.<name>.configuration` (not `.type`), fatal boot
  without an agents block / persona entry, no default_brain, no readonly.brain
  or personality back-reads, no boot migrations, config strictly at
  EGPT_HOME/config/config.yaml + config/agents/, transcription_service
  canonical, threadCwd retired (_SLIM_DROP purges strays). 28 files,
  +429/−1149, suite 122 files / 1296 tests green.
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
- **/e wizard landed** — bare `/e` (this chat) / `/e <fragment>` (target resolved like
  /e auto's) ARM a guided re-point: agent type → model → effort (v1 parity, NOT a flag
  command). Operator-only, 5-min TTL, b/back · x/cancel; while armed the operator's plain
  picks get first refusal (never fall through to E), a slash command bypasses WITHOUT
  cancelling (v1). On done: freezes the conversation's `readonly` (keeps threadId — context
  survives) + evicts its warm session (respawns next turn, no /restart). Reuses
  src/agent-wizard.mjs (steps re-vocabularied: `configuration` pick from config/agents +
  src/brains, current marked); ONE chokepoint in src/spine/commands.mjs isCommand/run.
  - **/e wizard custom + yaml-view (operator 2026-07-03)** — step 1 renders each type's
    COMPOSITION inline (model/effort/personality via brains.resolve, structured-yaml); a
    final `custom` option BUILDS a new agent type (model → effort → personality → name,
    named last, collision re-prompts) and authors config/agents/<name>.yaml (+ a free-text
    identity layer in identities/<name>/) then applies it like an existing pick. Personality
    picks = identity layers (profile ∪ repo, listIdentityLayers) + free text; 10 preset
    layers (secretary/psychologist/detective/poet/writer/spiritual-advisor/financial-advisor/
    philosopher/logicist/one-two-many) seeded copy-if-missing (src/spine/seed.mjs PRESET_IDENTITIES).
- Anti-drift: integrity tests scan v2 config reads; skeleton can't-rot tests

## 2. In flight right now

- Nothing mid-flight.

## 3. Decided, not yet dispatched

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
  Keep origin/rewrite for a few days. Old-spine deletion is a SEPARATE commit
  after cutover soak. The excision (85a824e) already retired the old-spine
  integrity scans and left this deletion list: egpt-spine.mjs, author-emoji.mjs
  (+ src/item-format.mjs), slash/, attic/, the 7 `// OLD-SPINE ONLY` migrations
  inside conversations-state.mjs (that FILE stays — it is the v2 conv-state
  library), compact-being.mjs's default_brain read, config-validate.mjs +
  conversation-members.mjs + their tests, dispatch.mjs's own personality/
  threadCwd reads (dispatch.mjs itself stays — v2 imports
  isContextOverflowError), vitest.config.mjs references.

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
- Profile: EGPT_HOME=~/.egpt2. Config: ~/.egpt2/config/config.yaml (the ONLY
  location — no legacy fallbacks since 85a824e). Old production (egpt-daemon service,
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
