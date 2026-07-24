# setup/deploy.ps1 -- SELF-ELEVATING deploy for a SUPERVISOR-level change.
#
# Fast-forwards the prod checkout (~/bin/egpt) to origin/main and RESTARTS the
# egpt-daemon service. Use this (not an ingest /restart) when the change alters
# what the supervisor spawns -- e.g. an entry-point rename that moves the spine to
# egpt-spine.mjs. An ingest /restart only respawns the spine via the ALREADY-RUNNING
# supervisor, so a new daemon-runtime appPath never takes effect; only a full
# service restart reloads it.
#
# Service control needs admin, so this self-elevates via UAC (one prompt). It logs
# to -LogPath (default a temp file) so the launching shell can read the result.
#
#   powershell -ExecutionPolicy Bypass -File setup\deploy.ps1
#   powershell -ExecutionPolicy Bypass -File setup\deploy.ps1 -LogPath C:\path\deploy.log
[CmdletBinding()]
param(
  [string]$Repo    = (Join-Path $env:USERPROFILE 'bin\egpt'),
  [string]$Service = 'egpt-daemon',
  [string]$LogPath = (Join-Path $env:TEMP 'egpt-deploy.log')
)
$ErrorActionPreference = 'Stop'

# --- self-elevate: relaunch as admin if we are not already ---
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $a = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Repo `"$Repo`" -Service `"$Service`" -LogPath `"$LogPath`""
  Start-Process powershell -Verb RunAs -ArgumentList $a
  Write-Host "Elevation requested. Approve the UAC prompt. Result logged to $LogPath"
  exit 0
}

# --- elevated from here ---
function Log($m) { ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) | Tee-Object -FilePath $LogPath -Append | Out-Null }
Set-Content -Path $LogPath -Value "" -Encoding utf8
Log "elevated deploy: repo=$Repo service=$Service"

# git -- resolve a real path (elevated PATH may differ)
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { foreach ($p in @('C:\Program Files\Git\cmd\git.exe','C:\Program Files (x86)\Git\cmd\git.exe','C:\Program Files\Git\bin\git.exe')) { if (Test-Path $p) { $git = $p; break } } }
if (-not $git) { Log "ERROR: git not found"; Start-Sleep 4; exit 1 }

try {
  $before = (& $git -C $Repo rev-parse --short HEAD).Trim()
  Log "prod at $before. fetch + reset --hard origin/main"
  & $git -C $Repo fetch origin --quiet 2>&1 | ForEach-Object { Log "git: $_" }
  (& $git -C $Repo reset --hard origin/main 2>&1) | ForEach-Object { Log "git: $_" }
  $after = (& $git -C $Repo rev-parse --short HEAD).Trim()
  Log "prod now $after"

  Log "restarting service $Service ..."
  Restart-Service $Service -Force
  Start-Sleep -Seconds 3
  Log "service status: $((Get-Service $Service).Status)"

  # Proof the SPINE (not the shell) booted: only the spine beats alive.txt.
  $alive = Join-Path $env:USERPROFILE '.egpt\state\alive.txt'
  if (Test-Path $alive) {
    $t0 = (Get-Item $alive).LastWriteTime
    $ok = $false
    for ($i=0; $i -lt 90; $i++) { Start-Sleep 1; if ((Get-Item $alive).LastWriteTime -ne $t0) { $ok = $true; break } }
    Log ("heartbeat advanced: {0} (now {1})" -f $ok, (Get-Item $alive).LastWriteTime.ToString('HH:mm:ss'))
    if ($ok) { Log "DEPLOY OK: spine is live on $after" } else { Log "DEPLOY WARNING: no heartbeat; check the daemon" }
  } else {
    Log "alive.txt missing; cannot confirm spine heartbeat"
  }
} catch {
  Log "ERROR: $($_.Exception.Message)"
}
Log "done."
Start-Sleep -Seconds 2