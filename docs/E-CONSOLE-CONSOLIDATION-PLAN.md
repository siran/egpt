# `/e` Console Consolidation — menu-driven conversation control

Status: PLANNED (2026-06-27). Supersedes the flat `/e <verb>` + `/egpt <verb>`
surface with a single navigable menu. Builds on the help-menu/wizard primitive
(`src/help-menu.mjs`, `src/agent-wizard.mjs`) and the self-DM echo fix
(`normEchoText`, `src/bridges/beeper.mjs`) that makes a stateful menu safe in the
operator's own DM.

## Why

Today there are ~13 typed verbs split across two commands, with `new` / `identity`
/ `persona` triplicated:

- `/e`:  `new` · `identity` · `persona` · `auto <mode>|pause|resume|status|show-think` · `residents` · `transcribe` · `<slug>` (console) · `<slug> agent` (wizard)
- `/egpt`: `status` · `brain <type>` · `list` · `new [<persona>] [<name>]` · `persona …` · `rewind`

Nobody can remember this, and it's hostile on a phone. The fix is to make `/e` a
**browser + per-conversation menu**: you navigate by number, never memorize a verb.

## Target surface

Only TWO entry points remain. Everything else is a menu choice.

- **`/e`** (alias `/egpt`, no args) → list the **10 most recent conversations**,
  numbered, plus a pinned global entry for the default brain. Reply a number to open.

  ```
  egpt · conversations
   ✦) @egpt — global default brain          (brain · sessions · rewind)
   1) SPOILER…              e · sonnet · mention   2m ago
   2) Joyce Vicente         e · haiku · mention    15m ago
   …
   (number · q quit)
  ```

- **`/e <slug>`** (alias `/egpt <slug>`) → that conversation's **console**: state
  line + a numbered action menu.

  ```
  «SPOILER…»  resident: e · claude-code/sonnet/medium · mention · transcribe:on · thread:b5a8081c
   1) personality   — pick one; its text is delivered into this chat via the bridge
   2) new thread    — wizard (brain → effort → personality); rotate transcript + back up block + fresh thread
   3) reply mode    — on / accum / mute / mention / off
   4) residents     — which beings reply here
   5) transcribe    — on / off / streaming
   (number · b back · q quit)
  ```

- **`✦ @egpt` (global)** console → `brain <type>` · `sessions` (list) · `rewind` ·
  `status`. The default-brain/persona session is a different object than a per-chat
  thread, so it gets its own pinned entry rather than being mixed into the chat list.

### Removed
`agent`, `new`, `identity`, `persona`, `auto`, `residents`, `transcribe` as **typed
verbs** all go away — they become numbered actions. `/e` and `/egpt` + a slug are the
only things typed. **No deep-linking** (`/e spoiler 2` is intentionally NOT supported):
always navigate. Keep it solid and simple.

## Action semantics

### 1) personality (replaces `/e identity` + `/e persona`)
- List available personalities (shipped `config/personalities/` + operator
  `~/.egpt/personalities/`); operator picks by number.
- The personality's **text is delivered into the chat where the command was run**
  (Self / group / 1:1) **through the bridge** — i.e. it is a real posted message, and
  that same delivery IS how the being receives it. One path, no hidden side-channel
  inject. (Play-script model: injecting a personality = posting it into the conversation.)
- Keeps the thread (this is a refresh, not a reset). Re-stamps `identityInjectedAt`.

