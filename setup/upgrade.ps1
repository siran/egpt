# setup/upgrade.ps1 -- the EVERYDAY deploy: drop /upgrade in the ingest box, then VERIFY.
#
# The spine sweeps EGPT_HOME/state/ingest every second, consumes the file, and exits 42;
# the daemon then does git pull + build + respawn (src/spine/ingest.mjs). That is the whole
# deploy. This script adds the part that is tedious by hand: proving it actually landed.
# Since 2026-09-28 the spine first finishes any turn in flight (state/draining.json says so
# while it waits, capped at 30 min) -- this script waits that out before counting down.
#
# Use setup/deploy.ps1 INSTEAD when the change alters what the SUPERVISOR spawns (an
# entry-point rename, daemon-runtime appPath). That one restarts the service and needs UAC.
# This one never elevates -- it writes one file into your own profile, and once the deploy
# lands it runs the pending migrations (setup/migrate.mjs), which report the ones that need
# elevation as PENDING rather than asking for it.
#
# ASCII ONLY, deliberately: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI, so a
# non-ASCII character here (an em-dash, an arrow) mangles into bytes that break the parser.
#
#   powershell -ExecutionPolicy Bypass -File setup\upgrade.ps1
#   powershell -ExecutionPolicy Bypass -File setup\upgrade.ps1 -EgptHome "$env:USERPROFILE\.egpt-secondary"
#   powershell -ExecutionPolicy Bypass -File setup\upgrade.ps1 -Peer an@192.168.1.102
[CmdletBinding()]
param(
  [string]$EgptHome  = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string]$Repo      = (Join-Path $env:USERPROFILE 'bin\egpt'),
  [string]$Source    = (Join-Path $env:USERPROFILE 'src\egpt'),   # the CHECKOUT people edit and run by hand
  [int]$TimeoutSec   = 120,
  [string]$Peer      = ''     # user@host -- deploy THIS node, then run this same script there over ssh
)
$ErrorActionPreference = 'Stop'

$stop     = Join-Path $EgptHome 'STOP'
$alive    = Join-Path $EgptHome 'state\alive.txt'
$ingest   = Join-Path $EgptHome 'state\ingest'
$draining = Join-Path $EgptHome 'state\draining.json'
$spinePid = Join-Path $EgptHome 'state\spine.pid'

# --- refuse on a stopped node: boot checks STOP first and exits clean, so an /upgrade
#     dropped now would be consumed by a spine that never starts. ---
if (Test-Path $stop) {
  Write-Host "REFUSING: $stop exists -- the node is deliberately stopped." -ForegroundColor Red
  foreach ($ln in (Get-Content $stop)) { Write-Host "  $ln" -ForegroundColor DarkGray }
  Write-Host "Clear it first:  setup\start-egpt.cmd" -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path $alive)) {
  Write-Host "REFUSING: no $alive -- is the node running?" -ForegroundColor Red
  exit 1
}

$git = (Get-Command git -ErrorAction SilentlyContinue).Source
# rev-parse FAILS on a repo with no commits (and prints to stderr), returning null -- calling
# .Trim() on that throws and kills the deploy. Guard both reads; '?' is already the unknown value.
function Get-ShortHead($gitExe, $repo) {
  if (-not $gitExe -or -not (Test-Path $repo)) { return '?' }
  $out = (& $gitExe -C $repo rev-parse --short HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $out) { return '?' }
  return ([string]$out).Trim()
}

# --- SOURCE TREES ---------------------------------------------------------------------
# The /upgrade handshake below only ever touches the RUNNING copy (~/bin/egpt). The checkout
# people actually edit and launch by hand (~/src/egpt) was never part of a deploy, so it
# drifted silently -- and on 2026-08-27 that drift broke a live node: a source tree ~30
# commits old still SERVED ws://127.0.0.1:23375 (the shell socket was inverted in af5fde2),
# so `node egpt.mjs` from it fought the current spine for the port, the spine logged
# EADDRINUSE on a loop and the editor sat forever on "spine is not connected". Stale source
# is no longer merely old code; running it actively breaks the node. So a deploy updates it.
#
# NEVER CLOBBER. A source tree is somebody's working copy and this repo has more than one
# engineer. Dirty, or not a clean fast-forward, means SKIP AND SAY SO -- no stash, no reset,
# no checkout, no merge. A skip is a normal reported outcome, never a failure: it must not
# abort the deploy, because the running copies still have to update.

