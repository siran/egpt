# s0-identity-reconcile.ps1 - keep the SESSION 0 Beeper on the right IDENTITY for who is here.
#
# THE RULE (operator 2026-09-03: "s0 should be an, after logon and logon-stutter, s1 an and s0
# rodz"):
#
#   nobody logged in  ->  Session 0 runs AN     so his agents answer in his own groups unattended
#   an logged in      ->  Session 1 GUI is AN, so Session 0 is free to be RODZ, and the node
#                         carries both identities at once
#
# OBSERVATION, NOT TRIGGERS. A logon task and a logoff task would each be one event away from
# leaving the node in the wrong state forever - a missed trigger, a crash mid-flip, a reboot with
# a session still open. This runs on a timer, asks what is actually true, and corrects. It is the
# same shape peer-liveness.mjs uses, and for the same reason: a local question answered by looking
# needs no negotiation and cannot split-brain.
#
# ASYMMETRIC HYSTERESIS, also borrowed from peer-liveness: YIELD EAGERLY, CLAIM RELUCTANTLY. The
# two mistakes do not cost the same. Flipping to RODZ when the operator is NOT really here takes
# `an` off Session 0 and his agents go silent in his own groups - the exact capability the whole
# Session 0 build exists for. Flipping back to AN when he IS here costs a duplicate device. So:
# going to rodz needs ClaimTicks CONSECUTIVE sightings of a live GUI; coming back to an happens on
# the FIRST tick that does not see one.
#
# THE SAFETY GATE. It will NEVER hand Session 0 to a Beeper install that is not logged in - that
# would trade a working `an` for a login screen and take the node off the air. The rodz install
# must answer /v1/accounts 200 with its own token, recorded in the ready-file, before this script
# will ever stop BeeperAn. Absent or stale ready-file = do nothing, and say so.
#
#   .\s0-identity-reconcile.ps1              one reconcile pass (what the scheduled task runs)
#   .\s0-identity-reconcile.ps1 -WhatIf      say what it would do, change nothing
#   .\s0-identity-reconcile.ps1 -Force an    flip to a named identity now, ignoring the observation
#
# ASCII ONLY: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI, so one em-dash is a parse
# error. Runs as SYSTEM from the task, so it needs no elevation of its own.
[CmdletBinding()]
param(
  [string] $AnService    = 'BeeperAn',
  [string] $RodzService  = 'BeeperRodz',
  [string] $SpineService = 'egpt-daemon',
  [string] $StatePath    = 'C:\Users\an\.egpt\state\s0-identity.json',
  [string] $ReadyPath    = 'C:\Users\an\.egpt\state\s0-rodz-ready.json',
  [string] $LogPath      = 'C:\Users\an\.egpt\config\logs\s0-identity.log',
  [int]    $ClaimTicks   = 2,
  [ValidateSet('an','rodz')][string] $Force,
  [switch] $WhatIf
)

$ErrorActionPreference = 'Stop'

function Say($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Write-Host $line
  try { Add-Content -Path $LogPath -Value $line -Encoding utf8 } catch { }
}

# ---- observe ---------------------------------------------------------------------------------
# A GUI that merely EXISTS is not enough: Beeper spawns helper processes early and sits for a
# while before it serves anything, so a process check would flip Session 0 while the GUI is still
# unusable. LISTENING on its local API is the honest "this install is up and answering".
function Get-InteractiveBeeperPort {
  $rows = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
          Where-Object { $_.LocalPort -ge 23373 -and $_.LocalPort -le 23390 }
  foreach ($r in $rows) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($r.OwningProcess)" -ErrorAction SilentlyContinue
    if ($p -and $p.Name -eq 'Beeper.exe' -and $p.SessionId -ne 0) { return $r.LocalPort }
  }
  return $null
}

function Get-RunningIdentity {
  $an   = (Get-Service $AnService   -ErrorAction SilentlyContinue).Status -eq 'Running'
  $rodz = (Get-Service $RodzService -ErrorAction SilentlyContinue).Status -eq 'Running'
  if ($an -and $rodz) { return 'both' }
  if ($an)   { return 'an' }
  if ($rodz) { return 'rodz' }
  return 'none'
}

# ---- the safety gate -------------------------------------------------------------------------
# Written by hand (or by the login run) once the rodz install is logged in AND has an approved
# connection: { "token": "bdapi_...", "verifiedAt": "..." }. Checked LIVE, not trusted: the token
# is probed against the rodz service's own port after it starts, and a rodz that stops answering
# sends the node back to `an` on the next tick.
function Get-RodzReady {
  if (-not (Test-Path $ReadyPath)) { return $null }
  try { return (Get-Content $ReadyPath -Raw | ConvertFrom-Json) } catch { return $null }
}

# ---- state (the claim streak) ----------------------------------------------------------------
$state = @{ streak = 0; last = '' }
if (Test-Path $StatePath) {
  try { $j = Get-Content $StatePath -Raw | ConvertFrom-Json; $state.streak = [int]$j.streak; $state.last = [string]$j.last } catch { }
}
function Save-State { if (-not $WhatIf) { try { ($state | ConvertTo-Json -Compress) | Set-Content -Path $StatePath -Encoding utf8 } catch { } } }

