# rename-beeper-s0-service.ps1 - rename a Session 0 Beeper service, preserving its configuration.
#
# NSSM CANNOT RENAME, so this reads every parameter off the old service, removes it, and installs
# the new one with the same values. That is the whole risk: between the remove and the install the
# Desktop is DOWN, so renaming the service that holds the account currently answering takes the
# agents off the air for the duration. Rename the idle one first, verify, then the live one.
#
# WHY IT EXISTS: the first two services here were created by hand and named after the operator's
# own accounts. eGPT is a public tool, so the vocabulary is ROLES - a PRIMARY account (the
# operator's own) and a SECONDARY (the one the agents wear) - and the shipped scripts default to
# `egpt-beeper-primary` / `egpt-beeper-secondary`, matching `egpt-daemon` and `egpt-chrome`.
#
#   .\setup\rename-beeper-s0-service.ps1 -From <old> -To <new>
#   .\setup\rename-beeper-s0-service.ps1 -From <old> -To <new> -WhatIf
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

$key = "HKLM:\SYSTEM\CurrentControlSet\Services\$From"
$par = Get-ItemProperty "$key\Parameters"
$svc = Get-CimInstance Win32_Service -Filter "Name='$From'"
$wasRunning = (Get-Service $From).Status -eq 'Running'

$cfg = [ordered]@{
  Application     = $par.Application
  AppParameters   = $par.AppParameters
  AppDirectory    = $par.AppDirectory
  AppStdout       = $par.AppStdout
  AppStderr       = $par.AppStderr
  AppRestartDelay = $par.AppRestartDelay
  ObjectName      = $svc.StartName
  Start           = $svc.StartMode
  DisplayName     = $svc.DisplayName
}
Say "$From -> $To  (running=$wasRunning, start=$($svc.StartMode), as=$($svc.StartName))"
foreach ($k in $cfg.Keys) { if ($cfg[$k]) { Say ("  {0,-16}{1}" -f $k, ([string]$cfg[$k]).Substring(0, [Math]::Min(110, ([string]$cfg[$k]).Length))) } }
if ($WhatIf) { Say '-WhatIf: nothing changed'; if ($Pause) { Read-Host 'Press Enter' | Out-Null }; return }

if ($wasRunning) { Say "stopping $From"; Stop-Service $From -Force; (Get-Service $From).WaitForStatus('Stopped','00:01:00') }
Say "removing $From"
& $nssm remove $From confirm | Out-Null
Start-Sleep -Seconds 2

Say "installing $To"
& $nssm install $To $cfg.Application | Out-Null
if ($cfg.AppParameters)   { & $nssm set $To AppParameters   $cfg.AppParameters   | Out-Null }
if ($cfg.AppDirectory)    { & $nssm set $To AppDirectory    $cfg.AppDirectory    | Out-Null }
if ($cfg.AppStdout)       { & $nssm set $To AppStdout       ($cfg.AppStdout -replace [regex]::Escape($From), $To) | Out-Null }
if ($cfg.AppStderr)       { & $nssm set $To AppStderr       ($cfg.AppStderr -replace [regex]::Escape($From), $To) | Out-Null }
if ($cfg.AppRestartDelay) { & $nssm set $To AppRestartDelay $cfg.AppRestartDelay | Out-Null }
& $nssm set $To ObjectName ($(if ($cfg.ObjectName) { $cfg.ObjectName } else { 'LocalSystem' })) | Out-Null
$startConst = switch ($cfg.Start) { 'Auto' { 'SERVICE_AUTO_START' } 'Manual' { 'SERVICE_DEMAND_START' } 'Disabled' { 'SERVICE_DISABLED' } default { 'SERVICE_DEMAND_START' } }
& $nssm set $To Start $startConst | Out-Null
& $nssm set $To DisplayName ($(if ($cfg.DisplayName) { $cfg.DisplayName -replace [regex]::Escape($From), $To } else { $To })) | Out-Null

if ($wasRunning) {
  Say "starting $To"
  Start-Service $To
  (Get-Service $To).WaitForStatus('Running','00:01:00')
}
Say "done: $To is $((Get-Service $To).Status), start=$startConst"
if ($Pause) { Write-Host ''; Read-Host 'Press Enter to close' | Out-Null }
