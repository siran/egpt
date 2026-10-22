# share-beeper-primary-profile.ps1 - run the primary account from ONE Beeper profile, shared by the
# operator's window and the egpt-beeper-primary service. The window runs it in Session 1 while Beeper is open; the
# service runs it in Session 0 otherwise; never both (beeper-desktop.ps1,
# "one profile, two runtimes"). One device, one token: beeper.primary_gui goes away.
# The shared profile is the service's own --user-data-dir when it has one (it keeps its device and
# token; the window opens on it), else the window's default profile (the service moves onto it).
#
#   1 backup      whatever runs the profile stopped (the service) or quit (Beeper: tray > Quit),
#                 then a full copy of the profile beside it
#   2 window      Beeper opened on the profile; wait for its API
#   3 token       a token minted on the window (one Approve click there) -> beeper.primary.token;
#                 a service that already ran the profile keeps its token, checked on the window
#   4 config      beeper.primary_gui removed; /restart, so the spine binds the window
#   5 service     egpt-beeper-primary stopped and pointed at the profile (unless it already runs it),
#                 with a 10 s Ctrl+C grace and the NSSM Start/Pre hook
#   6 reconciler  egpt-s0-identity registered as the desktop user (S4U), never SYSTEM
#   7 logon       Beeper's own Run value replaced by beeper-window.vbs, plus a "Beeper (eGPT)" shortcut
#   8 launcher    beeper-window started: it claims the profile and watches the window
# The record of what it replaced (state\beeper-share.json, with the profile) is written before step 3
# changes anything (a kept token is checked first).
# -Resume finishes a conversion that stopped once the service runs the profile (after step 5, or
# after step 3 when it already did): it looks at what is live and runs only
# what is missing (config, service hook, 6, 7, 8), each step safe to run again.
# -Revert undoes 8..3 from that record and names the profile backup. It starts the old service
# device again, which only works until the operator logs that device out; a service that kept its
# profile gets it back once Beeper is quit.
# The service keeps its LocalSystem log-on. Running it as the desktop user is a separate, optional
# step after this one: beeper-services-run-as-user.cmd (-Revert here needs it reverted first).
#
#   share-beeper-primary-profile.cmd [-DryRun] [-Revert | -Resume]
#   -StateFile <json>   plan from a recorded machine, not this one (tests); implies -DryRun
# ASCII ONLY: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI.
[CmdletBinding()]
param(
  [string] $ServiceName = 'egpt-beeper-primary',
  # Carried through UAC, which may log in as another account.
  [string] $AppData = $env:APPDATA,
  [string] $LocalAppData = $env:LOCALAPPDATA,
  [string] $UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
  [string] $EgptHome = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [switch] $Revert,
  [switch] $Resume,
  [Alias('WhatIf')][switch] $DryRun,
  [string] $StateFile,
  [switch] $Pause,
  [switch] $LoadFunctionsOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'beeper-desktop.ps1')

$RunKeyBeeper = 'com.automattic.beeper.desktop'   # Beeper's own login item (Electron setLoginItemSettings)
$RunKeyWindow = 'egpt-beeper-window'
$StopGraceMs = 10000   # NSSM's Ctrl+C wait; Beeper's own SIGINT cleanup caps itself at 5 s

# What a stopped conversion still lacks, from live state; each line starts with its step id. Pure.
function Get-ShareResumeSteps($s) {
  $have = { param($b) if ($b) { 'present' } else { 'absent' } }
  $steps = @()
  if ($s.config.primaryGui) { $steps += "config: remove beeper.primary_gui; spine /restart: $([bool]$s.spineLive)" }
  if ([string]$s.service.preHook -notmatch $BeeperPreStartHook -or [string]$s.service.stopConsole -ne "$StopGraceMs") {
    $steps += "service: AppStopMethodConsole $StopGraceMs; AppEvents Start/Pre -> s0-identity-reconcile.ps1 -PreStart"
  }
  # A repetition only on AtStartup waits for the next boot: it needs a time trigger repeating indefinitely.
  $repeats = @($s.task.triggers | Where-Object { $_.kind -eq 'Time' -and $_.interval -and -not $_.duration }).Count -gt 0
  if (-not $s.task -or $s.task.logonType -ne 'S4U' -or [string]$s.task.userId -match 'SYSTEM' -or -not $repeats) {
    $why = if (-not $s.task) { '' } elseif (-not $repeats -and $s.task.logonType -eq 'S4U' -and [string]$s.task.userId -notmatch 'SYSTEM') { ' - replacing one with no repeating time trigger (it would not run before a reboot)' }
      else { " - replacing the one that runs as $($s.task.userId) ($($s.task.logonType))" }
    $steps += "reconciler: register egpt-s0-identity as $($s.user) (S4U, every 2 min from now on, and at boot)$why"
  }
  if ($s.runValue -or -not $s.launcherRunValue -or -not $s.shortcutExists) {
    $steps += "logon: Run value $RunKeyBeeper ($(& $have $s.runValue)) -> $RunKeyWindow ($(& $have $s.launcherRunValue)); shortcut 'Beeper (eGPT)' ($(& $have $s.shortcutExists))"
  }
  if (-not $s.launcherRunning) { $steps += 'launcher: start beeper-window (claims the profile, watches the window)' }
  return $steps
}

