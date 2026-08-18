# watchdog-daemon.ps1 -- restart egpt-daemon-session1 if it's not actually alive.
#
# WHY THIS EXISTS (operator, 2026-08-17): Task Scheduler's own RestartCount/RestartInterval
# (registered on egpt-daemon-session1 itself) does NOT reliably fire -- confirmed live,
# twice, with a controlled repro (a disposable always-fails test task, same settings,
# LastRunTime never advanced past its first run even minutes later). This is a known,
# widely-reported Windows limitation for this trigger shape, not something more flag-tweaking
# fixes. A SEPARATE task on a plain REPEATING TIME TRIGGER is the standard, reliable
# alternative -- confirmed live too (a disposable test task fired cleanly every ~60s, three
# times in a row, no drift).
#
# CHECK: heartbeat freshness (state\alive.txt's mtime), not "is the task's State == Running"
# -- a wedged-but-technically-alive process is exactly the failure mode daemon-runtime.mjs's
# OWN internal loop already exists to catch for the SPINE child; this watchdog is the outer
# layer, for when the DAEMON ITSELF (not just its spine child) is gone. If the heartbeat is
# older than StaleSeconds, (re)start the task -- Start-ScheduledTask is a safe no-op if it's
# already running (MultipleInstances IgnoreNew on that task's own settings).
#
# Registered by register-watchdog-task.ps1 on a repeating trigger (every 2 min, no end).

param(
  [string]$EgptHome     = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string]$DaemonTask   = 'egpt-daemon-session1',
  [int]$StaleSeconds    = 90
)

$ErrorActionPreference = 'Continue'

$alive = Join-Path $EgptHome 'state\alive.txt'
$logFile = Join-Path $EgptHome 'config\logs\watchdog.log'
New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null

function Log($msg) {
  $line = "[watchdog $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffZ')] $msg"
  Add-Content -Path $logFile -Value $line
}

$stale = $true
if (Test-Path $alive) {
  $age = (Get-Date) - (Get-Item $alive).LastWriteTime
  $stale = $age.TotalSeconds -gt $StaleSeconds
}

if (-not $stale) {
  # Quiet on the happy path -- this fires every couple minutes forever; only log when it
  # actually DOES something, or the log would drown out everything else in this dir.
  exit 0
}

Log "heartbeat stale (or missing) -- restarting $DaemonTask"
try {
  Start-ScheduledTask -TaskName $DaemonTask -ErrorAction Stop
  Log "Start-ScheduledTask issued"
} catch {
  Log "Start-ScheduledTask FAILED: $($_.Exception.Message)"
}
