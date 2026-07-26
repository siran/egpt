# stop-egpt.ps1 - THE STOP BUTTON: take this node down, and keep it down.
#
# Normally you do not run this by hand - double-click setup\stop-egpt.cmd, which
# auto-elevates (stopping a service needs admin) and runs this.
#
# TWO actions, in THIS order:
#   1. write  EGPT_HOME\STOP  - the kill-switch FILE (src/stop-guard.mjs). While it
#      exists boot REFUSES to start and a RUNNING spine halts on its next tick, so
#      the node stays down even if the service is restarted or the machine reboots.
#   2. stop the NSSM service  - so nothing is running right now either.
# The FILE comes first on purpose: if the service respawns while we are stopping it,
# the file is already there and the fresh spine refuses to start. Stopping the
# service alone would only last until the next boot.
#
# UNDO: double-click setup\start-egpt.cmd (deletes the file, starts the service), or
# by hand:  Remove-Item <EGPT_HOME>\STOP ; Start-Service <service>
#
# Idempotent: an existing STOP file is left exactly as it is (whoever stopped the
# node first owns the explanation) and an already-stopped service is left alone.
#
# WARNING - THE FILE FORMAT BELOW IS A SECOND COPY of writeStopFile() in
# src/stop-guard.mjs. The node reads files this script writes and vice versa, so the
# two MUST NOT DRIFT; tests/stop-file.test.mjs asserts they still agree.
#
# Run from an ELEVATED PowerShell if you prefer the command line:
#   powershell -ExecutionPolicy Bypass -File .\setup\stop-egpt.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup\stop-egpt.ps1 -EgptHome "$env:USERPROFILE\.egpt2"

param(
  [string]$EgptHome    = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string]$ServiceName = '',
  [string]$Reason      = 'setup\stop-egpt.cmd (operator clicked the STOP button)'
)

$ErrorActionPreference = 'Stop'

# --- 1. ensure elevated (the .cmd wrapper already does this; this is the belt) ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This script must be run from an ELEVATED PowerShell (or double-click setup\stop-egpt.cmd)." -ForegroundColor Red
  exit 1
}

# --- 2. same profile -> service-name derivation the installer uses ---
#     ~/.egpt -> egpt-daemon, ~/.egpt2 -> egpt2-daemon (setup/install-nssm-service.ps1).
if (-not $ServiceName) {
  $base = (Split-Path $EgptHome -Leaf) -replace '^\.', ''   # ".egpt2" -> "egpt2"
  if (-not $base) { $base = 'egpt' }
  $ServiceName = "$base-daemon"
}

Write-Host ""
Write-Host "Stopping egpt:" -ForegroundColor Cyan
Write-Host "  profile : $EgptHome   (EGPT_HOME)"
Write-Host "  service : $ServiceName"
Write-Host ""

# --- 3. the kill-switch FILE (first - see the header) ---
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
  $who   = "$env:USERDOMAIN\$env:USERNAME"
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

# --- 4. stop the service ---
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
  Write-Host "No service named '$ServiceName' on this machine." -ForegroundColor Yellow
  $others = @(Get-Service | Where-Object { $_.Name -like '*egpt*' })
  if ($others.Count) {
    Write-Host ("  egpt services that DO exist: " + (($others | ForEach-Object { "$($_.Name) [$($_.Status)]" }) -join ', '))
    Write-Host "  Re-run with -ServiceName <name> (or -EgptHome <that node's profile>) to stop one of those."
  }
  Write-Host "  The STOP file is written regardless: a node on this profile halts on its next tick and refuses to restart."
} elseif ($svc.Status -eq 'Stopped') {
  Write-Host "$ServiceName was already stopped." -ForegroundColor DarkGray
} else {
  Write-Host "Stopping $ServiceName..." -ForegroundColor Yellow
  try { Stop-Service -Name $ServiceName -Force -ErrorAction Stop }
  catch { Write-Host "  Stop-Service said: $($_.Exception.Message)" -ForegroundColor DarkYellow }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt 20 -and (Get-Service $ServiceName).Status -ne 'Stopped') { Start-Sleep -Milliseconds 500 }
  $final = (Get-Service $ServiceName).Status
  if ($final -eq 'Stopped') {
    Write-Host "$ServiceName is Stopped." -ForegroundColor Green
  } else {
    # NSSM's graceful stop can hang while the bridge holds its WebSocket (see
    # setup/restart-egpt-service.ps1). Not fatal here: the STOP file is already on
    # disk, so whatever is still up halts on its next tick and cannot come back.
    Write-Host "$ServiceName is still '$final' after 20s - NSSM's graceful stop can hang on the bridge socket." -ForegroundColor Red
    Write-Host "  The STOP file is written, so the spine halts on its next tick and refuses to restart." -ForegroundColor Yellow
    Write-Host "  To clear the wrapper too:  taskkill /F /IM egpt-service.exe" -ForegroundColor Yellow
  }
}

# --- 5. say what happened and how to undo it ---
Write-Host ""
Write-Host "=== egpt is stopped ===" -ForegroundColor Green
Write-Host "  kill switch : $stopFile"
Write-Host "  service     : $ServiceName"
Write-Host ""
Write-Host "TO START IT AGAIN: double-click  setup\start-egpt.cmd" -ForegroundColor Cyan
Write-Host "  or by hand:  Remove-Item `"$stopFile`" ; Start-Service $ServiceName"
