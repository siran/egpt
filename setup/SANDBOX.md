# The OS sandbox

How a being's turn is confined by Windows itself, how to provision it, how to
check it, and what it does not cover.

This documents machinery that already exists in `setup/`. Nothing here is a
requirement for running eGPT — see `README.md`: node plus Beeper Desktop is the
baseline, and everything in this folder is optional Windows expansion.

## What it is, in one paragraph

A being's turn runs as a **different Windows account** from the operator, on its
**own desktop**, with write access to **exactly one folder** — the conversation
directory. The account is leased from a pool, its scratch profile is scrubbed
before use, and the grant is revoked when the turn's process exits. The boundary
is enforced by the kernel on every file open, so unlike `--add-dir` it does not
depend on the Claude Code CLI being correct.

```
warm session spawns
   │
   ├─ lease egpt-sbx-NN          an exclusively-opened lock file IS the lease
   ├─ read its password          DPAPI, LocalMachine scope, C:\ProgramData\egpt
   ├─ grant that SID Modify      on the conversation folder, and nothing else
   ├─ create a private desktop   ACE'd to that SID alone
   ├─ scrub the scratch profile  run as the pool account itself
   ├─ CreateProcessWithLogonW    claude.exe, stdio wired straight through
   └─ on exit: destroy desktop, revoke the ACE, release the lease
```

## The parts

| File | Does |
|---|---|
| `setup/sandbox-account.ps1` | The pool: account creation, the group, DPAPI credential storage, the grant helpers. Dot-sourced, never run directly. |
| `setup/provision-sandbox-account.ps1` | **The operator entry point.** Self-elevates via UAC, dot-sources the above, provisions everything. Idempotent. |
| `setup/sandbox-logon-launcher.ps1` | The per-session launcher. Leases, ACLs, scrubs, launches, cleans up. Invoked by the daemon, not by hand. |
| `src/sandbox-cli-session.mjs` | Wraps the warm CLI session so its `spawn` goes through the launcher. |
| `setup/sandbox-account.Tests.ps1`, `setup/sandbox-logon-launcher.Tests.ps1`, `setup/test-sandbox-logon-launcher.ps1` | Their tests. |

The launcher's parameters:

| Parameter | |
|---|---|
| `-TargetFolder` | required — the conversation folder, ACE'd for the lease |
| `-InnerBin` | required — the binary to launch as the leased account, an absolute path |
| `-InnerArgs` | required — the inner argv as **one argv element holding a JSON array**, e.g. `'["--print","--verbose",""]'` |
| `-SharePath` | optional — extra paths to ACE **Modify** alongside `TargetFolder`, granted and revoked independently. **One JSON array**, any number of paths: `'["C:\\a","C:\\b"]'` |
| `-SharePathReadOnly` | optional — the same, but each entry gets a **ReadAndExecute** ACE. Same JSON-array shape, same parser, same ledger and revoke. Omitted = no entries, so a caller that passes only `-SharePath` behaves exactly as before. |
| `-SetEnv` | optional — `NAME=VALUE` entries overlaid onto a per-user environment block, as **one JSON array**. Values are never logged, only names. |

**One argv element per parameter, and every list is a JSON array.** The launcher
parses them itself (`ConvertFrom-JsonArgv`) so that PowerShell's *parameter
binder* never sees caller-supplied data as a token. That is not stylistic — it is
the fix for three measured defects, one of which killed every sandboxed `ccode`
turn; see *Known gaps* 3. Malformed JSON throws, naming the parameter. Omitting
an optional flag and passing `'[]'` mean the same thing.

`src/sandbox-cli-session.mjs`'s `sandboxSpawn` is the only production caller and
`JSON.stringify()`s every one of them.

**A PowerShell caller cannot do this** (measured, PS 5.1): passing a JSON string
to a native exe strips every quote; `\"`-escaping keeps the quotes but splits the
argument at its first space; `""`-doubling survives spaces but breaks on a quote
inside a value. PS 5.1 re-tokenizes native arguments and has no
`$PSNativeCommandArgumentPassing` (PS 7.3+). Node's `child_process.spawn` builds
the command line itself, one argv element per array slot — which is why
`setup/test-sandbox-logon-launcher.ps1` spawns the launcher *through node*.

Constants live at the top of `sandbox-account.ps1`:

```powershell
$SandboxPoolSize   = 16              # headroom over config.yaml's warm.max
$SandboxPoolPrefix = 'egpt-sbx-'     # egpt-sbx-00 .. egpt-sbx-15
$SandboxPoolGroup  = 'egpt-sandbox-pool'
$CredDir           = "$env:ProgramData\egpt"
```

## Provisioning

Once per machine. Needs a local Administrator; the script self-elevates, so run
it from an ordinary shell:

```powershell
powershell -ExecutionPolicy Bypass -File setup\provision-sandbox-account.ps1
```

It is idempotent — re-run it after installing pi, after an npm global changes,
or if you are unsure. What it does:

1. `Ensure-SandboxPool` — creates `egpt-sbx-00` … `egpt-sbx-15` with 32 random
   bytes each, stores them DPAPI-protected at **LocalMachine** scope under
   `C:\ProgramData\egpt`.
2. `Ensure-SandboxPoolGroup` — creates `egpt-sandbox-pool` and puts all of them
   in it. One group means one grant instead of sixteen.
3. `Grant-SandboxPoolAce -Grant 'Traverse'` on the **ancestor chain** — `~`,
   `~\.egpt`, `~\.egpt\conversations`, `~\.egpt\conversations\whatsapp` and
   `~\src`, each skipped if absent. Traverse only. See *The ACL model*.
