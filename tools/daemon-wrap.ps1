# tools/daemon-wrap.ps1 — keep the egpt headless daemon alive across
# clean exits AND crashes. The Task Scheduler XML points at THIS
# script instead of `node egpt-daemon.mjs` directly, so when the
# daemon exits for any reason we respawn instead of leaving the
# TS task in Ready/not-running.
#
# Backoff: starts at 2s. If the daemon exited in < 30s of start,
# double the backoff up to 60s — protects against fast-crash loops
# on deterministic source bugs. Otherwise reset backoff to 2s.
#
# Logs respawn events to ~/.egpt/wrap.log so we don't collide with
# the daemon's own ~/.egpt/headless.log writer.

$ErrorActionPreference = 'Continue'
$entry  = Join-Path $env:USERPROFILE 'src\egpt\egpt-daemon.mjs'
$wrapLog = Join-Path $env:USERPROFILE '.egpt\wrap.log'
$workDir = Join-Path $env:USERPROFILE 'src\egpt'
Set-Location $workDir
$backoff = 2
function Log($m) {
  try { Add-Content -Path $wrapLog -Value "[wrap $(Get-Date -Format o)] $m" } catch {}
}
Log "wrapper start; entry=$entry"
while ($true) {
  $start = Get-Date
  Log "spawn: node $entry --headless"
  & node $entry --headless
  $code = $LASTEXITCODE
  $dur = ((Get-Date) - $start).TotalSeconds
  Log ("exit code={0} after {1:N1}s; backoff={2}s" -f $code, $dur, $backoff)
  if ($dur -lt 30) { $backoff = [Math]::Min($backoff * 2, 60) }
  else { $backoff = 2 }
  Start-Sleep -Seconds $backoff
}
