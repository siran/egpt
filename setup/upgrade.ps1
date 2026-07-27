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
$before = '?'
if ($git -and (Test-Path $Repo)) { $before = (& $git -C $Repo rev-parse --short HEAD).Trim() }
$beat0 = (Get-Item $alive).LastWriteTime

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

$after = '?'
if ($git -and (Test-Path $Repo)) { $after = (& $git -C $Repo rev-parse --short HEAD).Trim() }

Write-Host ""
if ($ok) {
  Write-Host "=== DEPLOY OK ===" -ForegroundColor Green
  Write-Host "  $before -> $after"
  if ($before -eq $after) {
    Write-Host "  (same commit -- it was already current; rebuilt and respawned anyway)" -ForegroundColor DarkGray
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
  $remote = 'powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\bin\egpt\setup\upgrade.ps1"'
  & ssh -o ConnectTimeout=8 $Peer $remote
  if ($LASTEXITCODE -ne 0) { Write-Host "PEER DEPLOY FAILED (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
}
