# reset-spine.ps1 - clean single-daemon restart of egpt.
#
# Stops the egpt-spine task, kills EVERY egpt node process (daemon + engine),
# clears the stale liveness/takeover files, then starts exactly ONE daemon
# (which loads the latest code on disk). Use this when the daemon has gotten
# into a respawn / takeover war (two engines fighting over the WhatsApp session).
#
# Run it elevated. Either:
#   Right-click > Run with PowerShell   (it self-elevates), or
#   powershell -ExecutionPolicy Bypass -File .\setup\reset-spine.ps1

# --- self-elevate if not Administrator ---
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host "not elevated - relaunching as Administrator..."
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  return
}

$ErrorActionPreference = 'SilentlyContinue'
$Task = 'egpt-spine'
$EgptHome = Join-Path $env:USERPROFILE '.egpt'

function Get-EgptNodes {
  Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -like '*egpt*' }
}

Write-Host "== egpt reset =="

# 1. stop the task so nothing respawns mid-cleanup
Write-Host "[1/5] stopping task '$Task'..."
Stop-ScheduledTask -TaskName $Task

# 2. kill every egpt node process
Write-Host "[2/5] killing egpt node processes..."
$killed = 0
foreach ($p in @(Get-EgptNodes)) {
  Write-Host ("      kill pid {0}" -f $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force
  $killed++
}
Write-Host ("      killed: {0}" -f $killed)

# 3. clear stale liveness / takeover files
Write-Host "[3/5] clearing stale liveness files (alive.txt, egpt.pid, nucleus.json)..."
Remove-Item (Join-Path $EgptHome 'state\alive.txt') -Force
Remove-Item (Join-Path $EgptHome 'egpt.pid') -Force
Remove-Item (Join-Path $EgptHome 'nucleus.json') -Force

# 4. confirm clean (retry once if anything survived)
Start-Sleep -Seconds 3
$left = @(Get-EgptNodes)
Write-Host ("[4/5] egpt processes left (want 0): {0}" -f $left.Count)
if ($left.Count -gt 0) {
  Write-Host "      survivors found - killing again..."
  foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force }
  Start-Sleep -Seconds 2
}

# 5. start exactly one daemon
Write-Host "[5/5] starting one daemon..."
Start-ScheduledTask -TaskName $Task

# --- verify ---
Write-Host ""
Write-Host "waiting 18s for it to connect..."
Start-Sleep -Seconds 18
Write-Host ""
Write-Host "== verify =="
$procs = @(Get-EgptNodes)
Write-Host ("egpt processes: {0}   (healthy = 2: one daemon + one engine)" -f $procs.Count)
foreach ($p in $procs) {
  $kind = 'engine'; if ($p.CommandLine -like '*daemon*') { $kind = 'daemon' }
  Write-Host ("  pid {0,-7} {1}" -f $p.ProcessId, $kind)
}
Write-Host ""
Write-Host "alive.txt (one pid, ticking):"
Get-Content (Join-Path $EgptHome 'state\alive.txt')
Write-Host ""
Write-Host "whatsapp-alive.txt (want 'tic/toc ... pushname=...', NOT 'reconnecting'):"
Get-Content (Join-Path $EgptHome 'state\whatsapp-alive.txt')
Write-Host ""
Write-Host "Done. If WhatsApp shows tic/toc with a pushname, you're good to sleep + test."
Write-Host "Then: sleep the PC, send a voice note, wake it, and check ~/.egpt/wa-bridge.log"
Write-Host "for: 'wake: ...suspend gap', 'stay-awake: ... asserted', 'connection OPEN', 'transcribed ...'."
Write-Host ""
Read-Host "Press Enter to close"
