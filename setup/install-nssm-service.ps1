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

# --- 3. resolve egpt paths ---
$repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$daemonPath = Join-Path $repoRoot 'egpt-daemon.mjs'
$node       = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $daemonPath)) { throw "egpt-daemon.mjs not found at $daemonPath" }
if (-not (Test-Path $node))       { throw "node.exe not found at $node - install Node.js or edit this script's `\$node path" }

# --- 4. stop the Task Scheduler approach so we don't run TWO daemons ---
Write-Host "Stopping any running egpt-spine task instance..." -ForegroundColor Yellow
schtasks /End /TN egpt-spine 2>&1 | Out-Null
Write-Host "Disabling egpt-spine task (NSSM service takes over)..." -ForegroundColor Yellow
schtasks /Change /TN egpt-spine /DISABLE 2>&1 | Out-Null
Write-Host "  (Re-enable with: schtasks /Change /TN egpt-spine /ENABLE)" -ForegroundColor DarkGray

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
$logDir = Join-Path $env:USERPROFILE '.egpt'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$stdoutLog = Join-Path $logDir 'service-stdout.log'
$stderrLog = Join-Path $logDir 'service-stderr.log'

Write-Host "Installing egpt-daemon service..." -ForegroundColor Cyan
& $nssm install egpt-daemon $node "$daemonPath" --headless
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
