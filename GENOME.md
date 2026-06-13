# eGPT — GENOME

*The canonical description of what eGPT is at heart. Read this before touching
the nucleus. This is the DNA; the code is the body;
[`CONTRACTS.md`](CONTRACTS.md) is the test‑locked behavior list;
[`config/config-schema.mjs`](config/config-schema.mjs) is the machine‑validated
config surface. When behavior changes, amend THIS first, then add a contract + a
test. An agent that has read this document should be able to extend eGPT without
drifting from what it is — and, given the reference body, to rebuild any organ
of it.*

Status: **e0** (seed). Versioned + amended deliberately; see §10.

---


## 0. The heart (read this twice)

**eGPT is a being, not a session.** It is not a chatbox you open. It is a
persistent presence that already lives in the channels the human already uses —
WhatsApp, Telegram, the home shell, the browser — that *hears everything,
remembers everything, and acts through limbs* into those channels.

Three ideas hold the whole thing together. If a change violates one of them, the
change is wrong, not the idea:

1. **The being is the nucleus; the limbs are interchangeable senses.** A
   transport (WhatsApp/Beeper, Telegram, the shell, the extension) is an eye or
   an ear. The *thinking* — routing, gating, transcription, memory, replying —
   happens in the nucleus, once, for every limb. Giving the being a new sense
   must not change its mind.


2. **Everything is heard and recorded; only some of it is spoken.** Logging is
   unconditional and independent of surfacing. The per‑chat *mode* governs
   whether a reply is *sent*, never whether the message is *processed* or
   *recorded*. Silence (`…`) is a valid, logged answer.


3. **eGPT builds eGPT.** `E` is the gated public self — the
   creation. `Wren`, `L`, `D` are ungated
   meta‑engineers — the selves that build and run the being. Wren maintains this
   very codebase, reachable as a being over Telegram, resuming its own thread so
   it never loses what it is building.


The discipline that keeps a self‑modifying, always‑listening being safe and
trustworthy is not bolted on — it *is* the spine (§1). Honor it and eGPT can
grow new senses, new selves, and a mesh of peers without becoming something the
operator can't trust.

---


## 1. Invariants — the spine (these must never drift)

Each is an invariant. A test must keep each from regressing (§9). Memory slugs
in brackets point at the recorded rationale.

- **I1 — One router.** The bridge/nucleus is the ONLY message router. Never
  duplicate it, never invent a backdoor or a parallel send‑path. Extend the
  bridge; don't run beside it. `[[egpt-bridge-sole-router]]`
- **I2 — Limbs are thin.** A limb pulls raw input off its transport and hands it
  to the nucleus (`onIncoming` + `onMedia`); it sends through its
  transport (`send` / stream). The *only* media job that is
  legitimately limb‑specific is fetching the bytes (each transport downloads
  differently). Saving, transcribing, acking, routing, gating — all nucleus.
  `[[egpt-limb-agnostic-media]]`
- **I3 — Log always, surface by mode.** Every inbound message and every
  brain/agent reply (surfaced OR withheld) is written to the chat's
  `transcript.md`, tagged sent/not‑sent. Transcripts are first‑class since the
  initial commit — never gate them on enrollment, observe‑only, or mode.
  `[[egpt-transcripts-first-class]]`
- **I4 — One emit gate, fail‑closed.** Every brain/agent reply passes a single
  gate (`mayEmitChat`) before it can reach a chat. Streaming replies fail
  closed through one factory; the few non‑streaming sends each call the same
  gate. Raw transport‑send (ungated) is system/lifecycle‑only.
  `[[egpt-wa-emit-chokepoint]]`
- **I5 — Mode is the gate; `paused` is the kill.** Per‑chat mode
  (`on` / `mention` / `mention-direct` / `mute` /
  `off` / `accum`) is the single source of truth for reply
  behavior. `paused` is an absolute @e‑emit kill that OVERRIDES the
  mode. A reaction never triggers a reply. `mute`/`off`
  never emit. `[[egpt-emit-gate-bridge-controlled]]`
