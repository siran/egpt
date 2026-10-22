# beeper-window.ps1 - open the operator's Beeper window on the profile a Session 0 service shares
# with it, and give the profile back to the service when Beeper exits. Never both at once.
#
#   at logon (HKCU Run) and from the "Beeper (eGPT)" shortcut:
#     claim the profile -> [hold the spine] stop the service -> wait until its Beeper lets go of
#     the profile -> open the window -> [release the spine once the token answers]
#   then it waits. When Beeper EXITS (tray Quit, a crash) - a hidden window still counts as open -
#   it releases the claim and starts the service. A logoff ends this process, which releases the
#   claim; the reconciler task (s0-identity-reconcile.ps1) starts the service then.
#   It never kills Beeper: if the service's Beeper does not let go, the window is not opened.
#   It waits while beeper-update.ps1 or Beeper's own installer runs.
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
# beeper-update.ps1 (run by this user) or Beeper's installer from beepertexts-updater. Its log
# written within a minute counts too: /update beeper runs the tool twice (close the app, then the
# update), and the gap between the two must not hand the profile to the service.
function Test-UpdateRunning {
  $log = Join-Path $EgptHome 'config\logs\beeper-update.log'
  if ((Test-Path -LiteralPath $log) -and ((Get-Date) - (Get-Item -LiteralPath $log).LastWriteTime).TotalSeconds -lt 60) { return $true }
  $updater = Join-Path $LocalAppData 'beepertexts-updater'
  foreach ($p in Get-CimInstance Win32_Process -Filter "SessionId=$session") {
    if ($p.Name -eq 'powershell.exe' -and [string]$p.CommandLine -match 'beeper-update\.ps1') { return $true }
    if ($p.ExecutablePath -and $p.ExecutablePath.StartsWith($updater, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
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

Say 'watching: the profile goes back to the service when Beeper exits'
$count = 0
while ($count -lt 2) {
  Start-Sleep -Seconds $PollSec
  $count = Get-BeeperWatchCount ((Test-WindowUp) -or (Test-BeeperLockHeld $profileDir)) (Test-UpdateRunning) $count
}

Say "Beeper exited - starting $ServiceName"
$held = Enter-EgptBeeperHold $EgptHome
$claim.Dispose()
try { Start-Service $ServiceName } catch { Say "FAILED to start ${ServiceName}: $($_.Exception.Message) - the reconciler tries again" }
Exit-EgptBeeperHold $EgptHome $held (Get-Token)
