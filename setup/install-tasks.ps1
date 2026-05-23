# setup/install-tasks.ps1 — (re)install the egpt supervisor scheduled
# tasks. Self-elevating: if not already admin, relaunches itself with
# -Verb RunAs (raises the UAC prompt). Creating a boot-triggered task
# needs admin; S4U principal means NO stored password is required.
#
# /e supervisor install spawns this (non-elevated, detached). The
# script detects it's not admin and re-launches elevated → UAC → the
# elevated instance creates both tasks. Keeps the slash command's
# spawn dead simple (no nested -Verb RunAs quoting in JS that risked
# the TUI).
#
# Tasks (both "run whether or not logged on" via S4U):
#   egpt-daemon-headless — boot/logon → daemon-wrap.ps1 → daemon
#   egpt-watchdog        — every 1 min → kills wedged daemon

$ErrorActionPreference = 'Stop'

# --- self-elevate ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
  )
  exit
}

# --- elevated from here ---
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

Log "elevated; setupDir=$setupDir"
foreach ($t in $tasks) {
  if (-not (Test-Path $t.Xml)) { Log "MISSING XML: $($t.Xml)"; continue }
  & schtasks /Delete /TN $t.Name /F 2>$null
  $out = & schtasks /Create /XML $t.Xml /TN $t.Name 2>&1
  if ($LASTEXITCODE -eq 0) { Log "created $($t.Name)" }
  else { Log "FAILED $($t.Name): $out" }
}
Log "done"
Write-Host ""
Write-Host "egpt supervisor tasks installed. This window closes in 6s..."
Start-Sleep -Seconds 6
