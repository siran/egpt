# OPERATIONS — deploying eGPT, and getting a shell that can

Measured 2026-09-14. `MANUAL.md` is what the system does; this is how you change
what runs.

## What is actually running

Two machines, **three spines**. A node is a machine; `primary`/`secondary` are
ROLES inside one node — separate profile dirs, each with its own daemon, spine,
heartbeat and shell port. No "kg2": both reve profiles declare `node_name: kg`.

| machine | profile | `node_name` | role | shell port |
|---|---|---|---|---|
| `reve` `192.168.1.114` | `~/.egpt` | `kg` | primary | 23475 |
| `reve` | `~/.egpt-secondary` | `kg` | secondary | 23477 |
| `Dolly` `192.168.1.102` | `~/.egpt` | `do` | primary | 23475 |

reve's `172.25.64.1` / `172.19.160.1` are Hyper-V/WSL switches — never deploy there.

**Each node has ONE runner: the Session 1 scheduled task `egpt-daemon`** (`node
egpt-daemon.mjs` → `egpt-spine.mjs`, started at logon by
`setup/register-session1-daemon-task.ps1`). Stopping it, this node goes silent. The
Session 0 NSSM service of the same name is **retired** (2026-10-17: stopped and
Disabled on both nodes; remove it with `setup\uninstall-nssm-service.cmd`, name
`egpt-daemon`). `/standdown` and the S0↔S1 handover are gone with it.
`node setup\verify-install.mjs` checks both.

**After a reboot nothing runs until the operator logs on** — the task's only trigger is
logon. `egpt-wake-duty` (also an interactive task, so also only while logged on) wakes a
sleeping machine every 30 min and, if the daemon died, revives it through
`setup\start-egpt.ps1` — never past a `STOP` file. It cannot start a node nobody is
logged on to.

`Get-Service *egpt*` lists **two Beeper Desktops** (and the disabled service):

| service | what it is | stopping it |
|---|---|---|
| `egpt-beeper-primary` | Beeper Desktop, primary account (the ear) | that account goes offline |
| `egpt-beeper-secondary` | Beeper Desktop, secondary account (the mouth) | the agents cannot reply |

A Beeper Desktop is **not** a spine — it is one nssm-wrapped Electron app per
connection, with its own `--user-data-dir` and **no CDP port** (closed 2026-10-11:
loopback CDP has no auth, so any boxed being could drive it).

**Renaming, once per node.** The two Beeper services were hand-created and still
carry the old names `egpt-primary`/`egpt-secondary` on a node that has not been
migrated. Migration `0001` does it (see *Migrations* below); by hand, there is no
rename verb in `sc.exe`, so it is delete-and-recreate and the Desktop is **down in
between** — do the idle one first:

```
powershell -File setup\rename-beeper-s0-service.ps1 -From egpt-primary   -To egpt-beeper-primary   -WhatIf
powershell -File setup\rename-beeper-s0-service.ps1 -From egpt-secondary -To egpt-beeper-secondary
```

**One profile for the operator's own account (optional, reve).**
`setup\share-beeper-primary-profile.cmd` (once, elevated, `-DryRun` / `-Revert`) points
`egpt-beeper-primary` at the operator's own Beeper window profile, after a full backup beside it:
one device, one token, no `primary_gui`. Then the window runs that profile while Beeper is open
and the service runs it otherwise, never both:

- `setup\beeper-window.cmd` (the logon Run value and the "Beeper (eGPT)" shortcut) claims the
  profile, stops the service, opens Beeper once the service's Beeper has let go, and starts the
  service again when Beeper exits (tray Quit; a hidden window still counts as open). Open Beeper
  through it, not through Beeper's own shortcut.
- The service's NSSM Start/Pre hook (`setup\s0-identity-reconcile.ps1 -PreStart`) refuses to start
  it while Session 1 claims or runs the profile; the `egpt-s0-identity` task (SYSTEM, boot + every
  2 min) starts it after a logoff. Nothing ever kills Beeper.
