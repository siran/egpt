# start-egpt.ps1 - THE WAY BACK from setup\stop-egpt.cmd.
#
# Normally you do not run this by hand - double-click setup\start-egpt.cmd.
#
# Undoes the stop, in the mirror order:
#   1. DELETE  EGPT_HOME\STOP  - while that file exists boot refuses to start, so
#      starting a runner without deleting it just makes the spine exit again.
#      Its contents are printed first: it records who stopped the node and why.
#   2. START the Session 1 task (setup/register-session1-daemon-task.ps1) - only while this
#      user is logged on at a desktop, and unless its daemon is already up - then wait for
#      that daemon to hold state\s1.claim. The task is MultipleInstances=IgnoreNew, so a
#      stale Running instance is stopped first or the start would be a no-op.
#   3. START the Session 0 service of the same name (setup/install-nssm-service.ps1) when it
#      is Stopped and not Disabled. While Session 1 holds the profile it holds off; it takes
#      the node back at logoff. Nobody logged on (ssh, the S4U backstop): this step alone.
#
# Idempotent: no STOP file / runners already up are all fine. Output with "already running"
# and no "Starting task"/"Starting service" line means nothing needed starting
# (setup\egpt-wake-duty.ps1 reads that). Exit 1 when the node is left without its runner.
# No elevation: the task is the operator's own, and install-nssm-service grants the
# operator start/stop on the service.
#
#   powershell -ExecutionPolicy Bypass -File .\setup\start-egpt.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup\start-egpt.ps1 -EgptHome "$env:USERPROFILE\.egpt-secondary"

param(
  [string]$EgptHome = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string]$TaskName = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'egpt-runners.ps1')

# --- 1. same profile -> task-name derivation the registrar uses ---
$base = (Split-Path $EgptHome -Leaf) -replace '^\.', ''   # ".egpt-secondary" -> "egpt-secondary"
if (-not $TaskName) {
  # THROW, never fall back to 'egpt' (2026-09-11): an empty leaf means EgptHome arrived
  # empty or mangled, and silently resolving that to the PRIMARY node is how a start aimed
  # at one node lands on another.
  if (-not $base) { throw "cannot derive a task name: -EgptHome is empty or has no leaf ('$EgptHome'). Pass -TaskName explicitly." }
  $TaskName = "$base-daemon"
}
$ServiceName = $TaskName   # the Session 0 service shares the task's name
$log = Join-Path (Join-Path $EgptHome 'config') 'logs\session1-daemon.log'
$serviceLog = Join-Path (Join-Path $EgptHome 'config') 'logs\daemon-stdout.log'

Write-Host ""
Write-Host "Starting egpt:" -ForegroundColor Cyan
Write-Host "  profile : $EgptHome   (EGPT_HOME)"
Write-Host "  task    : $TaskName"
Write-Host "  service : $ServiceName"
Write-Host ""

# --- 2. clear the kill switch (printing WHY the node was stopped) ---
$stopFile = Join-Path $EgptHome 'STOP'
if (Test-Path $stopFile) {
  Write-Host "The node was stopped by this file:" -ForegroundColor Yellow
  Get-Content $stopFile | ForEach-Object { Write-Host "  | $_" -ForegroundColor DarkGray }
  Remove-Item $stopFile -Force
  Write-Host "Removed $stopFile" -ForegroundColor Green
} else {
  Write-Host "No STOP file at $stopFile - nothing to clear." -ForegroundColor DarkGray
}

# --- 3. the Session 1 task, while this user is logged on at a desktop ---
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$loggedOn = Test-EgptInteractiveLogon (Get-EgptExplorers) $me
$running = $null
if (-not $loggedOn) {
  Write-Host "$me is not logged on at a desktop: no Session 1 daemon to start." -ForegroundColor DarkGray
} elseif (-not ($task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
  Write-Host "No scheduled task named '$TaskName' on this machine." -ForegroundColor Yellow
  Write-Host "  Register it with: powershell -ExecutionPolicy Bypass -File setup\register-session1-daemon-task.ps1 -EgptHome `"$EgptHome`""
} elseif ($running = Get-EgptLivePid $EgptHome 'daemon-s1.pid' 'egpt-daemon.mjs') {
  Write-Host "The Session 1 daemon was already running (pid $running)." -ForegroundColor DarkGray
} else {
  if ("$($task.State)" -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
  Write-Host "Starting task $TaskName..." -ForegroundColor Yellow
  Start-ScheduledTask -TaskName $TaskName
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt 20 -and -not ($running = Get-EgptLivePid $EgptHome 'daemon-s1.pid' 'egpt-daemon.mjs')) { Start-Sleep -Milliseconds 500 }
  # The service holds off only for a daemon that holds the claim (Get-EgptServiceStartVerdict).
  $claim = Get-EgptS1ClaimPath $EgptHome
  while ($running -and $sw.Elapsed.TotalSeconds -lt 20 -and -not (Test-BeeperClaimHeld $claim)) { Start-Sleep -Milliseconds 500 }
  if (-not $running) { Write-Host "No Session 1 daemon came up within 20s." -ForegroundColor Red }
}

# --- 4. the Session 0 service ---
$facts = Read-EgptServiceFacts $ServiceName $EgptHome
$serviceUp = $facts.status -eq 'Running'
$verdict = Get-EgptServiceStartVerdict $facts
if (-not $facts.exists) {
  Write-Host "No $ServiceName service: nothing runs this node while nobody is logged on (setup\install-nssm-service.cmd installs it, at the console)." -ForegroundColor Yellow
} elseif ($serviceUp) {
  Write-Host "Service $ServiceName was already running." -ForegroundColor DarkGray
} elseif (-not $verdict.start) {
  Write-Host "Service $ServiceName left $($facts.status): $($verdict.reason)" -ForegroundColor Yellow
} elseif (-not (Test-BeeperServiceControl $ServiceName)) {
  Write-Host "Service $ServiceName left Stopped: $me may not start it (setup\install-nssm-service.cmd grants that). The STOP file is already gone, so it starts at the next boot, or now from an elevated shell: Start-Service $ServiceName" -ForegroundColor Yellow
} else {
  Write-Host "Starting service $ServiceName..." -ForegroundColor Yellow
  Start-Service -Name $ServiceName
  $serviceUp = $true
}

Write-Host ""
$ok = if ($loggedOn) { [bool]$running } else { $serviceUp }
if ($ok) {
  $what = @()
  if ($running) { $what += "$TaskName daemon pid $running" }
  if ($serviceUp) { $what += "service $ServiceName" }
  Write-Host "=== egpt is running ($($what -join ', ')) ===" -ForegroundColor Green
  if ($running) { Write-Host "  Watch it:  Get-Content `"$log`" -Tail 20 -Wait" }
  if ($serviceUp) { Write-Host "  Service :  Get-Content `"$serviceLog`" -Tail 20 -Wait" }
  Write-Host "  Stop it:   setup\stop-egpt.cmd"
} else {
  Write-Host "egpt is NOT running: $(if ($loggedOn) { 'no Session 1 daemon' } else { "nobody is logged on and $ServiceName is not running" })." -ForegroundColor Red
  Write-Host "  Check: Get-Content `"$(if ($loggedOn) { $log } else { $serviceLog })`" -Tail 40"
  exit 1
}
