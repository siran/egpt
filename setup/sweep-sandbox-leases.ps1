# sweep-sandbox-leases.ps1  - operator-runnable repair for the sandbox pool's
# LEAKED LEASE ACEs. It revokes what abandoned leases left granted, releases
# their locks, and says exactly what it removed.
#
# WHY THIS EXISTS AS ITS OWN SCRIPT. The sweep itself is not new - it is
# Clear-SandboxAbandonedLeases in sandbox-account.ps1, and this script adds NO
# mechanism and no second definition of "revoked". What was missing was a way to
# RUN it: the only caller was provision-sandbox-account.ps1's last step, which
# self-elevates through a UAC prompt and then re-does the whole pool, the group,
# every standing grant and the credential-dir hardening. Nobody runs that to
# clear litter, so in practice the litter was never cleared.
#
# IT NEEDS NO ELEVATION, and that is the point of separating it. Removing an ACE
# needs WRITE_DAC on the object, and the operator OWNS the conversation folders
# and the thread stores these ACEs are on, so this runs as the ordinary operator
# account. (The provisioner needs admin for New-LocalUser and for hardening
# C:\ProgramData\egpt; none of that happens here.)
#
# SAFE TO RUN AT ANY TIME, INCLUDING WITH TURNS IN FLIGHT. A LIVE LEASE IS NEVER
# TOUCHED: the lock file a running turn holds is held FileShare::None, so this
# cannot open it, and Clear-SandboxAbandonedLeases reports it 'held' and steps
# over it - the launcher's own staleness test, not a second opinion about what
# "running" means. Nothing here re-implements that check.
#
# SAFE TO RUN REPEATEDLY. A revoke of an ACE that is already gone is SUCCESS and
# costs not one write (Revoke-SandboxPathAces reads the DACL first), so a second
# run over a clean pool reports zero and finishes in milliseconds. A lock whose
# revoke FAILED is deliberately KEPT, holding exactly the paths that are still
# granted, so running this again retries them instead of forgetting them.
#
# -WhatIf SHOWS WITHOUT TOUCHING: it reads every abandoned lock's ledger and
# prints what it WOULD revoke, taking each lock only long enough to read it and
# writing no DACL at all.
[CmdletBinding()]
param(
  # Defaults to $SandboxLocksDir (C:\ProgramData\egpt\sandbox-pool-locks). Only
  # a test has any reason to point this somewhere else.
  [string]$LocksDir = '',
  # Report only: read the ledgers, revoke nothing, release nothing.
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'sandbox-account.ps1')

if (-not $LocksDir) { $LocksDir = $SandboxLocksDir }

if (-not (Test-Path -LiteralPath $LocksDir)) {
  Write-Host "No lock directory at $LocksDir - this node has never leased a sandbox account. Nothing to sweep."
  exit 0
}

$watch = [System.Diagnostics.Stopwatch]::StartNew()

if ($WhatIf) {
  # THE READ-ONLY VIEW, and it is deliberately NOT a flag threaded through
  # Clear-SandboxAbandonedLeases: a sweep with a "do not actually do it" branch
  # inside it is a sweep whose real path is one boolean away from being untested.
  # This reads the same two things the sweep reads - the lock's holder and its
  # ledger - through the same Read-SandboxLeaseLedger, and stops there.
  Write-Host "WHAT-IF over $LocksDir - reading ledgers only, no DACL is written and no lock is released."
  $held = 0; $stale = 0; $paths = 0
  foreach ($file in @(Get-ChildItem -LiteralPath $LocksDir -Filter '*.lock' -File -ErrorAction SilentlyContinue)) {
    $account = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    # THE SAME PREFIX GUARD THE SWEEP APPLIES, and it has to be here or this view
    # LIES: without it a lock named after some other principal reads as "abandoned,
    # would revoke N paths" while the real run refuses to aim a revoke at it at
    # all. A preview that promises more than the thing it previews is worse than
    # no preview (caught 2026-09-23 running this for real against a throwaway
    # lock named after the operator).
    if (-not $account.StartsWith($SandboxPoolPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      Write-Host "  $account : NOT a pool lease lock - a real run skips it and revokes nothing for it."
      continue
    }
    $stream = $null
    try { $stream = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
    catch {
      $held++
      Write-Host "  $account : LIVE - a turn holds this lease. Untouched, now and by a real run."
      continue
    }
    try {
      $stale++
      $ledger = @(Read-SandboxLeaseLedger -Stream $stream)
      $paths += $ledger.Count
      Write-Host "  $account : abandoned, $($ledger.Count) path(s) it would revoke:"
      foreach ($p in $ledger) { Write-Host "      $p" }
    } finally { $stream.Close() }
  }
  Write-Host ("WHAT-IF done in {0:n1}s - {1} abandoned lease(s) holding {2} ACE(s), {3} live lease(s) left alone. Nothing was changed." -f $watch.Elapsed.TotalSeconds, $stale, $paths, $held)
  exit 0
}

# NO -TimeBudgetSeconds: an operator run finishes the job however long it takes.
# The launcher passes a budget because it is on a turn's path; this is not.
$records = @(Clear-SandboxAbandonedLeases -LocksDir $LocksDir)

# WHAT IT REMOVED, PER PATH, because "3 locks released" does not tell an operator
# whose conversation stopped being readable by a stranger - which is the whole
# reason this is run.
$revoked = 0; $stillThere = 0; $vanished = 0
foreach ($rec in $records) {
  if ($rec.Status -eq 'held') {
    Write-Host "  $($rec.Account): LIVE - a turn holds this lease, left alone."
    continue
  }
  Write-Host "  $($rec.Account): $($rec.Status) - $($rec.Message)"
  foreach ($ace in @($rec.Aces)) {
    switch ($ace.Status) {
      'revoked'  { $revoked++;    Write-Host "      REVOKED  $($ace.Path)" }
      'failed'   { $stillThere++; Write-Host "      STILL GRANTED  $($ace.Path)  - $($ace.Message)" }
      'deferred' { $stillThere++; Write-Host "      NOT REACHED  $($ace.Path)" }
      'missing'  { $vanished++;   Write-Host "      PATH GONE  $($ace.Path)  - if it was renamed rather than deleted, the ACE moved with it and nothing now names it" }
      default    { Write-Host "      already clear  $($ace.Path)" }
    }
  }
}

$reclaimed = @($records | Where-Object { $_.Status -eq 'reclaimed' }).Count
$held = @($records | Where-Object { $_.Status -eq 'held' }).Count
Write-Host ("DONE in {0:n1}s - {1} leaked ACE(s) revoked, {2} lock(s) released, {3} live lease(s) left alone." -f $watch.Elapsed.TotalSeconds, $revoked, $reclaimed, $held)
if ($stillThere -gt 0) {
  Write-Host "WARNING: $stillThere path(s) are STILL granted. Their locks were kept with those paths on the ledger - run this again, and if it repeats, the reason is on the STILL GRANTED line above."
}
if ($vanished -gt 0) {
  Write-Host "NOTE: $vanished ledger path(s) no longer exist. A DELETED folder took its ACEs with it; a RENAMED one did not - NTFS carries a DACL through a rename, so that grant is alive at a name nothing records any more."
}
# A leak that could not be cleared is not a successful run.
exit ([int]($stillThere -gt 0))