4. `-Grant 'Read'` on the standing read-only list — `~\.local\bin` (where
   `claude.exe` lives), `~\bin\egpt` (the running tree), `~\src` (the whole
   read-only view the pool profiles' `src` and `my-code` junctions point at) and
   `%APPDATA%\npm` (pi and codex are npm globals launched via `node.exe`, and
   the JS sits under the operator's profile). Each skipped if absent.
5. `-Grant 'Modify'` on `~\.pi\agent`, and sets `PI_CODING_AGENT_DIR` at
   **Machine** scope, because the launcher cannot pass a per-spawn environment
   (see *Known gaps*).
6. `Protect-SandboxCredDir` — breaks inheritance on `C:\ProgramData\egpt` so
   only SYSTEM, Administrators and the operator can read the credential blobs.
7. `Clear-SandboxAbandonedLeases` — the repair path for lease ACEs a hard-killed
   turn left behind. See *The ACL model*.

Steps 3–5 write nothing when the ACE is already right, so a re-provision of a
healthy node is seconds and prints `already granted` per path.

**Why LocalMachine DPAPI scope.** CurrentUser ciphertext is decryptable only by
the logon session that wrote it, which broke the moment the daemon started
running from a non-interactive logon. LocalMachine decrypts from any session on
this box, and is still not portable off it.

**Why `CreateProcessWithLogonW`.** `CreateProcessAsUser` needs
`SeAssignPrimaryTokenPrivilege`, which Administrators do not hold;
`CreateProcessWithTokenW` needs `SeImpersonatePrivilege`, which UAC filtering
strips. `CreateProcessWithLogonW` needs no privilege in the caller at all —
which is why the password is stored rather than a token being minted, and why
the daemon can stay unelevated.

**Why a pool rather than a fresh logon each time.** Windows mints a unique logon
SID per `LogonUser` call, but on this machine that SID never surfaces in the
resulting token's groups — so there is no per-call SID to write an ACE against.
Fixed accounts are what make the per-conversation ACE possible.

## The ACL model

The important thing to understand, because it is the opposite of what a
deny-list intuition suggests:

**A Windows user profile already denies everyone else by default.** `C:\Users\an`
grants SYSTEM, Administrators and `an` — and nothing to `Users`, `Authenticated
Users` or `Everyone`. So a pool account cannot read the operator's profile at
all, including `.claude` and `.egpt`, without an explicit grant.

Access is therefore **opt-in and narrow**, and the whole list is:

| Path | Grant | Why |
|---|---|---|
| `~` | Pool group, **traverse only** — `(X,RA,RC)`, not inherited | the ancestor chain above a conversation folder; see below |
| `~\.egpt` | Pool group, traverse only | same chain |
| `~\.egpt\conversations` | Pool group, traverse only | same chain |
| `~\.egpt\conversations\whatsapp` | Pool group, traverse only | same chain |
| `~\src` | Pool group, traverse only | same chain; skipped where absent |
| `~\src` | Pool group, **ReadAndExecute**, inherited | the operator's whole source tree, read-only, **standing**. Every pool profile carries a `src` directory junction pointing here and a `my-code` one pointing at `~\src\egpt` (both planted by the launcher's scrub pass, from one generator — `Get-SandboxProfileJunctionStatement`), and a junction is only a name: what may be done through it is decided by the DACL of the target. `my-code` is *under* `src`, so this one inherited grant covers both and there is no second grant to write. Operator 2026-09-20, asked for explicitly: *"can we make that sandbox account's sbx/src/ path points to src/an read-only?"* and *"it is actually interesting to have a my-code/ pointing to src/egpt"*. Permanent, not per-turn, and that is a decision — see below. |
| `~\.local\bin` | Pool group, ReadAndExecute | `claude.exe` |
| `%APPDATA%\npm` | Pool group, ReadAndExecute | pi / codex entry JS |
| `~\.pi\agent` | Pool group, Modify | pi writes there; missing it wedges the turn |
| `~\bin\egpt` | Pool group, ReadAndExecute | the RUNNING tree. Was Modify (operator 2026-09-10, *"let E modify itself"*); reversed 2026-09-13 — it executes **as the operator**, so a standing group write there is code outside the sandbox at the next restart. Permanent, not per-turn. See *Known gaps* 7. |
| the conversation folder | leased account, Modify | granted at launch, revoked at exit |
| each `-SharePath` | leased account, Modify | a being's full-access `allowed_paths`, plus its thread's CLI store; granted at launch, revoked at exit |
| each `-SharePathReadOnly` | leased account, ReadAndExecute | a being's read-only `allowed_paths`; granted at launch, revoked at exit — **unless the pool group can already read that path**, inherited or explicit, in which case nothing is granted and the launcher logs the skip (`Test-SandboxPoolReadCovered`). Since `~\src` carries the standing group read, most read-only shares now fall under it: the per-account ACE would grant what the being already has and leave one more thing for a hard kill to leak. Writable shares are never skipped. |

**Two kinds of ACE live on `~\src`, and telling them apart is the whole skill of
reading an `icacls` dump of that tree.** An ACE naming the **group**
(`egpt-sandbox-pool`) is one of the standing grants in the table above — it is
meant to be there. An ACE naming an **individual** `egpt-sbx-NN` is a *lease*
ACE, granted at launch from some being's `allowed_paths` and supposed to be
revoked at exit; one still standing is litter. Twelve of them were found on
`~\src\egpt` on 2026-09-20, one per pool account — see *Leases and residue*.

**Why the `~\src` read grant is standing rather than per-turn.** The `src`
junction is part of the *shape* of a pool profile: it is there between turns as
well as during them. A link that only resolved while a lease was held would be
exactly the failure the per-turn share ACEs exist to close — a directory the
being is told it may use and that then refuses it. The cost is stated rather
than hidden: all sixteen pool accounts can read all of the operator's source, at
all times. That was the ask.

**The traverse chain, and why it is its own kind of grant.** A per-turn ACE on a
conversation folder is *useless on its own* — but not for the reason it looks
like. This document said the pool's logon tokens lack "bypass traverse checking";
that was wrong, and it was settled by measurement on 2026-09-13, run as a real
pool account against a purpose-built tree.

The token **does** hold `SeChangeNotifyPrivilege`, Enabled, and it works: reading
a leaf file through two ACE-free ancestors succeeds. What the privilege does not
give is the right to **open an ancestor directory as an object in its own
right**. On an ungranted ancestor every raw `CreateFileW` failed `win32=5` —
`FILE_TRAVERSE`, `READ_CONTROL`, `FILE_READ_ATTRIBUTES`, and even a zero-access
query-only open.

That is precisely what Node does, and Claude Code is Node. On the same tree:

| call | ungranted ancestor in the way | why |
|---|---|---|
| `readFileSync` on the leaf | **OK** | implicit walk; the privilege covers it |
| `lstatSync` on the ancestor | `EPERM` | explicit open of the directory |
| `realpathSync` on the leaf | `EPERM` | walks components, and names the *ancestor* it tripped on |
| `realpathSync.native` on the leaf | **OK** | resolves via a handle on the target |

So the two symptoms were one bug: a being could not read an image inside its own
conversation folder for two days (Claude Code reported it as its symlink
resolution changing after the permission check), and a being could not write a
shared path it plainly held an ACE on. Granting `(X,RA,RC)` on the ancestors
flipped exactly those calls and nothing else — `opendirSync` on the ancestor
still `EPERM`s, because `RD` is still withheld.

`(X,RA,RC)` is traverse + read-attributes + read-permissions, and the important
part is what is **missing**: `RD`, list-directory. A pool account can walk
*through* the operator's home to a folder it was granted **by name**, and still
cannot enumerate the home, or `.egpt`, or the names of other conversations. The
ACEs are also **not inheritable** — each directory of the chain is granted on
its own, because an `(OI)(CI)` ACE here would hand traverse to everything below
the profile.

Recorded as an inference and not a measurement: the load-bearing bit in that mask
is probably `RA`, not `X` — `X` duplicates what the privilege already gives, and
`RA` is what the privilege withholds. `RA` was never isolated from `X`, so the
mask stays `(X,RA,RC)` rather than being pruned on a guess.

**One grant function, one ACL tool.** Every grant in the sandbox goes through
`Grant-SandboxPoolAce -Path <p> -Grant Traverse|Read|Modify [-Sid <s>]`; the three
masks and their inheritance flags are a table at the top of that function and are
spelled nowhere else. The provisioner's standing grants go to the pool group (the
default); the launcher's two per-lease grants pass the leased account's own `-Sid`
— same table, same check, same tool (operator 2026-09-20, told the launcher still
used `Set-Acl`: *"i think we can use always the fast way"*). A path that is a
single **file** takes the same mask without `(OI)(CI)`, derived in the helper:
`icacls` accepts those flags on a leaf, exits 0 and writes **nothing**.
It writes with **`icacls`, not `Set-Acl`** — `Set-Acl` persists the
SACL (the `PrivilegeNotHeldException` documented on `Protect-SandboxCredDir`) and
against `C:\Users\an` it *hung* twice and had to be killed. Plain `/grant`, never
`/grant:r`, so a grant is additive: it never narrows an existing ACE, and
narrowing one stays a hand operation.

