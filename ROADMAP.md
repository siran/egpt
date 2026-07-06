# ROADMAP — v2 state + what's next

> Written 2026-07-02 (session: the big feature push). Purpose: survive context
> compaction — everything decided-but-not-yet-done lives HERE, not in a chat
> buffer. Update this file as items land; delete sections that ship.
> Companion: SPINE-REWRITE-PLAN.md (the architecture + phase plan, mostly done).

## 1. Where we are

Branch `rewrite`, suite ~1403 tests / 0 fail. The node runs live as the
`egpt2-daemon` service, profile `~/.egpt`, from this working tree. All of the
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
  PROFILE's config/agents/; skeletons seed to the profile's config/skeletons
  (copy-if-missing, operator edits sacred)
- Textecutables: `*.x.md` = plain-text script, one fresh claude turn executes it
  (CLI / heartbeat `ai_run:` / ask E — NO /x command, ever)
- Commands: /restart /upgrade /rewind, /e auto <mode> [target], /status (fenced yaml)
- **/e wizard landed** — bare `/e` (this chat) / `/e <fragment>` (target resolved like
  /e auto's) ARM a guided re-point. Operator-only, 5-min TTL, b/back · x/cancel; while armed
  the operator's plain picks get first refusal (never fall through to E), a slash command
  bypasses WITHOUT cancelling (v1). On done: freezes the conversation's `readonly` (keeps
  threadId — context survives) + evicts its warm session (respawns next turn, no /restart).
  Reuses src/agent-wizard.mjs; ONE chokepoint in src/spine/commands.mjs isCommand/run.
  - **Picking an EXISTING type applies IMMEDIATELY (operator 2026-07-03)** — step 1 shows
    each type's COMPOSITION inline (model/effort/personality via brains.resolve); picking one
    IS the answer, applied with the type's PINNED model/effort (?? the DETERMINISTIC_* floor
    in conversations-state). The model → effort steps remain ONLY in the custom branch
    (STEPS_EXISTING = [config] now).
  - **/e wizard custom** — a final `custom` option BUILDS a new agent type (model → effort →
    personality → name, named last, collision re-prompts) and authors config/agents/<name>.yaml
    (+ a free-text identity layer as a FLAT config/identities/<name>.md) then applies it.
    Personality picks = identity layers (listIdentityLayers = profile config/identities/*.md +
    'egpt') + free text; 10 preset layers seeded copy-if-missing to config/identities/<name>.md
    (src/spine/seed.mjs PRESET_IDENTITIES).
  - **/e wizard tools step (operator 2026-07-03)** — a `tools` option (right before `custom`,
    also last) edits ONLY allowed_tools, keeping the current agent type/model/effort: default
    list / read-only / keep current / custom free text (validated, bare Bash/Agent rejected,
    'all' never selectable/writable — a picked type's or legacy frozen 'all' self-heals via
    the shared brainpool.coerceAllowedTools chokepoint).
- **Profile relayout (operator 2026-07-03, disk = spec)** — the code's canonical paths now
  match the reorganized profile: `config/conversations.yaml` (CONV_YAML_PATH), `config/logs/`
  (beeper.log + swallowed.log + NSSM service-std{out,err}.log), `state/ingest/` (the lifecycle
  box). Identities are FLAT `config/identities/<name>.md` files; the shared eGPT identity +
  pointers + rules ship as the ROOM TEMPLATE `config/skeletons/room/{00-identity,30-pointers,
  40-rules}.md` (git mv from the retired repo-root identities/egpt/), seeded copy-if-missing.
  readIdentityFeed = identity file + shared pointers + rules (identity first); a name with no
  profile file falls back to the room template's 00-identity.md. No repo-root identities/
  back-read.
- Anti-drift: integrity tests scan v2 config reads; skeleton can't-rot tests
- **Relayout guards (2026-07-03)** — two tripwires for the class of failure that slipped
  past the green suite when the profile was relaid out: (1) `tests/boot-profile-contract.test.mjs`
  boots the REAL spine against an on-disk fixture in the canonical layout with NO path
  overrides, asserting the code's own constants find it (registry-seen + thread resume,
  flat identity seeding, state/ingest consume, config/logs, transcript.md write, media/
  transcription roots under <conv>/media); (2) `setup/verify-install.mjs` (read-only,
  `node setup/verify-install.mjs`) checks the LIVE box for NSSM service-log drift +
  profile shape + liveness + claude on PATH — the drift no vitest can see
