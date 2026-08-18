# register-daemon-task.ps1 — register a Session-1 scheduled task that runs the WHOLE egpt
# daemon (egpt-daemon.mjs), replacing the Session-0 NSSM service (`egpt-daemon`).
#
# WHY: the NSSM service put the spine in Session 0 — any Bash/tool call a being made
# (launching Chrome, etc.) inherited that isolated, invisible desktop, so every GUI-needing
# action needed its own on-demand bridge task (egpt-chrome, the exact pattern this file
# mirrors). Operator ruling (2026-08-17): move the WHOLE daemon into Session 1 instead — every
# tool call runs on the real, visible desktop, no bridging needed. This machine already runs
# Windows auto-logon (AutoAdminLogon, verified in HKLM\SOFTWARE\Microsoft\Windows NT\
# CurrentVersion\Winlogon) to bring up Beeper Desktop after a reboot with nobody physically
# present, so an AtLogOn trigger survives a reboot exactly the same way.
#
# CRASH RECOVERY, now split two ways:
#   - Spine wedges/crashes (heartbeat stale, uncaught exit) -> already handled INSIDE
#     egpt-daemon.mjs itself (src/daemon-runtime.mjs's own respawn-with-backoff loop,
#     git-pull-on-/upgrade, etc.) -- completely independent of NSSM/Task Scheduler, so this
#     migration changes NOTHING about that layer.
#   - The daemon process ITSELF dies outright (killed, OOM, whatever) -- this is the ONE thing
#     NSSM's own service-restart used to cover, and Task Scheduler's RestartCount/RestartInterval
#     settings below now cover it instead.
#
# GOTCHAS (same as register-chrome-task.ps1 — read that file's header too):
#   - `schtasks /create /it /sc onlogon` emits INVALID task XML — DO NOT author with schtasks
#     /create. Use the PowerShell ScheduledTasks cmdlets (below).
#   - The principal user MUST be fully qualified `<COMPUTER>\<user>` — a bare `<user>` is
#     rejected as malformed XML.
#   - ExecutionTimeLimit defaults to a 3-DAY KILL (PT72H, the lock-on-logon task's own default,
#     fine for a task that runs for a second) — MUST be zeroed out here, or Task Scheduler
#     silently kills the daemon after 3 days.
#
# Idempotent: re-run to update (Register-ScheduledTask -Force). Does NOT touch the old NSSM
# service — stop/disable that yourself (see setup/cutover-to-session1.ps1) once this task is
# confirmed working.
#
# Run from THIS repo checkout, as the operator (the account the task will run as).
#   powershell -ExecutionPolicy Bypass -File .\setup\register-daemon-task.ps1

param(
  [string]$Repo      = (Join-Path $env:USERPROFILE 'bin\egpt'),
  [string]$EgptHome  = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string]$TaskName  = 'egpt-daemon-session1',
  [int]$RestartCount = 999,
  [int]$RestartIntervalMinutes = 1
)

$ErrorActionPreference = 'Stop'

$daemonScript = Join-Path $Repo 'egpt-daemon.mjs'
if (-not (Test-Path $daemonScript)) { throw "daemon script not found: $daemonScript" }

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeExe = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $nodeExe)) { throw "node.exe not found: $nodeExe" }

# EGPT_HOME: deliberately NOT set explicitly. src/egpt-home.mjs defaults to
# `os.homedir()/.egpt` when the env var is absent, which already resolves to the same
# C:\Users\<user>\.egpt the NSSM service explicitly pointed at (verified via the registry,
# HKLM\SYSTEM\CurrentControlSet\Services\egpt-daemon\Parameters, 2026-08-17). A Scheduled
# Task action has no clean per-task environment-variable slot the way NSSM's
# AppEnvironmentExtra did; the default already matches, so nothing to inject.

