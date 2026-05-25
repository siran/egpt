# setup/watchdog.ps1 -- wedged-daemon detection + kill.
#
# Runs every minute via the egpt-watchdog scheduled task (see
# setup/egpt-watchdog.xml). The daemon writes ~/.egpt/state/alive
# every 15s as proof of liveness. If the file is stale (mtime older
# than $StaleSeconds), the daemon is wedged-but-alive (event loop
# blocked, deadlock, etc.) and the wrapper's `& node ...; respawn`
# loop can't detect it -- `&` is blocked too. Watchdog kills the
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

# Decide whether to restart: the daemon is wedged (alive.txt stale), OR the
# daemon is alive but the WhatsApp BRIDGE is dead (whatsapp-alive.txt stale).
# The bridge writes its own tic/toc beat and stops the timer on disconnect, so
# a stuck reconnect leaves whatsapp-alive.txt stale. The bridge's own
# _scheduleReconnect handles transient drops; this is the BACKSTOP for a stuck
# one — a daemon respawn re-inits the bridge. (Operator 2026-05-25: the tic/toc
# timing tells if it's alive — so check the WA beat the same way.)
$reason = $null
if ($ageSec -ge $StaleSeconds) {
  $reason = ("alive file is stale: age={0:N1}s threshold={1}s" -f $ageSec, $StaleSeconds)
} else {
  # Daemon is alive — is the WA bridge? More lenient threshold (default 180s):
  # bridge reconnects can legitimately take longer than a daemon beat, so only
  # a genuinely stuck bridge trips it. Configurable via wa_stale_seconds.
  $waPath = Join-Path $env:USERPROFILE '.egpt\state\whatsapp-alive.txt'
  if (Test-Path $waPath) {
    $WaStaleSeconds = 180
    try {
      if ($cfgPath -and (Test-Path $cfgPath)) {
        $mw = Select-String -Path $cfgPath -Pattern '^\s*wa_stale_seconds:\s*(\d+)' | Select-Object -First 1
        if ($mw) { $WaStaleSeconds = [int]$mw.Matches[0].Groups[1].Value }
      }
    } catch {}
    try {
      $waContent = Get-Content -Path $waPath -Raw -ErrorAction Stop
      $waStamps = [regex]::Matches($waContent, '(?m)^(?:tic|toc)\s+(\S+)') |
        ForEach-Object { try { ([datetime]::Parse($_.Groups[1].Value)).ToUniversalTime() } catch {} }
      if ($waStamps) { $waLatest = ($waStamps | Sort-Object -Descending)[0] }
      else { $waLatest = (Get-Item $waPath).LastWriteTimeUtc }
      $waAge = ((Get-Date).ToUniversalTime() - $waLatest).TotalSeconds
      if ($waAge -ge $WaStaleSeconds) {
        $reason = ("WA bridge whatsapp-alive.txt stale: age={0:N1}s threshold={1}s (daemon alive) -- restarting to re-init the bridge" -f $waAge, $WaStaleSeconds)
      }
    } catch { Log "could not read whatsapp-alive.txt: $_" }
  }
}

if (-not $reason) { exit 0 }   # daemon + bridge both healthy
Log ("$reason -- killing daemon")

# Kill target: prefer the pid embedded in the newest alive.txt beat
# ("<tic|toc> <iso> <pid>") -- self-contained, no egpt.pid dependency.
# Fall back to egpt.pid for back-compat with older daemons.
$procPid = $null
try {
  $beat = [regex]::Matches($content, '(?m)^(?:tic|toc)\s+\S+\s+(\d+)\s*$')
  if ($beat.Count -gt 0) { $procPid = $beat[$beat.Count - 1].Groups[1].Value }
} catch {}
if (-not $procPid -and (Test-Path $pidPath)) {
  try {
    $raw = (Get-Content -Path $pidPath -Raw).Trim()
    if ($raw -match '"pid"\s*:\s*(\d+)') { $procPid = $Matches[1] }
    elseif ($raw -match '^\d+') { $procPid = ($raw -split '\s+')[0] }
  } catch {}
}
if (-not $procPid) {
  Log "no kill target (no pid in alive.txt or egpt.pid); nothing to kill"
  exit 0
}

try {
  Stop-Process -Id ([int]$procPid) -Force -ErrorAction Stop
  Log "killed pid $procPid; wrapper will respawn"
} catch {
  Log "Stop-Process pid=${procPid} failed: $_"
}
