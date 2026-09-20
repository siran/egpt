// sandbox-src-junction.test.mjs — THE POOL PROFILE'S ~/src AND ~/my-code, AND THE
// LEASE-ACE LEAK (operator 2026-09-20).
//
// TWO ASKS, ONE FILE, because they are two halves of the same thing:
//
//   1. "can we make that sandbox account's sbx/src/ path points to src/an read-only?" and,
//      the same day, "all agents see an src/ directory, it is actually interesting to have
//      a my-code/ pointing to src/egpt". TWO directory JUNCTIONS in every pool profile,
//      planted by ONE statement generator, plus a STANDING ReadAndExecute grant on ~/src
//      that my-code inherits. BOTH halves or the feature is a lie: a junction whose target
//      denies the leased account is a directory the being can see and cannot open, which is
//      exactly the "permitted by Claude Code, refused by the kernel" failure the share ACEs
//      exist to close.
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
// these are STRUCTURAL locks on its source. The BEHAVIOUR — real junctions on a real
// directory, a real ACE really granted and really revoked — is exercised for real in
// setup/sandbox-account.Tests.ps1 ('Grant-SandboxPoolAce', 'Revoke-SandboxPathAces',
// 'Clear-SandboxAbandonedLeases', 'Test-SandboxPoolReadCovered' and 'the pool profile
// junctions'), run with:
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
  expect(i, 'Clear-SandboxProfileContents no longer builds a $scrubScript — the junctions ride that payload').toBeGreaterThan(0);
  const end = src.indexOf(") -join '; '", i);
  expect(end).toBeGreaterThan(i);
  return src.slice(i, end);
}

// The ONE generator both junctions come from, in the dot-sourceable half.
function junctionGenerator(lib) {
  const i = lib.indexOf('function Get-SandboxProfileJunctionStatement');
  expect(i, 'Get-SandboxProfileJunctionStatement is gone — the junctions have no single generator').toBeGreaterThan(0);
  return lib.slice(i, lib.indexOf('\n}', i));
}

