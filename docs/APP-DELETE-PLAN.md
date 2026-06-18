# App Delete Plan

Status: implemented on branch `app-delete`; keep this as the rationale and
verification checklist for the App deletion.

## Purpose

Finish Phase C of `ENGINE-SURFACE-SEPARATION.md` by removing the remaining
React-shaped lifecycle from the spine.

The engine/spine no longer imports React, Ink, or the temporary
`src/spine/headless-runtime.mjs` hook shim. `egpt-spine.mjs` now starts a plain
imperative runtime, registers the engine input/output/attach/gate wiring, and
owns cleanup explicitly.

## Product Shape

The architecture we are preserving is:

```text
surfaces
  shell limb
  browser extension
  future Gmail / other limbs
      |
      | attach / transport event
      v
engine
  Room as semantic center
  transport adapters: WhatsApp, Telegram, Beeper, future Gmail
  brain adapters: CDP sessions, ccode CLI, local llama
  dispatch, slash interpreter, transcripts, room state
  input, output, attach host, emit gate
```

React, Ink, DOM, CodeMirror, and similar UI libraries belong in surfaces. They
must not be required by the engine/spine path.

## Current State

Already landed on `main`:

- `egpt.mjs` is a launcher.
- `src/shell/ink-limb.mjs` is the terminal UI surface.
- `egpt-spine.mjs` is spine-only. The old in-process client path is gone.
- `egpt-spine.mjs` no longer imports React or Ink.
- `src/engine/index.mjs` owns the four chokepoints:
  - input: `engine.submit()` / `engine.setSubmit()`
  - output: `engine.emit()` / `engine.subscribe()`
  - surface host: `engine.startAttach()`
  - outbound safety gate: `engine.mayEmit()` / `engine.configureGate()`

Completed on `app-delete`:

- pure dispatch helpers moved to `src/dispatch-helpers.mjs`
- WA joined/bound chat set moved to `src/wa-joined.mjs`
- reply-target helpers moved to `src/reply-targets.mjs`
- bridge item formatters moved to `src/item-format.mjs`
- local shell UI deleted from the spine
- `function App()` and `src/spine/headless-runtime.mjs` deleted

## Non-Goals

- Do not redesign Room semantics during this move.
- Do not rewrite WA/TG/Beeper behavior while moving it.
- Do not change reply routing, auto-mode, stop-guard, or emit-gate semantics.
- Do not remove React from the browser extension or Ink shell limb.
- Do not combine this with Gmail-as-limb or new transport work.

This is a relocation and lifecycle conversion, not a feature project.

## Invariants

Every iteration must preserve these:

- `egpt-spine.mjs` does not import React or Ink.
- `src/shell/ink-limb.mjs` does not import spine internals.
- The only local terminal UI is the shell limb.
- A message from shell, attach, WA, TG, Beeper, or future surfaces enters through
  the engine input boundary.
- All visible output goes through the engine output boundary.
- E outbound emission stays gated by `engine.mayEmit()`.
- Room fanout remains the only general multi-surface routing model.
- Transport adapters may own protocol details, but not redefine Room semantics.

## Iteration Plan

### 1. Lift remaining pure/state helpers

Move closure-free or nearly closure-free logic out of `App()` first.

Candidates:

- accum/backlog buffer helpers
- help-menu state helpers
- reply-target id helpers
- transcript file/path helpers
- small room/session helper wrappers

Pattern:

- create a module under `src/`
- pass config/state as arguments
- leave a thin alias at the old call site
- add focused unit tests

### 2. Convert item-append side effects

The current component uses `items.length` effects as a proxy for "an item was
appended." Replace that with an explicit engine event.

Target shape:

```js
engine.appendItem(item)
```

or equivalent, where append hooks handle:

- reply-target bookkeeping and save scheduling
- Telegram mirror
- WhatsApp mirror
- any scroll/render-only bookkeeping that can be deleted headlessly

Avoid keeping an `items` array as the hidden event bus.

### 3. Convert room/session mutation side effects

The current component uses state changes to trigger persistence and peer
broadcasts. Make those explicit events.

Targets:

- `setSessions` mutation path posts `sessions-update`
- room session map mutation schedules room persistence
- room save/delete and membership dual-write happen on the mutation path

The engine should own the mutation methods; callers should not rely on React
state changes to make persistence happen.

### 4. Convert transport toggles and peer events

Replace dependency-driven effects with direct event calls.

Targets:

- peer-online / peer-change triggers Telegram boot handoff logic
- Telegram polling toggle posts status
- bridge start/stop stays explicit and idempotent

The behavior should read as transport lifecycle code, not React lifecycle code.

### 5. Move run-once subsystem starters into `engine.start()`

Most `useEffect(..., [])` blocks are plain start/stop routines. Move them into
an imperative lifecycle.

Targets:

- output log subscription
- shell mirror reader, if still needed
- Telegram bridge start/stop
- WhatsApp/Beeper bridge start/stop
- outbox watcher
- inbox watcher
- heartbeat
- control-plane bus / peer announce
- local llama supervisor
- engine submit/gate wiring
- transcriptor worker

Target shape:

```js
const engine = createEngine(...);
await engine.start();
process.on('exit', () => engine.stop());
```

Each starter should return a cleanup function or register one with the engine.

### 6. Move submit orchestration into the engine

Move `submitInner` and the state it couples to out of `App()`.

Expected hard dependencies:

- bridge refs
- stop guard
- output sink
- dispatch runtime
- stream factory
- warm session pool
- room helpers
- reply-target maps
- current room/session state

Do not re-derive the logic. Move it behind the already-existing
`engine.submit()` boundary.

### 7. Delete `App()` and the headless runtime

After the above moves, the spine boot should be plain code:

```text
load config
create engine
await engine.start()
install process signal/crash handlers
```

Then delete:

- `function App()`
- `MultiLineInput` from `egpt-spine.mjs`
- imports from `src/spine/headless-runtime.mjs`
- `src/spine/headless-runtime.mjs`
- tests that only lock the temporary shim

Keep the Ink shell limb.

### 8. Verification pass

For every meaningful iteration:

- syntax check changed modules
- run focused unit tests
- run integrity tests

For merge/deploy milestones:

- full `npm.cmd test`
- isolated headless boot with temp `EGPT_HOME`
- attach smoke: connect limb client, send `/help`, receive item/sys frame
- live E turn where allowed emission must succeed
- WA/TG ingress smoke when touched
- `/restart` smoke
- one real Room fanout check before declaring Phase C done

## Completion Criteria

Phase C is done when:

- `egpt-spine.mjs` has no `function App()`.
- `egpt-spine.mjs` has no imports from `src/spine/headless-runtime.mjs`.
- `src/spine/headless-runtime.mjs` is deleted.
- Engine start/stop is plain imperative code.
- Engine input/output/attach/gate tests still pass.
- Room, bridge, and dispatch behavior is unchanged in live smoke tests.
- React/Ink remain only in real UI surfaces.

## Collaboration Notes

- Work on `app-delete` or a branch based on it, not `main`.
- Keep commits small and named by the moved unit.
- Prefer "move with alias, test, commit" over broad rewrites.
- If an iteration changes behavior, stop and make that behavior change explicit.
- Do not deploy from a dirty `main`; `/restart` respawns from the main checkout.