- **Repo cleanup (operator 2026-07-03)** — deleted 6 stale root docs (root `.md`
  18→12) + 14 docs/ plans & handoffs (docs/ 18→4) + 2 stale workspace files + 3
  orphaned scripts (backfill + 2 whisper probes) + config/heartbeats/ (superseded by
  config/skeletons/heartbeats.yaml); shipped plan docs removed per precedent. README /
  MANUAL / TESTING rewritten to v2 truth (lean). Root IDEAS.md seeds merged into
  docs/IDEAS.md (LATER deleted in the 2026-07-03 docs sweep — operator "can be
  forgone. full of BS"). KEPT by decision: MESSAGES-FIRST-CLASS-PLAN.md (its Phases 3–5 +
  Phase-1 OWED reply-path restructure are NOT shipped — only Phase 1's inbound `#id`
  and Phase 2 reactions landed; see §4 note).

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
  - **Scope amendment (operator 2026-07-03):** the stats service runs PER-MESSAGE
    and ASYNCHRONOUS — it does the counters AND resolves **LID↔phone identity
    mapping** as a per-message duty (the old src/identity.mjs + src/lid-map.mjs
    modules are the reference material; they STAY for that reason, kept off the
    cutover deletion list). "LID<->phone is done by the stats module per message,
    among other statistics, asynchronous."
  - **ALIAS MAP idea (operator 2026-07-03):** eGPT should map ANY sender id — a
    pushname, a number, a Beeper id — to an operator-chosen ALIAS, so a person is
    one stable identity across surfaces/ids. Candidate home: the stats module
    (per-message it already sees every id form) and/or config. Design open.

- **Self-setup onboarding** (operator 2026-07-03, verbatim intent — design open):
  on first run eGPT detects a DELETE-AFTER-SETUP file, which tells eGPT to
  SELF-CONFIGURE after receiving the `/egpt` command in Self (or whichever channel
  the user designates as the control channel). i.e. the node ships in a "not yet
  configured" state, greets/guides the operator through filling in the config from
  the control channel, then removes the marker file so subsequent boots are normal.
  Mechanism (how the guided config is authored, what it asks, how it validates the
  Beeper token) is not yet designed.