# The plan, from a machine state (Read-ShareState, or -StateFile). Pure: tests feed it states.
function Get-SharePlan($s, [bool] $Revert, [bool] $Resume = $false) {
  $refuse = { param($step, $err, $remedy) [ordered]@{ ok = $false; step = $step; error = $err; remedy = $remedy } }
  if (-not $s.service.exists) { return & $refuse 'service' "no service named $($s.serviceName)" $null }
  # Already runs the shared profile (its own --user-data-dir): it keeps its device and token.
  $runs = Test-BeeperRunsProfile $s.service.appParameters $s.profile
  if ($Resume) {
    if (-not $s.record) { return & $refuse 'record' "no record at $($s.recordPath) - nothing to resume" 'run without -Resume' }
    if (-not $runs) { return & $refuse 'service' "$($s.serviceName) does not run $($s.profile) yet: the conversion stopped before step 5" 'run with -Revert, then convert again' }
    return [ordered]@{ ok = $true; revert = $false; resume = $true; steps = @(Get-ShareResumeSteps $s) }
  }
  if ($Revert) {
    if (-not $s.record) { return & $refuse 'record' "no record at $($s.recordPath) - nothing to revert" $null }
    # Back to no --user-data-dir while it logs on as the user = that user's own window profile, twice.
    if (-not (Get-BeeperUserDataDir $s.record.appParameters) -and $s.service.account -ne 'LocalSystem') { return & $refuse 'account' "$($s.serviceName) logs on as $($s.service.account)" 'run beeper-services-run-as-user.cmd -Revert first' }
    # Back on the profile the window runs: Beeper is quit before the service starts.
    $kept = Test-BeeperRunsProfile $s.record.appParameters $s.profile
    $steps = @(
      "launcher: stop beeper-window (it releases the claim)",
      "logon: remove the $RunKeyWindow Run value and the shortcut; restore Beeper's own Run value: $([bool]$s.record.runValue)",
      'reconciler: unregister egpt-s0-identity',
      $(if ($kept) { "service: stop $($s.serviceName); AppParameters stay '$($s.record.appParameters)'; Start/Pre hook and Ctrl+C grace back" }
        else { "service: stop $($s.serviceName); AppParameters back to '$($s.record.appParameters)'; Start/Pre hook and Ctrl+C grace back" }),
      "config: beeper.primary.token and beeper.primary_gui back from $($s.record.configBackup)")
    if ($kept) { $steps += "window: Beeper on $($s.profile) quit first (tray > Quit; you are asked when it is open)" }
    $steps += $(if ($kept) { "service: start $($s.serviceName) (the device the window ran)" } else { "service: start $($s.serviceName) (its old device - only if not logged out since)" })
    $steps += 'spine: /restart', "backup: the profile backup stays at $($s.record.profileBackup) ($($s.record.profileBackupMB) MB)"
    return [ordered]@{ ok = $true; revert = $true; steps = $steps }
  }
  if ($s.record) {
    $fix = if ($runs) { 'run with -Resume to finish it, or -Revert to undo it' } else { 'run with -Revert first' }
    return & $refuse 'record' "a conversion is already recorded at $($s.recordPath)" $fix
  }
  if ($s.service.account -ne 'LocalSystem') { return & $refuse 'account' "$($s.serviceName) runs as $($s.service.account); this conversion keeps LocalSystem" $null }
  if (Test-BeeperSharedProfile $s.service.appParameters $s.appData $s.service.preHook) { return & $refuse 'shared' "$($s.serviceName) already runs $($s.profile)" 'nothing to do (-Revert undoes it)' }
  if (-not $s.profileExists) { return & $refuse 'profile' "no Beeper profile at $($s.profile)" $null }
  # The window runs as the desktop user.
  if ($s.aclGaps -gt 0) { return & $refuse 'acl' "$($s.aclGaps) entries in $($s.profile) do not give $($s.user) full control (first: $($s.firstGap))" "give $($s.user) full control of $($s.profile), then run this again" }
  if (-not $s.hooks) { return & $refuse 'nssm' "NSSM $($s.service.nssmVersion) has no Start/Pre hooks" 'install NSSM 2.24-101 or later' }
  if (-not $s.config.primary) { return & $refuse 'config' 'config.yaml has no beeper.primary block' $null }
  $open = if ($s.windowUp) { 'Beeper is open: you will be asked to quit it (tray > Quit) first' } elseif ($runs) { "$($s.serviceName) runs it: stopped first" } else { 'Beeper is closed' }
  $winArgs = Get-BeeperWindowArgs $s.profile $s.appData
  return [ordered]@{ ok = $true; revert = $false; keepToken = $runs; steps = @(
    "backup: $open; copy $($s.profile) to $($s.profile).backup-<time>",
    $(if ($winArgs) { "window: open Beeper.exe $winArgs and wait for its API" } else { 'window: open Beeper again and wait for its API' }),
    $(if ($runs) { "token: keep beeper.primary.token (the device of $($s.profile); no mint): check it answers on the window's port, then write $($s.recordPath)" }
      else { "token: write $($s.recordPath); mint a token on the window (click Approve there) -> beeper.primary.token" }),
    "config: remove beeper.primary_gui: $([bool]$s.config.primaryGui); spine /restart: $([bool]$s.spineLive)",
    $(if ($runs) { "service: stop $($s.serviceName); AppParameters stay as they are; AppStopMethodConsole $StopGraceMs; AppEvents Start/Pre -> s0-identity-reconcile.ps1 -PreStart" }
      else { "service: stop $($s.serviceName); AppParameters -> $(Get-BeeperServiceArgLine $s.profile); AppStopMethodConsole $StopGraceMs; AppEvents Start/Pre -> s0-identity-reconcile.ps1 -PreStart" }),
    "reconciler: register egpt-s0-identity as $($s.user) (S4U, every 2 min from now on, and at boot)",
    "logon: Run value $RunKeyBeeper ($(if ($s.runValue) { 'present' } else { 'absent' })) -> $RunKeyWindow; shortcut 'Beeper (eGPT)'",
    'launcher: start beeper-window (claims the profile, watches the window)') }
}

