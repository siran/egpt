# Ideas / Future Milestones

Designs that are intentionally not built yet. Each entry should
explain the shape of the idea, the path that was considered, and
what's pending — so picking one back up doesn't require
re-deriving the whole thing.

---

## Live mic capture into eGPT (DEFERRED 2026-05-23)

Operator: "for eGPT it would be supercool to connect a mic to the
PC, so note it down in ideas."

Shape: a new bridge / input source that captures audio from the
operator's local microphone (any OS), feeds it through whisper-
stream (which exists in their build and IS designed for live capture
via -c device-id), and dispatches the transcript as if the operator
typed it. Wake-word or push-to-talk gating so we don't transcribe
the whole day.

Path considered:
  - whisper-stream.exe handles the audio device + sliding-window
    transcription natively (--step, --length, --keep, --vad-thold
    flags). It's the right tool for live mic.
  - egpt would spawn whisper-stream as a managed child (similar to
    whisper-server lifecycle), parse its stdout for finalized
    segments, dispatch them as messages.
  - Routing: which "chat" does the mic transcript go into?
    Options: (a) configured default chat, (b) the chat the operator
    is currently "joined" to via /use, (c) a dedicated 'mic' room.
    Probably (b) — operator says "@e XYZ" out loud, it lands in the
    active chat. /use switches the target.
  - Wake gating: VAD threshold + a wake word ("egpt", "e") would
    keep the bridge from transcribing every ambient sound. Without
    a wake word, the mic captures everything.

Pending:
  - mic-bridge skeleton (parallel to wa/tg bridges)
  - device selection UX (`/mic devices` to list, `/mic on <id>` to start)
  - wake word detection (use whisper for it too — coarse model on the
    first few words of each utterance — OR a dedicated keyword-spotter)
  - integration with /use so transcripts land in the active chat

This would close the loop on egpt as an ambient assistant: voice
in (mic), voice out (TTS — already deferred separately).

---

## Read-receipt-driven personalization for `/movie` (DEFERRED 2026-05-16)

A WhatsApp message that animates *per viewer* via WA read receipts.
The vision: the operator sends `/movie @waN hi` to a group, the
message lands as a static `👋`, and when each member opens the chat
the hand waves and the message rewrites to include their pushName.
After everyone has seen it, the message rests on a line like

```
   👋  hi, Alice, Bob, and Carol!    👁 3 seen · 7 reads
```

— a "doorbell" that knows who's been by.

**Why it's parked.** An end-to-end implementation shipped (see git
log around mid-2026-05; commits `9fe0311`, `5bbf966`, `a788702`,
`737633a`, `3fe1501`) and got close, but reads from real viewers
weren't reliably reaching the bridge's handler. The two leading
hypotheses without a definitive answer:

1. **baileys event shape drift.** The bridge listened on both
   `sock.ev.on('messages.update')` (1:1 chats, status enum `4` =
   READ) and `'message-receipt.update'` (groups, per-participant).
   The latter's payload shape varies by baileys version —
   `receipt.userJid` vs top-level `participant`, `receipt.type ===
   'read'` vs `receipt.readTimestamp != null`. Need a diagnostic
   pass with real events captured to see what the current baileys
   actually emits in the operator's groups.
2. **WA read-receipt privacy off.** A non-trivial fraction of WA
   users disable read receipts entirely. Those reads fire no event
   at all on any device. No bridge-side fix possible; it's a
   feature-coverage limit to document, not a bug to chase.

A secondary issue surfaced: when a preset baked `<username>` into
its default greeting, the regular (non-personalized) `playFrames`
path rendered the placeholder as literal text. That was fixed
(commit `3fe1501`: auto-engage personalization on placeholder
detection), but the rip-out at `2026-05-16` removed that
infrastructure too — rebuilding will need to redo it.

### What was built (now removed — see git history)

All on the `main` branch between `9fe0311` and `3fe1501`,
torn out in a later commit. The shape was:

**slash/movie.mjs**

- New flags on `/movie`: `--template "<text with <username>>"`,
  `--mode append|first`, `--joiner ", "`, `--include-self` (for
  testing without a second device).
- `<username>` / `<viewercount>` / `<readcount>` placeholders
  substituted at frame emit time.
- New `hi` preset — static `👋` until first read, then wave +
  greeting + names. `autoDelete: false`, `placeholderFrames: 1`.