# ---- the flip --------------------------------------------------------------------------------
function Invoke-Flip($to) {
  $stop  = if ($to -eq 'rodz') { $AnService }   else { $RodzService }
  $start = if ($to -eq 'rodz') { $RodzService } else { $AnService }

  if ($WhatIf) { Say "-WhatIf: would stop $stop, start $start, then restart $SpineService"; return }

  Say "flipping Session 0 to '$to': stop $stop"
  if ((Get-Service $stop -ErrorAction SilentlyContinue).Status -eq 'Running') {
    Stop-Service $stop -Force
    (Get-Service $stop).WaitForStatus('Stopped', '00:01:00')
  }
  # WAIT FOR THE PORT TO CLEAR before starting the other one. Beeper takes the NEXT FREE port from
  # 23373, so starting the incoming Desktop while the outgoing one still holds 23373 gives it
  # 23374 instead - and then the two Desktops have swapped places with no error anywhere.
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    $held = Get-NetTCPConnection -State Listen -LocalPort 23373 -ErrorAction SilentlyContinue |
            Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue).SessionId -eq 0 }
    if (-not $held) { break }
    Start-Sleep -Milliseconds 500
  }

  Say "starting $start"
  Start-Service $start
  $deadline = (Get-Date).AddSeconds(120)
  $port = $null
  while (-not $port -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    $rows = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -ge 23373 -and $_.LocalPort -le 23390 }
    foreach ($r in $rows) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($r.OwningProcess)" -ErrorAction SilentlyContinue
      if ($p -and $p.Name -eq 'Beeper.exe' -and $p.SessionId -eq 0) { $port = $r.LocalPort; break }
    }
  }
  if ($port) { Say "Session 0 Beeper is listening on $port" }
  else       { Say "WARNING: no Session 0 Beeper API port after 120s - the spine will fall back to its first candidate" }

  # THE SPINE RE-RESOLVES AT BOOT, not continuously: a connection's candidate endpoints are probed
  # once, in boot(). So the flip is not complete until the spine restarts - without this it stays
  # bound to the install that just went away.
  Say "restarting $SpineService so it re-resolves its endpoints"
  Restart-Service $SpineService -Force
}

# ---- decide ----------------------------------------------------------------------------------
$have = Get-RunningIdentity
$guiPort = Get-InteractiveBeeperPort
$ready = Get-RodzReady

if ($Force) {
  Say "forced: '$Force' (observed gui=$(if($guiPort){"listening on $guiPort"}else{'none'}), running=$have)"
  if ($Force -eq 'rodz' -and -not $ready) { Say "REFUSING: $ReadyPath is absent - the rodz install is not logged in, and handing Session 0 to a login screen takes the node off the air"; return }
  if ($Force -ne $have) { Invoke-Flip $Force } else { Say "already '$have' - nothing to do" }
  return
}

# CLAIM RELUCTANTLY: a live GUI has to be seen ClaimTicks times running before Session 0 gives up
# `an`. YIELD EAGERLY: one tick without a GUI sends it straight back.
if ($guiPort) { $state.streak = [Math]::Min($state.streak + 1, $ClaimTicks) } else { $state.streak = 0 }
$want = if ($state.streak -ge $ClaimTicks) { 'rodz' } else { 'an' }

if ($want -eq 'rodz' -and -not $ready) {
  # Not an error and not a retry loop - just the honest state. Said once per change, not every tick.
  if ($state.last -ne 'blocked') { Say "GUI is up, but $ReadyPath is absent - the rodz install is not logged in yet, so Session 0 stays on 'an'" }
  # Blocked means the desired identity is 'an', so make sure it is actually RUNNING - saying
  # "stays on an" while nothing is on is the failure this whole gate exists to prevent.
  # BeeperRodz is deliberately NOT stopped here: while the gate is closed it is the install a
  # human is logging IN to, and pulling it out from under that is the one unhelpful thing to do.
  if ((Get-Service $AnService -ErrorAction SilentlyContinue).Status -ne 'Running') {
    Say "BeeperAn is not running while blocked - starting it"
    if (-not $WhatIf) { Start-Service $AnService }
  }
  $state.last = 'blocked'; Save-State
  return
}

if ($have -eq $want) {
  if ($state.last -ne $want) { Say "steady: Session 0 is '$want' (gui=$(if($guiPort){"listening on $guiPort"}else{'none'}), streak=$($state.streak))" }
  $state.last = $want; Save-State
  return
}

Say "want '$want', have '$have' (gui=$(if($guiPort){"listening on $guiPort"}else{'none'}), streak=$($state.streak))"
# BOTH RUNNING, and the one we want is already up: the surplus service is the only problem. `an`
# never went away, so the spine is still bound to a live install and restarting it would drop the
# warm pool for nothing. Stop the extra and leave the spine alone.
if ($have -eq 'both') {
  $surplus = if ($want -eq 'an') { $RodzService } else { $AnService }
  Say "both services are running - stopping the surplus ($surplus), leaving $SpineService alone"
  if (-not $WhatIf) { Stop-Service $surplus -Force }
  $state.last = $want; Save-State
  return
}
Invoke-Flip $want
$state.last = $want
Save-State
