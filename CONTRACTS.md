# egpt CONTRACTS — behaviors egpt MUST fulfill

Why this file exists: egpt's behavior contracts kept silently regressing — most
of them when the WhatsApp transport moved **baileys → Beeper** (commit `fae6034`
"remove baileys completely"), because the contracts lived in code/heads, not in a
tested spec. Each fresh agent re-derived a partial picture and dropped something.

This is the canonical list of what egpt promises. Treat each as an invariant.
**When you touch a path that implements one, there must be a test that locks it.**
Status legend: ✅ honored · ⚠️ regressed/partial · ❓ unverified.

Sources mined: git log (feature commits), the in-repo docs (BRAINS-AND-PROFILES,
ENGINE-SURFACE-SEPARATION, LEDGER_PROTOCOL, ROOMS-UNIFICATION, MANUAL, README,
AGENTS), and the agent memory invariants. This is v1 — expand it by auditing the
docs above; mark `❓` items as you verify them.

## Relationship to config/config-schema.mjs
`config-schema.mjs` is the COMPLEMENT to this file, not a duplicate:
- **config-schema.mjs** = the registry of every `EGPT_CONFIG.<key>` + its
  description. It is **machine-validated** (`tests/integrity.test.mjs` fails if a
  key read in egpt.mjs isn't registered), so the config SURFACE can't drift. It
  is config-centric and dense.
- **CONTRACTS.md** (this file) = the human-readable BEHAVIOR invariants (many
  config-independent) + status flags. It is NOT self-validating.

Lesson that motivated this file: the schema already documents the media-save
contract (`whatsapp.media.download`) — yet the behavior regressed anyway, because
the integrity test only checks that the KEY is registered, not that the BEHAVIOR
happens. **Documentation doesn't prevent regressions; a behavior test does.** So
each contract here should earn a behavior test as it's recovered/verified, and
should cross-reference its schema key where one exists.

---

## 0. The whole thing, in the operator's words
egpt is a simple, powerful tool. The entire contract is four sentences. Each
one is an invariant that a test must keep from regressing; the rest of this file
just expands them.

1. **All replies are logged unless egpt is `off` for that chat.** Logging is
   independent of surfacing — a reply withheld by the mode (or a `…` silence) is
   still written to `transcript.md`, tagged not-sent.
2. **Every brain/agent reply (E, L, Wren, Don, … — anything non-human) is gated
   by the chat's mode.** It can only reach the chat via:
   - **mention** — `@e` appears (never a self-mention)
   - **mention-direct** — `@e` at the start / a reply to E (never a self-mention)
   - **on** — the model decides; it may answer `…` to stay silent (not fanned
     out, still logged)
   Plus the two hard rules: **`paused` = absolute kill** (overrides every mode),
   and **a reaction never triggers a reply**. `mute`/`off` never emit.
3. **Every message sent to a group or room is logged; media goes to the chat's
   `media/` folder.**
4. **The model receives well-identified messages:**
   `Sender@[chatname/groupname].{node} (HH:MM): body` — `{node}` is the ENTRY
   POINT the message came through (`wa` = WhatsApp, `kg` = the home shell,
   `chrome` = the extension; never hardcoded). Voice is inlined as
   `(voice transcription, 26s) body`.

Lock status of the four:
- **#2 — LOCKED.** `tests/auto-mode.test.mjs` covers mode gating, mention /
  mention-direct / on, `…`-silence-logged-not-sent, mute/off-never, fail-closed
  on a forgotten flag, reaction-never, AND `paused`=absolute-kill
  (`mayEmitChat`). This is the leak fear — it is test-guarded.
- **#1 — LOCKED** (transcript record-always: `fanOutDecision`, C1.2).
- **#3 — logging LOCKED; media-save LOCKED** (recovered 2026-06-12, C2.1/C2.2
  — `tests/beeper-bridge.test.mjs` + `tests/media-save.test.mjs`; only the
  revoke→`deleted/` path C2.3 remains TODO).
- **#4 — LOCKED** (`tests/dispatch-line.test.mjs`; recovered 2026-06-12 — one
  `formatDispatchLine`, node from surface identity not hardcoded, brackets +
  `.{node}` + UTC HH:MM — C7.6).

---

## 1. Conversation folder & transcripts
- **C1.1** Every chat (group AND DM, every surface) has its own folder
  `~/.egpt/conversations/<surface>/<slug>/`, slug = path-valid `sanitizeSlug`. ✅ (fixed `48fa639` — Beeper ids now resolve to the WA surface; before this every Beeper chat collapsed into `_unrouted`)
