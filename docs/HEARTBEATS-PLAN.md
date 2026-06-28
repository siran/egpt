# Heartbeats — periodic per-conversation self-prompts

Status: PLANNED (2026-06-27). A heartbeat makes a conversation's resident (E) act on
its own on a schedule — a daily summary, a check-in, a "anything need a reply?" sweep —
instead of only reacting to incoming messages.

## Where it lives (decided by the existing architecture)

`src/room-core.mjs` already declares the per-conversation `config.yaml` (in the slug
folder) as the home for "members · personality · thread · **heartbeat** · transcription
service", and references a not-yet-created `src/heartbeats.mjs`. So:

- **Config source of truth:** a `heartbeat:` block in each conversation's
  `conversations/<surface>/<slug>/config.yaml` (the Room config — comment-preserving via
  `Room._setConfigBlock`). **Not** `conversations.yaml` — the orphan `heartbeat*` fields
  there (0 code refs) were removed 2026-06-27.
- **State:** `heartbeat.state.json` in the slug folder (`{ lastFiredAt }`), kept OUT of
  the operator-edited `config.yaml` so a firing beat never rewrites their file/comments.
- **Generated digest:** `~/.egpt/heartbeats.readonly.md` — the boot scan consolidates
  every active heartbeat into one read-only file, loaded into memory as the scheduler's
  source. "readonly" = generated, never hand-edited; edit the per-room `config.yaml`.

Distinct from the `heartbeat:` **config key** in the root `config.yaml`, which is the
unrelated supervisor-liveness beat (tic/toc to `state/alive.txt`). That stays.

## Config shape (proposed)

A `heartbeat:` block (or a list of them) in the per-conversation `config.yaml`. Every key
is allowed EXCEPT permissions — those live in the per-being config (see Permissions).

```yaml
# conversations/<surface>/<slug>/config.yaml
heartbeat:
  enabled: true
  # ── WHEN (one of) ──
  frequency: "0 9 * * *"     # cron-like expression (recurring)
  at: "9:30pm ET"            # OR a human time — see the `at` grammar below
  default_time: ET           # timezone used when `at` omits one (default America/New_York)
  # ── WHAT (one or both) ──
  prompt: |                  # inject this into a resident-E turn
    Review today's messages; if anything needs me, reply, else stay quiet.
  prompt_opts:               # OPTIONAL — run the prompt in a PARALLEL, context-free E
    fresh: true              #   a throwaway conversation-e (no history) so the main thread is untouched
    personality: banter      #   the wizard knobs, for this beat only
    brain: claude-code
    effort: medium
  command: "curl -s https://api.example.com/ping"   # OR a shell command (runs under E's bash grant)
```

