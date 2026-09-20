# provision-sandbox-account.ps1  - operator-run, one-time (idempotent)
# provisioning of the POOL of disposable local accounts used by
# sandbox-logon-launcher.ps1. New-LocalUser/Set-LocalUser need local-
# Administrator rights, which the launcher's own daemon process does NOT run
# with (by design  - keeps the daemon unelevated). This script self-elevates
# via a UAC prompt, does the provisioning, and exits  - no lasting elevation.
#
# Launchable non-interactively (e.g. `powershell -File provision-sandbox-account.ps1`
# from another process): the only prompt is the OS's native UAC consent dialog
# when relaunching elevated.
#
# A GRANT IS A FACT TO CONVERGE ON, NOT A COMMAND TO RE-ISSUE (operator
# 2026-09-20, after watching this script sit on the ancestor chain: "the script
# is doing something slow and perhaps weird with the ACLs.... it shouldn't be
# complicated, it has to be easy to review"). Every ACL step below goes through
# Grant-SandboxPoolAce, which READS the DACL and writes only when the ACE it
# wants is missing or wrong. On an already-provisioned node this whole run is
# seconds and every path says "already granted" - all five ancestors and ~\src
# were already correct on the run he watched. The FIRST run on a node is the slow
# one: writing a DACL on a container makes Windows re-run inheritance propagation
# over the whole subtree, and ~\src measured 307 s for a single pass on reve.
# Grant-SandboxPoolAce carries the rest of the measurements and the
# icacls-not-Set-Acl reason.
#
# WHAT IS GRANTED TO WHOM  - the model, which is not what changed:
#   traverse-only (X,RA,RC), NOT inheritable, to the pool GROUP on each ancestor
#     directory above the conversation folders;
#   inheritable ReadAndExecute to the pool GROUP on the CLI tool dirs and ~\src;
#   inheritable Modify to the pool GROUP on pi's own config dir;
#   per-lease Modify to ONE pool ACCOUNT on ONE conversation folder  - NOT here;
#     that is the launcher's, granted at launch and revoked with the lease. The
#     last step of this script is the repair path for the ones a hard-killed turn
#     left behind.

$ErrorActionPreference = 'Stop'

$isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isElevated) {
  Write-Host "Not elevated - relaunching with a UAC prompt..."
  $scriptPath = $MyInvocation.MyCommand.Path
  $proc = Start-Process powershell.exe -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath
  ) -Wait -PassThru
  $LASTEXITCODE = $proc.ExitCode
  exit $LASTEXITCODE
}

. (Join-Path $PSScriptRoot 'sandbox-account.ps1')

# PROGRESS, BECAUSE THIS SCRIPT USED TO LOOK HUNG (operator 2026-09-20: it
# printed nothing for minutes, "script seem to have hung", then "oh i closed the
# window... please make script show progress"). Each step announces its number
# and what it is about to touch before it starts, then reports its own elapsed
# seconds. A step that finds nothing to do says so in one line.
$StepCount = 7
$script:StepIndex = 0
function Start-Step {
  param([Parameter(Mandatory = $true)][string]$What, [string]$Warn = '')
  $script:StepIndex++
  Write-Host "[$script:StepIndex/$StepCount] $What"
  if ($Warn) { Write-Host "         $Warn" }
  return [System.Diagnostics.Stopwatch]::StartNew()
}
function Stop-Step {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Stopwatch]$Watch, [string]$Result = 'done')
  $Watch.Stop()
  Write-Host ("         {0}  - {1:n1}s" -f $Result, $Watch.Elapsed.TotalSeconds)
}