- **I6 — Authorization is provable and id‑based.** Emit authorization keys off
  genuine persona replies (`_personaReplyIds`), never the echo set; no persona
  inference/fallback. The operator is identified by a STABLE id
  (`isSender` / allow‑listed id), NEVER a display name (names are
  attacker‑controllable). `[[egpt-mention-replytobot-leak]]`
- **I7 — Privacy is structural.** Don't reveal eGPT in chats it isn't enrolled
  in: bridge‑initiated acks (the `👂` transcript ack) are gated on
  the enrolled‑chats rule, even though the transcript still reaches the model.
  Compartmentalize — never leak one chat's context into another.
- **I8 — E is gated; meta‑engineers are not.** `E` (the public
  persona) is always gated. `Wren`/`L`/`D`
  are ungated, self‑governed engineering selves. Agent↔agent chatter rides a
  VISIBLE transport (Telegram), never an invisible side channel.
  `[[egpt-metabot-vs-creation]]`
- **I9 — No silent failure.** Errors go to a sink and a durable log; nothing is
  swallowed without a trace. Backpressure and held‑backlog are explicit, not
  accidental drops.
- **I10 — Catch up, don't replay.** On reconnect/wake, backlog drains *paced*
  (as‑if‑always‑on): old messages are recorded‑as‑seen but not auto‑dispatched;
  the being answers live traffic. `[[egpt-backlog-paced-catchup]]`
- **I11 — The engine is the Claude Code CLI.** Every being runs on the local
  `claude` CLI (the `ccode` engine / native background agents); the in‑process
  SDK is retired (§7). This is a deliberate contract, chosen from experience:
  the CLI gives `--effort`, robustness under tool‑heavy and large‑session turns,
  the native thinking stream, full tools/MCP, and server‑side resume that
  handles big threads. Don't reintroduce the SDK path. `[[egpt-background-agents]]`


---


## 2. Anatomy — the organs

```
   transports (limbs)            the nucleus (egpt.mjs + src/)            brains/engines
 ┌───────────────────┐        ┌──────────────────────────────┐       ┌────────────────┐
 │ Beeper/WhatsApp    │        │  routing  ·  emit gate        │       │ claude-code CLI│
 │ Telegram           │ ──▶    │  dispatch-line formatting     │ ──▶   │ codex          │
 │ shell (kg)         │ onIncoming  media: save+transcribe+👂  │ stream│ llama (@l)     │
 │ chrome extension   │ onMedia │  rooms fan-out · accumulate  │       │ don (@d remote)│
 └───────────────────┘   ▲    │  memory/continuity · lifecycle │       │                │
        send / stream  ◀──┘    └──────────────────────────────┘       └────────────────┘
                                          │   ▲
                            transcript.md │   │ resume (session_id) · background agents
                            media/        │   │ outbox (self-restart) · agent mesh (LAN)
```


### 2.1 Limbs (`src/bridges/*.mjs`, the shell, the extension)

Thin transport adapters. Contract toward the nucleus:

- **Receive:** `onIncoming(text, from)` where `from` carries a STABLE
  `chatId`, `chatType`, the sender's stable id, `authorized`
  (operator‑sent, id‑based), mention flags, and `addressedToBot`. Media arrives
  via `onMedia(m)` (below).
- **Send:** `send(text, { chatId, replyTo })` and a streaming message primitive
  (`startStreamMessage`) for live token streaming.
- **The one transport‑specific media job:** download the bytes (Beeper assets
  API, Telegram `getFile`, …). Everything after the local file exists is
  nucleus.


Limbs in the body today: Beeper (PRIMARY WhatsApp + multi‑network transport,
local REST+WS), Telegram (off‑LAN; one bot = one being, e.g. `egpt_reve_bot` =
Wren), the home shell `kg`, the Chrome/Firefox extension (CDP).
**Landmine:** `telegram.mjs` is bundled into the browser extension, so it —
and anything it imports — must not pull in Node‑only builtins beyond what
`extension/build.mjs` externalizes. Node‑only services are *injected* by the
host, never imported into a bundled limb. `[[egpt-limb-agnostic-media]]`


