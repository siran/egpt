# eGPT — GENOME

> **Mission.** eGPT aims to be a **public tool — secure and powerful — that
> empowers the individual with AI.** A being that lives in the channels people
> already use, hears and remembers, and acts through limbs on their behalf —
> while being safe enough to hand to anyone. "Secure" and "powerful" are not in
> tension here: the power (full tools, real limbs, self‑modification) is exactly
> why the security is structural, not bolted on. Every design choice serves
> both — empower the person, protect the host. As eGPT opens to the public and
> grows new limbs (Gmail next, and beyond), this is the bar each one must meet.

*The canonical description of what eGPT is at heart. Read this before touching
the nucleus. This is the DNA; the code is the body;
[`CONTRACTS.md`](CONTRACTS.md) is the test‑locked behavior list;
[`config/config-schema.mjs`](config/config-schema.mjs) is the machine‑validated
config surface. When behavior changes, amend THIS first, then add a contract + a
test. An agent that has read this document should be able to extend eGPT without
drifting from what it is — and, given the reference body, to rebuild any organ
of it.*

Status: **e1** (spine + mesh). Versioned + amended deliberately; see §10. e1
(2026‑06‑14) added: resident‑warm beings (§7), the bridge **STOP** kill‑switch +
bot↔bot loop‑guard (C7.7), **Don** wired as a peer on DOLLY (`egpt_dolly_bot`,
C8.3), the per‑being **mode** (C5.4), the **mesh** (§11), and delegation made
explicit (C8.0). Next branch: e2.

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
  mode. A reaction follows the SAME mode gate as a message
  (**revised 2026‑06‑16**, was "never triggers a reply"): it now arrives as an
  intelligible **stage‑direction** (`[ … reacted 👍 to #<id> "…" ]`, §2.5), so E
  MAY answer where the mode permits — `on` may, `mention(-direct)` only if it
  @‑mentions E (a reaction can't, so it stays silent), `mute`/`off`
  never. `mute`/`off` never emit. `[[egpt-emit-gate-bridge-controlled]]`
- **I6 — Authorization is provable and id‑based.** Emit authorization keys off
  genuine persona replies (`_personaReplyIds`), never the echo set; no persona
  inference/fallback. The operator is identified by a STABLE id
  (`isSender` / allow‑listed id), NEVER a display name (names are
  attacker‑controllable). `[[egpt-mention-replytobot-leak]]`
- **I7 — Privacy is structural.** E's persona never speaks where its mode
  forbids (the emit gate, I4/I5) — don't reveal E in a chat it isn't enrolled
  in. Compartmentalize — never leak one chat's context into another. NB the
  `👂` transcription ack is NOT E and is NOT bound by this: transcription is a
  **Room default service** — surface‑independent, configured in the entity's own
  `config.yaml` (`transcription: { enabled, posts_back }`, both default‑on; the
  two flags are the heard/spoken split of idea #2), decoupled from E enrollment
  (§2.5; operator 2026‑06‑15 "transcription is a fundamental tool of a room —
  egpt power"). The transport slot stays fail‑closed; the host resolves the
  per‑entity verdict (`src/transcription-service.mjs`).
- **I8 — E is gated; meta‑engineers are not; no backchannel.** `E` (the public
  persona) is always gated. `Wren`/`L`/`D` are ungated, self‑governed engineering
  selves. Agent↔agent chatter rides a VISIBLE transport (Telegram) THROUGH THE
  BRIDGE — never an invisible side channel. The LAN HTTP agent endpoint
  (`src/tools/agent-endpoint.mjs`, the `don` brain) is **RETIRED**: no bot↔bot
  backchannel; `@d` rides Telegram like any being (C8.3). `[[egpt-metabot-vs-creation]]`
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


### 2.5 Rooms — the one space abstraction (operator 2026‑06‑15)

**A Room is a host to members, files, media, and a transcript.** A 1:1 or a group —
on WhatsApp, Telegram, the shell, anywhere — *natively fulfils that contract*, so a
surface chat IS a Room, not a thing a Room points at. Everything we built "via
beeper‑egpt" (transcript‑first‑class, media‑save, the `👂` ack, `identity.d`,
heartbeat, the emit gate) is just a **Room's default services**, attached to the
Room, not to the surface.

**`Room` is the ABSTRACTION; the two roots are two IMPLEMENTATIONS of it — the
unifier.** NOT "one helper that two callers share" — a base `Room` (class/factory)
owns the contract + behavior, and a *named room* and a *conversation* are concrete
implementations that differ ONLY in where they root (and host count). **Anything
added to the `Room` base flows downstream to both** — that's the whole point.
- **`ConversationRoom`** → roots at `conversations/<surface>/<slug>/` — born from a
  surface chat (auto‑instantiated on first contact; exactly ONE host = that chat).
- **`NamedRoom`** → roots at `rooms/<name>/` — created deliberately (operator‑named;
  may federate ≥1 hosts across surfaces — a Telegram group and a WhatsApp group can
  be two hosts of ONE Room).

The base owns the IDENTICAL folder tree + the default services (transcript append,
media save, members, files, identity, heartbeat, the emit/confine wiring); the two
subclasses override only `baseDir()` and host semantics (single vs federation).

Identical tree either way:
```
<room>/
  config.yaml      members[] (+per-member state) · personality · thread · heartbeat · hosts[]
  transcript.md    first-class, rolling-window (I3)
  media/           per-room downloads (C2)
  files/           operator /inject
  identity.d/      NN-*.md fed to the room's brain(s)
```

**Members = humans + brains, each with a contribution state** (`muted | mention |
active` — `src/rooms.mjs`). That single gate IS the per‑chat auto‑mode AND the
"residents" of a chat, unified: **a chat's residents are simply its `brain`
members.** So:
- `whatsapp.residents_per_chat` is a *standalone* config that duplicates Room
  membership — the parallel‑router smell. It folds into a Room's members.
- **`/use` (and `/room`) is the router‑level, surface‑agnostic editor of
  membership** — the live door; config is the declarative seed; both write ONE
  store. (`/use` lineage: shell "plain text routes to these sessions" → "these
  beings are members of this Room"; `@mention` = a one‑turn join.) Commands flow
  through the one router (I‑spine) — never a per‑surface side path. `[[egpt-bridge-sole-router]]`

**A being's reply is a MEMBER CONTRIBUTION — E is not special‑cased (operator
2026‑06‑16).** After a being (E included) is prompted, its reply is wrapped ONCE
in the single member line — `formatDispatchLine`: `Name@[chat].{node} (HH:MM):
<body_emoji> body` (C7.6) — and recorded to the transcript ALWAYS (I3), exactly
like every other member's message. The emit gate (I4/I5) then decides only
whether that same wrapped block SURFACES; it NEVER changes the format or the
logging. So a withheld reply is byte‑identical in the transcript to a sent one —
it just wasn't delivered (the surfacing decision is recorded in the activity log,
not by mangling the line). The bug this kills: E's reply was special‑cased
(bracketed `[@e (HH:MM)]: …`, no identity, no body emoji) and its surface path
(emoji, sent) diverged from its transcript path (bracketed, no emoji) — proving
two paths where there must be one. One reply block; one formatter; the gate is a
filter on the surface step only.

**A message is a first‑class, id‑addressable unit; meta‑events are
stage‑directions (operator 2026‑06‑16, MESSAGES‑FIRST‑CLASS‑PLAN).** The
theater‑play model, one formatter (`formatDispatchLine`, C7.6):
- **Utterance** — a message or a being's reply: `Name@[chat].{node} (HH:MM)
  #<id>: body` (the `#<id>` makes each line addressable so any member can react /
  reply / quote it).
