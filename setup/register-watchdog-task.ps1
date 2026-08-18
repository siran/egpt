# register-watchdog-task.ps1 -- register egpt-daemon-watchdog: a REPEATING TIME TRIGGER
# task (every 2 minutes, forever) that runs watchdog-daemon.ps1, which restarts
# egpt-daemon-session1 whenever its heartbeat goes stale.
#
# WHY A SEPARATE TASK ON A TIME TRIGGER, not RestartCount/RestartInterval on the daemon
# task itself: confirmed live, twice, that RestartCount/RestartInterval does not reliably
# fire for an AtLogOn-triggered task (a disposable repro task never restarted, even minutes
# past its RestartInterval) -- a known Windows limitation, not a config mistake. A repeating
# time trigger was confirmed reliable in the same live test (fired 3 times, cleanly, ~60s
# apart). This task is the fix.
#
# Idempotent: re-run to update (Register-ScheduledTask -Force).
#
#   powershell -ExecutionPolicy Bypass -File .\setup\register-watchdog-task.ps1

param(
  [string]$Repo             = (Join-Path $env:USERPROFILE 'bin\egpt'),
  [string]$EgptHome         = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string]$TaskName         = 'egpt-daemon-watchdog',
  [int]$IntervalMinutes     = 2
)

$ErrorActionPreference = 'Stop'

$watchdogScript = Join-Path $Repo 'setup\watchdog-daemon.ps1'
if (-not (Test-Path $watchdogScript)) { throw "watchdog script not found: $watchdogScript" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$watchdogScript`" -EgptHome `"$EgptHome`"" `
  -WorkingDirectory $Repo
$userId = "$env:COMPUTERNAME\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
# ExecutionTimeLimit short on purpose (this run is a quick check, seconds at most) --
# unlike the daemon task, a wedged WATCHDOG run should be killed and let the next
# repetition try again, not linger.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName':" -ForegroundColor Green
Write-Host "  runs as   : $userId  (LogonType Interactive)"
Write-Host "  script    : $watchdogScript"
Write-Host "  every     : $IntervalMinutes minutes, forever, starting now"
Write-Host ""

$task = Get-ScheduledTask -TaskName $TaskName
Write-Host "state: $($task.State)"
