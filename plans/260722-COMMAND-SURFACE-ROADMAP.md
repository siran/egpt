# egpt Command Surface — Phased Roadmap

Derived from `plans/260722-COMMAND-SURFACE-REVIVAL.md` (the design). Each phase is
**one shippable chunk**: reproduce-first test → surgical change → verify → commit.
Ordered so the cheapest high-value work lands first and the loop-breaker (phase 3)
lands **before** multi-brain chat (phase 4).

## Working rules (every phase)

- **Reproduce-first.** Write the failing test that models the behavior BEFORE the
  code. A feature gets a regression lock on neighboring behavior it must not break.
- **Surgical.** Touch only what the phase needs; match surrounding style. Every
  changed line traces to the phase goal.
- **Suite green before and after.** Baseline: 126 files / 1718 tests (main tree,
  after phase 1). NOTE: while an agent worktree exists under `.claude/worktrees/`,
  `npx vitest run` double-scans it (~2× counts) — use
  `npx vitest run --exclude "**/.claude/**"` for a clean main-tree count.
- **Commit per chunk**, specific `git add` (never `add -A`). No AI attribution.
- **Background agents do the coding**; the orchestrator scopes, verifies the diff,
  re-runs the suite, and commits. Agents must **not** commit and must **not** write
  to `~/.egpt` without asking.
- **No-touch:** don't edit `~/.egpt/config/conversations.yaml` live (node-written,
  races). Config *schema* changes go to `config.yaml` shipped defaults + code.

Every command below is wired in ONE place — `src/spine/commands.mjs` dispatch,
BEFORE the catch-all — so it lights up in the shell and Beeper and on both nodes.

---

## Phase 1 — Browser command wrappers

**Goal:** `/tabs`, `/open <url>`, `/tab <n>`, `/close <n>`; evict `/browse` + the
dead `browseTab` export.

**Touches:** `src/spine/commands.mjs` (dispatch), `src/tools/cdp.mjs` (remove
`browseTab`), `tests/spine-commands.test.mjs`.

**Reproduce-first:**
- `/tabs` with a fake CDP returning 2 tabs → reply lists both, numbered.
- `/open https://x` → calls `openTab`, reply names the new tab.
- `/tab 2` → `activateTarget` on the 2nd listed tab; `/close 2` → `closeTab`.
- Regression: `browseTab` has zero callers (grep-locked in a test) → its removal
  breaks nothing; full suite stays green.

**Build:** four thin dispatch handlers over existing `cdp.mjs` fns
(`listTabs/openTab/activateTarget/closeTab`); node-gate + operator-gate reuse the
`/chrome` pattern. Delete `browseTab` and the `/browse` recognizer.

**Verify:** suite green; live `/tabs` in the shell lists the real Chrome tabs.

**Commit:** `feat(commands): /tabs /open /tab /close over cdp.mjs; drop dead /browse`

---

## Phase 2 — Rooms & members core

**Goal:** `/rooms`, `/room <slug> join|leave|members` (+ `/members …` = current
room), `/members add tab <id>`, `/members <id> mode <disable|mention|all>`,
`/activate <id>`. Data model only — no relay yet (a member added, but a brain's
turn is still inert until phase 4).

**Touches:** `src/spine/commands.mjs`; a room/member store (extend the existing
NamedRoom `/room create` + `~/.egpt/rooms/<name>.yaml`); `src/tools/cdp.mjs`
(`listTabs` already returns URLs); a small **adapter registry** that matches a
tab URL against `config/brains/*-cdp.mjs` `urlMatch`. Tests:
`tests/spine-commands.test.mjs`, a new `tests/rooms-members.test.mjs`.

**Reproduce-first:**
- `/rooms` lists saved rooms, marks the current one.
- `/room devwork join` sets current; `/members` lists members with kind + mode +
  active state.
- `/members add tab 1` where tab 1 = a chatgpt URL → member added, **mode:disable**,
  active (tab open). `/members add tab 3` where tab 3 = gmail → **refused**, "no
  adapter matches".
