# beeper-update.ps1 - install Beeper's pending update on a node that runs TWO Beeper Desktops.
#
# THE PROBLEM THIS SOLVES (operator 2026-09-03: "when updating beeper i need to close both s0
# and s1, but i am having problems"). Beeper is a PER-USER electron-builder install: one binary
# tree under %LOCALAPPDATA%\Programs\BeeperTexts, shared by the SESSION 0 service Desktop and
# the SESSION 1 GUI. electron-updater downloads the new installer into its pending cache and
# then waits for a quit that never comes: the service Desktop is restarted by NSSM within
# seconds, and the installer cannot overwrite a tree either process still holds. So the update
# sits there, downloaded, forever. Closing them by hand is the part that keeps failing, because
# NSSM RESTARTS the S0 Desktop the moment it is killed - the service has to be STOPPED, not the
# process killed.
#
# ORDER IS LOAD-BEARING AT THE END. Beeper takes the NEXT FREE port from 23373, so whichever
# Desktop starts first gets 23373 - and config.yaml pins the spine to a port. Start the SERVICE
# first, wait for it to bind, and only then bring the GUI back; do it the other way round and
# the two Desktops swap ports, at which point the spine talks to the operator's GUI with no
# error at all. This script enforces that order and verifies the mapping afterwards.
#
#   .\beeper-update.cmd              install the pending update, if it is newer
#   .\beeper-update.cmd -WhatIf      say what it would do and stop
#   .\beeper-update.cmd -Force       reinstall even if the version is not newer
#   .\beeper-update.cmd -NoRelaunchGui   leave the Session 1 GUI closed
#
# ASCII ONLY, deliberately: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI, so a single
# em-dash in a comment is a parse error.
[CmdletBinding()]
param(
  [string] $Installer,
  [switch] $Force,
  [switch] $WhatIf,
  [switch] $NoRelaunchGui,
  [int]    $ServicePortTimeoutSec = 90
)

$ErrorActionPreference = 'Stop'

