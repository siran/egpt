# apply-lid-policy.ps1 — operator decision 2026-06-07 ("Do-nothing on AC
# only"): make lid-close on AC power NOT trigger the coma-sleep.
#
# Measured background (nap-tests + overnight forensics 2026-06-06..07):
# lid-CLOSED standby on this firmware pends all wake timers until lid-open
# (an unfixable coma for software), while lid-open-class standby honors
# them on schedule. Setting lid-action(AC)=do-nothing maps lid-close onto
# the working regime: screen off -> idle-standby (5 min) -> egpt-tick wakes
# the bridge every 15 min -> work-lock holds the system only while the
# cycle processes -> standby again. On battery (DC) everything stays
# stock: lid-close = Sleep/coma, max preservation, catch-up on lid-open.
#
# Run ELEVATED. Re-registers egpt-tick from the (PT15M) XML at the end —
# that step prompts for the Windows password (schtasks /RU /RP principal).
try { Start-Transcript -Path (Join-Path $env:USERPROFILE '.egpt\logs\apply-lid-policy.log') -Force | Out-Null } catch {}
$ErrorActionPreference = 'Continue'

Write-Host "lid-close action (AC) -> 0 (do nothing)" -ForegroundColor Cyan
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0

Write-Host "idle->standby (AC) -> 300 s (sleep promptly once the lid is closed)" -ForegroundColor Cyan
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 300

powercfg /setactive SCHEME_CURRENT

# LIDACTION is attribute-hidden by default; unhide so /q can verify it.
powercfg /attributes SUB_BUTTONS LIDACTION -ATTRIB_HIDE
Write-Host "`nverify:" -ForegroundColor Cyan
powercfg /q SCHEME_CURRENT SUB_BUTTONS LIDACTION
powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE

# Re-register egpt-tick from setup/egpt-tick.xml (now PT15M).
& (Join-Path $PSScriptRoot 'install-tick-task.ps1')

try { Stop-Transcript | Out-Null } catch {}
