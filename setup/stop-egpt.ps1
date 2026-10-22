# stop-egpt.ps1 - THE STOP BUTTON: take this node down, and keep it down.
#
# Normally you do not run this by hand - double-click setup\stop-egpt.cmd.
#
# FOUR actions, in THIS order (start-egpt.ps1 undoes them in the mirror order):
#   1. write  EGPT_HOME\STOP  - the kill-switch FILE (src/stop-guard.mjs). While it
#      exists boot REFUSES to start and a RUNNING spine halts on its next tick, so
#      the node stays down even if a runner restarts or the machine reboots.
#   2. Stop-Service the Session 0 service of the same name (setup/install-nssm-service.ps1)
#      if it runs. Denied: the STOP file still halts it - its spine exits 0, the daemon
#      exits 0, and NSSM's AppExit 0 = Exit keeps the service down.
#   3. Stop-ScheduledTask the Session 1 task (setup/register-session1-daemon-task.ps1).
#   4. taskkill the daemon trees - Stop-ScheduledTask does not kill one. The Session 1
#      daemon is found by state\daemon-s1.pid, an orphan spine by state\spine.pid, and,
#      when the service could not be stopped, its daemon by state\daemon-s0.pid; each pid
#      is killed only if its command line still runs egpt-daemon.mjs / egpt-spine.mjs.
# The FILE comes first on purpose: anything that respawns meanwhile refuses to start.
#
# UNDO: double-click setup\start-egpt.cmd (deletes the file, starts the task and the service).
#
# Idempotent: an existing STOP file is left exactly as it is (whoever stopped the
# node first owns the explanation) and an already-stopped node is left alone.
# No elevation: the task and its processes are the operator's own, and
# install-nssm-service grants the operator start/stop on the service.
#
# WARNING - THE FILE FORMAT BELOW IS A SECOND COPY of writeStopFile() in
# src/stop-guard.mjs. The node reads files this script writes and vice versa, so the
# two MUST NOT DRIFT; tests/stop-file.test.mjs asserts they still agree.
#
#   powershell -ExecutionPolicy Bypass -File .\setup\stop-egpt.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup\stop-egpt.ps1 -EgptHome "$env:USERPROFILE\.egpt-secondary"

param(
  [string]$EgptHome = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string]$TaskName = '',
  [string]$Reason   = 'setup\stop-egpt.cmd (operator clicked the STOP button)'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'egpt-runners.ps1')

# --- 1. same profile -> task-name derivation the registrar uses ---
#     ~/.egpt -> egpt-daemon, ~/.egpt-secondary -> egpt-secondary-daemon (setup/register-session1-daemon-task.ps1).
$base = (Split-Path $EgptHome -Leaf) -replace '^\.', ''   # ".egpt-secondary" -> "egpt-secondary"
if (-not $TaskName) {
  # THROW, never fall back to 'egpt' (2026-09-11): an empty leaf means EgptHome arrived
  # empty or mangled, and silently resolving that to the PRIMARY node is how a stop aimed
  # at one node lands on another.
  if (-not $base) { throw "cannot derive a task name: -EgptHome is empty or has no leaf ('$EgptHome'). Pass -TaskName explicitly." }
  $TaskName = "$base-daemon"
}
$ServiceName = $TaskName   # the Session 0 service shares the task's name

Write-Host ""
Write-Host "Stopping egpt:" -ForegroundColor Cyan
Write-Host "  profile : $EgptHome   (EGPT_HOME)"
Write-Host "  task    : $TaskName"
Write-Host "  service : $ServiceName"
Write-Host ""

