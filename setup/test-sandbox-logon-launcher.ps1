# test-sandbox-logon-launcher.ps1 — MANUAL smoke test for
# sandbox-logon-launcher.ps1's OS-level isolation. NOT part of vitest / any
# test runner. Run this yourself, ELEVATED (local admin — the first call
# self-heals/creates whichever pool account it happens to lease, same as the
# old single-account flow; the pool does not need to be pre-provisioned by
# provision-sandbox-account.ps1 for this test specifically, though normal
# operation expects it to be).
#
# Sets up two temp folders, each with its own marker file, then runs the
# launcher twice — once per folder, i.e. two SEPARATE logon sessions, each
# under a leased pool account (egpt-sbx-NN) — with a trivial inner command
# (powershell.exe reading marker.txt). Asserts each session's process can
# read its OWN folder's marker but is denied the OTHER folder's marker —
# proving the per-account ACE actually confines file access, not just that
# the process ran as a different account.
$ErrorActionPreference = 'Stop'

$root = Join-Path $env:TEMP ("egpt-sandbox-smoketest-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$dirA = Join-Path $root 'folder-a'
$dirB = Join-Path $root 'folder-b'
New-Item -ItemType Directory -Path $dirA -Force | Out-Null
New-Item -ItemType Directory -Path $dirB -Force | Out-Null
Set-Content -LiteralPath (Join-Path $dirA 'marker.txt') -Value 'MARKER-A-CONTENT' -NoNewline
Set-Content -LiteralPath (Join-Path $dirB 'marker.txt') -Value 'MARKER-B-CONTENT' -NoNewline

$launcher = Join-Path $PSScriptRoot 'sandbox-logon-launcher.ps1'

function Invoke-Session([string]$OwnFolder, [string]$OtherMarkerPath) {
  # Trivial inner command: try to read this session's OWN marker, then try
  # the OTHER session's marker (must be denied). Both results are printed on
  # one line so a single launcher invocation (one logon session, one ACE)
  # gives us both readings in one shot.
  # Own marker is read by ABSOLUTE path: this test asserts the ACL boundary
  # (can it read its own folder / is it denied the other's), and a relative
  # path would silently conflate that with how the inner shell resolves its
  # working directory. CWD is asserted separately, on its own line, because
  # production confinement DOES depend on lpCurrentDirectory being honoured
  # (warm-cli-session spawns the CLI with cwd = the conversation folder).
  $ownMarkerPath = Join-Path $OwnFolder 'marker.txt'
  $inner = "Write-Output ('CWD=' + (Get-Location).Path); " +
           "`$own = Get-Content -LiteralPath '$ownMarkerPath' -ErrorAction Stop; " +
           "try { `$other = Get-Content -LiteralPath '$OtherMarkerPath' -ErrorAction Stop; `$otherResult = 'READ:' + `$other } " +
           "catch { `$otherResult = 'DENIED:' + `$_.Exception.GetType().Name } " +
           "Write-Output ('OWN=' + `$own); Write-Output ('OTHER=' + `$otherResult)"
  # Local ErrorActionPreference override: the outer script's 'Stop' would make the
  # FIRST stderr line from this native call (launcher's Log() writes go to stderr)
  # a terminating error, hiding the launcher's real failure/success output that
  # follows it. Scoped to just this call so the rest of the script keeps failing
  # loudly on its own errors.
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    # InnerBin must be an absolute path (operator 2026-08-21): the launcher now
    # passes it as CreateProcessWithTokenW's lpApplicationName, which does not
    # search PATH the way a bare name relying on lpCommandLine parsing would.
    $psExe = Join-Path $PSHOME 'powershell.exe'
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher `
      -TargetFolder $OwnFolder -InnerBin $psExe `
      -NoProfile -NonInteractive -Command $inner 2>&1
  } finally {
    $ErrorActionPreference = $prevEAP
  }
  return $out
}

Write-Host "=== session for folder-a ==="
$outA = Invoke-Session -OwnFolder $dirA -OtherMarkerPath (Join-Path $dirB 'marker.txt')
$outA | ForEach-Object { Write-Host "  $_" }

Write-Host "=== session for folder-b ==="
$outB = Invoke-Session -OwnFolder $dirB -OtherMarkerPath (Join-Path $dirA 'marker.txt')
$outB | ForEach-Object { Write-Host "  $_" }

function Test-Result([string[]]$Out, [string]$ExpectOwn, [string]$ExpectCwd, [string]$Label) {
  $ownLine = $Out | Where-Object { $_ -match '^OWN=' } | Select-Object -First 1
  $otherLine = $Out | Where-Object { $_ -match '^OTHER=' } | Select-Object -First 1
  $cwdLine = $Out | Where-Object { $_ -match '^CWD=' } | Select-Object -First 1
  $ownOk = $ownLine -eq "OWN=$ExpectOwn"
  $otherOk = $otherLine -match '^OTHER=DENIED:'
  # lpCurrentDirectory must actually land the child in its own folder: production
  # confinement is scoped to the conversation dir the CLI is spawned in.
  $cwdOk = $cwdLine -eq "CWD=$ExpectCwd"
  Write-Host ""
  Write-Host "--- $Label ---"
  Write-Host "  own marker read:      $(if ($ownOk) {'PASS'} else {'FAIL'})  ($ownLine)"
  Write-Host "  other marker denied:  $(if ($otherOk) {'PASS'} else {'FAIL'})  ($otherLine)"
  Write-Host "  cwd is own folder:    $(if ($cwdOk) {'PASS'} else {'FAIL'})  ($cwdLine)"
  return ($ownOk -and $otherOk -and $cwdOk)
}

$passA = Test-Result -Out $outA -ExpectOwn 'MARKER-A-CONTENT' -ExpectCwd $dirA -Label 'folder-a session'
$passB = Test-Result -Out $outB -ExpectOwn 'MARKER-B-CONTENT' -ExpectCwd $dirB -Label 'folder-b session'

Write-Host ""
if ($passA -and $passB) {
  Write-Host "OVERALL: PASS - each session read its own folder, both were denied the other's"
} else {
  Write-Host "OVERALL: FAIL - see per-session results above"
}

Remove-Item -Recurse -Force -LiteralPath $root -ErrorAction SilentlyContinue