# --- self-elevate: stopping a service needs an admin token, the installer itself does not ----
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $argList = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [switch]) { if ($kv.Value.IsPresent) { $argList += "-$($kv.Key)" } }
    else { $argList += @("-$($kv.Key)", "`"$($kv.Value)`"") }
  }
  Write-Host "elevating..."
  Start-Process powershell -Verb RunAs -ArgumentList $argList
  return
}

function Say($m) { Write-Host "[beeper-update] $m" }

# --- where things are -------------------------------------------------------------------------
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\BeeperTexts'
$exe        = Join-Path $installDir 'Beeper.exe'
if (-not (Test-Path $exe)) { throw "no Beeper install at $installDir" }
$installed  = [version]((Get-Item $exe).VersionInfo.ProductVersion)
Say "installed: $installed"

$pendingDir = Join-Path $env:LOCALAPPDATA 'beepertexts-updater\pending'
if (-not $Installer) {
  $cand = Get-ChildItem $pendingDir -Filter '*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $cand) { Say "nothing pending in $pendingDir - open Beeper and let it download an update first"; return }
  $Installer = $cand.FullName
}
if (-not (Test-Path $Installer)) { throw "installer not found: $Installer" }
Say "pending:   $(Split-Path $Installer -Leaf)"

# electron-updater writes the expected sha512 (base64) beside the download. Verify it: a torn
# download is otherwise discovered only after both Desktops are already down.
$infoPath = Join-Path (Split-Path $Installer -Parent) 'update-info.json'
if (Test-Path $infoPath) {
  $info = Get-Content $infoPath -Raw | ConvertFrom-Json
  if ($info.sha512) {
    # Get-FileHash gives hex, electron-updater records base64. Converted with an explicit
    # byte[] and an index loop: the obvious `-split | ForEach-Object` pipeline yields Object[],
    # which ToBase64String refuses.
    $want  = $info.sha512
    $hex   = (Get-FileHash -Path $Installer -Algorithm SHA512).Hash
    $bytes = [byte[]]::new($hex.Length / 2)
    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
    $got = [Convert]::ToBase64String($bytes)
    if ($got -ne $want) { throw "sha512 mismatch on $Installer - delete the pending folder and let Beeper download again" }
    Say "sha512:    ok"
  }
}

# The version in the file name is what electron-builder puts there; treat a parse failure as
# "unknown" rather than guessing, and let -Force cover it.
$newVer = $null
if ((Split-Path $Installer -Leaf) -match '(\d+\.\d+\.\d+(\.\d+)?)') { $newVer = [version]$matches[1] }
if ($newVer) { Say "pending version: $newVer" }
if ($newVer -and $newVer -le $installed -and -not $Force) { Say "already at $installed - nothing to do (use -Force to reinstall)"; return }

# --- who is holding the tree -------------------------------------------------------------------
# The S0 Desktop is a service, found by its Application path rather than by a name, because the
# service is called BeeperAn on one node and BeeperRodz on the other.
$svc = Get-CimInstance Win32_Service | Where-Object {
  $_.PathName -match 'nssm' -and (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$($_.Name)\Parameters" -ErrorAction SilentlyContinue).Application -like '*BeeperTexts\Beeper.exe'
}
if ($svc -and $svc.Count -gt 1) { throw "more than one Beeper service found: $($svc.Name -join ', ') - pass one explicitly" }
$svcName  = if ($svc) { $svc.Name } else { $null }
$svcWasUp = $false
if ($svcName) {
  $svcWasUp = (Get-Service $svcName).Status -eq 'Running'
  Say "S0 service: $svcName ($(if($svcWasUp){'running'}else{'stopped'}))"
} else { Say "S0 service: none found" }

$gui = Get-CimInstance Win32_Process -Filter "Name='Beeper.exe'" | Where-Object { $_.SessionId -ne 0 }
$guiWasUp = [bool]$gui
Say "S1 GUI:     $(if($guiWasUp){"$($gui.Count) processes in session $($gui[0].SessionId)"}else{'not running'})"

if ($WhatIf) { Say "-WhatIf: would stop $svcName, close the GUI, run the installer silently, then bring both back"; return }

# --- bring both down ----------------------------------------------------------------------------
# STOP the service, never kill the process: NSSM's AppRestartDelay brings a killed Desktop back
# in 10s, right on top of the installer.
if ($svcName -and $svcWasUp) {
  Say "stopping $svcName"
  Stop-Service $svcName -Force
  (Get-Service $svcName).WaitForStatus('Stopped', '00:01:00')
}

# The GUI gets a real close first. Beeper writes a local database; SIGKILL on a syncing client
# is how a bridge comes back needing re-verification.
if ($guiWasUp) {
  Say "closing the Session 1 GUI"
  Get-Process Beeper -ErrorAction SilentlyContinue | ForEach-Object { $null = $_.CloseMainWindow() }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Process Beeper -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
}
# Whatever is left after that is a stray renderer or a Desktop with no window, and the installer
# cannot proceed around it.
$left = Get-Process Beeper -ErrorAction SilentlyContinue
if ($left) { Say "$($left.Count) Beeper processes still up after the graceful close - terminating"; $left | Stop-Process -Force; Start-Sleep -Seconds 2 }

# --- install ------------------------------------------------------------------------------------
# /S is NSIS silent. --updated is electron-updater's own flag, telling the installer it is an
# update rather than a first install. No --force-run: the relaunch below is ordered on purpose.
Say "running the installer (silent)"
$p = Start-Process -FilePath $Installer -ArgumentList '/S','--updated' -PassThru -Wait
Say "installer exit code: $($p.ExitCode)"
if ($p.ExitCode -ne 0) { Say "WARNING: non-zero exit - check the version below before trusting it" }

$now = [version]((Get-Item $exe).VersionInfo.ProductVersion)
Say "installed now: $now"

# --- bring both back, SERVICE FIRST --------------------------------------------------------------
if ($svcName -and $svcWasUp) {
  Say "starting $svcName"
  Start-Service $svcName
  # Wait for it to actually BIND before the GUI can race it for 23373. A Desktop takes a while
  # to come up in Session 0, and this wait is the whole reason the port mapping survives.
  $deadline = (Get-Date).AddSeconds($ServicePortTimeoutSec)
  $bound = $null
  while (-not $bound -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $bound = Get-NetTCPConnection -State Listen -LocalPort 23373 -ErrorAction SilentlyContinue |
             Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").SessionId -eq 0 }
  }
  if ($bound) { Say "S0 Desktop is listening on 23373" }
  else { Say "WARNING: S0 Desktop did not bind 23373 within ${ServicePortTimeoutSec}s - do NOT start the GUI until it does, or they will swap ports" }
}

if ($guiWasUp -and -not $NoRelaunchGui) {
  # Launched through explorer.exe so it runs as the SHELL user at medium integrity. Starting it
  # from this elevated process would hand the GUI an admin token it must not have.
  Say "relaunching the Session 1 GUI"
  Start-Process explorer.exe -ArgumentList "`"$exe`""
}

Say "done. verify with:  node src/tools/beeper-whoami.mjs"
