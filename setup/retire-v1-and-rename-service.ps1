# retire-v1-and-rename-service.ps1 - ONE-SHOT migration (operator 2026-07-03).
#
# Delete the egpt-tick scheduled task, remove the retired v1 egpt-daemon service,
# and rename the v2 egpt2-daemon service to egpt-daemon (Windows requires remove + recreate).
# The service runs as the user account .\an, so the script prompts for its Windows password.
#
# Run by double-click, or:
#   powershell -ExecutionPolicy Bypass -File setup\retire-v1-and-rename-service.ps1
# Self-elevates if not already Administrator.

# --- self-elevate ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Not elevated - relaunching as Administrator..."
  Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`""
  exit
}

$ErrorActionPreference = 'Stop'
$h = "$env:USERPROFILE"

try {
  Write-Host "Step 1: deleting egpt-tick scheduled task"
  $tick = Get-ScheduledTask -TaskName 'egpt-tick' -ErrorAction SilentlyContinue
  if ($tick) {
    Write-Host "  deleting \egpt-tick"
    Unregister-ScheduledTask -TaskName 'egpt-tick' -Confirm:$false
  } else {
    Write-Host "  \egpt-tick not found - already gone"
  }

  Write-Host ""
  Write-Host "Step 2: checking service state"
  $svc2 = Get-Service -Name 'egpt2-daemon' -ErrorAction SilentlyContinue
  $svc1 = Get-Service -Name 'egpt-daemon' -ErrorAction SilentlyContinue

  if ($svc2) {
    Write-Host "  egpt2-daemon exists - proceeding with rename"
  } elseif ($svc1) {
    Write-Host "  egpt-daemon already exists and egpt2-daemon is gone - already renamed"
    Write-Host ""
    Write-Host "Step 3: starting egpt-daemon"
    Start-Service egpt-daemon -ErrorAction SilentlyContinue
    $status = (Get-Service egpt-daemon).Status
    Write-Host "  Status: $status"
    Write-Host "  Next: run 'node setup/verify-install.mjs' to check the result"
    return
  } else {
    throw "ABORT: neither egpt2-daemon nor egpt-daemon found. No services to migrate."
  }

  Write-Host ""
  Write-Host "Step 3: removing retired v1 service if present"
  if ($svc1) {
    Write-Host "  both egpt2-daemon and egpt-daemon exist - removing egpt-daemon (v1)"
    nssm remove egpt-daemon confirm
  } else {
    Write-Host "  egpt-daemon not found - nothing to remove"
  }

  Write-Host ""
  Write-Host "Step 4: stopping and removing egpt2-daemon"
  Stop-Service egpt2-daemon -ErrorAction SilentlyContinue
  nssm remove egpt2-daemon confirm

  Write-Host ""
  Write-Host "Step 5: recreating as egpt-daemon with installed config"
  $logDir = "$h\.egpt\config\logs"
  if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  }
  nssm install egpt-daemon "C:\Program Files\nodejs\node.exe"
  nssm set egpt-daemon AppDirectory "$h\bin\egpt"
  nssm set egpt-daemon AppParameters "$h\bin\egpt\egpt-daemon.mjs"
  nssm set egpt-daemon AppEnvironmentExtra "EGPT_HOME=$h\.egpt"
  nssm set egpt-daemon AppStdout "$h\.egpt\config\logs\service-stdout.log"
  nssm set egpt-daemon AppStderr "$h\.egpt\config\logs\service-stderr.log"
  nssm set egpt-daemon DisplayName "egpt node (egpt-daemon)"
  nssm set egpt-daemon Description "eGPT node daemon - supervises node egpt.mjs from the installed ~/bin/egpt copy"
  nssm set egpt-daemon Start SERVICE_AUTO_START
  nssm set egpt-daemon AppExit Default Restart

  Write-Host ""
  Write-Host "Step 6: setting service account"
  $pass = Read-Host "Windows password for .\an (service logon; blank = LocalSystem, NOT recommended)" -AsSecureString
  if ($pass.Length -gt 0) {
    $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass))
    nssm set egpt-daemon ObjectName ".\an" "$plain"
    $plain = $null
  } else {
    Write-Host "  WARNING: using LocalSystem - the claude login will likely fail. Set the service account in services.msc." -ForegroundColor Yellow
  }

  Write-Host ""
  Write-Host "Step 7: starting egpt-daemon"
  Start-Service egpt-daemon
  $status = (Get-Service egpt-daemon).Status
  Write-Host ""
  Write-Host "Service status: $status"
  Write-Host "Next: run 'node setup/verify-install.mjs' to check the result."
} catch {
  Write-Host ""
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  Write-Host ""
  Read-Host 'done - press enter'
}