- **CUTOVER — main becomes v2** (held for operator "go" AFTER re-inspection):
  ```
  git tag pre-rewrite origin/main && git push origin pre-rewrite
  git push origin rewrite:main          # fast-forward, no force
  git branch -D main && git branch -m rewrite main
  git branch -u origin/main main        # /upgrade's git pull keeps working
  ```
  Keep origin/rewrite for a few days. Old-spine deletion is a SEPARATE commit
  after cutover soak. The excision (85a824e) already retired the old-spine
  integrity scans; the deletion list (enriched by the 2026-07-03 analysis):
  egpt-spine.mjs, author-emoji.mjs (+ src/item-format.mjs), slash/, attic/, the
  old shell/attach CONSOLE surface (src/shell/ + src/attach/ + the ink/CDP-console
  cluster the daemon no longer drives), config/personalities/ (identities replace
  them), config/themes/ (shell-only), the 7 `// OLD-SPINE ONLY` migrations inside
  conversations-state.mjs (that FILE stays — it is the v2 conv-state library),
  compact-being.mjs's default_brain read, config-validate.mjs + their tests,
  dispatch.mjs's own personality/threadCwd reads (dispatch.mjs itself stays — v2
  imports isContextOverflowError), vitest.config.mjs references, and config/brains/
  (codex.mjs, llama.mjs, claude-code.mjs old impl, config-schema.mjs, type/) —
  ~25 old-spine-only src modules + ~34 old-spine-only test files all told (see the
  analysis for the full list; not enumerated here to keep this terse).
  - **Design docs already GONE (operator-directed, 2026-07-03 docs sweep):**
    ENGINE-SURFACE-SEPARATION.md (its durable gene — engine-vs-surface, commands
    engine-first — folded into GENOME I1) and ROOMS-UNIFICATION.md (superseded by
    GENOME §2.5 + the "Rooms — remaining" entry above) were deleted EARLY rather
    than at cutover. The old-spine CODE that cited them (egpt-spine.mjs,
    src/engine/*, src/nucleus.mjs, src/room-routing.mjs comments) still carries the
    references as historical breadcrumbs — they die with those modules at cutover.
  - **NOT deleted (operator 2026-07-03):** `config/brains/chatgpt-cdp.mjs` +
    `config/brains/claude-cdp.mjs` are EARMARKED as FUTURE v2 engines (web-AI-via-
    browser — "browser control over CDP is eGPT's raison d'être; also to ease
    writing books using web AI"). `src/conversation-members.mjs` +
    `src/conversation-stats.mjs` + their tests STAY (stats module reuse — see the
    stats entry). `src/identity.mjs` + `src/lid-map.mjs` + their tests STAY (LID↔phone
    reference material — see the stats entry). The whole browser/CDP/extension/bus
    cluster (src/tools/{browser-tools,bus,bus-send,outbox-send,cdp,cdp-proxy,
    chrome-launcher,extract-yt-transcript}.mjs, extension/, commands/) STAYS.
  - **After cutover the working tree returns to `~/src/egpt`** (operator: "egpt2 was
    for a desperate rewrite"). Planned dev/prod split: PROD runs from an installed
    `~/bin/egpt`; the DEV tree's tests gain a read-only live-profile-layout tier
    (assert against the real profile shape without mutating it).

- **`mode: auto` — DESIGN DECIDED (operator 2026-07-04)**: very similar to
  `mode: on`, but egpt PLAYS THE OPERATOR'S ROLE in that conversation: be
  helpful and of service, follow links, do as told — and CONSULT THE OPERATOR
  when in doubt. The consult mechanism: a configurable advice channel (an
  "EGPT AUTO" chat is the default shape) where egpt posts its questions; the
  auto conversation's identity/kickoff layer instructs the model to know WHEN
  to seek advice there. All auto conversations run independent threads as
  always. Open implementation points: the advice-channel emit needs a
  sanctioned path through the fail-closed emit gate (a config-named chat id,
  same trust shape as agents.relay_channel); per-channel opt-in only; flood
  guard bounds runaway. NOT YET DISPATCHED — build after the turn-ordering
  fix lands (same spine files).

- **Deaf-bridge detection + post-deploy live smoke (live outage 2026-07-05)**:
  a respawn came up with a dead WS — process alive, tick beating, ZERO inbound
  for ~4 min of real traffic; operator commands silently unheard. The alive
  deadman only proves the LOOP runs, not that the bridge HEARS. Fix two ways:
  (a) liveness includes last-inbound age (deaf > N min with WS "open" →
  self-restart the bridge), (b) every deploy ends with a live smoke — a
  /status ping sent through the real chat and verified ANSWERED (the boot
  echo-verify machinery + egpt-an channel exist for exactly this).

- **Capabilities refresher (live gap 2026-07-05)**: resumed threads never learn
  NEW abilities — the identity feed is kickoff-only (E denied having /media
  live because its thread predates the limbs doc). Mechanism: version-stamp
  the limbs/instructions block; when a conversation's last-injected version ≠
  current, prepend the block once to its next turn (same shape as mode-flip
  instructions). Also: seeded skeletons are copy-if-missing, so live templates
  go stale on upgrade — the refresher must read the CURRENT template.

- **Stats enrichment — collect ALL Beeper-managed info (operator 2026-07-04)**:
  the stats module should capture everything the local Beeper API exposes —
  per CHAT (chatInfo: participants, network, group/1:1 type, ...) and per
  CONTACT (push name, numbers, alt ids, whatever the contacts surface returns)
  — stored in the stats files under a `beeper:`-style block with fetched_at.
  Doubles as DISCOVERY: "a good way to see what beeper can see." Refresh
  lazily (file creation / name change / staleness), async off the hot path —
  the collector gains bridge API access for this (today it is fs-only).
  Queued behind the natural-filenames chunk (same files).

- **Conversation-E API (limbs) — operator 2026-07-04, "long overdue"**: a more
  complete action surface E can invoke from inside its own conversation,
  "similar to react": send a reaction; REPLY to a specific msgid by its own
  volition (quote-reply); upload/send media files; (candidates: edit/delete
  its own prior message). Emit-syntax parsed+stripped by the comm-handler
  before surfacing (the Phase-4 emitted-command machinery), fail-closed:
  own-conversation ONLY, never cross-chat. Ground in what Beeper Desktop's
  local API actually supports (the bridge already sends reactions — the 👂
  ack path).

- **Single "mesh" channel (operator 2026-07-06, works NOW)**: the live 2-node
  chain uses rodz1/2/3, but with self-echo removed + mid gone it can run through
  ONE shared chat "mesh" — set every `agents.<name>.relay_channel: mesh`. The
  whole chain (request bouncing + reply) scrolls through one visible channel —
  "cool to see." Only caveat: the per-channel circuit breaker (5 sends/20s,
  guardedSend) concentrates on that one channel — raise it for a long chain.

- **`/react` emit syntax fix (live 2026-07-06)**: E fired `/react 👋` (emoji-
  first) through the mesh; operator believes the real bridge form is
  `/react <msgid> <emoji>`. Verify against src/spine/reply-actions.mjs + the
  bridge reaction call, correct the emit grammar AND the
  config/skeletons/room/00-identity.md doc E learns from, re-test.

- **HRW single-responder for shared channels (operator 2026-07-06)**: when 2+
  nodes/accounts BOTH host E in the SAME chat (e.g. REVE + DOLLY in a real
  group), an unqualified `@e` currently gets TWO replies. Default a rendezvous-
  hashing (HRW / Highest Random Weight — weighted-hrw, already cited in the
  config skeleton) tiebreak: each node independently computes
  weight(message-id, node-name) over the E-hosting node set present in the
  channel; only the max-weight node replies, the rest stay silent. Deterministic,
  zero cross-account coordination, load-balances across messages. NOT a problem
  for the relay chain (every hop is explicitly `@being.node` — one answerer);
  this is only for the unqualified-@e-in-a-shared-channel case.

- **Live mesh smoke — egpt-test channel CHAIN** (operator 2026-07-03): create 3–4
  dedicated egpt-test chats (like egpt-an — operator-authorized, no real contacts)
  and configure relay agents that CHAIN through them: `@don.kg → @moe.kg → @e.kg`
  — each hop a relay agent whose relay_channel is the next test chat, terminating
  at the local persona. Exercises multi-hop forward-once + living mirror + hop cap
  on ONE node, no DOLLY needed. Operator creates the chats; config gets the relay
  entries. (The DOLLY 2-node smoke stays as the later cross-machine step.)
  - **Node aliases (operator 2026-07-04)**: a node can claim two or more names —
    `node_name: <str>` + `aliases: [<list>]`. Routing (`@being.<node>` /
    config.mesh.nodes) resolves any alias to the same node. An alias can even
    be a fully DISTINCT SIGNED identity — the node just generates a second
    keypair ("it can generate two keys, no problem"): one machine, multiple
    cryptographic node-identities on the mesh; provenance then carries
    whichever identity the alias signs as. Identities can also live on
    DIFFERENT SURFACES: one node on whatsapp, another on signal — two
    full-name signed nodes on one machine (operator 2026-07-04).

- **Chrome/CDP textecutable test** (operator-driven, everything ready): copy
  the profile's config/skeletons/{script.x.md, heartbeats block} into a chat folder,
  set `when:` a few minutes out, delete state/heartbeats.readonly.yaml, watch.
  Note: CDP attaches only to a Chrome started with --remote-debugging-port
  (chrome-launcher.mjs starts a visible one; the daily browser needs the flag).

- **Root launcher script** (operator 2026-07-03): ONE script at the repo root
  that launches the spine if it isn't already present, then attaches the console
  client. Ties in the console-surface question: the Ink client
  (src/shell/ink-limb.mjs) is OLD-SPINE and of unknown health (operator: "i don't
  know if it works anymore") — this task PORTS it to v2 or RETIRES it. Design
  open (how the launcher detects a live spine, whether the client attaches over
  the retired attach/loopback path or something simpler). The old shell/attach
  cluster is on the cutover deletion list — if the console is retired, the
  launcher is just a spine starter.

- **Rooms — remaining** (folded from the retired ROOMS-UNIFICATION.md; GENOME
  §2.5 is the north-star). DONE in v2: the Room ABSTRACTION exists and unifies the
  path tree + member model — `src/room-core.mjs` (base `Room` + `ConversationRoom`
  + `NamedRoom`, one tree from `baseDir()`: config.yaml/transcript.md/media/files/
  identity.d, the 6-state member gate), LIVE via `conversations-state.slugDir`
  delegating to `Room.forChat(...).baseDir()` (byte-identical), and the v2 boot
  enumerates `rooms/<name>/` folders for heartbeats/transcription. NOT built: the
  behavior methods (transcript append, media save, confine wiring) still live in
  conversations-state — not moved onto the Room base; **NamedRoom federation**
  (`hosts[]` across surfaces); **member fan-out** (`src/rooms.mjs` +
  `src/room-routing.mjs` `planFanout`/`roomEnvelope` are OLD-SPINE-ONLY — imported
  only by egpt-spine.mjs + slash/ + tests, never by the v2 boot); **the dual-write
  rule** (a member chat's line appended to each Room's transcript). Folding those
  onto the base is a deliberate migration (+tests), not in passing. NB: the old
  flat-file room roster (`src/rooms.mjs` loadRooms/saveRooms + slash/room.mjs,
  slash/inject.mjs) rides the cutover deletion list; the v2 Room model is
  folder-based (`rooms/<name>/`).

## 4. Backlog (known warts, smallest last)

- **Service levels — "a conversation to be had" (operator 2026-07-03):** the node
  runs as `.\an` (the claude login, ~/.local/bin PATH, and the profile all live in
  the user's home — maximum capability, node = the operator). The alternative end
  of the spectrum is a dedicated low-privilege service account with explicit
  grants (smaller blast radius; claude-login + PATH story gets involved). Ties to
  GENOME's "secure AND powerful" bar. Not scheduled — discuss when ready.

- **messages-first-class — open phases** (docs/MESSAGES-FIRST-CLASS-PLAN.md, KEPT
  in the 2026-07-03 cleanup because it is NOT fully shipped). Landed: Phase 1 (inbound
  `#id` in the transcript line, C7.6e) + Phase 2 (reactions ingested/surfaced).
  STILL OPEN: Phase 1's ⏳ OWED reply-path restructure (E's OWN reply lines carry no
  `#id` — unify send→log so the id is appended once the send confirms); Phase 3 member
  actions (`/reply #<id>`, `@mention`, E SENDING reactions/removals via Beeper — no
  `/reply` exists in the v2 spine); Phase 4 contacts/ dataset; Phase 5 per-surface
  user_name + processing-node provenance. (NB: the cleanup prompt assumed C7.6e meant
  the whole plan shipped — it only completes Phase 1's inbound id.)
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
  install/setup docs after testing an install on another computer.

## 5. Operational facts (for any future session)

- Node: Windows service `egpt2-daemon` → egpt-daemon.mjs → spawns `node egpt.mjs`
  from the INSTALLED copy `~/bin/egpt` (operator 2026-07-03: prod decoupled from
  the dev tree — src/egpt2 can be dirty, the node doesn't care). Deploy: commit+
  push from dev, then drop `/upgrade` into ~/.egpt/state/ingest/ (the installed
  copy git-pulls origin/rewrite + npm install + respawns); `/restart` respawns
  what's installed. Migration script: setup/move-prod-to-bin-and-dot-egpt.ps1
  (self-elevating, re-run-safe).
- Profile: EGPT_HOME=~/.egpt (renamed from ~/.egpt2, operator 2026-07-03; old v1 profile archived as ~/.egpt-v1). Layout (operator 2026-07-03, disk = spec): config/
  {config.yaml, conversations.yaml, agents/, identities/<name>.md (FLAT), logs/,
  skeletons/ (incl. room/ = the shared identity/pointers/rules template)}; state/
  {ingest/, alive.txt, spine.pid, …}; conversations/<surface>/<slug>/; rooms/. Config
  is at ~/.egpt/config/config.yaml (the ONLY location — no legacy fallbacks since
  85a824e). Old production (egpt-daemon service, ~/.egpt, C:\Users\an\src\egpt) is
  STOPPED — both ride the same local Beeper Desktop (127.0.0.1:23373), so running both
  double-answers every @e.
- Restart: drop a file containing `/restart` into ~/.egpt/state/ingest/ (temp→rename).
  Hot-reload heartbeats: delete ~/.egpt/state/heartbeats.readonly.yaml.
- Install sanity check: `node setup/verify-install.mjs [service] [egptHome]` (read-only)
  probes the LIVE node — NSSM AppStdout/AppStderr under config/logs (the drift that killed
  the service 80× post-relayout), profile shape + no old-layout residue, spine.pid/alive.txt
  liveness, `claude` on PATH (with the service-env PATH caveat). EGPT_HOME defaults from the
  service's own NSSM AppEnvironmentExtra. Exit 0 = all ✅.
- Live self-testing: the egpt-an chat is operator-authorized for agent testing
  (pace sends ≥8s, small counts; each @e is a real claude turn; /status is free).
- Working agreements: operator = An; all implementation via background Opus
  agents (Fable orchestrates/reviews/commits); descriptive commits, no AI
  attribution; no continuity-diary logging for egpt work; commit+push without
  asking when work is done; comments carry the WHY (operator-dated decisions).
