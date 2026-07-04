# eGPT — HANDOFF (state of affairs, 2026-07-03)

> Orientation layer above ROADMAP.md. Read this first, then ROADMAP §1 (landed)
> + §3 (next). GENOME.md = the heart/DNA; CONTRACTS.md = the 16 one-line
> promises.


## What we are

eGPT is **a being, not a chatbox** — a persistent presence that lives in the
channels people already use (WhatsApp/Signal/Telegram via Beeper), hears and
remembers everything, and acts through limbs on the operator's behalf. The
mission: a **public tool, secure AND powerful, that empowers the individual with
AI** — the power (full tools, real limbs, self-modification) is exactly why the
security is structural, not bolted on.

The spine is **a loop that receives and dispatches messages through Beeper**;
every iteration checks heartbeats and runs what's due; everything is heard and
logged, only some is spoken (per-chat mode gates surfacing). One router, thin
limbs, fail-closed emit gate, id-based auth, structural confinement. Each
conversation runs as a **warm resident `claude` CLI process** (no SDK —
CLI only, I11). Peer nodes form a **mesh** (TCP-over-Beeper: base64 body + YAML
provenance tail, forward-once per mid).


## Where we stand (all LANDED + test-locked, suite ~126 files / ~1378 green)

- **Prod is decoupled**: Windows service `egpt-daemon` runs the INSTALLED
  copy `~/bin/egpt` (a git clone tracking origin/rewrite) on profile
  `~/.egpt`. The dev tree `~\src\egpt` (renamed today from
  `src/egpt2`; v1 archived `src/egpt-v1`) can be dirty. Deploy =
  commit+push, drop `/upgrade` into `~/.egpt/state/ingest/`.
  `/restart`=43 `/upgrade`=42 `/rewind`=44.
- **`/e` wizard**: <improve> -- let's you manage/configure agents in
  conversations
- **`/status <target>`**: fenced yaml — name/surface/slug, conversation_path,
  mode, agent/engine/model/effort/allowed_tools, personality, thread_id, members
  (from transcript), heartbeats.
- **Identities are flat** `config/identities/<name>.md`; 10 preset personalities
  seeded + `egpt`; shared pointers/rules = `config/skeletons/room/`.
- **Short chat ids** everywhere inside the spine; Matrix `!…:beeper.local` only
  at the Beeper API boundary (src/bridges/chat-id.mjs).
- **allowed_tools `all` is REJECTED** (d025413): egpt never writes
  it; a literal `all`/`*` is coerced to the explicit
  DEFAULT list `[Read Write Edit Glob Grep WebSearch WebFetch Task]`, confined
  to the conversation dir — no bypass tier left, no bare Bash/Agent. Scoped
  `Bash(<bin>:*)` only via an explicit list.
- Guards: `tests/boot-profile-contract.test.mjs` (real spine vs canonical
  fixture) + `setup/verify-install.mjs` (live NSSM/profile/liveness check).
- Docs modernized: CONTRACTS = 16 numbered one-liners; GENOME e2; MESH-PROTOCOL
  de-fluffed; TESTING lean; setup/ culled 20→6 scripts.


## In flight RIGHT NOW

Nothing running, nothing owed. Late-night additions (2026-07-04, all
agent-built, deployed live at 63d4073 / pid 23728):

- **Port RAN**: all 5 frozen `readonly.allowed_tools: all` entries → explicit
  list in the live registry (0 remaining, verified pre+post respawn).
- **Session rescue (ops)**: the 5 conversations instanced under the old
  `~/.egpt2` profile had cwd-keyed claude sessions the renamed profile couldn't
  --resume ("No conversation found with session ID", HFM wedged live). Session
  jsonls COPIED to the new `~/.claude/projects` keys — context preserved.
- **Dead-session backstop** (63d4073): that error now heals like context
  overflow — isDeadSessionError (dispatch.mjs), evict + retry once fresh,
  recordThread persists the new session. No conversation can wedge on a dead
  threadId again.
- **chat-id double-wrap fix**: fullChatId no longer re-wraps a chat homed on a
  non-beeper.local server (`!x:beeper.com` was becoming `!!x:beeper.com:
  beeper.local` → 404 on every API call for that chat). NOTE: one cosmetic scar
  remains — a conv folder named `!TUZaHGpkFXgCCFXfRw beeper.com-2607040134`
  registered during the bug window; slug-follows-name should heal it on that
  chat's next event.
- **STATS MODULE LANDED** (ROADMAP §3 item 1): every received message
  fire-and-forgets members:{<sender>:{count,last_seen}} into the conv's
  stats.yaml at the transcript.log chokepoint (per-path write serialization vs
  the thread mirror); operator-editable top-level `aliases:` block in
  config.yaml (display-time only); /status members renders alias+count+
  last_seen from stats, transcript fallback. LID↔phone NOT built — Beeper's
  local API exposes a single senderID, nothing to link (verified).
- Suite: 128 files / 1423 tests green. TESTDRIVE.disposable.md (git-invisible
  via .git/info/exclude) = operator's live smoke script for Rooms +
  textecutables + path permissions + allowed_tools.


## Where we want to go (ROADMAP §3, operator-decided, undispatched)

- **Stats module** — the async "stats collector" (CONTRACTS §3): per-message
  counters + member/LID↔phone mapping (async), feeding richer `/status`.
  An **alias map** (any sender id → operator-chosen alias) lives here.
- **`mode: auto`** — auto-reply designated channels, imitate-the-operator or
  role-play. Design fork: imitation (no persona marker → needs its own
  echo-suppression key) vs role-play (persona replies openly). Per-channel
  opt-in only.
- **Mesh: egpt-test channel chain** (`@don.kg → @moe.kg → @e.kg`) for multi-hop
  smoke on one node; DOLLY 2-node smoke later.
- **RNG / GCP2** (docs/RNG-GCP2.md): host a $300 HeartMath RNG; Mesh alignment
  is TWO-FOLD — per-node USB TRNG entropy (interpretation contested) AND the
  mesh's own network health as a causally-grounded collective-activity signal (a
  NetVar-style coherence net, free from the existing primitives).
- **Root launcher script** — one script: spine-if-absent + console attach; the
  Ink client (src/shell/ink-limb.mjs, old-spine) is port-or-retire.
- **CUTOVER**: `rewrite` → `main`; then delete old-spine
  (egpt-spine.mjs, slash/, attic/, the marked dead modules) in a separate soak'd
  commit.
- **Rooms — remaining**: NamedRoom federation, member fan-out, room roster CRUD,
  dual-write (conversation lines → each room's transcript) — all old-spine-only
  today; the Room base + ConversationRoom are live.


## Working agreements

**#1, checked into CLAUDE.md §5 (operator emphasized 2026-07-03): YOU ARE THE
ORCHESTRATOR. Start background agents to do the CODING — to maintain the goal +
direction AND preserve your own context.** The orchestrator's own hands are for
scoping, reviewing diffs, committing/pushing, writing handoffs, and ops actions
(ingest/restart) — NOT for editing source. If you catch yourself running `sed`
or hand-fixing a test, stop and dispatch. Operator flagged this repeatedly this
session; it is the load-bearing rule.

Tier agents by weight (haiku dumb / sonnet mid / opus heavy). Operator = An.
Plain tone, verify claims (don't assert from memory), no butler ceremony.
Descriptive commits, no AI attribution, commit+push when done. Live-test via the
egpt-an chat; restart via ingest. `switchModelsOnFlag: false` (a safeguard flag
pauses so the operator rephrases, keeping Fable). No continuity-diary logging
for egpt work.
