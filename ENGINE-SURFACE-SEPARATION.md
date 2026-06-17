# Engine ↔ Surface Separation

## Current branch status

The executable split has started:

- `egpt.mjs` is now a role launcher. It does not import Ink or the legacy
  engine at module load.
- `egpt-spine.mjs` is the legacy spine entry while the engine is extracted out
  of the old monolith. It still contains the historical Ink-backed runtime
  internally, but it is no longer the public launcher.
- `src/shell/ink-limb.mjs` is the local terminal shell as a thin limb: it imports
  Ink plus the attach client, renders nucleus frames, and forwards typed input.

This is an intermediate state. The visible shell is now a limb, but the spine
still needs the remaining engine extraction work before the engine path is free
of legacy Ink internals.

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

## Command interpretation (engine-first) — 2026-06-01

A `/command` is NOT a chat message and must not be routed like one. Today it can
fall through the chat path: a WhatsApp command that fails the per-surface auth
gate (or isn't recognized at ingress) flows on as a normal message — fanned to
rooms, surfaced/mirrored to the shell — instead of being interpreted. So whether
a command runs ends up depending on room membership + the shell's room state.
That conflation is the bug behind "I sent `/restart` on WhatsApp and it didn't
pick up; it got mirrored to the shell instead."

Clean model:
1. **Commands are an engine concern, surface-agnostic.** A `/command` from an
   authorized operator (WA self-DM, shell, limb, extension) is interpreted by the
   ENGINE directly — never fanned to rooms, never mirrored to another surface for
   re-interpretation, never gated by a member's room state. Commands and chat are
   different channels.
2. **Robust operator identity.** Recognize the owner across ALL jid forms (phone
   + lid) and linked devices (phone, Beeper, the bridge). A message in the
   operator's self-DM is authorized regardless of `fromMe`/jid-form. *(Landed
   2026-06-01: WA auth treats any self-DM message as authorized, and
   `allowed_users` carries both the phone and lid numbers — un-breaks `/restart`
   sent via Beeper.)*
3. **One interpreter.** The engine has a single command path (`handleSlash`);
   surfaces hand it the raw line + an authorized-operator flag and it decides. A
   limb forwards the line over the attach socket; the engine interprets. No
   surface re-interprets a command it merely received as a mirrored item.

Status: the auth robustness (2) landed as a targeted fix. The structural split
(1, 3) — interpret authorized commands at ingress, independent of the
chat→room→mirror path — is the remaining work, and slots into the engine
extraction (Phase C): the interpreter becomes an explicit Engine method every
surface routes commands through.

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
