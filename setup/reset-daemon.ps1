# setup/reset-daemon.ps1 -- hard-reset egpt to ONE clean daemon instance.
#
# Use this to recover from a respawn / takeover war (two engines fighting over
# the single WhatsApp session: 61s respawns, "connection replaced (reason 440)"
# in whatsapp-alive.txt). It stops the task, kills the node procs, clears the
# stale liveness/takeover files, restarts ONE daemon, and reports.
#
# NO elevation needed: the daemon runs at LeastPrivilege, so your own (same-user)
# shell can kill its node procs and re-run the task without admin or a UAC prompt.
# Scripts are blocked by the default execution policy, so run it like this:
#
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\src\egpt\setup\reset-daemon.ps1"
#
# (NOTE: step 2 kills ALL node.exe processes -- the surest way to clear the war.
# If you run other Node apps, close this one and kill egpt selectively instead.)

$ErrorActionPreference = 'Continue'
$Task = 'egpt-spine'                       # the current daemon task (was egpt-daemon-headless)
$EgptHome = Join-Path $env:USERPROFILE '.egpt'
$alivePath = Join-Path $EgptHome 'state\alive.txt'

Write-Host "=== 1. stopping task instance ($Task) ==="
schtasks /End /TN $Task 2>&1 | Out-Host

Write-Host "=== 2. killing all node.exe (clears duplicates / the war) ==="
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host ("  kill pid " + $_.Id)
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3
$left = Get-Process node -ErrorAction SilentlyContinue
if ($left) { Write-Host ("  WARNING: still alive: " + ($left.Id -join ', ')) }
else       { Write-Host "  all node procs cleared" }

Write-Host "=== 3. clearing stale liveness / takeover files ==="
foreach ($f in $alivePath, (Join-Path $EgptHome 'egpt.pid'), (Join-Path $EgptHome 'nucleus.json')) {
  if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue; Write-Host ("  cleared " + (Split-Path $f -Leaf)) }
}

Write-Host "=== 4. starting daemon task (fresh, single tree on current code) ==="
schtasks /Run /TN $Task 2>&1 | Out-Host

Write-Host "=== 5. waiting 18s for boot + connect ==="
Start-Sleep -Seconds 18

Write-Host "--- node procs (expect 2: egpt-daemon.mjs + egpt.mjs) ---"
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id, SessionId | Format-Table -AutoSize | Out-Host

Write-Host "--- alive.txt (expect fresh tic/toc, ONE pid) ---"
if (Test-Path $alivePath) { Get-Content $alivePath | Out-Host } else { Write-Host "  (no alive.txt yet -- still booting)" }

$waPath = Join-Path $EgptHome 'state\whatsapp-alive.txt'
Write-Host "--- whatsapp-alive.txt (want 'tic/toc ... pushname=...', NOT 'reconnecting') ---"
if (Test-Path $waPath) { Get-Content $waPath | Out-Host } else { Write-Host "  (not connected yet)" }

Write-Host ""
Write-Host "done. One daemon. If WhatsApp shows tic/toc with a pushname, you're good to sleep + test."
Write-Host "This window stays open. Press Enter to close."
[void](Read-Host)