# ONE STEP'S WORTH OF GRANTS: the same ACE on each path of a named list, one
# short line per path saying what happened to it, and a one-line tally for the
# step. Grant-SandboxPoolAce decides whether anything is written; this only
# reports, and skips a path that is not on this node.
#
# SKIP-IF-ABSENT IS PER PATH, deliberately: ~\src is on a dev node and not on a
# plain one, the whatsapp folder only appears once a chat has landed, and pi's
# config dir only after pi has run once. A node that grows one later picks it up
# the next time this runs.
function Grant-PoolOn {
  param(
    [Parameter(Mandatory = $true)]$Targets,
    [Parameter(Mandatory = $true)][ValidateSet('Traverse', 'Read', 'Modify')][string]$Grant
  )
  $written = 0; $already = 0; $absent = 0
  foreach ($label in $Targets.Keys) {
    $path = $Targets[$label]
    if (-not (Test-Path -LiteralPath $path)) {
      Write-Host "         $label ($path): not on this node  - skipped"
      $absent++
      continue
    }
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    if ((Grant-SandboxPoolAce -Path $path -Grant $Grant) -eq 'already granted') {
      Write-Host "         $label ($path): already granted"
      $already++
    } else {
      Write-Host ("         {0} ({1}): granted  - {2:n1}s" -f $label, $path, $watch.Elapsed.TotalSeconds)
      $written++
    }
  }
  return "$written written, $already already correct, $absent not on this node"
}

