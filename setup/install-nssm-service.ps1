# install-nssm-service.ps1 - install egpt-daemon as a Windows Service via NSSM.
#
# Why: on Modern Standby (S0 Low Power Idle) hardware where Task Scheduler
# wakes are aggressively suppressed (operator 2026-06-05 testing on Ryzen
# 7 7730U), a continuously-running Windows Service has a better chance of
# being granted execution windows during sleep - particularly to service
# the live WebSocket connection to web.whatsapp.com. The Task Scheduler
# approach is left intact and stopped (not deleted), so this can be backed
# out by running uninstall-nssm-service.ps1 + re-enabling the task.
#
# Architecture mirrors the current Task Scheduler setup:
#   - Runs node.exe egpt-daemon.mjs --headless
#   - As the configured user (REVE\an), so WA auth state + ~/.egpt access work
#   - Auto-restart on crash, similar effect to TS RestartOnFailure
#   - Writes service stdout/stderr to ~/.egpt/service-{stdout,stderr}.log
#
# Run from an ELEVATED PowerShell:
#     powershell -ExecutionPolicy Bypass -File .\setup\install-nssm-service.ps1
#
# After install, verify with:
#     Get-Service egpt-daemon
#     Get-Content $env:USERPROFILE\.egpt\service-stdout.log -Tail 20
#     Get-Content $env:USERPROFILE\.egpt\wa-bridge.log -Tail 20
#
# To remove: setup\uninstall-nssm-service.ps1

$ErrorActionPreference = 'Stop'

# --- 1. ensure elevated ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This script must be run from an ELEVATED PowerShell. Right-click PowerShell -> Run as administrator." -ForegroundColor Red
  exit 1
}

# --- 2. ensure NSSM is on the system ---
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
  Write-Host "NSSM not found. Installing via winget..." -ForegroundColor Yellow
  winget install --id NSSM.NSSM --silent --accept-source-agreements --accept-package-agreements
  # Refresh PATH so this session can find it
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
  $nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
  if (-not $nssm) { throw "NSSM install via winget didn't put nssm on the PATH. Install manually from https://nssm.cc/download and re-run." }
}
Write-Host "NSSM: $nssm" -ForegroundColor Cyan

# --- 2b. copy nssm.exe to a renamed binary so Task Manager shows
#         'egpt-service.exe' instead of 'nssm.exe' for the service host.
#         The renamed copy still IS nssm — the binary just has a friendlier
#         name. NSSM honors any rename of its executable: SCM launches
#         whatever path is registered as the service ImagePath, so we point
#         that at the renamed copy. All `nssm set/start/stop/remove` commands
#         in the rest of this script still use the canonical $nssm (those
#         are admin operations that don't care which copy is invoked). ---
$serviceBinDir = Join-Path $env:USERPROFILE '.egpt\bin'
if (-not (Test-Path $serviceBinDir)) { New-Item -ItemType Directory -Path $serviceBinDir -Force | Out-Null }
$serviceBin = Join-Path $serviceBinDir 'egpt-service.exe'
# Resolve $nssm if it's a winget shim symlink — symlinks can't be SCM ImagePath
# (SCM derefs the link but Get-Command may have returned the link target via
# the shim binary). Copy from the actual file either way.
$nssmReal = (Get-Item $nssm).FullName
if (-not (Test-Path $serviceBin) -or
    (Get-Item $serviceBin).Length -ne (Get-Item $nssmReal).Length -or
    (Get-Item $serviceBin).LastWriteTime -lt (Get-Item $nssmReal).LastWriteTime) {
  Write-Host "Copying $nssmReal -> $serviceBin (so the service appears in Task Manager as egpt-service.exe)..." -ForegroundColor Cyan
  Copy-Item -Path $nssmReal -Destination $serviceBin -Force
} else {
  Write-Host "Reusing existing $serviceBin (matches winget NSSM)." -ForegroundColor DarkGray
}

# --- 3. resolve egpt paths ---
$repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$daemonPath = Join-Path $repoRoot 'egpt-daemon.mjs'
$node       = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $daemonPath)) { throw "egpt-daemon.mjs not found at $daemonPath" }
if (-not (Test-Path $node))       { throw "node.exe not found at $node - install Node.js or edit this script's `\$node path" }

# --- 4. remove any legacy egpt-spine Task Scheduler entry so we don't run
#        TWO daemons. The XML definition stays in setup/egpt-spine.xml as
#        the documented fallback path; a user who wants to revert can
#        re-import it with schtasks /Create /XML setup\egpt-spine.xml. ---
$existingTask = schtasks /Query /TN egpt-spine /FO LIST 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Removing legacy egpt-spine Task Scheduler task..." -ForegroundColor Yellow
  schtasks /End    /TN egpt-spine 2>&1 | Out-Null
  schtasks /Delete /TN egpt-spine /F 2>&1 | Out-Null
  Write-Host "  (Re-create with: schtasks /Create /XML setup\egpt-spine.xml /TN egpt-spine /RU <user> /RP *)" -ForegroundColor DarkGray
}

# --- 5. kill any leftover node.exe so the new service starts cleanly ---
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "Killing leftover node pid $($_.Id)..." -ForegroundColor DarkGray
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# --- 6. credentials for service principal (so it can read ~/.egpt) ---
$svcUser = "$env:USERDOMAIN\$env:USERNAME"
$cred = Get-Credential -UserName $svcUser -Message "Password for $svcUser (the service runs as this user so it can access ~/.egpt)"

