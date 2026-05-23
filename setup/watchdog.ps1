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
$alivePath = Join-Path $env:USERPROFILE '.egpt\state\alive.txt'
$pidPath   = Join-Path $env:USERPROFILE '.egpt\egpt.pid'
$logPath   = Join-Path $env:USERPROFILE '.egpt\state\watchdog.log'

# Threshold is configurable via ~/.egpt/config.yaml:
#   heartbeat:
#     stale_seconds: 90
# Crude line-grep (avoids a YAML parser dependency in PowerShell).
# Falls back to 90 if the file / key is absent or unparseable.
$StaleSeconds = 90
try {
  $cfgPath = Join-Path $env:USERPROFILE '.egpt\config.yaml'
  if (Test-Path $cfgPath) {
    $m = Select-String -Path $cfgPath -Pattern '^\s*stale_seconds:\s*(\d+)' | Select-Object -First 1
    if ($m) { $StaleSeconds = [int]$m.Matches[0].Groups[1].Value }
  }
} catch { }

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

# tic/toc parse: the file holds up to two lines, "tic <iso>" and/or
# "toc <iso>". Freshness = the most recent of those timestamps. Fall
# back to file mtime if the content can't be parsed (mid-write race,
# legacy format).
try {
  $content = Get-Content -Path $alivePath -Raw -ErrorAction Stop
  $stamps = [regex]::Matches($content, '(?m)^(?:tic|toc)\s+(\S+)') |
    ForEach-Object {
      try { ([datetime]::Parse($_.Groups[1].Value)).ToUniversalTime() } catch {}
    }
  if ($stamps) {
    $latest = ($stamps | Sort-Object -Descending)[0]
  } else {
    $latest = (Get-Item $alivePath).LastWriteTimeUtc
  }
  $ageSec = ((Get-Date).ToUniversalTime() - $latest).TotalSeconds
} catch {
  Log "could not read alive file: $_"
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
