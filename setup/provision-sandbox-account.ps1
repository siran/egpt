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

# PROGRESS, BECAUSE THIS SCRIPT IS SLOW AND USED TO LOOK HUNG (operator
# 2026-09-20: it printed nothing for minutes, "script seem to have hung", then
# "oh i closed the window... please make script show progress"). It had not hung:
# it was writing DACLs on ~\src and revoking fifteen abandoned leases, and a DACL
# write on a container makes Windows re-run inheritance propagation over the
# whole subtree - 307 s for one pass over ~\src, measured by hand on reve.
#
# THE RULE THIS ENCODES: a step that can take minutes SAYS SO BEFORE IT STARTS,
# not after. Each one announces its number, what it is about to touch and any
# expected cost, then reports its own elapsed seconds. Same Write-Host shape the
# rest of this file already uses; the library half (sandbox-account.ps1) logs
# through Log, to stderr, and both land in this window.
$StepCount = 10
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

$runWatch = [System.Diagnostics.Stopwatch]::StartNew()
try {
  $step = Start-Step "ensuring the $SandboxPoolSize-account sandbox pool exists (one line per account below)"
  $result = Ensure-SandboxPool
  Stop-Step $step "created $($result.Created), already existed $($result.Existed)"

  $step = Start-Step "ensuring the '$SandboxPoolGroup' group exists and holds all $SandboxPoolSize accounts"
  Ensure-SandboxPoolGroup
  Stop-Step $step

  # THE ANCESTOR CHAIN, TRAVERSE ONLY (operator 2026-09-13, "nothing should be
  # hand-applied, everything structural"). These five were applied BY HAND on
  # both nodes and existed in no script, so a rebuild from this file produced a
  # node where two live features silently did not work.
  #
  # Every ACE the launcher writes per turn is on a LEAF  - a conversation
  # folder, a share path  - and a leaf ACE buys nothing unless the pool can OPEN
  # each directory above it. Not WALK it: the pool token's bypass-traverse covers
  # the walk, measured. It is the per-component lstat that Node  - and so Claude
  # Code  - does on the way that needs a real ACE; Grant-SandboxPoolTraverse
  # carries the measurement. (X,RA,RC) each, on the
  # directory itself, never inherited, and deliberately NOT list  - a sandboxed
  # being reaches a folder it was granted by name and still cannot enumerate the
  # operator's home or the names of other conversations. Grant-SandboxPoolTraverse
  # carries what was measured and why it is icacls and not Set-Acl.
  #
  # Skip-if-absent, per path: ~\src is on a dev node and not on a plain one, and
  # the whatsapp folder only appears once a chat has landed. A node that grows
  # one later picks it up the next time this runs.
  $traverseChain = @(
    $env:USERPROFILE,
    (Join-Path $env:USERPROFILE '.egpt'),
    (Join-Path $env:USERPROFILE '.egpt\conversations'),
    (Join-Path $env:USERPROFILE '.egpt\conversations\whatsapp'),
    (Join-Path $env:USERPROFILE 'src')
  )
  $step = Start-Step "traverse-only grants on the $($traverseChain.Count) ancestor directories above the conversation folders" `
    'SLOW: each one rewrites a DACL, and Windows then re-runs inheritance propagation over that whole subtree. ~\src alone took about 5 minutes on reve. Not hung.'
  $traverseNo = 0
  foreach ($traversePath in $traverseChain) {
    $traverseNo++
    if (Test-Path -LiteralPath $traversePath) {
      Write-Host "         path $traverseNo/$($traverseChain.Count): $traversePath"
      $pathWatch = [System.Diagnostics.Stopwatch]::StartNew()
      Grant-SandboxPoolTraverse -Path $traversePath
      $pathWatch.Stop()
      Write-Host ("         path {0}/{1} granted  - {2:n1}s" -f $traverseNo, $traverseChain.Count, $pathWatch.Elapsed.TotalSeconds)
    } else {
      Write-Host "         path $traverseNo/$($traverseChain.Count): $traversePath not present  - skipping its traverse grant on this node"
    }
  }
  Stop-Step $step "all $($traverseChain.Count) ancestor(s) processed"

  # ccode: claude.exe (warm-cli-session's resolveClaudeBin prefers ~/.local/bin).
  $claudeBinDir = Join-Path $env:USERPROFILE '.local\bin'
  $step = Start-Step "read-only grant for the pool group on the Claude Code bin dir: $claudeBinDir"
  Grant-SandboxPoolAccess -Path $claudeBinDir
  Stop-Step $step
  # pi AND codex: both are npm globals, and neither is launched as its own .exe --
  # the .cmd shims are not PE images, so the launcher runs node.exe against the
  # package's JS entry (codex-cli-session's resolveCodexCommand already does
  # exactly this). node.exe itself lives in Program Files and is world-readable;
  # the JS does NOT -- it sits under the operator's profile, which denies Users.
  # One grant on the npm root therefore covers both engines. Global npm packages
  # are public code; no credential lives here (pi's auth.json is in ~/.pi).
  # THE RUNNING eGPT TREE -- READ ONLY (operator 2026-09-13, reversing 2026-09-10).
  #
  # It was Modify, on the ruling "read-write in bin/egpt (the running copy). it's all in the
  # repo. let E modify itself." The cost of that was named here and accepted at the time, then
  # seen for what it is: "since egpt is executed by 'an' then it could actually nuke my
  # computer". bin/egpt is the tree the daemon EXECUTES AS THE OPERATOR, so a being writing
  # here places code that runs outside the sandbox at the next restart, with no deploy step in
  # between. A standing group Modify ACE handed that to all 16 pool accounts at once.
  #
  # Beings that need to change their own code get the EDITABLE checkout instead, per-turn and
  # per-being, via allowed_paths -> the launcher's -SharePath (~/src/egpt on this node). An
  # edit there reaches a running node only after a human commits, pushes and deploys.
  #
  # An ACE is the WHOLE gate for these beings: confinementFor returns {} for the `sandbox` and
  # `all` tiers, so the CLI-layer path confinement is off for them and no allowed_paths entry
  # would restrain what an ACE already permits. That cuts both ways, and it is why this one is
  # ReadAndExecute: Windows UNIONS Allow ACEs, so a per-turn read-only grant cannot subtract
  # write that a standing grant gives.
  #
  # THIS FUNCTION IS ADDITIVE AND NEVER REMOVES. Changing the line below stops a re-provision
  # from re-granting Modify; it does NOT revoke one already written. A node provisioned before
  # 2026-09-13 must have the old ACE removed by hand:
  #   icacls "%USERPROFILE%\bin\egpt" /remove:g egpt-sandbox-pool
  #   .\setup\provision-sandbox-account.ps1        # re-adds ReadAndExecute
  $runningTree = Join-Path $env:USERPROFILE 'bin\egpt'
  $step = Start-Step "read-only grant on the RUNNING eGPT tree: $runningTree" `
    'a node_modules tree, so expect tens of seconds to a few minutes.'
  if (Test-Path -LiteralPath $runningTree) {
    Grant-SandboxPoolAccess -Path $runningTree
    Stop-Step $step
  } else {
    Stop-Step $step 'not present on this node  - skipped'
  }

  # THE OPERATOR'S ~\src, READ-ONLY TO THE POOL - AND A DELIBERATELY STANDING GRANT
  # (operator 2026-09-20: "can we make that sandbox account's sbx/src/ path points to
  # src/an read-only?").
  #
  # This is the other half of the `src` junction the launcher plants in every pool
  # profile (see Clear-SandboxProfileContents). A junction is only a name: what a leased
  # account may do through it is decided entirely by the DACL of the TARGET, so without
  # this grant every pool profile would carry a ~\src the being can see and cannot open.
  #
  # STANDING, NOT PER-TURN, AND THAT IS THE DECISION RATHER THAN AN ACCIDENT. Every other
  # read grant in this file is standing too, but each of those covers one tool's
  # directory; this one covers ALL of the operator's source, for all 16 pool accounts, at
  # all times, whether a turn is running or not. It cannot be per-turn: the junction is
  # part of the profile SHAPE, present on every account between turns as well as during
  # them, and a link that only resolves while a lease is held would be exactly the "the
  # being is told it may use a directory that then refuses it" failure that the per-turn
  # share ACEs exist to close. The operator asked for the pool to see their src; the
  # honest way to give it is to say so here.
  #
  # KEEP THE TWO KINDS APART when reading an icacls dump of this tree. THIS ACE names the
  # GROUP (egpt-sandbox-pool) and is permanent. An ACE naming an individual egpt-sbx-NN is
  # a LEASE ACE from a being's `allowed_paths`, granted at launch and revoked at exit; one
  # of those still standing is litter, and Clear-SandboxAbandonedLeases below is what
  # clears it.
  #
  # ReadAndExecute and nothing more. Windows UNIONS Allow ACEs, so this can never be
  # narrowed by anything granted later - the same reasoning that made ~\bin\egpt
  # read-only, and the same reason narrowing it again would be a hand operation.
  #
  # SLOW, NOT HUNG - AND THE ONE THING IN THIS CHANGE THAT IS NOT MEASURED. ~\src already
  # costs about five minutes under Grant-SandboxPoolTraverse on this node (see its header:
  # writing any DACL on a container makes Windows re-run inheritance propagation over the
  # whole subtree, and ~\src is full of node_modules). This writes a SECOND DACL on the same
  # directory, through Set-Acl rather than icacls, and Grant-SandboxPoolTraverse's header
  # records that Set-Acl HUNG twice against C:\Users\an and had to be killed. It has not hung
  # on ~\src, but nor has it been tried there: the sibling grants Set-Acl is known-good on
  # (~\.local\bin, %APPDATA%\npm, ~\bin\egpt) are all far smaller. If this run sits on ~\src
  # for much more than ten minutes, kill it and grant it by hand instead, then re-run - the
  # rest of this script is idempotent:
  #   icacls "%USERPROFILE%\src" /grant egpt-sandbox-pool:(OI)(CI)(RX)
  $srcDir = Join-Path $env:USERPROFILE 'src'
  $step = Start-Step "read-only grant on ALL of the operator's source: $srcDir" `
    'THE SLOWEST STEP ON THIS NODE. Measured by hand on reve 2026-09-20: 307 s for one pass. It is full of node_modules and every DACL write re-propagates inheritance over the lot. If it sits here for much more than ten minutes, kill it, grant it by hand with `icacls "%USERPROFILE%\src" /grant egpt-sandbox-pool:(OI)(CI)(RX)` and re-run - the rest of this script is idempotent.'
  if (Test-Path -LiteralPath $srcDir) {
    Grant-SandboxPoolAccess -Path $srcDir
    Stop-Step $step
  } else {
    Stop-Step $step "not present on this node  - skipped (the pool profiles' src and my-code junctions will dangle until it exists)"
  }

  $npmGlobalDir = Join-Path $env:APPDATA 'npm'
  $step = Start-Step "read-only grant on the npm global root (pi and codex): $npmGlobalDir"
  if (Test-Path -LiteralPath $npmGlobalDir) {
    Grant-SandboxPoolAccess -Path $npmGlobalDir
    Stop-Step $step
  } else {
    Stop-Step $step 'not present on this node  - skipped'
  }
  # pi (@p): LET PI KEEP ITS OWN DEFAULT CONFIG DIR (~/.pi/agent) and point the
  # sandbox at it, rather than relocating pi to a directory eGPT invented
  # (operator 2026-08-27). PI_CODING_AGENT_DIR is MACHINE scope -- the launcher
  # passes lpEnvironment = NULL so it cannot be per-spawn -- which means setting
  # it redirects EVERY pi on the box, including the operator's own terminal. Not
  # eGPT's call to make.
  #
  # So: no env var, and the pool gets Modify on pi's real config dir. Modify, not
  # read: pi WRITES there (settings lock, runtime creation) and fails the turn
  # without it.
  #
  # NOTE, deliberately no deny on auth.json. An earlier version granted the dir
  # and denied that one file; pi reads auth.json during provider resolution and
  # handles a MISSING file fine, but an EPERM wedges it -- it accepts the prompt
  # and never starts the agent. A sandboxed turn can therefore read whatever
  # credentials pi stores. Keep cloud logins out of pi if that matters.
  # Set to PI'S OWN DEFAULT PATH, not to a directory eGPT invented. For the
  # operator this is a no-op -- ~/.pi/agent is where their pi already looks --
  # but it is REQUIRED for a sandboxed turn: under the launcher the being runs as
  # a pool account whose USERPROFILE is C:\Users\egpt-sbx-NN, so pi's "default"
  # resolves to a profile with no config and the turn dies with
  # 'Model "..." not found'. Granting the pool read on the operator's ~/.pi does
  # nothing on its own, because pi never looks there without being told.
  #
  # Machine scope is forced: sandbox-logon-launcher passes lpEnvironment = NULL,
  # so it cannot be handed over per-spawn.
  $piDir = Join-Path (Join-Path $env:USERPROFILE '.pi') 'agent'
  $step = Start-Step "PI_CODING_AGENT_DIR (machine scope) and read-write grant on pi's own config dir: $piDir"
  [Environment]::SetEnvironmentVariable('PI_CODING_AGENT_DIR', $piDir, 'Machine')
  if (Test-Path -LiteralPath $piDir) {
    Grant-SandboxPoolModify -Path $piDir
    Stop-Step $step
  } else {
    Stop-Step $step 'not present - run pi once, then re-run this'
  }

  # pi's bash tool: WARN, never rewrite. pi owns its own settings.json; this
  # just points out the one setting that silently breaks every tool turn here.
  #
  # TWO DIFFERENT FAILURES, and the second one is the one that bites (measured
  # 2026-09-14 as a real leased pool account; this comment used to name only the
  # first and blamed it for both).
  #
  # 1. `where bash` on these boxes finds C:\Windows\System32\bash.exe FIRST -- the WSL
  #    launcher -- and with no distro installed it exits 1. Confusing, but plain.
  #
  # 2. A REAL bash can still die 0xC0000022, and that is NOT the restricted token
  #    refusing the exe. An msys2/cygwin runtime keeps its shared memory in a
  #    per-INSTALLATION object directory under \Sessions\BNOLINKS\<session>, and on
  #    that directory the pool account holds QUERY|TRAVERSE and nothing else: it can
  #    OPEN an installation's directory that is already there, never CREATE one. So a
  #    bash whose installation has no process alive in the spine's session fails,
  #    and the same bash works the moment one is. Git for Windows has none; the
  #    operator's own msys2 shell keeps C:\msys64 warm, which is why that one works.
  #
  # For pi, settings.json's shellPath is still the fix -- point it at a bash whose
  # installation is warm. src/sandbox-cli-session.mjs carries the full measurement
  # and does the same job for Claude Code via CLAUDE_CODE_GIT_BASH_PATH.
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

  # THE LEASE LITTER, CLEARED (operator 2026-09-20, measured on kg: twelve standing
  # `(OI)(CI)(RX)` ACEs on ~\src\egpt, one per pool account). Those are LEASE ACEs from
  # `allowed_paths` share paths whose turn was killed before its revoke ran - the normal
  # end of a sandboxed session, not a rare crash, because the warm pool ends a CLI process
  # with TerminateProcess and a PowerShell `finally` does not survive that. The launcher
  # revokes them when it next leases the SAME account; an account nothing leases again
  # keeps them forever, which is how twelve piled up on one shared path.
  #
  # This is that same reclaim, over every lock at once, from the one place that is already
  # operator-run and already idempotent. It reads each dead lease's own ledger, so it
  # revokes exactly what was granted and never goes hunting through the filesystem. A lock
  # a running turn still holds is left alone. AFTER Protect-SandboxCredDir, deliberately:
  # that call rewrites the ACL of the directory these locks live in.
  #
  # ONE icacls PASS PER PATH, not per account (2026-09-20). The sweep groups the
  # dead leases by PATH and names every account on one command line, because the
  # cost of a revoke is the TREE, not the ACE: twelve Set-Acl passes over
  # ~\src\egpt took minutes, and `icacls ... /remove:g egpt-sbx-00 ... /C` took
  # 2 s for the same twelve. It logs each path, its account count and its elapsed
  # seconds as it goes - see Clear-SandboxAbandonedLeases.
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

  Write-Host ("OK: sandbox pool ready in {0:n1}s  - created {1}, already existed {2}. Group '{3}' granted ReadAndExecute on {4}, {5} and {6} (the standing read-only view every pool profile's src and my-code junctions point at), and traverse-only on the ancestor chain above the conversation folders. Credential dir {7} hardened (no BUILTIN\Users access)." -f $runWatch.Elapsed.TotalSeconds, $result.Created, $result.Existed, $SandboxPoolGroup, $claudeBinDir, $npmGlobalDir, $srcDir, $CredDir)
} catch {
  Write-Host ("FAILED after {0:n1}s at step {1}/{2}: {3}" -f $runWatch.Elapsed.TotalSeconds, $script:StepIndex, $StepCount, $_.Exception.Message)
  exit 1
}
