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
#   inheritable ReadAndExecute to the pool GROUP on the CLI tool dirs and on
#     ~\src\egpt  - the eGPT checkout, and since 2026-09-23 NOT all of ~\src;
#     the step after that one takes the old wide grant back off, and puts ~\src's
#     traverse ACE back, because `/remove:g` cannot take off one of a principal's
#     two ACEs and the walk-through is what makes the checkout reachable at all;
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
$StepCount = 8
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
  # narrowing one means REMOVING it, which is what the step after this does for
  # the one grant this script has actually retired (~\src). For any other, that
  # is still a hand operation (`icacls <path> /remove:g egpt-sandbox-pool`, then
  # re-run this script).
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
  # ~\src\egpt IS STANDING, NOT PER-TURN, and that is a decision rather than an
  # accident. It is the other half of the `src` junction the launcher plants in
  # every pool profile: a junction is only a name, and the TARGET's DACL decides
  # what a leased account may do through it. It cannot be per-turn - the junction
  # is part of the profile SHAPE, present between turns as well as during them,
  # and a link that only resolved while a lease was held would be exactly the
  # "told it may use a directory that then refuses it" failure the share ACEs
  # exist to close. Nor can it be afforded per-turn: a DACL write on this tree
  # re-propagates inheritance through node_modules, and the parent ~\src measured
  # 307 s for one pass. The cost, stated rather than left to be inferred: all 16
  # pool accounts can read the whole eGPT checkout, at all times.
  #
  # IT IS ~\src\egpt AND NO LONGER ~\src (operator 2026-09-23: "dismiss mounting
  # ~/src always, that was a faux-pas"). The 2026-09-20 shape granted the pool
  # ReadAndExecute on EVERY line of source the operator has ever checked out,
  # standing, for the sake of one checkout. The junction narrowed to the checkout
  # (Get-SandboxProfileJunctionStatement) and this narrowed with it; ~\src keeps
  # only the traverse-only ACE from the ancestor chain above, which is walk-
  # through and not read - so the pool can reach ~\src\egpt by name and still
  # cannot enumerate what else is in ~\src. Removing the old wide grant is the
  # step right after this one: leaving it would make the narrowing cosmetic.
  #
  # THE CHECKOUT'S ACE MUST BE ITS OWN, NOT AN INHERITED ONE, and that is what
  # makes the two steps safe in this order. Measured on the live node 2026-09-23,
  # ~\src\egpt read `egpt-sandbox-pool:(I)(OI)(CI)(RX)` - the (I) is INHERITED,
  # from the wide ~\src grant the next step retires, so retiring the parent would
  # have taken the checkout's access with it and silently. Grant-SandboxPoolAce's
  # "already granted" check is EXPLICIT-ONLY (see its header), so an inherited ACE
  # does not satisfy it and this step writes a real one on the object; a later
  # revoke on the parent then re-propagates inheritance and leaves that explicit
  # ACE exactly where it is. The requirement it is serving is the operator's, in
  # one line: "make sure agents can always see their own code".
  #
  # KEEP THE TWO KINDS APART when reading an icacls dump of this tree: an ACE
  # naming the GROUP (egpt-sandbox-pool) is this permanent grant; one naming an
  # individual egpt-sbx-NN is lease litter, and the last step of this script is
  # what clears it.
  $srcDir = Join-Path $env:USERPROFILE 'src'
  $repoDir = Join-Path $srcDir 'egpt'
  $readOnly = [ordered]@{
    'the Claude Code bin dir' = Join-Path $env:USERPROFILE '.local\bin'
    'the RUNNING eGPT tree'   = Join-Path $env:USERPROFILE 'bin\egpt'
    'the EDITABLE eGPT checkout (what every pool profile mounts as ~\src)' = $repoDir
    'the npm global root'     = Join-Path $env:APPDATA 'npm'
  }
  $step = Start-Step "standing read-only grants for '$SandboxPoolGroup' on $($readOnly.Count) tool and source directories" `
    'A FIRST run writes these, and ~\src\egpt alone takes minutes: it is full of node_modules and every DACL write re-propagates inheritance over the lot. Not hung. A node already provisioned writes nothing and says "already granted".'
  Stop-Step $step (Grant-PoolOn -Targets $readOnly -Grant 'Read')

  # ---- AND THE OLD WIDE GRANT COMES OFF. BOTH HALVES OR IT IS A MIRROR OF THE
  # BUG (operator 2026-09-23). The junction no longer points at ~\src, but a node
  # provisioned before today still carries `egpt-sandbox-pool:(OI)(CI)(RX)` there,
  # and that ACE is inherited by every sibling checkout in it - so the pool would
  # keep read access to all of the operator's source through a link that no longer
  # advertises it, which is worse than the state being retired, not better.
  #
  # Revoke-SandboxPathAces, not a second icacls line: it is the ONE revoke in this
  # sandbox, it reads the DACL first, and the first run on a node that has the ACE
  # pays one re-propagation over ~\src, which is minutes - said here rather than
  # discovered as a hang.
  #
  # THE GROUP, NEVER AN ACCOUNT: an ACE naming an individual egpt-sbx-NN under
  # ~\src is lease litter and belongs to the sweep at the end of this script; this
  # step takes off exactly the standing grant this script used to write.
  #
  # ---- AND IT PUTS THE TRAVERSE ACE BACK, WHICH IS THE WHOLE OF THIS STEP'S
  # CORRECTION (2026-09-23, second pass). `/remove:g` takes off EVERY explicit ACE
  # for the named principal on that object - it cannot remove one of two - and
  # ~\src carries TWO for this group: the wide (OI)(CI)(RX) being retired here and
  # the traverse-only (X,RA,RC) the ancestor step above just granted. So the
  # revoke as first written removed BOTH, every run, and left the pool unable to
  # WALK ~\src at all.
  #
  # THAT BREAKS THE ONE THING THE OPERATOR ASKED TO PRESERVE - "make sure agents
  # can always see their own code". ~\src\egpt's own explicit ReadAndExecute
  # (granted in the step above) is an ACE on the CHECKOUT, and an ACE on a leaf
  # buys nothing unless every directory above it can be opened: the per-profile
  # `src` junction points AT the checkout, and a junction is only a name - the
  # kernel checks the TARGET's DACL, and Node stats every component on the way.
  #
  # CHECK FIRST, SO A CONVERGED RUN STILL WRITES NOTHING. A blind revoke-then-
  # re-grant would cost TWO re-propagations over ~\src on every single run (that
  # tree measured 307 s a pass), and this script's whole 2026-09-20 correction was
  # that a grant is a fact to converge on. Test-SandboxPoolAcePresent asks for
  # exactly the ACE being retired - the same "already granted" predicate
  # Grant-SandboxPoolAce itself branches on, so the two cannot disagree - and on a
  # node already narrowed the answer is no and not one DACL is touched.
  $step = Start-Step "retiring the old standing grant for '$SandboxPoolGroup' on $srcDir" `
    'This is the OTHER half of narrowing the src mount to the eGPT checkout. Nothing to do on a node already narrowed; on one that is not, removing an inheritable ACE re-propagates over the whole tree and takes minutes.'
  $poolGroupSid = Get-SandboxPoolGroupSid
  if (-not (Test-SandboxPoolAcePresent -Path $srcDir -Grant 'Read' -Sid $poolGroupSid)) {
    Write-Host "         $srcDir : already narrowed  - no wide read grant for '$SandboxPoolGroup' on it, nothing written"
    Stop-Step $step '0 wide grant(s) removed'
  } else {
    $retired = @(Revoke-SandboxPathAces -Path $srcDir -AccountNames @($SandboxPoolGroup))
    foreach ($rec in $retired) { Write-Host "         $srcDir : $($rec.Status)  - $($rec.Message)" }
    if (@($retired | Where-Object { $_.Status -eq 'failed' }).Count -gt 0) {
      throw "the wide '$SandboxPoolGroup' grant on $srcDir is still there after the revoke  - see the line(s) above"
    }
    # The traverse ACE went out with it (one principal, one /remove:g). Put it
    # back through the ONE granting call, so the ancestor chain this script
    # promises in its own summary is actually the state it leaves behind.
    Write-Host "         $srcDir : re-granting the traverse ACE the revoke took off with it"
    Grant-SandboxPoolAce -Path $srcDir -Grant 'Traverse' | Out-Null
    Stop-Step $step (@($retired | Where-Object { $_.Status -eq 'revoked' }).Count.ToString() + ' wide grant(s) removed, traverse restored')
  }

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

  Write-Host ("OK: sandbox pool ready in {0:n1}s  - created {1}, already existed {2}. Group '{3}' holds traverse-only on the ancestor chain above the conversation folders (including {4}, walk-through and NOT read), ReadAndExecute on the CLI tool dirs and on {5} (the standing read-only view every pool profile's src junction points at), and Modify on pi's config dir. Credential dir {6} hardened (no BUILTIN\Users access)." -f $runWatch.Elapsed.TotalSeconds, $pool.Created, $pool.Existed, $SandboxPoolGroup, $srcDir, $repoDir, $CredDir)
} catch {
  Write-Host ("FAILED after {0:n1}s at step {1}/{2}: {3}" -f $runWatch.Elapsed.TotalSeconds, $script:StepIndex, $StepCount, $_.Exception.Message)
  exit 1
}
