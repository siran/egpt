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

try {
  $result = Ensure-SandboxPool
  Ensure-SandboxPoolGroup
  # ccode: claude.exe (warm-cli-session's resolveClaudeBin prefers ~/.local/bin).
  $claudeBinDir = Join-Path $env:USERPROFILE '.local\bin'
  Grant-SandboxPoolAccess -Path $claudeBinDir
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
  if (Test-Path -LiteralPath $runningTree) {
    Grant-SandboxPoolAccess -Path $runningTree
  } else {
    Write-Host "note: $runningTree not present  - skipping the running-tree grant on this node"
  }

  $npmGlobalDir = Join-Path $env:APPDATA 'npm'
  if (Test-Path -LiteralPath $npmGlobalDir) {
    Grant-SandboxPoolAccess -Path $npmGlobalDir
  } else {
    Write-Host "note: $npmGlobalDir not present  - skipping the pi/codex grant on this node"
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
  [Environment]::SetEnvironmentVariable('PI_CODING_AGENT_DIR', $piDir, 'Machine')
  if (Test-Path -LiteralPath $piDir) {
    Grant-SandboxPoolModify -Path $piDir
  } else {
    Write-Host "note: $piDir not present - run pi once, then re-run this"
  }

  # pi's bash tool: WARN, never rewrite. pi owns its own settings.json; this
  # just points out the one setting that silently breaks every tool turn here.
  #
  # `where bash` on these boxes finds C:\Windows\System32\bash.exe FIRST -- the
  # WSL launcher -- and with no distro installed it exits 1 (or 0xC0000022 under
  # the sandbox's restricted token). pi then reports a confusing "access denied"
  # for what looks like a plain ls. settings.json's shellPath fixes it, and the
  # operator's own terminal pi needs it just as much.
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
  Protect-SandboxCredDir
  Write-Host "OK: sandbox pool ready  - created $($result.Created), already existed $($result.Existed). Group '$SandboxPoolGroup' granted ReadAndExecute on $claudeBinDir and $npmGlobalDir. Credential dir $CredDir hardened (no BUILTIN\Users access)."
} catch {
  Write-Host "FAILED: $($_.Exception.Message)"
  exit 1
}
