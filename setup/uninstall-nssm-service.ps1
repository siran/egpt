# uninstall-nssm-service.ps1 - remove one egpt v2 node's NSSM service.
#
# Removes only the named service (default 'egpt-daemon'). Never kills stray
# node.exe and never touches other nodes - independent profiles are independent.
# No egpt code, config, or auth state is touched; service logs are preserved.
#
# Run from an ELEVATED PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\setup\uninstall-nssm-service.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup\uninstall-nssm-service.ps1 -ServiceName egpt2-daemon

param([string]$ServiceName = 'egpt-daemon')

$ErrorActionPreference = 'Stop'

# --- 1. ensure elevated ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This script must be run from an ELEVATED PowerShell." -ForegroundColor Red
  exit 1
}

# --- 2. stop + remove the service if present ---
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -eq 'Running') {
    Write-Host "Stopping $ServiceName..." -ForegroundColor Yellow
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  $nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
  if ($nssm) {
    Write-Host "Removing $ServiceName via NSSM..." -ForegroundColor Yellow
    & $nssm remove $ServiceName confirm | Out-Null
  } else {
    Write-Host "NSSM not on PATH - falling back to sc.exe delete..." -ForegroundColor Yellow
    sc.exe delete $ServiceName | Out-Null
  }
  Write-Host "Removed $ServiceName." -ForegroundColor Green
} else {
  Write-Host "No $ServiceName service present." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Done. The node's spine stopped with the service; its profile (config/conversations/state) is untouched." -ForegroundColor Green
Write-Host "Verify:  Get-Service $ServiceName -ErrorAction SilentlyContinue   # should be empty"