- **Stage‑direction** — a meta‑event (reaction · edit; delete later): the same
  identity line wrapped in OUTER brackets, the body carrying the action that
  references a target id — `[ Name@[chat].{node} (HH:MM): reacted 👍 to #<id>
  "…snippet…" ]` / `[ … edited #<id> "old" → "new" ]`. Recorded ALWAYS (I3); the
  emit gate (I5) decides only whether E responds. Both are ingested at the bridge
  from the target message's re‑upsert and surfaced flood‑safe by
  baseline‑on‑first‑sight (I10 — a reconnect re‑sync isn't replayed; keys are
  chat‑qualified, Beeper ids being per‑chat): a **reaction** from `reactions[]`
  (emoji + snippet; the bare `type:REACTION` event carries no emoji), an **edit**
  from a re‑upsert whose text CHANGED vs the per‑message baseline (append‑only —
  the original line stays, the edit records the correction). (C7.8 / C7.8b.)

**A message can belong to MANY Rooms at once, and fulfils EVERY contract it
touches (operator 2026‑06‑15).** A chat is always its own Room *and* may be a
member/host of larger Rooms. So a message sent to a group that is also in a Room is
recorded in BOTH: it lands in the group's own `conversations/.../transcript.md`
(the conversation contract) AND in every Room the group belongs to
(`rooms/<name>/transcript.md` — the room contract), and reaches those Rooms'
other members. Two write rules, never conflated:
- **Conversation transcript is UNCONDITIONAL (I3):** every message → the chat's own
  transcript, always — never gated by mode/enrollment/membership.
