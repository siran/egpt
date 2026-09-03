# set-beeper-s0-cdp-port.ps1 - repoint an existing Session 0 Beeper service at a different
# CDP port, preserving every other flag.
#
# WHY THIS IS ITS OWN SCRIPT and not a one-liner over ssh: an ssh hop whose remote shell is
# MSYS bash EATS backslashes and `$`, so a Windows path or a PowerShell variable sent inline
# arrives mangled and the command runs against nonsense. Writing the script to a file and
# invoking it with -File is the one reliable shape.
#
# THE PORT MATTERS. src/tools/s0-driver reserves 9223 for THIS machine's Session 0 Beeper and
# 9224 for an ssh tunnel to DOLLY's. Handing a local service 9224 does not error - it makes the
# tunnel fail to bind, and then the driver lists a target that looks like dolly's and is not.
# Driving the wrong computer, silently, is the exact failure that tool was built to avoid.
#
#   powershell -File setup/set-beeper-s0-cdp-port.ps1 -ServiceName BeeperRodz -CdpPort 9225
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $ServiceName,
  [Parameter(Mandatory = $true)][int]    $CdpPort
)
$ErrorActionPreference = 'Stop'

$key = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
if (-not (Test-Path $key)) { throw "no such NSSM service: $ServiceName" }
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { $nssm = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\nssm.exe' }

$old = (Get-ItemProperty $key).AppParameters
if ($old -notmatch '--remote-debugging-port=\d+') { throw "AppParameters has no --remote-debugging-port to change: $old" }
$new = $old -replace '--remote-debugging-port=\d+', "--remote-debugging-port=$CdpPort"

$wasRunning = (Get-Service $ServiceName).Status -eq 'Running'
if ($wasRunning) { Stop-Service $ServiceName -Force; (Get-Service $ServiceName).WaitForStatus('Stopped','00:01:00') }

& $nssm set $ServiceName AppParameters $new | Out-Null
Write-Host "[cdp-port] $ServiceName -> $CdpPort"
Write-Host "[cdp-port] $new"

if ($wasRunning) {
  Start-Service $ServiceName
  $deadline = (Get-Date).AddSeconds(90); $up = $false
  while (-not $up -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    try { $null = Invoke-WebRequest "http://127.0.0.1:$CdpPort/json/version" -TimeoutSec 3 -UseBasicParsing; $up = $true } catch { }
  }
  if ($up) { Write-Host "[cdp-port] CDP answering on $CdpPort" }
  else     { Write-Host "[cdp-port] WARNING: no CDP on $CdpPort after 90s" }
}
