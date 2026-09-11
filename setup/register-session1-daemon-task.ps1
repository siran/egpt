# register-session1-daemon-task.ps1 - register / inspect / remove the SCHEDULED TASK that
# starts the SESSION 1 DAEMON at logon and keeps it up.
#
#   .\setup\register-session1-daemon-task.ps1                 # register (idempotent)
#   .\setup\register-session1-daemon-task.ps1 -Status         # read-only: is it registered, and to what
#   .\setup\register-session1-daemon-task.ps1 -Remove         # remove exactly what was added
#   .\setup\register-session1-daemon-task.ps1 -DryRun         # print what would be registered, register nothing
#   .\setup\register-session1-daemon-task.ps1 -EgptHome "$env:USERPROFILE\.egpt2"
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).
#
# =====================================================================================
# WHAT THIS IS FOR
# =====================================================================================
# After a restart this node runs in session 0 under NSSM. At logon the SESSION 1 spine takes
# the primary profile and the session 0 primary spine stands down (STANDDOWN_EXIT_CODE = 45);
# the SECONDARY profile never moves and stays in session 0 throughout. A session 1 spine can
# spawn and supervise a browser as an ordinary child process, which is the whole reason the
# handover exists.
#
# The session 1 spine needs a supervisor of its own, and "an s1 can only be monitored by an
# s1" (operator 2026-09-11): the session 0 daemon is a service, it cannot put a process on the
# interactive desktop. So a second daemon runs in session 1, and Task Scheduler keeps IT up -
# trigger At log on, action the daemon, settings restart on failure.
#
# =====================================================================================
# WHY A TASK AND NOT THE HKCU RUN KEY
# =====================================================================================
# setup/register-session1-autostart.ps1 registers a Run entry that starts a bare SPINE. It
# still works and is kept as the no-supervisor fallback. Two things make the task the better
# seam once there is a daemon to launch:
#
#   - THE RUN KEY NEVER LOOKS BACK. It starts a process at logon and forgets it. If the
#     session 1 daemon dies mid-session, nothing brings it back until the next logon. A task
#     with "restart the task if it fails" does, which is the operator's stated reason for
#     accepting Task Scheduler here at all.
#   - A TASK CAN BE INSPECTED. Get-ScheduledTaskInfo reports LastRunTime, LastTaskResult and
#     NumberOfMissedRuns. A Run entry that silently did not fire leaves no trace anywhere -
#     the failure mode the shim's header already warns about.
#
# What is NOT better: a task is one more thing to keep in sync, and the schtasks family is
# exactly the seam this repo's integrity scan files under KNOWN_PLATFORM_DEBT. It stays in
# setup/, never in src/, and nothing in the runtime path calls it.
#
# =====================================================================================
# THE TWO SETTINGS THAT DECIDE WHETHER THIS WORKS AT ALL
# =====================================================================================
#   1. LogonType INTERACTIVE, never S4U/Password. A task registered to "run whether the user
#      is logged on or not" runs in SESSION 0 - which is where the daemon already is, so the
#      handover would never happen and the browser would land on a desktop nobody can see.
#      Interactive also means no password is stored anywhere.
#   2. ExecutionTimeLimit ZERO (unlimited). The default is 3 days, after which Task Scheduler
#      STOPS the task. A supervisor that is killed on a timer is not a supervisor - and the
#      failure would arrive three days into an uptime, which is the worst time to find it.
#
# And one that decides how it fails: RestartCount. Task Scheduler restarts a FAILED task
# (nonzero exit) up to N times, N below. When it gives up, the node is not down: the session 1
# spine dies with its daemon, port 23375 goes quiet, and the session 0 daemon - which has been
# watching that port since it stood down - brings the session 0 spine back. What is lost is
# the browser until the next logon. That is the safety net, and it is worth knowing it is
# there rather than assuming the restart count is the last line of defence.