# Native git under $ErrorActionPreference='Stop' is a trap in PS 5.1 -- with 2>&1 each stderr
# line becomes an ErrorRecord and TERMINATES the script, so a mere "not a fast-forward" would
# kill the deploy it is supposed to report. Drop the preference for the call, then restore it.
# (Same reasoning as the ls-remote probe below; this is that pattern, reused.)
function Invoke-TreeGit([scriptblock]$Run, [string[]]$GitArgs) {
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = (& $Run $GitArgs 2>&1 | Out-String)
  $rc  = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  return @{ Text = $out.Trim(); Code = $rc }
}

# git's real cause is the fatal:/error: line, not the first line: a failed pull leads with the
# harmless "From github.com:..." fetch chatter, and naming that as the reason explains nothing.
# PS 5.1 also renders a native exe's first stderr line as an ErrorRecord ("git.exe : fatal: ..")
# followed by an "At line:1 char:1 / + CategoryInfo .." block -- strip both, or the reason we
# print is PowerShell's own plumbing rather than anything git said.
function Get-GitReason([string]$text) {
  $lines = @(($text -split "`r?`n") |
    ForEach-Object { ($_ -replace '^[\w.-]+\.exe\s*:\s*', '').Trim() } |
    Where-Object { $_ -and $_ -notmatch '^(At line:|\+|CategoryInfo|FullyQualifiedErrorId)' })
  $bad   = @($lines | Where-Object { $_ -match '^(fatal|error|remote error):' }) | Select-Object -First 1
  if ($bad)   { return $bad.Trim() }
  if ($lines) { return ($lines | Select-Object -First 1).Trim() }
  return 'no output'
}

# ONE policy, two transports: local and peer differ only in the $Run scriptblock, so there is
# no second implementation to drift. Prints its own result line; never throws, never exits.
function Update-SourceTree([string]$Where, [scriptblock]$Run) {
  $head = Invoke-TreeGit $Run @('rev-parse', '--short', 'HEAD')
  if ($head.Code -ne 0 -or -not $head.Text) {
    Write-Host "  source  SKIPPED -- no usable checkout at $Where" -ForegroundColor Yellow
    Write-Host ("          " + (Get-GitReason $head.Text)) -ForegroundColor DarkGray
    return
  }
  $st = Invoke-TreeGit $Run @('status', '--porcelain')
  if ($st.Code -ne 0) {
    Write-Host "  source  SKIPPED -- cannot read status of $Where" -ForegroundColor Yellow
    Write-Host ("          " + (Get-GitReason $st.Text)) -ForegroundColor DarkGray
    return
  }
  if ($st.Text) {
    # Someone is working in here. Show what is in the way so the skip is actionable.
    $lines = @(($st.Text -split "`r?`n") | Where-Object { $_.Trim() })
    Write-Host ("  source  SKIPPED -- working tree is DIRTY (" + $lines.Count + " change(s)), left untouched") -ForegroundColor Yellow
    foreach ($ln in ($lines | Select-Object -First 5)) { Write-Host ("          " + $ln.Trim()) -ForegroundColor DarkGray }
    if ($lines.Count -gt 5) { Write-Host ("          ... and " + ($lines.Count - 5) + " more") -ForegroundColor DarkGray }
    return
  }
  # --ff-only with no refspec: it follows the tree's OWN upstream, so this can neither switch
  # a branch nor invent a merge commit. Diverged, or no upstream at all, is a clean refusal.
  $pull = Invoke-TreeGit $Run @('pull', '--ff-only')
  if ($pull.Code -ne 0) {
    Write-Host "  source  SKIPPED -- not a clean fast-forward at $Where" -ForegroundColor Yellow
    Write-Host ("          " + (Get-GitReason $pull.Text)) -ForegroundColor DarkGray
    return
  }
  $now = Invoke-TreeGit $Run @('rev-parse', '--short', 'HEAD')
  $to  = if ($now.Code -eq 0 -and $now.Text) { $now.Text } else { '?' }
  Write-Host ("  source  " + $head.Text + " -> " + $to)
  if ($head.Text -eq $to) { Write-Host "          (already current)" -ForegroundColor DarkGray }
}