$runWatch = [System.Diagnostics.Stopwatch]::StartNew()
try {
  $step = Start-Step "ensuring the $SandboxPoolSize-account sandbox pool exists (one line per account below)"
  $pool = Ensure-SandboxPool
  Stop-Step $step "created $($pool.Created), already existed $($pool.Existed)"

  $step = Start-Step "ensuring the '$SandboxPoolGroup' group exists and holds all $SandboxPoolSize accounts"
  Ensure-SandboxPoolGroup
  Stop-Step $step

  # THE ANCESTOR CHAIN, TRAVERSE ONLY (operator 2026-09-13, "nothing should be
  # hand-applied, everything structural"). These five were applied BY HAND on
  # both nodes and existed in no script, so a rebuild from this file produced a
  # node where two live features silently did not work.
  #
  # Every ACE the launcher writes per turn is on a LEAF - a conversation folder,
  # a share path - and a leaf ACE buys nothing unless the pool can OPEN each
  # directory above it. See Grant-SandboxPoolAce's table for what (X,RA,RC) buys,
  # what it deliberately withholds (list-directory: a being reaches the folder it
  # was granted BY NAME and still cannot enumerate the operator's home or the
  # names of other conversations), and why it is not inherited.
  $ancestors = [ordered]@{
    'the operator home'   = $env:USERPROFILE
    'the eGPT state dir'  = Join-Path $env:USERPROFILE '.egpt'
    'the conversations'   = Join-Path $env:USERPROFILE '.egpt\conversations'
    'the whatsapp chats'  = Join-Path $env:USERPROFILE '.egpt\conversations\whatsapp'
    'the operator source' = Join-Path $env:USERPROFILE 'src'
  }
  $step = Start-Step "traverse-only grants on the $($ancestors.Count) ancestor directories above the conversation folders"
  Stop-Step $step (Grant-PoolOn -Targets $ancestors -Grant 'Traverse')

  # THE STANDING READ GRANTS. All four go to the pool GROUP, ReadAndExecute and
  # never more, inheritable because the subtree is the point. Windows UNIONS
  # Allow ACEs, so none of them can be narrowed by anything granted later -
  # narrowing one is a hand operation (`icacls <path> /remove:g egpt-sandbox-pool`,
  # then re-run this script).
  #
  #   ~\.local\bin   ccode: claude.exe (warm-cli-session's resolveClaudeBin
  #                  prefers ~/.local/bin).
  #   ~\bin\egpt     the RUNNING eGPT tree, READ ONLY (operator 2026-09-13,
  #                  reversing 2026-09-10's Modify: "since egpt is executed by
  #                  'an' then it could actually nuke my computer"). The daemon
  #                  EXECUTES this tree AS THE OPERATOR, so a group Modify ACE
  #                  here let any of the 16 pool accounts place code that runs
  #                  outside the sandbox at the next restart, with no deploy step
  #                  in between. A being that must change its own code gets the
  #                  EDITABLE checkout under ~\src instead, where an edit reaches
  #                  a running node only after a human commits, pushes, deploys.
  #   %APPDATA%\npm  pi AND codex: both are npm globals, and neither is launched
  #                  as its own .exe - the .cmd shims are not PE images, so the
  #                  launcher runs node.exe against the package's JS entry. That
  #                  JS sits under the operator's profile, which denies Users, so
  #                  one grant on the npm root covers both engines. Global npm
  #                  packages are public code; no credential lives here (pi's
  #                  auth.json is in ~\.pi).
  #
  # ~\src IS STANDING, NOT PER-TURN, and that is a decision rather than an
  # accident (operator 2026-09-20: "can we make that sandbox account's sbx/src/
  # path points to src/an read-only?"). It is the other half of the `src`
  # junction the launcher plants in every pool profile: a junction is only a
  # name, and the TARGET's DACL decides what a leased account may do through it.
  # It cannot be per-turn - the junction is part of the profile SHAPE, present
  # between turns as well as during them, and a link that only resolved while a
  # lease was held would be exactly the "told it may use a directory that then
  # refuses it" failure the share ACEs exist to close. The cost, stated rather
  # than left to be inferred: all 16 pool accounts can read ALL of the operator's
  # source, at all times.
  #
  # KEEP THE TWO KINDS APART when reading an icacls dump of this tree: an ACE
  # naming the GROUP (egpt-sandbox-pool) is this permanent grant; one naming an
  # individual egpt-sbx-NN is lease litter, and the last step of this script is
  # what clears it.
  $srcDir = Join-Path $env:USERPROFILE 'src'
  $readOnly = [ordered]@{
    'the Claude Code bin dir'      = Join-Path $env:USERPROFILE '.local\bin'
    'the RUNNING eGPT tree'        = Join-Path $env:USERPROFILE 'bin\egpt'
    "ALL of the operator's source" = $srcDir
    'the npm global root'          = Join-Path $env:APPDATA 'npm'
  }
  $step = Start-Step "standing read-only grants for '$SandboxPoolGroup' on $($readOnly.Count) tool and source directories" `
    'A FIRST run writes these, and ~\src alone takes about five minutes: it is full of node_modules and every DACL write re-propagates inheritance over the lot. Not hung. A node already provisioned writes nothing and says "already granted".'
  Stop-Step $step (Grant-PoolOn -Targets $readOnly -Grant 'Read')

  # pi (@p): LET PI KEEP ITS OWN DEFAULT CONFIG DIR (~/.pi/agent) and point the
  # sandbox at it, rather than relocating pi to a directory eGPT invented
  # (operator 2026-08-27). PI_CODING_AGENT_DIR is MACHINE scope - the launcher
  # passes lpEnvironment = NULL, so it cannot be handed over per-spawn - which
  # means setting it redirects EVERY pi on the box, including the operator's own
  # terminal; pointing it at pi's OWN default is what makes that a no-op for
  # them. It is REQUIRED for a sandboxed turn: under the launcher the being runs
  # as a pool account whose USERPROFILE is C:\Users\egpt-sbx-NN, so pi's
  # "default" would resolve to a profile with no config and the turn dies with
  # 'Model "..." not found'.
  #
  # Modify, not read: pi WRITES there (settings lock, runtime creation) and fails
  # the turn without it. Deliberately NO deny on auth.json - pi handles a MISSING
  # file fine, but an EPERM wedges it (it accepts the prompt and never starts the
  # agent), so a sandboxed turn can read whatever credentials pi stores there.
  # Keep cloud logins out of pi if that matters.
  $piDir = Join-Path (Join-Path $env:USERPROFILE '.pi') 'agent'
  $step = Start-Step "PI_CODING_AGENT_DIR (machine scope) and a read-write grant on pi's own config dir"
  [Environment]::SetEnvironmentVariable('PI_CODING_AGENT_DIR', $piDir, 'Machine')
  Stop-Step $step (Grant-PoolOn -Targets ([ordered]@{ "pi's config dir (run pi once if it is missing)" = $piDir }) -Grant 'Modify')

  # pi's bash tool: WARN, never rewrite - pi owns its own settings.json. Two
  # failures this one setting avoids, both measured as a real leased pool account
  # (2026-09-14): `where bash` finds C:\Windows\System32\bash.exe first, the WSL
  # launcher, which exits 1 with no distro installed; and a REAL bash can still
  # die 0xC0000022, because an msys2/cygwin runtime needs to CREATE its shared
  # memory object directory under \Sessions\BNOLINKS and a pool account may only
  # OPEN one that is already there - so such a bash works only while some process
  # keeps that installation warm in the spine's session. Point shellPath at one
  # that is. src/sandbox-cli-session.mjs carries the full measurement and does the
  # same job for Claude Code via CLAUDE_CODE_GIT_BASH_PATH.
  $piSettings = Join-Path $piDir 'settings.json'
  $shell = $null
  try { $shell = (Get-Content -LiteralPath $piSettings -Raw | ConvertFrom-Json).shellPath } catch { }
  if (-not $shell) {
    Write-Host "WARNING: $piSettings has no shellPath. pi's bash tool will resolve to WSL's bash.exe and fail. Set it to a real bash, e.g. C:/msys64/usr/bin/bash.exe"
  } elseif (-not (Test-Path -LiteralPath $shell)) {
    Write-Host "WARNING: pi shellPath points at a missing file: $shell"
  } else {
    Write-Host "ok: pi shellPath = $shell"
  }

  # Must come AFTER Ensure-SandboxPool: that is what creates the credential
  # files this locks down. Needs admin, which is exactly why it lives here and
  # not in the (unelevated) launcher.
  $step = Start-Step "hardening the credential dir (no BUILTIN\Users access): $CredDir"
  Protect-SandboxCredDir
  Stop-Step $step

  # THE LEASE LITTER, CLEARED (operator 2026-09-20, measured on kg: twelve
  # standing (OI)(CI)(RX) ACEs on ~\src\egpt, one per pool account). Those are
  # LEASE ACEs from `allowed_paths` share paths whose turn was killed before its
  # revoke ran - the NORMAL end of a sandboxed session, not a rare crash, because
  # the warm pool ends a CLI process with TerminateProcess and a PowerShell
  # `finally` does not survive that. The launcher revokes them when it next leases
  # the SAME account; an account nothing leases again keeps them forever, which is
  # how twelve piled up on one shared path.
  #
  # It reads each dead lease's own ledger, so it revokes exactly what was granted
  # and never goes hunting through the filesystem, and it leaves a lock a running
  # turn still holds alone. AFTER Protect-SandboxCredDir, deliberately: that call
  # rewrites the ACL of the directory these locks live in.
  $step = Start-Step "sweeping abandoned lease locks in $SandboxLocksDir" `
    'one icacls pass per distinct path; a lease whose ACEs are already gone reconciles to clean and costs no write at all.'
  $reclaimed = @(Clear-SandboxAbandonedLeases)
  foreach ($rec in $reclaimed) {
    if ($rec.Status -eq 'held') { continue }
    Write-Host "         lease $($rec.Account): $($rec.Status)  - $($rec.Message)"
  }
  $heldCount = @($reclaimed | Where-Object { $_.Status -eq 'held' }).Count
  $aceCount = @($reclaimed | ForEach-Object { $_.Aces } | Where-Object { $_.Status -eq 'revoked' }).Count
  Stop-Step $step "$(@($reclaimed | Where-Object { $_.Status -eq 'reclaimed' }).Count) lock(s) released, $aceCount leaked ACE(s) revoked, $heldCount lease(s) left alone because a turn still holds them"

  Write-Host ("OK: sandbox pool ready in {0:n1}s  - created {1}, already existed {2}. Group '{3}' holds traverse-only on the ancestor chain above the conversation folders, ReadAndExecute on the CLI tool dirs and on {4} (the standing read-only view every pool profile's src and my-code junctions point at), and Modify on pi's config dir. Credential dir {5} hardened (no BUILTIN\Users access)." -f $runWatch.Elapsed.TotalSeconds, $pool.Created, $pool.Existed, $SandboxPoolGroup, $srcDir, $CredDir)
} catch {
  Write-Host ("FAILED after {0:n1}s at step {1}/{2}: {3}" -f $runWatch.Elapsed.TotalSeconds, $script:StepIndex, $StepCount, $_.Exception.Message)
  exit 1
}
