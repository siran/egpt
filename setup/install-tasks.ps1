# setup/install-tasks.ps1 — (re)install the egpt supervisor scheduled
# tasks. Must run ELEVATED (creating a boot-triggered task needs
# admin). The /supervisor slash command launches this via
# Start-Process -Verb RunAs, which raises the UAC prompt — approve it
# and both tasks register.
#
# Idempotent: deletes any existing task of the same name first, then
# recreates from the committed XML. Safe to re-run after every
# XML change (path fix, username change, etc.).
#
# Tasks created:
#   egpt-daemon-headless — boot trigger → daemon-wrap.ps1 → daemon
#   egpt-watchdog        — every 1 min → kills wedged daemon

$ErrorActionPreference = 'Stop'
$setupDir = Join-Path $env:USERPROFILE 'src\egpt\setup'
$tasks = @(
  @{ Name = 'egpt-daemon-headless'; Xml = (Join-Path $setupDir 'egpt-daemon-headless.xml') },
  @{ Name = 'egpt-watchdog';        Xml = (Join-Path $setupDir 'egpt-watchdog.xml') }
)

$log = Join-Path $env:USERPROFILE '.egpt\state\install-tasks.log'
function Log($m) {
  $line = "[install-tasks $(Get-Date -Format o)] $m"
  Write-Host $line
  try { Add-Content -Path $log -Value $line } catch {}
}

Log "starting; setupDir=$setupDir"
foreach ($t in $tasks) {
  if (-not (Test-Path $t.Xml)) {
    Log "MISSING XML: $($t.Xml) — skipping $($t.Name)"
    continue
  }
  # Delete existing (ignore failure if not present).
  & schtasks /Delete /TN $t.Name /F 2>$null
  # Create from XML. InteractiveToken principal in the XML means no
  # stored password needed; elevation (this script running as admin)
  # satisfies the boot-trigger privilege requirement.
  $out = & schtasks /Create /XML $t.Xml /TN $t.Name 2>&1
  if ($LASTEXITCODE -eq 0) {
    Log "created $($t.Name)"
  } else {
    Log "FAILED $($t.Name): $out"
  }
}
Log "done"
# Pause so the operator sees the result in the elevated window before
# it closes.
Write-Host ""
Write-Host "Done. This window closes in 8s..."
Start-Sleep -Seconds 8
