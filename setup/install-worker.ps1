# install-worker.ps1 - set up a WORKER machine (transcriptor role).
#
# Does the two elevated steps a worker needs, then hands off to the normal
# service installer:
#   1. Opens an inbound firewall rule for the transcriptor port (default
#      23390) on the PRIVATE profile only - so the main spine on the LAN
#      can POST audio, but the port is never exposed on public networks.
#   2. Invokes install-nssm-service.ps1 to install + start egpt-daemon as a
#      Windows Service (the daemon runs egpt.mjs, which brings up the
#      transcriptor role because ~/.egpt/config.yaml has transcriptor.enabled).
#
# Run via the self-elevating wrapper:  setup\install-worker.cmd
# Or directly from an ELEVATED PowerShell:
#     powershell -ExecutionPolicy Bypass -File .\setup\install-worker.ps1 [-Port 23390]
#
# Reverse: setup\uninstall-nssm-service.ps1  +  Remove-NetFirewallRule -DisplayName egpt-transcriptor
#
# NOTE: pure ASCII on purpose - Windows PowerShell 5.1 reads non-BOM files as
# Windows-1252, so a multibyte char (em dash etc.) in a STRING desyncs the
# parser. Keep this file ASCII-only.
param(
  [int]$Port = 23390
)

$ErrorActionPreference = 'Stop'

# --- 1. ensure elevated ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This script must be run elevated. Use setup\install-worker.cmd (auto-elevates) or run from an admin PowerShell." -ForegroundColor Red
  exit 1
}

# --- 2. firewall rule for the transcriptor port (PRIVATE profile only) ---
# Private-only is deliberate: the worker accepts the spine over the LAN, never
# the public internet. Requests are HMAC-gated regardless, but keeping the
# port off public profiles is defense in depth.
$ruleName = 'egpt-transcriptor'
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existingRule) {
  Write-Host "Updating existing firewall rule '$ruleName' to TCP $Port (Private)..." -ForegroundColor Cyan
  $existingRule | Set-NetFirewallRule -Direction Inbound -Action Allow -Protocol TCP -Profile Private -Enabled True
  $existingRule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port
} else {
  Write-Host "Creating firewall rule '$ruleName' to allow inbound TCP $Port (Private profile)..." -ForegroundColor Cyan
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Private `
    -Description 'egpt transcriptor worker - main spine POSTs audio for GPU transcription. LAN only; requests are HMAC-signed.' | Out-Null
}
Write-Host "Firewall: inbound TCP $Port allowed on Private networks." -ForegroundColor Green

# Best-effort heads-up if the active connection is on a Public profile (the
# rule will not apply there by design).
$publicConnected = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' }
if ($publicConnected) {
  Write-Host "NOTE: an active network is categorized 'Public' - the rule is Private-only, so the spine must reach this machine over a network marked Private/Home. Set the LAN connection to Private if needed." -ForegroundColor Yellow
}

# --- 3. install the egpt-daemon service (shared installer) ---
$svcInstaller = Join-Path $PSScriptRoot 'install-nssm-service.ps1'
if (-not (Test-Path $svcInstaller)) { throw "install-nssm-service.ps1 not found next to this script ($svcInstaller)" }
Write-Host ""
Write-Host "Handing off to install-nssm-service.ps1 - installs + starts egpt-daemon, prompts for your password." -ForegroundColor Cyan
Write-Host ""
& $svcInstaller
$rc = $LASTEXITCODE
if ($rc -ne 0) { Write-Host "Service installer exited $rc." -ForegroundColor Red; exit $rc }

Write-Host ""
Write-Host "Worker setup complete." -ForegroundColor Green
Write-Host "  transcriptor log:  Get-Content `$env:USERPROFILE\.egpt\logs\transcriptor.log -Tail 20 -Wait"
Write-Host "  on the SPINE, set transcription_endpoint to http://<this-machine-LAN-ip>:$Port plus the same transcription_token"
