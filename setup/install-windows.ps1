# setup/install-windows.ps1 — register egpt-daemon as a Task Scheduler task.
#
# The task runs `node egpt-daemon.mjs --headless` DIRECTLY (no PowerShell
# wrapper). Task Scheduler's RestartOnFailure setting handles outer-layer
# respawn (if the daemon process exits non-zero or crashes); egpt-daemon.mjs
# itself supervises the egpt.mjs child + runs the integrated heartbeat
# watchdog. Two layers, both proper (operator 2026-05-31).
#
# Replaces the prior 3-layer setup: daemon-wrap.ps1 → egpt-daemon.mjs →
# egpt.mjs plus a separate egpt-watchdog task. Both daemon-wrap.ps1 and the
# watchdog task are removed by this script.
#
# Install:
#   powershell -ExecutionPolicy Bypass -File .\setup\install-windows.ps1
#
# After install:
#   Get-ScheduledTask  -TaskName 'egpt-daemon'
#   Stop-ScheduledTask -TaskName 'egpt-daemon'
#   Start-ScheduledTask -TaskName 'egpt-daemon'
#   Get-Content "$env:USERPROFILE\.egpt\headless.log" -Tail 30 -Wait

$ErrorActionPreference = 'Stop'

# Tee everything to a log file so a quickly-closing window leaves a trace.
# Operator post-mortem path: C:\Users\<user>\.egpt\install-windows.log.
$LogPath = Join-Path $env:USERPROFILE '.egpt\install-windows.log'
try { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null } catch {}
try { Start-Transcript -Path $LogPath -Append -Force | Out-Null } catch { Write-Host "(Start-Transcript failed: $($_.Exception.Message); continuing without transcript)" -ForegroundColor Yellow }
Write-Output ("==== install-windows.ps1 run at {0} ====" -f (Get-Date))

# Admin check — the .cmd launcher (install-windows.cmd) handles UAC. If
# someone runs this .ps1 directly without admin, error out loudly instead
# of silently no-op'ing.
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Not admin. Run setup\install-windows.cmd (double-click) for the UAC prompt, or launch this script from an elevated PowerShell."
  try { Stop-Transcript | Out-Null } catch {}
  exit 1
}

try {

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
Write-Output ("script: {0}" -f $MyInvocation.MyCommand.Path)
Write-Output ("repo:   {0}" -f $RepoRoot)
# Avoid PS7-only `?.` — Windows PS 5.1 (default) parses-errors on it.
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
$NodeBin = if ($NodeCmd) { $NodeCmd.Source } else { $null }
if (-not $NodeBin) { throw "node.exe not found in PATH" }
Write-Output ("node:   {0}" -f $NodeBin)
$DaemonJs  = Join-Path $RepoRoot 'egpt-daemon.mjs'
if (-not (Test-Path $DaemonJs)) { throw "egpt-daemon.mjs not found at $DaemonJs" }
Write-Output ("daemon: {0}" -f $DaemonJs)

$TaskName = 'egpt-daemon'
$OldNames = @('egpt-daemon-headless', 'egpt-watchdog')

# Remove legacy tasks. We're replacing the wrapper-PS1 + separate watchdog
# pattern with a single task that runs node directly.
foreach ($n in $OldNames) {
  try {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue | Out-Null
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      Write-Output "removed legacy task: $n"
    }
  } catch { Write-Output "could not remove $n : $($_.Exception.Message)" }
}

# Kill any orphan node.exe processes running egpt-daemon.mjs / egpt.mjs.
# These can outlive a manually-deleted task or a crashed wrapper; without
# admin we can't kill session-0/S4U leftovers, but admin + taskkill /F works
# (Task Scheduler service is the owner; SYSTEM-level taskkill traverses it).
$orphans = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match 'egpt-daemon\.mjs' -or $_.CommandLine -match 'egpt\.mjs') }
if ($orphans) {
  Write-Output "killing existing egpt node processes:"
  foreach ($p in $orphans) {
    Write-Output ("  pid {0}: {1}" -f $p.ProcessId, ($p.CommandLine.Substring(0, [Math]::Min(80, $p.CommandLine.Length))))
    & taskkill.exe /F /PID $p.ProcessId /T 2>&1 | Out-Null
  }
  Start-Sleep -Seconds 2
}
# Also wipe a stale alive.txt so the new daemon doesn't see itself as
# already-alive and refuse via the singleton guard.
$alivePath = Join-Path $env:USERPROFILE '.egpt\state\alive.txt'
if (Test-Path $alivePath) { Remove-Item $alivePath -Force -ErrorAction SilentlyContinue; Write-Output "removed stale alive.txt" }

# Action: node egpt-daemon.mjs --headless
$Action = New-ScheduledTaskAction `
  -Execute $NodeBin `
  -Argument "`"$DaemonJs`" --headless" `
  -WorkingDirectory $RepoRoot

# Triggers: start on logon AND on boot (covers laptop sleep/wake + login)
$TrigLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$TrigBoot  = New-ScheduledTaskTrigger -AtStartup

# Settings: restart on failure, run hidden, don't stop if running long,
# allow start on battery, wake to run.
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

# Run as the current user, interactive (so it can access the user's home dir
# + node + the WA auth in ~/.egpt). HighestAvailable so it inherits the
# user's privileges (no elevation prompt — the task itself isn't elevated).
$Principal = New-ScheduledTaskPrincipal `
  -UserId  "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Highest

$Task = New-ScheduledTask `
  -Action    $Action `
  -Trigger   @($TrigLogon, $TrigBoot) `
  -Settings  $Settings `
  -Principal $Principal `
  -Description "egpt — personal WA/TG bridge daemon (egpt-daemon.mjs supervisor)"

Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null
Write-Output "registered scheduled task: $TaskName"

Start-ScheduledTask -TaskName $TaskName
Write-Output "started"
Write-Output ""
Write-Output "status:"
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
Write-Output ""
Write-Output ("logs:  Get-Content '{0}\.egpt\headless.log' -Tail 30 -Wait" -f $env:USERPROFILE)
Write-Output ("stop:  Stop-ScheduledTask  -TaskName '{0}'" -f $TaskName)
Write-Output ("start: Start-ScheduledTask -TaskName '{0}'" -f $TaskName)
Write-Output ""
Write-Output ("install log: {0}" -f $LogPath)
Write-Output "OK"

} catch {
  Write-Host ""
  Write-Host ("!! INSTALL FAILED: {0}" -f $_.Exception.Message) -ForegroundColor Red
  Write-Host ("   at: {0}" -f $_.InvocationInfo.PositionMessage) -ForegroundColor Red
  Write-Host ""
  Write-Host ("see full log: {0}" -f $LogPath) -ForegroundColor Yellow
} finally {
  try { Stop-Transcript | Out-Null } catch {}
}
