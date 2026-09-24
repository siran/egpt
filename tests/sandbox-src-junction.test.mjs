// sandbox-src-junction.test.mjs — THE POOL PROFILE'S ~/src MOUNT, AND THE LEASE-ACE LEAK.
//
// TWO ASKS, ONE FILE, because they are two halves of the same thing:
//
//   1. THE MOUNT. Operator 2026-09-20 asked for "that sandbox account's sbx/src/ path points
//      to src/an read-only" and "a my-code/ pointing to src/egpt", and on 2026-09-23 REVERSED
//      the wide half: "dismiss mounting ~/src always, that was a faux-pas", and "in the same
//      way that the conversation directory is mounted in the sandbox account, the src/egpt can
//      also be mounted as src/". So there is now ONE name, `src`, pointing at ~\src\egpt, and
//      `my-code` is gone — it pointed at the same target, nothing outside this repo named it,
//      and its table row cost about 34 characters of a command-line budget that REFUSES THE
//      TURN when it overruns.
//      BOTH halves or the feature is a lie: a junction whose target denies the leased account
//      is a directory the being can see and cannot open, which is exactly the "permitted by
//      Claude Code, refused by the kernel" failure the share ACEs exist to close. The other
//      half is a STANDING ReadAndExecute for the pool GROUP on ~\src\egpt — and the retirement
//      of the one that used to be on all of ~\src, which is asserted here too: narrowing the
//      junction while leaving the wide ACE would be cosmetic.
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
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const launcher = () => readFileSync(join(REPO, 'setup', 'sandbox-logon-launcher.ps1'), 'utf8');
const accountLib = () => readFileSync(join(REPO, 'setup', 'sandbox-account.ps1'), 'utf8');
const provisioner = () => readFileSync(join(REPO, 'setup', 'provision-sandbox-account.ps1'), 'utf8');
const sweepScript = () => readFileSync(join(REPO, 'setup', 'sweep-sandbox-leases.ps1'), 'utf8');

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

