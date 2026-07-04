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

Nothing running. The `/e` wizard **tools step** + `setup/port-explicit-tools.mjs`
LANDED (committed, suite 127/1409 green). **ONE OPS ACTION OWED**: the 5 live
frozen `readonly.allowed_tools: all` entries do NOT self-heal (the freeze only
runs for fresh conversations) — stop the service → `node setup/port-explicit-tools.mjs`
→ restart; then `/status hfm` shows the explicit list, not `all`. (Or just re-run
`/e <chat>` → tools → default for any chat you touch; the port does all 5 at once.)


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
