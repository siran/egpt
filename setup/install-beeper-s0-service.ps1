# install-beeper-s0-service.ps1 - run a Beeper Desktop as a SESSION 0 Windows service.
#
# Session 0 isolation removed the ability to SEE a service's windows. It never removed the
# ability to RUN there: Session 0 has a window station, a desktop, a working window manager and
# a virtual display, so a Beeper Desktop nobody can see still syncs and still serves its local
# API. That is what makes the agents answer in the operator's groups with nobody logged in.
#
# NO CDP (closed 2026-10-11): --remote-debugging-port on loopback has no auth, so every local
# account - every boxed being - could drive this account. Nothing in eGPT uses it.
#
# This installs ONE such Desktop. A node can host SEVERAL: they are the same binaries with
# DIFFERENT --user-data-dir values, which is what makes them separate INSTALLS - separate
# logins, separate tokens, separate ports: one for the PRIMARY account (the operator's own) and
# one for the SECONDARY (the account the agents wear).
#
# THE NAME SAYS WHAT THE PROCESS IS: `egpt-beeper-primary` / `egpt-beeper-secondary`. A name
# that omits `beeper` reads like an eGPT spine sitting beside `egpt-daemon`, and this is not one
# - stopping it does not stop a spine, it takes a WhatsApp account offline. setup\beeper-s0-
# naming.ps1 owns the names and the one-line labels. An install still sitting under one of the
# retired names is a RENAME, and this script refuses and says so rather than building a second
# Desktop beside it.
#
# Run ELEVATED, from the repo root:
#   .\setup\install-beeper-s0-service.ps1 -ServiceName egpt-beeper-secondary `
#       -UserDataDir $env:USERPROFILE\.egpt\state\beeper-secondary\userdata
#   add -RunAsUser to log it on as you instead of LocalSystem (beeper-services-run-as-user.ps1)
#
# A FRESH install has no login and no window to log in through. Log the account in (and mint its
# token, src/tools/beeper-mint-token.mjs) on a Session 1 Beeper started with its own
# --user-data-dir, quit it, then hand that profile over:
#   .\setup\adopt-beeper-profile.ps1 -ServiceName egpt-beeper-secondary -From <that dir>
#
# The user who runs this (carried through UAC as -GrantSid) is granted start/stop on THIS service
# (setup\beeper-desktop.ps1), so eGPT can update Beeper later without administrator.
#
# Remove:  nssm remove <ServiceName> confirm
#
# ASCII ONLY: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI, so one em-dash is a
# parse error.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $ServiceName,
  [Parameter(Mandatory = $true)][string] $UserDataDir,
  [string] $BeeperExe = (Join-Path $env:LOCALAPPDATA 'Programs\BeeperTexts\Beeper.exe'),
  [string] $LogDir   = (Join-Path $env:USERPROFILE 'bin\beeper-s0-logs'),
  # AUTO for the Desktop that must be up BEFORE anyone logs in.
  [ValidateSet('auto','manual','disabled')][string] $StartMode = 'auto',
  # The eGPT user, granted start/stop on this service: whoever ran this, before any UAC prompt.
  [string] $GrantSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
  # Log on as that same user instead of LocalSystem (asks the password in a dialog; never stored).
  [switch] $RunAsUser,
  [switch] $Start,
  [switch] $Pause
)

$ErrorActionPreference = 'Stop'