describe('the pool profile gets a read-only src junction onto the eGPT checkout', () => {
  it('EVERY link comes out of ONE generator, not copies of a statement', () => {
    // Operator 2026-09-20: "Both junctions are planted by the same statement-generator." A
    // copy is how the two would drift into disagreeing about the existence guard or the
    // error handling — the same failure mode the (d2) share loop is shaped to avoid.
    const g = junctionGenerator(accountLib());
    expect(g).toMatch(/'src'\s*=\s*\$RepoRoot/);
    expect(g).toMatch(/'egpt'\s*=\s*\$RoomTarget/);
    // ONE New-Item in the whole generator: the payload loops over the table.
    expect((g.match(/-ItemType Junction/g) || []).length).toBe(1);
  });

  it('REPRODUCE: the operator\'s whole ~\\src is NOT mounted any more, and cannot be by accident', () => {
    // Operator 2026-09-23: "dismiss mounting ~/src always, that was a faux-pas". The parameter
    // was RENAMED with the meaning (-OperatorSrc -> -RepoRoot), so a caller that still passes
    // the wide target fails to bind rather than silently re-mounting all of the operator's
    // source under a name that now advertises something narrower.
    const g = junctionGenerator(accountLib());
    expect(g).not.toMatch(/\$OperatorSrc/);
    expect(accountLib()).toMatch(/function Get-SandboxProfileJunctionStatement[\s\S]{0,600}\[string\]\$RepoRoot/);
    expect(launcher()).not.toMatch(/-OperatorSrc/);
    // `my-code` is gone with it — one name for one target.
    expect(g).not.toMatch(/'my-code'/);
  });

  it('they are JUNCTIONS, not copies and not symlinks', () => {
    const g = junctionGenerator(accountLib());
    expect(g).toMatch(/-ItemType Junction/);
    // A symlink would need SeCreateSymbolicLinkPrivilege, which the leased account does not
    // hold; a junction needs none. Getting this wrong fails only at runtime, as the account.
    expect(g).not.toMatch(/-ItemType SymbolicLink/);
  });

  it('the target is the CHECKOUT, and it is granted where the ACE actually has to be', () => {
    // A junction is only a name; the target's DACL decides. The repo is what the provisioner
    // grants the pool GROUP ReadAndExecute on, standing — it cannot be per-lease, because a
    // DACL write on that tree re-propagates inheritance through node_modules.
    const p = provisioner();
    expect(p).toMatch(/\$repoDir = Join-Path \$srcDir 'egpt'/);
    const readStep = p.slice(p.indexOf('$readOnly = [ordered]@{'), p.indexOf("-Grant 'Read'") + 20);
    expect(readStep).toMatch(/= \$repoDir/);
    expect(readStep).not.toMatch(/= \$srcDir\b/);
  });

  it('the target is resolved in the LAUNCHER own context, never inside the payload', () => {
    const src = launcher();
    // $env:USERPROFILE inside the scrub payload would be the POOL ACCOUNT's home — the
    // target has to be interpolated by the launcher, which runs as the operator.
    expect(src).toMatch(/\$repoRoot = Join-Path \(Join-Path \$env:USERPROFILE 'src'\) 'egpt'/);
    expect(scrubScript(src)).toMatch(/\(Get-SandboxProfileJunctionStatement -RepoRoot \$repoRoot -RoomTarget \$RoomTarget\)/);
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

  it('each is REMOVED then re-created, so a second acquire re-points rather than erroring', () => {
    // WAS an existence guard (`if(!(Test-Path ...))`) until the `egpt` mount joined the table
    // (2026-09-23). src and my-code have a CONSTANT target, so leaving a survivor alone was
    // harmless; egpt's target is a different Room every lease, and a link that outlived the wipe
    // would hand this conversation the previous one's Room. Still idempotent — three passes
    // leave exactly three junctions, proven for real in setup/sandbox-account.Tests.ps1.
    // The payload's own $ signs are backtick-escaped in the generator's source.
    const g = junctionGenerator(accountLib());
    expect(g).toMatch(/ri -LiteralPath `\$s -Recurse -Force -EA 0/);
    expect(g).not.toMatch(/if\(!\(Test-Path -LiteralPath `\$s\)\)/);
    // -Recurse takes the LINK, never the target (measured 2026-08-26, re-measured 2026-09-23);
    // without it Remove-Item PROMPTS on a junction with a non-empty target and the
    // -NonInteractive scrub child throws instead. Both halves are locked in the Pester suite.
    expect((g.match(/ri -LiteralPath/g) || []).length).toBe(1);
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
  it('the provisioner grants the pool group ReadAndExecute on ~\\src\\egpt, never Modify', () => {
    const p = provisioner();
    expect(p).toMatch(/\$srcDir = Join-Path \$env:USERPROFILE 'src'/);
    // The repo rides the read-only list, which is granted with -Grant 'Read' — the
    // (OI)(CI)(RX) row of Grant-SandboxPoolAce's table.
    const readStep = p.slice(p.indexOf('$readOnly = [ordered]@{'), p.indexOf("-Grant 'Read'") + 20);
    expect(readStep).toMatch(/= \$repoDir/);
    expect(readStep).toMatch(/Grant-PoolOn -Targets \$readOnly -Grant 'Read'/);
    // 'Modify' is the read-write row and must never be the thing pointed at the operator's
    // source.
    expect(p).not.toMatch(/Grant-PoolOn -Targets \$readOnly -Grant 'Modify'/);
  });

  it('REPRODUCE: the WIDE ~\\src grant is actively REMOVED, not merely stopped being written', () => {
    // BOTH HALVES OR IT IS THE SAME BUG IN A MIRROR. Every node provisioned before 2026-09-23
    // carries egpt-sandbox-pool:(OI)(CI)(RX) on ~\src, and that ACE is INHERITED by every
    // sibling checkout in it. Narrowing only the junction would leave the whole of the
    // operator's source readable by all 16 accounts through a link that no longer says so —
    // strictly worse than the state being retired, because it is no longer visible.
    const p = provisioner();
    expect(p).toMatch(/Revoke-SandboxPathAces -Path \$srcDir -AccountNames @\(\$SandboxPoolGroup\)/);
    // THE GROUP, never an account: an ACE naming an individual egpt-sbx-NN under ~\src is lease
    // litter and belongs to the sweep at the end of the script, which is a different step.
    expect(p).not.toMatch(/Revoke-SandboxPathAces -Path \$srcDir -AccountNames @\(Get-SandboxPoolAccountNames/);
    // It goes through the ONE revoke, which reads the DACL first — so a node already narrowed
    // costs nothing, and this stays as idempotent as every other step here. (The header still
    // MENTIONS the hand `icacls /remove:g` for the grants this script does not retire; what it
    // must not have is an icacls INVOCATION of its own.)
    expect(p).not.toMatch(/&\s*icacls/);
    // ~\src keeps its TRAVERSE ace (walk through, do not list) — that is what still lets the
    // pool reach the checkout by name without enumerating what else is in there.
    expect(p).toMatch(/'the operator source' = Join-Path \$env:USERPROFILE 'src'/);
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
    expect(fin).toMatch(/Write-SandboxLeaseLedger -Stream \$lockStream -Entries \$stillGranted/);
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
    expect(fn).toMatch(/Revoke-SandboxPathAces -Path \$entry\.Path -FileId \$entry\.FileId -AccountNames/);
    expect(fn).toMatch(/Read-SandboxLeaseLedgerEntries -Stream \$stream/);
    expect(fn).toMatch(/Write-SandboxLeaseLedger -Stream \$lease\.Stream/);
    expect(fn).not.toMatch(/PurgeAccessRules/);
    expect(fn).not.toMatch(/Set-Acl/);
    // Exactly one CALL SITE (a mention in the header is not one), i.e. the grouping is the only
    // thing this function adds.
    expect((fn.match(/^\s*\$recs = @\(Revoke-SandboxPathAces/gm) || []).length).toBe(1);
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

// ── THE REVOKE THAT DID NOT HAPPEN (measured on kg 2026-09-23, from the live artefacts).
//
//    THE MECHANISM WAS NEVER BROKEN; IT WAS NEVER REACHED. warm-cli-session.mjs's close() ends
//    the session with proc.kill() = TerminateProcess, so the launcher's `finally` does not run at
//    the ORDINARY end of a sandboxed session. The only revoke that then fires is the per-account
//    reclaim at step (a2), and it is keyed to ONE account and fires only when THAT account is
//    leased again. An account that leaks and then goes quiet keeps its ACEs indefinitely.
//
//    THE EVIDENCE, read off C:\ProgramData\egpt\sandbox-pool-locks and the thread stores:
//      * 14 of the 16 pool locks existed and NOT ONE was held — every one opened exclusively,
//        i.e. every one was a turn that died without running its finally.
//      * each of those 14 ledgers named exactly 2 paths (a Room and a ~\.egpt-jsonl\<thread>),
//        and all 14 of those ACEs were still on disk: 9 distinct thread stores carrying 14
//        explicit egpt-sbx-NN ACEs, one store granted to THREE pool accounts at once.
//      * the oldest lock was two days old. Nothing was going to clear it.
//
//    THE FIX: the reclaim stops being per-account. The launcher runs the SAME pool-wide function
//    the provisioner runs, once, right after it has taken its own lease — so every abandoned
//    lease is cleared by the next turn on the box rather than by the next turn on that account.
//
//    A SECOND DEFECT, FOUND IN THE SAME LEDGERS, AND NOW FIXED: egpt-sbx-08 and -13 named
//    ...\Favel Konefka-2608141626 while -03, -04 and -10 named ...\Favel Elena
//    Konefka-2608141626 — the SAME conversation (identical -2608141626 id), renamed slug. NTFS
//    carries a DACL through a rename, so those two ledgers pointed at nothing while the ACEs they
//    were written to revoke were alive at the new name. The revoke called that 'missing' and both
//    callers treated it as resolved — three pool accounts left holding Modify on a conversation
//    none of them was leased to, removable only by hand and by SID.
//
//    THE FIX: the ledger records the granted object's NTFS FILE ID beside its path, and the
//    revoke follows the id when the name stops naming the same object. Measured unelevated on
//    reve 2026-09-23: `fsutil file queryfileid` reads a directory's 128-bit id; `fsutil file
//    queryFileNameById` follows it through a rename AND a move; a DELETED object answers
//    Error 87, which is what finally separates "gone, ACEs went with it" from "renamed, ACE is
//    still out there"; and NTFS validates the sequence number, so a recycled MFT record cannot
//    make a stale id resolve to an innocent folder. An old ledger has no ids and must keep
//    behaving exactly as it did — which is asserted below. ──
describe('the reclaim reaches accounts nothing will lease again', () => {
  it('REPRODUCE: the launcher sweeps the WHOLE POOL on lease, not just the account it took', () => {
    const src = launcher();
    const lease = src.indexOf("leased pool account '$leasedName'");
    const sweep = src.indexOf('Clear-SandboxAbandonedLeases -LocksDir $locksDir');
    expect(lease).toBeGreaterThan(0);
    expect(sweep).toBeGreaterThan(0);
    // AFTER the lease, never before it: while the sweep holds another account's stale lock, a
    // launcher racing for that account sees a live lease and walks on. Sweeping first could cost
    // this very turn its preferred account.
    expect(sweep).toBeGreaterThan(lease);
    // ...and before the grant, so a turn never runs beside litter it could have cleared.
    expect(sweep).toBeLessThan(src.indexOf('# ---- (d) grant read/write'));
  });

  it('it is the SAME function, not a second sweeper the launcher grew of its own', () => {
    const src = launcher();
    // No second staleness test, no second ledger reader, no second purge loop in the launcher.
    expect(src).not.toMatch(/function Clear-Sandbox\w*Sweep/);
    // Exactly one CALL SITE (the header names it too, which is not one).
    expect((src.match(/@\(Clear-SandboxAbandonedLeases/g) || []).length).toBe(1);
    // The per-account reclaim at (a2) stays — it is what makes the ONE account this turn is
    // about to run as clean before it runs, which the pool sweep cannot promise for a lock it
    // does not hold.
    expect(src).toMatch(/Clear-SandboxStaleLease -Stream \$lockStream -AccountName \$name/);
  });

  it('OUR OWN LEASE IS NOT EXEMPTED — it is protected by the same test as everyone else\'s', () => {
    // The launcher holds its lock FileShare::None, so the sweep's exclusive open fails on it and
    // it is reported 'held'. An explicit "skip my account" parameter would be a second opinion
    // about what a live lease is, and the one that could be wrong.
    const src = launcher();
    const sweep = src.slice(src.indexOf('# ---- (a3)'), src.indexOf('$plainPwd = $null'));
    expect(sweep).not.toMatch(/-ExcludeAccount/);
    expect(sweep).toMatch(/held/);
    expect(accountLib()).toMatch(/function Clear-SandboxAbandonedLeases[\s\S]{0,4000}\[System\.IO\.FileShare\]::None/);
  });

  it('it is BUDGETED on the turn path and UNBUDGETED for the operator', () => {
    // The old reason to keep this off the lease path was real: a DACL write on a big tree
    // re-propagates inheritance, 307 s measured for ~\src. The budget is the guarantee, not the
    // expectation — and the trees themselves are gone from the ledgers now that the checkout is
    // a standing GROUP grant rather than a per-lease one.
    expect(launcher()).toMatch(/Clear-SandboxAbandonedLeases -LocksDir \$locksDir -TimeBudgetSeconds \$sweepBudget/);
    expect(accountLib()).toMatch(/\[double\]\$TimeBudgetSeconds = 0/);
    // The provisioner and the operator script pass none, so they finish the job.
    expect(provisioner()).not.toMatch(/Clear-SandboxAbandonedLeases[^\n]*TimeBudgetSeconds/);
    expect(sweepScript()).not.toMatch(/Clear-SandboxAbandonedLeases[^\n]*TimeBudgetSeconds/);
  });

  it('WHAT THE BUDGET SKIPS IS CARRIED, NEVER FORGOTTEN — the one move that makes a leak unfindable', () => {
    const lib = accountLib();
    const fn = lib.slice(lib.indexOf('function Clear-SandboxAbandonedLeases'));
    // The budget is checked BEFORE a pass starts, never during one: an icacls call cannot be
    // abandoned half way and leave a DACL anything can reason about.
    expect(fn).toMatch(/if \(\$TimeBudgetSeconds -ne 0 -and \$budget\.Elapsed\.TotalSeconds -ge \$TimeBudgetSeconds\)/);
    // A path with no record is DEFERRED, and deferred joins failed in the carry-over — so the
    // ledger keeps it and the lock is kept with it.
    expect(fn).toMatch(/Status = 'deferred'/);
    expect(fn).toMatch(/\$_\.Status -eq 'failed' -or \$_\.Status -eq 'deferred'/);
  });

  it("REPRODUCE: a ledger path that VANISHED is still never reported as if it were clean", () => {
    // The rename case, straight out of the live ledgers. For a lease with NO id — every lock
    // written before 2026-09-23 — the revoke still cannot follow a moved folder, and still must
    // not call the outcome success.
    const lib = accountLib();
    const revoke = lib.slice(lib.indexOf('function Revoke-SandboxPathAces'), lib.indexOf('function Revoke-SandboxLeaseAces'));
    expect(revoke).toMatch(/Status = 'missing'; Message = 'nothing is at that path any more\./);
    expect(revoke).toMatch(/RENAMED or MOVED, NTFS carried its DACL along/);
    // ...and it is said out loud where an operator reads it, not only in a record field.
    const fn = lib.slice(lib.indexOf('function Clear-SandboxAbandonedLeases'));
    expect(fn).toMatch(/\$vanished = @\(\$aces \| Where-Object \{ \$_\.Status -eq 'missing' \}\)/);
    expect(sweepScript()).toMatch(/PATH GONE/);
    // The loud warning is now aimed at the lines that DESERVE it — the id-less ones. A 'missing'
    // whose id was checked is not ambiguous and must not be reported as if it were.
    expect(fn).toMatch(/\$vanishedBlind = @\(\$vanished \| Where-Object \{ -not \$_\.FileId \}\)/);
  });
});

// ── THE RENAME IS FOLLOWED (2026-09-23). Everything here is a STRUCTURAL lock; the behaviour —
//    a real directory, really renamed, its ACE really followed and really removed — is measured
//    for real in setup/sandbox-account.Tests.ps1 ('Revoke-SandboxPathAces -FileId (the rename
//    hole, closed)' and 'the reclaim and the sweep, with ids on the ledger'). ──
describe('the ledger records the OBJECT, not only its name', () => {
  it('REPRODUCE: the id is read BEFORE the grant, on both grant steps, beside the path', () => {
    // Same order and same reason as the ledger append it rides: the crash log must be a
    // SUPERSET of what landed. An id recorded after a grant is an id a hard kill loses.
    const src = launcher();
    for (const [step, anchor, idVar] of [
      ['(d) TargetFolder', 'Grant-SandboxPoolAce -Path $TargetFolder', '$targetFileId'],
      ['(d2) share path', 'Grant-SandboxPoolAce -Path $sp', '$shareFileId'],
    ]) {
      const at = src.indexOf(anchor);
      expect(at, `step ${step} is gone`).toBeGreaterThan(0);
      const before = src.slice(Math.max(0, at - 1600), at);
      expect(before, `step ${step} records a path without the id that survives a rename`).toContain(
        'Get-SandboxPathFileId -Path',
      );
      expect(before).toContain(`-FileId "${idVar}"`);
    }
  });

  it('the id follows through the WHOLE lifecycle — append, revoke, carry-over', () => {
    const src = launcher();
    // The finally revokes ENTRIES (path + id), not bare paths...
    expect(src).toMatch(/Revoke-SandboxLeaseAces -AccountName \$leasedName -Entries \$acesGranted/);
    // ...and what it could not clear goes back on the ledger WITH its id. A retry without the id
    // is a retry with the hole back open.
    expect(src).toMatch(/ConvertTo-SandboxLeaseCarryEntry -Record \$rec/);
    expect(src).toMatch(/Write-SandboxLeaseLedger -Stream \$lockStream -Entries \$stillGranted/);
    // The per-account reclaim carries entries too, for the same reason.
    expect(src).toMatch(/\$reclaimCarryOver = @\(\$reclaimed \| Where-Object \{ \$_\.Status -eq 'failed' \} \| ForEach-Object \{ ConvertTo-SandboxLeaseCarryEntry/);
  });

  it('BACK-COMPAT: a line with no id is a path, and an old ledger is still just paths', () => {
    // Every lock on a live node right now holds bare paths. Reading one must not change, and
    // must not need a migration — the format is additive by construction.
    const lib = accountLib();
    const from = lib.slice(lib.indexOf('function ConvertFrom-SandboxLeaseLedgerLine'), lib.indexOf('function Read-SandboxLeaseLedgerEntries'));
    expect(from).toMatch(/if \(\$cut -lt 0\) \{ return \[pscustomobject\]@\{ Path = \$text; FileId = '' \} \}/);
    // An unknown field is ignored rather than rejected, so a future one cannot make today's
    // code refuse a ledger it could otherwise clean up.
    expect(from).toMatch(/StartsWith\('fid='/);
    // And the paths-only reader every existing caller uses is a PROJECTION of the entry reader,
    // not a second parser: one ledger, one thing that knows how a line is spelled.
    const read = lib.slice(lib.indexOf('function Read-SandboxLeaseLedger {'));
    expect(read).toMatch(/Read-SandboxLeaseLedgerEntries -Stream \$Stream \| ForEach-Object \{ \$_\.Path \}/);
  });

  it('NOTHING IS WIDENED to make this work — no new privilege, no second DACL writer', () => {
    const lib = accountLib();
    // CODE ONLY — the comments in this block discuss the P/Invoke route that was measured and
    // NOT taken, and prose about a thing is not the thing.
    const idBlock = lib
      .slice(lib.indexOf('# ---- THE FILE ID'), lib.indexOf('# ---- THE LEASE LEDGER'))
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    // The id is used to ASK WHERE THE OBJECT IS, never to write through a handle. A security
    // descriptor set on a handle would be a second DACL writer in a file whose whole doctrine
    // is one icacls call, keyed by path, read back before and after.
    expect(idBlock).not.toMatch(/SetAccessControl|SetSecurityInfo|Add-Type|OpenFileById/);
    expect(idBlock).not.toMatch(/SeBackupPrivilege|SeRestorePrivilege|AdjustTokenPrivileges/);
    // ...and it writes no DACL of its own at all: the only tools it runs are read-only queries.
    expect(idBlock).not.toMatch(/icacls|Set-Acl/);
    // Still exactly one icacls invocation in the revoke, and it is still aimed at ONE path.
    const fn = lib.slice(lib.indexOf('function Revoke-SandboxPathAces'), lib.indexOf('function Revoke-SandboxLeaseAces'));
    expect((fn.match(/icacls\.exe/g) || []).length).toBe(1);
    expect(fn).not.toMatch(/'\/T'/);
  });

  it('UNKNOWN IS NOT RESOLVED: an id that cannot be looked up keeps the lease, it does not drop it', () => {
    const lib = accountLib();
    const fn = lib.slice(lib.indexOf('function Revoke-SandboxPathAces'), lib.indexOf('function Revoke-SandboxLeaseAces'));
    // Three outcomes, and only one of them lets the ledger line go: 'gone' (the id resolves to
    // nothing, so the folder was deleted and took its ACEs along). 'unknown' is 'failed' — lock
    // kept, line kept, retried — because forgetting a leak is the one unrecoverable move.
    expect(fn).toMatch(/\$found\.Status -eq 'gone'/);
    expect(fn).toMatch(/Status = 'failed'; Message = "the recorded path is not this object any more/);
    const resolve = lib.slice(lib.indexOf('function Resolve-SandboxFileId'));
    // Fail closed on a round trip that disagrees: whatever path comes back is asked for its own
    // id, and a mismatch writes nothing.
    expect(resolve).toMatch(/Test-SandboxFileIdMatch \$back \$FileId/);
  });

  it('the operator sweep SAYS when it followed a rename, and stops crying wolf when it did not need to', () => {
    const s = sweepScript();
    expect(s).toMatch(/FOLLOWED BY FILE ID/);
    // A 'missing' with an id is PROVEN gone, so it no longer gets the ambiguous warning — that
    // one is now reserved for the id-less lines it is actually true of.
    expect(s).toMatch(/if \(\$ace\.FileId\)/);
    expect(s).toMatch(/no file id was recorded for this lease/);
  });
});

describe('the operator can actually run the sweep', () => {
  it('there is a standalone script, and a double-clickable launcher beside it', () => {
    // WHAT WAS MISSING was never the sweep — it was a way to RUN it. Its only caller was the
    // provisioner's last step, which self-elevates and re-does the pool, the group, every
    // standing grant and the credential-dir hardening. Nobody runs that to clear litter.
    expect(existsSync(join(REPO, 'setup', 'sweep-sandbox-leases.ps1'))).toBe(true);
    expect(existsSync(join(REPO, 'setup', 'sweep-sandbox-leases.cmd'))).toBe(true);
    expect(readFileSync(join(REPO, 'setup', 'sweep-sandbox-leases.cmd'), 'utf8')).toMatch(/sweep-sandbox-leases\.ps1/);
  });

  it('it adds no mechanism: it dot-sources the one library and calls the one sweep', () => {
    const s = sweepScript();
    expect(s).toMatch(/\. \(Join-Path \$PSScriptRoot 'sandbox-account\.ps1'\)/);
    expect(s).toMatch(/Clear-SandboxAbandonedLeases -LocksDir \$LocksDir/);
    // No second definition of stale, of revoked, or of what a lock is.
    expect(s).not.toMatch(/icacls/);
    expect(s).not.toMatch(/Set-Acl/);
    expect(s).not.toMatch(/Remove-Item -LiteralPath \$lock/);
  });

  it('it REPORTS what it removed, per path — "3 locks released" is not the answer to the question', () => {
    const s = sweepScript();
    expect(s).toMatch(/REVOKED/);
    expect(s).toMatch(/STILL GRANTED/);
    expect(s).toMatch(/leaked ACE\(s\) revoked/);
    // A leak it could not clear is not a successful run.
    expect(s).toMatch(/exit \(\[int\]\(\$stillThere -gt 0\)\)/);
  });

  it('-WhatIf takes each lock only to READ it, and writes no DACL at all', () => {
    const s = sweepScript();
    const whatIf = s.slice(s.indexOf('if ($WhatIf) {'), s.indexOf('# NO -TimeBudgetSeconds'));
    expect(whatIf).toMatch(/Read-SandboxLeaseLedgerEntries -Stream \$stream/);
    expect(whatIf).not.toMatch(/Revoke-/);
    expect(whatIf).not.toMatch(/Remove-Item/);
    expect(whatIf).not.toMatch(/Write-SandboxLeaseLedger/);
    // ...and it reads a LIVE lease exactly as the sweep does: the exclusive open is the test.
    expect(whatIf).toMatch(/\[System\.IO\.FileShare\]::None/);
  });

  it('it needs no elevation, and says why — that is the whole reason it is not the provisioner', () => {
    expect(sweepScript()).toMatch(/NO ELEVATION|IT NEEDS NO ELEVATION/);
    expect(sweepScript()).not.toMatch(/-Verb RunAs/);
  });
});