param(
  [string] $Repo      = '',
  [string] $EgptHome  = '',
  [string] $Node      = '',
  [string] $TaskName  = '',
  [string] $LogPath   = '',
  [int]    $RestartCount    = 99,
  [int]    $RestartMinutes  = 1,
  [switch] $Remove,
  [switch] $Status,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

# --- resolve every input once, then print it; nothing below guesses twice ------------

if (-not $Repo) { $Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
if (-not $EgptHome) {
  if ($env:EGPT_HOME) { $EgptHome = $env:EGPT_HOME }
  else { $EgptHome = Join-Path $env:USERPROFILE '.egpt' }
}
# Derived from the profile folder exactly like install-nssm-service.ps1 derives its service
# name: ~/.egpt -> egpt-session1-daemon. One machine can carry several nodes; they must not
# collide on one task name.
if (-not $TaskName) {
  $base = (Split-Path $EgptHome -Leaf) -replace '^\.', ''
  if (-not $base) { throw "cannot derive a task name: -EgptHome is empty or has no leaf ('$EgptHome'). Pass -TaskName explicitly." }
  $TaskName = "$base-session1-daemon"
}
if (-not $LogPath) { $LogPath = Join-Path $EgptHome 'config\logs\session1-daemon.log' }
if (-not $Node) {
  $found = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($found) { $Node = $found.Source }
  else { $Node = 'C:\Program Files\nodejs\node.exe' }   # the same fallback install-nssm-service.ps1 hardcodes
}

# The shim comes from -Repo, NOT from $PSScriptRoot. Running this script out of an editable
# checkout to register a task against the DEPLOYED one is the ordinary case, and a task whose
# shim lives in the tree you edit is the same footgun install-nssm-service.ps1 now refuses:
# the shim is what sets EGPT_SESSION1 and names egpt-daemon.mjs, so it must ship with the code
# it launches.
$Shim    = Join-Path (Join-Path $Repo 'setup') 'session1-daemon-launcher.vbs'
$Daemon  = Join-Path $Repo 'egpt-daemon.mjs'
$WScript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$User    = "$env:USERDOMAIN\$env:USERNAME"

$q = [char]34
$Arguments = "$q$Shim$q $q$Node$q $q$Repo$q $q$EgptHome$q $q$LogPath$q"

function Get-Task {
  try { return Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { return $null }
}

function Show-Status {
  Write-Host "scheduled task : $TaskName"
  $t = Get-Task
  if (-not $t) {
    Write-Host "  registered   : no" -ForegroundColor Yellow
    Write-Host "  would run    : $WScript $Arguments"
    return
  }
  Write-Host "  registered   : YES" -ForegroundColor Green
  Write-Host "  state        : $($t.State)"
  foreach ($a in $t.Actions) { Write-Host "  action       : $($a.Execute) $($a.Arguments)" }
  foreach ($g in $t.Triggers) { Write-Host "  trigger      : $($g.CimClass.CimClassName)" }
  $p = $t.Principal
  Write-Host "  principal    : $($p.UserId)  LogonType=$($p.LogonType)  RunLevel=$($p.RunLevel)"
  if ("$($p.LogonType)" -ne 'Interactive') {
    Write-Warning "LogonType is $($p.LogonType), not Interactive. A non-interactive task runs in SESSION 0, where the daemon already is - there would be no handover and no visible browser."
  }
  $s = $t.Settings
  Write-Host "  time limit   : $($s.ExecutionTimeLimit)   (PT0S / empty = unlimited, which is what a supervisor needs)"
  Write-Host "  restart      : count=$($s.RestartCount) interval=$($s.RestartInterval)"
  Write-Host "  multiple     : $($s.MultipleInstances)"
  try {
    $i = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
    Write-Host "  last run     : $($i.LastRunTime)  result=$($i.LastTaskResult)  missed=$($i.NumberOfMissedRuns)"
  } catch { }
  $expected = "$WScript $Arguments"
  $actual   = ($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | '
  if ($actual -ne $expected) {
    Write-Host "  NOTE: the registered action differs from what this script would write now:" -ForegroundColor Yellow
    Write-Host "        would be : $expected"
    Write-Host "        re-run without -Status to bring it up to date."
  }
}

function Test-Alignment {
  # The session 1 daemon and the session 0 service must agree on BOTH the profile and the
  # code, because they share the profile and hand it back and forth. A mismatch is not a
  # degraded handover, it is two independent nodes - so this reads the service's own NSSM
  # registration (readable unelevated) and says so.
  $svcBase = (Split-Path $EgptHome -Leaf) -replace '^\.', ''
  if (-not $svcBase) { return }
  $svcName = "$svcBase-daemon"
  $params  = "HKLM:\SYSTEM\CurrentControlSet\Services\$svcName\Parameters"
  $sp = $null
  try { $sp = Get-ItemProperty -Path $params -ErrorAction Stop } catch { }
  if (-not $sp) {
    Write-Host "note: no readable NSSM registration for service '$svcName' - skipping the session 0 cross-check."
    return
  }
  $svcHome  = $null
  $svcHomes = $null
  foreach ($e in @($sp.AppEnvironmentExtra)) {
    if ($e -like 'EGPT_HOME=*')  { $svcHome  = $e.Substring('EGPT_HOME='.Length) }
    if ($e -like 'EGPT_HOMES=*') { $svcHomes = $e.Substring('EGPT_HOMES='.Length) }
  }
  # Compare with separators normalised: the service is registered with EGPT_HOME=C:/Users/...
  # (forward slashes) and this script builds C:\Users\... - the same directory, and warning
  # that they differ would be a false alarm on the ONE thing this check exists to catch.
  $norm = { param($p) ($p -replace '/', '\').TrimEnd('\').ToLowerInvariant() }
  $carried = @()
  if ($svcHomes) { $carried = @($svcHomes.Split(';') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
  elseif ($svcHome) { $carried = @($svcHome) }
  $mine = & $norm $EgptHome
  $hit  = @($carried | Where-Object { (& $norm $_) -eq $mine })
  if ($carried.Count -and -not $hit.Count) {
    Write-Warning "profile mismatch: service '$svcName' supervises $($carried -join ', '), this task would serve $EgptHome. Different profiles means there is NO handover - the task would start a second, independent node."
  }
  if ($sp.AppDirectory -and (& $norm $sp.AppDirectory) -ne (& $norm $Repo)) {
    Write-Warning "checkout mismatch: service '$svcName' runs from $($sp.AppDirectory), this task would run from $Repo. Both daemons share one profile, so they must agree on the stand-down token format and the config schema. Pass -Repo '$($sp.AppDirectory)' unless you are deliberately testing a second checkout."
  }
}

# --- -Status: read only. No preflight, no writes, safe to run any time ---------------
if ($Status) { Show-Status; return }

# --- -Remove: take away exactly what was added, and nothing else ---------------------
if ($Remove) {
  $t = Get-Task
  if (-not $t) {
    Write-Host "'$TaskName' is not registered - nothing to remove."
  } elseif ($DryRun) {
    Write-Host "[dry run] would Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
  } else {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  }
  # The task is the ONLY thing this script ever creates. The shim is a tracked file in the
  # checkout and the log is the operator's record of past handovers; neither is ours to delete.
  Write-Host "Left alone (never created by this script): the shim $Shim, and the log $LogPath."
  Write-Host "NOTE: removing this task does NOT stop a session 1 daemon that is running right now."
  Write-Host "      Log off, or kill it - the session 0 daemon takes the profile back when 23375 goes quiet."
  return
}

# --- register (the default), idempotent ----------------------------------------------

Write-Host "task     : $TaskName"
Write-Host "repo     : $Repo"
Write-Host "profile  : $EgptHome   (EGPT_HOME)"
Write-Host "node     : $Node"
Write-Host "shim     : $Shim"
Write-Host "log      : $LogPath"
Write-Host "user     : $User   (LogonType Interactive - session 1, no stored password)"
Write-Host ""

# Preflight. Every one of these failures would otherwise surface as "the logon did nothing",
# hours later, with no message anywhere - the shim runs windowless, so there is no console for
# an error to land in.
if (-not (Test-Path -LiteralPath $WScript)) {
  throw "wscript.exe not found at $WScript. WSH is a Feature-on-Demand on recent Windows 11 builds; without it this mechanism cannot run hidden. See the shim's header."
}
if (-not (Test-Path -LiteralPath $Shim))   { throw "launcher shim not found: $Shim - the checkout at $Repo does not carry setup\session1-daemon-launcher.vbs. Deploy it there (setup\deploy.ps1) before registering a task that points at it." }
if (-not (Test-Path -LiteralPath $Node))   { throw "node.exe not found: $Node (pass -Node <path>)" }
if (-not (Test-Path -LiteralPath $Daemon)) { throw "egpt-daemon.mjs not found: $Daemon (pass -Repo <checkout>)" }

# cmd's `>>` creates the FILE but not the DIRECTORY: a missing log dir kills the whole `&&`
# chain before node ever starts, silently, because the error goes to a hidden console.
$logDir = Split-Path -Parent $LogPath
if (-not (Test-Path -LiteralPath $logDir)) {
  if ($DryRun) { Write-Host "[dry run] would create log directory $logDir" }
  else { New-Item -ItemType Directory -Path $logDir -Force | Out-Null; Write-Host "created log directory $logDir" }
}

Test-Alignment

$action    = New-ScheduledTaskAction -Execute $WScript -Argument $Arguments -WorkingDirectory $Repo
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $User
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount $RestartCount `
  -RestartInterval (New-TimeSpan -Minutes $RestartMinutes) `
  -MultipleInstances IgnoreNew
# StartWhenAvailable is deliberately NOT set: it makes Task Scheduler run a MISSED trigger
# late, and "late" for a logon trigger means starting a session 1 daemon at a moment nobody
# chose. The trigger is the logon; if the logon did not happen, nothing should start.

$existing = Get-Task
if ($DryRun) {
  if ($existing) { Write-Host "[dry run] would REPLACE the existing task '$TaskName'" }
  else { Write-Host "[dry run] would CREATE the task '$TaskName'" }
  Write-Host "[dry run]   execute   : $WScript"
  Write-Host "[dry run]   arguments : $Arguments"
  Write-Host "[dry run]   workdir   : $Repo"
  Write-Host "[dry run]   trigger   : AtLogOn ($User)"
  Write-Host "[dry run]   principal : $User Interactive/Limited"
  Write-Host "[dry run]   settings  : ExecutionTimeLimit=0 (unlimited), RestartCount=$RestartCount every ${RestartMinutes}m, MultipleInstances=IgnoreNew"
  return
}

try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
} catch {
  Write-Host "Register-ScheduledTask failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Registering a task for yourself usually needs no elevation. If this is an access" -ForegroundColor Yellow
  Write-Host "denial, re-run from an ADMIN PowerShell:" -ForegroundColor Yellow
  Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -EgptHome `"$EgptHome`" -Repo `"$Repo`""
  exit 1
}

if ($existing) { Write-Host "Updated scheduled task '$TaskName'." -ForegroundColor Green }
else { Write-Host "Registered scheduled task '$TaskName'." -ForegroundColor Green }

Write-Host ""
Write-Host "Takes effect at the NEXT LOGON. Nothing starts now, and nothing should:"
Write-Host "  the session 0 spine is holding $EgptHome right now, and two spines on one profile"
Write-Host "  is the failure this whole design exists to avoid."
Write-Host "  check   : .\setup\register-session1-daemon-task.ps1 -Status"
Write-Host "  log     : Get-Content `"$LogPath`" -Tail 40 -Wait"
Write-Host "  remove  : .\setup\register-session1-daemon-task.ps1 -Remove"
