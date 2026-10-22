# install-nssm-service.ps1 - the node's Session 0 runner: the egpt-daemon NSSM service, which runs
# `node egpt-daemon.mjs` as the desktop user while nobody is logged on. At logon the Session 1 task
# egpt-daemon takes the node over; at logoff the service takes it back (src\daemon-singleton.mjs:
# state\runner.lock, state\s1.claim). Installs it, or brings an existing one up to date.
#
#   1 credential  the user's password in a dialog, checked with a service logon before anything
#                 changes; never stored, logged or put on a command line. SeServiceLogonRight if missing
#   2 host        a copy of nssm at <repo>\setup\bin\egpt-service.exe (winget installs nssm if missing)
#   3 service     reconfigured in place when that copy hosts it, else removed and installed again (an
#                 older install, e.g. dolly's host inside the profile). Automatic, as the user (never
#                 LocalSystem), AppExit Default Restart + 0 Exit: a STOP keeps it down
#   4 access      the user may stop and start it unelevated (one ACE)
#   5 backstop    egpt-s0-identity (S4U) registered when absent: it starts the service after a logoff
#   6 start       unless a STOP file, or a Session 1 daemon of older code (no state\s1.claim), is there
# At the console only: the password dialog hangs over ssh. Refuses to run the service from a tree
# that is not the deployed checkout (~\bin\egpt) unless -AllowThisTree (2026-09-11: edits went live).
#
#   install-nssm-service.cmd [-DryRun]
#   -StateFile <json>   plan from a recorded machine, not this one (tests); implies -DryRun
#   Remove: setup\uninstall-nssm-service.cmd (name egpt-daemon)
# ASCII ONLY: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI.
[CmdletBinding()]
param(
  [string] $EgptHome = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string] $ServiceName = '',
  [string] $Repo = '',
  # Carried through UAC, which may log in as another account.
  [string] $UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
  [string] $UserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
  [string] $Deployed = (Join-Path $env:USERPROFILE 'bin\egpt'),
  [switch] $AllowThisTree,
  [Alias('WhatIf')][switch] $DryRun,
  [string] $StateFile,
  [switch] $Pause,
  [switch] $LoadFunctionsOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'egpt-runners.ps1')

# One line each: what it is, whose profile, what stopping it costs (operator 2026-09-15).
function Get-S0ServiceLabels([string] $Name, [string] $EgptHome) {
  return [ordered]@{
    displayName = "eGPT runner, session 0 ($Name)"
    description = "eGPT spine supervisor (egpt-daemon.mjs) in session 0 for $EgptHome, as the desktop user: it runs the node while nobody is logged on; Session 1 takes over at logon. Stop it and a logged-off node goes silent."
  }
}

# The NSSM settings the service carries, each with what it has now (`set`: the nssm set arguments). Pure.
function Get-S0ServiceSettings($s) {
  $v = $s.service
  $logs = Join-Path $s.egptHome 'config\logs'
  $labels = Get-S0ServiceLabels $s.serviceName $s.egptHome
  $row = { param($name, $have, $want, $set) if (-not $set) { $set = @($name, [string]$want) }; [ordered]@{ name = $name; have = [string]$have; want = [string]$want; set = $set } }
  return @(
    (& $row 'Start' $v.startMode 'Auto' @('Start', 'SERVICE_AUTO_START')),
    (& $row 'DisplayName' $v.displayName $labels.displayName),
    (& $row 'Description' $v.description $labels.description),
    (& $row 'Application' $v.application $s.node),
    (& $row 'AppDirectory' $v.appDirectory $s.repo),
    (& $row 'AppParameters' $v.appParameters (Join-Path $s.repo 'egpt-daemon.mjs')),
    (& $row 'AppEnvironmentExtra' (@($v.env) -join ' + ') "EGPT_HOME=$($s.egptHome)"),
    (& $row 'AppStdout' $v.stdout (Join-Path $logs 'daemon-stdout.log')),
    (& $row 'AppStderr' $v.stderr (Join-Path $logs 'daemon-stderr.log')),
    (& $row 'AppStdoutCreationDisposition' $v.stdoutDisposition 4),
    (& $row 'AppStderrCreationDisposition' $v.stderrDisposition 4),
    (& $row 'AppRotateFiles' $v.rotateFiles 1),
    (& $row 'AppRotateOnline' $v.rotateOnline 1),
    (& $row 'AppRotateBytes' $v.rotateBytes 10485760),
    (& $row 'AppExit Default' $v.exitDefault 'Restart' @('AppExit', 'Default', 'Restart')),
    (& $row 'AppExit 0' $v.exit0 'Exit' @('AppExit', '0', 'Exit')),
    (& $row 'AppRestartDelay' $v.restartDelay 5000),
    (& $row 'AppStopMethodConsole' $v.stopConsole 10000))
}