**A grant is a fact to converge on, not a command to re-issue.**
`Grant-SandboxPoolAce` reads the DACL first and writes only when the ACE it wants
is missing or wrong — wrong meaning different inheritance flags, or rights that
do not cover what the grant asks for. A broader ACE with the same flags already
satisfies it (Allow ACEs union, and plain `/grant` could not narrow it anyway).
Explicit ACEs only: an inherited one is a fact about a parent, and the fact this
converges on is an ACE on the object itself. So on an already-provisioned node
the provisioner writes nothing and prints `already granted` per path, and a turn
whose share ACE survived from an earlier lease costs the tree no re-propagation
either. That is the
difference between a re-provision measured in seconds and one measured in
minutes: on 2026-09-20 all five ancestors and `~\src` were already correct and
were rewritten anyway.

The `~\src` **ReadAndExecute** grant is still the slowest thing the provisioner
does on a node that does not have it yet — measured by hand on reve 2026-09-20 at
**307 s** for one pass, because the cost is inheritance re-propagation over a
tree full of `node_modules` and not the API that writes the ACE. The provisioner
announces that cost before it starts and prints its elapsed seconds after. If a
run sits on `~\src` for much more than ten minutes, kill it, grant it by hand and
re-run — everything else in that script is idempotent:

```powershell
icacls "$env:USERPROFILE\src" /grant egpt-sandbox-pool:"(OI)(CI)(RX)"
```

**The provisioner will look hung on `~` and `~\src`, and is not.** Writing any
DACL on a container makes Windows re-run inheritance propagation over the entire
subtree to recompute what the children inherit — even here, where the ACE is not
inheritable and there is no `/T`. `~\src` measured about five minutes on reve
(2026-09-13); it is full of `node_modules`. The cost is paid again on every
re-provision, because the ACE is rewritten even when it is already identical.

Everything else under the operator's profile — `.claude/.credentials.json`,
`.egpt/config/config.yaml`, `Documents`, and the *contents* of every directory
in the chain above — is unreachable from a pool account because nothing grants
it. Pool profiles are likewise isolated from each other:
`C:\Users\egpt-sbx-NN` carries no pool-group or `Users` ACE, so one
conversation's residue is not readable by another's.

**There is no deny-list, and that is deliberate.** A pool account can read
`C:\Windows`, `C:\Program Files` and most of `C:\ProgramData`, because it is an
`Authenticated User` and therefore a member of `BUILTIN\Users`. That is fine:
those hold installed software, not secrets, and the account needs them to run
anything at all. Denying them would break the sandbox without protecting
anything — the same bits ship with the OS. `C:\ProgramData\egpt` is the one part
of `ProgramData` that matters, and step 5 above closes it explicitly.