- `/members chatgpt mode mention` → persisted mode change.
- `/activate chatgpt` when the tab is closed → `openTab(savedUrl)`, member active.

**Build:** member record `{ id, kind, adapter?, targetId?, url?, mode }`; the
adapter registry (load `config/brains/*-cdp.mjs`, expose `matchAdapter(url)`);
persistence alongside NamedRooms. Modes stored per member; default `disable` on add.

**Verify:** suite green; in the shell, add a chatgpt tab, see it in `/members` as
`mode:disable`, flip to `mention`, `/activate` after closing the tab.

**Commit:** `feat(rooms): members model — /rooms /room /members add tab|mode, adapter match`

---

## Phase 3 — One guard (turn counter)  ← lands before multi-brain

**Goal:** re-wire the orphaned `stop-guard` as the single guard: N consecutive
**non-human** turns → pause the room; a genuine human message resets. Config
`guard: { turns: 6, window: -1 }` in `config.yaml`, per-conversation override,
`-1` disables. Restores the human `STOP`/`RESUME` safe-word. Removes `flood-guard`
+ mesh breaker (per "drop G" — turn-counter is the one guard).

**The crux (makes turn-counter-only safe):** "human" is decided by **provenance,
not display name**. A turn resets the counter ONLY if it is a genuine inbound human
message — NOT a bot send (`wasSentByUs`, id-based), NOT relay/envelope traffic
(`isEnvelope`), NOT a being emit. This closes the 2026-06-19 hole (mesh posting as
the operator) that a name-based counter missed.

**Touches:** `src/stop-guard.mjs` (config-driven limits; provenance-aware reset),
its wiring at the prompt chokepoint (`src/spine/spine.mjs` / `gating.mjs`),
`src/bridges/beeper-port.mjs` (remove `createFloodGuard`), `src/mesh/relay.mjs`
(remove the local circuit breaker; mesh turns now count as non-human), config
plumbing (`guard:` replaces `flood:`), `conversations-state.mjs` (per-conv
override read). Tests: `tests/stop-guard.test.mjs` (extend), a new
`tests/guard-provenance.test.mjs`.

**Reproduce-first:**
- 6 consecutive brain turns with no human → 6th trips `stop`; room paused.
- A genuine human message resets the counter to 0 (normal human↔bot never trips).
- **2026-06-19 lock:** a burst of mesh-posted-**as-operator** messages counts as
  non-human (provenance) → trips at `turns`, does NOT reset. (Fails today —
  name-based reset — passes after the provenance change.)
- `guard.turns: -1` (global or per-conv) disables tripping.
- `STOP` / `RESUME` safe-word blocks/clears prompting for the channel.

**Build:** thread config into `createStopGuard({ turns, window })`; add
provenance predicate `isHumanTurn(ev)` (inbound ∧ ¬wasSentByUs ∧ ¬isEnvelope ∧
¬beingEmit); call `noteHuman`/`noteBeing` at the single prompt chokepoint; delete
the two burst guards and their tests. `window` (minutes) optionally ages out old
turns; `-1` = pure consecutive.

**Verify:** suite green; live: force a 2-brain room (phase 4 dep — test with a
scripted double-emit) and confirm it stops at 6; confirm a human line resumes.

**Commit:** `feat(guard): single turn-counter guard, provenance reset; drop flood+mesh burst guards`

> Flag for review: this **removes the currently-wired flood-guard**. It's a
> deliberate simplification (per drop-G); the provenance-aware turn counter is the
> replacement and the 2026-06-19 test is the proof. Sanity-check this step's diff
> before commit.

---

## Phase 4 — Adapter relay (chatgpt only)  ← the consolidation

**Goal:** a `chatgpt` tab member's turn runs through its adapter + `streamFromTab`,
streaming the reply into the room; `@mention` routing honors member mode
(`disable`/`mention`/`all`). claude/grok adapters come later, unchanged pattern.