- While the profile changes hands the spine's bridges hold (`/beeper-hold on|off` in the ingest
  box, capped at 3 min), the same state `/update beeper` uses.

**Beeper services as the desktop user (optional, any node).** `setup\beeper-services-run-as-user.cmd`
(elevated, `-DryRun` / `-Revert`, `-ServiceName`) logs services on as you instead of LocalSystem:
password asked in a dialog and checked first (never stored), `SeServiceLogonRight` granted (and
removed on `-Revert` only if it added it), the profile backed up beside itself, then per service
hold → stop → switch → start → wait for its token → release; one that does not answer goes back to
LocalSystem. It refuses a service with no `--user-data-dir` (the primary until the one-profile
conversion). If a later password change stops a service logging on (error 1069), the spine says
so in log_to_group after 5 min on no port — through a connection that still works.

## Deploying

```
powershell -ExecutionPolicy Bypass -File setup\upgrade.ps1 -Peer an@dolly
powershell -ExecutionPolicy Bypass -File setup\upgrade.ps1 -EgptHome "$env:USERPROFILE\.egpt-secondary"
```

**Both lines, or you deployed two spines out of three.** `-Peer` does this machine
main profile then the other machine over ssh; it does NOT touch the secondary
role. A spine keeps running the code it loaded even after prod changes under it —
only a respawn picks it up.

**Measured 2026-09-25: `~/.egpt-secondary` is not running.** It carries a `STOP` file
and its heartbeat last beat 2026-09-15, so while that holds the `-Peer` line alone
deploys every live spine (and `upgrade.ps1` would refuse the second line anyway).
Check `<profile>/STOP` and `alive.txt` before believing the three-spine table above.

**Commit and push first**: it pulls `origin/main`, so unpushed work silently does
not ship. It drops `/upgrade` into `EGPT_HOME/state/ingest`; the spine sweeps that
every second, exits **42**, and the daemon pulls, builds, respawns — then verifies
prod SHA and a heartbeat that advanced. Exit codes: **42** `/upgrade`, **43**
`/restart`, **44** `/rewind`.

