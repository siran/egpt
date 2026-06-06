# unlock.ps1 - recovery for a half-applied lockdown.
#
# Operator 2026-06-06: lockdown.ps1's first run hit Access Denied mid-way
# through `icacls /inheritance:r /T` because a deep file under ~/.egpt/agent
# refused the ACL modification. icacls had already converted inherited ACEs
# to explicit on some subdirs before failing, leaving paths like
# ~/.egpt/agent with inheritance OFF and an empty ACL - nothing can read
# them now, not even the operator.
#
# What this script does:
#   1. takeown /R the whole tree (as owner, we get implicit WRITE_DAC on
#      NTFS even if no explicit ACE permits it).
#   2. icacls /reset /T - resets every file/dir's ACL to "inherit from
#      parent", undoing the partial /inheritance:r damage.
#   3. icacls /grant on root - explicit operator + SYSTEM grant on top of
#      the now-restored inheritance, as a defensive baseline.
#   4. Start egpt-daemon service if it isn't running.
#
# Idempotent. Restores the system to "everything is inherited from
# C:\Users\an\", which is the default Windows-installed state.

$ErrorActionPreference = 'Continue'

$root = Join-Path $env:USERPROFILE '.egpt'
if (-not (Test-Path $root)) { Write-Host "$root does not exist; nothing to do."; exit 0 }

$user = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "Recovery target: $root" -ForegroundColor Cyan
Write-Host "Operator:        $user" -ForegroundColor Cyan
Write-Host ""

# --- 1. takeown the whole tree -----------------------------------------------
Write-Host "Taking ownership recursively (as $user)..." -ForegroundColor Cyan
& takeown /F $root /R /D Y 2>&1 | Out-Null
Write-Host "  takeown exit: $LASTEXITCODE" -ForegroundColor DarkGray

# --- 2. reset every ACL back to inherited ------------------------------------
Write-Host "Resetting ACLs to inherited (undo partial lockdown)..." -ForegroundColor Cyan
$resetOut = & icacls $root /reset /T 2>&1
Write-Host "  icacls /reset /T exit: $LASTEXITCODE" -ForegroundColor DarkGray
# Suppress chatter; only show errors that actually failed
$resetOut | Where-Object { $_ -match 'denied|failed' } | Select-Object -First 5 |
  ForEach-Object { Write-Host "  WARN: $_" -ForegroundColor Yellow }

# --- 3. explicit grant at root (defensive baseline on top of inheritance) ----
Write-Host "Granting explicit operator + SYSTEM at root..." -ForegroundColor Cyan
& icacls $root /grant "${user}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" 2>&1 | Out-Null

# --- 4. service back up ------------------------------------------------------
$svc = Get-Service egpt-daemon -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Running') {
  Write-Host "Starting egpt-daemon service..." -ForegroundColor Cyan
  Start-Service egpt-daemon
  Start-Sleep -Seconds 2
}

# --- 5. verify read access on the previously-broken paths --------------------
Write-Host ""
Write-Host "Verifying read access..." -ForegroundColor Green
foreach ($p in @($root, (Join-Path $root 'agent'), (Join-Path $root 'wa-auth'),
                  (Join-Path $root 'state'), (Join-Path $root 'conversations'))) {
  if (-not (Test-Path $p)) { continue }
  try {
    $null = Get-ChildItem $p -Force -ErrorAction Stop | Select-Object -First 1
    Write-Host "  [OK]   $p"
  } catch {
    Write-Host "  [FAIL] $p  -  $($_.Exception.Message)" -ForegroundColor Red
  }
}
Write-Host ""
Write-Host "Recovery complete. ~/.egpt is back to default inheritance state." -ForegroundColor Green
Write-Host "DO NOT re-run setup/lockdown.cmd until the script is updated to" -ForegroundColor Yellow
Write-Host "operate root-only (no /T)." -ForegroundColor Yellow