# The plan, from a machine state (Read-S0ServiceState, or -StateFile). Pure: tests feed it states.
# A line starting with two spaces belongs to the step above it.
function Get-S0ServicePlan($s, [bool] $AllowThisTree = $false) {
  $refuse = { param($step, $err, $remedy) [ordered]@{ ok = $false; step = $step; error = $err; remedy = $remedy } }
  if ($s.sid -eq 'S-1-5-18' -or $s.user -match '(^|\\)(SYSTEM|LocalSystem)$|^NT AUTHORITY\\') {
    return & $refuse 'account' "the service never runs as $($s.user): it runs as the desktop user, who owns the profile and the claude login" "run it from the desktop user's own console"
  }
  if (-not $s.repoHasDaemon) { return & $refuse 'repo' "no egpt-daemon.mjs in $($s.repo)" $null }
  if ($s.deployedExists -and (ConvertTo-BeeperPathKey $s.repo) -ne (ConvertTo-BeeperPathKey $s.deployed) -and -not $AllowThisTree) {
    return & $refuse 'repo' "this would run $($s.serviceName) from $($s.repo), not the deployed checkout $($s.deployed): every uncommitted edit there would be live code on a serving node (2026-09-11)" "run $($s.deployed)\setup\install-nssm-service.cmd, or pass -AllowThisTree"
  }
  if (-not $s.node) { return & $refuse 'node' 'node.exe is not on the PATH' 'install Node.js' }
  $name = $s.serviceName
  $v = $s.service
  $hostExe = Join-Path $s.repo 'setup\bin\egpt-service.exe'
  $mode = if (-not $v.exists) { 'install' } elseif ((ConvertTo-BeeperPathKey ([string]$v.host)) -eq (ConvertTo-BeeperPathKey $hostExe)) { 'reconfigure' } else { 'reinstall' }
  $settings = @(Get-S0ServiceSettings $s)
  $right = if ($null -eq $s.rightHeld) { 'checked when it runs (elevated)' } else { [string](-not $s.rightHeld) }
  $steps = @(
    "credential: ask for $($s.account)'s password (a dialog at this console; never stored, logged or put on a command line), check it with a service logon before anything changes",
    "logon right: grant $BeeperServiceLogonRight to $($s.account): $right",
    $(if ($s.nssm) { "nssm: $($s.nssm)" } else { 'nssm: not on the PATH - install it with winget (NSSM.NSSM)' }),
    "host: $hostExe, $(if ($s.hostExists) { 'refreshed from nssm when older (kept while in use)' } else { 'a copy of nssm' })")
  if ($mode -eq 'reconfigure') {
    $steps += "service: reconfigure $name in place (its host is $hostExe)$(if ($v.state -ne 'Stopped') { "; stop it first, it is $($v.state)" })"
    $changed = @($settings | Where-Object { $_.have -ne $_.want })
    foreach ($c in $changed) {
      $note = if ($c.name -eq 'AppEnvironmentExtra' -and $c.have -match 'EGPT_HOMES=') { ' (EGPT_HOMES dropped: the multi-profile knob is retired)' } else { '' }
      $steps += "  set $($c.name): $(if ($c.have) { $c.have } else { '(none)' }) -> $($c.want)$note"
    }
    if (-not $changed.Count) { $steps += '  every setting is already as wanted' }
  } else {
    if ($mode -eq 'reinstall') { $steps += "service: stop and remove $name ($($v.state)): its host $($v.host) is not $hostExe - an older install (that copy and its logs stay where they are)" }
    $steps += "service: install $name - $hostExe runs $($s.node) $(Join-Path $s.repo 'egpt-daemon.mjs')"
    foreach ($c in $settings) { $steps += "  set $($c.name): $($c.want)" }
  }
  $was = if ($mode -eq 'reconfigure') { $v.account } else { 'LocalSystem, as nssm installs it' }
  $steps += "account: log on as $($s.account), its password set again (now $was); never LocalSystem"
  $steps += 'recovery: sc.exe failure - restart the host 5 s after it dies (an exit 0 is a clean stop, never a failure)'
  $ace = if ($mode -eq 'reconfigure' -and (Test-BeeperServiceAce ([string]$v.sddl) $s.sid)) { 'already there' } else { "add (A;;$BeeperServiceRights;;;$($s.sid))" }
  $steps += "access: $($s.account) may stop and start $name unelevated: $ace"
  $steps += if ($s.identityTask) { "backstop: egpt-s0-identity is registered - it starts $name after a logoff or a boot" }
    else { "backstop: register egpt-s0-identity as $($s.user) (S4U, every 2 min from now on, and at boot) - it starts $name after a logoff or a boot" }
  $start = Get-EgptServiceStartVerdict ([pscustomobject]@{ exists = $true; status = 'Stopped'; startMode = 'Auto'; stopFile = [bool]$s.stopFile; s1DaemonPid = $s.s1DaemonPid; s1Claimed = [bool]$s.s1Claimed })
  $steps += if ($start.start) { "start: $name - $($start.reason)" } else { "start: NOT started - $($start.reason)" }
  return [ordered]@{ ok = $true; mode = $mode; hostExe = $hostExe; settings = $settings; start = $start.start; steps = $steps }
}

