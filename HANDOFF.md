# eGPT — HANDOFF (state of affairs, 2026-07-03)

> Orientation layer above ROADMAP.md. Read this first, then ROADMAP §1 (landed)
> + §3 (next). plans/2606131545-GENOME.md = the heart/DNA; plans/2606120753-CONTRACTS.md = the 16 one-line
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
CLI only, I11). Peer nodes form a **mesh** (relay over shared Beeper chats:
base64 body + readable YAML provenance tail).

## ⭐ 2026-07-06 — LIVE two-node mesh (the milestone)

**Two real machines, two Beeper accounts, a relay chain answered live.** An on
REVE typed `@carol` → the message walked rodz1→rodz2→rodz3 bouncing between the
accounts → E on DOLLY answered → reply came home into REVE's Self placeholder.
E even fired a `/react` limb through the relay. This is the real friend-of-a-
friend across machines.

**The two nodes:**
- **REVE** — this box, Beeper account **An**, `node_name: kg`. Sources
  `C:\Users\an\src\egpt` (branch rewrite), installed `~/bin/egpt`, profile
  `~/.egpt`, NSSM `egpt-daemon`. Deploy = commit+push → `git -C ~/bin/egpt pull`
  → `/restart` via `~/.egpt/state/ingest/`.
- **DOLLY** — `192.168.1.102`, Beeper account **Rodz** (`@dolly-egpt`, WhatsApp
  +13472576794), `node_name: do`. Reach via **`ssh an@192.168.1.102`**
  (passwordless key from REVE; default remote shell cmd.exe). Runs `~/bin/egpt`
  on rewrite, profile `~/.egpt`, NSSM `egpt-daemon`, node deploy = SSH `git -C
  ~/bin/egpt pull` + drop `/restart` into `~/.egpt/state/ingest/`. **Also a GPU
  transcription worker** (:23390, REVE dials it) — PRESERVE that. Runbook +
  full recon: `DOLLY-SETUP.disposable.md` (git-ignored).
  - **Elevation caveat**: the SSH session is NOT admin, and the shared admin
    password does NOT validate `an` on DOLLY. Service/NSSM changes need a
    self-elevating script the operator clicks (`Desktop\DOLLY-cutover-CLICKME.cmd`
    pattern — UAC prompt). Reads/git/npm/writing `~/.egpt` all work over SSH.

**Mesh architecture (now clean — a lot changed 2026-07-05/06):**
- **Relay agents are declarative**: `agents.<name>.{relay_channel, to}` — `@name`
  posts into `relay_channel` re-addressed `to: <being>.<node>`; the next node
  re-relays via ITS agent entry; the chain ends when `to` resolves to a LOCAL
  being (which answers). Live chain: `carol.kg → don.do → wren.kg → ed.do`
  (REVE hosts carol+wren, DOLLY hosts don + `ed` [a HANDLE of egpt]).
- **`mid` REMOVED** (operator: "not necessary, just unwire it"). No forward-once,
  no ttl/hop-cap (both deleted). Loop safety is now **structural**: self-echo
  suppression (a node never re-sees its own posts — src/bridges/beeper.mjs
  isEcho applies to mesh envelopes too) + `_processedIds` foreign-redelivery
  dedup + the content `seen` replay guard + the per-channel circuit breaker
  (5 sends/20s, `guardedSend`).
- **Reply-home = `re:` return-address + the origin's `awaiting` map** (no mid).
  Works because the origin node sits in the terminal's room (the chain bounces
  the last hop back through it). LIMITATION (documented in relay.mjs): a chain
  terminating in a room the origin is NOT in would need reverse-path reply-
  forwarding — out of scope for now.
- **Mesh resolves a being by HANDLE**, not just its agent-map key (mirrors
  router.findAgent). So `ed.do` runs E because `ed` is in DOLLY's
  `egpt.handles`. The handle is arbitrary text; the config's `handles:` list is
  the source of truth per node.
- **Self-echo exemption was tried then removed**: the single-process-with-alias
  self-relay (node_alias wearing many identities on ONE process) is RETIRED —
  DOLLY (a real 2nd account) replaces it. `node_alias` still exists for
  local-answering multi-identity, but real transit needs distinct accounts.

**OPEN / next (operator-decided):**
- **Single "mesh" channel** (operator idea, works NOW): set every
  `relay_channel: mesh` (one chat with both accounts) instead of rodz1/2/3 —
  the whole chain scrolls through one visible channel. Tiny config change.
  Caveat: the 5/20s circuit breaker concentrates on that one channel; raise it
  if a long chain trips it.
- **`/react` emit syntax** (live 2026-07-06): E used emoji-first `/react 👋`;
  operator thinks the real bridge form is `/react <msgid> <emoji>`. VERIFY
  against src/spine/reply-actions.mjs + the bridge react call, fix the emit
  grammar + the `config/skeletons/room/00-identity.md` doc E learns from, and
  re-test.
- **HRW single-responder** for the unqualified-@e-in-a-shared-channel double-
  reply case (ROADMAP; not a chain problem — chain hops are explicitly addressed).
- Live at commit `ab1a3ef` (REVE pid 34656; DOLLY on ab1a3ef, hearing).


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


## 2026-07-05 adds (all deployed, node at a8321d9)

- **mode: auto LANDED**: E plays the operator's role in opted-in chats
  (`/e auto auto [target]`, gates like `on`); role instructions = identity
  layer `config/skeletons/auto-mode.md` (fresh kickoff + once-on-flip);
  `/ask` limb posts doubts to config `advice_channel` (origin-tagged, the ONE
  sanctioned cross-chat emit, fail-closed unconfigured); operator's
  quote-reply in the advice channel ROUTES BACK into the origin conversation
  (one-shot). OPERATOR SETUP OWED: create the advice chat, set
  `advice_channel:` in config.yaml, restart, flip a test chat.