Note that Windows evaluates **Deny before Allow**, so "deny the drive, allow one
folder" cannot work — the deny wins on the allowed child too. If a deny is ever
needed, it must name the specific subtree.

## Checking it

All read-only.

```powershell
# the pool exists and is enabled
Get-LocalUser egpt-sbx-* | Select-Object Name,Enabled
Get-LocalGroupMember egpt-sandbox-pool | Select-Object Name

# the credential store is closed to everyone else
icacls C:\ProgramData\egpt

# the operator's profile is not READABLE  (expect: no Users; no pool group at
# all on .claude, and on .egpt only the traverse ACE below — never (RX), never
# (M), never (OI)/(CI))
icacls C:\Users\$env:USERNAME\.claude
icacls C:\Users\$env:USERNAME\.egpt

# the traverse chain  (expect on each: egpt-sandbox-pool:(Rc,X,RA), no (OI)(CI).
# An extra S -- (Rc,S,X,RA) -- is the same grant: SYNCHRONIZE, which .NET adds to
# every rule it writes, so paths granted by hand before the provisioner carried
# this carry it and paths icacls granted do not. Neither bit is list.)
icacls C:\Users\$env:USERNAME
icacls C:\Users\$env:USERNAME\.egpt
icacls C:\Users\$env:USERNAME\.egpt\conversations
icacls C:\Users\$env:USERNAME\.egpt\conversations\whatsapp
icacls C:\Users\$env:USERNAME\src

# the read-and-execute grants ARE present  (expect: egpt-sandbox-pool:(OI)(CI)(RX))
icacls C:\Users\$env:USERNAME\.local\bin
icacls $env:APPDATA\npm
icacls C:\Users\$env:USERNAME\bin\egpt
icacls C:\Users\$env:USERNAME\src          # ...alongside the (Rc,X,RA) traverse ACE

# every pool profile has src and my-code junctions pointing at it  (expect:
# <SYMLINKD>-style junction rows; a profile that has not run a turn since
# 2026-09-20 has neither yet)
Get-ChildItem C:\Users\egpt-sbx-* -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -in 'src', 'my-code' } | Select-Object FullName, Target

# a live or leftover per-conversation grant
icacls C:\Users\$env:USERNAME\.egpt\conversations\whatsapp\<slug>
```

Reading `icacls` output: the first bracket says where the ACE came from —
`(I)` is inherited from the parent, no `(I)` means it was set directly here. The
rest is the right: `(F)` full control, `(M)` modify, `(RX)` read and execute.
`(OI)` propagates to files in the folder, `(CI)` to subfolders.

`(Rc,X,RA)` is the traverse grant, and it is easy to misread as a small `(RX)`.
It is not: `(RX)` includes `RD`, the list bit, and `(Rc,X,RA)` deliberately does
not. Walk through versus read the contents is the whole difference.

## Leases and residue

The lease is an exclusively-opened lock file under
`C:\ProgramData\egpt\sandbox-pool-locks`. The **open handle is the lease** — a
lock file that no process holds open is a crashed turn's litter and is reclaimed
in place. It is taken when the warm session spawns its CLI process and held for
that process's lifetime, not per turn.

**The hard-kill path is the NORMAL path, not the exceptional one.** The launcher
revokes its ACEs in a `finally`, and that `finally` does not run at the ordinary
end of a sandboxed session: `warm-cli-session.mjs`'s `close()` ends the CLI
process with `proc.kill()`, which on Windows is `TerminateProcess` whatever the
signal, and a PowerShell `finally` does not survive it. So the **reclaim** —
taking a lock file no process holds, and revoking whatever its ledger names — is
what actually does the cleaning.

The reclaim is keyed to one account and fires when **that account is leased
again**. An account nothing leases again keeps its ACEs indefinitely, and a path
that many conversations share collects one per pool account that ever ran. That
is how `~\src\egpt` came to carry twelve standing `(OI)(CI)(RX)` ACEs
(2026-09-20), one per pool account, while `~\Documents` and `~\bin\egpt` carried
none.

Two kinds of residue are therefore normal to find:

