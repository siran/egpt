# setup/upgrade.ps1 -- the EVERYDAY deploy: drop /upgrade in the ingest box, then VERIFY.
#
# The spine sweeps EGPT_HOME/state/ingest every second, consumes the file, and exits 42;
# the daemon then does git pull + build + respawn (src/spine/ingest.mjs). That is the whole
# deploy. This script adds the part that is tedious by hand: proving it actually landed.
#
# Use setup/deploy.ps1 INSTEAD when the change alters what the SUPERVISOR spawns (an
# entry-point rename, daemon-runtime appPath). That one restarts the service and needs UAC.
# This one never elevates -- it writes one file into your own profile.
#
# ASCII ONLY, deliberately: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI, so a
# non-ASCII character here (an em-dash, an arrow) mangles into bytes that break the parser.
#
#   powershell -ExecutionPolicy Bypass -File setup\upgrade.ps1
#   powershell -ExecutionPolicy Bypass -File setup\upgrade.ps1 -EgptHome "$env:USERPROFILE\.egpt2"
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

$stop   = Join-Path $EgptHome 'STOP'
$alive  = Join-Path $EgptHome 'state\alive.txt'
$ingest = Join-Path $EgptHome 'state\ingest'

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
# The peer's shell is cmd.exe and ssh flattens argv into one command line, so anything quoted
# arrives mangled. Everything here is therefore quote-free and space-free; %USERPROFILE%
# expands on the REMOTE, exactly as the recursive call at the bottom of this script does it.
$peerSrcGit = {
  param([string[]]$a)
  $remote = @('git', '-C', '%USERPROFILE%/src/egpt') + $a
  & ssh -o ConnectTimeout=8 $Peer @remote
}

$before = Get-ShortHead $git $Repo
$beat0 = (Get-Item $alive).LastWriteTime

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

# --- temp -> rename, because the sweep skips *.tmp so a half-written file is never read ---
New-Item -ItemType Directory -Force -Path $ingest | Out-Null
$tmp   = Join-Path $ingest 'upgrade.tmp'
$final = Join-Path $ingest 'upgrade'
[IO.File]::WriteAllText($tmp, "/upgrade", (New-Object Text.UTF8Encoding $false))
Move-Item -Path $tmp -Destination $final -Force
Write-Host "dropped /upgrade into the ingest box -- waiting for the spine to bounce..." -ForegroundColor Yellow

# --- the proof is the HEARTBEAT advancing: only a live spine writes alive.txt. The sha may
#     legitimately not move (already current), so it is reported, never required. ---
# A CHANGED HEARTBEAT ALONE IS NOT PROOF, and reading it as proof produced a false FAILURE on
# 2026-08-08: the OLD spine's 60s beat can fire between the drop and the daemon finishing its
# pull, so the loop saw "bounced", read the sha while git was still working, and reported the
# node as stuck on old code -- while the pull was in fact succeeding. So when we know the
# TARGET, wait for the repo to actually reach it; the heartbeat is the liveness half only.
$ok = $false
for ($i = 0; $i -lt $TimeoutSec; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $stop) {
    Write-Host "FAILED: $stop appeared during the deploy -- the node stopped itself." -ForegroundColor Red
    foreach ($ln in (Get-Content $stop)) { Write-Host "  $ln" -ForegroundColor DarkGray }
    exit 1
  }
  $beat = (Get-Item $alive).LastWriteTime -ne $beat0
  if (-not $beat) { continue }
  # Heartbeat moved. If we know what should have landed, hold out for it.
  if (-not $target) { $ok = $true; break }
  if ((Get-ShortHead $git $Repo) -eq $target) { $ok = $true; break }
}

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

# --- the peer, by running THIS SAME SCRIPT there over ssh: the remote copy does its own
#     drop + heartbeat proof, so there is one deploy procedure, never a second one that
#     drifts. %USERPROFILE% expands on the REMOTE shell, so no path is hardcoded here. ---
if ($Peer) {
  Write-Host ""
  Write-Host "Peer $Peer :" -ForegroundColor Cyan
  # The peer's SOURCE tree is fast-forwarded from HERE, not by the recursive call below. That
  # call runs the peer's OWN copy of this script out of ~/bin/egpt -- i.e. whatever version
  # was deployed BEFORE this run, which cannot be assumed to know about source trees at all.
  # Driving it from here means a deploy fixes the peer's source on the FIRST run rather than
  # the second; once the peer's copy is current it fast-forwards its own source too and simply
  # finds nothing left to do.
  Update-SourceTree "$Peer %USERPROFILE%/src/egpt" $peerSrcGit
  Write-Host ""
  # FORWARD SLASHES, UNQUOTED, on purpose: backslashes are eaten in transit to the remote
  # shell (a quoted C:\Users\... arrives as C:\Users\anbinegpt...), and quoting to survive
  # both shells is worse. Windows accepts / in a path, and this one has no spaces.
  $remote = 'powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%/bin/egpt/setup/upgrade.ps1'
  & ssh -o ConnectTimeout=8 $Peer $remote
  if ($LASTEXITCODE -ne 0) { Write-Host "PEER DEPLOY FAILED (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
}