- Preset config field `placeholderFrames` — how many leading
  frames to skip on re-animation so names don't flicker out
  between viewers.

**bridges/whatsapp.mjs**

- `_personalizedMovies` Map keyed by sent msgKey.id, holding per-
  message state: `viewers[]`, `totalReads`, `started`, `finished`,
  `placeholderFrames`, `includeSelf`, etc.
- `_pushNameByJid` Map populated from inbound `messages.upsert`
  events so reader pushNames could be resolved even when
  `sock.contacts` was sparse.
- `_resolvePushName` — pushName-only lookup chain (see
  [memory: pushName only, never the contact book]). Order:
  `msg.pushName → sock.user.name (for self) → _pushNameByJid →
  sock.contacts[jid].notify → friendly fallback ('you', 'friend',
  'mystery reader', ...)` — never `sock.contacts[jid].name`.
- `_renderUsername` — substitutes `<username>` / `<viewercount>` /
  `<readcount>` at every frame emit.
- `_handlePersonalizedRead` — dedup by pushName, skip operator
  self-reads (unless `includeSelf`), start animation on first
  read, re-animate on each subsequent post-finished read (skipping
  placeholder frames so the rest state stays visible between waves).
- Listeners on `sock.ev.on('messages.update')` and
  `'message-receipt.update')` filtered to known personalized keys,
  with verbose diagnostic logs for every event (status enum, raw
  receipt JSON).

### What to do when picking this back up

1. **Diagnose first.** Restore the verbose listeners (or rebuild
   them), send `/movie @waN hi --include-self` to a real group,
   have someone else open the chat, and read the
   `personalized[<id>]: ...` log lines. The mystery is whether
   events arrive at all, and if so what shape — not a code
   design question yet.
2. **Don't reinvent the pushName resolver.** The
   pushName-only-never-address-book rule is in memory and matters
   for privacy. Same with operator self-read skip (auto-mark-as-
   read on send would otherwise consume the first-viewer slot).
3. **Operator's KISS preferences from the design sessions:**
   - Animation continues uninterrupted when new viewers arrive
     mid-anim — just append to the live list.
   - When a viewer arrives after the animation finished, re-run
     the animation (not just edit the final frame) — operator's
     "doorbell" mental model.
   - No `--max_names`, no `--fallback_seconds`, no debounce
     window.
   - Counter visible in the rest frame (`👁 N seen · M reads`).
4. **Friendly-fallback names** — when the resolver falls all the
   way through to bare digits (i.e. a real phone number), swap
   for `'you'`, `'friend'`, `'mystery reader'`, etc. so the
   message never renders someone's raw phone number as their
   "name."

### Related memories

- `feedback-wa-pushname-only` — privacy rule for any WA-side
  display name resolution.
- `feedback-verify-wa-chat-name` — debugging "nothing happened"
  starts with the slash-echo chat name, not the chat the operator
  is staring at.
- `project-egpt-movie-hi-pending` — pointer back to this file.

---

## Streaming voice perception — `/movie`-style audio frames (DEFERRED 2026-05-22)

A WhatsApp voice note transcribed and fed to @e frame-by-frame as
it's being "heard" — analog of the `/movie` alien arc but driven
by audio chunks instead of pre-built canvas frames. The recipient
watches a single reply message evolve as the model's understanding
forms; the model receives a sliding text-window with a millisecond
timer, like watching meaning arrive over time.

**Why parked.** End-to-end implementation shipped (see commits
`dd093f1` through `537daee` and the `/textmovie` slash). The
mechanics worked — voice chunked at ffmpeg, transcribed in sliding
windows by `whisper-base`, brain re-fired per window via the SDK,
WA reply edited in place with replyStack accumulation, bridge
appends a deterministic `.` when transcription completes. But the
brain (haiku 4.5) consistently treated each frame as a discrete
question rather than a continuation of one utterance — producing
fragmented haiku-like replies that derailed conversation rather
than enhancing it.

**What was tried, in order:**

1. Plain text chunks per second → too short for whisper to
   transcribe coherently; "[Música]" noise placeholders flooded
   the output.
2. 6-second windows, 3-second stride → coherent transcripts but
   brain coalescing dropped half the windows when brain calls
   (~3s each) couldn't keep pace with chunk arrival (~3s stride).
