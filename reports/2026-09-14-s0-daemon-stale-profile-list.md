# The S0 daemon is supervising a profile it is no longer configured for

**Reported:** operator, 2026-09-14 — noticed three `egpt-*` services on KG and asked
whether the shape was still right.
**Node:** kg (reve). dolly checked for the same drift and is clean.
**Diagnosed against the LIVE machine** (services, registry, process table, pid files,
listening ports), not from the code alone.
**Status:** root cause CONFIRMED. **Nothing changed** — the fix depends on an intent
only the operator can state. See *Decision required*.

## Summary

reve runs two spines. Only one of them is configured to exist.

The `egpt-daemon` service is configured with `EGPT_HOMES=C:/Users/an/.egpt` — a single
profile — and its own description says *"Profile C:/Users/an/.egpt. ONE spine, both
accounts."* But the daemon process it started has been alive since **2026-09-12
12:37:23**, and it is still supervising **two** profiles: `~/.egpt` and
`~/.egpt-secondary`.

`resolveProfiles()` (`src/daemon-runtime.mjs:97`) reads `EGPT_HOMES` **once, at process
start**. The variable was narrowed to one profile at some point after that daemon
launched, and nothing has restarted it since — so the running process still holds the
older, wider list.

**The consequence is a silent loss.** The second spine exists only because a long-lived
process has not been recycled. The next restart of `egpt-daemon` — or the next reboot of
reve — and `~/.egpt-secondary` does not come back: no error, no alert, just Rodz's spine
gone and port 23477 unheld. Nothing in the system is watching for it.

## What is NOT wrong

Check this first, so the fix does not land on the healthy half.

**The S0 → S1 standdown works.** The service keeps a spine alive pre-login; at logon the
`egpt-session1-daemon` scheduled task starts the S1 spine and the S0 one stands down
(`src/spine/successor-announce.mjs:70`, `:107`). The handshake is in the log on every S1
boot:

```
2026-09-14 19:03:24 [standdown] successor (EGPT_SESSION1=1): no-incumbent — ECONNREFUSED 127.0.0.1:23475
2026-09-14 19:03:25 [shell] shell: the Session 1 successor does NOT reap :23475 — whatever holds it is the incumbent, and it is draining, not stale
```

`no-incumbent` is the correct reading: the S0 spine for `~/.egpt` had already stood down
at login, so there was nothing to hand over from. The second line is unconditional
(`src/spine/boot.mjs:2440`) and only *looks* like it contradicts the first.

**`egpt-primary` and `egpt-secondary` are not spare spines.** They are nssm-wrapped
Beeper Desktop instances, one per account, each with its own `--user-data-dir` and CDP
port (9223 and 9225; 9222 is the Chrome profile). They are the ear and the mouth of the
one spine, and removing them would take an account offline.

## Evidence

Supervision map, reve, 2026-09-14 19:03:

| session | started by | pid | serves |
|---|---|---|---|
| S1 | task `egpt-session1-daemon` | daemon 6668 → spine **44080** | `~/.egpt` (An) — port 23475 |
| S0 | service `egpt-daemon` | daemon **9812** → spine **43364** | `~/.egpt-secondary` (Rodz) — port 23477 |
| S0 | service `egpt-primary` | 5168 | Beeper Desktop, CDP 9223 |
| S0 | service `egpt-secondary` | 5128 | Beeper Desktop, `rodz-beeper` userdata, CDP 9225 |

The disagreement, item by item:

```
registry  HKLM\SYSTEM\CurrentControlSet\Services\egpt-daemon\Parameters
          AppEnvironmentExtra = EGPT_HOME=C:/Users/an/.egpt ;; EGPT_HOMES=C:/Users/an/.egpt
          Description         = ... Profile C:/Users/an/.egpt. ONE spine, both accounts.

process   pid 9812  started 2026-09-12 12:37:23   (session 0, child of service pid 6628)

pid files ~/.egpt/state/daemon-s0.pid            = 9812   written 2026-09-12 12:37:24
          ~/.egpt-secondary/state/daemon-s0.pid  = 9812   written 2026-09-12 12:37:24
          ~/.egpt-secondary/state/spine.pid      = 43364  written 2026-09-14 19:03:43

ports     23475 -> 44080   (S1 spine, ~/.egpt)
          23477 -> 43364   (S0 spine, ~/.egpt-secondary)
```

The daemon registered itself as `daemon-s0` for **both** profiles one second after it
started — which is only possible if its environment listed both at that moment. And it is
still actively supervising the second one: spine 43364 was **respawned at 19:03:43**,
during an `upgrade.ps1 -EgptHome "$env:USERPROFILE\.egpt-secondary"` run minutes before
this report. So this is not a stale pid file describing a dead process; the supervision is
live.

### Re-measuring it

Run from an elevated shell (on reve: `ssh -p 2222 an@dolly "ssh an@reve '<cmd>'"` — an
interactive session there is UAC-filtered; see `OPERATIONS.md`).

```
# what the service is configured for
(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\egpt-daemon\Parameters').AppEnvironmentExtra

# how long the daemon has held its startup environment
(Get-Process -Id 9812).StartTime

# what it is actually supervising
Get-Content ~/.egpt/state/daemon-s0.pid, ~/.egpt-secondary/state/daemon-s0.pid
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 23475,23477 }
```

The report is confirmed if `EGPT_HOMES` names one profile while two profiles name the
same pid as their `daemon-s0`.

### dolly

Clean. No `~/.egpt-secondary` exists, and the service uses plain
`EGPT_HOME=C:\Users\an\.egpt` with no `EGPT_HOMES` at all. The drift is reve-only.

## Decision required

Both paths are one small change; they differ in intent, and picking wrong loses data.

1. **The target is one spine carrying both accounts** (what the service description
   already claims). Then `~/.egpt-secondary` is *already* scheduled for deletion by
   accident, and it should be retired deliberately instead — its threads and transcripts
   moved or written off on purpose, not at the next power cut.

2. **`~/.egpt-secondary` is still wanted.** Then `EGPT_HOMES` must list it again
   (`;`-separated; `resolveProfiles` accepts `;` or `,`) so the configuration matches the
   process, and the profile survives a restart.

## Related

Whichever is chosen, the failure mode is worth fixing on its own: a profile that stops
being supervised produces no alert. It is the same shape as the thread-loss fixed in
`44d4c0f` — a recovery path that reports nothing, so the first sign is a human noticing
something has gone quiet.
