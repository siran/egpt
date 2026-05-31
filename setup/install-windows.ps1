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

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$NodeBin   = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $NodeBin) { throw "node.exe not found in PATH" }
$DaemonJs  = Join-Path $RepoRoot 'egpt-daemon.mjs'
if (-not (Test-Path $DaemonJs)) { throw "egpt-daemon.mjs not found at $DaemonJs" }

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
Write-Output "logs:  Get-Content `"$env:USERPROFILE\.egpt\headless.log`" -Tail 30 -Wait"
Write-Output "stop:  Stop-ScheduledTask  -TaskName '$TaskName'"
Write-Output "start: Start-ScheduledTask -TaskName '$TaskName'"
