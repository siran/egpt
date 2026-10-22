# share-beeper-primary-profile.ps1 - run the primary account from ONE Beeper profile: the
# operator's own window profile. The window runs it in Session 1 while Beeper is open; the
# egpt-beeper-primary service runs it in Session 0 otherwise; never both (beeper-desktop.ps1,
# "one profile, two runtimes"). One device, one token: beeper.primary_gui goes away.
#
#   1 backup      Beeper quit (tray > Quit), then a full copy of the profile beside it
#   2 window      Beeper opened again; wait for its API
#   3 token       a token minted on the window (one Approve click there) -> beeper.primary.token
#   4 config      beeper.primary_gui removed; /restart, so the spine binds the window
#   5 service     egpt-beeper-primary stopped (its old system-profile device) and pointed at the
#                 window profile, with a 10 s Ctrl+C grace and the NSSM Start/Pre hook
#   6 reconciler  egpt-s0-identity (SYSTEM) registered
#   7 logon       Beeper's own Run value replaced by beeper-window.vbs, plus a "Beeper (eGPT)" shortcut
#   8 launcher    beeper-window started: it claims the profile and watches the window
# The record of what it replaced (state\beeper-share.json) is written before step 3.
# -Revert undoes 8..3 from that record and names the profile backup. It starts the old service
# device again, which only works until the operator logs that device out.
# The service keeps its LocalSystem log-on. Running it as the desktop user is a separate, optional
# step after this one: beeper-services-run-as-user.cmd (-Revert here needs it reverted first).
#
#   share-beeper-primary-profile.cmd [-DryRun] [-Revert]
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

