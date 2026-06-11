# restart-egpt-service.ps1 — canonical clean restart for the egpt-daemon
# NSSM service. Run ELEVATED (the service tree lives in session 0).
#
# WHY NOT plain Restart-Service: NSSM's graceful stop can hang while the
# bridge holds its WebSocket (handoff 2026-06-07), and a taskkill of the
# app tree alone has been observed to leave NSSM wedged appless-but-
# "Running" (it logged 'service is stopping' kills, then never restarted
# the app). This script stops bounded, kills whatever's left, starts
# fresh, and reports.
$ErrorActionPreference = 'Continue'
# Elevated windows close with their output — keep a transcript so the
# non-elevated caller can read what actually happened.
try { Start-Transcript -Path (Join-Path $env:USERPROFILE '.egpt\logs\restart-elevated.log') -Force | Out-Null } catch {}

Write-Host "stopping egpt-daemon..."
sc.exe stop egpt-daemon | Out-Null
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 10) {
  if ((Get-Service egpt-daemon).Status -eq 'Stopped') { break }
  Start-Sleep -Milliseconds 500
}
if ((Get-Service egpt-daemon).Status -ne 'Stopped') {
  Write-Host "stop hung after 10s - killing wrapper + node tree"
  taskkill /F /IM egpt-service.exe 2>$null | Out-Null
  Start-Sleep -Seconds 2
}
# Orphaned node children survive a wrapper kill — sweep any node.exe whose
# command line is the egpt daemon/shell so a stale bridge can't hold the
# WA session against the fresh one.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  if ($_.CommandLine -match 'egpt(-daemon)?\.mjs') {
    Write-Host ("killing orphan node pid {0}" -f $_.ProcessId)
    taskkill /F /T /PID $_.ProcessId 2>$null | Out-Null
  }
}
Start-Sleep -Seconds 2
Write-Host "starting egpt-daemon..."
sc.exe start egpt-daemon | Out-Null
Start-Sleep -Seconds 5
$svc = Get-Service egpt-daemon
$nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'egpt' })
Write-Host ("service={0} egpt-node-procs={1} pids={2}" -f $svc.Status, $nodes.Count, (($nodes | ForEach-Object { $_.ProcessId }) -join ','))
try { Stop-Transcript | Out-Null } catch {}
