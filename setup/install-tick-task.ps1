# install-tick-task.ps1 - register the egpt-tick Task Scheduler task.
#
# The egpt-tick task fires every PT10M with WakeToRun=true. Its sole
# purpose is to wake the OS so the always-running NSSM egpt-daemon
# service gets execution time at least every 10 minutes, even during
# Modern Standby. The task action is trivial (one line appended to
# ~/.egpt/logs/egpt-tick.log); the wake side effect is what matters.
#
# Run from an ELEVATED PowerShell:
#     powershell -ExecutionPolicy Bypass -File .\setup\install-tick-task.ps1
# or use the double-click wrapper: install-tick-task.cmd

$ErrorActionPreference = 'Stop'

# Elevation check
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This script must be run from an ELEVATED PowerShell." -ForegroundColor Red
  exit 1
}

$xml = Join-Path $PSScriptRoot 'egpt-tick.xml'
if (-not (Test-Path $xml)) { throw "egpt-tick.xml not found at $xml" }

# Ensure wake timers are enabled on both AC and DC (PT10M wake won't fire
# without this on a laptop). Cheap idempotent powercfg.
Write-Host "Ensuring wake timers are enabled (AC + DC)..." -ForegroundColor Cyan
& powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
& powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
& powercfg /S SCHEME_CURRENT | Out-Null

# Prompt for the password to register the S4U principal so the task
# can run whether the user is logged on or not.
$cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message "Password for the egpt-tick task (S4U principal so it runs even without an interactive logon)"

# Clean re-register: always try to delete first. /End may fail if the task
# isn't running, /Delete may fail if the task doesn't exist - both are
# no-ops in those cases. We swallow stderr AND reset $LASTEXITCODE so
# PowerShell's $ErrorActionPreference='Stop' doesn't trip on the
# native-command non-zero exit code from "task not found".
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& schtasks /End    /TN egpt-tick 2>&1 | Out-Null
& schtasks /Delete /TN egpt-tick /F 2>&1 | Out-Null
$global:LASTEXITCODE = 0
$ErrorActionPreference = $prevEAP

Write-Host "Registering egpt-tick (PT10M, WakeToRun=true)..." -ForegroundColor Cyan
$createOut = & schtasks /Create /XML "$xml" /TN egpt-tick /RU $cred.UserName /RP $cred.GetNetworkCredential().Password 2>&1
$createOut | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "schtasks /Create failed (exit $LASTEXITCODE)." -ForegroundColor Red
  exit 1
}

# Verify
$ErrorActionPreference = 'Continue'
$q = & schtasks /Query /TN egpt-tick /V /FO LIST 2>&1
$ErrorActionPreference = $prevEAP
$status = ($q | Select-String 'Status:' | Select-Object -First 1)
$nextRun = ($q | Select-String 'Next Run Time:' | Select-Object -First 1)
Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  $status"
Write-Host "  $nextRun"
Write-Host ""
Write-Host "Tail the log to confirm it fires every ~10 min:"
Write-Host "  Get-Content $env:USERPROFILE\.egpt\logs\egpt-tick.log -Tail 10 -Wait"