function Test-NssmHooks([string] $Version) {
  return $Version -match '^2\.24-(\d+)' -and [int]$Matches[1] -ge 101
}

if ($LoadFunctionsOnly) { return }

function Say($m) { Write-Host "[share] $m" }
function Done($o, [int] $code = 0) {
  Write-Output ($o | ConvertTo-Json -Compress -Depth 6)
  if ($Pause) { Write-Host ''; Write-Host 'Press Enter to close...' -ForegroundColor Cyan; try { Read-Host | Out-Null } catch { } }
  exit $code
}

$recordPath = Join-Path $EgptHome 'state\beeper-share.json'
$configPath = Join-Path $EgptHome 'config\config.yaml'
$runKey = "Registry::HKEY_USERS\$UserSid\Software\Microsoft\Windows\CurrentVersion\Run"
$shortcut = Join-Path $AppData 'Microsoft\Windows\Start Menu\Programs\Beeper (eGPT).lnk'
$hookLog = Join-Path $EgptHome 'config\logs\s0-identity.log'
$nssm = $null

function Read-ShareState {
  $svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  $par = if ($svc) { Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters" } else { $null }
  $record = if (Test-Path -LiteralPath $recordPath) { Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json } else { $null }
  # A record names the profile (one from before 2026-10-22 does not: the window's default then).
  $profileDir = if ($record.profile) { [string]$record.profile } else { Get-BeeperShareProfile ([string]$par.AppParameters) $AppData }
  $s = [ordered]@{
    serviceName = $ServiceName; appData = $AppData; profile = $profileDir; profileExists = (Test-Path -LiteralPath $profileDir)
    recordPath = $recordPath; record = $record; hooks = $false; spineLive = (Test-EgptSpineLive $EgptHome)
    elevated = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    service = [ordered]@{ exists = [bool]$svc }
    windowUp = $false; runValue = $null; config = [ordered]@{}; aclGaps = 0; firstGap = $null
  }
  if ($svc) {
    $script:nssm = $svc.PathName.Trim('"')
    $s.service = [ordered]@{
      exists = $true; state = [string]$svc.State; account = [string]$svc.StartName; exe = [string]$par.Application
      appParameters = [string]$par.AppParameters
      stopConsole = ((& $nssm get $ServiceName AppStopMethodConsole) -join '').Trim([char]0, ' ')
      preHook = ((& $nssm get $ServiceName AppEvents Start/Pre) -join '').Trim([char]0, ' ')
      nssmVersion = (Get-Item $nssm).VersionInfo.FileVersion
    }
    $s.hooks = Test-NssmHooks $s.service.nssmVersion
  }
  $s.windowUp = @(Select-BeeperProfileProcesses (Get-CimInstance Win32_Process -Filter "Name='Beeper.exe'" | Where-Object { $_.SessionId -ne 0 }) $profileDir).Count -gt 0
  $run = Get-ItemProperty $runKey -ErrorAction SilentlyContinue
  $s.runValue = $run.$RunKeyBeeper
  $s.launcherRunValue = $run.$RunKeyWindow
  $s.shortcutExists = Test-Path -LiteralPath $shortcut
  $s.launcherRunning = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { [string]$_.CommandLine -match 'beeper-window\.ps1' }).Count -gt 0
  $s.user = ([Security.Principal.SecurityIdentifier]$UserSid).Translate([Security.Principal.NTAccount]).Value
  if ($s.profileExists -and -not $record) {   # only a fresh conversion asks
    $gaps = @(Get-BeeperAclGaps $profileDir $UserSid)
    $s.aclGaps = $gaps.Count; if ($gaps.Count) { $s.firstGap = $gaps[0] }
  }
  $t = Get-ScheduledTask -TaskName 'egpt-s0-identity' -ErrorAction SilentlyContinue
  $s.task = if ($t) {
    [ordered]@{ userId = [string]$t.Principal.UserId; logonType = [string]$t.Principal.LogonType
      triggers = @($t.Triggers | ForEach-Object { [ordered]@{ kind = ($_.CimClass.CimClassName -replace '^MSFT_Task|Trigger$', ''); interval = [string]$_.Repetition.Interval; duration = [string]$_.Repetition.Duration } }) }
  } else { $null }
  $names = Get-BeeperTokens -RepoRoot (Split-Path -Parent $PSScriptRoot) -EgptHome $EgptHome
  $s.config = [ordered]@{ primary = $names.ContainsKey('primary'); primaryGui = $names.ContainsKey('primary_gui') }
  return $s
}

