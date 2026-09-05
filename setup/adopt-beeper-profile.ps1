# adopt-beeper-profile.ps1 - point a Session 0 Beeper service at a profile copied from elsewhere.
#
# WHY THIS EXISTS. Beeper's desktop app (v4) offers NO way to verify a new device from an existing
# one: the verified device's Settings > Devices page has only Logout buttons, and the unverified
# device offers only a recovery key. So a fresh install of a second account can be permanently
# stuck behind the Verify wall with no path forward except the destructive recovery reset, which
# disconnects every bridged account and destroys history.
#
# A Beeper install's identity lives entirely in its user-data-dir. Copying an ALREADY-VERIFIED
# profile onto another machine therefore MOVES that device rather than enrolling a new one - no
# login, no verification, nothing for the missing UI to do.
#
# THE RULE THAT MAKES IT SAFE: ONE DEVICE, ONE RUNNING INSTANCE. Two copies of the same profile
# live at once are two clients claiming one device id, which is how key state gets confused. Stop
# the source service and leave it stopped (or set it Manual) before starting the destination.
#
# Everything is reversible: the destination's existing profile is renamed, never deleted, and the
# source is expected to have been backed up before staging.
#
#   .\adopt-beeper-profile.ps1 -ServiceName <svc> -From <staged dir> [-WhatIf]
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $ServiceName,
  [Parameter(Mandatory = $true)][string] $From,
  [switch] $WhatIf,
  [switch] $Pause
)
$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "must run elevated (service control + a SYSTEM-owned profile dir)"
}
function Say($m) { Write-Host "[adopt] $m" }

if (-not (Test-Path $From)) { throw "source not found: $From" }
$svc = Get-Service $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) { throw "no such service: $ServiceName" }

# The destination is whatever the service's own --user-data-dir says. Read it rather than take it
# as a parameter: a mismatch here would leave the service running its OLD profile while the new
# one sat unused on disk, which looks like "the copy did nothing".
$par = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
if ($par.AppParameters -notmatch '--user-data-dir="?([^"]+?)"?(\s|$)') {
  throw "$ServiceName has no --user-data-dir; it uses the account's default profile and this script will not guess at it"
}
$dest = $matches[1]
Say "service : $ServiceName ($($svc.Status))"
Say "source  : $From"
Say "dest    : $dest"
if ($WhatIf) { Say "-WhatIf: would stop the service, rename dest aside, copy, and restart"; return }

if ($svc.Status -eq 'Running') {
  Say "stopping $ServiceName"
  Stop-Service $ServiceName -Force
  (Get-Service $ServiceName).WaitForStatus('Stopped', '00:01:00')
  Start-Sleep -Seconds 2   # let the profile's sqlite/leveldb handles close before anything moves
}

if (Test-Path $dest) {
  $aside = "$dest.replaced-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Move-Item $dest $aside
  Say "existing profile kept at: $aside"
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$null = robocopy $From $dest /E /R:1 /W:1 /NFL /NDL /NJH /NJS
$mb = (Get-ChildItem $dest -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB
Say ("copied: {0:N0} MB, {1} files" -f $mb, (Get-ChildItem $dest -Recurse -File).Count)

Say "starting $ServiceName"
Start-Service $ServiceName
(Get-Service $ServiceName).WaitForStatus('Running', '00:01:00')
Say "done. Check whether it is past the Verify wall before trusting it:"
Say "  node src/tools/beeper-whoami.mjs"
if ($Pause) { Write-Host ''; Read-Host 'Press Enter to close' | Out-Null }
