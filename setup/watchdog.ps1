# setup/watchdog.ps1 — wedged-daemon detection + kill.
#
# Runs every minute via the egpt-watchdog scheduled task (see
# setup/egpt-watchdog.xml). The daemon writes ~/.egpt/state/alive
# every 15s as proof of liveness. If the file is stale (mtime older
# than $StaleSeconds), the daemon is wedged-but-alive (event loop
# blocked, deadlock, etc.) and the wrapper's `& node …; respawn`
# loop can't detect it — `&` is blocked too. Watchdog kills the
# daemon pid; wrapper's loop respawns immediately.
#
# Operator (2026-05-23): "a heartbeat-to-file pattern so an external
# watchdog notices wedged-but-alive states (process exists, doing
# nothing)."
#
# Log: ~/.egpt/state/watchdog.log

$ErrorActionPreference = 'Continue'
$alivePath = Join-Path $env:USERPROFILE '.egpt\state\alive'
$pidPath   = Join-Path $env:USERPROFILE '.egpt\egpt.pid'
$logPath   = Join-Path $env:USERPROFILE '.egpt\state\watchdog.log'
$StaleSeconds = 210

function Log($m) {
  try { Add-Content -Path $logPath -Value "[watchdog $(Get-Date -Format o)] $m" } catch {}
}

# Missing alive file: daemon never started, or stopAliveHeartbeat
# fired on graceful shutdown. Either way, the wrapper handles
# respawn; watchdog stays out of it.
if (-not (Test-Path $alivePath)) {
  Log "no alive file at $alivePath; nothing to check"
  exit 0
}

try {
  $ageSec = ((Get-Date) - (Get-Item $alivePath).LastWriteTime).TotalSeconds
} catch {
  Log "could not stat alive file: $_"
  exit 0
}

if ($ageSec -lt $StaleSeconds) {
  # Fresh — daemon is alive.
  exit 0
}

Log ("alive file is stale: age={0:N1}s threshold={1}s — killing daemon" -f $ageSec, $StaleSeconds)

if (-not (Test-Path $pidPath)) {
  Log "no pid file at $pidPath; nothing to kill"
  exit 0
}

try {
  $procPid = (Get-Content -Path $pidPath -Raw).Trim()
} catch {
  Log "could not read pid file: $_"
  exit 0
}

if (-not $procPid) {
  Log "pid file is empty"
  exit 0
}

try {
  Stop-Process -Id ([int]$procPid) -Force -ErrorAction Stop
  Log "killed pid $procPid; wrapper will respawn"
} catch {
  Log "Stop-Process pid=${procPid} failed: $_"
}