if ($StateFile) { $DryRun = $true; $state = Get-Content $StateFile -Raw | ConvertFrom-Json }
else { $state = Read-ShareState }

if (-not $DryRun -and -not $state.elevated) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-ServiceName', $ServiceName, '-AppData', "`"$AppData`"", '-LocalAppData', "`"$LocalAppData`"", '-UserSid', $UserSid, '-EgptHome', "`"$EgptHome`"", '-Pause')
  if ($Revert) { $a += '-Revert' }
  if ($Resume) { $a += '-Resume' }
  Say 'elevating...'
  Start-Process powershell -Verb RunAs -ArgumentList $a
  return
}

$plan = Get-SharePlan $state $Revert $Resume
if (-not $plan.ok) {
  Say "refused ($($plan.step)): $($plan.error)"
  if ($plan.remedy) { Say "fix: $($plan.remedy)" }
  Done $plan 1
}
$i = 0
foreach ($line in $plan.steps) { $i++; Say "$i $line" }
if ($Resume -and -not @($plan.steps).Count) { Say 'nothing left to do: the conversion is complete'; Done ([ordered]@{ ok = $true; resume = $true; steps = @() }) }
if ($DryRun) { Say '-DryRun: nothing changed'; Done ([ordered]@{ ok = $true; dryRun = $true; revert = $plan.revert; resume = [bool]$plan.resume; steps = $plan.steps }) }