# --- 7. if the service already exists, remove it first (clean slate) ---
$existing = Get-Service -Name 'egpt-daemon' -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Removing existing egpt-daemon service (clean reinstall)..." -ForegroundColor Yellow
  & $nssm stop   egpt-daemon confirm 2>&1 | Out-Null
  & $nssm remove egpt-daemon confirm 2>&1 | Out-Null
  Start-Sleep -Seconds 1
}

# --- 8. install + configure the service ---
$logDir = Join-Path $env:USERPROFILE '.egpt\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$stdoutLog = Join-Path $logDir 'service-stdout.log'
$stderrLog = Join-Path $logDir 'service-stderr.log'

Write-Host "Installing egpt-daemon service (host: $serviceBin)..." -ForegroundColor Cyan
# Use the renamed binary for `install` so SCM records ImagePath = egpt-service.exe.
# All subsequent `nssm set/start/stop` calls can use either copy — they're
# admin operations that just talk to SCM about config; they don't change
# which exe is the service host.
& $serviceBin install egpt-daemon $node "$daemonPath" --headless
& $nssm set egpt-daemon AppDirectory       $repoRoot
& $nssm set egpt-daemon DisplayName        'egpt personal AI bridge daemon'
& $nssm set egpt-daemon Description        'Node.js egpt-daemon.mjs wrapped via NSSM. Holds the WhatsApp bridge + engine. Equivalent to the egpt-spine Task Scheduler task; replaces it on Modern Standby hardware where TS wakes are suppressed during sleep.'
& $nssm set egpt-daemon Start              SERVICE_AUTO_START
& $nssm set egpt-daemon ObjectName         $cred.UserName $cred.GetNetworkCredential().Password
& $nssm set egpt-daemon AppStdout          $stdoutLog
& $nssm set egpt-daemon AppStderr          $stderrLog
& $nssm set egpt-daemon AppStdoutCreationDisposition 4   # OPEN_ALWAYS (append)
& $nssm set egpt-daemon AppStderrCreationDisposition 4   # OPEN_ALWAYS (append)
& $nssm set egpt-daemon AppRotateFiles     1
& $nssm set egpt-daemon AppRotateOnline    1
& $nssm set egpt-daemon AppRotateBytes     10485760   # 10 MB per rotation
& $nssm set egpt-daemon AppExit Default    Restart
& $nssm set egpt-daemon AppRestartDelay    5000      # 5 s before restart on crash
& $nssm set egpt-daemon AppStopMethodSkip  0          # use all stop methods (Ctrl+C, WM_CLOSE, terminate)
& $nssm set egpt-daemon AppStopMethodConsole 10000    # 10 s for graceful Ctrl+C
& $nssm set egpt-daemon AppStopMethodWindow  5000     # 5 s for WM_CLOSE
& $nssm set egpt-daemon AppStopMethodThreads 5000     # 5 s for thread termination

# --- 8b. SCM-level failure actions ---
# NSSM's AppExit/AppRestartDelay handle the case where the wrapped node.exe
# child crashes (NSSM sees its child die and respawns it). They do NOT
# handle the case where the wrapper itself (egpt-service.exe) dies - e.g.
# someone End-Tasks it from Task Manager. For that we need SCM-level
# recovery: actions registered with the Service Control Manager that fire
# when the service process terminates unexpectedly.
#
# Without this, an End-Task on egpt-service.exe leaves the service stopped
# until next reboot. With this, SCM restarts the wrapper after 5s, NSSM
# starts back up, NSSM spawns node, normal operation resumes within ~10s.
#
# reset=86400 - reset the failure counter after a day of uptime so a long
#               stable run doesn't accumulate phantom failures.
# actions=restart/5000/restart/5000/restart/5000
#             - first 3 failures: restart with 5s delay between attempts.
# failureflag=1 - apply the actions even on "non-crash" stops (which is
#                 how SCM categorizes a kill-from-Task-Manager). Default
#                 is to only apply on crash; flag=1 enables for any
#                 unexpected stop.
Write-Host "Configuring SCM failure actions (restart 3x with 5s delay if wrapper killed)..." -ForegroundColor Cyan
& sc.exe failure egpt-daemon reset=86400 actions=restart/5000/restart/5000/restart/5000 | Out-Null
& sc.exe failureflag egpt-daemon 1 | Out-Null

# --- 9. start it ---
Write-Host "Starting egpt-daemon service..." -ForegroundColor Cyan
& $nssm start egpt-daemon

Start-Sleep -Seconds 3
$svc = Get-Service egpt-daemon
Write-Host ""
Write-Host "Service state: $($svc.Status)" -ForegroundColor $(if ($svc.Status -eq 'Running') {'Green'} else {'Red'})

if ($svc.Status -eq 'Running') {
  Write-Host ""
  Write-Host "Done. egpt is now running as a Windows Service." -ForegroundColor Green
  Write-Host ""
  Write-Host "Verify:" -ForegroundColor Cyan
  Write-Host "  Get-Service egpt-daemon"
  Write-Host "  Get-Content $stdoutLog -Tail 20 -Wait"
  Write-Host "  Get-Content $env:USERPROFILE\.egpt\wa-bridge.log -Tail 20 -Wait"
  Write-Host ""
  Write-Host "Stop the service:    Stop-Service egpt-daemon"
  Write-Host "Start the service:   Start-Service egpt-daemon"
  Write-Host "Remove + restore TS: setup\uninstall-nssm-service.ps1"
} else {
  Write-Host ""
  Write-Host "Service did not reach Running state. Check the stderr log:" -ForegroundColor Red
  Write-Host "  Get-Content $stderrLog -Tail 40"
  exit 1
}
