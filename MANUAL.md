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
/status                 compact node health (fenced yaml): git sha + subject,
                        pid, uptime, last alive-beat age, heartbeat count,
                        conversation count, this chat's E mode
/e auto <mode> [chat]   set a chat's E reply mode. omit <chat> = this chat;
                        from the Self-DM name a target (slug/name fragment, or
                        a verbatim @jid / room-id)
/e                      arm the re-point WIZARD for this chat
/e <fragment>           arm the wizard for another chat (target resolved like
                        /e auto's)
/restart                bounce the node (daemon respawns the current checkout)
/upgrade                git pull + npm install + rebuild, then respawn
/rewind <ref>           git checkout <ref>, reinstall, respawn
```

**Reply modes** (`/e auto`): `on` (receive every burst, reply per personality) ·
`mute` (receive, never reply) · `mention-direct` (reply only when `@e` starts the
message or it replies to E) · `mention` (reply when `@e` appears anywhere, or a
reply to E — the default) · `off` (don't receive at all).

### The `/e` wizard

Bare `/e` (this chat) or `/e <fragment>` (another chat) arms a guided re-point.
Operator-only, 5-minute TTL; answer with the numbered picks, `b`/`back`,
`x`/`cancel`. While armed, your next plain message is treated as a wizard answer
(it never falls through to the persona); a slash command still runs and leaves
the wizard armed.

1. **Agent type** — the list is discovered from `src/brains` + your
   `config/agents/*.yaml`, filtered to types that resolve, each shown with its
   composition (model/effort/personality); the current one is marked. **Picking
   an existing type applies immediately** with that type's pinned model/effort.
2. **`custom`** — the final option builds a NEW type: model → effort →
   personality → name (named last; a collision re-prompts). It writes
   `config/agents/<name>.yaml` (and, for free-text personality, a flat
   `config/identities/<name>.md`), then applies it.

On done the target conversation's `readonly` is frozen (keeping its `threadId`,
so context survives the re-point) and its warm session is evicted (it respawns on
the next turn — no `/restart` needed).

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
| `agents` | **Required.** The unified registry: persona, local beings, and mesh relays. Each agent = `{ configuration, handles, relay_channel? }`. `configuration` names an agent-type file (`config/agents/<type>.yaml`) or the literal `relay`. A node without an `agents` block or a persona entry (handles include `e`/`egpt`) refuses to boot. |
| `whatsapp` / `telegram` / `signal` | Per-surface auth: `{ chat_id, allowed_users }` (empty = deny). Ids are per-surface namespaces. `whatsapp` also carries the transport config (`networks: []` = the firehose). |
| `default_time_zone` | Interprets timezone-less heartbeat `when:` times (IANA name or an alias like `ET`/`PT`). |
| `warm` | Warm-session policy: `max` (how many chats stay resident) + `idle_ttl_by_class.conversation` (quiet-time before eviction; default 15m, 0 = never). A chat overrides its own TTL in its folder's `config.yaml`. |
| `flood` | Send-flood guard: more than `limit` bot sends to one chat within `window_ms` pauses THAT chat for `cooldown_ms`. |
| `compaction` | After a quiet `cooling_ms`, if the warm session grew past `ratio` of the context window, native-`/compact` it in place (transcript.md keeps the full record). |
| `heartbeats` | Declarative timers — see §3. |
| `transcription_service` | Voice-note transcription — see §4. |

Agent types are resolved across layers, most-specific winning: `src/brains`
(built-in) < `config/agents` < a conversation's own `brains/`. A type's
`allowed_tools` LIST confines its file tools to the conversation dir +
`allowed_paths`; `allowed_tools: all` makes it trusted/unconfined. Point
`agents.egpt.configuration` at whichever type new conversations should start on.

---

## 3. Heartbeats + textecutables

A heartbeat is a declarative timer: `<name>: { <trigger>, <action> }`. It can
live in the node's `heartbeats:` config block, or in any conversation's /
room's own `config.yaml`.

- **Trigger** — `frequency: <ms|"30s"|"5m"|"1.5h">` (recurring) OR `when: <one-shot
  wall-clock time>` (`7/2/2026 8:20a`, `2026-07-02T08:20`, ...; zone from
  `default_time_zone`). Both set = invalid, skipped.
- **Action** — `command: <shell line>` OR `ai_run: <script.x.md>` (sugar that
  runs a textecutable). Both set = invalid, skipped.

The spine materializes the resolved set to `state/heartbeats.readonly.yaml`
(spine-written — don't edit it; edit `config.yaml` + `/restart`). **Hot reload:**
delete `state/heartbeats.readonly.yaml` and the spine re-reads within ~30 s (new
chat folders picked up too). Paste-ready template: `config/skeletons/heartbeats.yaml`.

A **textecutable** is a `*.x.md` file whose interpreter is one fresh `claude`
turn with tools — the file IS the program (numbered steps, run in the file's own
folder). The `.x.md` double extension is consent (a plain `.md` never runs). Each
run appends to `<name>.x.md.log`. Template: `config/skeletons/script.x.md`. Point
a heartbeat at one with `ai_run:`. There is no `/x` command.

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
