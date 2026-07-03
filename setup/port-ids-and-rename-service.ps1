# port-ids-and-rename-service.ps1 - ONE-SHOT (operator 2026-07-03). Double-click to run.
#
# Does three things in order:
#   1. stops the node service
#   2. ports the live profile to SHORT chat ids (setup/port-short-chat-ids.mjs)
#   3. runs setup/retire-v1-and-rename-service.ps1 (deletes the egpt-tick task,
#      removes the v1 service, renames egpt2-daemon -> egpt-daemon, prompts once
#      for the .\an password, starts the node)
#
# Re-run-safe: the port is idempotent and the rename script has its own guards.
# Self-elevates if not already Administrator.

# --- self-elevate ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Not elevated - relaunching as Administrator..."
  Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`""
  exit
}

$ErrorActionPreference = 'Stop'

try {
  Write-Host "Step 1: stopping the node service"
  Stop-Service egpt2-daemon -ErrorAction SilentlyContinue
  Stop-Service egpt-daemon -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host "Step 2: porting the profile to short chat ids"
  & node "$PSScriptRoot\port-short-chat-ids.mjs"
  if ($LASTEXITCODE -ne 0) {
    throw "port-short-chat-ids.mjs failed (exit $LASTEXITCODE) - service left stopped, nothing renamed"
  }

  Write-Host ""
  Write-Host "Step 3: retire v1 + rename the service (asks for the .\an password once)"
  & powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\retire-v1-and-rename-service.ps1"
} catch {
  Write-Host ""
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'done - press enter'
}
