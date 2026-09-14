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
  # NO `2>&1` ON GIT, and that is the whole reason this deploy failed on 2026-09-14.
  # Windows PowerShell 5.1 wraps EVERY stderr line of a native exe in a NativeCommandError
  # ErrorRecord; with $ErrorActionPreference='Stop' that is TERMINATING. git writes its
  # progress meter to stderr, so a checkout large enough to print one ("Updating files:
  # 25% (129/506)") aborted the deploy mid-reset -- the tree was left with files from the
  # new commit under the OLD HEAD, and the service was never restarted. The error even
  # read as `ERROR: Updating files: 25% (129/506)`, which is a progress line, not a fault.
  # --no-progress silences the meter at the source; the exit code is what is checked.
  & $git -C $Repo fetch origin --quiet --no-progress
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed (exit $LASTEXITCODE)" }
  & $git -C $Repo reset --hard --quiet origin/main
  if ($LASTEXITCODE -ne 0) { throw "git reset --hard origin/main failed (exit $LASTEXITCODE)" }
  $after  = (& $git -C $Repo rev-parse --short HEAD).Trim()
  $target = (& $git -C $Repo rev-parse --short origin/main).Trim()
  Log "prod now $after (origin/main $target)"
  # THE TREE IS CHECKED, NOT ASSUMED. A reset that dies partway leaves a working tree that
  # does not match its own HEAD -- which is what a half-deployed node IS, and the state the
  # failure above left dolly in. Restarting onto that is the one outcome worth refusing.
  if ($after -ne $target) { throw "prod HEAD $after is not origin/main $target -- refusing to restart" }
  # TRACKED CHANGES ONLY. A prod tree legitimately carries untracked scratch (reve has three
  # loose plans/ and setup/ files), and refusing to deploy over those would turn this guard
  # into the thing that blocks every deploy. What must never be tolerated is a TRACKED file
  # that does not match HEAD -- which is exactly what a half-applied reset leaves behind.
  $dirty = & $git -C $Repo status --porcelain --untracked-files=no
  if ($dirty) { throw "prod tree is dirty after reset -- refusing to restart:`n$($dirty -join "`n")" }

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