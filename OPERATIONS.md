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

`Get-Service *egpt*` lists **one spine service and two Beeper Desktops**. The name
says which is which:

| service | what it is | stopping it |
|---|---|---|
| `egpt-daemon` | the spine supervisor — `node egpt-daemon.mjs` → `egpt-spine.mjs` | this node goes silent |
| `egpt-beeper-primary` | Beeper Desktop, primary account (the ear), CDP 9223 | that account goes offline |
| `egpt-beeper-secondary` | Beeper Desktop, secondary account (the mouth), CDP 9225 | the agents cannot reply |

A Beeper Desktop is **not** a spine — it is one nssm-wrapped Electron app per
connection, with its own `--user-data-dir` and CDP port (reve 9223 + 9225, 9222 =
Chrome profile; dolly 9223). reve's second spine comes from the
`egpt-session1-daemon` scheduled task, not a service.

**Renaming, once per node.** The two Beeper services were hand-created and still
carry the old names `egpt-primary`/`egpt-secondary` on a node that has not been
migrated. There is no rename verb in `sc.exe`, so it is delete-and-recreate and the
Desktop is **down in between** — do the idle one first:

```
powershell -File setup\rename-beeper-s0-service.ps1 -From egpt-primary   -To egpt-beeper-primary   -WhatIf
powershell -File setup\rename-beeper-s0-service.ps1 -From egpt-secondary -To egpt-beeper-secondary
```

`setup\s0-identity-reconcile.ps1` finds these by **start mode**, not by name, so it
keeps working across the rename either way.

## Deploying

```
powershell -ExecutionPolicy Bypass -File setup\upgrade.ps1 -Peer an@dolly
powershell -ExecutionPolicy Bypass -File setup\upgrade.ps1 -EgptHome "$env:USERPROFILE\.egpt-secondary"
```

**Both lines, or you deployed two spines out of three.** `-Peer` does this machine
main profile then the other machine over ssh; it does NOT touch the secondary
role. A spine keeps running the code it loaded even after prod changes under it —
only a respawn picks it up.

**Commit and push first**: it pulls `origin/main`, so unpushed work silently does
not ship. It drops `/upgrade` into `EGPT_HOME/state/ingest`; the spine sweeps that
every second, exits **42**, and the daemon pulls, builds, respawns — then verifies
prod SHA and a heartbeat that advanced. Exit codes: **42** `/upgrade`, **43**
`/restart`, **44** `/rewind`, **45** `/standdown`.

`setup/deploy.ps1` is only for changes to what the **supervisor spawns** (entry
point rename, `daemon-runtime` appPath), since an `/upgrade` respawns through the
already-running supervisor. It restarts the service, needs admin, self-elevates
through UAC — unusable over ssh unless already elevated. Since 2026-09-14 it
refuses a half-applied tree: prod HEAD must equal `origin/main`, no tracked file
may differ.

**A deploy that died partway** leaves prod HEAD unchanged, some files already new
(one truncated), a stale lock, service never restarted. Confirm nothing holds the
lock (`Get-Process git`), then reset:

```
ssh -p 2222 an@dolly "rm -f ~/bin/egpt/.git/index.lock && git -C ~/bin/egpt reset --hard --quiet"
```

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
profile. `setup/stop-egpt.cmd` is the same with a launcher.

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
