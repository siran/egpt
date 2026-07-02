# ROADMAP — v2 state + what's next

> Written 2026-07-02 (session: the big feature push). Purpose: survive context
> compaction — everything decided-but-not-yet-done lives HERE, not in a chat
> buffer. Update this file as items land; delete sections that ship.
> Companion: SPINE-REWRITE-PLAN.md (the architecture + phase plan, mostly done).

## 1. Where we are

Branch `rewrite`, suite ~1403 tests / 0 fail. The node runs live as the
`egpt2-daemon` service, profile `~/.egpt2`, from this working tree. All of the
following is LANDED, test-locked, and (where marked) live-verified:

- Core pipe (receive → gate → brain → stream-reply → send), gating modes
  (accum retired), reply train (persona line, ∎, no nonce), flood guard — live-verified
- Voice chain + per-conversation transcription policy; media per origin surface;
  video Route A
- Contacts: slug-follows-name + folder move + renames.log (one shared resolver)
- Brains/agent-types: layered registry (src/brains ← config/brains ← config/agents ← conv)
- Auto-compaction (native /compact, 20%, 2-min cooling)
- Heartbeats: declarative (config + every conversation/room config.yaml),
  `frequency:` + `when:` one-shots (default_time_zone-aware), `command:` +
  `ai_run:` (textecutables), hot reload = DELETE state/heartbeats.readonly.yaml
  (staleness check rides runDue — no reload heartbeat), alive beat =
  `echo beat > state/alive.txt`, liveness = file MTIME, pid in state/spine.pid
- Daemon: mtime deadman, calm wedge backoff, singleton via spine.pid — live-verified
- Warm: conversation = background agent for 15m after last message (default),
  `warm.max` keeps N warm, per-conversation override `warm: { idle_ttl }` in the
  conv folder's config.yaml (0 = always warm)
- Per-surface auth: whatsapp/telegram/signal each own {chat_id, allowed_users};
  empty = deny; isSender = owner's global pass
- Siblings: @name routes to local beings, nested per-being thread persistence
- Mesh (Phase 4b): @being.node + relay agents; envelopes detected before gating;
  living mirror into the origin placeholder; forward-once per mid + service hop
  cap; `config.mesh.nodes` routes + route-direct via agents.relay_channel.
  UNIT-LOCKED ONLY — live 2-node smoke needs DOLLY awake.
- Agents registry: `agents: { <name>: { type, handles, relay_channel? } }` —
  ONE block for persona + local beings + relay targets; type files in the
  PROFILE's config/agents/; skeletons seed to ~/.egpt2/config/skeletons
  (copy-if-missing, operator edits sacred)
- Textecutables: `*.x.md` = plain-text script, one fresh claude turn executes it
  (CLI / heartbeat `ai_run:` / ask E — NO /x command, ever)
- Commands: /restart /upgrade /rewind, /e auto <mode> [target], /status (fenced yaml)
- Anti-drift: integrity tests scan v2 config reads; skeleton can't-rot tests

## 2. In flight right now

- **Agents-first config migration** (agent running): live config gets the real
  `agents:` block + `default_time_zone: America/New_York`; `default_brain`
  removed; `user_name` hoisted top-level; conversations.yaml migrates
  `readonly.brain` → `readonly.agent` (readers accept both); skeleton ships
  agents UNcommented; seed config/agents/default.yaml.
  → then /restart; operator re-inspects config.yaml + conversations.yaml.

## 3. Decided, not yet dispatched

- **Stats module + `/status <target>`** (operator 2026-07-02): a `stats` service
  the loop notifies after transcript.log(ev) — in-memory per-conversation
  counters (messages per sender, member first/last-seen = member history,
  devices when the payload carries them), debounced flush to the conv folder's
  own `stats.yaml` (entity-folder pattern). Slow facts (admin permissions, bio,
  participant list) fetched from Beeper ON DEMAND, not tracked per message.
  `/status <name-fragment|id>` resolves like /e auto's target and replies fenced
  yaml: name/surface/slug, mode, instanced agent, members + counts + last-seen,
  that folder's heartbeats, media count, live participants/admins when the API
  exposes them. Existing pure libs to reuse: conversation-stats.mjs (file-derived
  render), conversation-members.mjs (roster). Name history = renames.log (done).

