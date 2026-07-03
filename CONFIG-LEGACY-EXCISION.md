# CONFIG LEGACY EXCISION — new-config-only (operator 2026-07-02)

> Operator directive: "rewrite to only accept the new config, port it. no legacy
> nothing. no baggage to keep at this point. egpt must be a lean mean machine."
>
> Status: INVENTORY DONE (this doc), implementation NOT yet dispatched — session
> hit the Fable limit right after the inventory landed. Next session: read this,
> dispatch ONE background Opus agent with the plan below, review, commit, port
> the live residue, /restart.
>
> Scope decision: old-spine deletion (egpt-spine.mjs, author-emoji.mjs, slash/,
> attic/) STAYS a separate post-cutover commit per ROADMAP §3. This excision is
> the CONFIG acceptance layer only. CAVEAT from the inventory: dispatch.mjs and
> conversations-state.mjs are NOT old-spine-only — the v2 boot path imports live
> exports from both (boot.mjs ← conversations-state.mjs; brainpool ←
> dispatch.mjs isContextOverflowError). Legacy readers inside them are edited in
> place, never by deleting the files.

## The canonical (new) shape — anything accepting something else is legacy

- Node config: `EGPT_HOME/config/config.yaml` with the unified `agents:`
  registry — `agents.<name>: { type, handles, relay_channel? }`; `user_name`
  and `default_time_zone` top-level. Agent-type files:
  `EGPT_HOME/config/agents/<type>.yaml`.
- conversations.yaml (slim): jid-keyed entries, pushedName as the jid-key
  INLINE COMMENT; keys `conversation_path` (home-relative), `threadId`,
  `readonly: { agent, type, model, effort, allowed_tools }`, `home_dir`. No
  slug / personality / lifecycle-timestamp / threadCwd keys; lifecycle lives in
  each conversation's stats.yaml. readonly is deterministic (concrete
  model/effort, never null).

## Operator vocabulary — the 2026-07-02 20:32 live config.yaml edit IS the spec

The operator hand-rewrote `~/.egpt2/config/config.yaml` in the final vocabulary.
The code must accept exactly this (new-config-only), which AMENDS the groups
below:

- **`agents.<name>.configuration: <type-file>` REPLACES `agents.<name>.type`.**
  The registry key now names the agent-type FILE (config/agents/<name>.yaml);
  this disambiguates from the type-file's own `type: ccode` (engine) key.
  Accept ONLY `configuration` — no `type` back-read. Update: every registry
  reader (brainpool resolveDefaultBrain/localAgentDef, router, boot, mesh,
  relay), config-schema `agents` doc, config/skeletons/config.yaml, seed
  comments, and all tests/fixtures. `handles` and `relay_channel` unchanged.
