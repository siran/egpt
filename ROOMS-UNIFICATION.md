# Rooms ↔ Sessions Unification

> Design reference. Status: **planned** (2026-05-31). Baseline: `main` @ recovered
> beta-17 + rooms fixes. Build against this; update it as phases land.

## Why

eGPT accumulated **three** overlapping structures for "a brain you talk to,"
which is the core of where the project went astray (duplicate "rooms" concepts,
URL-as-path crashes, `/room work` vs `/attach work` namespace splits):

| Today | What it is | Lives in |
|---|---|---|
| in-memory `sessions` Map | the current room's open brains | React state → `resolveRoute` |
| `roomSessionsMap` / `_rooms/*.yaml` | "a room = a saved bundle of sessions" | `~/.egpt/conversations/_rooms/` |
| membership `config.yaml` brain member | `{kind:'brain', id, state}` — **no options** | `~/.egpt/rooms/config.yaml` |

The insight (operator, 2026-05-31): **a "session" is a precursor to "member of a
room."** Collapse the three into one.

## Target model

A **room** has **members**. A member is `{ kind, id, state, ... }`. A `brain`
member additionally carries its `brain` type and its `options`. The in-memory
`sessions` Map and the `_rooms` bundles both disappear — **a room's brain members
ARE its sessions.**

```yaml
# ~/.egpt/rooms/config.yaml  (the single source of truth)
rooms:
  work:
    members:
      - { kind: shell,    id: shell,        state: active }
      - { kind: brain,    id: cgpt1,        state: active,
          brain: chatgpt-cdp, options: { targetId: 0AD52CB4… } }
      - { kind: wa-group, id: 1203…@g.us,   state: active }
```

- `kind` ∈ `shell | extension | brain | wa-group | tg-group`
- `state` ∈ `muted | mention | active` — see **Room member states (refined)**
  below for the exact, uniform semantics. (`room-routing.mjs`.)
- brain `options` ⊇ `{ url?, targetId?, sessionId?, cwd?, model?, effort?, profileName? }`
  (the existing `normalizeSession` shape).

## Locked decisions

1. **`/use` is a separate per-shell routing layer, NOT member `state`.**
   `state` = "does this member contribute to room fan-out." `/use` = "where my
   plain text goes right now." `/use cgpt1,claude1` resolves each token
   **`@`-stripped, comma/space-split** against the current room's brain members.
   (This is why a blunt strip-the-`@` fix was rejected — `/use` is multi-recipient.)
2. **Single store:** `~/.egpt/rooms/config.yaml` (membership) is the one source of
   truth. `_rooms/*.yaml` is migrated once, then deleted.

## Room member states (refined 2026-06-01)

Two simplifications over the original "gates contribution, type-dependent" read:

1. **`muted` is absolute and uniform** — no member-kind branching. A muted
   member contributes to **nothing** (no other member, no WhatsApp/Telegram, no
   brain), and a muted brain is **never prompted — not even by an `@mention`**.
   It may still *see* the room (lurk); it just never speaks into it or is
   dispatched. ("muted is muted, period.")
2. **`mention` is meaningful only for brains.** Humans / groups / shells are
   *spontaneous* (not prompted), so for them only `active` (speak into the room)
   or `muted` (silent) make sense — `mention` is degenerate and maps to
   `active`. The `active`↔`mention` split is the inherent prompted-vs-spontaneous
   difference, not arbitrary type-branching.

| state | human / group / shell (spontaneous) | brain (prompted) |
|---|---|---|
| **muted** | sees the room, says nothing | never prompted (not even `@mention`) |
| **active** | everything it says enters the room | every room message dispatched to it (+ reply fans back); **queued while the brain is busy** so nothing is dropped |
| **mention** | = `active` (degenerate) | only `@<brain>` messages dispatched (+ reply back) |

Implementation deltas from the current code:

- **`planFanout`** (`room-routing.mjs`): contribution becomes simply
  `state !== 'muted'` — drop the `mention && @mention` gate, so a non-brain
  `mention` contributes like `active`.
- **brain dispatch** (`_deliverToRoom` in `egpt.mjs`): skip a `muted` brain
  *first*, so `@mention` no longer wakes a muted brain.
- **wire room→dispatch for ALL brains**, not just `@e` (today `egpt.mjs` skips
  `@cgpt2` with `"room-dispatch not wired yet (only @e)"`).
- an `active` brain **piles/queues** room messages while mid-reply (extend the
  persona-pile) and drains when idle.

Rollout: low-risk first (uniform `muted` + non-brain `active|muted`), then the
bigger piece (all-brain room dispatch + busy-queue).

## Mapping (today → target)

| Today | Target |
|---|---|
| in-memory `sessions` Map | brain members of the current room |
| `roomSessionsMap[room]` / `_rooms/*.yaml` | members of each room in `config.yaml` |
| `config.yaml` brain `{kind,id,state}` | enriched with `{brain, options}` |
| `activeSessions` (`/use`) | per-shell selection over the room's brain members |
| `currentRoom` | shell-local **focus** pointer (which room plain input addresses); not membership |

## Open questions (decide as we reach them)

- **Brain identity — per-room or global?** Can `cgpt1` (a tab) be a member of two
  rooms? Lean: brain members are per-room; the same underlying `targetId` may back
  members in more than one room (rare). Revisit in Phase 2.
- **`currentRoom` semantics** vs the shell being an `active` member of multiple
  rooms. Lean: keep `currentRoom` as a pure shell focus pointer; fan-out is driven
  by membership, independent of focus.

## Phased plan

Each phase is shippable and keeps the test suite green. The discipline that was
missing before: **change behind an adapter, prove with tests, then flip the source.**

### Phase 0 — stop the bleeding (small)
- `/attach` attaches into a **membership** room instead of auto-creating a
  session-room. Retire `/save-room` and the legacy `/rooms` snapshot list.
- **Fixes:** the `work` (session-room) vs `test` (membership-room) namespace split;
  bug #1 `/room work members → "no room work"`.

### Phase 1 — enrich (behind an adapter)
- Brain members carry `{brain, options}` in `config.yaml`.
- Add `sessionsMapFromMembers(room)` → builds the in-memory `sessions` Map *from* a
  room's brain members. `resolveRoute` is **unchanged**, just fed from members.
- `/open` and `/attach` upsert brain members (with options).
- Lean on existing `room.mjs` / `room-routing.mjs` pure tests.

### Phase 2 — rewire
- `resolveRoute` reads members directly. Retire the separate `sessions` Map and
  `roomSessionsMap`. Keep the `peerSessions` (bus) mapping intact.

### Phase 3 — delete + finish
- Remove `loadAllRooms` / `saveRoomToDisk` / `deleteRoomFile` / `_rooms`.
- Token-aware `/use` and `@`-resolution over members.
- **Fixes:** bug #2 `/use @cgpt1 → "unknown session"` (token `@`-strip + room
  scoping), done right rather than hacked.

## Migration

One-time on boot: for each `_rooms/*.yaml`, upsert its `sessions` as `brain`
members (with options) into the matching `config.yaml` room; then archive `_rooms`.
Bare brain members already in `config.yaml` keep working (options optional).

## Risk

`resolveRoute` is the routing heart; `peerSessions` (the bus) also references the
session shape. Phase 1's adapter (members → `sessions` Map) lets us move without
touching routing behavior first, then flip the source in Phase 2 with tests green
throughout. `room.mjs` and `room-routing.mjs` are already pure + unit-tested — that
is the lever.
