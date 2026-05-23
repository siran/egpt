# setup/reset-daemon.ps1 -- hard-reset the egpt daemon to ONE clean
# elevated instance. Self-elevating (relaunches with UAC if not admin)
# because killing high-integrity node procs + running the S4U task
# both need admin.
#
# What it does:
#   1. Stop both scheduled-task instances (egpt-daemon-headless, egpt-watchdog)
#   2. Kill ALL node.exe (clears leftover/duplicate daemon generations)
#   3. Re-run the daemon task (fresh single elevated tree on current code)
#   4. Wait + report: node procs, alive.txt freshness, watchdog status
#
# Run from any PowerShell:
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\src\egpt\setup\reset-daemon.ps1"
# or just:  .\src\egpt\setup\reset-daemon.ps1

$ErrorActionPreference = 'Continue'

# --- self-elevate ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "not admin -- relaunching elevated (approve UAC)..."
  Start-Process powershell -Verb RunAs -ArgumentList @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`""
  )
  exit
}

$alivePath = Join-Path $env:USERPROFILE '.egpt\state\alive.txt'

Write-Host "=== 1. stopping task instances ==="
schtasks /End /TN egpt-daemon-headless 2>&1 | Out-Host
schtasks /End /TN egpt-watchdog        2>&1 | Out-Host

Write-Host "=== 2. killing all node.exe ==="
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host ("  kill pid " + $_.Id)
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3
$left = Get-Process node -ErrorAction SilentlyContinue
if ($left) { Write-Host ("  WARNING: still alive: " + ($left.Id -join ', ')) }
else       { Write-Host "  all node procs cleared" }

# Clear the stale heartbeat so the first fresh beat is unambiguous.
Remove-Item $alivePath -Force -ErrorAction SilentlyContinue

Write-Host "=== 3. starting daemon task (fresh elevated tree) ==="
schtasks /Run /TN egpt-daemon-headless 2>&1 | Out-Host

Write-Host "=== 4. waiting 10s for boot + heartbeat ==="
Start-Sleep -Seconds 10

Write-Host "--- node procs (expect 2: egpt-daemon.mjs + egpt.mjs) ---"
Get-Process node -ErrorAction SilentlyContinue |
  Select-Object Id, SessionId | Format-Table -AutoSize | Out-Host

Write-Host "--- alive.txt (expect fresh tic/toc, SAME pid) ---"
if (Test-Path $alivePath) { Get-Content $alivePath | Out-Host }
else { Write-Host "  (no alive.txt yet -- daemon may still be booting)" }

Write-Host ""
Write-Host "done. The watchdog task runs every 1 min; check"
Write-Host "  ~/.egpt/state/watchdog.log  appears within a minute."
Write-Host "This window stays open. Press Enter to close."
[void](Read-Host)
