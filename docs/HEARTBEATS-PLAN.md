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

```yaml
# conversations/<surface>/<slug>/config.yaml
heartbeat:
  enabled: true
  every: 6h            # interval cadence: 30m / 6h / 1d   (mutually exclusive with `at`)
  at: "09:00"          # OR a daily wall-clock time (node-local)
  prompt: |            # what the resident does each beat (operator-authored)
    Review today's messages; if anything needs me, reply, else stay quiet.
```

## Boot scan (`src/heartbeats.mjs`, NEW)

On every spine boot, async (never blocks boot):
- `scanHeartbeats({ rootDir, now })` — walk `conversations/<surface>/<slug>/config.yaml`,
  read each `heartbeat:` block + its `heartbeat.state.json`, return the active model
  `[{ surface, slug, cadence, prompt, lastFiredAt, nextDue }]`.
- `renderHeartbeatsReadonly(model, now)` — PURE → the markdown digest (one row per active
  heartbeat: conversation · cadence · next due · prompt preview).
- `writeHeartbeatsReadonly({ rootDir, model, now })` — write `~/.egpt/heartbeats.readonly.md`.
- The spine keeps the model in a memory ref (the scheduler reads it; re-scan on change).

## Scheduler (fires the beats)

A timer (coarse, e.g. once/min) checks the in-memory model; for each `nextDue <= now`:
- Inject `prompt` into that conversation's resident-E thread via the NORMAL dispatch path
  (so the chat's reply mode gates whether E's output surfaces — a `mute` chat still does
  the work but posts nothing; `mention` posts only if E decides to, etc.).
- Update `heartbeat.state.json.lastFiredAt` + refresh the digest.
- One global lock so a slow beat can't stack.

## Steps

1. **Strip orphan fields** from `conversations.yaml`. — **DONE** (42 entries).
2. **`src/heartbeats.mjs`** — `scanHeartbeats` + `renderHeartbeatsReadonly` +
   `writeHeartbeatsReadonly`. Pure parts tested against a temp dir.
3. **Boot wiring** — async scan on boot → write `heartbeats.readonly.md` → memory ref.
4. **Scheduler** — timer → fire due beats → update state + digest (touches the live
   dispatch path; behind a guard, boot-verified).
5. **Console `heartbeat` action** — set enabled/cadence/prompt per conversation from the
   `/e <slug>` menu (ties into the E-console consolidation).
6. **Boot-verify** on REVE.

## Open decisions (before building the scheduler)

- **Cadence shape:** support both `every:` (interval) and `at:` (daily wall-clock), or
  just one to start?
- **Fire target:** inject into the conversation's E thread (E acts in-chat, mode-gated) —
  vs post only to Self. Recommend the former (a heartbeat is the conversation's own
  agent doing its job), with `mute` as the way to keep it silent-but-working.
