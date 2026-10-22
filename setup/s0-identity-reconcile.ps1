# s0-identity-reconcile.ps1 - the Session 0 backstop, from the egpt-s0-identity task (as the desktop
# user, S4U, every 2 min and at boot). Two independent parts; one failing never skips the other:
#   - a Beeper profile shared by the operator's window and a Session 0 service (beeper-desktop.ps1,
#     "one profile, two runtimes"): start the service when it is stopped and Session 1 neither
#     claims nor runs the profile. Stopping is setup\beeper-window.ps1's job, which then opens the window.
#   - the egpt-daemon service (setup\install-nssm-service.ps1): start it when it is Stopped and
#     Automatic, with no STOP file and no older Session 1 daemon (Get-EgptServiceStartVerdict).
# Neither is ever stopped here.
#
#   (no switch)  one pass
#   -PreStart    the Beeper service's NSSM Start/Pre hook, the Beeper part only: exit 99 (NSSM aborts
#                the start and leaves the service Stopped) while Session 1 claims or runs the profile.
#                Any error exits 99 too: never both instances.
#   -WhatIf      say what the pass would do.
#
# A Beeper service that does not share the window's profile (Test-BeeperSharedProfile: the window's
# default profile, or its own --user-data-dir behind the Start/Pre hook) is left to NSSM.
# Runs as the desktop user from the task (S4U, register-s0-identity-task.ps1) and under the Beeper
# service's own account as the NSSM hook; it needs no elevation of its own.
# ASCII ONLY: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI.
[CmdletBinding()]
param(
  [string] $ServiceName = $(if ($env:NSSM_SERVICE_NAME) { $env:NSSM_SERVICE_NAME } else { 'egpt-beeper-primary' }),
  [string] $EgptHome = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string] $DaemonService = 'egpt-daemon',
  [string] $LogPath,
  [switch] $PreStart,
  [switch] $WhatIf,
  [switch] $LoadFunctionsOnly
)
$ErrorActionPreference = 'Stop'

function Say($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Write-Host $line
  if ($LogPath) { try { Add-Content -Path $LogPath -Value $line -Encoding utf8 } catch { } }
}

# The shared Beeper profile. -PreStart: the exit code for NSSM; otherwise 0.
function Invoke-BeeperPart {
  $par = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
  $udd = Get-BeeperUserDataDir ([string]$par.AppParameters)
  if ($PreStart) {
    if (-not $udd) { return 0 }
  } elseif (-not (Test-BeeperSharedProfile ([string]$par.AppParameters) $env:APPDATA (Get-BeeperPreStartHook $ServiceName))) {
    Write-Host "$ServiceName does not share the window's profile: left to NSSM"   # console only: every 2 min
    return 0
  }
  $claimed = Test-BeeperClaimHeld (Get-BeeperClaimPath $udd)
  $inUse = Test-BeeperProfileInUse $udd (Get-CimInstance Win32_Process -Filter "Name='Beeper.exe'")

  if ($PreStart) {
    $code = Get-BeeperPreStartCode $claimed $inUse
    if ($code) { Say "PreStart: refused $ServiceName (claimed=$claimed, in use=$inUse) - the window owns $udd" }
    return $code
  }

  $state = [string](Get-Service $ServiceName).Status
  if ((Get-BeeperReconcileAction $state $claimed $inUse) -ne 'start') { return 0 }
  Say "$ServiceName is $state and nothing in Session 1 owns $udd - starting it"
  if (-not $WhatIf) { Start-Service $ServiceName }
  return 0
}

# The egpt-daemon service. Quiet unless it starts it: the pass runs every 2 min.
function Invoke-EgptDaemonPart {
  $go = Get-EgptServiceStartVerdict (Read-EgptServiceFacts $DaemonService $EgptHome) -AutoOnly
  if (-not $go.start) { return }
  Say "$DaemonService is Stopped and Automatic, with no STOP file in $EgptHome - starting it ($($go.reason))"
  if (-not $WhatIf) { Start-Service $DaemonService }
}

# One pass: each part on its own. The number of parts that failed.
function Invoke-ReconcilePass {
  $failed = 0
  try { $null = Invoke-BeeperPart } catch { Say "FAILED ($ServiceName): $($_.Exception.Message)"; $failed++ }
  try { $null = Invoke-EgptDaemonPart } catch { Say "FAILED ($DaemonService): $($_.Exception.Message)"; $failed++ }
  return $failed
}

if ($LoadFunctionsOnly) { return }

if ($PreStart) {
  try {
    . (Join-Path $PSScriptRoot 'beeper-desktop.ps1')
    exit (Invoke-BeeperPart)
  } catch {
    Say "FAILED: $($_.Exception.Message)"
    exit 99
  }
}

try { . (Join-Path $PSScriptRoot 'egpt-runners.ps1') } catch { Say "FAILED: $($_.Exception.Message)"; exit 1 }
if (Invoke-ReconcilePass) { exit 1 }
