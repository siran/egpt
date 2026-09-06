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
| `setup/sandbox-account.Tests.ps1`, `setup/test-sandbox-logon-launcher.ps1` | Their tests. |

The launcher's parameters:

| Parameter | |
|---|---|
| `-TargetFolder` | required — the conversation folder, ACE'd for the lease |
| `-InnerBin` | required — the binary to launch as the leased account, an absolute path |
| `-InnerArgs` | required — the inner argv as **one argv element holding a JSON array**, e.g. `'["--print","--verbose",""]'` |
| `-SharePath` | optional — extra paths to ACE alongside `TargetFolder`, granted and revoked independently. **One JSON array**, any number of paths: `'["C:\\a","C:\\b"]'` |
| `-SetEnv` | optional — `NAME=VALUE` entries overlaid onto a per-user environment block, as **one JSON array**. Values are never logged, only names. |

**One argv element per parameter, and every list is a JSON array.** The launcher
parses them itself (`ConvertFrom-JsonArgv`) so that PowerShell's *parameter
binder* never sees caller-supplied data as a token. That is not stylistic — it is
the fix for three measured defects, one of which killed every sandboxed `ccode`
turn; see *Known gaps* 3. Malformed JSON throws, naming the parameter. Omitting
an optional flag and passing `'[]'` mean the same thing.

`src/sandbox-cli-session.mjs`'s `sandboxSpawn` is the only production caller and
`JSON.stringify()`s all three.

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
3. Grants the group `ReadAndExecute` on `~\.local\bin` (where `claude.exe`
   lives) and on `%APPDATA%\npm` (pi and codex are npm globals launched via
   `node.exe`, and the JS sits under the operator's profile).
4. Grants `Modify` on `~\.pi\agent` and sets `PI_CODING_AGENT_DIR` at **Machine**
   scope, because the launcher cannot pass a per-spawn environment (see
   *Known gaps*).
5. `Protect-SandboxCredDir` — breaks inheritance on `C:\ProgramData\egpt` so
   only SYSTEM, Administrators and the operator can read the credential blobs.

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
| `~\.local\bin` | Pool group, ReadAndExecute | `claude.exe` |
| `%APPDATA%\npm` | Pool group, ReadAndExecute | pi / codex entry JS |
| `~\.pi\agent` | Pool group, Modify | pi writes there; missing it wedges the turn |
| the conversation folder | leased account, Modify | granted at launch, revoked at exit |

Everything else under the operator's profile — `.claude/.credentials.json`,
`.egpt/config/config.yaml`, `src/`, `Documents` — is unreachable from a pool
account because nothing grants it. Pool profiles are likewise isolated from each
other: `C:\Users\egpt-sbx-NN` carries no pool-group or `Users` ACE, so one
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

# the operator's profile is NOT reachable  (expect: no pool group, no Users)
icacls C:\Users\$env:USERNAME\.claude
icacls C:\Users\$env:USERNAME\.egpt

# the two intended grants ARE present  (expect: egpt-sandbox-pool:(OI)(CI)(RX))
icacls C:\Users\$env:USERNAME\.local\bin
icacls $env:APPDATA\npm

# a live or leftover per-conversation grant
icacls C:\Users\$env:USERNAME\.egpt\conversations\whatsapp\<slug>
```

Reading `icacls` output: the first bracket says where the ACE came from —
`(I)` is inherited from the parent, no `(I)` means it was set directly here. The
rest is the right: `(F)` full control, `(M)` modify, `(RX)` read and execute.
`(OI)` propagates to files in the folder, `(CI)` to subfolders.

## Leases and residue

The lease is an exclusively-opened lock file under
`C:\ProgramData\egpt\sandbox-pool-locks`. The **open handle is the lease** — a
lock file that no process holds open is a crashed turn's litter and is reclaimed
in place. It is taken when the warm session spawns its CLI process and held for
that process's lifetime, not per turn.

Two kinds of residue are normal to find and worth sweeping occasionally:

- **Leftover ACEs.** The revoke is best-effort inside a `finally`, so a turn that
  dies hard leaves its `Modify` ACE on the conversation folder. Harmless, but
  they accumulate silently — check with `icacls` on the conversations tree.
- **Orphaned lock files.** Reclaimed automatically on the next lease attempt.

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

4. **Shared paths are wired end to end, and read-only ones get a *write* ACE.**
   `brainpool.mjs`'s `allowedPathsFor` is now one walk with two consumers:
   `confinementFor` (the CLI layer — `--add-dir` and read-only deny rules) and
   `sandboxSharePathsFor` (the OS layer). The second has **no
   `dangerously_skip_permissions` early return**, deliberately: under the `all`
   and `sandbox` tiers `confinementFor` returns `{}`, so the CLI layer is off and
   the ACE is the *only* way a shared folder is reachable — exactly the tiers most
   likely to declare one.

   **The caveat.** The launcher has one ACE mode, `Modify`. A path declared
   read-only in `allowed_paths` therefore gets a *write-capable* OS grant, and its
   read-only-ness remains a CLI-layer property: enforced under a confined tier
   (`readOnlyDenyRules`), enforced by nothing under a skip-permissions tier —
   which already has full filesystem access at the CLI layer regardless. Excluding
   read-only paths instead would reproduce the original defect for exactly those
   paths: permitted by Claude Code, unreadable to the kernel. A real fix means
   teaching the launcher a `ReadAndExecute` ACE mode, and nothing needs it yet.

5. **pi's tool list is not enforceable.** `access_level` overwrites
   `allowed_tools` with ccode tool names, which are not pi tool names, so
   `pi-cli-session.mjs` logs the mismatch and leaves pi's defaults — including
   `bash` — enabled. Pi's real boundary is the pool account, and that one holds.

6. **No deny on pi's `auth.json`.** Deliberate: an EPERM there wedges pi rather
   than failing it. A sandboxed turn can read whatever credentials pi stores, so
   keep cloud logins out of pi.

## Troubleshooting

**`ERROR_ACCESS_DENIED` from `CreateProcessWithLogonW`** — the pool group has
lost `ReadAndExecute` on the binary's directory. Re-run
`provision-sandbox-account.ps1`.

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
