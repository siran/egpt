# eGPT — operator manual

The v2 operator reference: how to drive a running node and what every config key
does. For what eGPT *is*, read [`GENOME.md`](GENOME.md); for setup, the
[`README.md`](README.md); for the test tiers, [`TESTING.md`](TESTING.md).

eGPT runs as a background service (the daemon supervises the spine) against a
profile directory `EGPT_HOME` (default `~/.egpt`; the rewrite node runs with
`EGPT_HOME=~/.egpt`). It reaches every network through **Beeper Desktop's local
API**. You operate it from your **Self-DM** on any surface.

---

## 1. Commands (from the Self-DM)

A slash command typed in an authorized chat is intercepted by the node itself,
not answered by the persona. Authorization = the surface's own `chat_id`
(Self-DM), an entry in that surface's `allowed_users`, or the account owner.

```text
/status                                        compact node health (fenced yaml):
                                               git sha + subject, pid, uptime,
                                               last alive-beat age, heartbeat
                                               count, conversation count, this
                                               chat's E mode
/agents[=<slug>] <handle>|all                  live status of a resident being
                                               (fenced yaml, resolved fresh from
                                               config — never a stale snapshot).
                                               `all` covers every resident being.
                                               omit `=<slug>` for this chat; from
                                               the Self-DM name a target
                                               (slug/name fragment, or a verbatim
                                               @jid / room-id)
/agents[=<slug>] refresh <handle>|all          SMALLEST: keep the thread, re-feed it.
                                               <chat>/directives/ is re-copied from
                                               the current template right away, and
                                               the being's identity goes back into
                                               its RUNNING thread on that thread's
                                               next turn. Nothing is moved, no new
                                               thread, the context is kept
/agents[=<slug>] rethread <handle>|all         MIDDLE: clear only this being's
                                               threadId (mode, access_level, every
                                               other field survive) and roll
                                               transcript.md into transcripts/ under
                                               the retiring thread's id. The chat's
                                               FOLDER stays where it is. Next
                                               message starts a fresh thread. Named
                                               `restart` until 2026-09-10 — that
                                               word is /restart, the NODE's
                                               lifecycle, and is now refused here
/agents[=<slug>] reset <handle>|all            BIG: reset THIS being on THIS chat:
                                               archive the chat's WHOLE folder aside,
                                               wipe this being's registry block
                                               (mode, threadId, all of it — a
                                               sibling's own state survives) EXCEPT
                                               access_level/allowed_users, durable
                                               grants that survive the reset,
                                               reseed pristine — next message
                                               starts fresh
/agents[=<slug>] auto <mode> <handle>|all      set a being's reply mode
/agents[=<slug>] access_level <regular|all|sandbox> <handle>|all
                                               point a being at a confinement
                                               tier: this node's regular
                                               default, the unconfined one, or
                                               the OS-sandboxed one (see below)
/restart                                       bounce the node (daemon respawns
                                               the current checkout)
/upgrade                                       git pull + npm install + rebuild,
                                               then respawn
/rewind <ref>                                  git checkout <ref>, reinstall,
                                               respawn
```

