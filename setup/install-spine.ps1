# install-spine.ps1 — (re)install the egpt-spine scheduled task from egpt-spine.xml.
#
# The task is S4U (LogonType=Password) so the daemon runs whether or not you are
# logged on, and it has WakeToRun + a 15-minute repeat so the machine wakes
# periodically to let the resumed daemon reconnect WhatsApp and drain the
# offline backlog (receive / transcribe / reply). The engine asserts
# ES_SYSTEM_REQUIRED while it has pending work, so a transcription is never cut
# off by idle-sleep.
#
# Run from an ELEVATED PowerShell:
#     powershell -ExecutionPolicy Bypass -File .\setup\install-spine.ps1
#
# Register-ScheduledTask -Xml takes the XML as a STRING, so the file's on-disk
# encoding doesn't matter (the content is ASCII). You'll be prompted once for
# the account password (required for the run-whether-logged-on-or-not principal).

$ErrorActionPreference = 'Stop'

$xmlPath = Join-Path $PSScriptRoot 'egpt-spine.xml'
if (-not (Test-Path $xmlPath)) { throw "egpt-spine.xml not found next to this script ($xmlPath)" }
$xml = Get-Content -Raw -Path $xmlPath

$user = "$env:USERDOMAIN\$env:USERNAME"
$cred = Get-Credential -UserName $user -Message "Password for $user (so egpt-spine runs whether or not you are logged on)"

Register-ScheduledTask -TaskName 'egpt-spine' -Xml $xml `
  -User $cred.UserName -Password $cred.GetNetworkCredential().Password -Force | Out-Null

Write-Host "egpt-spine installed/updated."
Write-Host "  - WakeToRun: on   - Repeat: every 15 min   - Runs whether logged on or not."
Write-Host "Verify in Task Scheduler (\egpt-spine) or:  Get-ScheduledTask egpt-spine | Get-ScheduledTaskInfo"
Write-Host "To wake-test now: sleep the PC, send a WhatsApp voice note, let it wake -- watch ~/.egpt/wa-bridge.log for"
Write-Host "  'wake: <N>s suspend gap', 'stay-awake: ... asserted', 'transcribed ...', then 'stay-awake: released'."