### `at` time grammar (proposed)
Lenient, timezone-aware. Examples that must parse: `9a` · `9am` · `9:30pm` · `21h` ·
`21.30` · `21:30` · `9/18/2026 21:21` · `2026-09-18 21:21`. Rules:
- **Time-of-day only** → fires daily at that local time.
- **Date + time** → one-shot at that instant (then `enabled` flips off, or it's skipped).
- **Timezone** is an optional trailing token (`ET` / `PT` / `UTC`, or an IANA name like
  `America/New_York`). When absent, `default_time` applies; when that's absent too, ET.
- `frequency` (cron) and `at` are mutually exclusive on one heartbeat.

## Boot scan (`src/heartbeats.mjs`, NEW)

On every spine boot, async (never blocks boot):
- `scanHeartbeats({ rootDir, now })` — walk `conversations/<surface>/<slug>/config.yaml`,
  read each `heartbeat:` block + its `heartbeat.state.json`, return the active model
  `[{ surface, slug, when:{frequency|at,tz}, prompt, prompt_opts, command, lastFiredAt, nextDue }]`.
- `renderHeartbeatsReadonly(model, now)` — PURE → the markdown digest (one row per active
  heartbeat: conversation · cadence · next due · prompt preview).
- `writeHeartbeatsReadonly({ rootDir, model, now })` — write `~/.egpt/heartbeats.readonly.md`.
- The spine keeps the model in a memory ref (the scheduler reads it; re-scan on change).

## Execution — folded into the spine's existing loop (NOT a separate scheduler)

The spine already runs a periodic loop that writes the aliveness beat (`startAliveHeartbeat`
→ `state/alive.txt`, ~60s). Because the heartbeats are already loaded in memory (we wrote
the readonly digest at boot), each loop tick simply checks "is any heartbeat due?" and
hands the due ones to an **executor**. No new timer, no separate scheduler.

Executor, per due beat:
- **`command`** → run it as a shell command in the conversation's cwd (`threadCwd`), under
  conversation-e's **bash permission grant** (see Permissions). stdout is captured; a
  non-zero exit / permission error is an ERROR (below).
- **`prompt`** → inject it as a resident-E turn via the normal dispatch path, so the chat's
  reply mode gates whether output surfaces (`mute` works-but-silent). With `prompt_opts.fresh`
  it runs in a **parallel, context-free conversation-e** (its own throwaway thread with the
  given personality/brain/effort) so the main per-chat thread is never disturbed.
- Then update `heartbeat.state.json.lastFiredAt` + refresh the digest. One global lock so a
  slow beat can't stack across ticks.

### Errors → an `egpt-logs` channel (via a Logger)
A heartbeat runs unattended, so a failure (permission denied, non-zero command exit, brain
error) must surface somewhere. Rather than dump into Self, introduce a dedicated **`egpt-logs`
chat**: a Logger posts system warnings/errors there THROUGH THE BRIDGE (so it's auto-logged
to the transcript like any conversation) — and **never swallow** an error that would be
useful or insightful. The Logger is leveled (future: levels routed to different `egpt-*`
chats); for now one `egpt-logs` channel is enough — don't over-pollute. Every Logger send
runs **inside the flood-safe lock**, so a misconfigured beat erroring in a tight loop trips
the flood-guard and pauses, never firing indefinitely.

## Permissions — SAFE BY DEFAULT (NOT in the heartbeat block)

Per `docs/IDEAS.md` ("Permissions belong in config, not `/e`", 2026-06-25): per-being
permissions — tools, **runnable commands (bash)**, path grants — live in the **siblings
registry** or a **`conversations.yaml` per-being override**, folded into the #2 per-being
config shape. The `heartbeat:` block never carries permissions.

**Default is DENY.** A `command:` does NOT run unless conversation-e has been explicitly
granted command/bash permission in its per-being config. The operator may run dangerously
for THEIR OWN chats, but egpt must be safe by default — a contact (whose intentions egpt
can't vouch for) editing/triggering a heartbeat must not get arbitrary command execution.
So: no grant → the `command:` is skipped and an `egpt-logs` line says it was denied.
Granting is a deliberate per-being operator action, never implied by writing a `command:`.

## `heartbeats.readonly.md` layout

The generated digest is self-documenting so the operator never has to leave the file:
- **Top line:** `> You can find documentation of the heartbeat options at the bottom of this file.`
- **Middle:** the real, active heartbeats (one row each — conversation · when · next due · action).
- **Bottom:** a `## Options` reference + **example configs for every key** (`frequency`, `at`,
  `default_time`, `prompt` + `prompt_opts`, `command`), below the real heartbeats so examples
  are never mistaken for live ones.

## `alive.txt` IS a heartbeat (heartbeat-zero)

The supervisor-liveness beat (`_writeAliveNow` → `state/alive.txt`, tic/toc each tick) becomes
the FIRST built-in system heartbeat. Its tick loop (the existing `startAliveHeartbeat`, ~60s)
is the SAME loop that checks every other heartbeat's due-ness — unifying the mechanism: one
loop, one set of heartbeats, `alive` is just the always-on system one that writes the tic/toc.
(Granularity stays minute-level, which suits cron/`at`.) Note for monitoring: alive.txt is
rewritten in place (tic truncates, toc appends), so `tail -f` won't follow it — `while sleep 5;
do clear; cat state/alive.txt; done` (or watch it via `egpt-logs`).

## Steps

1. **Strip orphan fields** from `conversations.yaml`. — **DONE** (42 entries).
2. **`src/heartbeats.mjs`** — `scanHeartbeats` + `renderHeartbeatsReadonly` +
   `writeHeartbeatsReadonly`. Pure parts tested against a temp dir.
3. **`egpt-logs` Logger** — a leveled logger that posts warnings/errors to the `egpt-logs`
   chat through the bridge, inside the flood-safe lock. (Used by heartbeat errors + general
   system logging; don't over-pollute — one channel for now.)
4. **Boot wiring** — async scan on boot → write `heartbeats.readonly.md` (self-documenting
   layout) → memory ref.
5. **alive.txt as heartbeat-zero** — fold the aliveness write into the heartbeat set; its
   ~60s tick loop becomes the single due-check loop for ALL heartbeats (no separate timer).
6. **Executor** — `command` (shell, ONLY with E's bash grant, else denied + logged) and/or
   `prompt` (resident-E turn; `fresh` → parallel context-free E). Errors → `egpt-logs`.
7. **`at` parser** — the lenient timezone-aware grammar above (pure + tested).
8. **Console `heartbeat` action** — set enabled/when/prompt/command per conversation from
   the `/e <slug>` menu (ties into the E-console consolidation).
9. **Boot-verify** on REVE.

## Open decisions

- **`frequency` (cron) vs `at` (human time):** support both from the start (recommended —
  cron for power, `at` for humans), or ship `at` first?
- **Parallel-fresh-E (`prompt_opts.fresh`):** confirm the model — a throwaway conversation-e
  thread per beat, results posted to the chat (mode-gated) or to Self?
- **Command output:** post stdout to Self always, or only on error? (Errors always go to Self.)
