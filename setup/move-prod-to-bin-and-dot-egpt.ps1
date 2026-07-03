# move-prod-to-bin-and-dot-egpt.ps1 - ONE-SHOT production migration (operator 2026-07-03).
#
# After this: the service runs the INSTALLED copy from ~\bin\egpt (not a repo
# checkout), the profile is renamed ~\.egpt2 -> ~\.egpt, the old v1 profile is
# archived as ~\.egpt-v1, and the old v1 service (egpt-daemon) is retired.
#
# Run by double-click, or:
#   powershell -ExecutionPolicy Bypass -File setup\move-prod-to-bin-and-dot-egpt.ps1
# Self-elevates if not already Administrator.

# --- self-elevate ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Not elevated - relaunching as Administrator..."
  Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`""
  exit
}

$ErrorActionPreference = 'Stop'
$svc = 'egpt2-daemon'
$h = "$env:USERPROFILE"

try {
  Write-Host "Step 0: checking precondition - installed copy at $h\bin\egpt\egpt-daemon.mjs"
  if (-not (Test-Path "$h\bin\egpt\egpt-daemon.mjs")) {
    Write-Host "ABORT: $h\bin\egpt\egpt-daemon.mjs not found. Install the production copy under ~\bin\egpt first. Nothing was stopped or changed." -ForegroundColor Red
    return
  }

  Write-Host "Step 1: stopping service $svc"
  Stop-Service $svc -ErrorAction SilentlyContinue

  Write-Host "Step 2: profile rename (archive v1, promote v2)"
  if ((Test-Path "$h\.egpt2") -and (Test-Path "$h\.egpt-v1")) {
    Write-Host "  $h\.egpt-v1 already exists - not overwriting; assuming the archive rename already ran"
    Write-Host "  renaming $h\.egpt2 -> $h\.egpt"
    Rename-Item "$h\.egpt2" "$h\.egpt"
  } elseif ((Test-Path "$h\.egpt2") -and -not (Test-Path "$h\.egpt-v1")) {
    Write-Host "  renaming $h\.egpt -> $h\.egpt-v1"
    Rename-Item "$h\.egpt" "$h\.egpt-v1"
    Write-Host "  renaming $h\.egpt2 -> $h\.egpt"
    Rename-Item "$h\.egpt2" "$h\.egpt"
  } elseif (Test-Path "$h\.egpt\config\config.yaml") {
    Write-Host "  already migrated ($h\.egpt2 is gone and $h\.egpt\config\config.yaml exists) - skipping both renames"
  } else {
    Write-Host "  WARNING: cannot confirm migration state ($h\.egpt2 missing and $h\.egpt\config\config.yaml missing) - skipping renames" -ForegroundColor Yellow
  }

  Write-Host "Step 3: registry pointer fix"
  $reg = "$h\.egpt\config\conversations.yaml"
  if (Test-Path $reg) {
    $t = [IO.File]::ReadAllText($reg, [Text.Encoding]::UTF8)
    if ($t.Contains('.egpt2/conversations')) {
      Write-Host "  patching .egpt2/conversations -> .egpt/conversations in $reg"
      [IO.File]::WriteAllText($reg, $t.Replace('.egpt2/conversations', '.egpt/conversations'), (New-Object Text.UTF8Encoding($false)))
    } else {
      Write-Host "  no .egpt2/conversations reference found - nothing to patch"
    }
  } else {
    Write-Host "  WARNING: $reg not found - skipping registry patch" -ForegroundColor Yellow
  }

  Write-Host "Step 4: pointing $svc at the installed copy"
  nssm set $svc AppDirectory  "$h\bin\egpt"
  nssm set $svc AppParameters "$h\bin\egpt\egpt-daemon.mjs"
  nssm set $svc AppEnvironmentExtra "EGPT_HOME=$h\.egpt"
  nssm set $svc AppStdout "$h\.egpt\config\logs\service-stdout.log"
  nssm set $svc AppStderr "$h\.egpt\config\logs\service-stderr.log"

  Write-Host "Step 5: disabling retired v1 service egpt-daemon"
  Set-Service egpt-daemon -StartupType Disabled -ErrorAction SilentlyContinue

  Write-Host "Step 6: starting $svc"
  Start-Service $svc

  $status = (Get-Service $svc).Status
  Write-Host ""
  Write-Host "Service $svc status: $status"
  Write-Host "Next: run 'node setup/verify-install.mjs' (unelevated) to check the result."
} catch {
  Write-Host ""
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  Write-Host ""
  Read-Host 'done - press enter'
}
