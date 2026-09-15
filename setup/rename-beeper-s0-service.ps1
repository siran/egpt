# rename-beeper-s0-service.ps1 - rename a Session 0 Beeper service, preserving its configuration.
#
# NSSM CANNOT RENAME, and neither can sc.exe - there is no rename verb anywhere, so a rename is
# delete-and-recreate. That is the whole risk: between the two the Desktop is DOWN, so renaming
# the service that holds the account currently answering takes the agents off the air for the
# duration. Rename the idle one first, verify, then the live one.
#
# WHY IT EXISTS: the first two services here were created BY HAND and named after the operator's
# own accounts, then hand-renamed to `egpt-primary` / `egpt-secondary` - which reads like a third
# and fourth eGPT spine sitting beside `egpt-daemon`, and is not. They are Beeper Desktops.
# Stopping `egpt-primary` does not stop a spine; it takes a WhatsApp account offline. The shipped
# names now SAY WHAT THE PROCESS IS - `egpt-beeper-primary` / `egpt-beeper-secondary` - and
# setup\beeper-s0-naming.ps1 owns them along with the one-line labels that go beside them.
#
#   .\setup\rename-beeper-s0-service.ps1 -From egpt-primary -To egpt-beeper-primary -WhatIf
#   .\setup\rename-beeper-s0-service.ps1 -From egpt-primary -To egpt-beeper-primary
#
# NOTHING IS DROPPED, AND NOTHING IS DESTROYED BEFORE THE REPLACEMENT EXISTS.
#
# The first version of this script carried a HAND-PICKED list of nine parameters, which is
# exactly how a rename loses one: it silently dropped Description, AppEnvironmentExtra, the
# AppExit actions, AppThrottle, the AppStopMethod timeouts, the log rotation settings, the
# stdout/stderr creation dispositions and the SCM failure actions. A service can carry any of
# those and these two do. So it no longer enumerates: it copies the old service's ENTIRE
# `Parameters` registry subtree - every value, every type, every subkey - and then carries the
# service-key settings NSSM does not own (failure actions, delayed autostart, dependencies)
# beside it. Only two things are deliberately NOT copied verbatim:
#
#   - AppStdout / AppStderr - the log path usually embeds the service name, so the name is
#     substituted. Otherwise the renamed service keeps writing to the old file.
#   - DisplayName / Description - re-stamped from beeper-s0-naming.ps1 for the NEW name. Copying
#     them would leave `egpt-beeper-primary` still displaying "Beeper Desktop-s0-primary" and the
#     old prose description, which is half the reason for renaming it at all.
#
# ORDER: stop, CREATE the new one, copy into it, then remove the old. The old service survives
# until the replacement is fully configured, so a failure anywhere in the middle is recoverable -
# the partial new service is torn down and the old one is still there, stopped, ready to start.
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $From,
  [Parameter(Mandatory = $true)][string] $To,
  [switch] $WhatIf,
  [switch] $Pause
)
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'beeper-s0-naming.ps1')

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

function Say($m) { Write-Host "[rename] $m" }

