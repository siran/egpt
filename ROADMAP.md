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

- **Deaf-bridge detection + post-deploy live smoke (live outage 2026-07-05;
  ESCALATED by the 2026-07-07 overnight incident)**:
  a respawn came up with a dead WS — process alive, tick beating, ZERO inbound
  for ~4 min of real traffic; operator commands silently unheard. The alive
  deadman only proves the LOOP runs, not that the bridge HEARS. Fix two ways:
  (a) liveness includes last-inbound age (deaf > N min with WS "open" →
  self-restart the bridge), (b) every deploy ends with a live smoke — a
  /status ping sent through the real chat and verified ANSWERED (the boot
  echo-verify machinery exists for exactly this).
  - **2026-07-07 overnight incident (what was OBSERVED, no inferred
    mechanism)**: REVE deaf ~03:41→12:09Z (two bridge starts waited HOURS
    for WS: 05:29→07:35 and 10:51→12:09 — Beeper Desktop unreachable.
    CAUSE UNKNOWN: the machine was SET not to sleep (operator 2026-07-07),
    so "machine asleep" is out; why the local API was unreachable for hours
    on an awake machine is an open question — Beeper Desktop itself stuck /
    not running is the remaining suspect). After the 12:09 reconnect the log was scrolling — but that
    traffic was backlog SURFACING (voice transcriptions completing + late
    overnight sync, some held), NOT proof of live delivery. Two fresh
    /status posts to Self never produced a bridge event within ~4 min; after
    a /restart the fresh session delivered a new /status event in 17s.
    Cannot distinguish from the log whether the old session was broken for
    live pushes or Beeper Desktop was minutes behind and caught up — and it
    doesn't matter for the fix.
  - **Detector decision (operator 2026-07-07): DROP the passive
    last-inbound-age idea** — it false-alarms on quiet nights AND a draining
    backlog masks real deafness (lines scroll while the ear is broken; both
    just happened). The right check is ACTIVE, per the operator's own
    principle ("when you write a message, beeper has to notify you"):
    periodically post into a designated chat and require the bridge to
    receive its OWN event back within seconds; no echo → self-restart the
    bridge. Exercises the exact API→Beeper→WS→bridge path, traffic- and
    hypothesis-independent. Same probe doubles as the post-deploy smoke.
    Also by design: messages from a deaf window are HELD on reconnect
    (`held backlog message < bridge start`) — E stays silent on them rather
    than answering hours late; the humans must re-ping.

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

- **Single "mesh" channel — CLOSED (operator 2026-07-06)**: dropped on
  reflection — one shared chat means every node on the path is in one room, so
  in a chain A>B>C the endpoints A and C would know each other directly. That
  defeats the point of relaying (reaching C *through* B precisely because A and
  C share nothing). Per-hop channels stay.

