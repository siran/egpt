# lockdown.ps1 - restrict ~/.egpt so only the operator + SYSTEM can read it.
#
# Audit at the start of this work (operator 2026-06-06) showed every sensitive
# file under ~/.egpt - wa-auth/ session keys, bus.key, cdp-token, config.yaml,
# the whole conversations/ tree - was readable by BUILTIN\Administrators via
# inherited ACL. On a single-user laptop that mostly doesn't matter; on a
# shared machine OR if another local admin account exists, it's a real leak
# (a second local admin can read your WhatsApp session, impersonate the bus,
# or hijack the CDP session).
#
# This script:
#   1. takes ownership of the whole ~/.egpt tree as the operator (some subdirs
#      were owned by BUILTIN\Administrators from being created by an
#      elevated install).
#   2. removes inheritance at the root and replaces it with explicit ACL:
#        - operator user: FullControl
#        - NT AUTHORITY\SYSTEM: FullControl (Windows needs this for backup,
#          indexing, file-system services)
#      Every child path inherits from the root, so the whole tree is
#      operator+SYSTEM only after this.
#
# Idempotent - safe to run multiple times. Local admins can always take
# ownership back if they have to (e.g. for system maintenance), so this is
# a friction layer, not a vault.
#
# Run from any PowerShell (no admin needed if you only own the directory and
# its children; admin needed if any subdir is currently owned by
# BUILTIN\Administrators - the takeown step). The double-click wrapper
# (lockdown.cmd) auto-elevates.

$ErrorActionPreference = 'Stop'

$root = Join-Path $env:USERPROFILE '.egpt'
if (-not (Test-Path $root)) {
  Write-Host "$root does not exist; nothing to lock down." -ForegroundColor Yellow
  exit 0
}

$user = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "Lockdown target: $root" -ForegroundColor Cyan
Write-Host "Operator:        $user" -ForegroundColor Cyan
Write-Host ""

# --- 1. stop the running daemon so it isn't holding wa-bridge.log /
#        wa-auth/* / bus.key open. icacls /T fails with 'Access is denied'
#        on any file with an active write handle. Re-started at step 4. ---
$svc = Get-Service egpt-daemon -ErrorAction SilentlyContinue
$serviceWasRunning = $false
if ($svc -and $svc.Status -eq 'Running') {
  Write-Host "Stopping egpt-daemon service so file handles release..." -ForegroundColor Cyan
  Stop-Service egpt-daemon -Force
  $serviceWasRunning = $true
  # Give NSSM + child node procs ~2s to actually let go of file handles.
  Start-Sleep -Seconds 3
  Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  killing leftover node pid $($_.Id) (held over from service stop)..." -ForegroundColor DarkGray
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
}

# --- 2. takeown the whole tree (fixes admin-owned subdirs from elevated installs) ---
Write-Host "Taking ownership of the whole tree (as $user)..." -ForegroundColor Cyan
& takeown /F $root /R /D Y 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "  takeown returned non-zero ($LASTEXITCODE) - likely need elevation. Re-run via lockdown.cmd." -ForegroundColor Yellow
  if ($serviceWasRunning) { Start-Service egpt-daemon -ErrorAction SilentlyContinue }
  exit 1
}

# --- 3. remove inheritance, set explicit ACL: user + SYSTEM only ---
# We capture stderr instead of black-holing it so a future Access-Denied
# tells us WHICH file (most useful when something other than egpt-daemon
# is holding a handle — Defender, OneDrive, Indexing Service, etc.).
Write-Host "Removing inheritance..." -ForegroundColor Cyan
$inhOut = & icacls $root /inheritance:r /T /Q 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "  icacls /inheritance:r failed:" -ForegroundColor Red
  $inhOut | Where-Object { $_ -match 'denied|fail' } | Select-Object -First 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  if ($serviceWasRunning) { Start-Service egpt-daemon -ErrorAction SilentlyContinue }
  exit 1
}

Write-Host "Setting explicit ACL (user + SYSTEM only)..." -ForegroundColor Cyan
$grantOut = & icacls $root /grant:r "${user}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" /T /Q 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "  icacls /grant:r failed:" -ForegroundColor Red
  $grantOut | Where-Object { $_ -match 'denied|fail' } | Select-Object -First 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  if ($serviceWasRunning) { Start-Service egpt-daemon -ErrorAction SilentlyContinue }
  exit 1
}

# --- 4. restart the service if we stopped it ---
if ($serviceWasRunning) {
  Write-Host "Restarting egpt-daemon service..." -ForegroundColor Cyan
  Start-Service egpt-daemon
  Start-Sleep -Seconds 2
  $svc = Get-Service egpt-daemon
  if ($svc.Status -ne 'Running') {
    Write-Host "  WARNING: service did not return to Running state (current: $($svc.Status))" -ForegroundColor Yellow
  }
}

# --- 3. verify ---
Write-Host ""
Write-Host "Verifying - sensitive paths now show ONLY $user + SYSTEM:" -ForegroundColor Green
$check = @(
  $root,
  (Join-Path $root 'wa-auth'),
  (Join-Path $root 'bus.key'),
  (Join-Path $root 'cdp-token'),
  (Join-Path $root 'conversations'),
  (Join-Path $root 'state'),
  (Join-Path $root 'logs')
)
foreach ($p in $check) {
  if (-not (Test-Path $p)) { continue }
  $acl = Get-Acl $p
  $principals = $acl.Access | ForEach-Object { $_.IdentityReference.Value }
  $unique = $principals | Sort-Object -Unique
  $expected = @($user, 'NT AUTHORITY\SYSTEM') | Sort-Object -Unique
  $hasOnlyExpected = ($unique.Count -eq $expected.Count) -and -not (Compare-Object $unique $expected)
  $mark = if ($hasOnlyExpected) { '[OK]' } else { '[FAIL]' }
  Write-Host "  $mark $p  ->  $($unique -join ', ')"
}
Write-Host ""
Write-Host "Done. Other local users (including other admins, unless they take" -ForegroundColor Green
Write-Host "ownership) can no longer read ~/.egpt." -ForegroundColor Green