- **C1.2** Every chat keeps a `transcript.md` recording **every inbound message**
  AND **every @e/@l response — surfaced OR withheld** (mode-gated replies are
  logged tagged "not surfaced"). Logging is independent of surfacing; the
  auto-mode governs only whether a reply is SENT. ✅ **WhatsApp** (`48fa639` +
  `efbcea2`; memory `egpt-transcripts-first-class`).
  ⚠️ **NOT limb-agnostic — Telegram conversations are written nowhere** (drift
  found 2026-06-13). Three causes: the per-chat transcript write is on the
  default-brain path (`dispatch.mjs`), which the Telegram→Wren `forceTarget`
  route bypasses; `_appendSiblingReply` is hardcoded to `'whatsapp'`
  (egpt.mjs:2789); the Telegram dispatch only formats the prompt, never logs the
  inbound. Fix: log inbound + reply to `conversations/<surface>/<slug>/transcript.md`
  for EVERY surface + being (E or sibling), surface-aware. Owed.
- **C1.3** transcript.md is an 8-day rolling window; older days archive to
  `memories/transcript-<date>.md`. Per-file serialized appends (no lost writes). ✅ (`2dda652`)
- **C1.4** First-class since the **initial commit** — never gate transcripts on
  enrollment, observe-only, or mode. ✅ invariant
- **C1.5** transcript.md opens with a YAML **front-matter** block — `name`
  (contact/group), `thread_id` (resumable thread, distinct from chat_id),
  `surface`, `slug`, `persona`, `notes` — written once at creation
  (`src/transcript-meta.mjs` `renderFrontMatter`, via `dispatch.mjs`). Every
  reader strips it (`stripFrontMatter`) so front-matter keys never reach a model
  as turns. ✅ (2026-06-13, `tests/transcript-meta.test.mjs`). Enrichment fields
  (`network` / `phone` / `type` / `participants` / `account`) are the collector's
  job (planned) — the block is the stable container.

## 2. Media
- **C2.1** Every media attachment (image, video, voice note, audio, document,
  sticker) is saved by default into the chat's own `<slug>/media/`. Config:
  **`whatsapp.media.download`** (`"all"` / `"images_docs"` / `"off"`). ✅
  (recovered 2026-06-12). The Beeper bridge downloads each attachment + gates on
  the policy (`shouldDownload`), then hands it to the host via `onMedia`;
  egpt's `_saveIncomingMedia` copies it into `slugDir/media/` (ensuring the
  contact so a media-first chat doesn't lose the file). Voice notes are saved AND
  still transcribed — the regression was transcribe-then-drop. Locked by
  `tests/beeper-bridge.test.mjs` (onMedia called for voice + image, policy
  honored) + `tests/media-save.test.mjs` (pure helpers). The per-chat
  `<slug>/media/` form won over the legacy `~/.egpt/media/<jid>/`.
- **C2.2** Saved media gets a meaningful filename
  (`<YYYYMMDD-HHMMSS>-<sender>-<kind>[-<msgId>].<ext>`) + a sidecar `.txt`
  caption (voice → the transcript) + an `index.md` entry. ✅ (recovered
  2026-06-12, `mediaFileName`/`mediaIndexLine`, `tests/media-save.test.mjs`).
- **C2.3** Revoked/deleted media moves to `deleted/` (not hard-deleted). ⚠️
  **TODO** — needs a Beeper message-revoke event handler; the save path (C2.1/2.2)
  is in, the revoke path is not yet wired.
- **C2.4** Incoming media is processed in the NUCLEUS, limb-agnostically: a limb's
  only media job is fetching the bytes off its own transport (Beeper assets,
  Telegram `getFile`, …); it hands the local file to `onMedia`, and
  `_saveIncomingMedia` (surface-aware) saves it under
  `conversations/<surface>/<slug>/media/` and returns the path so a vision brain
  can `Read` an image. The Telegram limb now downloads photo/voice/audio/document
  (was text-only). ✅ (2026-06-13; `tests/incoming-media.test.mjs`; memory
  `egpt-limb-agnostic-media`).

## 3. Transcription
- **C3.1** Every voice/audio note is transcribed (DOLLY GPU whisper-server worker
  over LAN, HMAC-token auth; local whisper-cli fallback). Unconditional. ✅ (`d6fbbed`, `6bfede3`, `3ed95fc`)
- **C3.2** The `👂 <transcript>` ack is an egpt-initiated SEND → gated on the
  enrolled-chats rule (auto_e_chats / self-DM), NOT a contract. Suppressed in
  non-enrolled chats by design (privacy: don't reveal egpt in others' chats). ✅ (`54f69c3`)
- **C3.3** The transcript text still dispatches + lands in transcript.md even when
  the 👂 ack is suppressed. ✅
