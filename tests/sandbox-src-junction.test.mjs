// sandbox-src-junction.test.mjs — THE POOL PROFILE'S ~/src, AND THE LEASE-ACE LEAK
// (operator 2026-09-20).
//
// TWO ASKS, ONE FILE, because they are two halves of the same thing:
//
//   1. "can we make that sandbox account's sbx/src/ path points to src/an read-only?"
//      A directory JUNCTION in every pool profile plus a STANDING ReadAndExecute grant on
//      the target. BOTH halves or the feature is a lie: a junction whose target denies the
//      leased account is a directory the being can see and cannot open, which is exactly
//      the "permitted by Claude Code, refused by the kernel" failure the share ACEs exist
//      to close.
//
//   2. The leak that made half of #1 dangerous to reason about: twelve standing
//      `(OI)(CI)(RX)` ACEs on ~\src\egpt, one per pool account, measured on kg 2026-09-20.
//      Those are LEASE ACEs (a being's read-only `allowed_paths`, granted per turn) that
//      were never revoked. The standing group grant #1 adds is a DIFFERENT KIND and must
//      stay distinguishable from them — hence the assertions below that the provisioner
//      grants to the GROUP and the launcher grants per-account.
//
// WHY THE LEAK HAPPENS, which is what the fixes are shaped around: a sandboxed lease is
// held for the lifetime of the warm CLI process, and warm-cli-session.mjs's close() ends
// that process with proc.kill() — TerminateProcess on Windows, whatever the signal. A
// PowerShell `finally` does not survive that, so the launcher's revoke does NOT run at the
// ORDINARY end of a sandboxed session. The reclaim is the real cleanup path, and it fires
// only when that same account is leased again; an account nothing leases again keeps its
// ACEs forever, and a path many conversations share collects one per pool account.
//
// WHAT THIS FILE IS AND IS NOT — the same split tests/sandbox-ace-reclaim.test.mjs
// documents. The launcher is PowerShell with a param block, so nothing can dot-source it:
// these are STRUCTURAL locks on its source. The BEHAVIOUR — a real junction on a real
// directory, a real ACE really granted and really revoked — is exercised for real in
// setup/sandbox-account.Tests.ps1 ('Grant-SandboxPoolAccess', 'Clear-SandboxAbandonedLeases'
// and 'the pool profile src junction'), run with:
//   Invoke-Pester -Script setup\sandbox-account.Tests.ps1
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const launcher = () => readFileSync(join(REPO, 'setup', 'sandbox-logon-launcher.ps1'), 'utf8');
const accountLib = () => readFileSync(join(REPO, 'setup', 'sandbox-account.ps1'), 'utf8');
const provisioner = () => readFileSync(join(REPO, 'setup', 'provision-sandbox-account.ps1'), 'utf8');

// The scrub pass's inline -Command payload: the array literal Clear-SandboxProfileContents
// builds and joins with '; '. Everything the leased account runs on lease acquire is in here.
function scrubScript(src) {
  const i = src.indexOf('$scrubScript = @(');
  expect(i, 'Clear-SandboxProfileContents no longer builds a $scrubScript — the junction rides that payload').toBeGreaterThan(0);
  const end = src.indexOf(") -join '; '", i);
  expect(end).toBeGreaterThan(i);
  return src.slice(i, end);
}

