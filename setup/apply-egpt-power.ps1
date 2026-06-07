# apply-egpt-power.ps1 — canonical power config for egpt's FINAL contract
# (operator decision 2026-06-07: "lid-open cycling + closed=catch-up").
#
# THE PROVEN MODEL (Ryzen 7 7730U, S0 Modern Standby only — no S3):
#   - Lid OPEN, user away  -> machine idle-sleeps (STANDBYIDLE), egpt-tick
#     wakes it every 5 min, the bridge processes under its work-lock, the
#     machine re-sleeps. Real sleep + 5-min resume cadence. WORKS.
#   - Lid CLOSED            -> firmware coma: wake timers pended + NIC off
#     until lid-open, regardless of how standby was entered (PROVEN
#     2026-06-07: a 2 h idle-entered lid-closed standby fired 0 of ~24
#     batteries). UNFIXABLE in software. Contract = catch-up: deep sleep
#     while shut, the bridge drains the backlog in ~2 min on lid-open.
#
# So lid behavior is left STOCK (close = Sleep, the efficient choice for a
# catch-up contract). What egpt needs is just: a short idle->sleep so the
# lid-open cycle kicks in promptly, wake timers enabled so egpt-tick can
# fire, and network-in-standby so the NIC stays up across lid-OPEN sleeps.
#
# Run ELEVATED.  (egpt-tick itself is registered by install-tick-task.ps1,
# which prompts for the S4U password; this script does NOT re-register it.)
$ErrorActionPreference = 'Continue'

Write-Host "lid-close action -> Sleep on both AC and DC (stock; close = sleep)" -ForegroundColor Cyan
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1

Write-Host "idle -> standby: AC 300 s / DC 180 s (enables the lid-open wake cycle)" -ForegroundColor Cyan
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 300
powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 180

Write-Host "wake timers ENABLED (AC + DC) so egpt-tick can fire" -ForegroundColor Cyan
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1
powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1

# Network connectivity in standby — keeps the NIC alive across lid-OPEN
# standby (it does NOT save lid-CLOSED, where firmware powers the NIC off).
# AC=Enable, DC=Managed-by-Windows (stock, battery-friendly).
Write-Host "network-in-standby: AC Enable / DC Managed" -ForegroundColor Cyan
$CONNSTANDBY = 'F15576E8-98B7-4186-B944-EAFA664402D9'
powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE $CONNSTANDBY 1
powercfg /setdcvalueindex SCHEME_CURRENT SUB_NONE $CONNSTANDBY 2

powercfg /setactive SCHEME_CURRENT

Write-Host "`nverify:" -ForegroundColor Cyan
powercfg /q SCHEME_CURRENT SUB_BUTTONS LIDACTION | Select-String 'Current'
powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String 'Current'
powercfg /q SCHEME_CURRENT SUB_SLEEP RTCWAKE   | Select-String 'Current'