- **Leftover ACEs.** Cleared for the whole pool by re-running the provisioner,
  which sweeps every lock nothing holds (`Clear-SandboxAbandonedLeases`). It
  reads each dead lease's own ledger, so it revokes exactly what was granted and
  never goes hunting through the filesystem; a lock a running turn still holds
  is left alone. It groups the dead leases **by path** and takes every account
  off one path in a single `icacls /remove:g a b c … /C` pass, because the cost
  of a revoke is the tree, not the ACE — twelve accounts off `~\src\egpt`
  measured **2 s** that way against minutes for twelve separate `Set-Acl`
  passes. **A revoke of an ACE that is already gone is success:** the DACL is
  read first, an account that carries none is reconciled to *clean* without a
  single write, and the lock is released. Only an ACE still standing afterwards
  is a failure — that path stays on the ledger and the lock file stays in place,
  so the next reclaim retries instead of forgetting. That holds on the
  launcher's clean release path too, which used to delete the lock (and its
  ledger) regardless.
- **Orphaned lock files.** Reclaimed automatically on the next lease attempt, or
  by the provisioner sweep above.

```powershell
# the sweep, and everything else the provisioner does — idempotent, UAC prompt
powershell -ExecutionPolicy Bypass -File setup\provision-sandbox-account.ps1

# what is left afterwards: group ACEs are meant to be there, egpt-sbx-NN ones are not
icacls C:\Users\$env:USERNAME\src\egpt | Select-String 'egpt-sbx-'
```

## Known gaps

Real, current, and worth knowing before relying on any of this.

