# egpt-wake-duty.ps1 - wake, run ONE eGPT work cycle, then let the machine sleep again.
#
# NODE-AGNOSTIC. Nothing here names a being or a node: each node's own spine serves its own
# being, and this script only keeps the machine awake long enough for that to happen. Deploys
# to bin/egpt/setup and runs unchanged on every node.
#
# Fired every 30 min by the egpt-wake-duty scheduled task (WakeToRun, AC-only). There is no
# scheduler time cap - the script self-limits with $MAXMIN instead, so a real cycle is not
# killed mid-way. On wake it HOLDS the machine awake, revives the daemon if it died, and gives
# the resumed spine time to ingest the backlog, run due turns and drain outboxes (the spine
# drains at boot + after every turn), then releases so the machine drifts back to sleep on its
# own idle policy. Observe + ACT.
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).

$ErrorActionPreference = 'SilentlyContinue'
$prof   = $env:USERPROFILE
$state  = Join-Path $prof '.egpt\state'
# Per-node, identical on every node, and NOT the home root: a disposable log under the profile.
$logDir = Join-Path $prof '.egpt\disposable'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'egpt-wake-duty.log'
function L($m){ Add-Content -Path $log -Value ("{0} {1}" -f ((Get-Date).ToUniversalTime().ToString('o')), $m) }

$MAXMIN        = 15            # hard ceiling on awake time - the safety net now that there is no scheduler cap
$QUIETSEC      = 90            # the spine is "caught up" after this long with no new beeper ingest
$DaemonService = 'egpt-daemon' # the primary spine's service; the same literal on every node (each primary profile is .egpt)

# Keep the machine awake for the whole duty (ES_CONTINUOUS|ES_SYSTEM_REQUIRED = 0x80000001); released in finally.
$ste = Add-Type -Name Pwr -Namespace W -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[void]$ste::SetThreadExecutionState(0x80000001)
try {
  # 1) wait for networking - general internet reachability only, no LAN-specific host, up to 30s
  $sw=[Diagnostics.Stopwatch]::StartNew(); $inet=$false
  while($sw.Elapsed.TotalSeconds -lt 30){
    $inet = Test-Connection 1.1.1.1 -Count 1 -Quiet
    if($inet){ break }
    Start-Sleep -Milliseconds 500
  }

  # 2) revive the spine if the daemon died (best-effort; starting a service may need elevation)
  $svc = Get-Service $DaemonService
  if($svc -and $svc.Status -ne 'Running'){ try { Start-Service $DaemonService -ErrorAction Stop; L "daemon was $($svc.Status) -> start issued" } catch { L "daemon was $($svc.Status) -> start FAILED: $($_.Exception.Message)" } }

  # 3) HOLD awake while the spine works - until no new beeper ingest for QUIETSEC, or MAXMIN
  function OutboxCount { (Get-ChildItem (Join-Path $prof '.egpt\conversations') -Recurse -Directory -Filter outbox | ForEach-Object { Get-ChildItem $_.FullName -File } | Measure-Object).Count }
  $seen      = Join-Path $state 'beeper-seen.jsonl'
  $start     = Get-Date
  $deadline  = $start.AddMinutes($MAXMIN)
  $lastWrite = (Get-Item $seen).LastWriteTime
  $quietFrom = Get-Date
  while($true){
    Start-Sleep -Seconds 10
    $w = (Get-Item $seen).LastWriteTime
    if($w -ne $lastWrite){ $lastWrite = $w; $quietFrom = Get-Date }   # new ingest -> reset the quiet clock
    $now = Get-Date
    if( ($now - $quietFrom).TotalSeconds -ge $QUIETSEC ){ break }      # spine caught up
    if( $now -ge $deadline ){ break }                                 # safety ceiling
  }

  # 4) log the cycle outcome (+ flag an outbox the spine could not clear - a delivery problem, not a wake problem)
  $spid    = Get-Content (Join-Path $state 'spine.pid')
  $alive   = $null -ne (Get-Process -Id $spid)
  $beeper  = $false; try { Invoke-WebRequest 'http://127.0.0.1:23373/v1/accounts' -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop | Out-Null; $beeper=$true } catch { if($_.Exception.Response){ $beeper=$true } }
  $pending = OutboxCount
  $awake   = [Math]::Round(((Get-Date) - $start).TotalSeconds, 0)
  L ("duty: net(inet=$inet) spinePid=$spid alive=$alive beeperApi=$beeper outboxPending=$pending awakeSecs=$awake")
  if($pending -gt 0){ L "WARN: $pending outbox file(s) still pending after the cycle (stuck destination? a boot-drain or a turn in that chat clears it)" }
}
finally {
  [void]$ste::SetThreadExecutionState(0x80000000)   # ES_CONTINUOUS alone = release the keep-awake, let idle policy sleep the machine
}
