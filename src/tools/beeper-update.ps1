# beeper-update.ps1 - install Beeper's downloaded update for every Beeper on this machine.
#
# Beeper is a PER-USER install (%LOCALAPPDATA%\Programs\BeeperTexts) shared by the Beeper app
# and any eGPT Beeper service. electron-updater installs only on "Relaunch to update"; a plain
# quit does not, and any running Beeper.exe blocks it. NSSM restarts a killed service Desktop,
# so a service is STOPPED, and Beeper is never killed: a killed syncing client can come back
# needing re-verification.
#
# Two flows, by what is running:
#   app       no Beeper service running (the baseline): close the app, install, relaunch it,
#             check each token. No administrator needed.
#   services  close the app, stop each running service, install, start the services ONE AT A
#             TIME - each token must answer before the next starts (started together they race
#             for ports and one got none, 2026-10-15) - one restart of a service with no port,
#             then the app LAST. Stopping a service needs the right to: grant it once with
#             setup\grant-beeper-service-control.cmd, or let this script ask for administrator.
# The app goes FIRST and gets WM_CLOSE (hidden window included). It hides instead of quitting
# unless its "Quit Beeper when closing the main window" is on; then nothing is stopped or
# installed and the result says to quit it from the tray.
# Refused before anything is touched: a sha512 mismatch, nothing newer, an installer that needs
# admin rights, a missing permission. The installer runs as THIS user, never as SYSTEM.
# The last stdout line is ONE JSON object (eGPT reads it).
#
#   beeper-update.cmd                 install the downloaded update
#   beeper-update.cmd -DryRun         print the plan and stop; touches nothing (-WhatIf works too)
#   beeper-update.cmd -RestartOnly    no install: restart everything in order (a Beeper older
#                                     than the installed one is still running)
#   beeper-update.cmd -Force          reinstall even if the version is not newer
#   beeper-update.cmd -NoRelaunchGui  leave the Beeper app closed
#   -NoElevate                        never ask for UAC (eGPT runs it this way)
#   -CloseAppOnly [-WaitSec n]        only close the open app (WM_CLOSE, then n s, default 30, for it
#                                     to quit); {quit:true} or the close-app refusal, nothing else touched
#   -RelaunchApp                      relaunch the app even though it is not running now (eGPT closed it first)
#   -Installer <exe> -Sha512 <b64>    install this file (eGPT's own download), not the pending folder's
#   -StateFile <json>                 plan from a recorded state, not this machine (tests); implies -DryRun
#
# ASCII ONLY, deliberately: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI, so a single
# em-dash in a comment is a parse error.
[CmdletBinding()]
param(
  [Alias('WhatIf')][switch] $DryRun,
  [switch] $RestartOnly,
  [switch] $Force,
  [switch] $NoRelaunchGui,
  [switch] $CloseAppOnly,
  [int]    $WaitSec = 30,
  [switch] $RelaunchApp,
  [switch] $NoElevate,
  [switch] $Pause,
  [string] $StateFile,
  [string] $Installer,
  [string] $Sha512,
  # Carried through a UAC prompt, which may log in as another account.
  [string] $LocalAppData = $env:LOCALAPPDATA,
  [string] $AppData = $env:APPDATA,
  [string] $EgptHome = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [int]    $ServicePortTimeoutSec = 90
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. (Join-Path $repo 'setup\beeper-desktop.ps1')

$exe        = Join-Path $LocalAppData 'Programs\BeeperTexts\Beeper.exe'
$pendingDir = Join-Path $LocalAppData 'beepertexts-updater\pending'
$grantCmd   = Join-Path $repo 'setup\grant-beeper-service-control.cmd'
$selfCmd    = Join-Path $PSScriptRoot 'beeper-update.cmd'

function Say($m) { Write-Host "[beeper-update] $m" }
function Done($o, [int] $code = 0) {
  Write-Output ($o | ConvertTo-Json -Compress -Depth 6)
  if ($Pause) { Write-Host ''; Write-Host 'Press Enter to close...' -ForegroundColor Cyan; try { Read-Host | Out-Null } catch { } }
  exit $code
}

# electron-updater records the sha512 as base64, Get-FileHash gives hex. Converted with an explicit
# byte[] and an index loop: the obvious `-split | ForEach-Object` pipeline yields Object[], which
# ToBase64String refuses.
function Get-Sha512Base64([string] $Path) {
  $hex   = (Get-FileHash -Path $Path -Algorithm SHA512).Hash
  $bytes = [byte[]]::new($hex.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
  return [Convert]::ToBase64String($bytes)
}

# $s.pending for an installer: the version from its file name.
function Get-Pending([string] $File, [string] $Sha, [bool] $AdminRequired) {
  return [ordered]@{
    installer     = $File
    version       = $(if ((Split-Path $File -Leaf) -match '(\d+\.\d+\.\d+(\.\d+)?)') { $matches[1] } else { $null })
    adminRequired = $AdminRequired
    sha512Ok      = ((Test-Path $File) -and $Sha -and (Get-Sha512Base64 $File) -eq $Sha)
  }
}

# Everything the plan depends on, read without changing anything. -StateFile supplies the same shape.
function Read-MachineState {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  $elevated = (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $s = [ordered]@{
    system     = ($me.User.Value -eq 'S-1-5-18')
    elevated   = $elevated
    installed  = $(if (Test-Path $exe) { (Get-Item $exe).VersionInfo.ProductVersion } else { $null })
    pending    = $null
    services   = @(Get-BeeperServices $exe | ForEach-Object { [ordered]@{ name = $_.Name; running = $_.Running; canControl = ($elevated -or (Test-BeeperServiceControl $_.Name)) } })
    appRunning = [bool](Get-CimInstance Win32_Process -Filter "Name='Beeper.exe'" | Where-Object { $_.SessionId -ne 0 })
  }
  $infoPath = Join-Path $pendingDir 'update-info.json'
  if (-not $Installer -and (Test-Path $infoPath)) {
    $info = Get-Content $infoPath -Raw | ConvertFrom-Json
    $s.pending = Get-Pending (Join-Path $pendingDir $info.fileName) $info.sha512 ([bool]$info.isAdminRightsRequired)
  }
  return $s
}

function Get-UpdatePlan($s) {
  $running = @($s.services | Where-Object { $_.running } | ForEach-Object { $_.name })
  $p = [ordered]@{
    ok = $true; dryRun = [bool]$DryRun; flow = $(if ($running.Count) { 'services' } else { 'app' })
    from = $s.installed; to = $s.installed; install = (-not $RestartOnly)
    stop = $running; closeApp = [bool]$s.appRunning; start = $running; relaunchApp = (([bool]$s.appRunning -or $RelaunchApp) -and -not $NoRelaunchGui)
  }
  $refuse = { param($step, $err, $remedy) $p.ok = $false; $p.step = $step; $p.error = $err; if ($remedy) { $p.remedy = $remedy }; $p }
  if ($s.system) { return & $refuse 'identity' 'running as SYSTEM - Beeper is per-user; run this as the eGPT user' }
  if (-not $s.installed) { return & $refuse 'install-dir' "no Beeper at $exe" }
  if (-not $RestartOnly) {
    $pd = $s.pending
    if (-not $pd) { return & $refuse 'pending' "nothing downloaded in $pendingDir" }
    if (-not $pd.sha512Ok) { return & $refuse 'sha512' "the download does not match its sha512" "delete $pendingDir and let Beeper download it again" }
    if (-not $Force -and -not ($pd.version -and [version]$pd.version -gt [version]$s.installed)) { return & $refuse 'nothing-to-install' "Beeper $($s.installed) is installed; the download is $($pd.version)" }
    if ($pd.adminRequired -and -not $s.elevated) { return & $refuse 'admin-rights' 'this download needs administrator rights' "run $selfCmd (it asks for administrator)" }
    $p.to = $pd.version
  }
  $denied = @($s.services | Where-Object { $_.running -and -not $_.canControl } | ForEach-Object { $_.name })
  if ($denied.Count) { return & $refuse 'permission' "this user may not stop/start $($denied -join ', ')" "run $grantCmd once as administrator" }
  return $p
}

$closeAppRefusal = [ordered]@{ ok = $false; step = 'close-app'; error = 'the Beeper app hid instead of quitting'; remedy = 'quit Beeper from its tray icon (Quit), then update again'; connections = @(); app = [ordered]@{ ran = $true; relaunched = $false } }
if ($CloseAppOnly) {
  Say "closing the Beeper app (waiting up to ${WaitSec}s)"
  if (Close-BeeperApp $WaitSec (Get-BeeperDefaultProfile $AppData)) { Done ([ordered]@{ ok = $true; quit = $true }) }
  Say 'the Beeper app is still running - nothing was stopped'
  $closeAppRefusal.quit = $false
  Done $closeAppRefusal 1
}

if ($StateFile) { $DryRun = $true; $state = Get-Content $StateFile -Raw | ConvertFrom-Json }
else { $state = Read-MachineState }
if ($Installer) { $state.pending = Get-Pending $Installer $Sha512 $false }
$plan = Get-UpdatePlan $state

if (-not $plan.ok) {
  if (-not $DryRun -and -not $NoElevate -and -not $state.elevated -and $plan.step -in @('permission', 'admin-rights')) {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-LocalAppData', "`"$LocalAppData`"", '-AppData', "`"$AppData`"", '-EgptHome', "`"$EgptHome`"")
    foreach ($k in 'RestartOnly', 'Force', 'NoRelaunchGui', 'RelaunchApp', 'Pause') { if (Get-Variable $k -ValueOnly) { $a += "-$k" } }
    if ($Installer) { $a += @('-Installer', "`"$Installer`"", '-Sha512', $Sha512) }
    Say "$($plan.error) - elevating..."
    Start-Process powershell -Verb RunAs -ArgumentList $a
    return
  }
  Say "refused ($($plan.step)): $($plan.error)"
  if ($plan.remedy) { Say "fix: $($plan.remedy)" }
  Done $plan 1
}

Say "$($plan.flow) flow: Beeper $($plan.from) -> $($plan.to)$(if (-not $plan.install) { ' (restart only)' })"
if ($DryRun) {
  Say "-DryRun: close the app: $($plan.closeApp), stop [$($plan.stop -join ', ')], install: $($plan.install), start [$($plan.start -join ', ')] one at a time, relaunch the app: $($plan.relaunchApp)"
  Done $plan
}

# Wait until $Token's Desktop answers (200 on /v1/accounts); its port and the version it serves.
function Wait-Connection([string] $Token) {
  if (-not $Token) { Start-Sleep -Seconds 25; return @{ port = $null; version = $null } }   # no token: give it the bind time measured (5-25 s)
  $deadline = (Get-Date).AddSeconds($ServicePortTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $port = Find-BeeperPort $Token
    if ($port) { return @{ port = $port; version = (Get-BeeperVersionAt $port) } }
  }
  return @{ port = $null; version = $null }
}
# Equal as versions, not text: Beeper.exe's ProductVersion is 4.3.209.0, the download and /v1/info say 4.3.209.
function Test-SameVersion($a, $b) {
  $four = { param($v) $p = @("$v".Split('.') | ForEach-Object { [int]$_ }); while ($p.Count -lt 4) { $p += 0 }; $p -join '.' }
  return (& $four $a) -eq (& $four $b)
}
function New-ConnectionRow($name, $service, $r, [bool] $hasToken, $expect) {
  $status = if (-not $hasToken) { 'no-token' } elseif (-not $r.port) { 'no-port' } elseif ($r.version -and -not (Test-SameVersion $r.version $expect)) { "version $($r.version)" } else { 'ok' }
  return [ordered]@{ name = $name; service = $service; port = $r.port; version = $r.version; status = $status }
}

$t0 = Get-Date
$tokens = Get-BeeperTokens -RepoRoot $repo -EgptHome $EgptHome
$failStep = $null; $failErr = $null; $step = 'stop'
# The app first: if it will not quit, nothing has been stopped, so nothing needs bringing back.
# (eGPT closes it beforehand with -CloseAppOnly, so this is for a run started by hand.)
if ($plan.closeApp) {
  Say 'closing the Beeper app'
  if (-not (Close-BeeperApp 30 (Get-BeeperDefaultProfile $AppData))) {
    Say 'the Beeper app hid instead of quitting - nothing was stopped or installed'
    foreach ($k in 'flow', 'from', 'to', 'install') { $closeAppRefusal[$k] = $plan[$k] }
    $closeAppRefusal.installed = $state.installed
    Done $closeAppRefusal 1
  }
}

# A profile the app shares with a service (setup\beeper-desktop.ps1): holding its claim keeps the
# reconciler from starting that service mid-install. Released before the services start.
$claim = $null
foreach ($s in Get-BeeperServices $exe) {
  $ap = [string](Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$($s.Name)\Parameters").AppParameters
  if (Test-BeeperSharedProfile $ap $AppData (Get-BeeperPreStartHook $s.Name)) { $claim = Open-BeeperClaim (Get-BeeperClaimPath (Get-BeeperShareProfile $ap $AppData)) }
}

try {
  # STOP the service, never kill the process: NSSM brings a killed Desktop back in 10 s.
  foreach ($svc in $plan.stop) {
    Say "stopping $svc"
    Stop-Service $svc -Force
    (Get-Service $svc).WaitForStatus('Stopped', '00:01:00')
  }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Process Beeper -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Get-Process Beeper -ErrorAction SilentlyContinue) { throw 'a Beeper.exe is still running; nothing was installed' }

  if ($plan.install) {
    # /S is NSIS silent; --updated tells it this is an update. No --force-run: the relaunch below is ordered.
    $step = 'install'
    Say 'running the installer (silent)'
    $proc = Start-Process -FilePath $state.pending.installer -ArgumentList '/S', '--updated' -PassThru -Wait
    $now = (Get-Item $exe).VersionInfo.ProductVersion
    Say "installer exit $($proc.ExitCode); Beeper.exe is now $now"
    if (-not (Test-SameVersion $now $plan.to)) { throw "installer exit $($proc.ExitCode); Beeper.exe is $now, expected $($plan.to)" }
  }
} catch { $failStep = $step; $failErr = $_.Exception.Message; Say "FAILED ($step): $failErr - bringing Beeper back as it was" }
if ($claim) { $claim.Dispose() }

# Back up whatever happened above: services one at a time, the app last.
$expect = (Get-Item $exe).VersionInfo.ProductVersion
$conns = New-Object System.Collections.ArrayList
$ofService = @{}
foreach ($svc in $plan.start) {
  $name = $svc -replace '^egpt-beeper-', ''
  $ofService[$name] = $true
  Say "starting $svc"
  try { Start-Service $svc } catch { Say "${svc}: $($_.Exception.Message)" }
  $r = Wait-Connection $tokens[$name]
  if ($tokens[$name] -and -not $r.port) {
    Say "$svc answers on no port after ${ServicePortTimeoutSec}s - restarting it once"
    try { Restart-Service $svc -Force } catch { Say "${svc}: $($_.Exception.Message)" }
    $r = Wait-Connection $tokens[$name]
  }
  [void]$conns.Add((New-ConnectionRow $name $svc $r ([bool]$tokens[$name]) $expect))
}
if ($plan.relaunchApp) {
  # Through explorer.exe: the app runs as the desktop user, detached from this process, never elevated.
  Say 'relaunching the Beeper app'
  Start-Process explorer.exe -ArgumentList "`"$exe`""
  foreach ($name in @($tokens.Keys | Where-Object { -not $ofService.ContainsKey($_) } | Sort-Object)) {
    [void]$conns.Add((New-ConnectionRow $name $null (Wait-Connection $tokens[$name]) $true $expect))
  }
}

$restartSec = [int][Math]::Round(((Get-Date) - $t0).TotalSeconds)
$bad = @($conns | Where-Object { $_.status -ne 'ok' })
$result = [ordered]@{
  ok = (-not $failStep -and -not $bad.Count); flow = $plan.flow; from = $plan.from; to = $plan.to; installed = $expect
  install = $plan.install; connections = @($conns); app = [ordered]@{ ran = $plan.closeApp; relaunched = $plan.relaunchApp }; restartSec = $restartSec
}
if ($failStep) { $result.step = $failStep; $result.error = $failErr }
elseif ($bad.Count) { $result.step = 'start'; $result.error = (($bad | ForEach-Object { "$($_.name) $($_.status)" }) -join ', ') }
Say "$(if ($result.ok) { 'done' } else { "FAILED at $($result.step)" }): Beeper $expect, restarted in ${restartSec}s -$((@($conns) | ForEach-Object { "$($_.name) $($_.status)$(if ($_.port) { " :$($_.port)" })" }) -join ', ')"
Done $result $(if ($result.ok) { 0 } else { 1 })