# --- the machinery -------------------------------------------------------------------------
# PowerShell 5.1 drops embedded quotes from a native argument; \" survives to nssm's argv.
function Set-Nssm([string] $Name, [string] $Value) {
  if ($Value) { & $nssm set $ServiceName $Name ($Value -replace '"', '\"') | Out-Null } else { & $nssm reset $ServiceName $Name | Out-Null }
  if ($LASTEXITCODE -ne 0) { throw "nssm could not set $Name on $ServiceName" }
}
function Set-NssmHook([string] $Value) {
  if ($Value) { & $nssm set $ServiceName AppEvents Start/Pre ($Value -replace '"', '\"') | Out-Null } else { & $nssm reset $ServiceName AppEvents Start/Pre | Out-Null }
  if ($LASTEXITCODE -ne 0) { throw "nssm could not set the Start/Pre hook on $ServiceName" }
}
function Stop-ShareService {
  if ((Get-Service $ServiceName).Status -eq 'Stopped') { return }
  Say "stopping $ServiceName"
  Stop-Service $ServiceName
  (Get-Service $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
}
function Get-Mb([string] $Dir) { [Math]::Round(((Get-ChildItem -LiteralPath $Dir -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB), 0) }
# Up to 30 s for the profile's lockfile to go; $true once it has.
function Wait-ProfileFree {
  $deadline = (Get-Date).AddSeconds(30)
  while ((Test-BeeperLockHeld $profileDir) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  return -not (Test-BeeperLockHeld $profileDir)
}
$profileDir = $state.profile
$exe = $state.service.exe
$keep = [bool]$plan.keepToken   # the service already runs the profile: its device and token stay
# Before the record, a service stopped for the backup is the one thing changed.
$leftStopped = if ($keep) { "; $ServiceName stays Stopped: quit Beeper if it is open, then start $ServiceName" } else { '' }
$launcherVbs = Join-Path $PSScriptRoot 'beeper-window.vbs'
$hookCmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 's0-identity-reconcile.ps1')`" -PreStart -LogPath `"$hookLog`""

# The steps from 4 on that -Resume can finish. Each is safe to run again.
function Invoke-ShareStep([string] $Id) {
  switch ($Id) {
    'config' {
      & node (Join-Path $PSScriptRoot 'beeper-share-config.mjs') remove-gui --config $configPath
      if ($LASTEXITCODE -ne 0) { throw 'beeper.primary_gui was NOT removed' }
      if (Test-EgptSpineLive $EgptHome) { Send-EgptIngestLine $EgptHome '/restart'; Say 'spine: /restart (it waits for turns in progress, then binds the window)' }
    }
    'service' { Set-Nssm AppStopMethodConsole "$StopGraceMs"; Set-NssmHook $hookCmd }
    'reconciler' { & (Join-Path $PSScriptRoot 'register-s0-identity-task.ps1') -ServiceName $ServiceName -LogPath $hookLog -UserId $state.user }
    'logon' {
      Remove-ItemProperty -Path $runKey -Name $RunKeyBeeper -ErrorAction SilentlyContinue
      Set-ItemProperty -Path $runKey -Name $RunKeyWindow -Value "`"$env:SystemRoot\System32\wscript.exe`" //B //Nologo `"$launcherVbs`""
      $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
      $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
      $lnk.Arguments = "//B //Nologo `"$launcherVbs`""
      $lnk.IconLocation = "$exe,0"
      $lnk.Save()
    }
    'launcher' {   # as the desktop user, through the shortcut
      if (@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { [string]$_.CommandLine -match 'beeper-window\.ps1' }).Count) { Say 'beeper-window is already running'; return }
      Start-Process explorer.exe -ArgumentList "`"$shortcut`""
    }
    default { throw "unknown step '$Id'" }
  }
}
# A failure here leaves a state -Resume can finish: say so instead of pointing at -Revert.
function Invoke-ShareTail([string[]] $Ids) {
  foreach ($id in $Ids) {
    Say "step: $id"
    try { Invoke-ShareStep $id } catch { throw "step '$id' failed: $($_.Exception.Message) - fix the cause, then run share-beeper-primary-profile.cmd -Resume" }
  }
}

try {
if ($Resume) {
  Invoke-ShareTail @($plan.steps | ForEach-Object { ($_ -split ':')[0] })
  Say "done. Beeper stays yours while it is open; Quit it from the tray and $ServiceName takes the profile in ~10-30 s."
  Done ([ordered]@{ ok = $true; resume = $true; steps = $plan.steps })
}

if ($Revert) {
  $r = $state.record
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { [string]$_.CommandLine -match 'beeper-window\.ps1' } |
    ForEach-Object { Say "stopping beeper-window (pid $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force }
  Remove-ItemProperty -Path $runKey -Name $RunKeyWindow -ErrorAction SilentlyContinue
  if ($r.runValue) { Set-ItemProperty -Path $runKey -Name $RunKeyBeeper -Value $r.runValue }
  if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
  & (Join-Path $PSScriptRoot 'register-s0-identity-task.ps1') -Remove
  Stop-ShareService
  if ($state.service.appParameters -ne $r.appParameters) { Set-Nssm AppParameters $r.appParameters }
  Set-Nssm AppStopMethodConsole $r.stopConsole
  Set-NssmHook $r.preHook
  & node (Join-Path $PSScriptRoot 'beeper-share-config.mjs') restore --from $r.configBackup --config $configPath
  if ($LASTEXITCODE -ne 0) { throw 'config.yaml was NOT restored (see the line above)' }
  if ((Test-BeeperRunsProfile $r.appParameters $profileDir) -and (Test-BeeperLockHeld $profileDir)) {   # the window still runs it
    Read-Host '[share] Quit Beeper from its tray icon (Quit), then press Enter' | Out-Null
    if (-not (Wait-ProfileFree)) { throw "Beeper still holds $profileDir - $ServiceName is left Stopped: quit Beeper, then run -Revert again" }
  }
  Say "starting $ServiceName (its old device)"
  Start-Service $ServiceName
  if (Test-EgptSpineLive $EgptHome) { Send-EgptIngestLine $EgptHome '/restart' }
  Move-Item -LiteralPath $recordPath -Destination "$recordPath.reverted-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Say "reverted. The profile backup is still at $($r.profileBackup) ($($r.profileBackupMB) MB): restore it by hand only if the profile itself is damaged."
  Done ([ordered]@{ ok = $true; revert = $true; profileBackup = $r.profileBackup })
}

# 1 backup - with whatever runs the profile stopped or quit, so the copy is consistent
if ($keep) { Stop-ShareService; [void](Wait-ProfileFree) }
if ($state.windowUp -or (Test-BeeperLockHeld $profileDir)) {
  Read-Host '[share] Quit Beeper from its tray icon (Quit), then press Enter' | Out-Null
  if (-not (Wait-ProfileFree)) { Say "Beeper still holds the profile - nothing changed$leftStopped"; Done ([ordered]@{ ok = $false; step = 'backup'; error = 'Beeper did not quit' }) 1 }
}
$backup = "$profileDir.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Say "backing up $profileDir -> $backup"
$null = robocopy $profileDir $backup /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) { Say "robocopy failed ($LASTEXITCODE) - nothing changed$leftStopped"; Done ([ordered]@{ ok = $false; step = 'backup'; error = "robocopy exit $LASTEXITCODE" }) 1 }
$backupMb = Get-Mb $backup
Say "backup: $backup ($backupMb MB)"

# 2 window - as the desktop user, never elevated: explorer opens a shortcut that carries the arguments
$winArgs = Get-BeeperWindowArgs $profileDir $AppData
$winLnk = Join-Path $EgptHome 'state\beeper-share-window.lnk'
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($winLnk)
$lnk.TargetPath = $exe
$lnk.Arguments = $winArgs
$lnk.Save()
Start-Process explorer.exe -ArgumentList "`"$winLnk`""
$port = $null
$deadline = (Get-Date).AddSeconds(120)
while (-not $port -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $mine = @(Select-BeeperProfileProcesses (Get-CimInstance Win32_Process -Filter "Name='Beeper.exe'" | Where-Object { $_.SessionId -ne 0 }) $profileDir | ForEach-Object { $_.ProcessId })
  # A main process with no --user-data-dir runs the default profile: the window's only when no arguments were needed.
  $main = if ($winArgs) { @() } else { @(Get-CimInstance Win32_Process -Filter "Name='Beeper.exe'" | Where-Object { $_.SessionId -ne 0 -and [string]$_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.ProcessId }) }
  $port = (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $BeeperApiPorts -contains $_.LocalPort -and ($mine + $main) -contains $_.OwningProcess } | Select-Object -First 1).LocalPort
}
Remove-Item -LiteralPath $winLnk -ErrorAction SilentlyContinue
if (-not $port) { Say "Beeper's API did not come up in 120 s - nothing else changed (backup kept)$leftStopped"; Done ([ordered]@{ ok = $false; step = 'window'; error = 'no API port'; profileBackup = $backup }) 1 }
Say "Beeper is up on port $port"

# 3 token - a kept token is checked first; then the record, so -Revert can undo every step from here on
if ($keep) {
  $token = (Get-BeeperTokens -RepoRoot (Split-Path -Parent $PSScriptRoot) -EgptHome $EgptHome)['primary']
  if (-not $token -or (Find-BeeperPort $token) -ne $port) {
    Say "beeper.primary.token does not answer on $port (the window on $profileDir) - nothing else changed (backup kept)$leftStopped"
    Done ([ordered]@{ ok = $false; step = 'token'; error = "the kept token does not answer on $port"; profileBackup = $backup }) 1
  }
  Say "beeper.primary.token answers on ${port}: kept"
}
$configBackup = "$configPath.bak-share-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $configPath -Destination $configBackup
[ordered]@{
  at = (Get-Date).ToString('o'); service = $ServiceName; profile = $profileDir; appParameters = $state.service.appParameters
  stopConsole = $state.service.stopConsole; preHook = $state.service.preHook; objectName = $state.service.account
  runValue = $state.runValue; configBackup = $configBackup; profileBackup = $backup; profileBackupMB = $backupMb
} | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding ascii
if (-not $keep) {
  Say 'click Approve on the eGPT request in your Beeper window'
  $minted = (& node (Join-Path (Split-Path -Parent $PSScriptRoot) 'src\tools\beeper-mint-token.mjs') --port $port --name egpt-window --json) -join "`n"
  $token = try { ($minted | ConvertFrom-Json).token } catch { $null }
  if (-not $token) { throw 'no token minted (see above); revert with -Revert' }
  $token | & node (Join-Path $PSScriptRoot 'set-beeper-token.mjs') primary --config $configPath
  if ($LASTEXITCODE -ne 0) { throw 'config.yaml was NOT changed (see the line above); revert with -Revert' }
  if ((Find-BeeperPort $token) -ne $port) { throw "the new token does not answer on $port; revert with -Revert" }
}

# 4 config
& node (Join-Path $PSScriptRoot 'beeper-share-config.mjs') remove-gui --config $configPath
if ($LASTEXITCODE -ne 0) { throw 'beeper.primary_gui was NOT removed; revert with -Revert' }
if (Test-EgptSpineLive $EgptHome) { Send-EgptIngestLine $EgptHome '/restart'; Say 'spine: /restart (it waits for turns in progress, then binds the window)' }

# 5 service - the account stays LocalSystem (see the header); one that already runs the profile keeps its AppParameters
Stop-ShareService
if (-not $keep) { Set-Nssm AppParameters (Get-BeeperServiceArgLine $profileDir) }
# From here on a failure is something -Resume finishes: the rest of 5, then 6 reconciler, 7 logon, 8 launcher
Invoke-ShareTail @('service', 'reconciler', 'logon', 'launcher')
Say "done. Beeper stays yours while it is open; Quit it from the tray and $ServiceName takes the profile in ~10-30 s."
Say "profile backup: $backup ($backupMb MB). Undo: share-beeper-primary-profile.cmd -Revert"
Say "optional: beeper-services-run-as-user.cmd runs the Beeper services as you instead of LocalSystem"
Done ([ordered]@{ ok = $true; profileBackup = $backup; profileBackupMB = $backupMb; port = $port })
} catch {
  Say "FAILED: $($_.Exception.Message)"
  Done ([ordered]@{ ok = $false; step = 'run'; error = $_.Exception.Message }) 1
}