# The names and the one-line labels live in ONE file, shared with rename-beeper-s0-service.ps1.
. (Join-Path $PSScriptRoot 'beeper-s0-naming.ps1')
. (Join-Path $PSScriptRoot 'beeper-desktop.ps1')

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [switch]) { if ($kv.Value.IsPresent) { $a += "-$($kv.Key)" } }
    else { $a += @("-$($kv.Key)", "`"$($kv.Value)`"") }
  }
  if (-not $PSBoundParameters.ContainsKey('GrantSid')) { $a += @('-GrantSid', $GrantSid) }
  Write-Host "elevating..."
  Start-Process powershell -Verb RunAs -ArgumentList $a
  return
}

function Say($m) { Write-Host "[beeper-s0] $m" }

if (-not (Test-Path $BeeperExe)) { throw "no Beeper at $BeeperExe" }
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { $nssm = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\nssm.exe' }
if (-not (Test-Path $nssm)) { throw "nssm not found - winget install nssm" }

if (Get-Service $ServiceName -ErrorAction SilentlyContinue) { throw "service $ServiceName already exists - remove it first: nssm remove $ServiceName confirm" }

# AN OLD-NAMED INSTALL IS A RENAME, AND THIS SCRIPT WILL NOT DO IT.
#
# It deliberately does not migrate, for two reasons. First, it is not idempotent by design (the
# throw above): installing beside a live Desktop would leave two services fighting for the same
# user-data-dir and the same account. Second, THIS SCRIPT ONLY KNOWS THE
# PARAMETERS IT SETS - the services on this node were created by hand, so anything hand-set on
# them would be silently dropped by a reinstall from these defaults. setup\rename-beeper-s0-
# service.ps1 exists for exactly this, carries the old service's whole configuration across, and
# says plainly that the Desktop is DOWN in between so the idle one goes first.
$legacyMap = Get-BeeperS0LegacyNameMap
foreach ($oldName in $legacyMap.Keys) {
  if ($legacyMap[$oldName] -ne $ServiceName) { continue }
  if (-not (Get-Service $oldName -ErrorAction SilentlyContinue)) { continue }
  throw @"
'$oldName' already exists - that is this same Beeper Desktop under its old name, so what you want is a RENAME, not an install.
Renaming is remove-and-reinstall (sc.exe has no rename verb) and the Desktop is DOWN in between, so do the IDLE one first:
  .\setup\rename-beeper-s0-service.ps1 -From $oldName -To $ServiceName -WhatIf
  .\setup\rename-beeper-s0-service.ps1 -From $oldName -To $ServiceName
"@
}

New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir      | Out-Null

# SYSTEM'S PROFILE IS A STUB, and Beeper dies on it in a way that looks like a hang.
# app.getPath('downloads') THROWS when the folder does not exist, the rejection is unhandled at
# Electron's module top level, and startup aborts while leaving a window and three processes
# standing at ZERO CPU. It reads as a wedge, not a crash. Create the shell folders first.
$sysProfile = 'C:\Windows\System32\config\systemprofile'
foreach ($d in 'Downloads','Documents','Desktop','Pictures','Music','Videos') {
  $p = Join-Path $sysProfile $d
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null; Say "created SYSTEM profile folder: $d" }
}

# The flags, and why each is there: Get-BeeperServiceArgLine (beeper-desktop.ps1).
$argLine = Get-BeeperServiceArgLine $UserDataDir

Say "installing $ServiceName"
& $nssm install $ServiceName $BeeperExe | Out-Null
& $nssm set $ServiceName AppParameters $argLine        | Out-Null
& $nssm set $ServiceName AppDirectory (Split-Path $BeeperExe -Parent) | Out-Null
& $nssm set $ServiceName AppStdout (Join-Path $LogDir "$ServiceName.log") | Out-Null
& $nssm set $ServiceName AppStderr (Join-Path $LogDir "$ServiceName.log") | Out-Null
& $nssm set $ServiceName AppRestartDelay 10000         | Out-Null
$startConst = @{ auto = 'SERVICE_AUTO_START'; manual = 'SERVICE_DEMAND_START'; disabled = 'SERVICE_DISABLED' }[$StartMode]
& $nssm set $ServiceName Start $startConst             | Out-Null
& $nssm set $ServiceName ObjectName LocalSystem        | Out-Null
& $nssm set $ServiceName DisplayName (Get-BeeperS0DisplayName $ServiceName) | Out-Null
& $nssm set $ServiceName Description (Get-BeeperS0Description $ServiceName) | Out-Null

# The eGPT user may stop/start THIS service, so a Beeper update never needs UAC.
Say "granting start/stop on $ServiceName to $GrantSid"
Set-BeeperServiceAccess -Name $ServiceName -Sid $GrantSid

# -RunAsUser: the same steps as beeper-services-run-as-user.ps1, on a service nothing runs yet.
if ($RunAsUser) {
  $who = (Split-BeeperAccount (([Security.Principal.SecurityIdentifier]$GrantSid).Translate([Security.Principal.NTAccount]).Value)).account
  $cred = Get-Credential -UserName $who -Message "eGPT: the Windows password of $who, to run $ServiceName as that account. Checked here, never stored."
  if (-not $cred -or (Split-BeeperAccount $cred.UserName).account -ine $who) { throw "no credential for $who - $ServiceName stays LocalSystem" }
  $v = Test-BeeperCredential $cred
  if (-not $v.ok) { throw "$($v.message) - $ServiceName stays LocalSystem" }
  if ($v.rightMissing) { Set-BeeperServiceLogonRight $GrantSid; Say "granted $BeeperServiceLogonRight to $who" }
  Set-BeeperServiceAccount $ServiceName $cred
  Say "$ServiceName logs on as $who"
}

Say "installed ($StartMode start). user-data-dir: $UserDataDir"
Say "                    log: $(Join-Path $LogDir "$ServiceName.log")"

if ($Start) {
  Say "starting"
  Start-Service $ServiceName
  # CAME UP = Running, and the same Beeper process is still there 30s later: nssm relaunches a
  # dying app every AppRestartDelay, so a crash loop shows as a new pid. Only a LOGGED-IN install
  # answers /v1/accounts, so that is beeper-whoami's job below, not this check's.
  $exe = Split-Path $BeeperExe -Leaf
  $appPid = {
    $svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if ($svc.State -eq 'Running' -and $svc.ProcessId) {
      (Get-CimInstance Win32_Process -Filter "ParentProcessId=$($svc.ProcessId) AND Name='$exe'" | Select-Object -First 1).ProcessId
    }
  }
  Start-Sleep -Seconds 10
  $first = & $appPid
  Start-Sleep -Seconds 30
  $now = & $appPid
  if ($first -and $now -eq $first) {
    Say "up: $ServiceName Running, $exe pid $first stayed up 30s"
    $api = Get-NetTCPConnection -State Listen -OwningProcess $first -ErrorAction SilentlyContinue |
           Where-Object { $_.LocalPort -ge 23373 -and $_.LocalPort -le 23390 }
    if ($api) { Say ("its Beeper API port: " + (($api.LocalPort | Sort-Object -Unique) -join ', ')) }
    else      { Say "no Beeper API port yet - a fresh install: log it in via adopt-beeper-profile.ps1 (header)" }
  } else {
    Say "WARNING: $ServiceName did not stay up (pid '$first' -> '$now') - check $(Join-Path $LogDir "$ServiceName.log")"
  }
}

Say "done. verify with:  node src/tools/beeper-whoami.mjs   (a logged-in install answers /v1/accounts)"

if ($Pause) { Write-Host ''; Write-Host 'Press Enter to close...' -ForegroundColor Cyan; try { Read-Host | Out-Null } catch { } }
