# beeper-window.ps1 - the operator's Beeper window on the profile a Session 0 service shares with it.
# Never both at once. One pass; it never loops and never kills Beeper.
#
#   -Once   the Session 1 egpt daemon's pass (src\daemon-runtime.mjs, every few seconds; it holds
#           state\s1.claim): claim the profile -> [hold the spine] stop the service -> wait until its
#           Beeper lets go of the profile -> open the window -> [release the spine once the token
#           answers] -> let go of the claim. A window already open: nothing. So a window that exits
#           (tray Quit, a crash, Beeper's own update) is reopened by the next pass, and nothing is
#           reopened while an update needs Beeper closed (Test-UpdateRunning) or another launcher
#           holds the claim. The daemon ending (logoff) lets go of s1.claim; the Session 0 daemon
#           starts the service then.
#   (none)  the "Beeper (eGPT)" shortcut, and beeper-update.ps1's relaunch: while the Session 1 daemon
#           holds s1.claim it only surfaces an open window (the daemon opens it); with no such daemon,
#           the same handover once.
#
# No service shares the profile (the baseline): the shortcut just opens Beeper; -Once does nothing.
#   beeper-window.cmd [-DryRun]
# ASCII ONLY: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI.
[CmdletBinding()]
param(
  [string] $ServiceName = 'egpt-beeper-primary',
  [string] $EgptHome = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string] $AppData = $env:APPDATA,
  [string] $LocalAppData = $env:LOCALAPPDATA,
  [int] $WaitSec = 60,
  [switch] $Once,
  [switch] $DryRun,
  [switch] $LoadFunctionsOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'egpt-runners.ps1')

# What to do, from what is true now. 'show' surfaces a window another launcher already owns.
function Get-BeeperWindowPlan([bool] $Shared, [bool] $Claimed, [string] $ServiceState, [bool] $WindowUp, [bool] $Updating = $false) {
  if ($Updating) { return @() }
  if (-not $Shared) { return @('open') }
  if (-not $Claimed) { if ($WindowUp) { return @('show') } return @() }
  $p = @()
  if ($ServiceState -ne 'Stopped') { $p += 'stop-service', 'wait-release' }
  if (-not $WindowUp) { if (-not $p) { $p += 'wait-release' }; $p += 'open' }
  return $p
}

# Where the window opens: the profile this service shares with it (its --user-data-dir, needed
# unless it is the default profile), else the user's own default profile - never the service's own.
function Get-BeeperWindowOpen([bool] $Shared, [string] $AppParameters, [string] $AppData) {
  $p = if ($Shared) { Get-BeeperShareProfile $AppParameters $AppData } else { Get-BeeperDefaultProfile $AppData }
  return [ordered]@{ profile = $p; args = (Get-BeeperWindowArgs $p $AppData) }
}

