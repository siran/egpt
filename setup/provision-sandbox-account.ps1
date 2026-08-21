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
  $npmGlobalDir = Join-Path $env:APPDATA 'npm'
  if (Test-Path -LiteralPath $npmGlobalDir) {
    Grant-SandboxPoolAccess -Path $npmGlobalDir
  } else {
    Write-Host "note: $npmGlobalDir not present  - skipping the pi/codex grant on this node"
  }
  # pi (@p): the engine resolves `--model reve/local` by reading ~/.pi/agent/
  # models.json, which carries the provider's baseUrl (127.0.0.1:8080). That dir
  # sits under the operator's profile and denies Users, so a sandboxed turn
  # cannot resolve its model without this grant -- the binary grant above is
  # necessary but NOT sufficient.
  #
  # ~/.pi ALSO holds auth.json (provider credentials), which is exactly why the
  # npm-root comment above says no credential lives there. So: grant the dir,
  # then punch an explicit DENY through it on auth.json alone. Relocating pi's
  # config for the sandboxed process is not an option -- PI_CODING_AGENT_DIR
  # would do it, but sandbox-logon-launcher passes lpEnvironment = NULL, so the
  # inner process inherits the LEASED ACCOUNT's environment, not ours.
  $piDir = Join-Path $env:USERPROFILE '.pi'
  if (Test-Path -LiteralPath $piDir) {
    Grant-SandboxPoolAccess -Path $piDir
    Deny-SandboxPoolOnFile -Path (Join-Path (Join-Path $piDir 'agent') 'auth.json')
  } else {
    Write-Host "note: $piDir not present  - skipping the pi config grant on this node"
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
