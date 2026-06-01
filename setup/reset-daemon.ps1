# setup/reset-daemon.ps1 -- hard-reset the egpt daemon to ONE clean
# instance. NO elevation: the daemon now runs at LeastPrivilege (operator
# 2026-05-24 — de-elevated to stop UAC secure-desktop transitions, which
# were crashing the machine). At medium integrity we can kill the daemon's
# node procs + re-run the task without admin and WITHOUT a UAC prompt.
#
# (One-time exception: flipping the tasks elevated->least-privilege needs a
# single UAC — that's install-tasks.ps1, not this. After that, this script
# never prompts.)
#
# What it does:
#   1. Stop the daemon task instance (egpt-daemon-headless)
#   2. Kill the daemon-wrap wrappers + node procs (clears duplicates)
#   3. Re-run the daemon task (fresh single tree on current code)
#   4. Wait + report: node procs, alive.txt freshness
#
# Run from any PowerShell (no admin needed):
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\src\egpt\setup\reset-daemon.ps1"
# or just:  .\src\egpt\setup\reset-daemon.ps1

$ErrorActionPreference = 'Continue'

$alivePath = Join-Path $env:USERPROFILE '.egpt\state\alive.txt'

Write-Host "=== 1. stopping task instance ==="
schtasks /End /TN egpt-daemon-headless 2>&1 | Out-Host

# Kill the daemon-wrap.ps1 WRAPPERS first. These are powershell.exe
# (not node), so a node-only kill leaves them looping -> they respawn
# fresh daemons -> duplicates survive the reset. Match by command line
# containing 'daemon-wrap.ps1', EXCLUDING this very process (and its
# parent shell) so the reset doesn't suicide.
Write-Host "=== 2a. killing daemon-wrap.ps1 wrappers ==="
$selfPid = $PID
try {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'daemon-wrap\.ps1' -and $_.ProcessId -ne $selfPid } |
    ForEach-Object {
      Write-Host ("  kill wrapper pid " + $_.ProcessId)
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch { Write-Host ("  wrapper scan error: " + $_) }

Write-Host "=== 2b. killing all node.exe ==="
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

Write-Host "=== 3. starting daemon task (fresh) ==="
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
Write-Host "done. One daemon, no watchdog. Check alive.txt freshness above."
Write-Host "This window stays open. Press Enter to close."
[void](Read-Host)