# The plan, from a machine state (Read-ShareState, or -StateFile). Pure: tests feed it states.
function Get-SharePlan($s, [bool] $Revert) {
  $refuse = { param($step, $err, $remedy) [ordered]@{ ok = $false; step = $step; error = $err; remedy = $remedy } }
  if (-not $s.service.exists) { return & $refuse 'service' "no service named $($s.serviceName)" $null }
  if ($Revert) {
    if (-not $s.record) { return & $refuse 'record' "no record at $($s.recordPath) - nothing to revert" $null }
    # Back to no --user-data-dir while it logs on as the user = that user's own window profile, twice.
    if ($s.service.account -ne 'LocalSystem') { return & $refuse 'account' "$($s.serviceName) logs on as $($s.service.account)" 'run beeper-services-run-as-user.cmd -Revert first' }
    return [ordered]@{ ok = $true; revert = $true; steps = @(
      "launcher: stop beeper-window (it releases the claim)",
      "logon: remove the $RunKeyWindow Run value and the shortcut; restore Beeper's own Run value: $([bool]$s.record.runValue)",
      'reconciler: unregister egpt-s0-identity',
      "service: stop $($s.serviceName); AppParameters back to '$($s.record.appParameters)'; Start/Pre hook and Ctrl+C grace back",
      "config: beeper.primary.token and beeper.primary_gui back from $($s.record.configBackup)",
      "service: start $($s.serviceName) (its old device - only if not logged out since)",
      'spine: /restart',
      "backup: the profile backup stays at $($s.record.profileBackup) ($($s.record.profileBackupMB) MB)") }
  }
  if ($s.record) { return & $refuse 'record' "a conversion is already recorded at $($s.recordPath)" 'run with -Revert first' }
  if ($s.service.account -ne 'LocalSystem') { return & $refuse 'account' "$($s.serviceName) runs as $($s.service.account); this conversion keeps LocalSystem" $null }
  if (Test-BeeperSharedProfile $s.service.appParameters $s.appData) { return & $refuse 'shared' "$($s.serviceName) already runs $($s.profile)" 'nothing to do (-Revert undoes it)' }
  if (-not $s.profileExists) { return & $refuse 'profile' "no Beeper profile at $($s.profile)" $null }
  if (-not $s.hooks) { return & $refuse 'nssm' "NSSM $($s.service.nssmVersion) has no Start/Pre hooks" 'install NSSM 2.24-101 or later' }
  if (-not $s.config.primary) { return & $refuse 'config' 'config.yaml has no beeper.primary block' $null }
  $open = if ($s.windowUp) { 'Beeper is open: you will be asked to quit it (tray > Quit) first' } else { 'Beeper is closed' }
  return [ordered]@{ ok = $true; revert = $false; steps = @(
    "backup: $open; copy $($s.profile) to $($s.profile).backup-<time>",
    'window: open Beeper again and wait for its API',
    "token: write $($s.recordPath); mint a token on the window (click Approve there) -> beeper.primary.token",
    "config: remove beeper.primary_gui: $([bool]$s.config.primaryGui); spine /restart: $([bool]$s.spineLive)",
    "service: stop $($s.serviceName); AppParameters -> $(Get-BeeperServiceArgLine $s.profile); AppStopMethodConsole $StopGraceMs; AppEvents Start/Pre -> s0-identity-reconcile.ps1 -PreStart",
    'reconciler: register egpt-s0-identity (SYSTEM, at boot and every 2 min)',
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
  $profileDir = Get-BeeperDefaultProfile $AppData
  $s = [ordered]@{
    serviceName = $ServiceName; appData = $AppData; profile = $profileDir; profileExists = (Test-Path -LiteralPath $profileDir)
    recordPath = $recordPath; record = $null; hooks = $false; spineLive = (Test-EgptSpineLive $EgptHome)
    elevated = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    service = [ordered]@{ exists = [bool]$svc }
    windowUp = $false; runValue = $null; config = [ordered]@{}
  }
  if (Test-Path -LiteralPath $recordPath) { $s.record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json }
  if ($svc) {
    $script:nssm = $svc.PathName.Trim('"')
    $par = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
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
  $s.runValue = (Get-ItemProperty $runKey -ErrorAction SilentlyContinue).$RunKeyBeeper
  $names = Get-BeeperTokens -RepoRoot (Split-Path -Parent $PSScriptRoot) -EgptHome $EgptHome
  $s.config = [ordered]@{ primary = $names.ContainsKey('primary'); primaryGui = $names.ContainsKey('primary_gui') }
  return $s
}

if ($StateFile) { $DryRun = $true; $state = Get-Content $StateFile -Raw | ConvertFrom-Json }
else { $state = Read-ShareState }

if (-not $DryRun -and -not $state.elevated) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-ServiceName', $ServiceName, '-AppData', "`"$AppData`"", '-LocalAppData', "`"$LocalAppData`"", '-UserSid', $UserSid, '-EgptHome', "`"$EgptHome`"", '-Pause')
  if ($Revert) { $a += '-Revert' }
  Say 'elevating...'
  Start-Process powershell -Verb RunAs -ArgumentList $a
  return
}

$plan = Get-SharePlan $state $Revert
if (-not $plan.ok) {
  Say "refused ($($plan.step)): $($plan.error)"
  if ($plan.remedy) { Say "fix: $($plan.remedy)" }
  Done $plan 1
}
$i = 0
foreach ($line in $plan.steps) { $i++; Say "$i $line" }
if ($DryRun) { Say '-DryRun: nothing changed'; Done ([ordered]@{ ok = $true; dryRun = $true; revert = $plan.revert; steps = $plan.steps }) }

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
$profileDir = $state.profile
$exe = $state.service.exe
$launcherVbs = Join-Path $PSScriptRoot 'beeper-window.vbs'

try {
if ($Revert) {
  $r = $state.record
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { [string]$_.CommandLine -match 'beeper-window\.ps1' } |
    ForEach-Object { Say "stopping beeper-window (pid $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force }
  Remove-ItemProperty -Path $runKey -Name $RunKeyWindow -ErrorAction SilentlyContinue
  if ($r.runValue) { Set-ItemProperty -Path $runKey -Name $RunKeyBeeper -Value $r.runValue }
  if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
  & (Join-Path $PSScriptRoot 'register-s0-identity-task.ps1') -Remove
  Stop-ShareService
  Set-Nssm AppParameters $r.appParameters
  Set-Nssm AppStopMethodConsole $r.stopConsole
  Set-NssmHook $r.preHook
  & node (Join-Path $PSScriptRoot 'beeper-share-config.mjs') restore --from $r.configBackup --config $configPath
  if ($LASTEXITCODE -ne 0) { throw 'config.yaml was NOT restored (see the line above)' }
  Say "starting $ServiceName (its old device)"
  Start-Service $ServiceName
  if (Test-EgptSpineLive $EgptHome) { Send-EgptIngestLine $EgptHome '/restart' }
  Move-Item -LiteralPath $recordPath -Destination "$recordPath.reverted-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Say "reverted. The profile backup is still at $($r.profileBackup) ($($r.profileBackupMB) MB): restore it by hand only if the profile itself is damaged."
  Done ([ordered]@{ ok = $true; revert = $true; profileBackup = $r.profileBackup })
}

# 1 backup - with Beeper quit, so the copy is consistent
if ($state.windowUp -or (Test-BeeperLockHeld $profileDir)) {
  Read-Host '[share] Quit Beeper from its tray icon (Quit), then press Enter' | Out-Null
  $deadline = (Get-Date).AddSeconds(30)
  while ((Test-BeeperLockHeld $profileDir) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Test-BeeperLockHeld $profileDir) { Say 'Beeper still holds the profile - nothing changed'; Done ([ordered]@{ ok = $false; step = 'backup'; error = 'Beeper did not quit' }) 1 }
}
$backup = "$profileDir.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Say "backing up $profileDir -> $backup"
$null = robocopy $profileDir $backup /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) { Say "robocopy failed ($LASTEXITCODE) - nothing changed"; Done ([ordered]@{ ok = $false; step = 'backup'; error = "robocopy exit $LASTEXITCODE" }) 1 }
$backupMb = Get-Mb $backup
Say "backup: $backup ($backupMb MB)"

# 2 window - as the desktop user, never elevated
Start-Process explorer.exe -ArgumentList "`"$exe`""
$port = $null
$deadline = (Get-Date).AddSeconds(120)
while (-not $port -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $mine = @(Select-BeeperProfileProcesses (Get-CimInstance Win32_Process -Filter "Name='Beeper.exe'" | Where-Object { $_.SessionId -ne 0 }) $profileDir | ForEach-Object { $_.ProcessId })
  $main = @(Get-CimInstance Win32_Process -Filter "Name='Beeper.exe'" | Where-Object { $_.SessionId -ne 0 -and [string]$_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.ProcessId })
  $port = (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $BeeperApiPorts -contains $_.LocalPort -and ($mine + $main) -contains $_.OwningProcess } | Select-Object -First 1).LocalPort
}
if (-not $port) { Say "Beeper's API did not come up in 120 s - nothing else changed (backup kept)"; Done ([ordered]@{ ok = $false; step = 'window'; error = 'no API port'; profileBackup = $backup }) 1 }
Say "Beeper is up on port $port"

# 3 token - the record first, so -Revert can undo every step from here on
$configBackup = "$configPath.bak-share-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $configPath -Destination $configBackup
[ordered]@{
  at = (Get-Date).ToString('o'); service = $ServiceName; appParameters = $state.service.appParameters
  stopConsole = $state.service.stopConsole; preHook = $state.service.preHook; objectName = $state.service.account
  runValue = $state.runValue; configBackup = $configBackup; profileBackup = $backup; profileBackupMB = $backupMb
} | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding ascii
Say 'click Approve on the eGPT request in your Beeper window'
$minted = (& node (Join-Path (Split-Path -Parent $PSScriptRoot) 'src\tools\beeper-mint-token.mjs') --port $port --name egpt-window --json) -join "`n"
$token = try { ($minted | ConvertFrom-Json).token } catch { $null }
if (-not $token) { throw 'no token minted (see above); revert with -Revert' }
$token | & node (Join-Path $PSScriptRoot 'set-beeper-token.mjs') primary --config $configPath
if ($LASTEXITCODE -ne 0) { throw 'config.yaml was NOT changed (see the line above); revert with -Revert' }
if ((Find-BeeperPort $token) -ne $port) { throw "the new token does not answer on $port; revert with -Revert" }

# 4 config
& node (Join-Path $PSScriptRoot 'beeper-share-config.mjs') remove-gui --config $configPath
if ($LASTEXITCODE -ne 0) { throw 'beeper.primary_gui was NOT removed; revert with -Revert' }
if (Test-EgptSpineLive $EgptHome) { Send-EgptIngestLine $EgptHome '/restart'; Say 'spine: /restart (it waits for turns in progress, then binds the window)' }

# 5 service - the account stays LocalSystem (see the header)
Stop-ShareService
Set-Nssm AppParameters (Get-BeeperServiceArgLine $profileDir)
Set-Nssm AppStopMethodConsole "$StopGraceMs"
Set-NssmHook "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 's0-identity-reconcile.ps1')`" -PreStart -LogPath `"$hookLog`""

# 6 reconciler
& (Join-Path $PSScriptRoot 'register-s0-identity-task.ps1') -ServiceName $ServiceName -LogPath $hookLog

# 7 logon
Remove-ItemProperty -Path $runKey -Name $RunKeyBeeper -ErrorAction SilentlyContinue
Set-ItemProperty -Path $runKey -Name $RunKeyWindow -Value "`"$env:SystemRoot\System32\wscript.exe`" //B //Nologo `"$launcherVbs`""
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
$lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$lnk.Arguments = "//B //Nologo `"$launcherVbs`""
$lnk.IconLocation = "$exe,0"
$lnk.Save()

# 8 launcher - as the desktop user
Start-Process explorer.exe -ArgumentList "`"$shortcut`""
Say "done. Beeper stays yours while it is open; Quit it from the tray and $ServiceName takes the profile in ~10-30 s."
Say "profile backup: $backup ($backupMb MB). Undo: share-beeper-primary-profile.cmd -Revert"
Say "optional: beeper-services-run-as-user.cmd runs the Beeper services as you instead of LocalSystem"
Done ([ordered]@{ ok = $true; profileBackup = $backup; profileBackupMB = $backupMb; port = $port })
} catch {
  Say "FAILED: $($_.Exception.Message)"
  Done ([ordered]@{ ok = $false; step = 'run'; error = $_.Exception.Message }) 1
}
