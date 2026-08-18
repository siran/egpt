# cutover-to-session1.ps1 -- swap the running daemon from the Session-0 NSSM service to the
# Session-1 scheduled task (setup/register-daemon-task.ps1 must already be registered -- run
# that first). Requires elevation (stopping/disabling a Windows service always does).
#
# ASCII ONLY, deliberately: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI, so a
# non-ASCII character here (an em-dash, an arrow) mangles into bytes that break the parser
# (see upgrade.ps1's own header for the same rule).
#
# Does NOT delete the NSSM service -- stops it and sets Start=Disabled, so it stays as a
# ready rollback (re-enable + Start-Service to revert).
#
#   powershell -ExecutionPolicy Bypass -File .\setup\cutover-to-session1.ps1

param(
  [string]$TaskName = 'egpt-daemon-session1',
  [string]$EgptHome = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' })
)

$ErrorActionPreference = 'Stop'

$isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isElevated) {
  Write-Host "Not elevated -- re-launching this script in an elevated window that stays open..." -ForegroundColor Yellow
  $q = [char]34
  $self = $q + $PSCommandPath + $q
  Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoExit -NoProfile -ExecutionPolicy Bypass -File $self" -Verb RunAs
  exit
}

Write-Host "=== Stopping the old NSSM service ===" -ForegroundColor Cyan
Stop-Service -Name egpt-daemon -Force -ErrorAction SilentlyContinue
& nssm set egpt-daemon Start SERVICE_DISABLED
$svc = Get-Service egpt-daemon
Write-Host "  egpt-daemon (NSSM): $($svc.Status), StartType=$($svc.StartType) -- kept registered as rollback"

Write-Host ""
Write-Host "=== Starting the new Session-1 scheduled task ===" -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$alive = Join-Path $EgptHome 'state\alive.txt'
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  if (Test-Path $alive) {
    $age = (Get-Date) - (Get-Item $alive).LastWriteTime
    if ($age.TotalSeconds -lt 15) { $ok = $true; break }
  }
  Start-Sleep -Seconds 1
}

Write-Host ""
if ($ok) {
  Write-Host "=== HEARTBEAT FRESH -- daemon is up ===" -ForegroundColor Green
} else {
  Write-Host "=== NO FRESH HEARTBEAT after 30s -- something's wrong ===" -ForegroundColor Red
  Write-Host "Check: $EgptHome\config\logs\service-stdout.log (old NSSM log) and the task's own history (Task Scheduler GUI, or Get-ScheduledTaskInfo -TaskName $TaskName)"
}

$task = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "  task last run: $($task.LastRunTime) (result $($task.LastTaskResult))"

$conn = Get-NetTCPConnection -LocalPort 23375 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)"
  if ($proc.SessionId -ne 0) {
    Write-Host "  shell-editor port 23375: pid $($proc.ProcessId), Session $($proc.SessionId) (Session 1 -- correct)"
  } else {
    Write-Host "  shell-editor port 23375: pid $($proc.ProcessId), Session $($proc.SessionId) (Session 0 -- WRONG, still the old one somehow)"
  }
} else {
  Write-Host "  shell-editor port 23375: not listening"
}

Write-Host ""
Write-Host "Rollback if needed:" -ForegroundColor Yellow
Write-Host "  Stop-ScheduledTask -TaskName $TaskName; Disable-ScheduledTask -TaskName $TaskName"
Write-Host "  nssm set egpt-daemon Start SERVICE_AUTO_START; Start-Service egpt-daemon"
Write-Host ""
Write-Host "Press any key to close this window."
[void][System.Console]::ReadKey($true)
