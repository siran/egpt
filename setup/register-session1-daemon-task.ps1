# register-session1-daemon-task.ps1 - register / inspect / remove the SCHEDULED TASK that
# starts the SESSION 1 DAEMON at logon and keeps it up.
#
#   .\setup\register-session1-daemon-task.ps1                 # register (idempotent)
#   .\setup\register-session1-daemon-task.ps1 -Status         # read-only: is it registered, and to what
#   .\setup\register-session1-daemon-task.ps1 -Remove         # remove exactly what was added
#   .\setup\register-session1-daemon-task.ps1 -DryRun         # print what would be registered, register nothing
#   .\setup\register-session1-daemon-task.ps1 -EgptHome "$env:USERPROFILE\.egpt-secondary"
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).
#
# =====================================================================================
# WHAT THIS IS FOR
# =====================================================================================
# This task is the node's ONE runner (operator 2026-10-17: the Session 0 service is retired).
# It starts egpt-daemon.mjs at logon in session 1, where the daemon can hold the browsers and
# the claude sessions as ordinary children, and Task Scheduler keeps it up - trigger At log on,
# action the daemon, settings restart on failure. setup\start-egpt.cmd / stop-egpt.cmd drive it.
#
# =====================================================================================
# WHY A TASK AND NOT THE HKCU RUN KEY
# =====================================================================================
# The HKCU Run entry that started a bare SPINE is retired (2026-10-17). Two things made the
# task the better seam:
#
#   - THE RUN KEY NEVER LOOKS BACK. It starts a process at logon and forgets it. If the
#     session 1 daemon dies mid-session, nothing brings it back until the next logon. A task
#     with "restart the task if it fails" does, which is the operator's stated reason for
#     accepting Task Scheduler here at all.
#   - A TASK CAN BE INSPECTED. Get-ScheduledTaskInfo reports LastRunTime, LastTaskResult and
#     NumberOfMissedRuns. A Run entry that silently did not fire leaves no trace anywhere.
#
# What is NOT better: a task is one more thing to keep in sync, and the schtasks family is
# exactly the seam this repo's integrity scan files under KNOWN_PLATFORM_DEBT. It stays in
# setup/, never in src/, and nothing in the runtime path calls it.
#
# =====================================================================================
# THE TWO SETTINGS THAT DECIDE WHETHER THIS WORKS AT ALL
# =====================================================================================
#   1. LogonType INTERACTIVE, never S4U/Password. A task registered to "run whether the user
#      is logged on or not" runs in SESSION 0, where the browser would land on a desktop
#      nobody can see. Interactive also means no password is stored anywhere.
#   2. ExecutionTimeLimit ZERO (unlimited). The default is 3 days, after which Task Scheduler
#      STOPS the task. A supervisor that is killed on a timer is not a supervisor - and the
#      failure would arrive three days into an uptime, which is the worst time to find it.
#
# And one that decides how it fails: RestartCount. Task Scheduler restarts a FAILED task
# (nonzero exit) up to N times, N below. When it gives up, the node is down until the next
# logon or setup\start-egpt.cmd.

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

# The task's one-line Description lives in ONE file, shared with migrations\0005 and 0043.
. (Join-Path $PSScriptRoot 'egpt-daemon-task-labels.ps1')

# --- resolve every input once, then print it; nothing below guesses twice ------------

