# Session Zero — 2026-09-02 / 2026-09-03

Read `git log` for the changes. This is the shape, the traps, and the open work.

---

## Where we are

**Both nodes run egpt entirely in Windows Session 0. reve was proven cold, with nobody
logged in, and `AutoAdminLogon = 0` on both.**

```
reve (kg)   SESSION 0   spine (egpt-daemon) 23375 · Beeper(an) 23373 · CDP 9223
            session 1   Beeper(an) 23374          <- the operator's GUI, 2nd device, same account
dolly (do)  SESSION 0   spine 23375/23390/23391 · Beeper(Rodz) 23373 · CDP 9223
                        whisper 8089 · llama 8080
                        icecast · liquidsoap · caddy · jellyfin
```

`@e @c @p @l` answer in the operator's own groups whether or not he is logged in. That was
the requirement, stated in his words: *"in the groups where i am in, with my friends, E C P
L must reply … E must answer whether an is logged in on windows or not."*

### THE IDEA, and why it looked impossible

Session 0 isolation (Vista) removed the ability to SEE a service's windows. It never
removed the ability to RUN there. Session 0 still has a window station, a desktop, a
working window manager and a virtual display (measured: 1024x768). What everyone reads as
"GUI apps can't work in a service" is a statement about visibility.

Two facts make it usable:
- **CDP renders from the compositor**, so `Page.captureScreenshot` works on a window nothing
  can display. `PrintWindow` returns TRUE and a BLANK PNG — that nearly produced the wrong
  conclusion that Session 0 cannot paint. It paints.
- **Loopback is machine-wide, not session-scoped.** A Session 0 Beeper's API on
  `127.0.0.1:23373` is readable from Session 1 and from the spine. This was already written
  in `commands.mjs:878` and we rediscovered it the hard way.

### The account topology, and the correction that mattered

```
reve S0 = an     <- the operator's own account. His groups live here, so THIS is what must
                    be up unattended. Built backwards at first (it was Rodz) and corrected.
dolly S0 = Rodz  <- `don` answers as Rodz.
```

**No account switching.** An account holds MULTIPLE DEVICES, so an's Beeper runs as the
Session 0 service AND as the operator's Session 1 GUI, both synced, the spine pinned to the
S0 one by port. Beeper cannot swap accounts without a logout/login and a fresh device
verification, so any "switch at logon" design is fragile and unnecessary.

**Ports are decided by BOOT ORDER, and it inverts.** Services start during boot, logon
happens after — so the S0 Beeper takes the DEFAULT 23373 and the S1 GUI is pushed to 23374.
Before a reboot the mapping is the opposite. Establish it with a cheap reboot BEFORE writing
config; guessing costs a silent misconnection.

---

## What shipped

| commit | what |
|---|---|
| `9abe717` | a beeper connection carries `base_url`/`ws_url` and `owner_node`, not just a token; the bridge map is keyed by the **(base_url, token) pair** |
| `b376194` | the spine ADOPTS a whisper-server it finds already running instead of reaping it |
| `06f4430` | the console port is `shell.port`, not a constant — two spines can share a machine |
| `cdcf800` + `d66ebd6` | `fallback_handle.unless_peer_alive`: a being's handle assumed only while the peer spine is absent |
| `f5c6cb6` | one spine listening on EVERY connection it holds (inbound fanout) |
| `fa3e348` | a sleep is not a wedge — the watchdog stopped killing a healthy spine on every resume |

Suite 3351 → 3410, 166 files.

### The load-bearing ones

**`base_url` is why kg does not answer as Rodz.** After reve's reboot, Rodz's service Beeper
takes 23373 and an's is pushed to 23374. `main` is an's account. Riding the default, kg
would silently talk to RODZ's Beeper — no error, just the wrong identity answering as the
operator. Keying the bridge map by token ALONE collapsed two Desktops into one bridge
pointed at whichever was built first.

**`owner_node` exists because the presence test stops working.** `unless_present` asks
whether an account is IN the chat, which separated the nodes only while ONE of them held
that account. With the same account live in Session 0 on both, it is true for both and both
answer. A connection names its owner; every other node SENDS on it and never WAKES on it.

**Observation, not negotiation** — the operator's principle, applied three times: whisper
adoption, peer liveness, and the fallback gate are all *look at the port, believe what
answers*. Two processes cannot both decide to answer without talking or being told in
advance — but "is my peer alive?" is a LOCAL question. No election, no split brain.
Asymmetric hysteresis is the safety: **yield eagerly, claim reluctantly**, because believing
the peer dead when it is alive costs a DOUBLE ANSWER while the reverse costs silence.