describe('the pool profile gets a read-only src junction', () => {
  it('the scrub pass plants src as a JUNCTION, not a copy and not a symlink', () => {
    const s = scrubScript(launcher());
    expect(s).toMatch(/-ItemType Junction/);
    // A symlink would need SeCreateSymbolicLinkPrivilege, which the leased account does not
    // hold; a junction needs none. Getting this wrong fails only at runtime, as the account.
    expect(s).not.toMatch(/-ItemType SymbolicLink/);
  });

  it('it points at the OPERATOR home ~\\src, resolved in the launcher own context', () => {
    const src = launcher();
    // $env:USERPROFILE inside the scrub payload would be the POOL ACCOUNT's home — the
    // target has to be interpolated by the launcher, which runs as the operator.
    expect(src).toMatch(/\$srcRoot = Join-Path \$env:USERPROFILE 'src'/);
    expect(scrubScript(src)).toMatch(/-Target '\$srcRoot'/);
  });

  it('it is planted AFTER the wipe, and the locked-entry report comes before it', () => {
    const s = scrubScript(launcher());
    const wipe = s.indexOf('Remove-Item -Recurse -Force');
    const report = s.indexOf('locked entries left');
    const junction = s.indexOf('-ItemType Junction');
    // The scrub stays TOTAL: the junction is re-planted after everything is deleted, never
    // exempted from the delete.
    expect(wipe).toBeGreaterThan(0);
    expect(junction).toBeGreaterThan(wipe);
    // ...and the report counts what the WIPE could not delete. Counting the junction too
    // would make a healthy scrub and a stuck one report the same non-zero number.
    expect(report).toBeGreaterThan(wipe);
    expect(junction).toBeGreaterThan(report);
  });

  it('it is guarded, so a second acquire is a no-op rather than an error', () => {
    // The payload's own $ signs are backtick-escaped in the launcher source.
    expect(scrubScript(launcher())).toMatch(/if\(!\(Test-Path -LiteralPath `\$s\)\)/);
  });

  it('the payload stays inside the 1024-character CreateProcessWithLogonW budget', () => {
    // MSDN's lpCommandLine limit is real and ENFORCED here — a long command line fails with
    // E_INVALIDARG rather than truncating (see Invoke-AsLeasedAccount's BUDGET note), and the
    // whole payload is one argv element. Measured 775 characters with the real values; this
    // is a coarse ceiling on the SOURCE so a future addition has to notice the budget.
    const s = scrubScript(launcher());
    expect(s.length).toBeLessThan(1400);
    // Every " in the payload becomes \" in the command line, i.e. costs two characters of a
    // budget that is already two thirds spent. The payload uses single quotes throughout.
    expect(s.split('\n').filter((l) => l.trim().startsWith('"')).join('\n').replace(/^\s*"|"\s*$/gm, '')).not.toMatch(/[^`]"/);
  });

  it('the pool profile does NOT get Desktop/Documents/Downloads — those are the conversation folder job', () => {
    // Operator ruling 2026-09-20, reversing the first cut: a home-like folder in the pool
    // profile is scratch (this very scrub wipes it every acquire) and is not the being's cwd.
    // The being's own folders live in the conversation tree — see Room.treeDirs.
    const s = scrubScript(launcher());
    expect(s).not.toMatch(/'Desktop'/);
    expect(s).not.toMatch(/'Downloads'/);
  });
});

describe('the OTHER half: a standing read grant on the junction target', () => {
  it('the provisioner grants the pool group ReadAndExecute on ~\\src, never Modify', () => {
    const p = provisioner();
    expect(p).toMatch(/\$srcDir = Join-Path \$env:USERPROFILE 'src'/);
    expect(p).toMatch(/Grant-SandboxPoolAccess -Path \$srcDir/);
    // Grant-SandboxPoolAccess is the ReadAndExecute helper; Grant-SandboxPoolModify is the
    // read-write one and must never be the thing pointed at the operator's whole source tree.
    expect(p).not.toMatch(/Grant-SandboxPoolModify -Path \$srcDir/);
  });

  it('it is granted to the GROUP, which is what keeps it distinguishable from lease litter', () => {
    // An ACE naming egpt-sandbox-pool on ~\src is this standing grant. An ACE naming an
    // individual egpt-sbx-NN anywhere under it is a lease ACE that should have been revoked.
    // Reading an icacls dump depends on the two never being written by the same code path.
    expect(accountLib()).toMatch(/function Grant-SandboxPoolAccess[\s\S]{0,900}NTAccount\(\$SandboxPoolGroup\)/);
    expect(accountLib()).toMatch(/function Grant-SandboxPoolAccess[\s\S]{0,900}'ReadAndExecute', 'ContainerInherit,ObjectInherit'/);
  });

  it('the standing-vs-per-turn choice is stated in the header, not left to be inferred', () => {
    // The ask was explicit and so is the cost: all 16 accounts can read all of the operator's
    // source, between turns as well as during them. It has to be a decision on the page.
    const p = provisioner();
    const i = p.indexOf("$srcDir = Join-Path $env:USERPROFILE 'src'");
    const header = p.slice(Math.max(0, i - 2600), i);
    expect(header).toMatch(/STANDING, NOT PER-TURN/);
  });
});

describe('a lease share is released with the lease', () => {
  it('a revoke that FAILED keeps its lock file, so the reclaim can retry it', () => {
    // THE HOLE THIS CLOSES: the finally logged "the next reclaim of this lease will retry
    // it" and then deleted the lock file — ledger and all — so nothing named the leaked path
    // ever again. The reclaim path (Clear-SandboxStaleLease) always carried failures forward;
    // this is that same discipline on the clean path, not a second idea about it.
    const src = launcher();
    const fin = src.slice(src.indexOf('} finally {', src.indexOf('$acesGranted = New-Object')));
    expect(fin).toMatch(/\$stillGranted/);
    expect(fin).toMatch(/Write-SandboxLeaseLedger -Stream \$lockStream -Paths \$stillGranted/);
    // The Remove-Item is now conditional on there being nothing left to find.
    expect(fin).toMatch(/if \(\$keepLock\) \{[\s\S]{0,600}\} else \{[\s\S]{0,400}Remove-Item -LiteralPath \$lockPath/);
  });

  it('the pool-wide reclaim reuses Clear-SandboxStaleLease rather than redefining "revoked"', () => {
    const lib = accountLib();
    const fn = lib.slice(lib.indexOf('function Clear-SandboxAbandonedLeases'));
    expect(fn).toMatch(/Clear-SandboxStaleLease -Stream \$stream -AccountName \$account/);
    // No second purge loop, no second opinion about what an ACE is.
    expect(fn).not.toMatch(/PurgeAccessRules/);
  });

  it('it uses the launcher own staleness test, so a LIVE lease is never touched', () => {
    const lib = accountLib();
    const fn = lib.slice(lib.indexOf('function Clear-SandboxAbandonedLeases'));
    expect(fn).toMatch(/\[System\.IO\.FileShare\]::None/);
    expect(fn).toMatch(/'held'/);
  });

  it('it guards the pool-account prefix before it aims a revoke at anything', () => {
    const lib = accountLib();
    const fn = lib.slice(lib.indexOf('function Clear-SandboxAbandonedLeases'));
    const guard = fn.indexOf('$SandboxPoolPrefix');
    const revoke = fn.indexOf('Clear-SandboxStaleLease');
    expect(guard).toBeGreaterThan(0);
    expect(revoke).toBeGreaterThan(guard);
  });

  it('the locks directory has ONE derivation, shared by the launcher and the repair path', () => {
    expect(accountLib()).toMatch(/\$SandboxLocksDir = Join-Path \$CredDir 'sandbox-pool-locks'/);
    expect(launcher()).toMatch(/\$locksDir = \$SandboxLocksDir/);
    // Two spellings of the same directory would let the repair sweep one and the launcher use
    // the other, silently.
    expect(launcher()).not.toMatch(/Join-Path \(Join-Path \$env:ProgramData 'egpt'\) 'sandbox-pool-locks'/);
  });

  it('the provisioner runs that sweep, which is the repair path for the 16 existing accounts', () => {
    expect(provisioner()).toMatch(/Clear-SandboxAbandonedLeases/);
  });
});