**Reply modes** (`/agents … auto <mode>`): `on` (receive every burst, reply per
personality) · `mute` (receive, never reply) · `mention-direct` (reply only when
`@e` starts the message or it replies to E) · `mention` (reply when `@e` appears
anywhere, or a reply to E — the default) · `accum` (the `mention` gate, and each
reply is prompted with everything said here since the being's own last turn) ·
`off` (don't receive at all).

`accum` changes only WHAT a turn is prompted with, never WHEN one happens — it
does not buffer, batch, or flush on a heartbeat. (The 2026-07-01 accum did; same
word, different mechanism.)

### `/agents … access_level` — the confinement tiers

`/agents <handle>|all access_level all` points the being at
`config/permissions/all.md` — full filesystem, bare Bash — read fresh every turn
(not a freeze; editing that file changes behavior for every conversation pointed
at it immediately, no re-run needed). `/agents <handle>|all access_level
regular` points it back at the node's regular confined default. It touches ONLY
tool access — agent/model/effort/engine are untouched either way, and are never
pinned per-conversation any more: a conversation always resolves its
engine/model/effort/tools FRESH from config.yaml's `agents:` block, every turn
(point `agents.<being>.configuration` at whichever type file conversations
should run on). The warm session is evicted so the change takes effect on the
very next turn — no `/restart` needed.

`/agents <handle>|all access_level sandbox` is the third tier: it points the
being at `config/permissions/sandbox.md`, which is `all.md`'s grant byte for
byte, but the spine forces `sandboxed: true` for that level, so the being only
ever runs inside the OS sandbox — the kernel holds the boundary instead of the
CLI's own flags, and no config rung can unbox it. `regular`, `all` and
`sandbox` are the whole set (`ACCESS_LEVELS`, src/spine/permission-levels.mjs);
the command's usage line is built from it, so it can never name fewer than
exist.

### The three lifecycle verbs

`refresh`, `rethread` and `reset` are three different sizes of the same
instinct — "give this being a clean start" — and until 2026-09-10 the first one
did not exist and the second was called `restart`. Pick by how much you want to
throw away:

| | `refresh` | `rethread` | `reset` |
|---|---|---|---|
| Thread | **kept, still running** | new one next message | new one next message |
| `transcript.md` | untouched | rolled into `transcripts/<old-thread>.md` | goes with the archived folder |
| Conversation folder | stays; `directives/` re-copied | stays; `directives/` re-copied on the next turn | archived aside, reseeded pristine |
| Registry block | only `identityInjectedAt` cleared | only `threadId` cleared | wiped, except `access_level`/`allowed_users` |
| Context the model holds | **kept** | dropped | dropped |
| Use it when | you edited a card or an identity and want the LIVE conversation to know, without losing what it is in the middle of | this thread is stale/confused but the chat's history and settings are fine | the history itself is the problem |

`restart` is NOT one of them. `/restart` is the node's own lifecycle (the
daemon respawns the checkout); typing `/agents restart <handle>` is refused by
name and tells you to use `rethread`, rather than quietly doing something
adjacent to what you meant.

### `/agents refresh …` — re-feed the running thread

The smallest of the three, and the only one that keeps the conversation's
context. Two halves, and the reply tells you which is which:

- **On disk, immediately** — `<chat>/directives/` is re-copied from the current
  room template, overwriting what is there. That is how an edited card
  (`10-actions.md` learning a new limb) reaches a conversation seeded months
  ago. Your own hand-edits inside `directives/` are overwritten; the source is
  the template, these are consult copies.
- **In context, on the next turn** — the being's identity feed goes back into
  the thread it is already running, as the next message's preamble. It cannot
  land sooner: an idle CLI session has nothing to push a message into. The
  confirmation says so rather than claiming it already happened.

Nothing is moved, no thread is minted, and `mode`/`access_level` are untouched.

The identity feeds at four moments: **start**, **refresh**, **rethread** and
**compaction**. The last one is not a command — auto-compaction (§2, the
`compaction` config block) native-`/compact`s a grown session in place, which
rewrites its context and can summarise the kickoff feed away. A compact that
succeeds therefore arms the same re-feed `refresh` does, and the being's next
turn carries its identity again on the same thread. A compact that FAILED arms
nothing: the log and the registry say the same thing about what happened.

### `/agents reset …` — start a being over

Archives the conversation's whole folder aside
(`conversations/archive/<slug>-archived-<suffix>/`, never deleted), wipes the
TARGET being's registry state (mode, thread) — a sibling being resident on the
same conversation, if not also named, is untouched — and reseeds a pristine
tree at the same path. The next message starts a fresh thread. `/agents reset
all` wipes every resident being on the conversation in one call.

`access_level` and `allowed_users` are durable operator-set grants, not
session state — `reset` preserves them (captured before the wipe, reapplied
after the reseed) rather than silently dropping a being back to the node's
global default. A being with neither set behaves exactly as before: fully
wiped.

Was `/e reset`/`/e auto`/`/e access` (retired 2026-08-15): hardcoded to the
persona's own map key, so it could never reach a sibling being on the same
conversation — `/agents` fixes that by taking the being explicitly.

### `/agents rethread …` — a new thread, keeping the chat

Narrower than `reset`, on purpose. `/agents rethread <handle>|all` clears
**only** that being's `threadId` (a merge, not a wipe) — `mode`,
`access_level`, and every other field on the being's registry block are left
exactly as they were — and rolls `transcript.md` into
`transcripts/<retiring-thread>.md`, leaving a blank one behind. The
conversation FOLDER itself (`media/`, `files/`, `directives/`) is **never**
archived or moved.

If the transcript could not be rolled — nothing written yet, or the file names
no thread to file it under — the confirmation says `transcript.md was NOT
moved` instead of claiming it went. The thread half still happened.

Identity reseeding is not synchronous: it happens lazily the moment the being's
next real message arrives (the same `fresh = !sessionId` path a never-before-seen
thread always takes). A warm CLI session left over from before is handled
automatically too: the pool's own session-identity guard notices the next turn
asks for a null session and reopens fresh, with no separate eviction step here.

### Lifecycle without a chat (the ingest box)

Drop a file whose content is the command line into `~/.egpt/state/ingest/` —
the spine sweeps that folder (~1 s), runs the line, and consumes the file. Write
to a temp name then rename for atomicity (the sweep skips dotfiles + `*.tmp`).
This is how `/restart` / `/upgrade` / `/rewind <ref>` work when you can't reach a
chat.

---

## 2. Config (`~/.egpt/config/config.yaml`)

Start from `config/skeletons/config.yaml` (every key is documented inline and
registered in `config/config-schema.mjs`). What ships uncommented is a working
default; commented blocks are optional overrides.

| Key | Purpose |
|---|---|
| `beeper_token` | The one credential — Beeper Desktop → Settings → Developer → Desktop API. |
| `user_name` | Your handle, shown in cross-surface mirroring as `<user_name>@<surface>`. |
| `emojis` | Author tags for mirroring: `user` / `egpt` / `persona` / `human`. |
| `agents` | **Required.** The unified registry: persona, local beings, and mesh relays. Each agent = `{ configuration, personality?, handles, relay_channel? }`. `configuration` names an agent-type file (`config/agents/<type>.yaml`), an inline map, or the literal `relay`. `personality` names `config/agents/identities/<name>.md` and sits BESIDE `configuration` — a being composes a shared brain def with its own identity, no per-being type file needed; it outranks a `personality:` written inside the def, and absent both it is `egpt`. A node without an `agents` block or a persona entry (handles include `e`/`egpt`) refuses to boot. |
| `whatsapp` / `telegram` / `signal` | Per-surface auth: `{ chat_id, allowed_users }` (empty = deny). Ids are per-surface namespaces. `whatsapp` also carries the transport config (`networks: []` = the firehose). |
| `default_time_zone` | Interprets timezone-less heartbeat `when:` times (IANA name or an alias like `ET`/`PT`). |
| `warm` | Warm-session policy: `max` (how many chats stay resident) + `idle_ttl_by_class.conversation` (quiet-time before eviction; default 15m, `-1` = never evict, `0` = always). A chat overrides its own TTL in its folder's `config.yaml`. |
| `flood` | Send-flood guard: more than `limit` bot sends to one chat within `window_ms` pauses THAT chat for `cooldown_ms`. |
| `compaction` | After a quiet `cooling_ms`, if the warm session grew past `ratio` of the context window, native-`/compact` it in place (transcript.md keeps the full record). A compact that SUCCEEDS then arms the identity re-feed, exactly as `/agents refresh` does, so the being gets its identity back on its next turn — `/compact` rewrites the context, and the kickoff feed can be summarised out of it. A compact that fails arms nothing. |
| `heartbeats` | Declarative timers — see §3. |
| `transcription_service` | Voice-note transcription — see §4. |

Agent types are resolved across layers, most-specific winning: `src/brains`
(built-in) < `config/agents` < a conversation's own `brains/`. A type's
`allowed_tools` LIST confines its file tools to the conversation dir +
`allowed_paths`; `allowed_tools: all` makes it trusted/unconfined. Point
`agents.egpt.configuration` at whichever type conversations run on — every
conversation resolves it FRESH every turn, so a repoint reaches all of them on
their very next turn (there is no per-conversation freeze).

---

## 3. Heartbeats + textecutables

A heartbeat is a declarative timer: `<name>: { <trigger>, <action> }`. It can
live in the node's `heartbeats:` config block, or in any conversation's /
room's own `config.yaml`.

- **Trigger** — `frequency: <ms|"30s"|"5m"|"1.5h">` (recurring) OR `when: <one-shot
  wall-clock time>` (`7/2/2026 8:20a`, `2026-07-02T08:20`, ...; zone from
  `default_time_zone`). Both set = invalid, skipped.
- **Action** — `command: <shell line>` OR `script_path: <script.x.md>` (sugar that
  runs a textecutable). Both set = invalid, skipped. The path is relative to the
  folder the beat was declared in — the chat/room folder, or the checkout for a
  node-level beat — **not** to a `scripts/` subfolder. (This key was `ai_run:`
  until 2026-08-22; an entry still carrying it is invalid, skipped + logged.)

The spine materializes the resolved set to `~/.egpt/heartbeats.readonly.yaml` —
at the profile root, beside `config.readonly.yaml` and
`conversations.readonly.yaml` (spine-written — don't edit them; edit the rung
file instead). Every row names its `source:`, the file it was read from.
`heartbeats` is the config resolver's one UNION block: an entity declaring a beat
CONTRIBUTES one, it never replaces the node's. **Config refresh:** a rung-file
edit takes effect automatically on the next inbound message (or at boot/restart)
— no action needed, no file to delete (new chat folders picked up the same way).
Paste-ready template: `config/skeletons/heartbeats.yaml`.

A **textecutable** is a `*.x.md` file whose interpreter is one fresh `claude`
turn with tools — the file IS the program (numbered steps, run in the file's own
folder). The `.x.md` double extension is consent (a plain `.md` never runs). Each
run appends to `<name>.x.md.log`. Template: `config/skeletons/script.x.md`. Point
a heartbeat at one with `script_path:`. There is no `/x` command.

---

## 4. Transcription

Voice notes are transcribed by a per-note fallback **chain**: each engine in
`fallback_order` is tried in order, first transcript wins. Configure under
`transcription_service`; `use_config` names the active profile (the one line that
differs machine-to-machine). Engine `type`s:

- `whisper-server-remote` — POST to another node's GPU worker (`endpoint` +
  shared HMAC `token`; a dead server just costs a fallback).
- `whisper-server-local` — a resident whisper.cpp server (lazy-spawned).
- `whisper-cli` — per-note binary; the always-available floor.

A change of *winning* engine posts one `⚠️`/`✅` to the operator Self-DM
(transition-only, never per note).

---

## 5. Operational notes

- **The node runs the current checkout.** `/restart` boots whatever is checked
  out — never restart with uncommitted edits mid-flight.
- **Liveness** = the mtime of `state/alive.txt` (the alive heartbeat rewrites it
  each tick); the daemon's deadman respawns a wedged spine. The spine pid lives
  in `state/spine.pid` (singleton guard).
- **Install sanity check:** `node setup/verify-install.mjs [service] [egptHome]`
  (read-only) probes the live node — service-log paths, profile shape, liveness,
  `claude` on PATH.
- **Two nodes on one Beeper double-answer every `@e`** — only run one spine
  against a given Beeper Desktop login.
