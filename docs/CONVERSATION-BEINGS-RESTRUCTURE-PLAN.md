# Conversation-Beings Restructure — Plan

Locked design (operator + agent, 2026-06-25). Three rounds, sequenced. Build each
staged + tested + deployed, like the routing unification. Config stays **fully
commented** — comments encode structure and reveal inconsistencies (never strip).

Guiding constraints:
- Beeper is the one transport; network is metadata (already done — `whatsapp:` dissolved).
- Brains are **resident background agents**, never per-turn ccode CLI. A brain/effort/
  personality change therefore **reloads** the agent → explicit command, never a hot yaml edit.
- Meta engineers (@wren, @don, …) are global, mention-only — UNLESS shadowed by a
  conversation-local resident of the same name (local precedence, scoped to that chat).

---

## #1 — Transcription `mode:` (small, self-contained — DO FIRST)

The engine axis is **server vs cli**, not remote vs local (a "remote" worker is just a
server with an endpoint). Target shape:

```yaml
transcription:
  enabled: true              # global on/off (also gated per-conversation)
  mode: whisper-cli          # engine: whisper-server | whisper-cli  (extensible)
  posts_back_delay_ms: 0     # common to ALL engines — 👂 echo hold (ms); 0 = immediate, reply-to-own-audio
  server:                    # endpoint-based — a resident LOCAL server OR a remote box (e.g. DOLLY)
    endpoint: http://192.168.1.102:23390
    token: ...               # shared HMAC secret (remote endpoints only)
    # model / size / launch-args for a local resident server
  cli:                       # spawn the whisper binary per note
    command: ...whisper-cli.exe
    model_path: ...ggml-large-v3.bin
    language: es
    ffmpeg_command: ...ffmpeg.exe
    threads: 12
```

- `mode: whisper-server` → use the endpoint; **fall back to `cli` on any failure** (cli is
  always-available; a dead server only costs speed). `mode: whisper-cli` → cli only.
- Code: `txEndpoint()/txToken()` + transcriber selection (egpt-spine ~2322, ~3151), the
  whisper-server path (~4755-4773), `audioCfg` (transcription.cli ?? legacy whatsapp.media.audio_transcribe).
- Read-fallbacks for the just-migrated `transcription.{endpoint,token,whisper}` keys.
- Schema doc + tests.

## #2 — Per-being `conversations.yaml` restructure (big, staged)

Each conversation (1:1 / group / room) carries resident beings as sub-blocks. `E` always
present (default voice); others (`H`, custom) optional. Brain config is **readonly** (records
how the thread was started). Target shape:

```yaml
"!ykhYcePQbcYLTtWr2fUK:beeper.local":
  slug: Cecilia Rojas-2606151637
  pushedName: Cecilia Rojas
  firstSeenAt: 2026-06-15T16:37:18.341Z
  E:                                   # resident being (always present — the default voice)
    readonly:                          # how THIS thread's resident agent was started — editing here does NOTHING.
      # to change: /e new | /e identity | /e brain  (reload the agent + snapshot to past_conversations.yaml)
      brain: ...
      effort: high
      personality: default
    threadId: 5b518dc7-...
    threadCreatedAt: 2026-06-15T16:37:30.000Z
    identityInjectedAt: 2026-06-15T16:37:30.000Z
  H:                                   # optional second resident
    readonly: { brain: ..., effort: medium, personality: banter }
    threadId: ...
    threadCreatedAt: ...
    identityInjectedAt: ...
  # heartbeat NOT here — see heartbeats.readonly.yaml
```

- **`default_brain`** becomes the **template** (type/model/effort/personality/identity defaults
  inherited by each conversation's `E:` block). No global `session_id`/`history`.
- **`past_conversations.yaml`** in `conversations/<surface>/<slug>/`: on every thread change,
  append the **full conversation block** (all keys, all beings) — generic, AI-agnostic audit log.
- **`heartbeats.readonly.yaml`** at root: generated at spine start by scanning every
  conversation/room heartbeat file. Authoritative config stays in the per-conversation
  `heartbeat.*.md`; the root file is a read-only overview (no mirror inside conversations.yaml).
- **`@`-resolution:** conversation-local residents shadow the global siblings registry
  (`room.mjs` resolveRoute checks local first). A local `wren` shadows global `@wren` in that chat.
- Migration: reader-converge (read nested ?? flat) → migrate conversations.yaml → writer-converge
  (`_runReboot`, /e new|identity|brain) → drop the flat-key fallback. Touches conversations-state,
  dispatch, room, persona-state, _runReboot.

## #3 — `/e new agent` guided command (own round, after #2)

Born from a command, not hand-edited yaml. `/e new agent` asks *brain? effort? personality?*
with numbered, navigable options (like the help system), then writes the resident sub-block
into the current conversation. Creates the per-conversation custom resident (which may shadow
a global meta-engineer name).
