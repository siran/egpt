# install-beeper-s0-service.ps1 - run a Beeper Desktop as a SESSION 0 Windows service.
#
# Session 0 isolation removed the ability to SEE a service's windows. It never removed the
# ability to RUN there: Session 0 has a window station, a desktop, a working window manager and
# a virtual display, and CDP renders from the compositor, so a Beeper Desktop nobody can see
# still syncs, still serves its local API, and can still be driven (src/tools/s0-driver). That is
# what makes the agents answer in the operator's groups with nobody logged in.
#
# This installs ONE such Desktop. A node can host SEVERAL: they are the same binaries with
# DIFFERENT --user-data-dir values, which is what makes them separate INSTALLS - separate
# logins, separate tokens, separate ports. reve runs one for `an` and one for `rodz`.
#
# Run ELEVATED, from the repo root:
#   .\setup\install-beeper-s0-service.ps1 -ServiceName BeeperRodz `
#       -UserDataDir C:\Users\an\.egpt\state\rodz-beeper\userdata -CdpPort 9224
#
# Remove:  nssm remove <ServiceName> confirm
#
# ASCII ONLY: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI, so one em-dash is a
# parse error.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $ServiceName,
  [Parameter(Mandatory = $true)][string] $UserDataDir,
  [int]    $CdpPort  = 9223,
  [string] $BeeperExe = (Join-Path $env:LOCALAPPDATA 'Programs\BeeperTexts\Beeper.exe'),
  [string] $LogDir   = (Join-Path $env:USERPROFILE 'bin\beeper-s0-logs'),
  # AUTO for the Desktop that must be up BEFORE anyone logs in; MANUAL for one the logon
  # flip owns, so Windows does not start it behind the flip's back at boot.
  [ValidateSet('auto','manual','disabled')][string] $StartMode = 'auto',
  [switch] $Start,
  [switch] $Pause
)

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [switch]) { if ($kv.Value.IsPresent) { $a += "-$($kv.Key)" } }
    else { $a += @("-$($kv.Key)", "`"$($kv.Value)`"") }
  }
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

# A CDP port already in use would silently give this Desktop NO debugger, which is the one way
# back into a window nobody can see.
if (Get-NetTCPConnection -State Listen -LocalPort $CdpPort -ErrorAction SilentlyContinue) {
  throw "CDP port $CdpPort is already listening - pick another (BeeperAn uses 9223)"
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

# THE FLAGS, and why each is here:
#   --disable-gpu                          no GPU in Session 0.
#   --disable-gpu-compositing              ditto. NOTE: --disable-software-rasterizer must NOT
#                                          be added alongside these; together they remove the
#                                          LAST render path and the app paints nothing.
#   --disable-background-timer-throttling   Chromium throttles what it thinks is background, and
#   --disable-renderer-backgrounding        NOTHING in Session 0 is ever foregrounded. Without
#   --disable-backgrounding-occluded-windows these three a live sync socket stalls.
#   --remote-debugging-port                 the only way into a window nobody can display.
#   --remote-allow-origins=*                /json/list sends no CORS headers; the driver is served.
$argLine = "--user-data-dir=`"$UserDataDir`" --disable-gpu --disable-gpu-compositing --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --remote-debugging-port=$CdpPort --remote-allow-origins=*"

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
& $nssm set $ServiceName DisplayName "Beeper Desktop (Session 0) - $ServiceName" | Out-Null

Say "installed ($StartMode start). user-data-dir: $UserDataDir"
Say "               CDP port: $CdpPort"
Say "                    log: $(Join-Path $LogDir "$ServiceName.log")"

if ($Start) {
  Say "starting"
  Start-Service $ServiceName
  # A fresh install has no login, so it will NOT serve /v1/accounts. What proves it came up is
  # the CDP endpoint - and that is also how you log it in, through src/tools/s0-driver.
  $deadline = (Get-Date).AddSeconds(90)
  $up = $false
  while (-not $up -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    try { $null = Invoke-WebRequest "http://127.0.0.1:$CdpPort/json/version" -TimeoutSec 3 -UseBasicParsing; $up = $true } catch { }
  }
  if ($up) {
    Say "CDP is answering on $CdpPort - drive it with src/tools/s0-driver to log this install in"
    $api = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
           Where-Object { $_.LocalPort -ge 23373 -and $_.LocalPort -le 23390 -and (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").SessionId -eq 0 }
    if ($api) { Say ("session 0 Beeper API ports now listening: " + (($api.LocalPort | Sort-Object -Unique) -join ', ')) }
  } else {
    Say "WARNING: no CDP on $CdpPort after 90s - check $(Join-Path $LogDir "$ServiceName.log")"
  }
}

Say "done. verify with:  node src/tools/beeper-whoami.mjs"

if ($Pause) { Write-Host ''; Write-Host 'Press Enter to close...' -ForegroundColor Cyan; try { Read-Host | Out-Null } catch { } }