- **E-actions live** (bbd1734+fix): /react /reply /media /edit /delete +
  ↩#msgid inbound + quote-reply-to-E triggers without @e. Live room template
  hand-synced (was stale — seed is copy-if-missing). GAP on ROADMAP:
  capabilities refresher — resumed threads never learn new limbs (kickoff-only
  feed); reset a chat's thread to teach it today.
- **Stats humanized**: natural filenames (cap 120 word-boundary), twins
  deduped, member name: fields, former_names rename history.

## In flight RIGHT NOW (2026-07-04 afternoon adds)

- **TURN ORDERING FIXED + deployed (d036143, pid 9640)**: two same-conv
  mentions used to fuse into one reply (warm injectWhileBusy weave) + strand a
  '⏳ Thinking…' (no-nonce newest-text placeholder collision). Now: per-conv
  FIFO turn queue in spine.mjs (makeSerialByKey, keyed 1:1 with the warm key),
  placeholder ON ARRIVAL ('⏳ Queued (N ahead)…' → activates), each turn edits
  only its own out-handle, replies in arrival order — and different convs run
  FULLY CONCURRENTLY (the old pump globally serialized everything). Mention
  payload verified already single-line (ev.line). Registry lost-update race
  that concurrency exposed: FIXED same deploy (mutateState wraps whole
  load→mutate→write per writeState ref; /e wizard's operator-driven writes
  left as-is, out of window). Residual, operator's call: 3+ identical
  coexisting placeholders could still collide — a nonce would be airtight
  (old nonce removed by design d7614b8).
- **TURN VISIBILITY + TIMEOUT + CYCLE ACCUMULATION (da330cb, pid 32640)** —
  first acceptance run: queue/order/placeholders PASSED but turn 1 vanished
  silently (two swallow paths: post-brain throw rejected into the FIFO
  unlogged; empty text silently DELETED the placeholder). Now every turn exit
  resolves its placeholder visibly ('❌ Sending failed.' throw/timeout, '⚠️ no
  reply (turn failed/empty) ∎' empty/failure-shaped, isBrainFailureResult now
  consulted), reply RECORDED BEFORE delivery, bridge-level per-turn timeout
  10min (evicts hung warm session via new brainpool.evict, queue drains on),
  and QUEUED turns prompt with the ACCUMULATED cycle timeline (in-memory
  cycleBy buffer: chatter + E's own delivered replies + own mention line,
  CAP 40; immediate turns stay single-line).
- **STALE-TWIN PLACEHOLDER LANDMINE — the REAL silent-death root cause
  (1ea5f7e, pid 28212)**: the spine was innocent (all four "lost" replies were
  in transcript.md all along); bridge resolveSentMessageId bound a fresh
  placeholder's id to the NEWEST IDENTICAL-TEXT message — the first poll races
  the POST's upsert, so a stale orphaned '⏳ Thinking…' (seeded by the
  pre-queue collision era) got matched and every edit landed INVISIBLY on the
  old message (PUT succeeds → no fallback/error/log); self-perpetuating: each
  failure orphaned the next twin. Immediate turns died, queued ones (distinct
  text) delivered. FIX: pre-send id floor — snapshot newestChatMsgId before
  the POST, resolver skips any match ≤ floor (Beeper ids = per-chat sequence
  numbers); unbindable → §7 fallback posts fresh, visible. Old orphaned
  Thinking messages remain in chats as inert text (unmatchable now; delete
  manually if tidy). LIVE ACCEPTANCE OWED: one SOLO @e mention in SPOILER
  (still full of twins) → reply must land in the NEW placeholder.
- **mode: auto design DECIDED** (ROADMAP §3 updated): egpt plays the
  OPERATOR'S role (helpful, follow links, do as told), consults a configurable
  EGPT-AUTO advice channel when in doubt (kickoff teaches WHEN); independent
  threads; advice-channel emit needs a sanctioned fail-closed-gate path (same
  trust shape as relay_channel). BUILD NOT YET DISPATCHED — next up.

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
  fire-and-forgets member stats at the transcript.log chokepoint (per-path
  write serialization vs the thread mirror); operator-editable top-level
  `aliases:` block in config.yaml (display-time only); /status members renders
  alias+count+last_seen from stats, transcript fallback. LID↔phone NOT built —
  Beeper's local API exposes a single senderID, nothing to link (verified).
- **STATS RELOCATED out of the conv dir** (operator 2026-07-04): the conv dir
  is the being's CONFINED cwd (tamper/race risk), so stats are spine-owned
  now: `state/stats/<surface>/<chatId>.yaml` (per-chat: name, first_seen,
  threads, members; keyed by STABLE short chat id, rename-proof) +
  `state/stats/<surface>/<sanitized-senderId>.yaml` (per-contact cross-chat
  rollup: count, last_seen, name; sanitizeStatKey escapes ':' for Windows).
  setup/port-stats-location.mjs RAN live: 20 chat files moved, 3 contact
  rollups seeded, 0 stats.yaml left in conv dirs. Deployed; node respawned.
  Files SELF-IDENTIFY (operator screenshot fix): chat_id:/sender_id: body
  fields (real unsanitized ids, greppable both directions), honest headers,
  bijective unsanitizeStatKey, idempotent backfill pass in the port (ran
  live: 21+5 ids stamped).
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
- **RNG / GCP2** (plans/2607031636-RNG-GCP2.md): host a $300 HeartMath RNG; Mesh alignment
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
