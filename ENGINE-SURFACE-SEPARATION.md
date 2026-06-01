# Engine ↔ Surface Separation

> Design reference. Status: **planning** (2026-05-31). Sequenced **before** the
> rooms↔sessions unification (process topology is more foundational). Build
> against this; it weighs salvage vs rebuild and records the lessons from why the
> spine went astray.

## Goal

A **central egpt engine** that is **always running**, owns the transports
(WhatsApp/Telegram) and all state (conversation files, rooms, personas, brain
dispatch, the interpreter), and processes input whether or not a human is
watching. **Surfaces** are thin: they feed input to the engine and render its
output. The interactive Ink shell is *one surface*; the browser extension is
another; WhatsApp/Telegram are transport surfaces the engine owns directly.

```
        ┌──────────── surfaces (thin) ────────────┐
        │  Ink shell      browser ext             │   CLIENT surfaces
        └─────┬───────────────┬───────────────────┘   (attach over loopback TCP)
              │   attach       │
              ▼                ▼
        ┌──────────────────────────────────────────┐
        │            egpt ENGINE (always on)         │
        │  interpreter · rooms · dispatch · state    │
        │  ┌──────────────┐    ┌──────────────┐      │
        │  │  WhatsApp     │    │  Telegram     │     │   TRANSPORT surfaces
        │  └──────────────┘    └──────────────┘      │   (owned in-process)
        └──────────────────────────────────────────┘
```

## The symptom that motivates this

`node egpt` was not running. A `/restart` sent over WhatsApp sat unprocessed
until an interactive shell was opened — because in the recovered baseline the
engine **only exists while a shell or `--headless` process is up**, and the two
swap WhatsApp via a pidfile "helm" handshake. No always-on engine ⇒ lost
messages; `/restart` needs `EGPT_SUPERVISED` ⇒ fails without a supervisor.

## What the spine got right vs wrong

The spine/nucleus refactor (abandoned on `dev`) targeted **exactly this model**.
It did not fail at the separation. It failed at the lifecycle around it.

**Right — salvage these (clean, ~500 lines, already unit-tested):**
- `src/attach/protocol.mjs` (68) — NDJSON frame protocol, stateful decoder.
- `src/attach/server.mjs` (141) — loopback-TCP server; signed HELLO handshake
  (HMAC over `~/.egpt/bus.key`) with a replay/freshness guard; turns each socket
  into a `Surface { send, startStream, sys, stop }`.
- `src/attach/client.mjs` (95) — one-shot authenticated client; "reconnect is the
  caller's job" (a UI retry loop) — the right call.
- the **surface registry** + fan-out in `src/nucleus.mjs` (186).

**Wrong — do NOT carry these over:**
- **Three liveness mechanisms** (standalone `watchdog.ps1` + daemon integrated
  watchdog + WA bridge probe) racing to kill each other's processes.
- **`/restart` as a cross-process exit-code dance** (WhatsApp → daemon → respawn,
  codes 42/43/44) with announce/bounce sidecars.
- **`nucleus.json` discovery races** (predecessor deleting the live successor's
  sidecar; the periodic re-assert was a band-aid).
- **The `CLIENT_MODE` gating maze**: the spine ran the *whole 8746-line Ink App*
  in both engine and client mode, gated by 18 `if (CLIENT_MODE) return` sites.
  That is the smell — it punted on the real work (below) and bolted a second mode
  onto the monolith.

## The real cost (be honest)

The transport is the *easy* part — ~500 salvageable lines. The hard, dominant
work is that **the engine is fused into the Ink App** in `egpt.mjs`: WhatsApp
wiring, Telegram, dispatch, rooms, persona, and conversation state all live
inside the React component and its closures (`submit`, `_deliverToRoom`,
`onIncoming`, refs). A *truly thin* client is impossible until the engine core is
**extracted out of the Ink component** into something that runs headless and is
imported by the engine entry but **never** by the client.

This is the same "8746-line monolith is the risk" finding from day one. The spine
avoided this extraction (hence the gating maze). We should not.

## The lifecycle rule (the inversion of what broke)

> **One engine. One supervisor (or none). No liveness-kill watchdog. No
> restart-via-exit-code. No takeover handshake.** The engine just runs; surfaces
> attach/detach freely; "restart" is the engine re-exec'ing itself; if it dies,
> exactly one thing restarts it.

Concretely:
- **Discovery:** a single, fixed loopback port (from config) or one atomically
  written read-only sidecar that the engine never rewrites in a loop. If the port
  is taken, an engine is already running — that *is* the singleton check.
- **Supervision:** ONE of {OS service (systemd/launchd/Task Scheduler), or a
  trivial Node supervisor that restarts only on process exit}. No alive.txt
  polling that kills. No WA-staleness kills (a wedged bridge is the bridge's
  problem to reconnect, not a reason to SIGKILL the engine).
- **Restart:** the engine re-execs itself (or exits 0/non-0 and the single
  supervisor restarts it). Surfaces auto-reconnect via the client retry loop the
  spine already implements. `/restart` from WhatsApp simply triggers that — no
  exit-code relay, no announce/bounce sidecar.

## Approach decision (to lock after this doc)

- **Transport:** SALVAGE the spine's `attach/*` + surface registry. They're clean
  and tested; rebuilding them buys nothing.
- **Engine core:** EXTRACT incrementally from `egpt.mjs` (see phases) rather than
  big-bang or gate-in-place. This is the crux and the risk.
- **Lifecycle/supervision:** REBUILD minimal, per the rule above. Discard the
  spine's daemon/watchdog/restart code entirely.

## Phased plan (each phase shippable, tests green)

### Phase A — always-on engine, pragmatic (stops today's pain)
Run `--headless` as a single always-on engine under ONE trivial supervisor (or OS
service) with **no watchdog**. WhatsApp is never dead again. The interactive shell
still works via the existing pidfile handshake for now (clunky but functional).
*No architecture change yet — just operational.*

### Phase B — define the engine interface
Carve a stable in-process `Engine` API out of the App: `submit(input, meta)`,
`onOutput(cb)`, `attachSurface(surface)`, `listRooms()`, etc. The App keeps
working but now calls `Engine` instead of reaching into closures. No transport
yet; this is the seam.

### Phase C — extract the engine from Ink
Move the engine subsystems (WA, TG, dispatch, rooms, state, interpreter) out of
the React component into a headless `engine` module behind the Phase-B interface.
The engine runs with no Ink. The App becomes a consumer of `Engine`. Test each
subsystem move green.

### Phase D — wire the salvaged transport
Engine entry (`egpt-engine`) runs the attach server (salvaged) + owns transports.
The Ink shell becomes a **pure client**: it imports the attach client only,
connects, sends input, renders output — it does **not** import the engine. Kill
the `CLIENT_MODE` gating; there is no shared dual-mode App anymore.

### Phase E — minimal supervision + restart
One supervisor, the lifecycle rule above. `/restart` = engine re-exec; surfaces
reconnect. Delete the spine's daemon/watchdog/exit-code machinery for good.

## Open questions

- **Where exactly is the engine/UI line?** Theming, emoji, time formatting are
  presentation (client-side); dispatch/state are engine. Some helpers straddle.
- **Extension transport:** same attach client as the shell, or its own path?
  (Lean: same protocol, so one engine serves both.)
- **Rendering for transport vs client surfaces:** the engine renders plain text
  for WA/TG; clients want structured items (author, stream ids, theme hints). The
  `Surface.send(item)` shape from the spine already anticipates this.
- **Relationship to rooms unification:** do Phase A–B first, then decide whether
  rooms↔members lands before or after Phase C extraction.
```