- **C3.4** Voice transcription + the `👂` ack are ONE shared nucleus service
  (`src/incoming-media.mjs` `transcribeVoiceNote`), used by EVERY limb — never
  re-implemented per limb. The limb supplies the downloaded file + a reply
  mechanism + the host's enrolled/mute verdict; the nucleus transcribes (injected
  transcriber) and posts the enrolled-gated ack. Telegram now hears voice the same
  way Beeper does. ✅ (2026-06-13; `tests/incoming-media.test.mjs`). LANDMINE:
  `telegram.mjs` is browser-bundled, so the transcriber is INJECTED, never
  imported (no `node:child_process` in a bundled limb).

## 4. Emit gate & authorization
- **C4.1** Every brain/agent reply passes the emit gate (`_eMayReplyToChat` →
  `mayEmitChat`) before it can reach a chat: streaming replies fail-closed
  through `streamFactoryRef`; the few non-streaming sends each call the same gate
  per-call-site. Raw `bridge.send` (no gate) is system/lifecycle-only. The gate
  itself is **test-locked** — `tests/auto-mode.test.mjs` (`mayEmit`,
  `mayEmitChat`, `fanOutDecision`). ✅ (memory `egpt-wa-emit-chokepoint`)
- **C4.2** Per-chat mode (`on/mention/mention-direct/mute/off/accum`) is the gate;
  `paused` = absolute @e-emit kill that OVERRIDES the mode (pulled into the tested
  `mayEmitChat` so its removal goes red). ✅ (memory `egpt-emit-gate-bridge-controlled`)
- **C4.3** Emit authorization keys off `_personaReplyIds` (provable persona
  replies only), never `_sentIds` (echo set). No persona inference/fallback. ✅ (memory `egpt-mention-replytobot-leak`)
- **C4.4** Authorization uses a STABLE id ONLY, never display names (names are
  attacker-controllable). Operator = `isSender`. ✅ (`3ed95fc`, `fae6034`)
- **C4.5** Operator-sent `@<sibling>` bypasses observe-only in ANY chat; a
  non-operator's does not. ✅ (`3906d76`)

## 5. Auto-mode / surfaces
- **C5.1** The per-chat auto-mode (`on/mention/mute/off/accum`) is the SINGLE
  source of truth for reply behavior. `observeOnly` (classify = !isEgptChat) is
  for shell/bus MIRRORING ONLY — it must never gate replies or transcripts. ✅ now (it had leaked into both — caused @l-silent-in-groups and the transcript misfiling)
- **C5.2** `off` = no egpt at all in that chat (no transcript, no command, no @e). ❓ verify under Beeper
- **C5.3** Echo suppression must recognize egpt's OWN sends even when Beeper
  echoes them back HTML-formatted with a new id (normalize before compare). ✅ (`954823c`)

## 6. Backlog / catch-up
- **C6.1** Reconnect/wake backlog drains PACED (as-if-always-on); egpt answers
  LIVE traffic only — old messages are recorded-as-seen but not dispatched. ✅ (memory `egpt-backlog-paced-catchup`; beeper backlog gate `54f69c3`)

## 7. Dispatch / siblings
- **C7.1** A message reaches its brain through the nucleus on every surface (the
  limb is a dumb pipe); unified `@<sibling>` routing by canonical name + aliases. ✅
- **C7.2** Addressed siblings dispatch BEFORE @e so a direct address isn't stuck
  behind @e's slow turn. ✅ (`673858e`)
- **C7.3** @l (sessionless) runs on ONE local slot, globally serialized; bursts
  pile per-chat and drain oldest-first; a piled turn carries `replyAllowed`. ✅ (`69b10e1`)
- **C7.4** A sessionless sibling's reply is logged to transcript.md; its memory =
  l.md persona + a bounded tail of that transcript. ⚠️ memory is **off** right now (`siblings.l.memory:false`) — it hung the single slot on the CPU 3B; re-enable needs a per-@l slot-release timeout (see C7.5).
- **C7.5** A hung worker turn must RELEASE the slot quickly (short per-@l
  timeout), so one bad turn can't freeze @l until the 600s hard-timeout. ⚠️ **TODO** — currently a hung @l turn blocks all @l for up to 600s.
