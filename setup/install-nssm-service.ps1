# install-nssm-service.ps1 - install an egpt v2 node as a Windows Service via NSSM.
#
# A node is one profile: EGPT_HOME selects its config/conversations/state/sessions
# (default ~/.egpt). Independent nodes coexist by using different profiles - each
# gets its own service, its own ~/.egptN. This installs ONE such node.
#
# The service runs:  node egpt-daemon.mjs   (the supervisor; it spawns `node
# egpt.mjs` = boot(), respawns on crash, restarts a wedged spine, handles the
# /upgrade /restart /rewind exit codes). No --headless, no role flags - boot()
# IS the node. EGPT_HOME is set in the service environment and inherited by the
# spine, so the whole node follows the one profile.
#
# Run from an ELEVATED PowerShell, from the repo root:
#   # production node (default profile ~/.egpt, service 'egpt-daemon'):
#   powershell -ExecutionPolicy Bypass -File .\setup\install-nssm-service.ps1
#   # a second, isolated node on profile ~/.egpt2 (service 'egpt2-daemon'):
#   powershell -ExecutionPolicy Bypass -File .\setup\install-nssm-service.ps1 -EgptHome "$env:USERPROFILE\.egpt2"
#
# Remove:  setup\uninstall-nssm-service.ps1 -ServiceName <name>

param(
  [string]$EgptHome    = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string]$ServiceName = ''
)

$ErrorActionPreference = 'Stop'

# Derive the service name from the profile folder: ~/.egpt -> egpt-daemon,
# ~/.egpt2 -> egpt2-daemon. Keeps nodes from colliding on one machine.
if (-not $ServiceName) {
  $base = (Split-Path $EgptHome -Leaf) -replace '^\.', ''   # ".egpt2" -> "egpt2"
  if (-not $base) { $base = 'egpt' }
  $ServiceName = "$base-daemon"
}

# --- 1. ensure elevated ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This script must be run from an ELEVATED PowerShell (Run as administrator)." -ForegroundColor Red
  exit 1
}

# --- 2. ensure NSSM is on the system ---
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
  Write-Host "NSSM not found. Installing via winget..." -ForegroundColor Yellow
  winget install --id NSSM.NSSM --silent --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
  $nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
  if (-not $nssm) { throw "NSSM install via winget didn't put nssm on the PATH. Install from https://nssm.cc/download and re-run." }
}
Write-Host "NSSM: $nssm" -ForegroundColor Cyan

# --- 2b. host the service from a renamed nssm copy so Task Manager shows a
#         friendly name (egpt-service.exe) instead of nssm.exe. The copy lives in
#         the repo (setup/bin, gitignored), not in the profile dir. ---
$serviceBinDir = Join-Path $PSScriptRoot 'bin'
if (-not (Test-Path $serviceBinDir)) { New-Item -ItemType Directory -Path $serviceBinDir -Force | Out-Null }
$serviceBin = Join-Path $serviceBinDir 'egpt-service.exe'
$nssmReal = (Get-Item $nssm).FullName
if (-not (Test-Path $serviceBin) -or
    (Get-Item $serviceBin).Length -ne (Get-Item $nssmReal).Length -or
    (Get-Item $serviceBin).LastWriteTime -lt (Get-Item $nssmReal).LastWriteTime) {
  Copy-Item -Path $nssmReal -Destination $serviceBin -Force
}

# --- 3. resolve paths (THIS repo checkout runs the node) ---
$repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$daemonPath = Join-Path $repoRoot 'egpt-daemon.mjs'
$node       = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $daemonPath)) { throw "egpt-daemon.mjs not found at $daemonPath" }
if (-not (Test-Path $node))       { throw "node.exe not found at $node - install Node.js or edit the node path in this script" }

Write-Host ""
Write-Host "About to install node:" -ForegroundColor Cyan
Write-Host "  service : $ServiceName"
Write-Host "  repo    : $repoRoot"
Write-Host "  profile : $EgptHome   (EGPT_HOME)"
Write-Host ""

