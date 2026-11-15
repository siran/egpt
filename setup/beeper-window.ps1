# beeper-window.ps1 - open the operator's Beeper window on the profile a Session 0 service shares
# with it, and keep it open while the operator is logged in. Never both at once.
#
#   at logon (HKCU Run) and from the "Beeper (eGPT)" shortcut:
#     claim the profile -> [hold the spine] stop the service -> wait until its Beeper lets go of
#     the profile -> open the window -> [release the spine once the token answers]
#   then it watches, holding the claim. When Beeper EXITS (tray Quit, a crash, Beeper's own
#   update) - a hidden window still counts as open - it reopens it. After $Tries opens that never
#   come up it starts the service and tries the window again $RetryMin minutes later.
#   A logoff ends this process, which releases the claim; the reconciler task
#   (s0-identity-reconcile.ps1) starts the service then.
#   It never kills Beeper: if the service's Beeper does not let go, the window is not opened.
#   It reopens nothing while an update needs Beeper closed (Test-UpdateRunning); beeper-update.ps1
#   hands the window back to it.
#
# No service shares the profile (the baseline): it just opens Beeper.
#   beeper-window.cmd [-DryRun]
# ASCII ONLY: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI.
[CmdletBinding()]
param(
  [string] $ServiceName = 'egpt-beeper-primary',
  [string] $EgptHome = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string] $AppData = $env:APPDATA,
  [string] $LocalAppData = $env:LOCALAPPDATA,
  [int] $PollSec = 3,
  [int] $WaitSec = 60,
  [int] $Tries = 3,
  [int] $RetryMin = 10,
  [switch] $DryRun,
  [switch] $LoadFunctionsOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'beeper-desktop.ps1')

# What to do, from what is true now. 'show' surfaces a window another launcher already owns.
function Get-BeeperWindowPlan([bool] $Shared, [bool] $Claimed, [string] $ServiceState, [bool] $WindowUp) {
  if (-not $Shared) { return @('open') }
  if (-not $Claimed) { if ($WindowUp) { return @('show') } return @() }
  $p = @()
  if ($ServiceState -ne 'Stopped') { $p += 'stop-service', 'wait-release' }
  if (-not $WindowUp) { $p += 'open' }
  return $p + 'watch'
}

# Where the window opens: the profile this service shares with it (its --user-data-dir, needed
# unless it is the default profile), else the user's own default profile - never the service's own.
function Get-BeeperWindowOpen([bool] $Shared, [string] $AppParameters, [string] $AppData) {
  $p = if ($Shared) { Get-BeeperShareProfile $AppParameters $AppData } else { Get-BeeperDefaultProfile $AppData }
  return [ordered]@{ profile = $p; args = (Get-BeeperWindowArgs $p $AppData) }
}

# Polls in a row with no Beeper and no update in progress; two mean Beeper has exited.
function Get-BeeperWatchCount([bool] $BeeperUp, [bool] $UpdateRunning, [int] $Count) {
  if ($BeeperUp -or $UpdateRunning) { return 0 }
  return $Count + 1
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

# Reopens Beeper whenever it exits. Returns only after $Tries opens in a row never came up, once
# the service has the profile.
function Watch-BeeperWindow {
  $gone = 0; $opens = 0
  while ($true) {
    Start-Sleep -Seconds $PollSec
    $up = (Test-WindowUp) -or (Test-BeeperLockHeld $profileDir)
    if ($up) { $opens = 0 }
    $gone = Get-BeeperWatchCount $up (Test-UpdateRunning) $gone
    if ($gone -lt 2) { continue }
    if ($opens -ge $Tries) { break }
    Say $(if ($opens) { "Beeper did not come up - opening it again ($($opens + 1) of $Tries)" } else { 'Beeper exited - reopening it' })
    try { Open-Window } catch { Say "FAILED to open Beeper: $($_.Exception.Message)" }
    $opens++; $gone = 0
  }
  Say "FAILED: Beeper did not come up after $Tries tries - starting $ServiceName; the window is tried again in $RetryMin min"
  $held = Enter-EgptBeeperHold $EgptHome
  $claim.Dispose()
  try { Start-Service $ServiceName } catch { Say "FAILED to start ${ServiceName}: $($_.Exception.Message)" }
  Exit-EgptBeeperHold $EgptHome $held (Get-Token)
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
$connection = $ServiceName -replace '^egpt-beeper-', ''
$session = (Get-Process -Id $PID).SessionId

function Test-WindowUp {
  $mine = Get-CimInstance Win32_Process -Filter "Name='Beeper.exe' AND SessionId=$session"
  return @(Select-BeeperProfileProcesses $mine $profileDir).Count -gt 0
}
function Open-Window { if ($open.args) { Start-Process -FilePath $exe -ArgumentList $open.args } else { Start-Process -FilePath $exe } }

# The spine's Beeper bridges wait (calls held, no redial) while the profile changes hands.
$held = $false
function Get-Token { (Get-BeeperTokens -RepoRoot (Split-Path -Parent $PSScriptRoot) -EgptHome $EgptHome)[$connection] }

$claimPath = Get-BeeperClaimPath $profileDir
$claim = $null
if ($shared -and -not $DryRun) {
  for ($i = 0; $i -lt 10 -and -not $claim; $i++) { $claim = Open-BeeperClaim $claimPath; if (-not $claim) { Start-Sleep -Milliseconds 300 } }
}
$claimed = if ($DryRun) { $shared -and -not (Test-BeeperClaimHeld $claimPath) } else { [bool]$claim }
$serviceState = if ($shared) { [string](Get-Service $ServiceName).Status } else { '' }
$plan = Get-BeeperWindowPlan $shared $claimed $serviceState (Test-WindowUp)

if ($DryRun) {
  Say "-DryRun: shared=$shared service=$ServiceName ($serviceState) profile=$profileDir open: Beeper.exe $($open.args) plan: $(if ($plan) { $plan -join ' -> ' } else { 'nothing (another launcher owns the profile)' })"
  return
}
if (-not $shared) { Open-Window; return }
if (-not $claimed) {
  if ($plan -contains 'show') { Open-Window } else { Say 'another launcher is handing the profile over - nothing to do' }
  return
}

while ($true) {
  try {
    if ($plan -contains 'stop-service') {
      $held = Enter-EgptBeeperHold $EgptHome
      Say "stopping $ServiceName"
      Stop-Service $ServiceName
      (Get-Service $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds($WaitSec))
      $deadline = (Get-Date).AddSeconds($WaitSec)
      while ((Test-BeeperLockHeld $profileDir) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
      if (Test-BeeperLockHeld $profileDir) { throw "the service's Beeper still holds $profileDir after ${WaitSec}s - the window is not opened" }
      Start-Sleep -Seconds 2   # let its sqlite/leveldb handles close
    }
    if ($plan -contains 'open') { Say 'opening Beeper'; Open-Window }
    Exit-EgptBeeperHold $EgptHome $held (Get-Token)
  } catch {
    Say "FAILED: $($_.Exception.Message)"
    Exit-EgptBeeperHold $EgptHome $held $null
    $claim.Dispose()
    exit 1
  }

  Say 'watching: Beeper is reopened when it exits'
  Watch-BeeperWindow
  Start-Sleep -Seconds (60 * $RetryMin)
  $claim = Open-BeeperClaim $claimPath
  if (-not $claim) { Say 'another launcher has the profile now - nothing to do'; exit 0 }
  $held = $false
  $plan = Get-BeeperWindowPlan $true $true ([string](Get-Service $ServiceName).Status) (Test-WindowUp)
}
