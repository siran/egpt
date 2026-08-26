# SHELL LIMB + S1 SPINE — design plan

> **AMENDMENT 2026-08-26 — the shell socket's direction is INVERTED.** Everything below is
> preserved as written; this note records where it is now wrong. §0/§1/§3/§7/§8 state the
> invariant "the spine is a CLIENT of its surface apps" and apply it to the shell: the editor
> serves `ws://127.0.0.1:23375`, the spine dials out. **For the SHELL that is now reversed —
> the SPINE serves 23375 and holds it from boot; the EDITOR is the client that dials in and
> authenticates.** (The BEEPER limb is unchanged: Beeper Desktop is a third-party app that
> serves 23373 by its own design, so the spine still dials it. The invariant was over-general —
> it was derived from Beeper and applied to an app that is ours.)
>
> Why: (1) the durable process should be the server and the transient one the client — the
> spine is always running, the editor is opened and closed; (2) auth becomes
> client-proves-to-server, the conventional direction; (3) **decisively** — the spine binds at
> boot and HOLDS the port, so there is no unbound window to squat. With the editor serving,
> 23375 was free whenever the operator's editor was closed (the usual state), and any local
> process — notably a sandboxed pool account, which can bind loopback freely, Windows having
> no per-user loopback namespace — could take the port and receive the spine's outbound
> connection. Holding the port kills that structurally rather than detecting it after the fact.
>
> §1's stated reason for the original direction — *"Close it → spine lives"* — conflated who
> SERVES with whose lifetime dominates. A server with no clients is fine, and the editor's
> lifetime remains entirely its own.
>
> Code: `src/bridges/shell-port.mjs` (spine, now the WS server) and
> `src/shell/spine-link.mjs` (editor, now the WS client — renamed from `src/shell/server.mjs`,
> which every §-reference below to "the editor's server" should be read as).

**What:** the operator console is a *limb* — a transport adapter exactly like the
Beeper bridge. An external interactive **editor** serves a local port; the spine's
`shell-port` limb **connects out to it as a client**, precisely how the beeper limb
connects to Beeper Desktop. The node's single spine runs detached in Session 1 so
the **browser** limb can spawn Chrome natively — the shell reaches the spine over a
socket from anywhere, so it does not need S1 itself.

**Why now:** we have no wired way to create a `NamedRoom`; the console is where
`/room create` (and `/attach`, `/profile`, …) live. Rather than a bespoke shell, the
console is one more surface feeding the command interpreter the spine already runs.

**Decision (operator, 2026-07-19):** topology **(1) — one spine, detached in S1.**
The S0 Windows service demotes from *runs-the-loop* to *supervises-the-S1-loop*.
Chosen over a second S1 spine (two writers race `EGPT_HOME`) and an on-demand
shell-spine (no persistent node). Natural completion of this session's S1-reach
groundwork (auto-logon, the Interactive scheduled-task pattern, never-sleep).

---

## 0. Four concepts, kept separate (the alignment that drove this plan)

| Term | What it is | Lifecycle |
|---|---|---|
| **Spine** | the node process — the loop hosting the limbs, the interpreter, and fan-out. No UI of its own; runs detached. | **supervised** — the S0 supervisor respawns it if it wedges/exits. |
| **Shell** | an external interactive **editor** app (v1's themed TUI). Serves a port; on *send*, pushes the composed message to the spine. | **independent** — open/close it freely; the spine is unaffected. |
| **Terminal / console** | the OS text-I/O window the editor happens to draw in. Dumb plumbing. | incidental. |
| **respawn** | the supervisor relaunching **the spine**. | the spine's only — nothing to do with the shell. |

**Invariant — the spine is a CLIENT of its surface apps.** It dials OUT to each
surface's local port (Beeper Desktop `ws://127.0.0.1:23373`; the shell editor
`ws://127.0.0.1:23375`). Each surface is an independent app; its up/down never
touches the spine.

**Invariant — node symmetry.** Every node — REVE (`kg`), DOLLY (`do`), a friend's
box, another Beeper account — is the same independent peer running the same shape
(one detached S1 spine + beeper/shell/browser limbs). No per-node branching, ever.

