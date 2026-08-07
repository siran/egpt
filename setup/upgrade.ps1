# setup/upgrade.ps1 -- the EVERYDAY deploy: drop /upgrade in the ingest box, then VERIFY.
#
# The spine sweeps EGPT_HOME/state/ingest every second, consumes the file, and exits 42;
# the daemon then does git pull + build + respawn (src/spine/ingest.mjs). That is the whole
# deploy. This script adds the part that is tedious by hand: proving it actually landed.
#
# Use setup/deploy.ps1 INSTEAD when the change alters what the SUPERVISOR spawns (an
# entry-point rename, daemon-runtime appPath). That one restarts the service and needs UAC.
# This one never elevates -- it writes one file into your own profile.
#
# ASCII ONLY, deliberately: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI, so a
# non-ASCII character here (an em-dash, an arrow) mangles into bytes that break the parser.
#
#   powershell -ExecutionPolicy Bypass -File setup\upgrade.ps1
#   powershell -ExecutionPolicy Bypass -File setup\upgrade.ps1 -EgptHome "$env:USERPROFILE\.egpt2"
#   powershell -ExecutionPolicy Bypass -File setup\upgrade.ps1 -Peer an@192.168.1.102
[CmdletBinding()]
param(
  [string]$EgptHome  = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string]$Repo      = (Join-Path $env:USERPROFILE 'bin\egpt'),
  [int]$TimeoutSec   = 120,
  [string]$Peer      = ''     # user@host -- deploy THIS node, then run this same script there over ssh
)
$ErrorActionPreference = 'Stop'

$stop   = Join-Path $EgptHome 'STOP'
$alive  = Join-Path $EgptHome 'state\alive.txt'
$ingest = Join-Path $EgptHome 'state\ingest'

# --- refuse on a stopped node: boot checks STOP first and exits clean, so an /upgrade
#     dropped now would be consumed by a spine that never starts. ---
if (Test-Path $stop) {
  Write-Host "REFUSING: $stop exists -- the node is deliberately stopped." -ForegroundColor Red
  foreach ($ln in (Get-Content $stop)) { Write-Host "  $ln" -ForegroundColor DarkGray }
  Write-Host "Clear it first:  setup\start-egpt.cmd" -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path $alive)) {
  Write-Host "REFUSING: no $alive -- is the node running?" -ForegroundColor Red
  exit 1
}

$git = (Get-Command git -ErrorAction SilentlyContinue).Source
# rev-parse FAILS on a repo with no commits (and prints to stderr), returning null -- calling
# .Trim() on that throws and kills the deploy. Guard both reads; '?' is already the unknown value.
function Get-ShortHead($gitExe, $repo) {
  if (-not $gitExe -or -not (Test-Path $repo)) { return '?' }
  $out = (& $gitExe -C $repo rev-parse --short HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $out) { return '?' }
  return ([string]$out).Trim()
}
$before = Get-ShortHead $git $Repo
$beat0 = (Get-Item $alive).LastWriteTime

