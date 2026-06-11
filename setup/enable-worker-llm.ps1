# enable-worker-llm.ps1 - activate the local LLM (@l) on a WORKER machine.
#
# Two elevated steps, then a service restart so the egpt daemon picks up the
# local_llm block already written to ~/.egpt/config.yaml:
#   1. Open an inbound firewall rule for the llama-server port (default 8080)
#      on the PRIVATE profile only - so the main spine's @l can reach it over
#      the LAN, never the public internet. (Raw llama-server is unauthenticated;
#      LAN + Private + a router firewall is the trust boundary.)
#   2. Restart egpt-daemon (via restart-egpt-service.ps1), which spawns +
#      supervises llama-server from the local_llm config.
#
# Run via the self-elevating wrapper:  setup\enable-worker-llm.cmd
# Or from an ELEVATED PowerShell:
#     powershell -ExecutionPolicy Bypass -File .\setup\enable-worker-llm.ps1 [-Port 8080]
#
# NOTE: pure ASCII on purpose - Windows PowerShell 5.1 reads non-BOM files as
# Windows-1252, so a multibyte char in a STRING desyncs the parser. ASCII only.
param(
  [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'

# --- 1. ensure elevated ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This script must be run elevated. Use setup\enable-worker-llm.cmd (auto-elevates) or run from an admin PowerShell." -ForegroundColor Red
  exit 1
}

# --- 2. firewall rule for the llama-server port (PRIVATE profile only) ---
$ruleName = 'egpt-llama'
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existingRule) {
  Write-Host "Updating existing firewall rule '$ruleName' to TCP $Port (Private)..." -ForegroundColor Cyan
  $existingRule | Set-NetFirewallRule -Direction Inbound -Action Allow -Protocol TCP -Profile Private -Enabled True
  $existingRule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port
} else {
  Write-Host "Creating firewall rule '$ruleName' to allow inbound TCP $Port (Private profile)..." -ForegroundColor Cyan
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Private `
    -Description 'egpt local LLM (@l) - main spine dials llama-server here over the LAN. LAN only; llama-server itself is unauthenticated.' | Out-Null
}
Write-Host "Firewall: inbound TCP $Port allowed on Private networks." -ForegroundColor Green

# --- 3. restart egpt-daemon so it spawns llama-server from local_llm config ---
$restart = Join-Path $PSScriptRoot 'restart-egpt-service.ps1'
if (-not (Test-Path $restart)) { throw "restart-egpt-service.ps1 not found next to this script ($restart)" }
Write-Host ""
Write-Host "Restarting egpt-daemon to pick up the local_llm block..." -ForegroundColor Cyan
& $restart

# --- 4. verify the llama-server port comes up (model load can take ~15s) ---
Write-Host ""
Write-Host "Waiting for llama-server to listen on $Port (model load ~15s)..." -ForegroundColor Cyan
$listening = $false
for ($i = 0; $i -lt 40; $i++) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($conn) { $listening = $true; break }
  Start-Sleep -Seconds 1
}
if ($listening) {
  Write-Host "llama-server is listening on TCP $Port." -ForegroundColor Green
  Write-Host ""
  Write-Host "Next, on the MAIN SPINE add:" -ForegroundColor Cyan
  Write-Host "  siblings:"
  Write-Host "    l:"
  Write-Host "      type: llama"
  Write-Host ("      url: http://{0}:{1}" -f ((Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } | Select-Object -First 1).IPAddress), $Port)
  Write-Host "      body_emoji: llama"
  Write-Host ""
  Write-Host "Worker @l log lines appear in: Get-Content `$env:USERPROFILE\.egpt\logs\headless.log -Tail 20"
} else {
  Write-Host "llama-server did NOT come up on $Port within 40s." -ForegroundColor Red
  Write-Host "Check: Get-Content `$env:USERPROFILE\.egpt\logs\headless.log -Tail 40   (look for 'local_llm:' lines)" -ForegroundColor Yellow
  exit 1
}