if (-not (Get-Service $From -ErrorAction SilentlyContinue)) { throw "no such service: $From" }
if (Get-Service $To -ErrorAction SilentlyContinue) { throw "target name already exists: $To" }

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { $nssm = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\nssm.exe' }
if (-not (Test-Path $nssm)) { throw "nssm not found" }

$SVCROOT     = 'SYSTEM\CurrentControlSet\Services'     # relative to HKLM, for the .NET registry API
$fromSvcRel  = "$SVCROOT\$From"
$toSvcRel    = "$SVCROOT\$To"

# .NET rather than the PowerShell provider, because the provider cannot round-trip a REG_BINARY
# blob or the registry's default ("") value name without special-casing, and FailureActions is a
# REG_BINARY blob. GetValueKind/SetValue(name,value,kind) is type-exact for every type NSSM uses.
function Copy-RegistrySubtree {
  param([Parameter(Mandatory = $true)][string] $SrcRel, [Parameter(Mandatory = $true)][string] $DstRel)
  $src = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($SrcRel, $false)
  if (-not $src) { throw "registry key not found: HKLM\$SrcRel" }
  $dst = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey($DstRel)
  try {
    foreach ($n in $src.GetValueNames()) {
      $kind = $src.GetValueKind($n)
      # DoNotExpandEnvironmentNames keeps a REG_EXPAND_SZ's %VARS% literal instead of baking in
      # THIS process's environment, which is not the service's.
      $val  = $src.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $dst.SetValue($n, $val, $kind)
    }
    foreach ($s in $src.GetSubKeyNames()) { Copy-RegistrySubtree "$SrcRel\$s" "$DstRel\$s" }
  } finally {
    # Guarded: a bare .Close() on a null handle throws FROM THE finally BLOCK and would replace
    # the real failure with a null-reference message, in a script that runs mid-incident.
    if ($dst) { $dst.Close() }
    if ($src) { $src.Close() }
  }
}

# The service-key settings that live OUTSIDE Parameters and that NSSM does not write for us.
# FailureActions is the SCM recovery blob (`sc.exe failure`) - copied as bytes rather than parsed
# back out of `sc qfailure`, because the blob is self-contained and carries no service name.
#
# Description is deliberately absent: it is re-stamped from the naming module below, never
# copied, and listing it here would report it as "carried" in the -WhatIf output.
$SERVICE_KEY_CARRIED = @(
  'Type', 'ErrorControl', 'DelayedAutostart', 'DependOnService',
  'FailureActions', 'FailureActionsOnNonCrashFailures', 'PreshutdownTimeout',
  'RequiredPrivileges', 'ServiceSidType'
)

$fromParams = Get-ItemProperty "HKLM:\$fromSvcRel\Parameters"
$svc        = Get-CimInstance Win32_Service -Filter "Name='$From'"
$wasRunning = (Get-Service $From).Status -eq 'Running'

$application = $fromParams.Application
if (-not $application) { throw "HKLM\$fromSvcRel\Parameters has no Application - this is not an NSSM service" }

$newDisplayName = Get-BeeperS0DisplayName $To
$newDescription = Get-BeeperS0Description $To
$startConst = switch ($svc.StartMode) {
  'Auto'     { 'SERVICE_AUTO_START' }
  'Manual'   { 'SERVICE_DEMAND_START' }
  'Disabled' { 'SERVICE_DISABLED' }
  default    { 'SERVICE_DEMAND_START' }
}

# THE ACCOUNT NEEDS ITS PASSWORD, and asking for it AFTER stopping the service would leave the
# Desktop down while a prompt waits. A built-in principal has no password; anything else does,
# and `nssm set ObjectName <user>` without one produces a service that installs cleanly and then
# cannot start - the exact silent drop this script exists to prevent. These two run as
# LocalSystem, so in practice this never prompts.
$objectName = if ($svc.StartName) { $svc.StartName } else { 'LocalSystem' }
$BUILTIN = @('LocalSystem', '.\LocalSystem', 'NT AUTHORITY\LocalService', 'NT AUTHORITY\NetworkService', 'LocalService', 'NetworkService')
$objectPassword = $null
$needsPassword  = -not ($BUILTIN -contains $objectName)

$carriedParams = @((Get-Item "HKLM:\$fromSvcRel\Parameters").GetValueNames() | Where-Object { $_ } | Sort-Object)
$fromKeyItem   = Get-Item "HKLM:\$fromSvcRel"
$carriedSvcKey = @($SERVICE_KEY_CARRIED | Where-Object { $fromKeyItem.GetValueNames() -contains $_ })

Say "$From -> $To  (running=$wasRunning, start=$($svc.StartMode), as=$objectName)"
Say "  Application     $application"
Say "  Parameters      $($carriedParams -join ', ')"
if ((Get-Item "HKLM:\$fromSvcRel\Parameters").GetSubKeyNames()) {
  Say "  Parameters subkeys  $((Get-Item "HKLM:\$fromSvcRel\Parameters").GetSubKeyNames() -join ', ')"
}
Say "  service key     $($carriedSvcKey -join ', ')"
Say "  DisplayName     $newDisplayName      (re-stamped, was '$($svc.DisplayName)')"
Say "  Description     $newDescription      (re-stamped)"
if ($needsPassword) { Say "  NOTE: '$objectName' is not a built-in principal, so its password will be asked for." }

if ($WhatIf) { Say '-WhatIf: nothing changed'; if ($Pause) { Read-Host 'Press Enter' | Out-Null }; return }

if ($needsPassword) {
  $cred = Get-Credential -UserName $objectName -Message "Password for $objectName (the account '$From' runs as; the renamed service must keep it)"
  if (-not $cred) { throw "no credential given for $objectName - refusing to rename into a service that cannot start" }
  $objectPassword = $cred.GetNetworkCredential().Password
}

if ($wasRunning) { Say "stopping $From"; Stop-Service $From -Force; (Get-Service $From).WaitForStatus('Stopped','00:01:00') }

Say "installing $To"
& $nssm install $To $application | Out-Null
if (-not (Get-Service $To -ErrorAction SilentlyContinue)) { throw "nssm install $To did not create the service" }

try {
  # Wholesale, so nothing can be forgotten: drop what `nssm install` just seeded and copy the old
  # Parameters subtree over it verbatim.
  Say "carrying every Parameters value and subkey across"
  [Microsoft.Win32.Registry]::LocalMachine.DeleteSubKeyTree("$toSvcRel\Parameters", $false)
  Copy-RegistrySubtree "$fromSvcRel\Parameters" "$toSvcRel\Parameters"

  # The log path almost always embeds the service name; without this the renamed service keeps
  # appending to the old service's file.
  foreach ($logValue in @('AppStdout', 'AppStderr')) {
    $p = (Get-ItemProperty "HKLM:\$toSvcRel\Parameters" -ErrorAction SilentlyContinue).$logValue
    if ($p) { & $nssm set $To $logValue ($p -replace [regex]::Escape($From), $To) | Out-Null }
  }

  Say "carrying the service-key settings NSSM does not own"
  $toKey = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey($toSvcRel)
  try {
    $fromKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($fromSvcRel, $false)
    if (-not $fromKey) { throw "registry key not found: HKLM\$fromSvcRel" }
    try {
      foreach ($n in $SERVICE_KEY_CARRIED) {
        if ($fromKey.GetValueNames() -notcontains $n) { continue }
        $toKey.SetValue($n, $fromKey.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames), $fromKey.GetValueKind($n))
      }
    } finally { if ($fromKey) { $fromKey.Close() } }
  } finally { if ($toKey) { $toKey.Close() } }

  if ($objectPassword) { & $nssm set $To ObjectName $objectName $objectPassword | Out-Null }
  else                 { & $nssm set $To ObjectName $objectName | Out-Null }
  & $nssm set $To Start       $startConst     | Out-Null
  & $nssm set $To DisplayName $newDisplayName | Out-Null
  & $nssm set $To Description $newDescription | Out-Null
} catch {
  Say "FAILED while configuring $To - removing the half-built service; '$From' is still installed (stopped)"
  & $nssm remove $To confirm | Out-Null
  throw
}

Say "removing $From"
& $nssm remove $From confirm | Out-Null
Start-Sleep -Seconds 2

if ($wasRunning) {
  Say "starting $To"
  Start-Service $To
  (Get-Service $To).WaitForStatus('Running','00:01:00')
}
Say "done: $To is $((Get-Service $To).Status), start=$startConst"
if ($Pause) { Write-Host ''; Read-Host 'Press Enter to close' | Out-Null }