1. **A sandboxed turn needs `sandbox_oauth_token` set, or it has no credential.**
   The CLI authenticates from `~/.claude/.credentials.json`, which the pool cannot
   read (correctly — it is the operator's credential). The headless mechanism is a
   token in the environment (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`,
   or `ANTHROPIC_API_KEY`), and that path **is wired now**: `config.yaml`'s
   `sandbox_oauth_token` → `brainpool.mjs` (sandboxed turns only) →
   `sandbox-cli-session.mjs` → the launcher's `-SetEnv`. With the key unset a
   sandboxed ccode turn reaches the CLI and dies at
   `Not logged in · Please run /login` — which is this gap, not a launcher fault.

2. **`-SetEnv` and the environment block.** The launcher builds a per-user
   environment block (`LogonUser` → `CreateEnvironmentBlock` → overlay →
   `CREATE_UNICODE_ENVIRONMENT`), so a per-turn credential such as
   `CLAUDE_CODE_OAUTH_TOKEN` is injected without touching disk or a machine-wide
   variable. Values are never logged, only names.

   **The block is rebased on the account's own profile** — fixed 2026-09-05
   after the first smoke test caught it corrupting the environment. Worth
   knowing, because the failure was silent:

   | with `-SetEnv`, before the fix | after |
   |---|---|
   | `USERPROFILE=C:\Users\Default` | `C:\Users\egpt-sbx-NN` |
   | `TEMP`/`TMP`=`C:\WINDOWS\TEMP` | under the account's own profile |
   | `APPDATA`/`LOCALAPPDATA` empty | the account's own |

   Cause: `CreateProcessWithLogonW` with `LOGON_WITH_PROFILE` loads the hive and
   derives these itself — but only while `lpEnvironment` is NULL. Supply a block
   and the block wins, and ours came from a *separate* `LogonUser` token whose
   hive is not loaded, so `CreateEnvironmentBlock` fell back to the Default
   profile. A `claude` launched that way looked for `~/.claude` under
   `C:\Users\Default`.

   The fix overlays `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`,
   `HOMEDRIVE`, `HOMEPATH`, `USERNAME`, `USERDOMAIN` onto the block, derived from
   the profile path `Get-SandboxProfilePath` resolves — the same guarded
   `Win32_UserProfile` lookup the scrub uses, now shared rather than copied.
   **Not** `LoadUserProfile`: that needs `SE_RESTORE_NAME`/`SE_BACKUP_NAME`, and
   this launcher's premise is that it needs no privilege at all. That premise was
   confirmed the same day — with those two privileges stripped from the caller's
   token the defect appears, which is what identified hive loading as the
   privileged step.

   An account with no profile yet now **fails loudly** on a `-SetEnv` turn rather
   than silently shipping the Default block. One non-`-SetEnv` turn creates the
   profile and fixes it permanently.

   Note `HOMEPATH` deliberately differs from the no-block path: without a block
   the child gets the *cwd*, with the rebase it gets `\Users\egpt-sbx-NN`,
   consistent with `USERPROFILE`. The new value is the correct one.

3. **The argument contract — three defects, one root cause. Fixed and verified
   live, 2026-09-05.** Caller-supplied data used to reach PowerShell's *parameter
   binder*, which then interpreted it. All three were measured, not inferred:

   | what the caller sent | what the launcher received |
   |---|---|
   | the inner argv's own `--verbose` | eaten — prefix-matched `[CmdletBinding()]`'s common `-Verbose` switch. 7 args sent, `(+6 args)` logged, and `claude` died with *When using --print, --output-format=stream-json requires --verbose* |
   | `-SharePath A B` | `SharePath=['A']`, and `B` silently spilled into `InnerArgs` |
   | `-SharePath A,B` | the one literal string `'A,B'` — PS 5.1 never re-parses an argv element into an array |
   | `-SharePath A -SharePath B` | hard error, `ParameterAlreadyBound` |
   | `--setting-sources ''` | rejected outright: `Mandatory` on a `[string[]]` validates every *element* as non-empty |

   **This is very likely the undiagnosed outage** `~/.egpt/config/config.yaml`
   records against the `egpt` being — *"don ran OS-sandboxed and every turn died
   before the model"* — and the reason the handoffs concluded *"a ccode being
   cannot be sandboxed"*. It was not the sandbox. It was one missing flag.

   The fix is the one fix for all three: **each caller-supplied list is exactly
   one argv element holding a JSON array**, which the launcher parses itself. The
   binder now sees a flag name and one opaque string. `-Command` was rejected as
   an alternative — it *adds* a PowerShell re-parse (a quoting bug there is code
   execution, not a corrupted argv) and would not have fixed the `--verbose` case
   anyway, since the script still binds parameters.

   `PositionalBinding = $false` is kept but now guards something smaller: a stray
   token has nowhere to be swept, so it becomes a loud *"A positional parameter
   cannot be found"* instead of a silent bind by position. `[AllowEmptyString()]`
   was **removed** from the script's own parameters (dead — the empty element
   lives inside the JSON now) and **kept** on `Invoke-AsLeasedAccount`'s
   `-BinArgs`, `New-SandboxEnvironmentBlock`'s `-SetEnv` and `Set-EnvBlockEntry`'s
   `-Value`, which receive the *parsed* arrays and are `Mandatory`.

   Verified live: `claude.exe` launched with the real 15-element confined argv
   logs `(+15 args)`, reaches `{"type":"system","subtype":"init"}` with
   `"permissionMode":"default"` and `"mcp_servers":[]` (the empty
   `--setting-sources` value did its job), and fails only on authentication —
   which is gap 1's territory, well past the model gate.

4. **Shared paths are wired end to end, in two classes.** `brainpool.mjs`'s
   `allowedPathsFor` is one walk with two consumers: `confinementFor` (the CLI
   layer — `--add-dir` and read-only deny rules) and `sandboxSharePathsFor` (the
   OS layer). The second has **no `dangerously_skip_permissions` early return**,
   deliberately: under the `all` and `sandbox` tiers `confinementFor` returns
   `{}`, so the CLI layer is off and the ACE is the *only* way a shared folder is
   reachable — exactly the tiers most likely to declare one.

   **Read-only is real at the OS layer since 2026-09-13.** It was not before:
   `sandboxSharePathsFor` concatenated the two classes and the launcher had one
   ACE mode, `Modify`, so a path declared read-only got a *write-capable* OS
   grant. With `Bash`/`PowerShell` in a being's tool list that was a shell command
   away from writing past `readOnlyDenyRules`, and under a skip-permissions tier
   nothing enforced it anywhere. Now the two classes stay two lists all the way
   down — `-SharePath` (Modify) and `-SharePathReadOnly` (ReadAndExecute) — and
   both ride the same lease ledger, so a read-only ACE is revoked by the turn's
   `finally` or by the next reclaim, exactly like a writable one.

   **What is still not covered:** an *explicit deny*. A `ReadAndExecute` ACE grants
   no write, but it does not subtract write granted by some *other* applicable ACE
   on the same path — see gap 7.

5. **pi's tool list is not enforceable.** `access_level` overwrites
   `allowed_tools` with ccode tool names, which are not pi tool names, so
   `pi-cli-session.mjs` logs the mismatch and leaves pi's defaults — including
   `bash` — enabled. Pi's real boundary is the pool account, and that one holds.

6. **No deny on pi's `auth.json`.** Deliberate: an EPERM there wedges pi rather
   than failing it. A sandboxed turn can read whatever credentials pi stores, so
   keep cloud logins out of pi.

7. **A read-only share path cannot subtract a standing grant.**
   `-SharePathReadOnly` adds a `ReadAndExecute` ACE; Windows *unions* every
   applicable Allow ACE, so it cannot take away write that some other ACE
   already gives. The case this was written about was `~/bin/egpt`, which the
   pool **group** held `Modify` on — operator ruling 2026-09-10, *"let E modify
   itself"*.

   **That ruling was reversed on 2026-09-13** and the provisioner now grants
   `ReadAndExecute` there (`-Grant 'Read'`), because `~/bin/egpt` is
   executed **as the operator**: a standing group write ACE let any of the 16
   pool accounts place code that runs outside the sandbox at the next restart. A
   being that must change its own code is pointed at the editable checkout
   per-turn instead, through `allowed_paths` → `-SharePath`.

   **The general shape of the gap stands**, and so does its operational tail:
   these helpers are **additive and never remove**, so changing the provisioner
   stops a re-provision from re-granting `Modify` but does not revoke one an
   earlier run already wrote. A node provisioned before 2026-09-13 still has it
   until someone runs
   `icacls "%USERPROFILE%\bin\egpt" /remove:g egpt-sandbox-pool` and
   re-provisions. Same rule for any future standing grant: a per-turn read-only
   ACE will not narrow it.

## Troubleshooting

**`ERROR_ACCESS_DENIED` from `CreateProcessWithLogonW`** — the pool group has
lost `ReadAndExecute` on the binary's directory. Re-run
`provision-sandbox-account.ps1`.

**`Win32 error 267` from `CreateProcessWithLogonW`** — `ERROR_DIRECTORY`: the
`lpCurrentDirectory` handed to the call is not reachable **by the target
user**, i.e. the conversation folder carries no ACE for the leased account.
Measured on kg 2026-09-23, where the folder held Modify for three *other* pool
accounts and nothing for the one that was running. The cause is that a grant
can silently not land — `icacls` accepts some specs, exits 0, prints success
and writes no ACE — and nothing read the DACL back. It cannot reach a launch
any more: the launcher now re-reads the DACL right after the grant and again
immediately before the launch (`Assert-SandboxPathReachable`), and a turn whose
folder the leased account cannot reach ends there with `REFUSING at step (d)…`
or `REFUSING at step (f)…`, naming the account, the folder and what was
expected. That message means the sandbox could not be established — it is never
a reason to widen a grant. Check the folder's DACL, then re-run
`provision-sandbox-account.ps1` if the *ancestor* traverse chain is what is
missing.

**`Model "..." not found` from pi** — `PI_CODING_AGENT_DIR` is unset at Machine
scope, so pi resolved its config against `C:\Users\egpt-sbx-NN` instead. Re-run
the provisioner.

**The turn dies before the model, with no useful error** — until 2026-09-05 this
was almost certainly the launcher eating `--verbose`; see gap 3. If it still
happens, check whether the being is `sandboxed` at all, and whether
`sandbox_oauth_token` is set (gap 1).

**`Error: When using --print, --output-format=stream-json requires --verbose`** —
gap 3. The flag was in the argv the caller built and never reached `claude`.

**`A positional parameter cannot be found that accepts argument ...` from the
launcher** — something was passed to `sandbox-logon-launcher.ps1` as a bare token.
Every list is one `-Flag '<json array>'` pair now; nothing is positional and
nothing is swept up as remaining arguments. That message is the guard working.

**`sandbox-logon-launcher: -InnerArgs is not valid JSON`** (or `must be a JSON
ARRAY of strings`) — the caller did not `JSON.stringify()` the list, or a
PowerShell caller passed it as a native argument. See the caller note under *The
parts*: PS 5.1 cannot pass a JSON string to an exe intact.

**`ParameterArgumentValidationErrorEmptyStringNotAllowed`** — gap 3.

**Pool exhaustion** — sixteen accounts against `warm.max`. Orphaned leases are
reclaimed automatically now, but if the pool is genuinely full, either the warm
cap grew or sessions are not exiting.
