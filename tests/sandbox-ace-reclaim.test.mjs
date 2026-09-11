// REPRODUCE-FIRST for the LEAKED-ACE DEFECT — the residue 1087b63 recorded and did not close.
//
// THE DEFECT, established by measurement on this node BEFORE this file was written:
// setup/sandbox-logon-launcher.ps1 grants the leased pool account a Modify ACE on TargetFolder
// (step d) and on every -SharePath entry (step d2), and revokes them in its `finally`. A
// HARD-killed turn (taskkill /F, crash, reboot) never runs that finally, so the ACE stays on the
// folder FOREVER — and pool accounts are REUSED across different conversations, so the next
// lease of that SAME account by a DIFFERENT conversation still has Modify on the first one's
// folder. That is exactly the cross-conversation leak the scrub design exists to prevent,
// arriving through the ACL instead of through the profile.
//
// MEASURED 2026-09-11 on this node, unelevated, read-only:
//   * ALL 15 lease-lock files in C:\ProgramData\egpt\sandbox-pool-locks are STALE — opening each
//     with FileShare::None succeeds, i.e. no process holds any of them. Every one is a turn that
//     died without running its finally.
//   * 42 explicit `reve\egpt-sbx-NN` Modify ACEs survive across the live conversation folders of
//     ~/.egpt. One conversation folder carries TWELVE different pool accounts at once, i.e. most
//     of the 16-account pool can read it whoever it is leased to next.
//
// THE FIX THESE TESTS LOCK: the revoke rides the mechanism that ALREADY exists for precisely
// this class of problem — the stale-lease-lock RECLAIM (launcher step (a), "RECLAIMED stale
// lease lock … hard-killed before its release ran"). A lease being reclaimed is the one moment
// we know a finally was skipped, and it is the moment BEFORE that account runs anything again.
//
// The reclaim needs to know WHAT to revoke, so the lock file — the per-account artifact that
// already survives the hard kill, is already created and deleted with the lease, and is already
// found by the reclaim — carries the list. Each grant appends its path to the lock file BEFORE
// its Set-Acl (a superset of what landed, which is the safe direction for a crash log); the
// reclaim reads it, revokes each, and rewrites the ledger with whatever it could NOT revoke so
// the next reclaim retries rather than forgetting.
//
// NO SECOND MECHANISM: the finally and the reclaim revoke through the SAME function
// (Revoke-SandboxLeaseAces in setup/sandbox-account.ps1, beside Get-SandboxPoolLeaseOrder and
// the rest of the lease helpers), so the two can never drift.
//
// WHAT THIS FILE IS AND IS NOT. The launcher is PowerShell, and this repo's standing convention
// for it (setup/sandbox-account.Tests.ps1's own header: "NOT part of vitest — `npm test` never
// runs a .ps1") is text contracts here plus Pester by hand. So these are STRUCTURAL locks on the
// launcher's source. The BEHAVIOUR — a real ACE on a real directory, really revoked — is
// exercised for real in setup/sandbox-account.Tests.ps1 ('Revoke-SandboxLeaseAces' and
// 'Clear-SandboxStaleLease' describes), run with:
//   Invoke-Pester -Script setup\sandbox-account.Tests.ps1
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const launcher = () => readFileSync(join(REPO, 'setup', 'sandbox-logon-launcher.ps1'), 'utf8');
const accountLib = () => readFileSync(join(REPO, 'setup', 'sandbox-account.ps1'), 'utf8');

// The reclaim branch: the inner catch of the lease loop, from the RECLAIMED log line to the end
// of that catch. Everything the reclaim does lives between the exclusive open and the `break`.
function reclaimBranch(src) {
  const i = src.indexOf('RECLAIMED stale lease lock');
  expect(i, 'the launcher no longer has a stale-lease reclaim at all — that is the mechanism this fix rides').toBeGreaterThan(0);
  const end = src.indexOf('      } catch {', i);
  expect(end).toBeGreaterThan(i);
  return src.slice(src.lastIndexOf('    } catch [System.IO.IOException]', i), end);
}

