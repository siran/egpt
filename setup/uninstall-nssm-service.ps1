# uninstall-nssm-service.ps1 - remove the NSSM-wrapped egpt-daemon service
# and re-enable the egpt-spine Task Scheduler task as the supervisor.
#
# Use this to back out of install-nssm-service.ps1 cleanly: stops the
# service, removes it from the SCM, deletes service log files, and re-
# enables the Task Scheduler approach so egpt resumes the way it was
# before NSSM. No egpt code or auth state is touched.
#
# Run from an ELEVATED PowerShell:
#     powershell -ExecutionPolicy Bypass -File .\setup\uninstall-nssm-service.ps1

$ErrorActionPreference = 'Stop'

# --- 1. ensure elevated ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This script must be run from an ELEVATED PowerShell." -ForegroundColor Red
  exit 1
}

# --- 2. stop + remove the service if present ---
$svc = Get-Service -Name 'egpt-daemon' -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -eq 'Running') {
    Write-Host "Stopping egpt-daemon service..." -ForegroundColor Yellow
    Stop-Service egpt-daemon -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  $nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
  if ($nssm) {
    Write-Host "Removing egpt-daemon service via NSSM..." -ForegroundColor Yellow
    & $nssm remove egpt-daemon confirm 2>&1 | Out-Null
  } else {
    Write-Host "NSSM not on PATH - falling back to sc.exe delete..." -ForegroundColor Yellow
    sc.exe delete egpt-daemon | Out-Null
  }
  Write-Host "  removed." -ForegroundColor Green
} else {
  Write-Host "No egpt-daemon service present." -ForegroundColor DarkGray
}

# --- 3. kill any leftover node.exe so the next supervisor starts clean ---
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "Killing leftover node pid $($_.Id)..." -ForegroundColor DarkGray
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

# --- 4. (optional) restore the Task Scheduler supervisor ---
# Skipped by default (operator 2026-06-05): when you choose to uninstall the
# service, the expectation is no autostart. If you want the Task Scheduler
# approach back, re-import it explicitly:
#
#   schtasks /Create /XML setup\egpt-spine.xml /TN egpt-spine /RU $env:USERNAME /RP *
#
# The XML lives in the repo as the documented fallback supervisor.

Write-Host ""
Write-Host "Done. NSSM service removed." -ForegroundColor Green
Write-Host ""
Write-Host "Verify:" -ForegroundColor Cyan
Write-Host "  Get-Service egpt-daemon -ErrorAction SilentlyContinue   # should be empty"
Write-Host "  Get-Process node                                          # should be empty"
Write-Host ""
Write-Host "To restore the Task Scheduler supervisor instead:"
Write-Host "  schtasks /Create /XML setup\egpt-spine.xml /TN egpt-spine /RU `$env:USERNAME /RP *"
Write-Host ""
Write-Host "Service logs at $env:USERPROFILE\.egpt\logs\service-{stdout,stderr}.log are preserved (delete manually if you want)."