**Touches:** `src/spine/brainpool.mjs` (route a member whose adapter is
`chatgpt-cdp` through the CDP relay instead of `ccode`), `config/brains/chatgpt-cdp.mjs`
(adapter, already exports inject/poll + `urlMatch`/`homeUrl`), the room fan-out
(deliver a room message to each member per mode), `src/tools/cdp.mjs`
(`streamFromTab`, unchanged). Tests: `tests/adapter-relay.test.mjs`.

**Reproduce-first:**
- A room with a `chatgpt` member at `mode:mention`: `@chatgpt hello` → the relay's
  `injectScript` is invoked with "hello", `pollScript` streams a reply back into
  the room (fake CDP socket in the test). At `mode:disable` → not reached. At
  `mode:all` → reached by any room message.
- The streamed reply fans out to the other members (shell + whatsapp) once.
- Guard interplay (regression on phase 3): two brains at `mode:all` answering each
  other stop at `guard.turns`.

**Build:** in the fan-out, for each member whose mode admits the message, if the
member is a web-brain → `streamFromTab(targetId, adapter.injectScript(text),
adapter.pollScript)`, post the finalized reply as that member into the room. Each
brain reply is a non-human turn (feeds the phase-3 counter).

**Verify:** suite green; live: add a real chatgpt tab (mode:mention), `@chatgpt`
a question in the shell, watch the streamed answer appear; confirm a runaway
2-brain room halts at 6 turns.

**Commit:** `feat(relay): chatgpt web-brain members answer via streamFromTab, mode-gated`

---

## Phase 5 — Channels & join

**Goal:** `/channels [slug]` (grouped by network, ~15 recent, `<slug>` filters);
`/join <slug>` binds a Beeper chat as a room member (bidirectional mirror).

**Touches:** `src/spine/commands.mjs`; `src/bridges/beeper.mjs`
(`listChats`/`resolveChatId` exist); room membership from phase 2. Tests:
`tests/spine-commands.test.mjs`.

**Reproduce-first:**
- `/channels` with a fake `listChats` → grouped, numbered, network headers.
- `/channels devs` → filters to the match.
- `/join devs` → resolves via `resolveChatId('devs')`, adds a chat member; a shell
  line posts to the chat and a chat message renders on the shell (mirror test).

**Verify:** suite green; live `/channels` lists real chats; `/join` a low-traffic
chat and confirm the two-way mirror.

**Commit:** `feat(channels): /channels grouped listing + /join chat-as-member mirror`

---

## Phase 6 — allowed_users per-conversation override

**Goal:** layer a per-conversation `allowed_users` on top of the surface-level list.

**Touches:** `src/spine/boot.mjs` (`isAllowedUser`), `conversations-state.mjs`
(per-conv read), config docs. Tests: extend the boot/gating tests.

**Reproduce-first:** a sender allowed by a conversation override but absent from
the surface list is admitted for that conversation only; a sender in neither is
refused; the surface list still applies where no override exists.

**Verify:** suite green.

**Commit:** `feat(auth): per-conversation allowed_users override over surface list`

---

## Phase 7 — Long tail

`/recap` `/last` `/summarize` `/conversations` `/config` `/log` `/version`
`/who <slug>` `/identity` `/mirror` `/room leave`. Each: reproduce-first test in
`tests/spine-commands.test.mjs`, thin dispatch handler, commit per small batch.
`/status` stays shelved (`~`). `/handle /movie /textmovie /storm /rules /browse`
not revived.

**Backburner (after the relay is solid):** files/images from a brain reply
downloaded into the room's `base_dir` + surfaced as links.

---

## Phase dependencies

```
1 browser ─┐
2 rooms ───┼─► 3 guard ─► 4 relay ─► (multi-brain safe)
5 channels ┘        6 allowed_users        7 long tail
```

Phase 3 (guard) is the gate before 4 (relay): no multi-brain chat until the
loop-breaker exists. 1, 2, 5, 6, 7 are otherwise independent and can interleave.