# --- WHAT SHOULD LAND: the deploy is the daemon doing `git pull`, so the target is the
#     remote's main. Resolve it FIRST. Without this the script can only compare the repo to
#     itself, and an unreachable remote reads exactly like "already up to date" -- which is
#     precisely the false green this produced on 2026-08-05: it reported DEPLOY OK / already
#     current while the pull had failed on a network blocking port 22, and the spine came back
#     on the OLD code. A deploy tool that cannot tell those apart is worse than none. ---
$target = ''
$remoteErr = ''
if ($git -and (Test-Path $Repo)) {
  # 2>&1 on a NATIVE exe is a trap in PS 5.1: each stderr line becomes an ErrorRecord, which
  # under $ErrorActionPreference='Stop' TERMINATES the script -- so probing for an unreachable
  # remote would kill the very deploy it exists to warn about. Drop the preference for this one
  # call, then restore it.
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $lsOut = (& $git -C $Repo ls-remote origin main 2>&1 | Out-String)
  $lsRc  = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  if ($lsRc -eq 0 -and $lsOut.Trim()) {
    $target = $lsOut.Trim().Split("`n")[0].Split()[0].Substring(0, 7)
  } else {
    # FIRST line, not last: git's final stderr line is the generic "make sure you have the
    # correct access rights and the repository exists" tail, which names no cause. The first
    # line is the actual one ("ssh: connect to host github.com port 22: Connection timed out").
    $remoteErr = ($lsOut.Trim() -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
    if ($remoteErr) { $remoteErr = $remoteErr.Trim() } else { $remoteErr = "git ls-remote exited $lsRc" }
  }
}
if ($remoteErr) {
  Write-Host "WARNING: cannot reach the remote -- $remoteErr" -ForegroundColor Yellow
  Write-Host "         the daemon's git pull will fail; this will REBUILD AND RESPAWN THE CURRENT CODE, not update it." -ForegroundColor Yellow
  Write-Host "         (GitHub also serves ssh on 443: git push ssh://git@ssh.github.com:443/<owner>/<repo>.git main)" -ForegroundColor DarkGray
  Write-Host ""
}

Write-Host ""
Write-Host "Deploying:" -ForegroundColor Cyan
Write-Host "  profile : $EgptHome"
Write-Host "  prod    : $Repo  (at $before)"
Write-Host ""

# --- temp -> rename, because the sweep skips *.tmp so a half-written file is never read ---
New-Item -ItemType Directory -Force -Path $ingest | Out-Null
$tmp   = Join-Path $ingest 'upgrade.tmp'
$final = Join-Path $ingest 'upgrade'
[IO.File]::WriteAllText($tmp, "/upgrade", (New-Object Text.UTF8Encoding $false))
Move-Item -Path $tmp -Destination $final -Force
Write-Host "dropped /upgrade into the ingest box -- waiting for the spine to bounce..." -ForegroundColor Yellow

# --- the proof is the HEARTBEAT advancing: only a live spine writes alive.txt. The sha may
#     legitimately not move (already current), so it is reported, never required. ---
$ok = $false
for ($i = 0; $i -lt $TimeoutSec; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $stop) {
    Write-Host "FAILED: $stop appeared during the deploy -- the node stopped itself." -ForegroundColor Red
    foreach ($ln in (Get-Content $stop)) { Write-Host "  $ln" -ForegroundColor DarkGray }
    exit 1
  }
  if ((Get-Item $alive).LastWriteTime -ne $beat0) { $ok = $true; break }
}

$after = Get-ShortHead $git $Repo

Write-Host ""
if ($ok -and $target -and $after -ne $target) {
  # The spine came back -- on the WRONG code. Loudest possible, because a green here is how
  # you lose an hour later wondering why a fix you "deployed" is not in effect.
  Write-Host "=== DEPLOY FAILED -- the spine restarted on the OLD code ===" -ForegroundColor Red
  Write-Host "  prod is at $after, but the remote's main is $target"
  Write-Host "  the pull did not land. Check the daemon log:"
  Write-Host "  $EgptHome\config\logs\service-stdout.log"
  exit 1
} elseif ($ok) {
  Write-Host "=== DEPLOY OK ===" -ForegroundColor Green
  Write-Host "  $before -> $after"
  if ($before -eq $after) {
    if ($remoteErr) {
      # Say WHICH kind of no-op this was. These look identical in the sha and are not the
      # same event at all: one means nothing needed doing, the other means nothing could be done.
      Write-Host "  (same commit -- REMOTE UNREACHABLE, so nothing could be pulled; rebuilt and respawned the existing code)" -ForegroundColor Yellow
    } else {
      Write-Host "  (same commit -- it was already current; rebuilt and respawned anyway)" -ForegroundColor DarkGray
    }
  }
  Write-Host ("  heartbeat: " + (Get-Item $alive).LastWriteTime.ToString('HH:mm:ss'))
} else {
  Write-Host "=== NO HEARTBEAT after $TimeoutSec s ===" -ForegroundColor Red
  Write-Host "  prod is at $after. The spine may still be building, or the daemon is wedged."
  Write-Host "  Check the log:  $EgptHome\config\logs\service-stdout.log"
  exit 1
}

# --- the peer, by running THIS SAME SCRIPT there over ssh: the remote copy does its own
#     drop + heartbeat proof, so there is one deploy procedure, never a second one that
#     drifts. %USERPROFILE% expands on the REMOTE shell, so no path is hardcoded here. ---
if ($Peer) {
  Write-Host ""
  Write-Host "Peer $Peer :" -ForegroundColor Cyan
  # FORWARD SLASHES, UNQUOTED, on purpose: backslashes are eaten in transit to the remote
  # shell (a quoted C:\Users\... arrives as C:\Users\anbinegpt...), and quoting to survive
  # both shells is worse. Windows accepts / in a path, and this one has no spaces.
  $remote = 'powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%/bin/egpt/setup/upgrade.ps1'
  & ssh -o ConnectTimeout=8 $Peer $remote
  if ($LASTEXITCODE -ne 0) { Write-Host "PEER DEPLOY FAILED (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
}