- **CUTOVER — main becomes v2** (held for operator "go" AFTER re-inspection):
  ```
  git tag pre-rewrite origin/main && git push origin pre-rewrite
  git push origin rewrite:main          # fast-forward, no force
  git branch -D main && git branch -m rewrite main
  git branch -u origin/main main        # /upgrade's git pull keeps working
  ```
  Keep origin/rewrite for a few days. Old-spine deletion (egpt-spine.mjs,
  dispatch.mjs, slash/, attic) is a SEPARATE commit after cutover soak — the
  integrity tests that scan egpt-spine.mjs get retired with it.

- **Live mesh smoke**: needs DOLLY (2nd node). Config: mesh.nodes routes or an
  agents relay entry pointing at a shared chat. Unit tests cover the machinery.

- **Chrome/CDP textecutable test** (operator-driven, everything ready): copy
  ~/.egpt2/config/skeletons/{script.x.md, heartbeats block} into a chat folder,
  set `when:` a few minutes out, delete state/heartbeats.readonly.yaml, watch.
  Note: CDP attaches only to a Chrome started with --remote-debugging-port
  (chrome-launcher.mjs starts a visible one; the daily browser needs the flag).

## 4. Backlog (known warts, smallest last)

- Test flakes under full-suite port/timing contention: tests/transcriptor.test.mjs,
  tests/beeper-bridge.test.mjs "newest isSender match" (real retry timers).
  Both pass in isolation. Fix: fake timers / serialize the port-binding tests.
- Node-level `heartbeats:` config block is boot-cached — hot reload re-reads
  entity folders but NOT config.yaml (needs /restart). Offered to make the
  loader re-read config on reload; operator hasn't ruled.
- spine.stats() counts the WAITING queue only — a lone hung turn shows q=0
  (visible only once backlog accumulates). Two-line fix if ever wanted.
- warm-cli: a claude proc that exits cleanly between turns respawns from
  creation-time options (loses --resume; sessionId getter goes stale).
- Double context-overflow (retry also overflows) would surface the error string.
- Reactions/edits bypass the whatsapp.networks scope gate (moot at default []).
- Eventual: move the profile ~/.egpt2 → ~/.egpt ("main" profile);
  install/setup docs after testing an install on another computer.

## 5. Operational facts (for any future session)

- Node: Windows service `egpt2-daemon` → egpt-daemon.mjs → spawns `node egpt.mjs`
  from THIS working tree (a /restart boots whatever is checked out — never
  restart with uncommitted edits in flight).
- Profile: EGPT_HOME=~/.egpt2. Config: ~/.egpt2/config/config.yaml (canonical;
  root config.yaml is the legacy location). Old production (egpt-daemon service,
  ~/.egpt, C:\Users\an\src\egpt) is STOPPED — both ride the same local Beeper
  Desktop (127.0.0.1:23373), so running both double-answers every @e.
- Restart: drop a file containing `/restart` into ~/.egpt2/ingest/ (temp→rename).
  Hot-reload heartbeats: delete ~/.egpt2/state/heartbeats.readonly.yaml.
- Live self-testing: the egpt-an chat is operator-authorized for agent testing
  (pace sends ≥8s, small counts; each @e is a real claude turn; /status is free).
- Working agreements: operator = An; all implementation via background Opus
  agents (Fable orchestrates/reviews/commits); descriptive commits, no AI
  attribution; no continuity-diary logging for egpt work; commit+push without
  asking when work is done; comments carry the WHY (operator-dated decisions).