---

## 1. The shape

```
   Session 0 (service)            Session 1 (auto-logon desktop)
 ┌──────────────────────┐   ┌──────────────────────────────────────────────┐
 │ egpt-daemon           │   │  node egpt.mjs  (THE SPINE, detached)         │
 │  SUPERVISOR:          │   │   boot() wires limbs (all CLIENTS dialing out)│
 │  • starts on boot     │──▶│    • beeper-port → ws 127.0.0.1:23373 (Beeper)│
 │  • fires S1 spine task│run│    • shell-port  → ws 127.0.0.1:23375 (editor)│
 │  • watches alive.txt  │◀──│    • browser      → native Chrome, this S1    │
 │  • respawns the SPINE │beat│   → ONE interpreter + fan-out                │
 └──────────────────────┘   └──────────────────────────────────────────────┘
        (no loop here)         SHELL editor is a SEPARATE app in S1; it SERVES
                               23375; the spine connects out. Close it → spine lives.
```

`daemon-singleton.liveDaemonPid` still guarantees exactly one `boot()` per
`EGPT_HOME`, so there is never a second writer. The supervisor is **not** a spine.

---

## 2. The shell is a message *surface* — and a limb carries no logic

Like Beeper, the shell limb only **transports**. A line the operator sends becomes
an inbound **message** it hands to the spine; the **spine** owns everything after —
the message hits the **interpreter** (commands) and is **fanned out to recipients**.

- A slash command → the interpreter handles it (`/room create`, `/chrome`, …).
- Plain content → fanned out to that surface's recipients (a room's members,
  including web-brain tabs). *(Plain-content fan-out rides the deferred message-router
  plan; Phase 1 targets the command round-trip, which needs no routing.)*

So the operator at the shell is a **participant**, symmetric with a WhatsApp sender —
not an admin at a special console. `shell-port` contains **zero** command logic and
**zero** fan-out; it is a dumb pipe, exactly like `beeper-port`.

**`shell` is already a first-class surface** — `KNOWN_SURFACES =
['whatsapp','telegram','shell','signal']` (`conversations-state.mjs:65`); we fill a
reserved seat.

---

## 3. `shell-port` mirrors `beeper.mjs` — a WebSocket client

`beeper.mjs:4`: the limb is a **client** of Beeper Desktop's WebSocket at
`127.0.0.1:23373`. `shell-port` is the same:

