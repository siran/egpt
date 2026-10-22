# register-s0-identity-task.ps1 - run setup\s0-identity-reconcile.ps1 every few minutes and at boot:
# it starts a shared-profile Beeper service once Session 1 lets go of the profile (a logoff, a
# window that quit with no launcher watching). setup\share-beeper-primary-profile.ps1 registers it.
# Logon needs no trigger: setup\beeper-window.ps1 owns that moment.
#
# AS THE DESKTOP USER, S4U: it runs whether or not that user is logged on, and no password is
# stored. NEVER SYSTEM: the script lives in a folder the user can write, so SYSTEM running it would
# hand that folder SYSTEM's rights. The user already may query and start the Beeper services
# (grant-beeper-service-control.ps1) and owns the profile, the claim and the lockfile.
#
#   .\setup\register-s0-identity-task.ps1 -LogPath <file>   register (or replace) the task
#   .\setup\register-s0-identity-task.ps1 -UserId reve\an   as that user (default: whoever runs this)
#   .\setup\register-s0-identity-task.ps1 -IntervalMin 5    a different cadence
#   .\setup\register-s0-identity-task.ps1 -Remove           unregister
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).
[CmdletBinding()]
param(
  [string] $TaskName    = 'egpt-s0-identity',
  [string] $ScriptPath  = (Join-Path $PSScriptRoot 's0-identity-reconcile.ps1'),
  [string] $ServiceName = 'egpt-beeper-primary',
  [string] $LogPath     = '',
  [string] $UserId      = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
  [int]    $IntervalMin = 2,
  [switch] $Remove,
  [switch] $Pause,
  [switch] $LoadFunctionsOnly
)
$ErrorActionPreference = 'Stop'

# Who the task runs as. In-memory only (tests read it).
function Get-S0IdentityTaskPrincipal([string] $UserId) {
  if ($UserId -match '(^|\\)SYSTEM$|^NT AUTHORITY\\') { throw "the reconciler task never runs as $UserId (its script is in a user-writable folder)" }
  return New-ScheduledTaskPrincipal -UserId $UserId -LogonType S4U -RunLevel Limited
}

# When it runs. In-memory only (tests read it). The time trigger starts the repetition NOW and keeps
# it across reboots; a repetition hung off AtStartup alone waits for the next boot (reve 2026-10-22:
# registered, never ran, no next run time). AtStartup stays for the pass right at boot.
# No -RepetitionDuration: empty means indefinitely; [TimeSpan]::MaxValue is refused (P99999999DT23H59M59S).
function Get-S0IdentityTaskTriggers([int] $IntervalMin, [datetime] $At = (Get-Date)) {
  return @(
    (New-ScheduledTaskTrigger -Once -At $At -RepetitionInterval (New-TimeSpan -Minutes $IntervalMin)),
    (New-ScheduledTaskTrigger -AtStartup))
}

if ($LoadFunctionsOnly) { return }

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

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  # -ErrorAction Stop, explicitly: the preference above is NOT enough for these cmdlets. Measured
  # on dolly 2026-09-12 (register-session1-daemon-task.ps1, same preference set): the failure came
  # back NON-TERMINATING and the script announced work it had not done.
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
  Write-Host "[s0-identity] removed existing task $TaskName"
}
if ($Remove) { Write-Host "[s0-identity] done (removed)"; if ($Pause) { Read-Host 'Press Enter' | Out-Null }; return }

if (-not (Test-Path $ScriptPath)) { throw "reconciler not found: $ScriptPath" }

$arg = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ScriptPath`" -ServiceName $ServiceName"
if ($LogPath) { $arg += " -LogPath `"$LogPath`"" }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg

# RunOnlyIfNetworkAvailable is deliberately OFF: this is a local question about local services and
# must be answered on a machine with no network at all.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger (Get-S0IdentityTaskTriggers $IntervalMin) `
  -Settings $settings -Principal (Get-S0IdentityTaskPrincipal $UserId) `
  -Description "Starts $ServiceName when Session 1 is not using its Beeper profile (shared with the operator's window). Never stops it." `
  -ErrorAction Stop | Out-Null

Write-Host "[s0-identity] registered $TaskName - every $IntervalMin min from now on, and at boot, as $UserId (S4U), for $ServiceName"
if ($LogPath) { Write-Host "[s0-identity] log: $LogPath" }
if ($Pause) { Write-Host ''; Read-Host 'Press Enter to close' | Out-Null }