if ($LoadFunctionsOnly) { return }

function Say($m) { Write-Host "[s0-service] $m" }
function Done($o, [int] $code = 0) {
  Write-Output ($o | ConvertTo-Json -Compress -Depth 6)
  if ($Pause) { Write-Host ''; Write-Host 'Press Enter to close...' -ForegroundColor Cyan; try { Read-Host | Out-Null } catch { } }
  exit $code
}

# ~\.egpt -> egpt-daemon: the Session 1 task's name (register-session1-daemon-task.ps1).
if (-not $ServiceName) {
  $base = (Split-Path $EgptHome -Leaf) -replace '^\.', ''
  if (-not $base) { throw "cannot derive a service name: -EgptHome is empty or has no leaf ('$EgptHome'). Pass -ServiceName explicitly." }
  $ServiceName = "$base-daemon"
}

# Read-only.
function Read-S0ServiceState {
  $root = if ($Repo) { (Resolve-Path $Repo).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
  $head = '?'; $dirty = 0
  $git = (Get-Command git -ErrorAction SilentlyContinue).Source
  if ($git) {
    $h = & $git -C $root rev-parse --short HEAD
    if ($LASTEXITCODE -eq 0 -and $h) { $head = ([string]$h).Trim() }
    $dirty = @(& $git -C $root status --porcelain --untracked-files=no).Count
  }
  $svc = [ordered]@{ exists = $false }
  $w = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if ($w) {
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
    $p = Get-ItemProperty $key -ErrorAction SilentlyContinue
    $exit = Get-Item "$key\AppExit" -ErrorAction SilentlyContinue
    $nssmDefault = { param($value, $default) if ($null -eq $value) { $default } else { $value } }
    $svc = [ordered]@{
      exists = $true; state = [string]$w.State; startMode = [string]$w.StartMode; account = [string]$w.StartName
      host = ([string]$w.PathName).Trim('"'); displayName = [string]$w.DisplayName; description = [string]$w.Description
      application = [string]$p.Application; appDirectory = [string]$p.AppDirectory; appParameters = [string]$p.AppParameters
      env = @($p.AppEnvironmentExtra | Where-Object { $_ }); stdout = [string]$p.AppStdout; stderr = [string]$p.AppStderr
      stdoutDisposition = (& $nssmDefault $p.AppStdoutCreationDisposition 4); stderrDisposition = (& $nssmDefault $p.AppStderrCreationDisposition 4)
      rotateFiles = $p.AppRotateFiles; rotateOnline = $p.AppRotateOnline; rotateBytes = $p.AppRotateBytes
      restartDelay = $p.AppRestartDelay; stopConsole = $p.AppStopMethodConsole
      exitDefault = $(if ($exit) { [string]$exit.GetValue('') } else { '' }); exit0 = $(if ($exit) { [string]$exit.GetValue('0') } else { '' })
      sddl = ((& sc.exe sdshow $ServiceName) -join '').Trim()
    }
  }
  $elevated = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $f = Read-EgptServiceFacts $ServiceName $EgptHome
  return [pscustomobject][ordered]@{
    serviceName = $ServiceName; repo = $root; repoHasDaemon = (Test-Path -LiteralPath (Join-Path $root 'egpt-daemon.mjs')); repoHead = $head; repoDirty = $dirty
    deployed = $Deployed; deployedExists = (Test-Path -LiteralPath (Join-Path $Deployed 'egpt-daemon.mjs')); egptHome = $EgptHome
    node = (Get-Command node -ErrorAction SilentlyContinue).Source; nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
    hostExists = (Test-Path -LiteralPath (Join-Path $root 'setup\bin\egpt-service.exe'))
    user = $UserName; account = (Split-BeeperAccount $UserName).account; sid = $UserSid
    elevated = $elevated; rightHeld = $(if ($elevated) { Test-BeeperServiceLogonRight $UserSid } else { $null })
    service = [pscustomobject]$svc
    stopFile = $f.stopFile; s1DaemonPid = $f.s1DaemonPid; s1Claimed = $f.s1Claimed
    identityTask = [bool](Get-ScheduledTask -TaskName 'egpt-s0-identity' -ErrorAction SilentlyContinue)
  }
}

if ($StateFile) { $DryRun = $true; $state = Get-Content $StateFile -Raw | ConvertFrom-Json }
else { $state = Read-S0ServiceState }
$ServiceName = $state.serviceName

$plan = Get-S0ServicePlan $state ([bool]$AllowThisTree)
Say "service : $ServiceName"
Say "repo    : $($state.repo) (HEAD $($state.repoHead), $(if ($state.repoDirty) { "DIRTY: $($state.repoDirty) tracked file(s) differ from HEAD and would run" } else { 'clean' }))"
Say "profile : $($state.egptHome) (EGPT_HOME)"
Say "user    : $($state.account) ($($state.sid))"
if (-not $plan.ok) {
  Say "refused ($($plan.step)): $($plan.error)"
  if ($plan.remedy) { Say "fix: $($plan.remedy)" }
  Done $plan 1
}
$i = 0
foreach ($line in $plan.steps) { if ($line.StartsWith('  ')) { Say "   $($line.TrimStart())" } else { $i++; Say "$i $line" } }
if ($DryRun) { Say '-DryRun: nothing changed'; Done ([ordered]@{ ok = $true; dryRun = $true; mode = $plan.mode; start = $plan.start; steps = $plan.steps }) }

if (-not $state.elevated) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-EgptHome', "`"$EgptHome`"", '-ServiceName', $ServiceName,
    '-Repo', "`"$($state.repo)`"", '-UserSid', $UserSid, '-UserName', "`"$UserName`"", '-Deployed', "`"$Deployed`"", '-Pause')
  if ($AllowThisTree) { $a += '-AllowThisTree' }
  Say 'elevating...'
  Start-Process powershell -Verb RunAs -ArgumentList $a
  return
}

