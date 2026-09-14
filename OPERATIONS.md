# OPERATIONS — deploying eGPT, and getting a shell that can

Everything here was measured on 2026-09-14, on the two live nodes. Where a fact
came from a command, the command is written out so you can re-measure it rather
than trust this file.

This is the operator runbook. `MANUAL.md` is what the system does; this is how
you change what is running. `NODE-SHAPE.md` is what a node IS; `setup/SANDBOX.md`
is how a sandboxed being is confined.

---

## The two nodes

| node | hostname | LAN address | role |
|---|---|---|---|
| kg | `reve` | `192.168.1.114` (Wi-Fi) | primary |
| do | `Dolly` | `192.168.1.102` (Wi-Fi) | secondary |

A *node* is a machine. `primary` / `secondary` are roles inside one node, not
machines — there is no "kg2". Both hostnames resolve on the LAN, so `an@dolly`
and `an@reve` work without the addresses; the addresses are here for when name
resolution is the thing that broke.

reve also holds `172.25.64.1` and `172.19.160.1`. Those are Hyper-V/WSL virtual
switches, not the LAN — never deploy to them.

Services on each node (`Get-Service *egpt*`): `egpt-daemon` is the supervisor and
the one a deploy restarts. reve also runs `egpt-primary` and `egpt-secondary`;
dolly runs `egpt-primary`.

---

## Deploying

### The everyday deploy — `setup/upgrade.ps1`

```
powershell -ExecutionPolicy Bypass -File setup\upgrade.ps1 -Peer an@dolly
```

That is the whole thing, both nodes, from reve. It pushes nothing: commit and
push first, then run it.

What it does: drops `/upgrade` into `EGPT_HOME/state/ingest`. The spine sweeps
that directory every second, consumes the file and exits **42**; the daemon then
does git pull + build + respawn. `-Peer user@host` deploys this node, then runs
the same script over ssh on the other one.

It needs no elevation — it writes one file into your own profile — and it
VERIFIES, which is the part that is tedious by hand: prod SHA before and after,
and a heartbeat that actually advanced.

Lifecycle exit codes, for reading a log: **42** `/upgrade`, **43** `/restart`,
**44** `/rewind`, **45** `/standdown`.

### The supervisor deploy — `setup/deploy.ps1`

```
powershell -ExecutionPolicy Bypass -File setup\deploy.ps1
```

Use this ONLY when the change alters what the *supervisor spawns* — an entry
point rename, a `daemon-runtime` appPath. An `/upgrade` respawns the spine
through the already-running supervisor, so a new appPath never takes effect;
only a full service restart reloads it.

It fast-forwards prod to `origin/main` and restarts `egpt-daemon`. Service
control needs admin, so it self-elevates through UAC — one prompt, on the
machine's own desktop. **That makes it unusable over ssh unless the session is
already elevated** (see the hop below).

Since 2026-09-14 it refuses rather than restarting onto a half-applied tree: prod
HEAD must equal `origin/main` and no TRACKED file may differ. Untracked scratch
in prod is tolerated on purpose — reve carries some.

### If a deploy dies partway

It happened on 2026-09-14 and the shape is worth recognising. Symptoms: prod HEAD
unchanged, some files already holding new content (one truncated mid-write), a
stale `.git/index.lock`, and the service never restarted.

```
ssh -p 2222 an@dolly "rm -f ~/bin/egpt/.git/index.lock && git -C ~/bin/egpt reset --hard --quiet"
```

Check that no git is actually running first (`Get-Process git`) — the lock is
only safe to remove when nothing holds it. Then redeploy.

---

## Getting an admin shell — the ssh hop

Service control, `Restart-Service`, and `icacls` on system paths all need
administrator. An interactive desktop session on reve does NOT have it: UAC
filters the token, so `IsInRole(Administrator)` is **False** in a normal shell,
and a script that self-elevates pops a prompt someone has to click.

An ssh session does not go through that filtering. Measured:

| from | to | admin? |
|---|---|---|
| reve, local shell | — | **False** |
| reve | `ssh an@localhost` (22 or 2222) | auth refused |
| reve | `ssh an@dolly` (22 or 2222) | **True** |
| reve | `ssh an@dolly` then `ssh an@reve` | **True** |