# --- 2. the kill-switch FILE (first - see the header) ---
$stopFile = Join-Path $EgptHome 'STOP'
if (-not (Test-Path $EgptHome)) {
  Write-Host "WARNING: profile folder $EgptHome does not exist - is that the right EGPT_HOME?" -ForegroundColor Yellow
  Write-Host "         Creating it so the STOP file lands somewhere; re-run with -EgptHome <path> if this is wrong." -ForegroundColor Yellow
  New-Item -ItemType Directory -Path $EgptHome -Force | Out-Null
}
if (Test-Path $stopFile) {
  Write-Host "STOP file already present - left exactly as it is: $stopFile" -ForegroundColor DarkGray
} else {
  # === MIRROR OF writeStopFile() in src/stop-guard.mjs - keep byte-compatible ======
  $when  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  # NOT "$env:USERDOMAIN\$env:USERNAME": USERDOMAIN is WORKGROUP on a workgroup machine and over
  # ssh, so this named WORKGROUP\an rather than the real account. WindowsIdentity is authoritative.
  $who   = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $where = "$env:COMPUTERNAME / setup\stop-egpt.ps1"
  $lines = @(
    'egpt is STOPPED.',
    '',
    "reason: $Reason",
    "who:    $who",
    "where:  $where",
    "when:   $when",
    '',
    'This node refuses to start while this file exists, and a running node halts on its',
    "next tick. Delete this file to let egpt start again:  rm $stopFile",
    ''
  )
  [IO.File]::WriteAllText($stopFile, ($lines -join "`n"))
  # ================================================================================
  Write-Host "Wrote the kill switch: $stopFile" -ForegroundColor Green
}

# --- 3. stop the service ---
$serviceStopped = $true
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
  Write-Host "No $ServiceName service on this machine." -ForegroundColor DarkGray
} elseif ("$($svc.Status)" -eq 'Stopped') {
  Write-Host "Service $ServiceName is Stopped." -ForegroundColor DarkGray
} else {
  try { Stop-Service -Name $ServiceName -ErrorAction Stop; Write-Host "Stopped service $ServiceName." -ForegroundColor Green }
  catch {
    $serviceStopped = $false
    Write-Host "  Stop-Service said: $($_.Exception.Message)" -ForegroundColor DarkYellow
    Write-Host "  The STOP file still halts it: its spine exits on the next tick and the service stays down." -ForegroundColor DarkYellow
  }
}

# --- 4. stop the task ---
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "No scheduled task named '$TaskName' on this machine." -ForegroundColor Yellow
} elseif ("$($task.State)" -eq 'Running') {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop; Write-Host "Stopped task $TaskName." -ForegroundColor Green }
  catch { Write-Host "  Stop-ScheduledTask said: $($_.Exception.Message)" -ForegroundColor DarkYellow }
} else {
  Write-Host "Task $TaskName is $($task.State)." -ForegroundColor DarkGray
}

# --- 5. kill the daemon trees (and an orphan spine) ---
$targets = @(@('daemon-s1.pid', 'egpt-daemon.mjs'), @('spine.pid', 'egpt-spine.mjs'))
if (-not $serviceStopped) { $targets += , @('daemon-s0.pid', 'egpt-daemon.mjs') }
$killed = 0
foreach ($t in $targets) {
  $procId = Get-EgptLivePid $EgptHome $t[0] $t[1]
  if (-not $procId) { continue }
  & taskkill.exe /PID $procId /T /F | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "Killed $($t[1]) pid $procId and its tree." -ForegroundColor Green; $killed++ }
  else { Write-Host "taskkill /PID $procId /T /F exited $LASTEXITCODE - the STOP file still halts it on its next tick." -ForegroundColor Red }
}
if (-not $killed) { Write-Host "No live daemon or spine on this profile." -ForegroundColor DarkGray }

# --- 6. say what happened and how to undo it ---
Write-Host ""
Write-Host "=== egpt is stopped ===" -ForegroundColor Green
Write-Host "  kill switch : $stopFile"
Write-Host "  task        : $TaskName"
Write-Host "  service     : $ServiceName"
Write-Host ""
Write-Host "TO START IT AGAIN: double-click  setup\start-egpt.cmd" -ForegroundColor Cyan
Write-Host "  or by hand:  Remove-Item `"$stopFile`" ; Start-ScheduledTask -TaskName $TaskName ; Start-Service $ServiceName"
