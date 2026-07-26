# start-egpt.ps1 - THE WAY BACK from setup\stop-egpt.cmd.
#
# Normally you do not run this by hand - double-click setup\start-egpt.cmd, which
# auto-elevates and runs this.
#
# Undoes both halves of the stop, in the mirror order:
#   1. DELETE  EGPT_HOME\STOP  - while that file exists boot refuses to start, so
#      starting the service without deleting it just makes the spine exit again.
#      Its contents are printed first: it records who stopped the node and why.
#   2. START the NSSM service.
#
# Idempotent: no STOP file / an already-running service are both fine.
#
# Run from an ELEVATED PowerShell if you prefer the command line:
#   powershell -ExecutionPolicy Bypass -File .\setup\start-egpt.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup\start-egpt.ps1 -EgptHome "$env:USERPROFILE\.egpt2"

param(
  [string]$EgptHome    = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string]$ServiceName = ''
)

$ErrorActionPreference = 'Stop'

# --- 1. ensure elevated (the .cmd wrapper already does this; this is the belt) ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This script must be run from an ELEVATED PowerShell (or double-click setup\start-egpt.cmd)." -ForegroundColor Red
  exit 1
}

# --- 2. same profile -> service-name derivation the installer uses ---
if (-not $ServiceName) {
  $base = (Split-Path $EgptHome -Leaf) -replace '^\.', ''   # ".egpt2" -> "egpt2"
  if (-not $base) { $base = 'egpt' }
  $ServiceName = "$base-daemon"
}

Write-Host ""
Write-Host "Starting egpt:" -ForegroundColor Cyan
Write-Host "  profile : $EgptHome   (EGPT_HOME)"
Write-Host "  service : $ServiceName"
Write-Host ""

# --- 3. clear the kill switch (printing WHY the node was stopped) ---
$stopFile = Join-Path $EgptHome 'STOP'
if (Test-Path $stopFile) {
  Write-Host "The node was stopped by this file:" -ForegroundColor Yellow
  Get-Content $stopFile | ForEach-Object { Write-Host "  | $_" -ForegroundColor DarkGray }
  Remove-Item $stopFile -Force
  Write-Host "Removed $stopFile" -ForegroundColor Green
} else {
  Write-Host "No STOP file at $stopFile - nothing to clear." -ForegroundColor DarkGray
}

# --- 4. start the service ---
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
  Write-Host "No service named '$ServiceName' on this machine." -ForegroundColor Yellow
  $others = @(Get-Service | Where-Object { $_.Name -like '*egpt*' })
  if ($others.Count) {
    Write-Host ("  egpt services that DO exist: " + (($others | ForEach-Object { "$($_.Name) [$($_.Status)]" }) -join ', '))
  }
  Write-Host "  Install one with: setup\install-nssm-service.cmd"
  exit 1
}
if ($svc.Status -eq 'Running') {
  Write-Host "$ServiceName was already running." -ForegroundColor DarkGray
} else {
  Write-Host "Starting $ServiceName..." -ForegroundColor Yellow
  Start-Service -Name $ServiceName
  Start-Sleep -Seconds 3
}

$final = (Get-Service $ServiceName).Status
Write-Host ""
if ($final -eq 'Running') {
  Write-Host "=== egpt is running ($ServiceName) ===" -ForegroundColor Green
  $log = Join-Path (Join-Path $EgptHome 'config') 'logs\service-stdout.log'
  Write-Host "  Watch it:  Get-Content `"$log`" -Tail 20 -Wait"
  Write-Host "  Stop it:   setup\stop-egpt.cmd"
} else {
  Write-Host "$ServiceName is '$final' - it did not come up." -ForegroundColor Red
  $err = Join-Path (Join-Path $EgptHome 'config') 'logs\service-stderr.log'
  Write-Host "  Check: Get-Content `"$err`" -Tail 40"
  exit 1
}