if (-not $Repo) { $Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
if (-not $EgptHome) {
  if ($env:EGPT_HOME) { $EgptHome = $env:EGPT_HOME }
  else { $EgptHome = Join-Path $env:USERPROFILE '.egpt' }
}
# Derived from the profile folder: ~/.egpt -> egpt-daemon. One machine can carry several nodes;
# they must not collide on one task name. setup/start-egpt.ps1 and stop-egpt.ps1 derive it the same way.
$base = (Split-Path $EgptHome -Leaf) -replace '^\.', ''
if (-not $TaskName) {
  if (-not $base) { throw "cannot derive a task name: -EgptHome is empty or has no leaf ('$EgptHome'). Pass -TaskName explicitly." }
  $TaskName = "$base-daemon"
}
$Description = Get-EgptDaemonTaskDescription
# The name this task carried until migrations\0002 renamed it. A node that has not run 0002
# still has it, and registering the new name beside it would put TWO logon tasks on the node -
# two session 1 daemons at every logon. So registering refuses while it exists.
$LegacyTaskName = if ($base) { "$base-session1-daemon" } else { '' }
if (-not $LogPath) { $LogPath = Join-Path $EgptHome 'config\logs\session1-daemon.log' }
if (-not $Node) {
  $found = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($found) { $Node = $found.Source }
  else { $Node = 'C:\Program Files\nodejs\node.exe' }
}

# The shim comes from -Repo, NOT from $PSScriptRoot. Running this script out of an editable
# checkout to register a task against the DEPLOYED one is the ordinary case, and a task whose
# shim lives in the tree you edit is a footgun: the shim is what sets EGPT_SESSION1 and names egpt-daemon.mjs, so it must ship with the code
# it launches.
$Shim    = Join-Path (Join-Path $Repo 'setup') 'session1-daemon-launcher.vbs'
$Daemon  = Join-Path $Repo 'egpt-daemon.mjs'
$WScript = Join-Path $env:SystemRoot 'System32\wscript.exe'
# NOT "$env:USERDOMAIN\$env:USERNAME": USERDOMAIN is WORKGROUP on a workgroup machine and over
# ssh, and WORKGROUP\user maps to no SID (0x80070534, dolly 2026-09-12). WindowsIdentity is authoritative.
$User    = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$q = [char]34
$Arguments = "$q$Shim$q $q$Node$q $q$Repo$q $q$EgptHome$q $q$LogPath$q"

function Get-Task {
  try { return Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { return $null }
}

function Get-LegacyTask {
  if (-not $LegacyTaskName -or $LegacyTaskName -eq $TaskName) { return $null }
  try { return Get-ScheduledTask -TaskName $LegacyTaskName -ErrorAction Stop } catch { return $null }
}

function Show-Status {
  Write-Host "scheduled task : $TaskName"
  $t = Get-Task
  if (-not $t) {
    Write-Host "  registered   : no" -ForegroundColor Yellow
    Write-Host "  would run    : $WScript $Arguments"
    if (Get-LegacyTask) {
      Write-Host "  NOTE: this task is registered under its old name '$LegacyTaskName' - this node has not run migrations\0002. Run: node setup\migrate.mjs" -ForegroundColor Yellow
    }
    return
  }
  Write-Host "  registered   : YES" -ForegroundColor Green
  Write-Host "  state        : $($t.State)"
  foreach ($a in $t.Actions) { Write-Host "  action       : $($a.Execute) $($a.Arguments)" }
  foreach ($g in $t.Triggers) { Write-Host "  trigger      : $($g.CimClass.CimClassName)" }
  $p = $t.Principal
  Write-Host "  principal    : $($p.UserId)  LogonType=$($p.LogonType)  RunLevel=$($p.RunLevel)"
  if ("$($p.LogonType)" -ne 'Interactive') {
    Write-Warning "LogonType is $($p.LogonType), not Interactive. A non-interactive task runs in SESSION 0, where no browser it starts is visible."
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
    # -ErrorAction Stop for the same reason as the registration below: a non-terminating failure
    # here would fall through to the green "Removed" line and report a task that is still there.
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  }
  # The task is the ONLY thing this script ever creates. The shim is a tracked file in the
  # checkout and the log is the operator's record; neither is ours to delete.
  Write-Host "Left alone (never created by this script): the shim $Shim, and the log $LogPath."
  Write-Host "NOTE: removing this task does NOT stop a session 1 daemon that is running right now - setup\stop-egpt.cmd does."
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
if (Get-LegacyTask) {
  throw "'$LegacyTaskName' is registered - that is this same task under its old name, so '$TaskName' beside it would start TWO session 1 daemons at logon. Rename it losslessly instead: node setup\migrate.mjs (migrations\0002)"
}

# cmd's `>>` creates the FILE but not the DIRECTORY: a missing log dir kills the whole `&&`
# chain before node ever starts, silently, because the error goes to a hidden console.
$logDir = Split-Path -Parent $LogPath
if (-not (Test-Path -LiteralPath $logDir)) {
  if ($DryRun) { Write-Host "[dry run] would create log directory $logDir" }
  else { New-Item -ItemType Directory -Path $logDir -Force | Out-Null; Write-Host "created log directory $logDir" }
}

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
  Write-Host "[dry run]   describe  : $Description"
  return
}

# -ErrorAction Stop, explicitly: on dolly 2026-09-12 this failed with 0x80070534 as a
# NON-TERMINATING error, walked straight past the catch below, and the script printed
# "Registered scheduled task" in green for a task Get-ScheduledTask could not find.
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description $Description -Force -ErrorAction Stop | Out-Null
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
Write-Host "Takes effect at the NEXT LOGON. To start it now: setup\start-egpt.cmd"
Write-Host "  check   : .\setup\register-session1-daemon-task.ps1 -Status"
Write-Host "  log     : Get-Content `"$LogPath`" -Tail 40 -Wait"
Write-Host "  remove  : .\setup\register-session1-daemon-task.ps1 -Remove"