describe('the pool profile gets read-only src and my-code junctions', () => {
  it('BOTH links come out of ONE generator, not two copies of a statement', () => {
    // Operator 2026-09-20: "Both junctions are planted by the same statement-generator." A
    // copy is how the two would drift into disagreeing about the existence guard or the
    // error handling — the same failure mode the (d2) share loop is shaped to avoid.
    const g = junctionGenerator(accountLib());
    expect(g).toMatch(/'src'\s*=\s*\$OperatorSrc/);
    expect(g).toMatch(/'my-code'\s*=\s*\(Join-Path \$OperatorSrc 'egpt'\)/);
    // ONE New-Item in the whole generator: the payload loops over the table.
    expect((g.match(/-ItemType Junction/g) || []).length).toBe(1);
  });

  it('they are JUNCTIONS, not copies and not symlinks', () => {
    const g = junctionGenerator(accountLib());
    expect(g).toMatch(/-ItemType Junction/);
    // A symlink would need SeCreateSymbolicLinkPrivilege, which the leased account does not
    // hold; a junction needs none. Getting this wrong fails only at runtime, as the account.
    expect(g).not.toMatch(/-ItemType SymbolicLink/);
  });

  it('my-code points INSIDE src, so the standing ~\\src grant covers it with no second grant', () => {
    // The target is $OperatorSrc\egpt, which inherits the pool group's (OI)(CI)(RX). A
    // my-code aimed anywhere else would need a grant of its own that nothing writes.
    const g = junctionGenerator(accountLib());
    expect(g).toMatch(/Join-Path \$OperatorSrc 'egpt'/);
    expect(provisioner()).not.toMatch(/Grant-SandboxPool\w+ -Path \$myCode/);
  });

  it('the target is resolved in the LAUNCHER own context, never inside the payload', () => {
    const src = launcher();
    // $env:USERPROFILE inside the scrub payload would be the POOL ACCOUNT's home — the
    // target has to be interpolated by the launcher, which runs as the operator.
    expect(src).toMatch(/\$srcRoot = Join-Path \$env:USERPROFILE 'src'/);
    expect(scrubScript(src)).toMatch(/\(Get-SandboxProfileJunctionStatement -OperatorSrc \$srcRoot\)/);
    // ...and the launcher does not spell a junction out for itself any more.
    expect(src).not.toMatch(/-ItemType Junction/);
  });

  it('they are planted AFTER the wipe, and the locked-entry report comes before them', () => {
    const s = scrubScript(launcher());
    const wipe = s.indexOf('Remove-Item -Recurse -Force');
    const report = s.indexOf('locked entries left');
    const junction = s.indexOf('Get-SandboxProfileJunctionStatement');
    // The scrub stays TOTAL: the junctions are re-planted after everything is deleted, never
    // exempted from the delete.
    expect(wipe).toBeGreaterThan(0);
    expect(junction).toBeGreaterThan(wipe);
    // ...and the report counts what the WIPE could not delete. Counting the junctions too
    // would make a healthy scrub and a stuck one report the same non-zero number.
    expect(report).toBeGreaterThan(wipe);
    expect(junction).toBeGreaterThan(report);
  });

  it('each is guarded, so a second acquire is a no-op rather than an error', () => {
    // The payload's own $ signs are backtick-escaped in the generator's source.
    expect(junctionGenerator(accountLib())).toMatch(/if\(!\(Test-Path -LiteralPath `\$s\)\)/);
  });

  it('the payload stays inside the 1024-character CreateProcessWithLogonW budget', () => {
    // MSDN's lpCommandLine limit is real and ENFORCED here — a long command line fails with
    // E_INVALIDARG rather than truncating (see Invoke-AsLeasedAccount's BUDGET note), and the
    // whole payload is one argv element. Measured 775 characters with ONE junction; the
    // second rides the same foreach rather than doubling the statement. The real length is
    // asserted in Pester, which can call the generator; this is the coarse source ceiling.
    const s = scrubScript(launcher());
    expect(s.length).toBeLessThan(1400);
    expect(junctionGenerator(accountLib())).toMatch(/foreach\(`\$j in @\(\$pairs\)\)\{/);
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
    // ~\src rides the read-only list, which is granted with -Grant 'Read' — the
    // (OI)(CI)(RX) row of Grant-SandboxPoolAce's table.
    const readStep = p.slice(p.indexOf('$readOnly = [ordered]@{'), p.indexOf("-Grant 'Read'") + 20);
    expect(readStep).toMatch(/= \$srcDir/);
    expect(readStep).toMatch(/Grant-PoolOn -Targets \$readOnly -Grant 'Read'/);
    // 'Modify' is the read-write row and must never be the thing pointed at the operator's
    // whole source tree.
    expect(p).not.toMatch(/Grant-PoolOn -Targets \$readOnly -Grant 'Modify'/);
  });

  it('it is granted to the GROUP, which is what keeps it distinguishable from lease litter', () => {
    // An ACE naming egpt-sandbox-pool on ~\src is this standing grant. An ACE naming an
    // individual egpt-sbx-NN anywhere under it is a lease ACE that should have been revoked.
    // Reading an icacls dump depends on the two never being written by the same code path.
    expect(accountLib()).toMatch(/function Grant-SandboxPoolAce[\s\S]{0,1200}NTAccount\(\$SandboxPoolGroup\)/);
    // The Read row of the one grant table: inheritable ReadAndExecute, nothing more.
    expect(accountLib()).toMatch(/Read\s+= @\{ Spec = '\(OI\)\(CI\)\(RX\)';[\s\S]{0,200}'ReadAndExecute, Synchronize'/);
  });

  it('the grant CHECKS the DACL before it writes — a grant is a fact to converge on', () => {
    // Operator 2026-09-20, after watching the provisioner rewrite five ancestor DACLs that
    // were already correct: "the script is doing something slow and perhaps weird with the
    // ACLs…. it shouldn't be complicated, it has to be easy to review". A DACL write on a
    // container re-propagates inheritance over the whole subtree — 307 s for one pass over
    // ~\src — so re-issuing a correct grant is not free. The BEHAVIOUR is proved for real in
    // setup/sandbox-account.Tests.ps1 ('Grant-SandboxPoolAce check-first'); this locks the
    // order, which is the part a refactor could quietly lose.
    const lib = accountLib();
    const fn = lib.slice(lib.indexOf('function Grant-SandboxPoolAce'), lib.indexOf('function Test-SandboxPoolReadCovered'));
    const read = fn.indexOf('$present = @((Get-Acl');
    const write = fn.indexOf('& icacls.exe');
    expect(read).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(read);
    expect(fn).toMatch(/return 'already granted'/);
    // ONE ACL tool for every grant, the same one the revoke uses. Set-Acl is what hung twice
    // on C:\Users\an, and it persists the SACL as well as the DACL.
    expect(fn).not.toMatch(/Set-Acl/);
    // Plain /grant, never /grant:r — the grants stay additive and never narrow.
    expect(fn).not.toMatch(/\/grant:r/);
    expect((fn.match(/icacls\.exe/g) || []).length).toBe(1);
    // ...and the three superseded Set-Acl grant helpers are gone, not kept beside it.
    expect(lib).not.toMatch(/function Grant-SandboxPoolAccess/);
    expect(lib).not.toMatch(/function Grant-SandboxPoolModify/);
    expect(lib).not.toMatch(/function Grant-SandboxPoolTraverse/);
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

  it('the pool-wide reclaim reuses the ONE revoke rather than redefining "revoked"', () => {
    // It can no longer route through Clear-SandboxStaleLease (that one is keyed to a single
    // account, and the whole point of the sweep is batching ACROSS locks), but it must still
    // end in the same Revoke-SandboxPathAces every other caller ends in, and reuse the same
    // ledger read/write. No second purge loop, no second opinion about what an ACE is.
    const lib = accountLib();
    const fn = lib.slice(lib.indexOf('function Clear-SandboxAbandonedLeases'));
    expect(fn).toMatch(/Revoke-SandboxPathAces -Path \$entry\.Path -AccountNames/);
    expect(fn).toMatch(/Read-SandboxLeaseLedger -Stream \$stream/);
    expect(fn).toMatch(/Write-SandboxLeaseLedger -Stream \$lease\.Stream/);
    expect(fn).not.toMatch(/PurgeAccessRules/);
    expect(fn).not.toMatch(/Set-Acl/);
    // Exactly one call site, i.e. the grouping is the only thing this function adds.
    expect((fn.match(/Revoke-SandboxPathAces/g) || []).length).toBe(1);
  });

  it('REPRODUCE-FIRST: the sweep groups by PATH, so it is O(paths) and not O(accounts × tree)', () => {
    // THE DEFECT. Fifteen abandoned locks, twelve naming ~\src\egpt, one Set-Acl each —
    // minutes of silence that the operator read as a hang. Writing a DACL on a container
    // re-propagates inheritance over the whole subtree, so the cost is the TREE, not the ACE.
    // Measured by hand the same day: one `icacls ... /remove:g <12 accounts> /C` = 2 s.
    const lib = accountLib();
    const fn = lib.slice(lib.indexOf('function Clear-SandboxAbandonedLeases'));
    // The grouping structure itself: path -> the accounts that leaked onto it.
    expect(fn).toMatch(/\$byPath/);
    expect(fn).toMatch(/\$byPath\[\$key\]\.Accounts\.Add\(\$lease\.Account\)/);
    // ...and the revoke loop walks PATHS, not leases.
    expect(fn).toMatch(/foreach \(\$key in @\(\$byPath\.Keys\)\)/);
  });

  it('REPRODUCE-FIRST: the one revoke is icacls /remove:g, with every account on one line', () => {
    const lib = accountLib();
    const fn = lib.slice(lib.indexOf('function Revoke-SandboxPathAces'), lib.indexOf('function Revoke-SandboxLeaseAces'));
    expect(fn).toMatch(/'\/remove:g'/);
    // The account list is expanded into the SAME argv, as SID literals.
    expect(fn).toMatch(/\$targets \| ForEach-Object \{ "\*\$\(\$sids\[\$_\]\.Value\)" \}/);
    expect(fn).toMatch(/& icacls\.exe @icaclsArgs/);
    // No /T — a lease ACE is explicit and on the named object only, and recursing would
    // re-walk the very tree this exists to stop re-walking.
    expect(fn).not.toMatch(/'\/T'/);
    // Exactly one icacls invocation in the function body: the batching is the whole point.
    expect((fn.match(/icacls\.exe/g) || []).length).toBe(1);
    // ...and Set-Acl is gone from the revoke entirely — as it now is from the grant
    // (Grant-SandboxPoolAce). One ACL tool, on both sides of the ledger.
    expect(fn).not.toMatch(/Set-Acl/);
  });

  it('REPRODUCE-FIRST: an ACE that is already gone reconciles to clean, and costs no write', () => {
    // Operator 2026-09-20, having removed the twelve by hand: "a revoke of an ACE that is
    // already gone is SUCCESS, not failure … make the 15 stale locks clear cleanly on the
    // next run". The DACL is read first and icacls is not run at all when nothing is there.
    const lib = accountLib();
    const fn = lib.slice(lib.indexOf('function Revoke-SandboxPathAces'), lib.indexOf('function Revoke-SandboxLeaseAces'));
    const presence = fn.indexOf('$before = @((Get-Acl');
    const call = fn.indexOf('& icacls.exe');
    expect(presence).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(presence);
    expect(fn).toMatch(/if \(\$targets\.Count -eq 0\) \{ return \$records\.ToArray\(\) \}/);
    expect(fn).toMatch(/Status = 'clean'/);
    // And the VERDICT comes from the DACL afterwards, not from the exit code — an icacls that
    // returned non-zero over something unrelated must not turn a cleared ACE into a failure.
    expect(fn).toMatch(/if \(\$after -contains \$sids\[\$n\]\.Value\)/);
  });

  it("a share the pool group can ALREADY read gets no per-account ACE — and a WRITE share always does", () => {
    // Operator 2026-09-20: ~/src carries a standing (OI)(CI)(RX) for egpt-sandbox-pool, so a
    // per-turn read-only share under it is a DACL write on a big tree that grants the being
    // what it already has and leaves one more ACE for a hard kill to leak. The writable class
    // is NOT skippable: a conversation folder's Modify is real and per-lease.
    const src = launcher();
    expect(src).toMatch(/@\{ Grant = 'Modify';\s*SkipIfPoolReadCovered = \$false;/);
    expect(src).toMatch(/@\{ Grant = 'Read';\s*SkipIfPoolReadCovered = \$true;/);
    expect(src).toMatch(/if \(\$shareClass\.SkipIfPoolReadCovered -and \(Test-SandboxPoolReadCovered -Path \$sp -LeasedSid \$leasedSid\)\)/);
    // It says so — a skipped grant that logged nothing would be indistinguishable from a
    // share the launcher silently forgot.
    const step = src.slice(src.indexOf('# ---- (d2)'), src.indexOf('# ---- (e)'));
    const skip = step.indexOf('SkipIfPoolReadCovered -and');
    expect(step.slice(skip, skip + 400)).toMatch(/Log "share path is already readable/);
    // The skip comes BEFORE the ledger append: an ACE that was never granted must never be
    // recorded as one, or the next reclaim hunts a path that carries nothing.
    expect(skip).toBeLessThan(step.indexOf('Add-SandboxLeaseLedgerPath'));
  });

  it('the coverage check is by GROUP and demands the whole read mask — a wrong skip is a silent denial', () => {
    // The STOP-rule surface. A lease ACE naming an individual egpt-sbx-NN must never satisfy
    // it (that is the litter being removed), a traverse-only (X,RA,RC) must never satisfy it
    // (it withholds read-data on purpose), and any Deny means the per-account grant is still
    // needed — an explicit Allow for the account beats an inherited Deny for the group.
    const lib = accountLib();
    const fn = lib.slice(lib.indexOf('function Test-SandboxPoolReadCovered'));
    expect(fn).toMatch(/NTAccount\(\$SandboxPoolGroup\)/);
    expect(fn).toMatch(/\$rule\.IdentityReference\.Value -ne \$groupSid\.Value/);
    expect(fn).toMatch(/AccessControlType\]::Deny/);
    expect(fn).toMatch(/-band \$readAndExecute\) -eq \$readAndExecute/);
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