- **C7.6** Every inbound message a brain SEES is identified as
  `Sender@[chatname/groupname].{node} (HH:MM): body`, where `{node}` is the
  ENTRY POINT (`wa`/`kg`/`chrome`/…), resolved from the client/surface identity,
  NEVER a hardcoded literal. Voice notes inline as `(voice transcription, Ns)
  body`. One formatter (`src/dispatch-line.mjs` `formatDispatchLine`), wrapped by
  egpt.mjs `formatAutoDispatchLine` and shared by every call site +
  dispatch.mjs/slash. ✅ (recovered 2026-06-12 `tests/dispatch-line.test.mjs`).
  Note: the room sender-label at egpt.mjs:~3964 still hand-rolls a `@name.wa`
  (no brackets) for room ENVELOPES — separate consumer, follow-up to unify.
- **C7.7** Bot↔bot loop-guard (bridge-side). The bridge tracks a bot↔bot exchange
  per chat (sibling-bot replies with no intervening human turn). **Soft limit**
  (configurable minutes) → inject `WARNING FROM BRIDGE: …` into the chat. **Hard
  limit** (configurable) → the bridge stops gate-posting a bot's replies to the
  other, cutting the loop. Cross-bot analog of `resident_chain_cap`; the routing
  is the bridge's (Telegram is only transport). ⚠️ **planned**.

## 8. Workers (DOLLY)
- **C8.1** @l = local llama-server; transcriptor = GPU whisper-server. Both
  supervised by DOLLY's daemon (crash-respawn), LAN-firewalled. ✅
- **C8.2** A worker supervisor REAPS the stale port-holder before spawning, so a
  soft restart self-heals the Windows child-orphan (no manual elevated taskkill). ✅ (`91abee3`, `src/tools/reap-port.mjs`)
- **C8.3** egpt↔egpt is **bridge-controlled Telegram ONLY**. `@d`/Don is reached
  as a Telegram-bound being (egpt_dolly_bot), gated + logged like any other. The
  LAN HTTP agent endpoint — `src/tools/agent-endpoint.mjs` (`POST /v1/turn`,
  HMAC `agent_token`), the `don` brain (`config/brains/don.mjs`), the `agent`
  server config, and `siblings.d`'s LAN form — is **RETIRED**: no invisible
  bot↔bot backchannel (I8). ⚠️ code removal owed: drop `agent-endpoint.mjs` +
  `don.mjs` + their tests + the DOLLY `agent` server, re-bind `@d` to Telegram.

## 9. Lifecycle / logging
- **C9.1** `/restart` (exit 43) respawns from disk via the supervisor — NO UAC.
  The elevated `sc.exe` path is only the wedged-daemon failsafe. A `{type:'slash',
  cmd:'/restart'}` dropped in `~/.egpt/outbox/` triggers it remotely (works for
  the spine AND DOLLY over the file share). ✅
- **C9.2** logOut/errOut append to a durable `~/.egpt/logs/egpt.log` (the headless
  frame-dump is lossy — don't trust it). ✅ (true file logging)
- **C9.3** No error is ever truly silent — `swallow()` sink + catch triage. ✅ (`2b683f7`)

## 10. Engine & warmth (beings)
- **C10.1** Every being runs on the Claude Code **CLI** (`ccode` engine / native
  background agents); the in-process SDK is **RETIRED**. Deliberate contract,
  chosen from experience: the CLI gives `--effort`, robustness under tool-heavy +
  large-session turns, the native thinking stream, full tools/MCP, and server-side
  `--resume` that handles big threads. Do NOT reintroduce the SDK path. ✅
  (GENOME §7 / invariant I11; memory `egpt-background-agents`).
- **C10.2** Beings are native **background agents**: revived per message, warm
  ~5 min then reaped, context via `--resume`, per-being model+effort. BUILT:
  `ccode` resume-per-turn (`config/brains/claude-code.mjs`) — context is free, but
  a turn still spawns a process (interim). OWED ("Unit 4"): the resident-warm
  policy (config-driven always-on; attach-if-warm / revive-if-dead; ~5-min reap)
  so a turn stops paying a spawn. ⚠️ resident warmth **UNBUILT**.

---

## Open regressions to recover (priority order)
1. ~~**Message-shape (C7.6)**~~ — DONE 2026-06-12 (`src/dispatch-line.mjs` +
   `tests/dispatch-line.test.mjs`). Follow-up: unify the room sender-label
   (egpt.mjs:~3964) onto the same formatter.
2. ~~**Media-save (C2.1–C2.2)**~~ — DONE 2026-06-12 (`src/media-save.mjs`,
   bridge `onMedia`, egpt `_saveIncomingMedia`; tests locked). Remaining: the
   **revoke→`deleted/`** path (C2.3) needs a Beeper message-revoke handler.
3. **@l slot-release timeout (C7.5)** — bound a single @l turn so a hang frees the
   slot fast; then re-enable `siblings.l.memory`.
4. **Audit `❓` items** (C5.2, and cross-check every doc) and add a test per
   recovered contract.