$localSrcGit = {
  param([string[]]$a)
  & $git -C $Source @a
}
# The peer's shell is msys BASH (dolly answers on port 2222, full POSIX -- ~/.ssh/config pins it;
# port 22 is the cmd.exe sshd and is NOT what this reaches). It was cmd.exe when this was
# written, which is why `%USERPROFILE%` used to expand here and stopped on 2026-08-31 --
# bash leaves %VAR% literal, so the path arrived unexpanded and the deploy died with exit 127.
# `~` is what BOTH shells resolve, and msys converts it to a Windows path on the way into a
# native exe, so `-File ~/bin/...` reaches powershell.exe correctly. ssh flattens argv into one
# command line, so anything quoted
# arrives mangled. Everything here is therefore quote-free and space-free; `~`
# expands on the REMOTE, exactly as the recursive call at the bottom of this script does it.
$peerSrcGit = {
  param([string[]]$a)
  $remote = @('git', '-C', '~/src/egpt') + $a
  & ssh -o ConnectTimeout=8 $Peer @remote
}

$before = Get-ShortHead $git $Repo

# --- WHAT SHOULD LAND: the deploy is the daemon doing `git pull`, so the target is the
#     remote's main. Resolve it FIRST. Without this the script can only compare the repo to
#     itself, and an unreachable remote reads exactly like "already up to date" -- which is
#     precisely the false green this produced on 2026-08-05: it reported DEPLOY OK / already
#     current while the pull had failed on a network blocking port 22, and the spine came back
#     on the OLD code. A deploy tool that cannot tell those apart is worse than none. ---
$target = ''
$remoteErr = ''
if ($git -and (Test-Path $Repo)) {
  # 2>&1 on a NATIVE exe is a trap in PS 5.1: each stderr line becomes an ErrorRecord, which
  # under $ErrorActionPreference='Stop' TERMINATES the script -- so probing for an unreachable
  # remote would kill the very deploy it exists to warn about. Drop the preference for this one
  # call, then restore it.
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $lsOut = (& $git -C $Repo ls-remote origin main 2>&1 | Out-String)
  $lsRc  = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  if ($lsRc -eq 0 -and $lsOut.Trim()) {
    $target = $lsOut.Trim().Split("`n")[0].Split()[0].Substring(0, 7)
  } else {
    # FIRST line, not last: git's final stderr line is the generic "make sure you have the
    # correct access rights and the repository exists" tail, which names no cause. The first
    # line is the actual one ("ssh: connect to host github.com port 22: Connection timed out").
    $remoteErr = ($lsOut.Trim() -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
    if ($remoteErr) { $remoteErr = $remoteErr.Trim() } else { $remoteErr = "git ls-remote exited $lsRc" }
  }
}
if ($remoteErr) {
  Write-Host "WARNING: cannot reach the remote -- $remoteErr" -ForegroundColor Yellow
  Write-Host "         the daemon's git pull will fail; this will REBUILD AND RESPAWN THE CURRENT CODE, not update it." -ForegroundColor Yellow
  Write-Host "         (GitHub also serves ssh on 443: git push ssh://git@ssh.github.com:443/<owner>/<repo>.git main)" -ForegroundColor DarkGray
  Write-Host ""
}

Write-Host ""
Write-Host "Deploying:" -ForegroundColor Cyan
Write-Host "  profile : $EgptHome"
Write-Host "  prod    : $Repo  (at $before)"
Write-Host "  source  : $Source"
Write-Host ""

# The source tree goes FIRST and unconditionally: it is independent of the ingest handshake,
# so it must still be reported even when the prod deploy below fails and exits.
if ($git) {
  Update-SourceTree $Source $localSrcGit
} else {
  Write-Host "  source  SKIPPED -- git is not on PATH" -ForegroundColor Yellow
}
Write-Host ""

# --- THE SPINE MAY BE DRAINING (operator 2026-09-28: "yes, restart should wait for turns in
#     progress"). /upgrade and /restart no longer leave the moment they are read: the spine keeps
#     serving until no turn is in flight, and says so in state/draining.json -- { since, busy,
#     turns, cap } -- until it exits. This returns that record while it is there AND still inside
#     the spine's own cap plus a margin, else $null: a file a spine left behind by dying mid-drain
#     (boot clears it too) can never hold a deploy past the cap. The cap is READ from the file,
#     so the spine's one constant (src/spine/spine.mjs RESTART_DRAIN_CAP_MS) is the only copy. ---
$DrainMarginSec = 120
function Get-Drain {
  if (-not (Test-Path $draining)) { return $null }
  try {
    $d = Get-Content -Raw $draining | ConvertFrom-Json
    $until = [DateTimeOffset]::Parse($d.since).AddMilliseconds([double]$d.cap).AddSeconds($DrainMarginSec)
  } catch { return $null }
  if ([DateTimeOffset]::UtcNow -gt $until) { return $null }
  return $d
}

# --- drop a lifecycle command into the ingest box and WAIT FOR THE BOUNCE. One procedure for the
#     /upgrade below and for the /restart after config migrations, so both wait the same way. ---
function Get-SpineBoot {
  if (-not (Test-Path $spinePid)) { return $null }
  return (Get-Item $spinePid).LastWriteTime
}
function Invoke-Bounce([string]$Command) {
  # Sampled at the drop, not earlier: a beat from before the drop is not a bounce.
  $beat0 = (Get-Item $alive).LastWriteTime
  $boot0 = Get-SpineBoot
  # --- temp -> rename, because the sweep skips *.tmp so a half-written file is never read ---
  New-Item -ItemType Directory -Force -Path $ingest | Out-Null
  $name  = $Command.TrimStart('/')
  $tmp   = Join-Path $ingest "$name.tmp"
  $final = Join-Path $ingest $name
  [IO.File]::WriteAllText($tmp, $Command, (New-Object Text.UTF8Encoding $false))
  Move-Item -Path $tmp -Destination $final -Force
  Write-Host "dropped $Command into the ingest box -- waiting for the spine to bounce..." -ForegroundColor Yellow

  # --- the proof is the HEARTBEAT advancing: only a live spine writes alive.txt. The sha may
  #     legitimately not move (already current), so it is reported, never required. ---
  # A CHANGED HEARTBEAT ALONE IS NOT PROOF, and reading it as proof produced a false FAILURE on
  # 2026-08-08: the OLD spine's 60s beat can fire between the drop and the daemon finishing its
  # pull, so the loop saw "bounced", read the sha while git was still working, and reported the
  # node as stuck on old code -- while the pull was in fact succeeding. So when we know the
  # TARGET, wait for the repo to actually reach it; the heartbeat is the liveness half only.
  #
  # A DRAINING SECOND IS NOT A COUNTDOWN SECOND (2026-09-28): while the spine says it is finishing
  # turns, $TimeoutSec does not run, the draining spine's own beats are not a bounce (the baseline
  # moves with them), and every ~30 s the script says who it is waiting for.
  $drainSeen = $null
  $drainTold = $null
  $i = 0
  while ($i -lt $TimeoutSec) {
    Start-Sleep -Seconds 1
    if (Test-Path $stop) {
      Write-Host "FAILED: $stop appeared during the deploy -- the node stopped itself." -ForegroundColor Red
      foreach ($ln in (Get-Content $stop)) { Write-Host "  $ln" -ForegroundColor DarkGray }
      exit 1
    }
    $d = Get-Drain
    if ($d) {
      $beat0 = (Get-Item $alive).LastWriteTime
      if (-not $drainSeen) { $drainSeen = Get-Date }
      if (-not $drainTold -or ((Get-Date) - $drainTold).TotalSeconds -ge 30) {
        Write-Host ("  the spine is waiting for " + $d.turns + " turn(s) to finish: " + (@($d.busy) -join ', ')) -ForegroundColor DarkYellow
        $drainTold = Get-Date
      }
      continue
    }
    if ($drainSeen) {
      if (Test-Path $draining) {
        Write-Host "  the spine is PAST its own drain cap and has not left -- no longer waiting on it" -ForegroundColor Red
      } else {
        Write-Host ("  ...the turns finished after " + [int]((Get-Date) - $drainSeen).TotalSeconds + " s -- waiting for the bounce") -ForegroundColor DarkGray
      }
      $drainSeen = $null
    }
    $i++
    $beat = (Get-Item $alive).LastWriteTime -ne $beat0
    if (-not $beat) { continue }
    # ...AND IT IS A NEW SPINE THAT BEAT (2026-09-28). The spine that was asked to leave keeps
    # beating until the very moment it exits -- through its drain and through the going-down
    # announce -- and for a /restart there is no new sha to hold out for, so a beat alone was
    # read as a bounce that had not happened (measured: the /upgrade's own bounce beat passed for
    # the /restart's). state/spine.pid is written once per boot (its TIME, not the pid, which
    # Windows may reuse), so a newer spine.pid and a beat newer than it is the spine that came
    # back. No spine.pid to compare -> the beat alone, as before.
    if ($boot0) {
      $bootNow = Get-SpineBoot
      if (-not $bootNow -or $bootNow -eq $boot0) { continue }
      if ((Get-Item $alive).LastWriteTime -le $bootNow) { continue }
    }
    # Heartbeat moved. If we know what should have landed, hold out for it.
    if (-not $target) { return $true }
    if ((Get-ShortHead $git $Repo) -eq $target) { return $true }
  }
  return $false
}

$ok = Invoke-Bounce '/upgrade'

$after = Get-ShortHead $git $Repo

Write-Host ""
if ($ok -and $target -and $after -ne $target) {
  # The spine came back -- on the WRONG code. Loudest possible, because a green here is how
  # you lose an hour later wondering why a fix you "deployed" is not in effect.
  Write-Host "=== DEPLOY FAILED -- the spine restarted on the OLD code ===" -ForegroundColor Red
  Write-Host "  prod is at $after, but the remote's main is $target"
  Write-Host "  the pull did not land. Check the daemon log:"
  Write-Host "  $EgptHome\config\logs\service-stdout.log"
  exit 1
} elseif ($ok) {
  Write-Host "=== DEPLOY OK ===" -ForegroundColor Green
  Write-Host "  prod    $before -> $after"
  if ($before -eq $after) {
    if ($remoteErr) {
      # Say WHICH kind of no-op this was. These look identical in the sha and are not the
      # same event at all: one means nothing needed doing, the other means nothing could be done.
      Write-Host "  (same commit -- REMOTE UNREACHABLE, so nothing could be pulled; rebuilt and respawned the existing code)" -ForegroundColor Yellow
    } else {
      Write-Host "  (same commit -- it was already current; rebuilt and respawned anyway)" -ForegroundColor DarkGray
    }
  }
  Write-Host ("  heartbeat: " + (Get-Item $alive).LastWriteTime.ToString('HH:mm:ss'))
} else {
  Write-Host "=== NO HEARTBEAT after $TimeoutSec s ===" -ForegroundColor Red
  Write-Host "  prod is at $after. The spine may still be building, or the daemon is wedged."
  Write-Host "  Check the log:  $EgptHome\config\logs\service-stdout.log"
  exit 1
}

# --- MIGRATIONS: the structural half of a deploy. Only now, once prod verifiably holds the new
#     code, so the migrations that run are the ones that just shipped. Here and NOT at boot: boot
#     is what the watchdog retries in a loop, so a broken migration there is a crash loop, while
#     here it is one red line. The runner reads THIS profile's ledger, skips what is recorded,
#     and says PENDING for what needs elevation - this script never elevates, so those wait for
#     an admin shell (see setup\migrate.mjs). A failure does not undo the deploy that already
#     landed; it stops the migration chain, lets the peer still deploy, and fails this script
#     at the end. ---
$migrationsFailed = $false
$migrationsApplied = $false
$runner = Join-Path $Repo 'setup\migrate.mjs'
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
Write-Host ""
if (-not (Test-Path $runner)) {
  Write-Host "  migrations SKIPPED -- prod has no $runner" -ForegroundColor Yellow
} elseif (-not $nodeExe) {
  Write-Host "  migrations NOT RUN -- node is not on PATH" -ForegroundColor Red
  $migrationsFailed = $true
} else {
  # Same PS 5.1 trap as the git probes above: if this host captures a native stderr line (a
  # PowerShell script the runner calls can throw), 'Stop' would turn it into a terminating
  # error and kill the report of the very failure it describes. Drop it for the call.
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  # Tee'd, not captured: the runner's lines still print as they come, and the copy is how the
  # step below knows whether anything was APPLIED (the runner's own per-migration line).
  & $nodeExe $runner --egpt-home $EgptHome | Tee-Object -Variable migrateOut
  $migrateRc = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  $migrationsApplied = @($migrateOut | Where-Object { "$_" -match '\sAPPLIED - recorded' }).Count -gt 0
  if ($migrateRc -eq 2) {
    Write-Host "=== MIGRATIONS PENDING ELEVATION -- the node is not converged until they run (see above) ===" -ForegroundColor Yellow
  } elseif ($migrateRc -ne 0) {
    Write-Host "=== MIGRATIONS FAILED (exit $migrateRc) -- the deploy landed, the migration chain stopped ===" -ForegroundColor Red
    $migrationsFailed = $true
  }
}

# --- A MIGRATION THAT CHANGED THE NODE NEEDS ONE MORE BOUNCE (found live on kg, 2026-09-28).
#     The migrations run AFTER the spine bounced, and the spine reads config.yaml ONCE, at boot
#     (src/spine/boot.mjs `const cfg = readConfig()`; the per-message refresh re-scans the
#     conversation/room resolver, never node keys). 0034 added `global_read_paths` at 16:10:37 to
#     a spine that booted at 16:10:33, so every boxed session after it launched without its read
#     mounts until the NEXT restart. So: anything APPLIED -> drop /restart and wait for that bounce
#     exactly as for the /upgrade (it drains in-flight turns too). Nothing applied -> no restart. ---
if ($migrationsApplied) {
  Write-Host ""
  Write-Host "config migrations applied - restarting once more so the spine reads them" -ForegroundColor Yellow
  if (-not (Invoke-Bounce '/restart')) {
    Write-Host "=== NO HEARTBEAT after the /restart ($TimeoutSec s) ===" -ForegroundColor Red
    Write-Host "  The deploy and its migrations landed; the spine did not come back from the restart."
    Write-Host "  Check the log:  $EgptHome\config\logs\service-stdout.log"
    exit 1
  }
  Write-Host ("  restarted -- heartbeat: " + (Get-Item $alive).LastWriteTime.ToString('HH:mm:ss')) -ForegroundColor Green
}

# --- the peer, by running THIS SAME SCRIPT there over ssh: the remote copy does its own
#     drop + heartbeat proof, so there is one deploy procedure, never a second one that
#     drifts. `~` resolves on the REMOTE shell, so no path is hardcoded here. ---
if ($Peer) {
  Write-Host ""
  Write-Host "Peer $Peer :" -ForegroundColor Cyan
  # The peer's SOURCE tree is fast-forwarded from HERE, not by the recursive call below. That
  # call runs the peer's OWN copy of this script out of ~/bin/egpt -- i.e. whatever version
  # was deployed BEFORE this run, which cannot be assumed to know about source trees at all.
  # Driving it from here means a deploy fixes the peer's source on the FIRST run rather than
  # the second; once the peer's copy is current it fast-forwards its own source too and simply
  # finds nothing left to do.
  Update-SourceTree "$Peer ~/src/egpt" $peerSrcGit
  Write-Host ""
  # FORWARD SLASHES, UNQUOTED, on purpose: backslashes are eaten in transit to the remote
  # shell (a quoted C:\Users\... arrives as C:\Users\anbinegpt...), and quoting to survive
  # both shells is worse. Windows accepts / in a path, and this one has no spaces.
  $remote = 'powershell -NoProfile -ExecutionPolicy Bypass -File ~/bin/egpt/setup/upgrade.ps1'
  & ssh -o ConnectTimeout=8 $Peer $remote
  if ($LASTEXITCODE -ne 0) { Write-Host "PEER DEPLOY FAILED (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
}

if ($migrationsFailed) { exit 1 }