# HIDDEN, but Task Scheduler must still track the daemon's actual lifetime (operator
# 2026-08-17, live: "why not run that tab headless" -- the console window only ever needed
# to exist for Chrome, never for the daemon itself). Launching node.exe DIRECTLY as the
# task's own action always shows its console under Interactive logon -- no cmdlet flag
# suppresses that for the task's own action process. Fix: run a real SCRIPT FILE
# (run-daemon-hidden.ps1, next to this one) -- three straight rounds of nested-quote
# collisions in a -Command one-liner (outer wrapper vs inner path literals, then vs an
# inner 'Continue' literal) proved that shape too fragile; a -File action needs zero
# command-line escaping. See that script's own header for why it blocks and why
# $ErrorActionPreference='Continue' is required there.
#
# `powershell.exe -WindowStyle Hidden` ALONE still isn't enough (operator 2026-08-17, live:
# "i still see flashing ... it switches focus and disappears") -- Windows allocates the
# console window as part of process creation, before powershell.exe's own code runs to
# apply -WindowStyle, so it can flash/steal focus for an instant regardless. wscript.exe
# (run-hidden.vbs, next to this one) is a GUI-subsystem host, not console-subsystem -- it
# never allocates a console window at all, so there is nothing to flash. See that script's
# own header for the Run(cmd, 0, True) mechanics.
$wrapperScript = Join-Path $PSScriptRoot 'run-daemon-hidden.ps1'
if (-not (Test-Path $wrapperScript)) { throw "wrapper script not found: $wrapperScript" }
$vbsWrapper = Join-Path $PSScriptRoot 'run-hidden.vbs'
if (-not (Test-Path $vbsWrapper)) { throw "vbs wrapper not found: $vbsWrapper" }
$q = [char]34
$qEsc = '\' + $q   # a literal backslash+quote pair -- how an embedded " survives INSIDE
                    # an already-quoted Win32 command-line argument (standard
                    # CommandLineToArgvW escaping, not a PowerShell escape sequence)
$innerCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $qEsc$wrapperScript$qEsc -Repo $qEsc$Repo$qEsc -EgptHome $qEsc$EgptHome$qEsc"
$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument "//B //NoLogo $q$vbsWrapper$q $q$innerCmd$q" `
  -WorkingDirectory $Repo
# fully-qualified <COMPUTER>\<user> — a bare user is rejected as malformed XML
$userId = "$env:COMPUTERNAME\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
# ExecutionTimeLimit = PT0S: no 3-day kill, this must run forever.
# MultipleInstances IgnoreNew: a manual Start-ScheduledTask while it's already running is a
# safe no-op, never a second daemon fighting the first over the same ports/state.
# RestartCount/RestartInterval: Task Scheduler's own answer to "the daemon process died
# outright" — the ONE thing the old NSSM service covered that egpt-daemon.mjs's own internal
# respawn loop (src/daemon-runtime.mjs) does not, since that loop can't restart itself once
# its own process is gone.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount $RestartCount -RestartInterval (New-TimeSpan -Minutes $RestartIntervalMinutes)

Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName':" -ForegroundColor Green
Write-Host "  runs as   : $userId  (LogonType Interactive -> Session 1 desktop)"
Write-Host "  execute   : $nodeExe `"$daemonScript`""
Write-Host "  cwd       : $Repo"
Write-Host "  trigger   : AtLogOn ($userId)"
Write-Host "  restart   : up to $RestartCount times, every $RestartIntervalMinutes min, if the process dies outright"
Write-Host ""

# --- status readback: what WINDOWS actually has now, read back fresh -- not the variables above ---
Write-Host "Current status (read back from Windows):" -ForegroundColor Green
$task = Get-ScheduledTask -TaskName $TaskName
Write-Host "  state     : $($task.State)"
Write-Host "  runs as   : $($task.Principal.UserId)  (LogonType $($task.Principal.LogonType))"

$info = Get-ScheduledTaskInfo -TaskName $TaskName
if ($info.LastRunTime -and $info.LastRunTime.Year -ge 2000) {
  Write-Host "  last run  : $($info.LastRunTime)  (result $($info.LastTaskResult))"
} else {
  Write-Host "  last run  : never run"
}

Write-Host ""
Write-Host "NOT started yet, and the old NSSM service is untouched. To cut over:" -ForegroundColor Yellow
Write-Host "  1. Stop-Service egpt-daemon; nssm set egpt-daemon Start SERVICE_DISABLED"
Write-Host "  2. Start-ScheduledTask -TaskName $TaskName"
Write-Host "  3. verify the new process is alive, in Session 1, and the heartbeat is fresh"