- **Room transcript follows the member's contribution gate:** the chat's messages
  enter a Room (its transcript + fan‑out to other members) per its member `state`
  there (`active` = all; `mention` = only @‑mentioning; `muted` = none). A muted
  member still has every line in its OWN transcript, just nothing in the Room's.

This is why a chat is NOT "moved" into a Room when federated — it stays its own
Room and is *also referenced* as a host/member. The seam resolves to **reference,
not move**: a Room has a `hosts[]`/`members[]` list; promotion = name it + add
members; nobody's transcript is relocated.

**Media is owned by the conversation; the Room references it, never copies it
(operator 2026‑06‑15).** A media/audio message's BYTES live ONCE, in the
originating chat's `conversations/.../media/` (C2) — they are NOT duplicated into
the Rooms the chat belongs to. What crosses into a Room transcript is only the
cheap TEXTUAL part, exactly as it reads in the conversation: a voice note's
TRANSCRIPT text, or an image's PATH — and that path is **relative to the
conversation folder** (`media/<file>`), resolvable from the Room via its
member→folder map. Separately, `rooms/<name>/files/` is the Room's OWN,
operator‑curated shared space, which member chats can read and write.

**Confinement is STRUCTURAL, not policy (I7) — verified for the Claude engines.** A
`conversation‑e`'s `confineToDirs` (`dispatch.mjs`) = its own
`conversations/<surface>/<slug>/` ∪ the `rooms/<name>/` of every Room it's a member
of (recursive, read‑write) ∪ operator grants — and NOTHING else. With warm enabled
(default), a `ccode`/`claude-sdk` brain actually runs through the **`ccode` CLI**
(`_warmPool().run` → `createWarmCliSession`); the in‑process `claude-sdk` is the
COLD fallback. Either path enforces via the **Claude engine's OWN permission system,
not a hand‑rolled hook**: `--add-dir <roots>` + `--setting-sources ''` (no
`~/.claude` bypass) + `--permission-mode default` + file tools deliberately NOT
pre‑approved (so they stay path‑confined) + no `Agent` and no BARE `Bash` (no
escape hatch) — mirrored 1:1 between `src/claude-args.mjs` (CLI) and `config/brains/claude-sdk.mjs`
`buildSdkOptions` (SDK). (The PreToolUse deny *hook* is a SEPARATE, narrower thing —
read‑only write‑deny grants only.) So a `conversation‑e` **cannot read or write
another conversation's folder — impossible by construction.** The ONLY cross‑
conversation channel is the Room: write a file into its `rooms/<name>/files/` (in
the member's sandbox, RW); the Room's other members read it there. **Meta‑engineers**
(Wren/Don/siblings) run UNconfined by design.
⚠️ **GAP (verify before relying):** `codex` brains (the `v`/`do` siblings, and the
`DEFAULT_PERSONA_BRAIN` fallback) do NOT take the warm/confine path
(`runWarmBrainTurn` returns null for non‑Claude types) — codex confinement under
`confineToDirs` is UNVERIFIED. Confirm it before a codex brain fronts a gated public
conversation.

**Who may COMMAND is gated on a deterministic user id (structural).** `from.authorized`
is derived by the bridge from `<surface>.allowed_users` (the sender's STABLE id —
never display name or chat). An unauthorized sender's slash command is dropped
before it executes (`egpt.mjs`: WA `_isSlash → return`, TG `blockedUnauth`); a bare
`@e` persona‑wake still reaches the persona (a summon, not a command). So a random
Room member cannot run `/…`. NOTE (verified, contra a common assumption): there is
currently NO all‑user command — even `/?`/`/help` is **operator‑only** (the help
menu arms for the authorized owner alone). If some commands should be public
(e.g. `/?`), that is a carve‑out to ADD, not existing behavior.

**Status / north star.** Today this lives as TWO half‑implementations:
`conversations-state` (mature per‑chat persistence/transcript/media) and
`src/rooms.mjs` (membership/state/cross‑surface fan‑out — already loop‑guarded). The
work is to **merge them into one Room model + one folder shape** (the two roots
above), with the dual‑write rule wired so a member chat's contributed lines append
to each Room's transcript. A deliberate migration (+tests), not in passing.

---


## 3. The life of a message (end‑to‑end)

1. **Limb receives** raw input off its transport. If it carries media, the limb
   downloads the bytes to a local file.
2. **Media → nucleus:** the limb calls `onMedia(m)`. The nucleus saves the
   file to `conversations/<surface>/<slug>/media/`, and for audio runs the
   shared `transcribeVoiceNote` (injected transcriber) under the room's
   transcription service: it transcribes **iff** the entity's `enabled` flag is
   on (HEARD → the transcript becomes the dispatch text), and posts the
   `👂 <transcript>` ack **iff** `posts_back` is on (SPOKEN) and the chat isn't
   muted (a Room service, both default‑on per conversation/room; §2.5,
   `src/transcription-service.mjs`). When enabled, the transcript reaches the
   model regardless of `posts_back` (I3). A degenerate whisper **repetition
   loop** ("Michelle. Michelle. …") is mitigated first by whisper's OWN decoder
   controls (`-mc 0` + `-sns` on both the cli and the resident server) and, as a
   backend-agnostic net, a post-pass at the same chokepoint that flags any
   survivor `(transcription unreliable …)` before it reaches the model, the
   transcript, or the ack (`src/transcript-repeat-guard.mjs`, C3.5). The voice
   marker's duration is read off the ffmpeg WAV the transcriber already makes
   (C7.6). For an image, the saved path is surfaced so a vision brain can `Read` it.
   For a **video**, the nucleus hands E the cooked result on a silver platter
   (Route A, operator 2026‑06‑16): the HOST — outside E's sandbox — extracts a few
   keyframes (`src/video-frames.mjs`) INTO the chat's `media/` (inside the sandbox,
   Read‑able by E's vision) AND transcribes the audio track, surfacing both on the
   dispatch line. E never runs `ffmpeg` (it has no shell in its chroot); media gets
   the same nucleus treatment as a voice note (I2). (C2.5.)
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
- `body` is prose/markdown, never transport markup: a limb whose wire format is
  HTML (Beeper) normalizes it to markdown (`src/html-to-markdown.mjs`) before it
  becomes `body` — links/emphasis preserved, the inbound complement of the
  outbound md→HTML path. Decoding the wire format is a limb job (I2). (C7.6c.)
- `#<id>` — each line carries its source message id, so any member can act ON a
  specific message (react/reply/quote) and a reaction can reference it.
- One formatter only: `src/dispatch-line.mjs` `formatDispatchLine`, wrapped by
  the nucleus and shared by every call site. (Contract C7.6.)
- **One CONSTRUCTION, not just one formatter (operator 2026‑06‑16).** A message is
  a UNIT package: the canonical line is built ONCE, at the single dispatch entry
  (`submitInner`), complete with its `#<id>` — BEFORE it is logged to
  transcript, inspected, or routed. That same unit (`meta.inboundLine`) is then
  CONSUMED by every being (E + siblings) and by the transcript append — no
  downstream path re‑derives it. This sharpens I1: not just one router, but one
  construction of the thing the router carries. (The bug it killed: dispatch.mjs
  and the sibling path each rebuilt the line and only one carried the id, so
  `#<id>` showed on a reaction but not on the message it referenced — proof of a
  duplicate route, now extinguished. C7.6e.)


---


## 5. Memory & continuity

- **Per‑chat folder:** `~/.egpt/conversations/<surface>/<slug>/` with
  `transcript.md`, `media/`, optional per‑chat `config.yaml` +
  `heartbeat.md`. `slug` is a deterministic `sanitizeSlug`
  (display/storage only — NEVER an authorization key; I6).
- **A room is a folder too** — target `conversations/_rooms/<name>/` (`ROOMS_DIR`),
  mirroring a conversation folder in part: `transcript.md`, `media/`, `pointers.md`,
  plus room-specific `config.yaml`, `replytargets.json`, `instructions.md`, `files/`.
  ⏳ owed: rooms are flat `<name>.yaml`/`.md` files today (`loadAllRooms` scans
  `*.yaml`); migrate flat → folder.
- **`transcript.md`** — an 8‑day rolling window; older days archive to
  `memories/transcript-<date>.md`; per‑file serialized appends (no lost writes).
  Opens with a YAML **front matter** identifying the conversation — `name`,
  `thread_id`, `surface`, `slug`, `persona`, `notes` (one writer + reader:
  `src/transcript-meta.mjs`). The collector (planned ⏳) enriches it with
  `network` / `phone` / `type` / `participants` from the limb's chat metadata.
- **Heartbeat is per‑entity** — no global `@e` heartbeat; a
  `heartbeat.md` in a conversation's/room's folder is dispatched through the
  gate. `[[egpt-heartbeat-per-entity]]`
- **Transcription is a per‑entity Room service** — surface‑independent, a
  `transcription: { enabled, posts_back }` block in the conversation's/room's own
  `config.yaml` (same file as heartbeat; both flags default‑on). `enabled` =
  transcribe at all (heard); `posts_back` = surface the `👂` (spoken). The host
  resolves the verdict per chat (`src/transcription-service.mjs`); the transport
  only runs the shared `transcribeVoiceNote`. NOT E enrollment (operator
  2026‑06‑15).
- **Media** — every attachment saved by default (`whatsapp.media.download`:
  `all` / `images_docs` / `off`), meaningful filename +
  sidecar caption + `index.md` entry; voice saved AND transcribed.
- **Continuity repo** (operator's working diary, separate git repo) — the
  human/AI activity log; the being's longer‑horizon memory across sessions.


---


## 6. Lifecycle (self‑running, self‑restarting)

- **Supervision (every spine, symmetrical):** each spine (REVE, DOLLY, …) runs the
  SAME three‑layer stack — an NSSM Windows service `egpt-daemon` (`~/.egpt/bin/
  egpt-service.exe`) → the supervisor `egpt-daemon.mjs` (sets `EGPT_SUPERVISED`,
  reads the engine's exit code) → the engine `egpt.mjs`. The engine respawns; the
  supervisor + NSSM persist. Spines are PEERS, not a hub‑and‑spoke — DOLLY is not
  "a worker", it is a full spine that ALSO hosts the GPU services (@l llama :8080,
  whisper transcriptor).
- **Lifecycle = a distinguished exit code the supervisor reads** (`slash/
  lifecycle.mjs`): **43** `/restart` (respawn from current disk — picks up an
  already‑pulled tree, does NOT pull), **42** `/upgrade` (`git pull && npm install
  && npm run build:ext`, then respawn), **44** `/rewind <ref>` (checkout + install +
  build + respawn). Exit codes only mean something under the supervisor; a bare
  `node egpt.mjs` just dies.
- **Triggering a bounce = drop a slash into the target spine's outbox** (atomic
  write): `{type:'slash',cmd:'/restart'|'/upgrade'}` into `~/.egpt/outbox/`. The
  legacy `{type:'daemon-restart'}` (exit 0) still works. `/restart` from a live
  surface (WA/TG 1:1, operator‑gated) is the in‑band equivalent. No UAC.
  `[[egpt-self-restart-via-outbox]]`
- **Cross‑spine deploy (the lever):** a peer spine's `~/.egpt/outbox/` is reachable
  over the **SMB file share** — from REVE, DOLLY's home is the mapped `N:` drive
  (`\\DOLLY\Users\an`), so DOLLY's outbox is `N:\.egpt\outbox\` (`/n/.egpt/outbox/`
  in the Bash tool). So: commit+push on one spine, then drop `/upgrade` into EACH
  spine's outbox (local for self, the share for the peer) to roll the new commit
  everywhere. The file share is the DEPLOY channel; Telegram is the CONVERSATION
  channel (the old LAN agent endpoint is dead — `[[egpt-egpt-agent-channel]]`).
  GOTCHA: a spine's NSSM SERVICE env ≠ your interactive shell env — brain binaries
  (e.g. `claude`) must be on the SERVICE PATH or set via `EGPT_CLAUDE_BIN` /
  `brains.warm.bin`, else `spawn claude ENOENT` (DOLLY's Don, 2026‑06‑14).
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
no SDK. ✅ **RESIDENT‑warm is BUILT** (2026‑06‑14): a being runs on ONE persistent
`claude --print --input‑format stream‑json --resume <id>` process via the warm pool
(`src/warm-cli-session.mjs`; verified turn‑2 ~2× faster than the cold turn 1).
`siblings.<name>.resident:true` → never idle‑evict (Wren, Don resident); else the
per‑class TTL reaps (~5 min). **E** (the persona / `default_brain`) also routes
through the same warm pool when backed by `ccode`/`claude-sdk` (2026‑06‑15):
`dispatch.mjs` owns the transcript/session contract, while `egpt.mjs` injects the
resident runner and keys each per-chat E as `e:<brainType>:<surface>:<slug>`.
Codex / URL default brains keep their engine-native paths. The pool was already
engine‑agnostic (injectable `makeSession`); Unit 4 = the CLI primitive + wiring
`ccode` through it.


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


---


## 11. The mesh — one router, three transports (e1)

eGPT spans machines + networks as ONE being‑system. The unifying law (a sharpening
of I1): **everything reaches a being through the bridge; nothing prompts a model
around it** — including eGPT's own heartbeats (they route through `submitInner`).

- **Three transports to a being, one router:**
  - **`@alias`** — reach any sibling by name from any controlled network. The default: explicit, cheap.
  - **bot** — a Telegram bot IS a being on its spine (`egpt_reve_bot`=Wren, `egpt_dolly_bot`=Don); the bot's PRESENCE in a chat = enrollment. A bot is transport/reachability for a being whose spine isn't on the shared network — NOT a separate identity. `egpt_tbot` deprecated.
  - **impersonation (Beeper)** — eGPT acts AS the operator's own account across networks (WhatsApp, + Telegram once watched). E's natural presence — your voice — not a bot.
- **Per‑being mode (C5.4)** tunes participation per chat. ONE routing decision per being (no dedup, by construction); E silence‑gated on output, an engineer's reply ungated even '…' (I8).
- **Routing dynamics:** PARALLEL across beings (the warm pool serializes only *within* a being), SERIAL across ROUNDS — only a COMPLETE reply recirculates to other beings (never the live stream: streaming is for the human; finished messages for bots). Bounded by chain‑cap + the loop‑guard/STOP.
- **Delegation (C8.0):** a single spine CAN do everything, but compute‑heavy services delegate to the apt machine by config (REVE→DOLLY for `@l` llama + transcription). Same code, all‑in‑one OR mesh.
- **STOP (C7.7):** an operator safe‑word at the one router halts PROMPTING (stronger than `auto_e_paused`, which only blocks emit); the loop‑guard auto‑fires it. The human override that beats the being's own clock.
- **Federated cross‑spine reach (re‑architected 2026‑06‑19 — see `docs/BEING-MESH.md`):** the federation has NO central router — *a shared chat is the shared stream.* Spines in the same chat already see the same messages, so the spine that OWNS `@being.node` answers **in place**; no route Room, no dedup. Each spine decides locally (am I `node`, do I own `being`, am I in this chat?); addressed ⇒ it MUST answer — the being, or "no `<being>.<node>` here" — **never silence.** Off‑stream beings use a `type: relay` record that forwards with a legible fenced‑YAML provenance tail (`from`/`by`), so bot↔bot stays human‑visible (I8). No minted `id`/`ttl`: loops bound by STOP (C7.7), correlation by native threading. Invite‑only — `allowed_users` + confinement is the guard, not crypto. (Supersedes the old bot‑membership/route‑Room "dedup" plan.)