```js
// src/bridges/shell-port.mjs  (new)
export const SHELL_WS_PORT = 23375;                 // editor serves this; spine dials out
// createShellPort({ url = `ws://127.0.0.1:${SHELL_WS_PORT}`, WebSocket = ws, onMessage, send, onLog })
//  • connects out; reconnect/backoff when the editor is absent (idle, like beeper)
//  • inbound editor frame → an inbound event on the `shell` surface → spine pipeline
//  • spine outbound send → a frame pushed back over the same socket → editor displays
```

- **Injection seam** for the `WebSocket` constructor so tests drive a fake editor
  (a fake WS server) with no real socket.
- `boot.mjs` wires it beside `createBeeperBridgePort` (`:17`) into the *same*
  router/gating/transcript/sender/**commands**/ingest services — one dispatch, two
  surfaces. No TTY, no readline, no role flags.

---

## 4. Relocating the spine into S1 (detached)

Today `daemon-runtime` `spawn`s `node egpt.mjs` in-session (S0). Topology (1) changes
only *where*:

- **Generalize the `egpt-chrome` task** into `egpt-spine` (Interactive principal,
  `setup/register-spine-task.ps1`) that launches the spine **detached** in S1 — no
  window needed; the shell reaches it over `23375`.
- **Supervisor fires it** with `schtasks /run /tn egpt-spine` instead of an in-session
  `spawn`, and monitors `state/alive.txt` across the session boundary (existing 60 s
  beat). Missed beat / clean exit → re-fire (existing backoff `RESTART_MIN_MS 2s →
  MAX 60s`).
- **Lifecycle codes unchanged** — `/restart` (43), `/upgrade` (42), `/rewind` (44)
  re-fire the S1 task exactly as they re-spawn today.

---

## 5. What this REMOVES

- **The `/chrome` Session-hop.** With the spine in S1, Chrome spawns directly — no
  `egpt-chrome` task, no `launchChromeTask` seam, no `waitForChromeUp` fallback;
  `/chrome` collapses to launch-or-attach in-process. (The task + code shipped this
  session were the S0-era bridge; topology (1) retires them.)
- **The S0 in-session spine.** `daemon-runtime` stops running `boot()`'s child in S0.

---

## 6. Resilience (the S0-service reason, preserved)

- **Auto-logon** → an S1 desktop always exists after reboot, **locked** (lock-on-logon).
- **Supervisor is still an S0 service**, boot-started, that fires the S1 spine — "always
  comes back" is unchanged; only the loop's *session* moved.
- **Modern Standby** is defeated by the display setting already applied (never sleep +
  Blank *screensaver*, not display-off) — a locked-but-awake S1 desktop doesn't freeze
  background processes.

Net resilience is equal-or-better, and we stop maintaining per-feature S1 hops.

---

## 7. Phasing (each shippable + verifiable alone)

1. **`shell-port` limb (spine side).** The WS-client limb + `boot()` wiring + tests
   against a fake editor. → *verify: a fake editor pushes `/status` over the socket →
   `shell-port` emits a `shell`-surface event → the interpreter replies → the reply is
   pushed back over the socket.* (The editor **app** — recover v1's Ink shell or a new
   one — is a separate, parallel deliverable; this phase needs only a fake.)
2. **`/room create <name>`.** First missing handler, in the shared dispatch (calls
   `createRoom` + seeds `config/skeletons/room/`); reuse the `/e` wizard's arm/step
   machinery for the guided variant. → *verify: `rooms/<name>/` appears and the
   heartbeat/transcription loaders enumerate it.*
3. **Supervised S1 relocation.** `setup/register-spine-task.ps1`; `daemon-runtime` fires
   `egpt-spine` via `schtasks /run` + watches `alive.txt` across sessions. → *verify:
   reboot → auto-logon → supervisor fires S1 spine → alive.txt beats; `/restart` re-fires.*
4. **Drop the `/chrome` hop.** Remove `launchChromeTask`/`waitForChromeUp`; `/chrome`
   spawns in-process; delete `egpt-chrome` task. → *verify: cold node, `/chrome kg` opens
   Chrome with no scheduled task present.*

Order matters: 1–2 give the console + rooms **without** touching deployment; 3–4 do the
relocation once the console is proven.

---

## 8. Lean guarantees / non-goals

- **No forked dispatch** — `shell-port` feeds the spine a message; the interpreter and
  fan-out live in the spine, shared with every limb.
- **No TUI framework in the limb** — the editor is a separate app; the limb is a WS client.
- **No role flags** — a limb wires or sits idle based on whether its surface's port answers.
- **Message router deferred** — plain-content fan-out to room members is a *separate* plan.
- **Per-node symmetry** — no node-specific code; a peer with no editor simply has an idle
  `shell-port`.

---

## 9. Open questions

- **The editor app itself.** Recover v1's Ink shell (deleted `src/shell/ink-limb.mjs`, of
  distrusted health) or write a fresh minimal editor that serves `23375`? Out of scope for
  Phase 1 (fake editor suffices), but it's the next real deliverable after.
- **Which room does a shell message target?** A slash command is room-agnostic; a plain
  message needs a "current room" the shell is composing into — belongs to the message-router
  plan.
- **Reconnect cadence / discovery** — fixed port `23375` (like Beeper's `23373`); confirm we
  want a fixed port vs. a discovery file. (Plan assumes fixed.)

---

## 10. First cut (firing now)

Phase 1 only: `src/bridges/shell-port.mjs` (WS-client limb) + `boot.mjs` wiring +
`tests/shell-port.test.mjs`, reproduce-first, against a fake editor. Nothing deployed,
nothing in `~/.egpt`. When it round-trips a slash command over the socket, we scope
`/room create`.