# Beeper must stay closed: beeper-update.ps1 holds its lock (until it hands the window back),
# Beeper's own installer runs, or /update beeper is between its two runs (its log, written within a
# minute, ends with the close-app run's "quit":true).
function Test-UpdateRunning {
  if (Test-BeeperClaimHeld (Get-BeeperUpdateLockPath $LocalAppData)) { return $true }
  $log = Join-Path $EgptHome 'config\logs\beeper-update.log'
  if ((Test-Path -LiteralPath $log) -and ((Get-Date) - (Get-Item -LiteralPath $log).LastWriteTime).TotalSeconds -lt 60 -and
      [string](Get-Content -LiteralPath $log -Tail 1) -match '"quit":true') { return $true }
  $updater = Join-Path $LocalAppData 'beepertexts-updater'
  return @(Get-CimInstance Win32_Process -Filter "SessionId=$session" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($updater, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
}

# One pass. 0, or 1 when the handover failed.
function Invoke-BeeperWindow {
  if ($Once -and -not $shared) { return 0 }
  $daemonOwns = -not $Once -and (Test-BeeperClaimHeld (Get-EgptS1ClaimPath $EgptHome))
  $claim = $null
  if ($shared -and -not $daemonOwns -and -not $DryRun) {
    for ($i = 0; $i -lt 10 -and -not $claim; $i++) { $claim = Open-BeeperClaim $claimPath; if (-not $claim) { Start-Sleep -Milliseconds 300 } }
  }
  $held = $false
  try {
    $claimed = if ($DryRun) { $shared -and -not $daemonOwns -and -not (Test-BeeperClaimHeld $claimPath) } else { [bool]$claim }
    $serviceState = if ($shared) { [string](Get-Service $ServiceName).Status } else { '' }
    $plan = Get-BeeperWindowPlan $shared $claimed $serviceState (Test-WindowUp) (Test-UpdateRunning)

    if ($DryRun) {
      Say "-DryRun: shared=$shared once=$Once daemon=$daemonOwns service=$ServiceName ($serviceState) profile=$profileDir open: Beeper.exe $($open.args) plan: $(if ($plan) { $plan -join ' -> ' } else { 'nothing' })"
      return 0
    }
    if (-not $shared -or -not $claimed) {
      if ($Once) { return 0 }
      if ($plan -contains 'open' -or $plan -contains 'show') { Open-Window }
      elseif ($daemonOwns) { Say 'the egpt daemon opens the window - nothing to do' }
      return 0
    }
    if ($plan -contains 'stop-service') {
      $held = Enter-EgptBeeperHold $EgptHome
      Say "stopping $ServiceName"
      Stop-Service $ServiceName
      (Get-Service $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds($WaitSec))
    }
    if ($plan -contains 'wait-release') {
      $deadline = (Get-Date).AddSeconds($WaitSec)
      while ((Test-BeeperLockHeld $profileDir) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
      if (Test-BeeperLockHeld $profileDir) { throw "a Beeper still holds $profileDir after ${WaitSec}s - the window is not opened" }
      if ($plan -contains 'stop-service') { Start-Sleep -Seconds 2 }   # let its sqlite/leveldb handles close
    }
    if ($plan -contains 'open') { Say 'opening Beeper'; Open-Window }
    if ($held) { Exit-EgptBeeperHold $EgptHome $held (Get-Token) }
    return 0
  } catch {
    Say "FAILED: $($_.Exception.Message)"
    Exit-EgptBeeperHold $EgptHome $held $null
    return 1
  } finally {
    if ($claim) { $claim.Dispose() }
  }
}

if ($LoadFunctionsOnly) { return }

$logFile = Join-Path $EgptHome 'config\logs\beeper-window.log'
function Say($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Write-Host "[beeper-window] $m"
  try { Add-Content -Path $logFile -Value $line -Encoding utf8 } catch { }
}

$par = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters" -ErrorAction SilentlyContinue
$exe = if ($par.Application) { [string]$par.Application } else { Join-Path $LocalAppData 'Programs\BeeperTexts\Beeper.exe' }
$shared = [bool]$par -and (Test-BeeperSharedProfile ([string]$par.AppParameters) $AppData (Get-BeeperPreStartHook $ServiceName))
$open = Get-BeeperWindowOpen $shared ([string]$par.AppParameters) $AppData
$profileDir = $open.profile
$claimPath = Get-BeeperClaimPath $profileDir
$connection = $ServiceName -replace '^egpt-beeper-', ''
$session = (Get-Process -Id $PID).SessionId

function Test-WindowUp {
  $mine = Get-CimInstance Win32_Process -Filter "Name='Beeper.exe' AND SessionId=$session"
  return @(Select-BeeperProfileProcesses $mine $profileDir).Count -gt 0
}
function Open-Window { if ($open.args) { Start-Process -FilePath $exe -ArgumentList $open.args } else { Start-Process -FilePath $exe } }
# The spine's Beeper bridges wait (calls held, no redial) while the profile changes hands.
function Get-Token { (Get-BeeperTokens -RepoRoot (Split-Path -Parent $PSScriptRoot) -EgptHome $EgptHome)[$connection] }

exit (Invoke-BeeperWindow)