# --- the machinery ---------------------------------------------------------------------------
$nssm = $state.nssm
function Set-Nssm([string[]] $SetArgs) {
  & $nssm set $ServiceName @SetArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "nssm could not set $($SetArgs -join ' ') on $ServiceName" }
}
function Stop-S0Service {
  $s = Get-Service $ServiceName
  if ($s.Status -eq 'Stopped') { return }
  Say "stopping $ServiceName"
  Stop-Service $ServiceName -Force
  $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
}

try {
  $cred = Get-Credential -UserName $state.account -Message "eGPT: the Windows password of $($state.account), to run the $ServiceName service as that account. Checked here, never stored."
  if (-not $cred) { Say 'no credential given - nothing changed'; Done ([ordered]@{ ok = $false; step = 'credential'; error = 'cancelled' }) 1 }
  if ((Split-BeeperAccount $cred.UserName).account -ine $state.account) { Say "that is not $($state.account) - nothing changed"; Done ([ordered]@{ ok = $false; step = 'credential'; error = 'another account' }) 1 }
  $verdict = Test-BeeperCredential $cred
  if (-not $verdict.ok) { Say "$($verdict.message) - nothing changed"; Done ([ordered]@{ ok = $false; step = 'credential'; error = $verdict.message }) 1 }
  if (-not (Test-BeeperServiceLogonRight $state.sid)) { Set-BeeperServiceLogonRight $state.sid; Say "granted $BeeperServiceLogonRight to $($state.account)" }
  $again = Test-BeeperCredential $cred
  if (-not $again.ok -or $again.rightMissing) { throw "a service logon as $($state.account) still fails after the right was granted ($(if ($again.message) { $again.message } else { 'a policy denies log on as a service?' }))" }

  if (-not $nssm) {
    Say 'nssm is not on the PATH - installing it with winget'
    & winget install --id NSSM.NSSM --silent --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
    if (-not $nssm) { throw 'winget did not put nssm on the PATH - install it from https://nssm.cc/download and run this again' }
  }
  # The host copy: Task Manager shows egpt-service.exe, not nssm.exe. A copy in use is kept.
  $hostExe = $plan.hostExe
  New-Item -ItemType Directory -Force -Path (Split-Path $hostExe) | Out-Null
  $src = Get-Item $nssm
  if ($src.LinkType) { $src = Get-Item (@($src.Target)[0]) }   # winget's Links\nssm.exe is a link
  if (-not (Test-Path $hostExe) -or (Get-Item $hostExe).Length -ne $src.Length -or (Get-Item $hostExe).LastWriteTime -lt $src.LastWriteTime) {
    try { Copy-Item -LiteralPath $src.FullName -Destination $hostExe -Force }
    catch { if (-not (Test-Path $hostExe)) { throw }; Say "note: $hostExe is in use - kept as it is" }
  }

  if ($plan.mode -eq 'reinstall') {
    Stop-S0Service
    Say "removing $ServiceName (an older install, host $($state.service.host))"
    & $nssm remove $ServiceName confirm | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "nssm could not remove $ServiceName" }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Service $ServiceName -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (Get-Service $ServiceName -ErrorAction SilentlyContinue) { throw "$ServiceName is still registered 30 s after its removal (marked for deletion: close the Services console, then run this again)" }
  }
  if ($plan.mode -eq 'reconfigure') { Stop-S0Service }
  else {
    Say "installing $ServiceName (host $hostExe)"
    & $hostExe install $ServiceName $state.node (Join-Path $state.repo 'egpt-daemon.mjs') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "nssm could not install $ServiceName" }
  }
  foreach ($c in $plan.settings) { Set-Nssm $c.set }
  Set-BeeperServiceAccount $ServiceName $cred
  Say "$ServiceName logs on as $($state.account), Automatic, AppExit 0 = Exit"
  & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc.exe failure $ServiceName exited $LASTEXITCODE" }
  & sc.exe failureflag $ServiceName 1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc.exe failureflag $ServiceName exited $LASTEXITCODE" }
  Set-BeeperServiceAccess -Name $ServiceName -Sid $state.sid

  $logs = Join-Path $state.egptHome 'config\logs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  if (-not (Get-ScheduledTask -TaskName 'egpt-s0-identity' -ErrorAction SilentlyContinue)) {
    & (Join-Path $PSScriptRoot 'register-s0-identity-task.ps1') -LogPath (Join-Path $logs 's0-identity.log') -UserId $state.user -EgptHome $state.egptHome
  }

  $go = Get-EgptServiceStartVerdict (Read-EgptServiceFacts $ServiceName $state.egptHome) -AutoOnly
  if ($go.start) { Start-Service $ServiceName; Say "started $ServiceName - $($go.reason)" }
  else { Say "$ServiceName NOT started - $($go.reason)" }
  Done ([ordered]@{ ok = $true; mode = $plan.mode; started = $go.start })
} catch {
  Say "FAILED: $($_.Exception.Message)"
  Done ([ordered]@{ ok = $false; step = 'run'; error = $_.Exception.Message }) 1
}
