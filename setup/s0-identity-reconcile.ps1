# s0-identity-reconcile.ps1 - the Beeper services' pass of the Session 0 egpt daemon (-BeeperOnly,
# src\daemon-runtime.mjs), and the Session 0 backstop from the egpt-s0-identity task (as the desktop
# user, S4U, every 2 min and at boot). Independent parts; one failing never skips another:
#   - each Beeper service in -BeeperServices (the task: only while no Session 0 daemon is live;
#     nobody: while beeper-update.ps1 holds its lock):
#     - a profile shared by the operator's window and the service (beeper-desktop.ps1, "one profile,
#       two runtimes"): start the service when it is stopped, Session 1 neither claims nor runs the
#       profile, and no Session 1 egpt daemon holds state\s1.claim (while one does, the window is
#       its to reopen: setup\beeper-window.ps1 -Once). Stopping is beeper-window.ps1's job.
#     - a profile of its own (the secondary, the mouth): start it when it is Stopped and Automatic.
#   - the egpt-daemon service (setup\install-nssm-service.ps1; the task only): start it when it is
#     Stopped and Automatic, with no STOP file and no older Session 1 daemon (Get-EgptServiceStartVerdict).
# Nothing is ever stopped here.
#
#   (no switch)  the task's pass
#   -BeeperOnly  the Session 0 daemon's pass
#   -PreStart   the Beeper service's NSSM Start/Pre hook, the Beeper part only: exit 99 (NSSM aborts
#                the start and leaves the service Stopped) while Session 1 claims or runs the profile.
#                Any error exits 99 too: never both instances.
#   -WhatIf      say what the pass would do.
#
# Runs as the desktop user from the task (S4U, register-s0-identity-task.ps1) and under the Beeper
# service's own account as the NSSM hook; it needs no elevation of its own.
# ASCII ONLY: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI.
[CmdletBinding()]
param(
  [string] $ServiceName = $(if ($env:NSSM_SERVICE_NAME) { $env:NSSM_SERVICE_NAME } else { 'egpt-beeper-primary' }),
  [string] $EgptHome = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string[]] $BeeperServices = @('egpt-beeper-primary', 'egpt-beeper-secondary'),
  [string] $DaemonService = 'egpt-daemon',
  [string] $LogPath,
  [switch] $PreStart,
  [switch] $BeeperOnly,
  [switch] $WhatIf,
  [switch] $LoadFunctionsOnly
)
$ErrorActionPreference = 'Stop'

function Say($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Write-Host $line
  if ($LogPath) { try { Add-Content -Path $LogPath -Value $line -Encoding utf8 } catch { } }
}

# One Beeper service. -PreStart: the exit code for NSSM; otherwise 0.
function Invoke-BeeperPart([string] $Name = $ServiceName) {
  $par = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
  $udd = Get-BeeperUserDataDir ([string]$par.AppParameters)
  if ($PreStart) {
    if (-not $udd) { return 0 }
  } elseif (-not (Test-BeeperSharedProfile ([string]$par.AppParameters) $env:APPDATA (Get-BeeperPreStartHook $Name))) {
    $svc = Get-Service $Name
    if ([string]$svc.Status -eq 'Stopped' -and [string]$svc.StartType -eq 'Automatic') {
      Say "$Name is Stopped and Automatic - starting it"
      if (-not $WhatIf) { Start-Service $Name }
    }
    return 0
  }
  $claimed = Test-BeeperClaimHeld (Get-BeeperClaimPath $udd)
  $inUse = Test-BeeperProfileInUse $udd (Get-CimInstance Win32_Process -Filter "Name='Beeper.exe'")

  if ($PreStart) {
    $code = Get-BeeperPreStartCode $claimed $inUse
    if ($code) { Say "PreStart: refused $Name (claimed=$claimed, in use=$inUse) - the window owns $udd" }
    return $code
  }

  $state = [string](Get-Service $Name).Status
  if ((Get-BeeperReconcileAction $state $claimed $inUse) -ne 'start') { return 0 }
  if (Test-BeeperClaimHeld (Get-EgptS1ClaimPath $EgptHome)) {
    Say "$Name is $state and nothing in Session 1 owns $udd, but the Session 1 egpt daemon is live - not started: its next pass reopens the window"
    return 0
  }
  Say "$Name is $state and nothing in Session 1 owns $udd - starting it"
  if (-not $WhatIf) { Start-Service $Name }
  return 0
}

# Every installed Beeper service, each on its own; none while an update needs Beeper closed.
# The number that failed.
function Invoke-BeeperServicesPart {
  if (Test-BeeperClaimHeld (Get-BeeperUpdateLockPath $env:LOCALAPPDATA)) { return 0 }
  $failed = 0
  foreach ($s in @(Get-Service -Name $BeeperServices -ErrorAction SilentlyContinue)) {
    try { $null = Invoke-BeeperPart $s.Name } catch { Say "FAILED ($($s.Name)): $($_.Exception.Message)"; $failed++ }
  }
  return $failed
}

# The egpt-daemon service. Quiet unless it starts it: the pass runs every 2 min.
function Invoke-EgptDaemonPart {
  $go = Get-EgptServiceStartVerdict (Read-EgptServiceFacts $DaemonService $EgptHome) -AutoOnly
  if (-not $go.start) { return }
  Say "$DaemonService is Stopped and Automatic, with no STOP file in $EgptHome - starting it ($($go.reason))"
  if (-not $WhatIf) { Start-Service $DaemonService }
}

# One pass: each part on its own. The number that failed.
function Invoke-ReconcilePass {
  $failed = 0
  if ($BeeperOnly -or -not (Get-EgptLivePid $EgptHome 'daemon-s0.pid' 'egpt-daemon.mjs')) { $failed += Invoke-BeeperServicesPart }
  if ($BeeperOnly) { return $failed }
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
# The primary's profile, for the daemon's 1 s lockfile probe between passes.
if ($BeeperOnly) {
  $primary = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\egpt-beeper-primary\Parameters' -ErrorAction SilentlyContinue
  if ($primary) { Write-Host "profile=$(Get-BeeperShareProfile ([string]$primary.AppParameters))" }
}
if (Invoke-ReconcilePass) { exit 1 }