3. Audio-time [M:SS] prefix added → brain had sequence cue but
   still treated each frame as a new question.
4. Millisecond [M:SS.mmm] tickers + ticker also firing between
   windows ("time passes" perception) → more granular but brain
   still confused.
5. Silence rendered as whitespace inside windows
   (`_buildSpacedWindow` parses whisper segments, positions text
   in audio-time) → visually meaningful but brain didn't read
   the whitespace as silence-passing.
6. Bare ticker-only format (`[0:05.177] hola estoy`) with no
   sender / envelope → brain returned silence to all of them;
   too contextless.
7. Ticker + sender (`[0:05.177] An: hola`) → brain replied but
   per-frame, no continuity across frames.

Each iteration improved something but the brain's cognitive
interpretation kept missing. **Root finding: without telling the
model that these inputs are partial frames of one ongoing voice,
it defaults to treating each WA-envelope-shaped dispatch as a
separate user turn.** Session memory (resume across calls) helps
but doesn't bridge the gap on its own — the model needs structural
"this is a stream" knowledge.

**Resolution.** Reverted to batch mode (single dispatch with the
full accurate `whisper-large-v3` transcript per voice note).
Gated by:

  whatsapp.media.audio_transcribe.streaming: false   # in ~/.egpt/config.yaml

Flipping to `true` re-engages the streaming path. All code is
in place, no removals.

### What's pending

If we pick it back up, the unresolved question is "how does the
brain know it's a stream?" Three paths worth exploring:

1. **Minimal pre-prompting in `personalities/system.md`** — one
   short paragraph telling the model that `[M:SS]` or `[M:SS.mmm]`
   prefixed inputs are sliding-window frames of one voice in
   progress, to thread continuity. Reverts the operator's
   "no-prompting" rule but the experiment showed it's the
   structural minimum the model needs.

2. **SDK streaming-input mode** — `claude-agent-sdk`'s `query()`
   accepts an `async iterable` as the prompt. Each window appends
   to the SAME user turn rather than dispatching as a new turn.
   The model genuinely sees one growing message and replies with
   one growing assistant message. This is the architecturally
   honest version of the alien effect: input streams as a single
   turn, not N turns. Big refactor of the brain wrapper but the
   modality matches what the operator was after.

3. **Voice-channel paradigm** — for true real-time, switch from
   voice-note delivery to a voice-channel join (Discord stage,
   Telegram voice chat, custom WebRTC). The operator speaks live;
   audio is streamed at native rates via WebRTC; whisper-stream
   does true real-time transcription. Different UX entirely —
   "talk to @e" via a phone-call-like channel rather than via
   voice notes.

### What stayed shipped (useful infrastructure beyond the voice
experiment)

- `~/.egpt/state/e-prompts.log` — every brain prompt + reply,
  tail-friendly format. 5MB rotation.
- `~/.egpt/state/e-activity.log` — RECV/REPLY/SKIP/ERROR/SEND-FAIL
  audit, 5MB rotation.
- `~/.egpt/headless.log` — 500KB rotation + spinner-line filter so
  the Ink redraw churn doesn't bloat the file.
- `/textmovie "<text>"` slash — feeds the brain a paragraph as
  alien-style timestamped frames at a configurable cadence. Pure
  test harness for brain real-time perception (no WA bridge); useful
  for future experiments at this layer.
- `_transcribeAudioStreaming` helper in `bridges/whatsapp.mjs`:
  ffmpeg-chunks audio, runs whisper-base per window, exposes
  EventEmitter + donePromise. Reusable as the audio side of any
  future streaming-perception attempt.
- Sliding-window + spaced-text helpers in `bridges/whatsapp.mjs`:
  `_buildSpacedWindow(rawWhisperOutput, dur)` and
  `_stripNoiseMarkers(s)`. Used by the streaming path; still
  there for re-engagement.

### Related memories

- `project-egpt-movie-hi-pending` — sibling experiment with the
  same modality at the visual layer.
- Probe scripts: `tools/probe-whisper-stream.mjs`,
  `tools/probe-whisper-srt.mjs`, `tools/README.md` — documented
  the finding that whisper-cli is fundamentally batch (no
  streaming stdout / no incremental SRT), which forced the
  ffmpeg-chunk approach.
