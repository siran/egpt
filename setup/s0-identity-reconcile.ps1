# s0-identity-reconcile.ps1 - the SYSTEM side of a Beeper profile shared by the operator's window
# and a Session 0 service (beeper-desktop.ps1, "one profile, two runtimes").
#
#   (no switch)  one pass, from the egpt-s0-identity task: start the service when it is stopped
#                and Session 1 neither claims nor runs the profile. It never stops anything:
#                stopping is setup\beeper-window.ps1's job, which then opens the window.
#   -PreStart    the service's NSSM Start/Pre hook: exit 99 (NSSM aborts the start and leaves the
#                service Stopped) while Session 1 claims or runs the profile. Any error exits 99
#                too: never both instances.
#   -WhatIf      say what the pass would do.
#
# A service with no --user-data-dir is not shared, and is left alone.
# Runs as SYSTEM (task, NSSM hook), so it needs no elevation of its own.
# ASCII ONLY: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI.
[CmdletBinding()]
param(
  [string] $ServiceName = $(if ($env:NSSM_SERVICE_NAME) { $env:NSSM_SERVICE_NAME } else { 'egpt-beeper-primary' }),
  [string] $LogPath,
  [switch] $PreStart,
  [switch] $WhatIf
)
$ErrorActionPreference = 'Stop'

function Say($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Write-Host $line
  if ($LogPath) { try { Add-Content -Path $LogPath -Value $line -Encoding utf8 } catch { } }
}

try {
  . (Join-Path $PSScriptRoot 'beeper-desktop.ps1')
  $par = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
  $udd = Get-BeeperUserDataDir ([string]$par.AppParameters)
  if (-not $udd) {
    if ($PreStart) { exit 0 }
    Say "$ServiceName has no --user-data-dir: not a shared profile, nothing to do"
    return
  }
  $claimed = Test-BeeperClaimHeld (Get-BeeperClaimPath $udd)
  $inUse = Test-BeeperProfileInUse $udd (Get-CimInstance Win32_Process -Filter "Name='Beeper.exe'")

  if ($PreStart) {
    $code = Get-BeeperPreStartCode $claimed $inUse
    if ($code) { Say "PreStart: refused $ServiceName (claimed=$claimed, in use=$inUse) - the window owns $udd" }
    exit $code
  }

  $state = [string](Get-Service $ServiceName).Status
  if ((Get-BeeperReconcileAction $state $claimed $inUse) -ne 'start') { return }
  Say "$ServiceName is $state and nothing in Session 1 owns $udd - starting it"
  if (-not $WhatIf) { Start-Service $ServiceName }
} catch {
  Say "FAILED: $($_.Exception.Message)"
  if ($PreStart) { exit 99 }
  throw
}
