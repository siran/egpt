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
  # pi (@p): the engine resolves `--model reve/local` from models.json in its
  # config dir, and it WRITES there too (settings lock, runtime creation). A
  # sandboxed turn runs as a pool account whose USERPROFILE is C:\Users\egpt-sbx-NN
  # (LOGON_WITH_PROFILE, verified by probe), so it would look in a profile that
  # has no config at all.
  #
  # Give the pool its OWN config dir rather than opening the operator's ~/.pi.
  # An earlier attempt granted ~/.pi and denied auth.json through it; that DENY
  # silently wedged pi -- it accepted the RPC prompt (response success:true) and
  # then never emitted agent_start, because an EPERM reading auth.json is not
  # handled the way a MISSING auth.json is. This shape has no deny to trip over,
  # and the operator's credentials are never reachable at all.
  #
  # MACHINE scope is forced: sandbox-logon-launcher passes lpEnvironment = NULL,
  # so the value cannot be handed over per-spawn. The operator's own pi picks up
  # the same dir, which is why models.json is seeded across.
  # Under the eGPT PROFILE, not ProgramData: everything else eGPT owns lives in
  # ~/.egpt, and the pool already writes there every turn (its conversation
  # folder). ProgramData is for the machine-level sandbox CREDENTIALS, which are
  # a different kind of thing (operator 2026-08-27).
  $piPoolDir = Join-Path $env:USERPROFILE '.egpt\pi-agent'
  New-Item -ItemType Directory -Path $piPoolDir -Force | Out-Null
  $srcModels = Join-Path (Join-Path $env:USERPROFILE '.pi') 'agent\models.json'
  $dstModels = Join-Path $piPoolDir 'models.json'
  if ((Test-Path -LiteralPath $srcModels) -and -not (Test-Path -LiteralPath $dstModels)) {
    Copy-Item -LiteralPath $srcModels -Destination $dstModels
    Write-Host "seeded models.json into $piPoolDir"
  }
  # Present and EMPTY on purpose: pi reads auth.json during provider resolution,
  # and it must find a readable file, not a permission error.
  $dstAuth = Join-Path $piPoolDir 'auth.json'
  # WriteAllText, NOT Set-Content -Encoding utf8: PowerShell 5.1 writes a UTF-8
  # BOM (ef bb bf) plus CRLF, and pi's JSON.parse throws on the BOM. That failure
  # is INVISIBLE -- pi accepts the RPC prompt and then never emits agent_start,
  # exactly like the EPERM case. Verified by hexdump: 7 bytes vs the 2 it needs.
  if (-not (Test-Path -LiteralPath $dstAuth)) { [System.IO.File]::WriteAllText($dstAuth, '{}') }
  Grant-SandboxPoolModify -Path $piPoolDir
  [Environment]::SetEnvironmentVariable('PI_CODING_AGENT_DIR', $piPoolDir, 'Machine')
  Write-Host "set machine PI_CODING_AGENT_DIR = $piPoolDir"

  # Must come AFTER Ensure-SandboxPool: that is what creates the credential
  # files this locks down. Needs admin, which is exactly why it lives here and
  # not in the (unelevated) launcher.
  Protect-SandboxCredDir
  Write-Host "OK: sandbox pool ready  - created $($result.Created), already existed $($result.Existed). Group '$SandboxPoolGroup' granted ReadAndExecute on $claudeBinDir and $npmGlobalDir. Credential dir $CredDir hardened (no BUILTIN\Users access)."
} catch {
  Write-Host "FAILED: $($_.Exception.Message)"
  exit 1
}