### 2.2 The nucleus (`egpt.mjs` + `src/`)

The being's mind. Responsibilities, each a single chokepoint:

- **Routing** — a message reaches its brain through the nucleus on every
  surface; unified `@<sibling>` routing by canonical name + aliases;
  addressed siblings dispatch BEFORE `@e` so a direct address isn't
  stuck behind E's slow turn.
- **Emit gate** (`src/auto-mode.mjs` `mayEmit`/`mayEmitChat`,
  `fanOutDecision`) — I4/I5.
- **Dispatch line** (`src/dispatch-line.mjs` `formatDispatchLine`) — the exact
  shape the model sees (§4). One formatter, every call site.
- **Incoming media** (`_saveIncomingMedia` + `src/incoming-media.mjs`) — saves
  every attachment to the chat's `media/`, transcribes voice via an
  injected transcriber, posts the enrolled‑gated `👂` ack, surfaces
  image paths so a vision brain can `Read` them. Limb‑agnostic; the
  limb only supplies the file + a reply mechanism + the host's verdicts.
- **Rooms** (`src/rooms.mjs`, `src/room*.mjs`) — gated, loop‑safe fan‑out of a
  message to room members across surfaces.
- **Memory/continuity** — see §5.
- **Lifecycle** — see §6.


### 2.3 Brains/engines (`config/brains/*.mjs`)

Brain‑agnostic interface: `stream({ history, message }, onUpdate, options)` →
`{ text, optionsPatch }`. `options.sessionId` (when set) resumes a server‑side
thread; the brain captures a freshly‑minted id and returns it in
`optionsPatch` for the host to persist. Engines:

- **`claude-code` (ccode)** — the local `claude` CLI as a subprocess;
  `--resume` threads a session id (context carries server‑side,
  prompt‑cached — the CLI's "warm"); `--effort` is the reasoning lever the
  SDK can't set. Robust under tool‑heavy turns. Confinement via the tested
  `src/claude-args.mjs`.
- **`claude-sdk`** — LEGACY in‑process engine, being retired in favor of
  `ccode` background agents (§7); not used for new beings.
- **`codex`**, **`llama`** (`@l`, local llama.cpp
  on the GPU box, sessionless), **`don`** (`@d`, a remote
  eGPT reached over the LAN agent endpoint).


### 2.4 Beings (siblings)

- **`E`** — the gated public persona (the creation). Session +
  model in `default_brain`.
- **`Wren`** — meta‑engineer; the being you talk to to build eGPT.
  Bound to a Telegram bot by IDENTITY (`forceTarget`, no `@e`
  mangling). Runs on `ccode`, resuming a pinned engineering thread.
- **`L`** — local sessionless chatter; memory = its persona + a
  bounded tail of the chat's `transcript.md`.
- **`D`** — a remote sibling eGPT (e.g. on the GPU box) over an
  HMAC‑authed LAN endpoint; its reply rides the same gated + logged sibling
  path. `[[egpt-egpt-agent-channel]]`


The sibling registry (`EGPT_CONFIG.siblings.<name>`) is the source of truth:
`{ type, aliases?, session_id?, cwd?, model?, effort?, allowed_tools?, url?, body_emoji?, system_prompt_file? }`.

---


## 3. The life of a message (end‑to‑end)

1. **Limb receives** raw input off its transport. If it carries media, the limb
   downloads the bytes to a local file.
2. **Media → nucleus:** the limb calls `onMedia(m)`. The nucleus saves the
   file to `conversations/<surface>/<slug>/media/`, and for audio runs the
   shared `transcribeVoiceNote` (injected transcriber) → the transcript becomes
   the dispatch text, and a `👂 <transcript>` ack is posted **iff** the chat is
   enrolled and not muted (I7). The transcript reaches the model regardless
   (I3). For an image, the saved path is surfaced so a vision brain can
   `Read` it.
3. **Text → nucleus:** the limb calls `onIncoming(text, from)`.
4. **Classify** (nucleus): per‑chat mode, mention/mention‑direct, surface
   identity, operator (`authorized`, id‑based). Backlog older than connect −
   grace is held, not dispatched (I10).
5. **Record:** the inbound line is appended to `transcript.md` (I3).
6. **Format** the dispatch line (§4) — one formatter, node = entry point.
7. **Route:** addressed sibling → that being (dispatches before E). Otherwise
   the mode decides whether E is invoked. A reaction never triggers a reply
   (I5).
8. **Brain turn:** stream tokens via the engine; resume by `session_id`.
9. **Emit gate:** the reply passes `mayEmitChat` (I4/I5). `paused`
   kills it.
10. **Surface** through the originating limb (streamed message / send). The
    reply is appended to `transcript.md` tagged sent/not‑sent (I3).


---


## 4. The shape the model sees

Every inbound message a brain sees is identified as:

```
Sender@[chatname/groupname].{node} (HH:MM): body
```

- `{node}` is the ENTRY POINT the message came through —
  `wa` (WhatsApp), `kg` (home shell), `chrome`
  (extension), `tg` (Telegram) — resolved from the client/surface
  identity, NEVER hardcoded.
- Voice notes inline as `(voice transcription, Ns) body`.
- One formatter only: `src/dispatch-line.mjs` `formatDispatchLine`, wrapped by
  the nucleus and shared by every call site. (Contract C7.6.)


---


## 5. Memory & continuity

- **Per‑chat folder:** `~/.egpt/conversations/<surface>/<slug>/` with
  `transcript.md`, `media/`, optional per‑chat `config.yaml` +
  `heartbeat.md`. `slug` is a deterministic `sanitizeSlug`
  (display/storage only — NEVER an authorization key; I6).
- **`transcript.md`** — an 8‑day rolling window; older days archive to
  `memories/transcript-<date>.md`; per‑file serialized appends (no lost writes).
  Opens with a YAML **front matter** identifying the conversation — `name`,
  `thread_id`, `surface`, `slug`, `persona`, `notes` (one writer + reader:
  `src/transcript-meta.mjs`). The collector (planned ⏳) enriches it with
  `network` / `phone` / `type` / `participants` from the limb's chat metadata.
- **Heartbeat is per‑entity** — no global `@e` heartbeat; a
  `heartbeat.md` in a conversation's/room's folder is dispatched through the
  gate. `[[egpt-heartbeat-per-entity]]`
- **Media** — every attachment saved by default (`whatsapp.media.download`:
  `all` / `images_docs` / `off`), meaningful filename +
  sidecar caption + `index.md` entry; voice saved AND transcribed.
- **Continuity repo** (operator's working diary, separate git repo) — the
  human/AI activity log; the being's longer‑horizon memory across sessions.


---


## 6. Lifecycle (self‑running, self‑restarting)

- **Self‑restart:** drop `{type:'daemon-restart'}` into `~/.egpt/outbox/`
  (atomic write); the supervisor respawns the engine from disk — no UAC. Works
  for the spine AND remote workers over the file share. `/restart` (exit
  43) is the in‑band equivalent. `[[egpt-self-restart-via-outbox]]`
- **Durable logs:** `logOut`/`errOut` append to
  `~/.egpt/logs/`. The headless frame‑dump is lossy — don't trust it; trust the
  file (I9).
- **Workers (the GPU box):** `@l` = local llama‑server; the
  transcriptor = GPU whisper‑server (HMAC‑token, LAN‑firewalled, local
  whisper‑cli fallback); a supervisor reaps the stale port‑holder before
  respawning so a soft restart self‑heals.
- **Config:** `~/.egpt/config.yaml` (operator‑editable YAML; legacy
  `config.json` auto‑migrates), secrets in `config.local.json`, merged into
  `EGPT_CONFIG` at import. Read live where it matters so edits apply without
  a restart.


---


## 7. Warmth — beings are native background agents

- **Revived if not warm, per message, warm ~5 min, then reaped for memory
  efficiency.** There can be agents always in memory, configuration driven. A
  being is started with a thread (resume), a model, and an effort. It stays
  RESIDENT between turns and is reaped ~5 min after the last interaction.
  Consecutive messages in a conversation hit an already‑alive agent — no cold
  start, the conversation is kept *in the agent*, the transcript is NOT re‑fed
  each turn. Across an idle gap, context is restored warm‑from‑thread
  (`--resume`). Resume = the context; residency = the warmth; they are
  orthogonal.
- Background agents are resident + scriptable‑listable: `claude agents --json`
  enumerates live sessions (`id`, `sessionId`,
  `name`, `state`, `kind`; no TTY).
- A turn runs as long as it needs (no fake turn‑timeout).


**Build status (name the half‑state — §10).** The engine is the CLI, full stop —
no SDK. BUILT: the `ccode` engine (`config/brains/claude-code.mjs`) runs a
transient `claude -p --resume <id>` per turn (spawn → reply → exit), the interim
"resume‑per‑turn" form — so a being already has its context for free. OWED: the
RESIDENT‑warm policy above (config‑driven always‑on agents; attach‑if‑warm,
revive‑if‑dead, ~5‑min reap) — the prior sessions' "Unit 4." Until it lands a
turn still pays a process spawn; that is a latency gap to close, NOT an open
question about the architecture.


---


## 8. Config surface (orientation; the registry is authoritative)

`config/config-schema.mjs` is the machine‑validated registry of every
`EGPT_CONFIG.<key>` (the integrity test fails if `egpt.mjs` reads an
unregistered key — the config surface can't drift). High‑level shape:

- `whatsapp` — transport (`beeper`), media (`download`,
  `audio_transcribe`), `auto_e_chats`, `auto_e_default_mode`,
  `auto_e_paused`, `chat_id` (self‑DM).
- `telegram` — `bot_token` (in `config.local.json`),
  `allowed_users`, `agent` (the being the bot IS, default
  `wren`), `mirror` (route plain authorized messages to the
  agent), `show_think_chats`.
- `siblings.<name>` — the being registry (§2.4).
- `default_brain` / `default_brain_fallback` — E's engine + session + model.
- `transcription_endpoint` / `transcription_token` — remote‑first transcriber;
  absent ⇒ local whisper‑cli.
- `agent_token` — shared HMAC for the eGPT↔eGPT LAN endpoint.


---


## 9. Build & verify discipline

- **Documentation doesn't prevent regressions; a behavior test does.** Every
  invariant here and every contract in `CONTRACTS.md` earns a test as it is
  built/recovered. When you touch a path that implements an invariant, there
  must be a test that locks it.
- **Three complementary documents, one truth each:**
  - **GENOME.md** (this) — the heart + invariants + anatomy (the *why* and the
    *must‑never‑drift*).
  - **CONTRACTS.md** — the human‑readable behavior list with status flags
    (✅/⚠️/❓) (the *what*, recovered piece by piece).
  - **config-schema.mjs** — the validated config surface (the *knobs*).
- The full suite is the gate: a change that reds a contract test is wrong until
  proven otherwise.


---


## 10. Anti‑drift protocol (how to use this genome)

1. **Read §0–§1 before touching the nucleus.** If a change fights an invariant,
   the change is wrong.
2. **New behavior?** Amend this genome first (add/adjust an invariant or organ),
   then add a `CONTRACTS.md` entry, then a test. Never the reverse.
3. **New limb?** It only implements §2.1's contract. If you find yourself
   re‑implementing transcription, gating, logging, or routing in a limb, stop —
   that belongs in the nucleus (I2).
4. **New being?** Add it to the sibling registry; it rides the existing gated +
   logged path. Creation stays gated; meta‑engineers stay ungated and visible
   (I8).
5. **Versioned amendments.** This file is reviewed and amended deliberately;
   bump the status line (e0 → …) when the organism crosses a real threshold. The
   body (code) is the reference implementation; this is its DNA.


> The point of the genome is that the being can grow new senses, new selves, and
> a mesh of peers — and still be the same trustworthy eGPT. Keep the spine; let
> everything else evolve.