**Typed in a chat, a command names a being (since 2026-10-19):** `/<handle> <command>` —
`/e upgrade` runs on kg (E's node), `/d upgrade` on do; every other node records the line and
does nothing. A bare `/upgrade` in a chat is ordinary text. The ingest box above and the editor
shell (the node's own console) still take the bare line.

**A deploy waits for turns in progress (since 2026-09-28).** `/upgrade` and `/restart`
no longer exit on the spot: the spine keeps answering and exits the moment no turn is
running, or after **30 minutes** regardless (logged loudly). While it waits it writes
`state/draining.json`, and `upgrade.ps1` prints who it is waiting for every ~30 s
instead of counting down. `/rewind`, `STOP` and the daemon's wedge-restart stay immediate.

A change to the **supervisor itself** (`daemon-runtime`, entry point, appPath) needs
a daemon restart, since an `/upgrade` respawns through the already-running
supervisor: after the `/upgrade` lands, `setup\stop-egpt.cmd` then
`setup\start-egpt.cmd` in the node's logged-on session — that pair IS the restart; there
is no separate restart script. `setup/deploy.ps1` does it in one go: fast-forwards prod,
then runs the same stop and start (no elevation; not from a being's shell — the stop kills
the daemon's tree; a node with a `STOP` file is left stopped).

### The Session 1 daemon holds the browsers

Since 2026-10-11 (`feat/daemon-holds-chrome`) the **Session 1 daemon** — the `egpt-daemon`
scheduled task, not the service — launches and holds every browser group's Chrome and its CDP
pipe (`src/chrome-host.mjs`). `/upgrade`, `/restart` and a config restart respawn only the
spine; the new spine re-attaches to the Chromes the daemon still holds. A spine with no such
daemon (run by hand) has **no browser**: `/chrome` answers "no daemon chrome-host".

`/upgrade` never reloads daemon code: a daemon imports its modules once, at start. Chrome exits
the moment the process holding its pipe exits (measured 2026-10-11), so a daemon restart
restarts every group Chrome; `--restore-last-session` reopens their tabs.

**Restarting the Session 1 daemon** (needed once after an `/upgrade` that changes daemon code):
in the node's logged-on session, as the operator (no elevation; the task is the operator's),
`setup\stop-egpt.cmd` then `setup\start-egpt.cmd`. Stop writes `STOP`, stops the task and
`taskkill /T /F`s the daemon tree (`Stop-ScheduledTask` alone does not); start removes `STOP` and
starts the task. A daemon refuses to start while a live spine still holds the profile
(`state/spine.pid` + a fresh `alive.txt`) and says which pid. A turn in progress is cut.
Done when `<profile>/config/logs/session1-daemon.log` shows a fresh
`egpt-daemon up` with no `no chrome-host` line after it, and `/<handle> chrome` logs
`launched "brain" Chrome … held by the daemon`. At start the new daemon kills any
`--remote-debugging-pipe` Chrome left on a profile under `<profile>/chrome/profiles` (an orphan
of the old spine); nothing else.

### The Session 1 daemon holds the claude sessions

Since 2026-10-16 (`feat/cli-host`) the same daemon also spawns and holds every being's `claude`
(a boxed being's launcher too, so its lease stays) and its stdio (`src/cli-host.mjs`). `/upgrade`,
`/restart`, a config restart, a spine crash or a wedge-restart leave each session and its
background agents running; the new spine adopts them (`[cli-host] adopted <key> pid …` in its
log). What they emit meanwhile is buffered (4 MB per session, partial deltas shed first) and
replayed: a finished task wakes the being as usual. So the restart drain waits for turns in flight,
no longer for background work. A config change reaches a live session as a control request (model,
effort, verbose_thinking); anything else reopens it by resume, never while its background work runs.

Still ended, resumed by thread id on the next turn: a daemon restart or reboot (the daemon's
children die with it, measured) and `/rewind`. A spine with no daemon (run by hand) spawns its
own, and its restarts still wait for background work.

A daemon restart (section above) ends today's sessions, their background agents and the Chromes
once: pick a moment with no background work (a chat that has some shows the being's status
message).

**A deploy that died partway** leaves prod HEAD unchanged, some files already new
(one truncated), a stale lock, daemon never restarted. Confirm nothing holds the
lock (`Get-Process git`), then reset:

```
ssh -p 2222 an@dolly "rm -f ~/bin/egpt/.git/index.lock && git -C ~/bin/egpt reset --hard --quiet"
```

### Migrations

A structural change to a node — a service or task name, a config shape — ships as
`migrations/NNNN-<slug>.mjs` and is never hand-applied. After a deploy lands,
`upgrade.ps1` runs `setup/migrate.mjs` from prod against the profile it deployed.
What a node has applied lives in `<profile>/state/migrations-applied.json`, not in
git. Each migration first checks whether the node is already there, and records
"already satisfied" without acting. If any migration is **APPLIED**, `upgrade.ps1`
restarts the spine once more (same drain, same wait): the spine reads `config.yaml`
only at boot, so it would otherwise run without the change until the next restart.

```
node setup\migrate.mjs --dry-run      # what each pending migration would change; changes nothing
node setup\migrate.mjs                # apply what is pending (setup\migrate.cmd to double-click)
```

A failure stops the chain and is not recorded. A migration that needs elevation, run
unelevated, prints **PENDING** with the exact command and does not block the rest —
so on reve's UAC-filtered shell an elevated migration stays pending until run from
an admin shell.
**`-Peer an@dolly` runs dolly's migrations over ssh, which is elevated** (below):
elevated ones apply there during the deploy, Beeper downtime included.

## The admin ssh hop

An interactive session on reve is UAC-filtered — `IsInRole(Administrator)` is
**False** and self-elevating scripts need a click. ssh sessions are not filtered:

| from | to | admin? |
|---|---|---|
| reve, local shell | — | **False** |
| reve | `ssh an@localhost` (22 or 2222) | auth refused |
| reve | `ssh an@dolly` (22 or 2222) | **True** |
| reve | `ssh an@dolly` → `ssh an@reve` | **True** |

reve will not ssh to its own loopback, but dolly will ssh in and that inbound
session carries the full token. **For admin on reve, hop out and back:**

```
ssh -p 2222 an@dolly "ssh an@reve '<elevated command>'"
```

Nested quoting through two shells mangles `$_` (msys path translation) — write a
`.ps1` and run it by path. Verify a session really is elevated:

```
powershell -NoProfile -Command "(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
```

**Port 22** = Windows OpenSSH (`scp` works). **Port 2222** = msys2 sshd, the POSIX
shell this repo assumes — but `scp -P 2222` FAILS; pipe instead:
`ssh -p 2222 an@dolly "cat > /tmp/f" < local`. Python on both machines is
**Windows** python even inside msys: pass `C:/Users/...`, never `/c/Users/...`.

## Two traps, each of which cost a live incident

**Never pipe a native exe through `2>&1` in PowerShell 5.1.** Every stderr line
becomes a `NativeCommandError`; under `$ErrorActionPreference = 'Stop'` that is
terminating. The git progress meter goes to stderr, so `git reset --hard 2>&1`
aborted a deploy mid-checkout and logged it as `ERROR: Updating files: 25%` — a
progress line reported as a fault. Use `--no-progress`/`--quiet`, check
`$LASTEXITCODE`. If you truly want the stderr, drop the preference around the call
as the `upgrade.ps1` remote probe does; `tests/integrity.test.mjs` enforces it.

**A heartbeat beats once every 60s.** Sampling twice in ten seconds looks exactly
like a wedged spine — watch a full minute, per profile:

```
for i in 1 2 3; do date +%H:%M:%S; stat -c %y ~/.egpt/state/alive.txt ~/.egpt-secondary/state/alive.txt; sleep 25; done
```

## Stopping, and where the live state is

`touch <profile>/STOP` — boot checks it first and exits clean, and `upgrade.ps1`
REFUSES while it exists rather than dropping an `/upgrade` nothing will read. Per
profile. `setup/stop-egpt.cmd` writes it, stops the `egpt-daemon` task and kills the
daemon tree; `setup/start-egpt.cmd` removes it and starts the task.

| path | what |
|---|---|
| `~/src/egpt` | the checkout people edit |
| `~/bin/egpt` | PROD — what every spine runs; shared by both profiles |
| `<profile>/config/config.yaml` | `node_name`, connections, agents, compaction, ports |
| `<profile>/config/agents.yaml` | globally-pinned agents threads (wren/dren) |
| `<profile>/config/conversations.yaml` | per-chat threads, one block per being |
| `<profile>/state/alive.txt` | the heartbeat |
| `<profile>/state/ingest/` | where `/upgrade` and friends are dropped |
| `<profile>/config/logs/session1-daemon.log` | the spine log |
| `~/.egpt-jsonl/<threadId>/` | a SANDBOXED being CLI store, one per thread |
| `~/.claude/projects/<slug>/` | an UNSANDBOXED being CLI store |

The last two are not interchangeable, and the gap has eaten live conversations: a
thread created before a being entered the sandbox lives in `~/.claude/projects`,
invisible to the sandboxed store, so the first turn after the move fails to resume
and the spine starts the being FRESH. Since 2026-09-14 that raises an operator
alert instead of passing silently.

Every token — shell, transcription, Beeper — lives in `config.yaml` and nowhere
else. Never copy one into a doc, a commit, or a chat.
