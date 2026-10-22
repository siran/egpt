# beeper-services-run-as-user.ps1 - run this machine's Beeper services as the desktop user instead
# of LocalSystem (-Revert: back). Per service, any node, independent of the one-profile conversion.
#
# Refused per service, before anything changes:
#   - no --user-data-dir: as the user it would open the user's DEFAULT Beeper profile, the one the
#     operator's own window runs - two instances of one device. (The primary: convert it first,
#     share-beeper-primary-profile.cmd, which gives it that profile behind its guards.)
#   - not LocalSystem now; no token for its connection (its return could not be checked)
#   - its profile held by the window (quit Beeper from the tray first: the profile is backed up)
#   - an entry in its profile that does not give the user full control
# Then: the password (a dialog; checked with a service logon before anything changes; never
# stored, logged or put on a command line), SeServiceLogonRight (recorded when this added it), and
# per service: hold the spine, stop, back the profile up beside it, log on as the user, start, wait
# for its token to answer. One that does not come back goes back to LocalSystem by itself.
#
#   beeper-services-run-as-user.cmd [-DryRun] [-Revert] [-ServiceName egpt-beeper-secondary]
#   -StateFile <json>   plan from a recorded machine, not this one (tests); implies -DryRun
# ASCII ONLY: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI.
[CmdletBinding()]
param(
  [string[]] $ServiceName,
  # Carried through UAC, which may log in as another account.
  [string] $UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
  [string] $UserName = ".\$env:USERNAME",
  [string] $AppData = $env:APPDATA,
  [string] $LocalAppData = $env:LOCALAPPDATA,
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

# One service: switch, skip or refuse, and why. Pure.
function Get-RunAsRow($v, [string] $User) {
  $row = [ordered]@{ service = $v.name; action = 'refuse'; reason = $null }
  if ((Split-BeeperAccount $v.account).account -ieq (Split-BeeperAccount $User).account) { $row.action = 'skip'; $row.reason = "already runs as $User"; return $row }
  $row.reason = if ($v.account -ne 'LocalSystem') { "runs as $($v.account); only LocalSystem is switched" }
    elseif (-not $v.udd) { "no --user-data-dir: as $User it would open $User's own default profile, the one your Beeper window runs - two instances of one device. Convert it first (share-beeper-primary-profile.cmd)" }
    elseif (-not $v.uddExists) { "its profile is not there: $($v.udd)" }
    elseif (-not $v.hasToken) { "config.yaml has no token for '$($v.connection)', so its return could not be checked" }
    elseif ($v.state -ne 'Running' -and $v.lockHeld) { 'your Beeper window holds its profile: quit Beeper from the tray first, so the profile can be backed up' }
    elseif ($v.aclGaps -gt 0) { "$($v.aclGaps) entries in its profile do not give $User full control (first: $($v.firstGap))" }
    else { $null }
  if (-not $row.reason) { $row.action = 'switch'; $row.reason = "$($v.udd) ($($v.profileMB) MB)" }
  return $row
}

# The plan, from a machine state (Read-RunAsState, or -StateFile). Pure: tests feed it states.
function Get-RunAsPlan($s, [bool] $Revert) {
  $refuse = { param($step, $err, $remedy) [ordered]@{ ok = $false; step = $step; error = $err; remedy = $remedy } }
  if ($Revert) {
    if (-not $s.record) { return & $refuse 'record' "no record at $($s.recordPath) - nothing to revert" $null }
    $names = @($s.record.services.PSObject.Properties | ForEach-Object { $_.Name })
    $steps = @($names | ForEach-Object { "${_}: hold the spine, stop, log on as LocalSystem, start, wait for its token, release (its backup stays at $($s.record.services.$_.backup))" })
    $steps += "logon right: remove $BeeperServiceLogonRight from $($s.record.user): $([bool]$s.record.rightAdded) (only what this script added)"
    return [ordered]@{ ok = $true; revert = $true; rows = @(); steps = $steps }
  }
  if ($s.record) { return & $refuse 'record' "already recorded at $($s.recordPath)" 'run with -Revert first' }
  $rows = @($s.services | ForEach-Object { Get-RunAsRow $_ $s.user })
  $switch = @($rows | Where-Object { $_.action -eq 'switch' })
  if (-not $switch.Count) { $p = & $refuse 'nothing' 'no service can be switched' $null; $p.rows = $rows; return $p }
  $right = if ($null -eq $s.rightHeld) { 'checked when it runs (elevated)' } else { [string](-not $s.rightHeld) }
  $steps = @(
    "credential: ask for $($s.user)'s password (a dialog; never stored, logged or put on a command line), check it with a service logon before anything changes",
    "logon right: grant $BeeperServiceLogonRight to $($s.user): $right (recorded, so -Revert removes only what this added)")
  $steps += @($switch | ForEach-Object { "$($_.service): hold the spine, stop, back up its profile beside it, log on as $($s.user), start, wait for its token (else back to LocalSystem), release" })
  return [ordered]@{ ok = $true; revert = $false; rows = $rows; steps = $steps }
}

if ($LoadFunctionsOnly) { return }

function Say($m) { Write-Host "[run-as-user] $m" }
function Done($o, [int] $code = 0) {
  Write-Output ($o | ConvertTo-Json -Compress -Depth 6)
  if ($Pause) { Write-Host ''; Write-Host 'Press Enter to close...' -ForegroundColor Cyan; try { Read-Host | Out-Null } catch { } }
  exit $code
}

$recordPath = Join-Path $EgptHome 'state\beeper-run-as-user.json'
$exe = Join-Path $LocalAppData 'Programs\BeeperTexts\Beeper.exe'

function Read-RunAsState {
  $elevated = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $tokens = Get-BeeperTokens -RepoRoot (Split-Path -Parent $PSScriptRoot) -EgptHome $EgptHome
  $wanted = @($ServiceName | ForEach-Object { $_ -split ',' } | Where-Object { $_ })   # one comma-joined string after UAC
  $services = foreach ($b in @(Get-BeeperServices $exe)) {
    if ($wanted.Count -and $wanted -notcontains $b.Name) { continue }
    $w = Get-CimInstance Win32_Service -Filter "Name='$($b.Name)'"
    $ap = [string](Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$($b.Name)\Parameters").AppParameters
    $udd = Get-BeeperUserDataDir $ap
    $v = [ordered]@{
      name = $b.Name; state = [string]$w.State; account = [string]$w.StartName; udd = $udd
      uddExists = [bool]($udd -and (Test-Path -LiteralPath $udd)); connection = ($b.Name -replace '^egpt-beeper-', '')
      lockHeld = $false; aclGaps = 0; firstGap = $null; profileMB = 0; shared = (Test-BeeperSharedProfile $ap $AppData)
    }
    $v.hasToken = $tokens.ContainsKey($v.connection)
    if ($v.uddExists) {
      $v.lockHeld = Test-BeeperLockHeld $udd
      if ($v.account -eq 'LocalSystem') {
        $gaps = @(Get-BeeperAclGaps $udd $UserSid)
        $v.aclGaps = $gaps.Count; if ($gaps.Count) { $v.firstGap = $gaps[0] }
        $v.profileMB = [Math]::Round(((Get-ChildItem -LiteralPath $udd -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB), 0)
      }
    }
    [pscustomobject]$v
  }
  return [pscustomobject][ordered]@{
    user = $UserName; sid = $UserSid; elevated = $elevated; spineLive = (Test-EgptSpineLive $EgptHome)
    rightHeld = $(if ($elevated) { Test-BeeperServiceLogonRight $UserSid } else { $null })
    recordPath = $recordPath; record = $(if (Test-Path -LiteralPath $recordPath) { Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json } else { $null })
    services = @($services)
  }
}

if ($StateFile) { $DryRun = $true; $state = Get-Content $StateFile -Raw | ConvertFrom-Json }
else { $state = Read-RunAsState }

if (-not $DryRun -and -not $state.elevated) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-UserSid', $UserSid, '-UserName', "`"$UserName`"", '-AppData', "`"$AppData`"", '-LocalAppData', "`"$LocalAppData`"", '-EgptHome', "`"$EgptHome`"", '-Pause')
  if ($ServiceName) { $a += @('-ServiceName', ($ServiceName -join ',')) }
  if ($Revert) { $a += '-Revert' }
  Say 'elevating...'
  Start-Process powershell -Verb RunAs -ArgumentList $a
  return
}

$plan = Get-RunAsPlan $state $Revert
foreach ($r in @($plan.rows)) { Say ("{0,-22} {1,-7} {2}" -f $r.service, $r.action, $r.reason) }
if (-not $plan.ok) {
  Say "refused ($($plan.step)): $($plan.error)"
  if ($plan.remedy) { Say "fix: $($plan.remedy)" }
  Done $plan 1
}
$i = 0
foreach ($line in $plan.steps) { $i++; Say "$i $line" }
if ($DryRun) { Say '-DryRun: nothing changed'; Done ([ordered]@{ ok = $true; dryRun = $true; revert = $plan.revert; rows = $plan.rows; steps = $plan.steps }) }

# --- the machinery ---------------------------------------------------------------------------
$tokens = Get-BeeperTokens -RepoRoot (Split-Path -Parent $PSScriptRoot) -EgptHome $EgptHome
function Save-Record($r) { $r | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $recordPath -Encoding ascii }
function Wait-Token([string] $Token, [int] $Sec = 90) {
  $deadline = (Get-Date).AddSeconds($Sec)
  while ((Get-Date) -lt $deadline) { $p = Find-BeeperPort $Token; if ($p) { return $p }; Start-Sleep -Seconds 2 }
  return $null
}
function Stop-AndRelease($v) {
  Stop-Service $v.name
  (Get-Service $v.name).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
  $deadline = (Get-Date).AddSeconds(30)
  while ((Test-BeeperLockHeld $v.udd) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Test-BeeperLockHeld $v.udd) { throw "$($v.name)'s Beeper still holds $($v.udd)" }
}
# One service onto $Credential's account ($null: LocalSystem), stopped and started around it when it
# runs; a shared profile is claimed meanwhile, so the SYSTEM reconciler leaves it alone.
function Switch-Service($v, [pscredential] $Credential, [switch] $Backup) {
  $token = $tokens[$v.connection]
  $was = [string](Get-Service $v.name).Status
  $held = Enter-EgptBeeperHold $EgptHome
  $claim = if ($v.shared) { Open-BeeperClaim (Get-BeeperClaimPath $v.udd) } else { $null }
  $out = [ordered]@{ ok = $false; backup = $null; backupMB = 0; port = $null }
  try {
    if ($was -eq 'Running') { Say "stopping $($v.name)"; Stop-AndRelease $v }
    if ($Backup) {
      $out.backup = "$($v.udd).backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
      $null = robocopy $v.udd $out.backup /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
      if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE) backing up $($v.udd)" }
      $out.backupMB = [Math]::Round(((Get-ChildItem -LiteralPath $out.backup -Recurse -File -Force | Measure-Object Length -Sum).Sum / 1MB), 0)
      Say "backup: $($out.backup) ($($out.backupMB) MB)"
    }
    Set-BeeperServiceAccount $v.name $Credential
    Say "$($v.name) logs on as $(if ($Credential) { $Credential.UserName } else { 'LocalSystem' })"
    if ($claim) { $claim.Dispose(); $claim = $null }
    if ($was -ne 'Running') { $out.ok = $true; Say "$($v.name) was $was - left so"; return $out }
    try { Start-Service $v.name } catch { Say "$($v.name) did not start: $($_.Exception.Message)" }
    $out.port = Wait-Token $token
    $out.ok = [bool]$out.port
    return $out
  } finally {
    if ($claim) { $claim.Dispose() }
    Exit-EgptBeeperHold $EgptHome $held $token
  }
}

try {
  if ($Revert) {
    $r = $state.record
    foreach ($name in @($r.services.PSObject.Properties | ForEach-Object { $_.Name })) {
      $v = $state.services | Where-Object { $_.name -eq $name } | Select-Object -First 1
      if (-not $v) { Say "$name is no longer a Beeper service here - skipped"; continue }
      $res = Switch-Service $v $null
      Say "$name back on LocalSystem: $(if ($res.ok) { 'up' } else { 'did NOT answer - check it' })"
    }
    if ($r.rightAdded) {
      $still = @(Get-CimInstance Win32_Service | Where-Object { (Split-BeeperAccount ([string]$_.StartName)).account -ieq (Split-BeeperAccount $r.user).account })
      if ($still.Count) { Say "kept ${BeeperServiceLogonRight}: $($still.Count) service(s) still log on as $($r.user)" }
      else { Set-BeeperServiceLogonRight $r.sid -Remove; Say "removed $BeeperServiceLogonRight from $($r.user)" }
    }
    Move-Item -LiteralPath $recordPath -Destination "$recordPath.reverted-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Done ([ordered]@{ ok = $true; revert = $true })
  }

  $cred = Get-Credential -UserName $UserName -Message "eGPT: the Windows password of $UserName, to run the Beeper services as that account. Checked here, never stored."
  if (-not $cred) { Say 'no credential given - nothing changed'; Done ([ordered]@{ ok = $false; step = 'credential'; error = 'cancelled' }) 1 }
  if ((Split-BeeperAccount $cred.UserName).account -ine (Split-BeeperAccount $UserName).account) { Say "that is not $UserName - nothing changed"; Done ([ordered]@{ ok = $false; step = 'credential'; error = 'another account' }) 1 }
  $verdict = Test-BeeperCredential $cred
  if (-not $verdict.ok) { Say "$($verdict.message) - nothing changed"; Done ([ordered]@{ ok = $false; step = 'credential'; error = $verdict.message }) 1 }

  $record = [ordered]@{ at = (Get-Date).ToString('o'); user = $UserName; sid = $UserSid; rightAdded = $false; services = [ordered]@{} }
  if (-not (Test-BeeperServiceLogonRight $UserSid)) {
    Set-BeeperServiceLogonRight $UserSid
    $record.rightAdded = $true
    Say "granted $BeeperServiceLogonRight to $UserName"
  }
  Save-Record $record
  $again = Test-BeeperCredential $cred
  if (-not $again.ok -or $again.rightMissing) { throw "a service logon as $UserName still fails after the right was granted ($(if ($again.message) { $again.message } else { 'a policy denies log on as a service?' })) - run -Revert" }

  $failed = 0
  foreach ($row in @($plan.rows | Where-Object { $_.action -eq 'switch' })) {
    $v = $state.services | Where-Object { $_.name -eq $row.service } | Select-Object -First 1
    $res = Switch-Service $v $cred -Backup
    if ($res.ok) {
      $record.services[$v.name] = [ordered]@{ previous = 'LocalSystem'; backup = $res.backup; backupMB = $res.backupMB }
      Save-Record $record
      Say "$($v.name): up as $UserName$(if ($res.port) { " on port $($res.port)" })"
    } else {
      $failed++
      Say "$($v.name) did not answer as $UserName in 90 s - putting it back on LocalSystem"
      $back = Switch-Service $v $null
      Say "$($v.name) on LocalSystem again: $(if ($back.ok) { 'up' } else { 'did NOT answer - check it' }) (its backup: $($res.backup))"
    }
  }
  if (-not $record.services.Count) {
    if ($record.rightAdded) { Set-BeeperServiceLogonRight $UserSid -Remove; Say "removed $BeeperServiceLogonRight again (nothing switched)" }
    Remove-Item -LiteralPath $recordPath
  }
  Done ([ordered]@{ ok = ($failed -eq 0); switched = @($record.services.Keys); failed = $failed }) $(if ($failed) { 1 } else { 0 })
} catch {
  Say "FAILED: $($_.Exception.Message)"
  Done ([ordered]@{ ok = $false; step = 'run'; error = $_.Exception.Message }) 1
}