So: **to get an elevated shell on reve, hop out to dolly and back.**

```
ssh -p 2222 an@dolly "ssh an@reve '<elevated command>'"
```

That is the gain-admin hop. It exists because reve will not let you ssh to its
own loopback, but dolly will ssh in to reve, and that inbound session carries the
full token. Use it for anything that would otherwise need a UAC click — including
`setup/deploy.ps1`.

Verify a session really is elevated before trusting it:

```
powershell -NoProfile -Command "(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
```

### Which ssh port

| port | what answers | notes |
|---|---|---|
| 22 | Windows OpenSSH | `scp` works; paths are Windows-shaped |
| 2222 | msys2 sshd | a real POSIX shell — `/c/Users/an/...`, grep, sed |

Port 2222 gives the POSIX tooling this repo's scripts assume. It has one sharp
edge: `scp -P 2222` FAILS (`dest open "/c/Users/an/..."`). Pipe instead:

```
ssh -p 2222 an@dolly "cat > /tmp/file" < localfile
```

Python on both nodes is **Windows** python, even inside the msys shell. It does
not understand `/c/Users/...` — pass `C:/Users/...` to any script sent over.

---

## Two traps that have each cost a live incident

**Never pipe a native exe through `2>&1` in PowerShell 5.1.** Every stderr line
becomes a `NativeCommandError` ErrorRecord, and under
`$ErrorActionPreference = 'Stop'` that is TERMINATING. git writes its progress
meter to stderr, so `git reset --hard 2>&1 | ...` aborted a live deploy
mid-checkout and logged it as `ERROR: Updating files: 25% (129/506)` — a progress
line reported as a fault. Use `--no-progress` / `--quiet` and check
`$LASTEXITCODE`. If you genuinely want the stderr, drop the preference around the
call the way the `upgrade.ps1` remote probe does; `tests/integrity.test.mjs`
enforces exactly that rule.

**A heartbeat beats every 60 seconds.** `~/.egpt/state/alive.txt` is written once
a minute, so sampling it twice in ten seconds looks exactly like a wedged spine.
Watch it across a full minute before concluding anything:

```
for i in 1 2 3; do date +%H:%M:%S; stat -c %y ~/.egpt/state/alive.txt; sleep 25; done
```

---

## Stopping a node

`touch ~/.egpt/STOP` stops it deliberately — boot checks that file first and
exits clean. `upgrade.ps1` REFUSES while it exists, rather than dropping an
`/upgrade` a spine will never read. `setup/stop-egpt.cmd` is the same thing with
a launcher. Remove the file and restart the service to bring it back.

---

## Where the live state is

| path | what |
|---|---|
| `~/src/egpt` | the checkout people edit |
| `~/bin/egpt` | PROD — what the daemon runs; deploys fast-forward this |
| `~/.egpt/config/config.yaml` | node config: agents, compaction, ports |
| `~/.egpt/config/agents.yaml` | globally-pinned agents' threads (wren/dren) |
| `~/.egpt/config/conversations.yaml` | per-chat threads, one block per being |
| `~/.egpt/state/alive.txt` | the heartbeat |
| `~/.egpt/state/ingest/` | the box `/upgrade` and friends are dropped into |
| `~/.egpt/config/logs/session1-daemon.log` | the spine log |
| `~/.egpt-jsonl/<threadId>/` | a SANDBOXED being's CLI store, one per thread |
| `~/.claude/projects/<slug>/` | an UNSANDBOXED being's CLI store |

Those last two are not interchangeable, and the difference has eaten live
conversations: a thread created before a being moved into the sandbox lives in
`~/.claude/projects` where the sandboxed store cannot see it, so the first turn
after the move fails to resume and the spine starts the being FRESH. Since
2026-09-14 that raises an operator alert instead of passing silently.

Ports in use: `shell.port` 23475 on both nodes, Beeper CDP 9223, the dolly
transcriptor 23390. Their tokens live in `config.yaml` and belong nowhere else —
never copy one into a doc, a commit, or a chat.