### 2) new thread (replaces `/e new` + the `agent` wizard)
- Wizard collects: **brain → effort → personality** (per the conversation; the being
  is the conversation's resident — `e` by default).
- On completion, route through the shared reset core (`_runReboot`, extended):
  1. **Archive** `transcript.md` → `transcripts/<stamp>_<oldThreadId>.md` *(exists today)*
  2. **Back up the old conversation block** → `conversations/<surface>/<slug>/past-conversations.yaml`,
     keyed by the old `threadId` (1:1 with the archived transcript) *(new)*
  3. **Start a fresh thread** with the chosen brain/model/effort + installed personality *(extend `_runReboot`: it currently applies identity only)*
  4. **Update `conversations.yaml`**: new `threadId`/`threadCreatedAt`, chosen
     `readonly:{brain,model,effort,personality}`, plus `conversation_path` +
     populated `threadCwd` (see Store changes).

### 3) reply mode (replaces `/e auto <mode>`)
- on / accum / mute / mention-direct / mention / off. Global pause/resume/status live
  under the `✦ @egpt` global console (they're node-wide, not per-chat).

### 4) residents (replaces `/e residents`)
- Which beings reply here. Ties into the per-conversation `residentsOf()` dispatch
  (already wired, #2 Phase 1) and the future per-being dispatch (Phase 2/3).

### 5) transcribe (replaces `/e transcribe`)
- on / off / streaming, per chat (global toggle under the `✦ @egpt` console).

## Store changes (prerequisite for #2)

Per operator (2026-06-27): the conversation path must be **stored, not derived**, and
every started conversation has a conversation-e thread, so `threadCwd` must not be null.

- **`conversation_path`** — NEW field per entry, relative to `~/.egpt`
  (e.g. `conversations/whatsapp/SPOILER…-2606101647`). Written when the contact's
  folder is ensured. Readers prefer it; derive (`slugDir`) only as a fallback for old
  entries.
- **`threadCwd`** — populate it (the AI thread's cwd, absolute) at thread-start instead
  of leaving it `null`. Kept as the distinct "AI cwd" field (it *may* differ from the
  conversation folder; normally equals it). Backfilled on next dispatch for old entries.
- **`past-conversations.yaml`** — NEW per-slug file; archived being-blocks land here on
  reset, keyed by old `threadId`.

## Menu mechanics

- Reuse `src/help-menu.mjs` (navigation state machine) + `src/agent-wizard.mjs` (the
  step wizard) — same renderer-neutral model (text now, TTS/voice later).
- Stateful per `chatKey` in the spine (`_helpMode` / `_wizardMode` maps), armed by `/e`
  / `/e <slug>`, consuming the operator's numbered replies.
- **Self-DM safety:** the bridge drops our own prompt echoes via `normEchoText`
  (handles WhatsApp's `N)` → `- ` list rewrite), so a numbered menu in the operator's
  own DM cannot echo-loop. This is the precondition that makes the whole design safe.
- Only the account owner (`authorized`) drives the menu; everyone else passes through.

## Migration (multistep)

1. **Store fields** — add `conversation_path` (stored) + populate `threadCwd`;
   read-fallbacks for old entries. Tests. *(no behavior change yet)* — **DONE** (`3db15bf`).
   - **1b. Backfill script** — `setup/backfill-conversations.mjs`: deterministic one-shot
     that fills `conversation_path` + `threadCwd`, **discovers** a missing `threadId`
     from `~/.claude/projects/`, and DETERMINES `e.readonly {brain,model,effort,personality}`
     (model read from the thread's `.jsonl` = ground truth, else `default_brain`). Dry-run
     by default; `--apply` writes the safe fields, `--readonly` also pins brain/model.
     Run with the daemon stopped (avoids the live-write race). **DONE.**
2. **Browser** — `/e` / `/egpt` (no args) → numbered list of 10 recent conversations
   + pinned `✦ @egpt`. Number → open console.
3. **Console menu** — `/e <slug>` → state line + numbered actions; wire actions to the
   EXISTING handlers (reply mode → auto, residents, transcribe) first, behavior-neutral.
4. **New-thread wizard** — extend `_runReboot` to apply brain/model/effort + back up the
   old block to `past-conversations.yaml`; make the wizard the #2 action.
5. **Personality action** — deliver the personality text via the bridge as a real
   message (replace the marker+hidden-feed split with one delivered message).
6. **Fold `/egpt` globals** — `✦ @egpt` console: brain / sessions / rewind / status +
   global pause/resume/transcribe.
7. **Retire typed verbs** — remove `agent`/`new`/`identity`/`persona`/`auto`/`residents`/
   `transcribe` as typed verbs; update `meta`/help so `/e` and `/egpt` advertise the menu.
8. **Boot-verify** on REVE (outbox `/restart`) + a Self-DM walkthrough.

## Parked / related (don't forget)

- **Heartbeats boot-scan → `heartbeats.readonly.md`.** On every spine boot, an async
  process should scan all per-conversation heartbeat configs (`heartbeatEnabled` /
  `heartbeatIntervalMin` / `heartbeatLastFiredAt` on each entry) and write a consolidated
  `heartbeats.readonly.md` that is loaded into memory — so heartbeats actually fire. This
  is the missing wiring that makes heartbeats work (operator 2026-06-27). Separate
  subsystem from the `/e` console, parked here so it isn't lost; schedule after the
  console lands (or as its own track).

## Non-goals / open

- No deep-linking (decided).
- Multi-resident transcript archival: `transcript.md` is one file per chat. Resetting a
  being archives the shared transcript — fine for the single-E case (today). Revisit when
  a chat truly has E + another resident (dispatch Phase 2/3).
- Voice/TTS rendering of the menu — the primitive is renderer-neutral; not built here.
