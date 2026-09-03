# register-s0-identity-task.ps1 - run the Session 0 identity reconciler on a timer, as SYSTEM.
#
# The reconciler (setup/s0-identity-reconcile.ps1) is a single idempotent pass. This is what makes
# it happen: at boot, at any logon, and every N minutes thereafter.
#
# ALL THREE TRIGGERS, on purpose. Boot and logon make it RESPOND quickly to the two moments that
# actually change the answer; the repeating timer is what makes it CORRECT rather than merely
# reactive - a missed event, a crash mid-flip or a session that ended without a logon event all
# heal on the next tick instead of leaving Session 0 wrong until someone notices.
#
# AS SYSTEM, because it starts and stops services and must run with nobody logged in - which is
# precisely the state it exists to maintain.
#
#   .\setup\register-s0-identity-task.ps1                 register (or replace) the task
#   .\setup\register-s0-identity-task.ps1 -IntervalMin 5  a different cadence
#   .\setup\register-s0-identity-task.ps1 -Remove         unregister
#
# DO NOT REGISTER THIS UNTIL THE RODZ INSTALL IS LOGGED IN. The reconciler's safety gate refuses
# to hand Session 0 to an install that cannot answer, so it will not take the node off the air -
# but until the gate opens it will also stop a BeeperRodz you are in the middle of logging in to.
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).
[CmdletBinding()]
param(
  [string] $TaskName    = 'egpt-s0-identity',
  [string] $ScriptPath  = (Join-Path $PSScriptRoot 's0-identity-reconcile.ps1'),
  [int]    $IntervalMin = 2,
  [switch] $Remove,
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

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "[s0-identity] removed existing task $TaskName"
}
if ($Remove) { Write-Host "[s0-identity] done (removed)"; if ($Pause) { Read-Host 'Press Enter' | Out-Null }; return }

if (-not (Test-Path $ScriptPath)) { throw "reconciler not found: $ScriptPath" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ScriptPath`""

# A repetition that never ends, hung off a boot trigger, plus a logon trigger for responsiveness.
$atBoot  = New-ScheduledTaskTrigger -AtStartup
$atBoot.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMin) `
  -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition
$atLogon = New-ScheduledTaskTrigger -AtLogOn

# RunOnlyIfNetworkAvailable is deliberately OFF: this is a local question about local services and
# must be answered on a machine with no network at all.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atBoot, $atLogon) `
  -Settings $settings -User 'SYSTEM' -RunLevel Highest `
  -Description 'Keeps the Session 0 Beeper on the right identity: an when nobody is logged in, rodz once the operator GUI is up.' | Out-Null

Write-Host "[s0-identity] registered $TaskName - at boot, at logon, every $IntervalMin min, as SYSTEM"
Write-Host "[s0-identity] log: C:\Users\an\.egpt\config\logs\s0-identity.log"
if ($Pause) { Write-Host ''; Read-Host 'Press Enter to close' | Out-Null }