- **No `agents` block (or no persona entry) = FATAL boot error** with a clear
  message — not a silent fallback to brains.resolve('egpt'). The skeleton ships
  the block uncommented; a node without it should say so, not guess. (Amends
  Group A: resolveDefaultBrain's whole fallback chain collapses to "the persona
  agent's `configuration`".)
- **`transcription_service` is canonical** (already primary in
  src/spine/transcription.mjs:35 — the operator's `use_config: reve` +
  `reve.fallback_order` shape matches the code exactly). DELETE the
  `cfg.transcription` fallback (:36) and the bare top-level
  `cfg.posts_back_delay_ms` (:53); `txSvc.posts_back_delay_ms` stays.
- **`user_name`: top-level default, per-network override KEPT** — the operator
  comment says "can be overwritten per network (whatsapp, telegram, signal)".
  So `cfg.whatsapp?.user_name ?? cfg.user_name` in boot.mjs:141 is CANONICAL,
  not legacy (amends Group K). `beeper_token` stays top-level only — the
  `cfg.whatsapp?.beeper_token` fallback (boot.mjs:140) still goes.
- **`whatsapp.auto_e_default` / `auto_e_paused` stay where they are** (the live
  file uses them) — Group K's default confirmed: keep, and delete the
  `dispatch.*` legacy read-fallback note from the schema.

## Inventory (Explore agent, 2026-07-02) — delete ALL of this

### A. `default_brain` fallback
- `src/spine/brainpool.mjs:215-233` `resolveDefaultBrain()` — reads
  `(getConfig() ?? {}).default_brain` (line 228; string OR inline object
  230-232). New-only: resolve solely from the persona agent's `type`.
- `config/config-schema.mjs:50-59` — `default_brain` + `default_brain_fallback`
  entries (self-labeled LEGACY). Delete once no reader remains.
- `src/tools/textecute.mjs:79-86` — `cfg.default_brain` model override (LIVE
  reader — textecutables spawn outside the spine import graph). Drop; fall back
  to login default.
- `src/tools/compact-being.mjs:148` — dead on v2 (only inside
  `compactableConversations()`, old-spine-only). Leave for old-spine deletion.
- Tests locking it: `tests/spine-brainpool.test.mjs:75-86,121`.

### B. `readonly.brain` back-read (brain→agent)
- `conversations-state.mjs:899-900` `getBeing()` — `ro.agent ?? ro.brain` (both
  the `brain:` and `agent:` return fields). New-only: `ro.agent` only.
- Writer already new-shape (`src/spine/brainpool.mjs:271-273`).
- Tests: `tests/spine-brainpool.test.mjs:400-410`,
  `tests/conversations-state.test.mjs:538,571,821-826`.

### C. Boot migration layer (excise whole)
- `src/spine/boot.mjs:240-245` — invokes `migrateConversationVocabulary(...)`.
  Delete the call.
- `conversations-state.mjs:627-730` `migrateConversationVocabulary()` — delete
  (ports brain→agent, 'default'→'egpt', drops personality, deterministic
  model/effort backfill, lifecycle→stats.yaml, re-bases conversation_path +
  home_dir). Live profile already ported — verified 2026-07-02.
- `src/tools/config-io.mjs:35-56` — JSON→YAML config migration
  (`config.json` → `config/config.yaml` + `.bak` rename). Delete.
- Dead-on-v2 migrations defined in conversations-state.mjs, invoked only from
  `egpt-spine.mjs:5820-5860`: `migrateLayoutIfNeeded:1647`,
  `migrateSlugSuffix:549`, `migrateMediaToSlugDirs:313`,
  `migrateConversationsToJidKey:406`, `migrateToSurfaceLayout:449`,
  `migrateSlugsToCurrentName:514`, `migrateJsonToYaml:1608`. Deleting them now
  breaks egpt-spine.mjs imports + old-spine tests → EITHER delete together with
  matching test/vitest updates, OR leave clearly-marked for the old-spine
  commit. Prefer: delete now IF egpt-spine.mjs's imports of them are also
  stubbed/removed without widening scope; otherwise mark `// OLD-SPINE ONLY`.
- Tests: `tests/conversations-state.test.mjs:649-830` (whole migration
  describe) — delete.

### D. `siblings` / `persona` / `persona_name` legacy resolution
- `src/spine/boot.mjs:88,103,107,114,118,218,219` — body_emoji/name/persona
  fallbacks + `getSiblings: () => cfg.siblings ?? {}` wiring.
- `src/spine/router.mjs:67,107,115-122` — sibling fallback routing (agents
  consulted first; siblings = "both worlds during migration").
- `src/spine/brainpool.mjs:201` — `siblingDef()` legacy
  `config.siblings?.[being]` inline-shape fallback.
- `src/spine/mesh.mjs:49-50,57,111-122,226` — `persona ?? persona_name`,
  `siblings()`, legacy `mesh.nodes` route. NOTE: `config.mesh.nodes` is the
  CURRENT route mechanism per ROADMAP §1 (mesh routes + route-direct via
  agents.relay_channel) — keep `mesh.nodes`, drop only persona/siblings reads.
- New-only: label/emoji/routing/local-being purely from the `agents` registry.
- Tests: `tests/spine-router.test.mjs:8-15,59,94,170-187` (":187 no agents
  block → siblings still route" gets DELETED — no agents block now means no
  local beings), `tests/spine-brainpool.test.mjs:266-291`,
  `tests/spine-boot.test.mjs:21,28,40`, `tests/spine-mesh.test.mjs`,
  `tests/conversation-members.test.mjs:25-32`,
  `tests/config-validate.test.mjs:12-39` (sibling cwd warnings).

### E. Legacy config LOCATION fallbacks
- `src/tools/config-io.mjs:21-30` — `LEGACY_CONFIG_YAML` (profile-root
  config.yaml) + `CONFIG_JSON_LEGACY` fallbacks; `_readConfigYamlPath()`.
- `src/tools/config-io.mjs:81-86,90-104` — `LEGACY_AGENT_DIR`
  (`EGPT_HOME/agent/`) fallback in `_readAgentDir()`.
- New-only: require `config/config.yaml` + `config/agents/`. Live profile
  verified clean (no root config.yaml, no config.json, no ~/.egpt2/agent).

### F. Per-conversation `personality` residue
- `conversations-state.mjs:892` `getBeing()` — `personality: ro.personality ??
  flat.personality ?? 'default'`. Delete the field from the return (identity
  feed is the agent TYPE's `personality:`, already wired in brainpool:281).
- `conversations-state.mjs:885-886` — getBeing returns
  threadCreatedAt/identityInjectedAt (dropped keys; old-spine callers only) —
  delete from the return.
- Tests: `tests/conversations-state.test.mjs:821-826` (+ fixtures :525-528),
  `tests/spine-brainpool.test.mjs:100-109,135-143`, `tests/per-being.test.mjs`.

### G. `threadCwd` (write + residue)
- `conversations-state.mjs:1082` — ensureContact actively WRITES `threadCwd`
  (and nulls it on rename at :1105). No v2 reader anywhere. Delete both; add
  `threadCwd` to `_SLIM_DROP` (:1486) so serialize purges it from disk.
- Live residue: `~/.egpt2/conversations.yaml` has 4 stray `threadCwd:` keys
  (lines ~12/33/44/87) + stale `conversations.yaml.bak`. Port = _SLIM_DROP
  handles the keys on next write; delete the .bak by hand.
- Tests: `tests/conversations-state.test.mjs:190-232` (backfill + rename-null
  assertions get deleted/rewritten), fixtures :571,773.

### H. Brains layering — drop the `config/brains` profile layer
- `src/spine/brains.mjs:25-27,50-54` — layer order src/brains →
  EGPT_HOME/config/brains (tagged legacy) → EGPT_HOME/config/agents → conv
  brains/. Drop the `config/brains` layer (live profile has none; cold).
  Keep: src/brains built-ins ← config/agents ← conv.
- Tests: `tests/spine-brains.test.mjs:23-40,58-72`.

### I. `default` type alias — already clean
- No alias exists (brains.mjs resolves literally; seed ships egpt.yaml).
- FIX STALE COMMENT: `src/spine/brainpool.mjs:218-219` claims a default→egpt
  alias that doesn't exist.

### J. CONFIG_SCHEMA legacy entries (config/config-schema.mjs)
- Delete: `default_brain`(:50), `default_brain_fallback`(:54), `meta_brain`
  (:60), `siblings`(:68), `persona`(:71), `persona_name`(:72),
  `main_engineer`(:70), `auto_modes`(:69), `transcription_endpoint`(:45),
  `transcription_token`(:46), `posts_back_delay_ms`(:47); prune legacy notes in
  `whatsapp`(:41) and `dispatch`(:28) docs.
- BLOCKER: these are held by the old-spine `EGPT_CONFIG` anti-drift scan
  (`tests/integrity.test.mjs:67-86`, reads egpt-spine.mjs). That scan asserts
  every key egpt-spine reads exists in CONFIG_SCHEMA. Options: (a) retire the
  old-spine scan now (it guards dead code on the v2 path), or (b) keep the
  schema keys until old-spine deletion. Operator intent ("no baggage") →
  RETIRE THE OLD-SPINE SCAN (:40-65 launcher boundary, :67-86 EGPT_CONFIG scan,
  :128-161 command-dispatch coverage — everything reading egpt-spine.mjs),
  keep the v2 scan (:88-124). The v2 scan requires `siblings/persona/
  persona_name` keys only while boot reads them — Group D removes those reads,
  then the schema keys go too.

### K. Adjacent legacy-location reads on the v2 path
- `src/spine/boot.mjs:140-141` — `cfg.whatsapp?.beeper_token` and
  `cfg.whatsapp?.user_name` fallbacks. New-only: top-level only.
- `src/spine/gating.mjs:24,42` — reads legacy `whatsapp.auto_e_default` /
  `whatsapp.auto_e_paused`. DECISION: these are what the LIVE config uses
  (config.yaml has whatsapp.auto_e_default: mention) — so here the whatsapp.*
  location IS current practice. Either keep as canonical (update schema doc) or
  move to `dispatch.*` + port live config. Default: KEEP whatsapp.* as
  canonical for now, delete only the `dispatch.*` read-fallback note in schema.
- `src/spine/transcription.mjs:53` — triple fallback `txSvc?.posts_back_delay_ms
  ?? cfg.transcription?.posts_back_delay_ms ?? cfg.posts_back_delay_ms`. Keep
  `transcription.*` (canonical block), drop the bare top-level fallback +
  deprecated schema aliases.
- `src/spine/brainpool.mjs:99-104` — `cfg.brains?.identity` manifest override.
  Drop with the config/brains layer (Group H) unless tests show live use.

## Execution plan (next session)

1. Dispatch ONE background Opus agent with this doc as the spec. Success
   criteria: all groups A–K applied; migration functions gone from the v2 path;
   `rg -n "default_brain|ro\.brain|LEGACY_CONFIG|CONFIG_JSON_LEGACY|LEGACY_AGENT_DIR|migrateConversationVocabulary|siblings" src/ config/ spine.mjs egpt.mjs` clean
   (mesh.nodes stays); full suite green (`npx vitest run`), including rewritten
   integrity tests; no old-spine files touched beyond what Group C/J requires.
2. Fable reviews the diff, runs the suite, commits + pushes (descriptive, no AI
   attribution).
3. Port live residue: delete `~/.egpt2/conversations.yaml.bak`; the threadCwd
   keys purge themselves via _SLIM_DROP on first write (or strip by hand).
4. `/restart` via `~/.egpt2/ingest/` (only with a clean committed tree), verify
   beat (`state/alive.txt` mtime) + `/status` in the egpt-an chat.
5. Update ROADMAP.md (§2/§3) + delete this doc's DONE sections or the whole doc.