# --- 4. credentials: the service runs as you, so it can read the profile + your
#        `claude` login. ---
$svcUser = "$env:USERDOMAIN\$env:USERNAME"
$cred = Get-Credential -UserName $svcUser -Message "Password for $svcUser (the service runs as you so it can read $EgptHome and your claude login)"

# --- 5. clean reinstall of THIS service only (never touches other nodes/processes) ---
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "Removing existing $ServiceName service (clean reinstall)..." -ForegroundColor Yellow
  & $nssm stop   $ServiceName confirm | Out-Null
  & $nssm remove $ServiceName confirm | Out-Null
  Start-Sleep -Seconds 1
}

# --- 6. install + configure ---
$logDir = Join-Path (Join-Path $EgptHome 'config') 'logs'   # logs live under config/ now (operator 2026-07-03)
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$stdoutLog = Join-Path $logDir 'service-stdout.log'
$stderrLog = Join-Path $logDir 'service-stderr.log'

Write-Host "Installing $ServiceName (host: $serviceBin)..." -ForegroundColor Cyan
& $serviceBin install $ServiceName $node "$daemonPath"
& $nssm set $ServiceName AppDirectory        $repoRoot
& $nssm set $ServiceName AppEnvironmentExtra  "EGPT_HOME=$EgptHome"      # the one knob that selects the profile
& $nssm set $ServiceName DisplayName          "egpt node ($ServiceName)"
& $nssm set $ServiceName Description           "egpt v2 node - node egpt-daemon.mjs (supervisor) -> egpt.mjs (boot). Profile $EgptHome."
& $nssm set $ServiceName Start                SERVICE_AUTO_START
& $nssm set $ServiceName ObjectName           $cred.UserName $cred.GetNetworkCredential().Password
& $nssm set $ServiceName AppStdout            $stdoutLog
& $nssm set $ServiceName AppStderr            $stderrLog
& $nssm set $ServiceName AppStdoutCreationDisposition 4   # OPEN_ALWAYS (append)
& $nssm set $ServiceName AppStderrCreationDisposition 4
& $nssm set $ServiceName AppRotateFiles       1
& $nssm set $ServiceName AppRotateOnline      1
& $nssm set $ServiceName AppRotateBytes       10485760   # 10 MB
& $nssm set $ServiceName AppExit Default      Restart
& $nssm set $ServiceName AppRestartDelay      5000       # 5s before restart on crash
& $nssm set $ServiceName AppStopMethodConsole 10000      # 10s graceful Ctrl+C (SIGTERM -> boot stop)

# SCM-level recovery: restart the wrapper if it (not just the node child) is killed.
& sc.exe failure $ServiceName reset=86400 actions=restart/5000/restart/5000/restart/5000 | Out-Null
& sc.exe failureflag $ServiceName 1 | Out-Null

# --- 7. start ---
Write-Host "Starting $ServiceName..." -ForegroundColor Cyan
& $nssm start $ServiceName
Start-Sleep -Seconds 3
$svc = Get-Service $ServiceName
Write-Host ""
Write-Host "Service state: $($svc.Status)" -ForegroundColor $(if ($svc.Status -eq 'Running') {'Green'} else {'Red'})

if ($svc.Status -eq 'Running') {
  Write-Host ""
  Write-Host "Done. '$ServiceName' is running egpt from $repoRoot on profile $EgptHome." -ForegroundColor Green
  Write-Host "  Get-Content `"$stdoutLog`" -Tail 20 -Wait"
  Write-Host "  Stop:   Stop-Service $ServiceName"
  Write-Host "  Remove: setup\uninstall-nssm-service.ps1 -ServiceName $ServiceName"
} else {
  Write-Host "Service did not reach Running. Check: Get-Content `"$stderrLog`" -Tail 40" -ForegroundColor Red
  exit 1
}
