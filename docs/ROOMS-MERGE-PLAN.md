# Plan — merge `conversations` ↔ `rooms` into one Room model

Spec: **GENOME §2.5** (the Room abstraction). This is the implementation roadmap.
Principle: a deliberate, phased migration — each phase ships green + tested + is
independently revertable. No phase changes behavior the previous one didn't already
cover. The SDK/codex retirement is LAST, only after everything else is verified live.

Target end-state (from §2.5):
- **Room** = host(s) + members(+state) + `transcript.md` · `media/` · `files/` ·
  `identity.d/` · `config`. ONE implementation, ONE folder tree, TWO roots:
  `conversations/<surface>/<slug>/` (born from a chat, 1 host) and `rooms/<name>/`
  (deliberate, ≥1 hosts).
- residents = a Room's `brain` members. `/use`/`/room` = the router-level membership
  editor; config = the declarative seed of the same store.
- A message fulfils every Room it touches (dual-write: conversation transcript
  UNCONDITIONAL; room transcript per member-state). Media owned by the conversation,
  referenced (relative path) into Rooms — never copied. Confinement structural.

---

## Phase 0 — Room model + folder-tree helpers (pure, no behavior change)
**Goal:** one module that defines the Room shape and the path helpers both roots share.
- New `src/room-folder.mjs` (pure): `roomFolder({root, surface?, slug|name})` →
  the base dir; `transcriptPath / mediaDir / filesDir / identityDir / configPath`
  derived from it — IDENTICAL shape for `conversations/<surface>/<slug>/` and
  `rooms/<name>/`. `conversations-state.slugDir` and `rooms.roomDir` re-export from it.
- **Tests:** both roots yield the same tree; helpers resolve; `slugDir`/`roomDir`
  unchanged for existing callers (characterization tests).
- **Risk:** none (pure, re-export). Revert = delete module.

## Phase 1 — A conversation IS a single-host Room (members + `/use`)
**Goal:** residents become Room membership, editable at the router.
- Conversation config gains `members[]` with per-member `state` (`muted|mention|active`)
  — humans + brains. Seed from today's `residents_per_chat` + `auto_e_modes` (read both
  as the declarative seed; write the unified store).
- `/use [<name>…] [in|out|both]` invoked IN a chat edits THAT chat's members, persists,
  and routes through the bridge (the one router) on every surface. Shell `/use` becomes
  the shell-Room's instance of the same op. `@mention` = one-turn join (already wired).
- `residents_per_chat` keeps working (seed) but is no longer the only door.
- **Tests:** residents resolve from membership; `/use` add/remove persists + survives
  restart; seed-from-config still works; disabled members (`enabled:false`) excluded.
- **Risk:** medium (membership state model). Rollback = config seed path unchanged.

## Phase 2 — Rooms reference chats as members/hosts; dual-write
**Goal:** a message in a chat that's in a Room lands in BOTH, gated correctly.
- A `rooms/<name>/` Room's `members[]` may include surface chats (host bindings). The
  fan-out (already loop-guarded, `room.mjs`/`room-routing.mjs`) ALSO appends the
  contributed line to the Room's `transcript.md`.
- Two write rules (GENOME §2.5): conversation transcript UNCONDITIONAL (I3); room
  transcript per the member's `state` (active=all, mention=@-only, muted=none).
- **Media:** room transcript references the conversation's media by a path RELATIVE
  to the conversation folder (resolved via the line's `Name@[chat].surface` stamp →
  member→folder map). No byte copy. `rooms/<name>/files/` is the shared shelf (members RW).
- **Tests:** dual-write present; muted member contributes nothing to the room; media
  referenced not copied + relative path resolves; loop-guard still holds (no re-dispatch).
- **Risk:** medium-high (touches routing). Rollback = drop the room-transcript append.

## Phase 3 — Confinement under the unified model (verify, don't regress)
**Goal:** the structural wall (GENOME §2.5) holds when membership drives `confineToDirs`.
- `confineToDirs` = own conversation folder ∪ its Room folders (RW) ∪ grants — derived
  from Room membership (already the shape in `dispatch.mjs:916-932`).
- **Tests:** cross-conversation read/write DENIED (claude engine); `rooms/files/`
  readable+writable by members; sharing only via the Room; meta-engineers unconfined.
- **Risk:** low (mechanism exists; this locks it with tests).

## Phase 4 — Retire codex + claude-sdk → one engine (ccode). `ack sdk *.mjs` == nil
**Only after Phases 0-3 are verified working live.**
- Codex already disabled (`enabled:false`, 2026-06-15). Remove codex brain + sibling
  defs (or leave disabled), drop `default_brain_fallback`/`DEFAULT_PERSONA_BRAIN` codex.
- Remove `config/brains/claude-sdk.mjs`, the `claudeSdk` import, the warm-routing
  `claude-sdk` branches, and the `claude-sdk` token in `isBrainFailureResult`. Convert
  `default_brain`/`jay` from `claude-sdk` → `ccode` (warm already routes both through
  the ccode CLI — `claude-args.mjs` is the live confinement). Update GENOME §2.5 (drop
  the "SDK cold fallback" line) and §2.3.
- **Tests:** suite green on ccode-only; a brain-resolution test asserts no `claude-sdk`
  type resolves; **`ack sdk *.mjs` returns nil** (the acceptance check).
- **Risk:** medium (engine consolidation). Do it last, with a tagged commit to revert to.

---

## Cross-cutting
- **Migration:** one-shot, idempotent, backed-up (mirror the slug-rename migrations):
  existing `conversations/` + `rooms/` → unified shape; `residents_per_chat`/`auto_e_modes`
  → members. Boot-wired behind the existing migration chain.
- **Coverage (operator ask):** every phase ADDS tests (behavior, not just unit) — the
  dual-write, the membership editor, the confinement wall, the engine consolidation.
- **Reversibility:** each phase is a self-contained commit; Phase 4 gets a pre-removal tag.
