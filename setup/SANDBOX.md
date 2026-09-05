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
| `-InnerBin` | required — the binary to launch as the leased account |
| `-InnerArgs` | its arguments, `ValueFromRemainingArguments` |
| `-SharePath` | optional, repeatable — extra folders to ACE alongside `TargetFolder`, granted and revoked independently. One path per invocation (see *Known gaps* 4). |
| `-SetEnv` | optional — `NAME=VALUE` entries overlaid onto a per-user environment block. Values are never logged, only names. |

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

1. **A sandboxed turn cannot use the operator's Claude subscription.** The CLI
   authenticates from `~/.claude/.credentials.json`, which the pool cannot read
   (correctly — it is the operator's credential). The documented headless
   mechanism is a token in the environment (`CLAUDE_CODE_OAUTH_TOKEN` from
   `claude setup-token`, or `ANTHROPIC_API_KEY`), which leads directly to:

2. **Nothing yet passes `-SetEnv`.** The launcher can now build a per-user
   environment block (`LogonUser` → `CreateEnvironmentBlock` → overlay →
   `CREATE_UNICODE_ENVIRONMENT`), so a per-turn credential such as
   `CLAUDE_CODE_OAUTH_TOKEN` can be injected without touching disk or a
   machine-wide variable. **`src/sandbox-cli-session.mjs` does not pass it yet**,
   so gap 1 stands until that caller is wired.

   Known sub-gap, written into the code: the token minted for the block is a
   separate logon that does not load the pool account's registry hive.
   `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` come from the token and are correct;
   `TEMP`, `TMP` and per-user `PATH` live in `HKCU\Environment` and may fall
   back to machine values. Symptom to look for: a child writing into
   `C:\Windows\Temp`. Only affects the `-SetEnv` path.

3. **Confined ccode and the sandbox do not compose — fixed, unverified live.**
   `claude-args.mjs:123` pushes `'--setting-sources', ''`, an empty-string argv
   element. The parameter that rejected it was **`Invoke-AsLeasedAccount`'s
   `-BinArgs`**, not the script's `-InnerArgs`: `Mandatory` on a `[string[]]`
   validates every *element* as non-empty, and `-InnerArgs` is
   `ValueFromRemainingArguments` without `Mandatory`, so it always bound the
   empty element fine. The live log names `BinArgs` seven times and `InnerArgs`
   never. Both now carry `[AllowEmptyString()]`; `-BinArgs` is the one that
   mattered. A skip-permissions tier was never affected, because
   `confinementFor` returns `{}` and no `--setting-sources` is emitted.

4. **Shared paths: launcher ready, caller not wired.** `-SharePath` now takes
   extra folders and gives each the same `Modify` ACE as `TargetFolder`, granted
   independently and purged in the same `finally`. **Nothing passes it yet**, so
   a being's `allowed_paths` still produce an `--add-dir` at the CLI layer and no
   ACE at the OS layer — permitted by Claude Code, denied by the kernel.

   Constraint on the eventual caller: through `powershell -File`, **one path per
   invocation**. `-SharePath A B` binds `A` and spills `B` into the next
   parameter; `-SharePath A,B` binds the single string `"A,B"` — PS 5.1 does not
   re-parse an argv element into an array. No `,`/`;` splitter was added on
   purpose: both are legal in Windows paths and a splitter would silently
   corrupt real directory names. Several paths means changing the invocation
   style, not the separator.

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

**The turn dies before the model, with no useful error** — check whether the
being is `sandboxed` at all. A ccode being cannot currently be sandboxed; see
gap 1.

**`ParameterArgumentValidationErrorEmptyStringNotAllowed`** — gap 3.

**Pool exhaustion** — sixteen accounts against `warm.max`. Orphaned leases are
reclaimed automatically now, but if the pool is genuinely full, either the warm
cap grew or sessions are not exiting.
