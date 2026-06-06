# tune-ac-power.ps1 - keep WiFi NIC + PCIe powered on AC; default behavior on battery.
#
# Operator 2026-06-06: bridge inbound during long sleeps was failing because
# at ~25 min into Modern Standby the OS powers down the WiFi NIC. While the
# NIC is off, WhatsApp queues messages server-side; egpt's WebSocket effectively
# pauses. This script makes the OS keep the NIC alive ONLY while on AC so the
# long-sleep behavior matches the short-sleep behavior we've validated. On
# battery, default aggressive power saving stays in effect.
#
# Two Power Plan settings, both natively AC/DC-conditional:
#   - Wireless Adapter Settings / Power Saving Mode
#       0 = Maximum Performance, 3 = Maximum Power Saving
#   - PCI Express / Link State Power Management
#       0 = Off (no power management), 2 = Maximum Power Savings
#
# Apply: powershell -ExecutionPolicy Bypass -File setup\tune-ac-power.ps1
# Or double-click setup\tune-ac-power.cmd (auto-elevates).

$SUB_PCIE = '501a4d13-42af-4429-9fd1-a8218c268e20'
$ASPM     = 'ee12f906-d277-404b-b6da-e5fa1a576df5'
$SUB_WL   = '19cbb8fa-5279-450e-9fac-8a3d5fedd0c1'
$WL_POWER = '12bbebe6-58d6-4636-95bb-3217ef867c1a'

Write-Host "Applying: AC = no power saving, DC = max power saving" -ForegroundColor Cyan

# WiFi adapter power saving mode
& powercfg /SETACVALUEINDEX SCHEME_CURRENT $SUB_WL  $WL_POWER 0
& powercfg /SETDCVALUEINDEX SCHEME_CURRENT $SUB_WL  $WL_POWER 3

# PCIe link-state power management
& powercfg /SETACVALUEINDEX SCHEME_CURRENT $SUB_PCIE $ASPM    0
& powercfg /SETDCVALUEINDEX SCHEME_CURRENT $SUB_PCIE $ASPM    2

& powercfg /S SCHEME_CURRENT

Write-Host ""
Write-Host "Verify - Wireless Adapter Power Saving Mode:" -ForegroundColor Green
(powercfg /Q SCHEME_CURRENT $SUB_WL $WL_POWER) | Select-String 'Current AC|Current DC' | ForEach-Object { '  ' + $_.Line.Trim() }
Write-Host ""
Write-Host "Verify - PCIe Link State Power Management:" -ForegroundColor Green
(powercfg /Q SCHEME_CURRENT $SUB_PCIE $ASPM) | Select-String 'Current AC|Current DC' | ForEach-Object { '  ' + $_.Line.Trim() }
Write-Host ""
Write-Host "  AC 0x0 = stays alive (WiFi NIC stays on while plugged in)"
Write-Host "  DC 0x3 / 0x2 = aggressive power saving on battery"
