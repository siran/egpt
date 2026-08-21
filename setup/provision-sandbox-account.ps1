# provision-sandbox-account.ps1  - operator-run, one-time (idempotent)
# provisioning of the shared egpt-sandbox local account used by
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

$existedBefore = [bool](Get-LocalUser -Name $SandboxUser -ErrorAction SilentlyContinue)

try {
  Get-SandboxCredential | Out-Null
  if ($existedBefore) {
    Write-Host "OK: account '$SandboxUser' already existed (credential verified/self-healed)."
  } else {
    Write-Host "OK: account '$SandboxUser' created."
  }
} catch {
  Write-Host "FAILED: $($_.Exception.Message)"
  exit 1
}
