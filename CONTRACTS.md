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

---

## 1. Conversation folder & transcripts
- **C1.1** Every chat (group AND DM, every surface) has its own folder
  `~/.egpt/conversations/<surface>/<slug>/`, slug = path-valid `sanitizeSlug`. ✅ (fixed `48fa639` — Beeper ids now resolve to the WA surface; before this every Beeper chat collapsed into `_unrouted`)
- **C1.2** Every chat keeps a `transcript.md` recording **every inbound message**
  AND **every @e/@l response — surfaced OR withheld** (mode-gated replies are
  logged tagged "not surfaced"). Logging is independent of surfacing; the
  auto-mode governs only whether a reply is SENT. ✅ (`48fa639` + `efbcea2`; see memory `egpt-transcripts-first-class`)
- **C1.3** transcript.md is an 8-day rolling window; older days archive to
  `memories/transcript-<date>.md`. Per-file serialized appends (no lost writes). ✅ (`2dda652`)
- **C1.4** First-class since the **initial commit** — never gate transcripts on
  enrollment, observe-only, or mode. ✅ invariant

## 2. Media
- **C2.1** Every media attachment (image, video, voice note, audio, document,
  sticker) is saved into the chat's `media/` folder by default. ⚠️ **REGRESSED** — the Beeper bridge downloads a voice note only to a cache path to transcribe it, then drops it; no `media/` folder is created for Beeper chats (52 baileys-era folders have `media/`; Beeper chats have none). Source: `c02ad18`.
- **C2.2** Saved media gets a meaningful filename + a sidecar caption file + an
  index entry. ⚠️ **REGRESSED** with C2.1. Source: `d4f453c`.
- **C2.3** Revoked/deleted media moves to `deleted/` (not hard-deleted). ⚠️ **REGRESSED** with C2.1.

## 3. Transcription
- **C3.1** Every voice/audio note is transcribed (DOLLY GPU whisper-server worker
  over LAN, HMAC-token auth; local whisper-cli fallback). Unconditional. ✅ (`d6fbbed`, `6bfede3`, `3ed95fc`)
- **C3.2** The `👂 <transcript>` ack is an egpt-initiated SEND → gated on the
  enrolled-chats rule (auto_e_chats / self-DM), NOT a contract. Suppressed in
  non-enrolled chats by design (privacy: don't reveal egpt in others' chats). ✅ (`54f69c3`)
- **C3.3** The transcript text still dispatches + lands in transcript.md even when
  the 👂 ack is suppressed. ✅

## 4. Emit gate & authorization
- **C4.1** Every model reply to WA is gated at ONE chokepoint (streamFactoryRef),
  fail-closed; raw bridge.send is system-only. ✅ (memory `egpt-wa-emit-chokepoint`)
- **C4.2** Per-chat mode (`on/mention/mute/off`) enforced at the send chokepoint,
  not the model reply. `paused` = absolute @e-emit kill. ✅ (memory `egpt-emit-gate-bridge-controlled`)
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

## 8. Workers (DOLLY)
- **C8.1** @l = local llama-server; transcriptor = GPU whisper-server. Both
  supervised by DOLLY's daemon (crash-respawn), LAN-firewalled. ✅
- **C8.2** A worker supervisor REAPS the stale port-holder before spawning, so a
  soft restart self-heals the Windows child-orphan (no manual elevated taskkill). ✅ (`91abee3`, `src/tools/reap-port.mjs`)

## 9. Lifecycle / logging
- **C9.1** `/restart` (exit 43) respawns from disk via the supervisor — NO UAC.
  The elevated `sc.exe` path is only the wedged-daemon failsafe. A `{type:'slash',
  cmd:'/restart'}` dropped in `~/.egpt/outbox/` triggers it remotely (works for
  the spine AND DOLLY over the file share). ✅
- **C9.2** logOut/errOut append to a durable `~/.egpt/logs/egpt.log` (the headless
  frame-dump is lossy — don't trust it). ✅ (true file logging)
- **C9.3** No error is ever truly silent — `swallow()` sink + catch triage. ✅ (`2b683f7`)

---

## Open regressions to recover (priority order)
1. **Media-save (C2.1–C2.3)** — re-land "save every attachment into the chat's
   `media/`, meaningful filename + sidecar caption + index, revoke→`deleted/`" on
   the Beeper bridge. The bridge has the chatID; it needs a `saveMedia(chatID,
   path, meta)` callback that egpt.mjs resolves to `slugDir/media/`.
2. **@l slot-release timeout (C7.5)** — bound a single @l turn so a hang frees the
   slot fast; then re-enable `siblings.l.memory`.
3. **Audit `❓` items** (C5.2, and cross-check every doc) and add a test per
   recovered contract.
