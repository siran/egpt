# register-wake-probe.ps1 — one-shot experiment: can DISCRETE-StartBoundary
# triggers wake this machine from deep Modern Standby, when Repetition
# triggers provably cannot?
#
# CONTEXT (operator 2026-06-07): overnight 2026-06-06→07 the egpt-tick task
# (6 staggered triggers, PT8M Repetition, WakeToRun=true, RTCWAKE=Enabled)
# fired ZERO times across two deep-standby stretches totaling ~8 h (~27
# missed batteries; the only non-user wake was the OS's own ~3:23 AM
# maintenance blip, which closed within 1 s). Hypothesis to discriminate:
# Task Scheduler arms real RTC wake timers for discrete trigger instances
# but NOT for Repetition instances.
#
# WHAT IT REGISTERS: task 'egpt-wake-probe', N discrete -Once triggers at
# +OffsetsMinutes from NOW, WakeToRun=true, StartWhenAvailable=FALSE (so a
# logged line can ONLY mean the wake actually fired at trigger time — no
# catch-up runs muddying the signal). The action appends 'probe' to
# egpt-tick.log, holds an ExecutionRequired power request for 90 s via
# stay-awake-helper.ps1 -OneShotSeconds (keeping the wake window open long
# enough for the bridge's conn-tick to claim its own work-lock and run a
# full cycle), then appends 'probe-end'.
#
# PROTOCOL: run this, plug in AC, close the lid, send a WhatsApp voice note
# mid-nap, reopen after the last offset + a few minutes. Then read:
#   ~/.egpt/logs/egpt-tick.log   — probe/probe-end lines at trigger times?
#   ~/.egpt/logs/wa-bridge.log   — bridge cycle under work-lock during nap?
#   System event log 506/507     — standby exits at trigger times?
#
# CLEANUP: Unregister-ScheduledTask -TaskName egpt-wake-probe -Confirm:$false
param([int[]]$OffsetsMinutes = @(6, 12, 18))
$ErrorActionPreference = 'Stop'

$helper = Join-Path $PSScriptRoot '..\src\tools\stay-awake-helper.ps1'
$helper = (Resolve-Path $helper).Path
$log    = Join-Path $env:USERPROFILE '.egpt\logs\egpt-tick.log'

$arg = "/c `"echo %DATE% %TIME% probe>> `"$log`" & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$helper`" -OneShotSeconds 90 & echo %DATE% %TIME% probe-end>> `"$log`"`""
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg

$now = Get-Date
$triggers = foreach ($m in $OffsetsMinutes) { New-ScheduledTaskTrigger -Once -At $now.AddMinutes($m) }

# -WakeToRun is the point. StartWhenAvailable stays FALSE (default) so a
# missed trigger stays missed — the log line is then an unambiguous wake.
$settings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'egpt-wake-probe' -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null

Write-Host "egpt-wake-probe registered. Trigger times:"
foreach ($m in $OffsetsMinutes) { Write-Host ("  {0}" -f $now.AddMinutes($m).ToString('HH:mm:ss')) }
Write-Host "Close the lid (on AC). Reopen after $(($OffsetsMinutes | Measure-Object -Maximum).Maximum + 4) minutes."
