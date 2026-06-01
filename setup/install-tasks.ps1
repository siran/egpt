# setup/install-tasks.ps1 -- (re)install the egpt supervisor scheduled
# tasks. Self-elevating: if not already admin, relaunches itself with
# -Verb RunAs (raises the UAC prompt). Creating a boot-triggered task
# needs admin; S4U principal means NO stored password is required.
#
# /e supervisor install spawns this (non-elevated, detached). The
# script detects it's not admin and re-launches elevated ? UAC ? the
# elevated instance creates both tasks. Keeps the slash command's
# spawn dead simple (no nested -Verb RunAs quoting in JS that risked
# the TUI).
#
# Task ("run whether or not logged on" via S4U):
#   egpt-daemon-headless -- boot/logon ? daemon-wrap.ps1 ? daemon
# No watchdog task: the heartbeat-kill watchdog was removed. It killed
# healthy/reconnecting daemons (the "daemon got confused with the
# heartbeat" failure). One trivial supervisor, no liveness-kill.

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
  @{ Name = 'egpt-daemon-headless'; Xml = (Join-Path $setupDir 'egpt-daemon-headless.xml') }
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
Log "done creating tasks"

# Apply immediately: kill the running daemon (which may still be the OLD
# elevated/HighestAvailable one) + its wrappers, then re-run the freshly
# registered task so the new RunLevel takes effect now, not at next boot.
# We are elevated here (the one UAC), so we CAN kill the old high-integrity
# daemon. This is the elevated->least-privilege transition; after it, the
# daemon runs at medium integrity and reset-daemon.ps1 restarts it with
# ZERO UAC. (operator 2026-05-24: de-elevate to stop UAC secure-desktop
# transitions from crashing the machine.)
Log "stopping running daemon + wrappers, re-running fresh task..."
& schtasks /End /TN egpt-daemon-headless 2>$null
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'daemon-wrap\.ps1' -and $_.ProcessId -ne $PID } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# Kill only egpt's own node procs (match the command line), never every node
# on the box — a blanket `Get-Process node | Stop-Process` would take down
# unrelated node apps (and any agent session) too.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'egpt' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
& schtasks /Run /TN egpt-daemon-headless 2>$null
Log "fresh least-privilege daemon started (no watchdog)"
Write-Host ""
Write-Host "egpt supervisor re-registered at LEAST-PRIVILEGE + restarted."
Write-Host "From now on, restarts need NO UAC (reset-daemon.ps1 / /restart)."
Write-Host "This window closes in 6s..."
Start-Sleep -Seconds 6