describe('a hard-killed turn no longer leaks its ACE — the revoke rides the stale-lease reclaim', () => {
  it('REPRODUCE-FIRST: the reclaim of a stale lease revokes the ACEs the dead turn left behind', () => {
    // Today the reclaim takes the lock and logs, and that is ALL it does: the dead turn's Modify
    // ACE on its conversation folder and on its ~/.egpt-jsonl/<thread> store is still there, and
    // this launcher is about to run a DIFFERENT conversation as that same account.
    const branch = reclaimBranch(launcher());
    expect(
      branch,
      'the reclaim notices the skipped finally and does nothing about its ACEs — 42 of them are '
      + 'live on this node right now',
    ).toMatch(/Clear-SandboxStaleLease/);
  });

  it('REPRODUCE-FIRST: the lock file is opened for READ as well, so it can carry what this turn granted', () => {
    // Both opens — the CreateNew that takes a free name and the exclusive reopen that reclaims a
    // stale one. FileAccess::Write alone cannot read back a dead turn's ledger.
    const src = launcher();
    const opens = [...src.matchAll(/\[System\.IO\.File\]::Open\(\$candidatePath[^)]*\)/g)].map((m) => m[0]);
    expect(opens.length, 'both lease opens are still there').toBe(2);
    for (const open of opens) {
      expect(open, 'the lease lock is opened write-only, so the reclaim cannot read the dead turn\'s ledger from it').toMatch(/FileAccess\]::ReadWrite/);
    }
    // ...and still EXCLUSIVE in both directions: the whole discriminator between "a lease" and
    // "a dead turn's litter" is whether a live handle holds the file.
    expect(opens[0]).toMatch(/FileMode\]::CreateNew/);
    expect(opens[1]).toMatch(/FileShare\]::None/);
  });

  it('REPRODUCE-FIRST: every grant is written to the ledger BEFORE its Set-Acl', () => {
    // BEFORE, deliberately: the ledger exists for the crash case, so it must be a SUPERSET of
    // what actually landed. A Set-Acl that threw leaves no ACE, and the revoke skips a path that
    // carries none — so the superset costs a read and never a stray write.
    const src = launcher();
    for (const [step, anchor] of [['(d) TargetFolder', '$acl.AddAccessRule($rule)'], ['(d2) share path', '$shareAcl.AddAccessRule($shareRule)']]) {
      const at = src.indexOf(anchor);
      expect(at, `step ${step} is gone`).toBeGreaterThan(0);
      const before = src.slice(Math.max(0, at - 1200), at);
      expect(before, `step ${step} grants an ACE without first recording it where a hard kill can find it`).toMatch(/Add-SandboxLeaseLedgerPath/);
    }
  });

  it('REPRODUCE-FIRST: ONE revoke implementation — the finally and the reclaim cannot drift', () => {
    const src = launcher();
    // No hand-rolled purge left in the launcher: both paths go through the shared function.
    expect(
      (src.match(/PurgeAccessRules/g) || []).length,
      'the launcher still purges ACLs inline — a second revoke implementation is exactly what must not exist here',
    ).toBe(0);
    expect(src).toMatch(/Revoke-SandboxLeaseAces/);
    // ...and it lives with the other lease helpers, where Pester can reach it.
    const lib = accountLib();
    for (const fn of ['Revoke-SandboxLeaseAces', 'Clear-SandboxStaleLease', 'Add-SandboxLeaseLedgerPath', 'Read-SandboxLeaseLedger', 'Write-SandboxLeaseLedger']) {
      expect(lib, `${fn} is not in setup/sandbox-account.ps1`).toMatch(new RegExp(`^function ${fn}\\b`, 'm'));
    }
    expect(lib).toMatch(/PurgeAccessRules/);
  });

  it('REPRODUCE-FIRST: a revoke that FAILED is logged as a WARNING and kept in the ledger', () => {
    // Standing rule: nothing swallowed, nothing lied about. A path the revoke could not clear is
    // still leaking, so it must say so AND stay on the list for the next reclaim to retry —
    // truncating the ledger unconditionally would forget the leak forever.
    const src = launcher();
    const branch = reclaimBranch(src);
    expect(branch, 'the reclaim does not report what its revoke could not clean').toMatch(/WARNING/);
    const lib = accountLib();
    const clear = lib.slice(lib.indexOf('function Clear-SandboxStaleLease'));
    expect(clear, "Clear-SandboxStaleLease rewrites the ledger without carrying the failures over").toMatch(/failed/);
    expect(clear).toMatch(/Write-SandboxLeaseLedger/);
  });
});

describe('the locks this fix must not break', () => {
  it('LOCK: the reclaim still says WHY it reclaimed, and still takes the lease it found', () => {
    const src = launcher();
    expect(src).toMatch(/RECLAIMED stale lease lock \$candidatePath/);
    const branch = reclaimBranch(src);
    // The reclaimed handle IS the lease — deliberately not "open, close, re-CreateNew", which
    // would reopen the very window it is testing.
    expect(branch).toMatch(/\$leasedName = \$name/);
    expect(branch).toMatch(/\$lockPath = \$candidatePath/);
  });

  it('LOCK: the finally still revokes on the normal path, before it releases the lease', () => {
    const src = launcher();
    const fin = src.slice(src.lastIndexOf('} finally {'));
    expect(fin, 'the normal-path revoke is gone — the reclaim is a backstop for hard kills, not a replacement').toMatch(/Revoke-SandboxLeaseAces/);
    expect(fin.indexOf('Revoke-SandboxLeaseAces')).toBeLessThan(fin.indexOf('$lockStream.Close()'));
  });

  it('LOCK: the grant itself is unchanged — per-path Modify for the leased SID only, never a broader principal', () => {
    const src = launcher();
    expect(src).toMatch(/New-Object System\.Security\.AccessControl\.FileSystemAccessRule\(\s*\$leasedSid, 'Modify'/);
    expect(src).toMatch(/\$leasedSid, 'Modify', \$shareInherit/);
    // Nothing here may widen to the pool GROUP or to Everyone.
    expect(src).not.toMatch(/FileSystemAccessRule\(\s*\$poolGroupSid/);
  });

  it('LOCK: the ledger holds PATHS ONLY — the lock file never becomes a place a credential lands', () => {
    const src = launcher();
    const adds = [...src.matchAll(/Add-SandboxLeaseLedgerPath[^\n]*/g)].map((m) => m[0]);
    expect(adds.length).toBeGreaterThanOrEqual(2);
    for (const a of adds) {
      expect(a, 'something other than a path is being written into the lease ledger').not.toMatch(/SetEnv|Password|plainPwd|Token/i);
    }
  });
});