**NOTHING DEDUPLICATES, deliberately** (operator's ruling, and he was right). Two accounts
in one real group do not see the same message twice: Beeper is Matrix, each account has its
own room, so one real chat is a DIFFERENT chatId per connection — a different conversation,
not a duplicate. Which one ANSWERS is decided by addressing. A content hash would have been
a patch over a question the architecture already answers.

---

## Traps, all paid for once

- **`app.getPath('downloads')` throws for SYSTEM** and the rejection is unhandled at Electron's
  module top level, so Beeper's startup aborts while leaving a window and three processes
  standing. It looks like a hang at ZERO CPU, not a crash. SYSTEM's profile is a stub; create
  Downloads/Documents/Desktop/Pictures/Music/Videos. A real service account has them already.
- **`--disable-software-rasterizer` must NOT be combined with `--disable-gpu`** — together they
  remove the last render path. Harmless in a toy probe, fatal for a real app.
- **Chromium throttles what it thinks is background**, and nothing in Session 0 is ever
  foregrounded. `--disable-background-timer-throttling --disable-renderer-backgrounding
  --disable-backgrounding-occluded-windows` are not optional for a live sync socket.
- **Run the app AS the scheduled task, not as its child.** Task Scheduler kills the wrapper
  mid-cleanup and orphans children (12 stray SYSTEM Beeper processes, twice).
- **`element.click()` is IGNORED by React.** Every failed click was this. `Input.dispatchMouseEvent`
  (trusted, browser-level) works first try. A custom switch also only reads `switch on` after a
  re-render — verify on a LATER tick, never the same one.
- **Beeper opens Settings and each dialog as its OWN window**, i.e. its own CDP target,
  invisible to the others. Three targets for one flow.
- **Beeper's local API is gated** behind Settings → Integrations → *Allow connections* plus an
  APPROVED CONNECTION. A fresh install has none, so NO token works — the 401 is not a stale
  token. `Allow connections` is an ACCOUNT-level setting and syncs; the TOKEN belongs to an
  INSTALL, so the S1 GUI's token 401s against the S0 one. Expiry defaults to **30 days**, not
  Never — useless for a service.
- **Device verification expires.** Restarting the S0 Beeper re-issues the request; that is the
  reliable move. Read the emoji from EACH target independently.
- **An unparseable `config.yaml` reads as an EMPTY config, not an error** — the spine boots with
  ZERO agents. A connection's NAME sits at indent 2, its FIELDS at 4. Every config writer here
  now parse-checks and auto-reverts. This bit once.
- **PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI** — an em-dash in a comment is a
  parse error. ASCII only in `.ps1`.
- **MSYS mangles ssh arguments**: `/r` becomes a path, backslashes vanish. Use PowerShell
  cmdlets or forward slashes; write a script to a file and invoke it with `-File`.
- **Mixed line endings**: `boot.mjs`/`shell-port.mjs` are CRLF, `router.mjs`/`daemon-runtime.mjs`
  are LF. Patch with Node and assert no stray LF/CRLF after every write.
- **A literal NUL byte makes ripgrep treat a source file as binary** and silently truncate every
  later audit. `tests/integrity.test.mjs` catches it.

---

## Two capabilities worth keeping

**Self-elevation on reve, no UAC, no human click.** `ssh reve -> dolly -> reve`. reve does not
authorize its own key for itself, but dolly's IS authorized here, and ssh hands out an
UNFILTERED admin token because `LocalAccountTokenFilterPolicy=1`. (That policy — not
auto-logon — is what gives ssh admin. UAC is still on interactively.)

**`src/tools/s0-driver/`** — a screen for Session 0. `Page.startScreencast` + trusted
`Input.*`, served locally (`s0-driver.cmd`). It must be SERVED, not opened as `file://`:
`/json/list` sends no CORS headers. Its proxy REWRITES the ws port, because a remote CDP
advertises its own `:9223` and a target listed through a tunnel would otherwise drive the
WRONG COMPUTER, silently. Drives Electron windows, not the whole desktop — a real
Session 0 X-server is still unbuilt and wanted.

---

## Open work

1. **A real Session 0 X-server.** The driver covers Electron; arbitrary Windows apps need a
   capture service inside Session 0 plus input injection.
2. **Strict `resolveChatId`** (from the previous handoff, still open): names match exactly and
   first-match wins on ambiguity, while two chats share the name `egpt-mesh-do-kg`.
3. **`chatgpt`/codex fails with "Sending failed"** on both nodes. Pre-existing, undiagnosed.
4. **`don` emits a `/reply` action** that routes to a chat rather than back to the console;
   the console then logs "stripped malformed action".
5. **wren feels absent because it is ONE mind.** Pinned to `agent/wren`: one queue, one live
   turn, and `allow_new_input: same_sender` weaves follow-ups INTO the running turn, so a
   follow-up never gets its own reply. Head-of-line blocking is inherent to the design and its
   own config says so. `allow_new_input: none` would trade absorption for queueing.
6. **Opus 5 refuses some threads** with `[reasoning_extraction]`, reproducible OUTSIDE egpt via
   `claude --resume`. Sonnet answers the same thread. Fixed once by clearing the thread pointer
   (the transcript survives, so it is not amnesia) — expect it again.
7. **`an-on-errands.md`** was pushed to the PUBLIC `siran/egpt` and removed from HEAD, but the
   blob remains in history at `b376194`. Purging needs a rewrite + force-push. Operator's call.
8. **The whisper/llama services run as LocalSystem**, which is why SYSTEM's stub profile needed
   patching. A dedicated service account (the operator's own `provision-sandbox-account.ps1`)
   is the cleaner follow-up.

## Facts about the machines

- **dolly is Windows 11 HOME**: no Windows Sandbox (`Containers-DisposableClientVM`), no
  Hyper-V — but `VirtualMachinePlatform`, `HypervisorPlatform` and WSL2 ARE enabled. "Home has
  no virtualization" is wrong.
- **The spine service runs as `.\an`, NOT LocalSystem.** A service is in Session 0 whatever
  account it uses, and only `an` can read `C:\Users\an\.claude`. A LocalSystem spine kills
  every ccode turn before the model runs — invisibly.
- **whisper binds `127.0.0.1` only**; reve reaches it through egpt's remote-worker path.
- **`egpt-wake-duty`** wakes reve on an RTC timer, now every 30 min, AC only. Its log is the
  cheapest proof the node is alive.
- **Transcription language is `auto`, not absent** — whisper.cpp's `-l` default is `en`, so
  deleting the key pins English instead of Spanish. Three config sites plus the service's own
  arguments.