- **Mixed-network mesh + multipath + traceroute (operator 2026-07-06)**:
  three stacked steps proving the mesh is network- and path-transparent.
  1. **Mixed-network hop — CODE READY, WAITING ON OPERATOR (Telegram link)**:
     `network:` pin LANDED (2026-07-06, agent-built): `agents.<name>.network:
     whatsapp|telegram|signal|matrix` beside relay_channel pins which network a
     shared chat NAME resolves to — router carries it on the mesh route,
     canonRoute/resolveBeingRelay pass it through, bridge.resolveChatId gates
     name/slug matches by the chat's network (raw ids bypass; no cache-key
     change needed — _knownChatIds keys on resolved ids, never names). Absent
     = resolve across all (prior behavior). CHECKED 2026-07-06 (twice): the
     Rodz account (DOLLY) has only matrix+whatsapp — NO Telegram — and the
     operator chose to LINK TELEGRAM ON RODZ first (over the zero-setup
     matrix-hop alternative). Once Telegram shows in DOLLY's /v1/accounts:
     create the cross-account Telegram chat, re-point don's relay_channel
     (+ network: telegram) in DOLLY config, re-run `@carol hello`.
  2. **Multipath — LANDED (2026-07-06, agent-built, reproduce-first)**: two
     layers. (a) Reply collision FIXED: `awaiting` keyed per-request by post_id
     (was origin-chat-wide — first reply home stranded the second request).
     (b) MULTIPATH-AS-CONFIGURATION (operator: "an agent is a list of paths,
     every message through every path"): `agents.<name>` may be a LIST of
     single-key maps `- <label>: {relay_channel, network?, to?}` — the router
     fans the mesh target into ALL paths; relayOut posts ONE placeholder then
     one envelope per path (same re:/post_id, per-path network pin, a failing
     path skipped, all-fail surfaces); relay-RECORD hops fan out too
     (resolveBeingRelay returns an array for list agents). First reply home
     wins the placeholder (existing awaiting-delete); a later duplicate is
     consumed. TERMINAL DEDUP falls out of the existing `seen` guard (keys on
     being+from+body — both envelopes collide): the being answers ONCE,
     redundant transport, no new machinery. Caveats: dedup requires identical
     to/from/body and one node process; the spine's armTimeout still keys one
     origin-wait timer per chat (timeout-only); config-schema doc string not
     yet updated for the list shape. LIVE on REVE config: carol = path1 rodz1
     (whatsapp) + path2 egpt-mesh-do-kg (telegram); live fan-out VERIFIED
     (2026-07-07 @carol tests). **MESH TEST PROGRAM CLOSED (operator
     2026-07-08)**: @cara 1-hop live-verified in Self ("Yeah, I'm here." —
     instant); every transport claim (multi-hop, multi-network, multipath,
     dedup, reply-home, traceroute) is live-proven. The rodz relay channels
     stay as the foreign-mesh testbed.
  3. **Traceroute `via:` — LANDED (2026-07-06)**: each forwarding hop appends
     `<being>.<node>` to a comma-separated `via:` provenance key; the terminal
     responder echoes it home; the origin appends a one-line trailer on the
     final frame only: `via don.do › wren.kg`. NOTE the origin's own relay
     agent (carol.kg) is NOT in the trail — hop 0 is from/from_node; seed it in
     relayOut if the operator wants it shown. Per-hop TIMING still open.

- **`/react` emit syntax fix — DONE (2026-07-06, agent-built, reproduce-first)**:
  the old grammar was `/react <emoji> [#<id>]` with the id DEFAULTING to the
  message being answered — so E's live `/react 👋` was accepted and silently
  fired at the triggering message. (The "✅ Done" that followed was NOT a react
  ack — it's the generic showThink stream-finalize marker; the reply was
  action-only so it was the only visible text.) Now STRICT `/react #<id> <emoji>`
  (id first, `#`-form matching /reply//edit//delete and how ids appear in
  transcripts); an omitted id is malformed → stripped + logged, never defaulted.
  Skeleton doc updated. Audited the other limbs (reply/edit/delete/media/ask)
  for the same silent-default class — none have it. LIVE CAVEAT: profile
  skeletons are copy-if-missing, so the LIVE room template still teaches the
  old grammar until refreshed (the capabilities-refresher gap) — malformed
  emits self-correct via the error line meanwhile.

- **Mesh channel NAMING CONVENTION (operator 2026-07-06, adopted)**: a mesh
  link channel between two nodes is named `egpt-mesh-<a>-<b>` with the node
  names in DETERMINISTIC (sorted) order — e.g. kg↔do → `egpt-mesh-do-kg`,
  kg↔mo → `egpt-mesh-kg-mo`. Both ends derive the same name independently, no
  coordination. LIVE: the kg↔do telegram link channel carries this name (was
  egpt-mesh-id → egpt-mesh → egpt-mesh-do-kg; renamed via PATCH /v1/chats/{id}
  {title} — works even though the response echoes the stale title). Seeds a
  future auto-provision step: a node can derive + create/find the link channel
  for any peer by name alone.

- **Mesh request OPTIONS (operator 2026-07-06 proposal, design open — build
  AFTER the multi-network test)**: the INITIAL message can carry per-request
  flags to the mesh, as a YAML tail on the human's own message:
  ```
  @carol hi
  ---
  opts:
    - show-hops
    - encrypt
    - sign-nodes
  ```
  Candidate opts: `show-hops` (surface the `via:` trail at the origin — the
  trail always rides the wire tail, this only controls origin display),
  `encrypt` (body encrypted for the terminal being, hops can't read),
  `sign-nodes` (each hop SIGNS its via entry — signed hops, verifiable path;
  ties into the node-keypair/alias identity ideas). Opts ride the envelope
  provenance so every hop sees them. Nothing implemented yet.

- **TRUSTED EGPT NETWORK (operator 2026-07-08 — ADOPTED DIRECTION, supersedes
  the standalone HRW item and the brief main-spine-to-DOLLY idea)**: REVE stays
  the main machine. Each node fronts its OWN Beeper account (kg/REVE = An,
  do/DOLLY = Rodz — the Rodz account does NOT retire, it is the network's
  second identity); the network = the set of SHARED chats both accounts sit
  in. Both nodes keep full transcripts of what they hear (they are egpt
  nodes). Simplicity is king. Decided semantics:
  1. **PRIMARY/STANDBY single-responder (v1, decided over HRW)**: `@e` → kg
     answers (primary); if NO reply lands in the chat within **5s**, ed (do)
     takes over. Coordination-free — the standby just watches the chat.
     HRW load-balancing can come later. Qualified addressing always pins
     (`@e`/`@e.kg` vs `@ed`). Reply stamps tell nodes apart: kg = 🐶,
     do = 🤝 (**body_emoji: 🤝 LIVE on DOLLY 2026-07-08**).
  2. **Transcription primary/standby**: DOLLY (GPU box) is the transcription
     PRIMARY; 👂 post-back keeps the 15-min debounce (confirmed 900000 ms);
     only the role-holder posts the 👂 (one ack, not two).
  3. **Sibling non-triggering DEFAULT**: agents don't trigger each other;
     per-chat opt-in may come later ("might be wanted in some cases");
     agents' polite-silence rules apply in shared chats.
  4. **Backlog-on-wake (decided)**: a waking spine RECEIVES backlog messages
     — they must NEVER dispatch agents (only live messages do) but MUST be
     transcript-logged, and voice notes MUST be transcribed locally; the 👂
     posts back only per the primary/standby role. (Today held backlog is
     dropped before transcript-logging — fix needed.)
  5. **beeper accounts REGISTRY (config shape, operator verbatim)**:
     ```yaml
     beeper:
       dolly: { account: dolly.egpt@gmail.com, token: <rodz token> }
       reve:  { account: anrodz42@gmail.com,   token: <reve token> }
     ```
     the network's named accounts shared as config. Physical note: a token
     only answers on its OWN machine's local API (and sleeps with it) —
     cross-account API ops work while the sibling is awake.
  BUILD ORDER (operator 2026-07-08 — the a→d checklist):
  ```
  a. [standby responder + sibling-output guard + atE-handles fix]
     → verify: shared-chat @e answered ONCE (🐶); with kg silent, 🤝 answers
       at +5s; @ed pinned answers immediately; sibling-stamped messages never
       trigger dispatch — ✅ DONE + LIVE-VERIFIED (2026-07-08, 875594a):
       both-up @e in rodz2 → ONE 🐶 answer, DOLLY heard (atE=true) and
       stayed silent; kg muted → 🤝 fired at +5.6s ("secondary instance
       responding. Primary appears silent."). Config live: kg
       network{role:primary, peer_stamps:[🤝]}, do network{role:standby,
       takeover_ms:5000, peer_stamps:[🐶]} + An's ids added to DOLLY
       whatsapp.allowed_users (the standby must AUTHORIZE the peer operator
       to take over — an activation requirement, now on both nodes).
  b. [backlog backfill on wake: transcript-log + transcribe voice, NO agent
     dispatch, 👂 per role]
     → verify: sleep DOLLY, send voice note, wake: transcript has it, no
       agent fired, exactly one 👂 — ✅ CODE DONE + DEPLOYED (2026-07-08,
       0346196; test-locked: stale→transcript flagged backlog, backlog voice
       transcribed+logged, backlog @e never dispatches even mode:on,
       network.transcribe_ack:false silences the 👂, no cancelHolds on
       backlog). Bundled: the 👂 LID push-name bug FIXED (a LID sender is an
       UNSAVED contact so senderName IS the push name — "le_moi" now shows,
       raw id only when no push name exists). LIVE sleep-window verify still
       to run (the DOLLY 5-min cycle test above).
  c. [beeper accounts registry config block]
     → verify: block parsed; /status shows the network's named accounts
     — ✅ DONE + LIVE-VERIFIED (2026-07-08, 2c3e93d): /status on kg shows
       beeper_accounts (reve/dolly names+addresses); tokens never surfaced
       (asserted absent in tests; deployed configs hold accounts-only
       entries — tokens deliberately omitted until cross-account ops exist).
  d. [transcription role wiring: do = primary transcriber]
     → verify: shared-chat voice note transcribed by do, 👂 posted once,
       15-min debounce intact
  ```

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

- **INIT LEVELS (operator 2026-07-07, design conversation open):** the node's
  capability ladder, runlevel-style; the spine should KNOW its level, expose it
  in /status, log transitions, and PROMOTE itself with active probes (never
  assume). Sketch:
  - **L-1 DORMANT** — machine asleep; scheduled WakeToRun duty cycles: wake,
    do egpt things, exit (exiting releases the scheduler's wake lock → machine
    drifts back to sleep). TEST HARNESSES LIVE 2026-07-07, task
    `egpt-wake-duty` → C:\Users\an\egpt-wake-duty.ps1 → appends to
    C:\Users\an\egpt-wake-duty.log; wake timers enabled AC+DC on both:
    - REVE (operator: test here first): every 5 MIN, duty also WAITS FOR
      NETWORKING (up to 30s, pings DOLLY + 1.1.1.1, logs seconds-to-net) —
      manual fire verified (net 0.1s, svc=Running, spine alive, beeperApi up).
    - DOLLY: every 15 min; S3 supported; manual fire verified.
    Sleep test = operator sleeps the machine, expect wake + log line within
    one interval; `lastwake` should name the task. NB while the task is
    enabled a sleeping machine RE-WAKES every interval — disable after
    testing (`schtasks /change /tn egpt-wake-duty /disable`).
  - **L0 BOOT** — service starts at boot, NO login: VERIFIED 2026-07-07 both
    nodes (`egpt-daemon`, startMode=Auto, .\an). Headless duties (heartbeats,
    cron, textecutables, claude turns) should run; Beeper is a GUI app so no
    messaging — deaf/mute BY DESIGN at this level.
  - **L1 SESSION** — user logged in, Beeper Desktop up → bridge connects →
    EARS VERIFIED. Promotion gate = the ACTIVE self-echo probe (post →
    expect own event in seconds), NOT "WS open". Operator-observed failure
    mode: "after log in, the spine remains in 0 instead of progressing" —
    the 2026-07-07 overnight WS waits (hours) are this; promotion today is
    passive retry and can wedge. The probe both PROMOTES to L1 and DEMOTES
    out of it (deaf → restart bridge → retry).
  - **L2 MESH** — relay channels resolve + peer link verified (mesh ping to
    a peer node). Optional higher rungs: transcription worker, browser/CDP.
  Implementation next steps: level field in /status + transition log lines
  first (observability), then the L1 probe (already the top reliability
  item), then wire L-1 duties into the real spine (ingest a beat / process
  due heartbeats during wake windows).
  - **L-1 PROVEN on DOLLY (2026-07-07 live test)**: operator slept DOLLY;
    the task WOKE IT from S3 (`powercfg /lastwake`: "Presume Wake Timer …
    NT TASK\egpt-wake-duty"), net up in 0.1s, spine SURVIVED the sleep
    (same pid, no deadman — daemon+spine freeze/resume together so the beat
    never looks stale), and the message sent DURING sleep dispatched and
    was ANSWERED on resume (backlog hold anchors to process start —
    process survived, so nothing held). The whole dormant→wake→hear→answer
    loop works on an S3 box. REVE CANNOT do this: it is Modern Standby
    (S0 Low Power Idle) — RTC wake timers are not honored there (two ticks
    slept through, empty wake history); REVE options = stay always-on
    (current), or buddy-wake via Wake-on-LAN from DOLLY (S0 honors WoL;
    needs the NIC's "Wake on Magic Packet" enabled + REVE's MAC in DOLLY's
    duty). Harnesses still armed on both (5-min): DISABLE after testing —
    `schtasks /change /tn egpt-wake-duty /disable`.

- **BUG: bridge atE wake-word ignores configured persona handles (found by
  the 2026-07-07 DOLLY sleep test)**: on DOLLY (`agents.egpt.handles:
  [ed, egptd]`) a live `@ed estás?` logged `atE=false` and was NEVER
  dispatched (the mention gate runs on the bridge's atE), while `@e estás?`
  logged `atE=true` and answered — the bridge's mention detection is
  hardcoded to e/egpt and never reads the agents config. Handles DO work at
  the router (mesh `to: ed.do` resolves; @ed at the START would route if it
  survived the gate) — the bug is the bridge gate. Fix: the bridge's
  wake-word set = the persona agent's name + handles from config (one
  source of truth), reproduce-first with a DOLLY-shaped config fixture.

- **messages-first-class — open phases** (docs/MESSAGES-FIRST-CLASS-PLAN.md, KEPT
  in the 2026-07-03 cleanup because it is NOT fully shipped). Landed: Phase 1 (inbound
  `#id` in the transcript line, C7.6e) + Phase 2 (reactions ingested/surfaced).
  STILL OPEN: Phase 1's ⏳ OWED reply-path restructure (E's OWN reply lines carry no
  `#id` — unify send→log so the id is appended once the send confirms); Phase 3 member
  actions (`/reply #<id>`, `@mention`, E SENDING reactions/removals via Beeper — no
  `/reply` exists in the v2 spine); Phase 4 contacts/ dataset; Phase 5 per-surface
  user_name + processing-node provenance. (NB: the cleanup prompt assumed C7.6e meant
  the whole plan shipped — it only completes Phase 1's inbound id.)
- html-to-markdown.mjs:45 renders <pre>/<code> tags as SINGLE backticks glued to
  the text — the true chokepoint behind the telegram fence-glue mangling
  (parseMesh now tolerates it, c62360b; a proper fenced-block rendering
  ```\n…\n``` would fix it at the source for ALL consumers, not just the mesh).
- **BUG: 👂 voice ack shows the raw LID instead of the push name (live
  2026-07-08)**: `👂 @whatsapp_lid-85555832479795:beeper.local (92s): …` in
  the morgan chat — should be the sender's pushed name (operator: "it should
  use push name"). An existing test locks pushed-name behavior for the 👂
  echo, so the LID-shaped sender path misses the resolver (ties into the
  LID↔phone stats duty). QUEUED behind trusted-network chunk (a) — same
  file (beeper.mjs).
- Test flakes under full-suite port/timing contention: tests/transcriptor.test.mjs,
  tests/beeper-bridge.test.mjs "newest isSender match" (real retry timers).
  Both pass in isolation. Fix: fake timers / serialize the port-binding tests.
  2026-07-06 full-suite run also flaked beeper-bridge "👂 voice echo pushed
  name" once (5s timeout, same contention class; passed isolated + next run).
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
