# sandbox-account.ps1  - one-time idempotent provisioning of the POOL of
# disposable unprivileged local accounts (egpt-sbx-00..NN) used by
# sandbox-logon-launcher.ps1's per-turn leasing flow. New-LocalUser/
# Set-LocalUser require local-Administrator rights. Dot-sourced by
# sandbox-logon-launcher.ps1 and by provision-sandbox-account.ps1 (which
# self-elevates before dot-sourcing this).

# Pool size: headroom over config.yaml's warm.max: 10 concurrent sessions.
$SandboxPoolSize = 16
$SandboxPoolPrefix = 'egpt-sbx-'
# One local group all pool accounts belong to (operator 2026-08-21): the CLI
# binaries a sandboxed turn launches (e.g. claude.exe under the operator's own
# profile, ~/.local/bin) are NOT readable by an arbitrary low-privilege
# account by default -- CreateProcessWithLogonW fails with ERROR_ACCESS_DENIED
# otherwise. Granting ReadAndExecute to this ONE group, once, is simpler than
# granting each of the 16 pool accounts individually.
$SandboxPoolGroup = 'egpt-sandbox-pool'
# Credentials are protected with DPAPI at LocalMachine scope (see
# Protect-/Unprotect-SandboxCredentialBytes below), not the CurrentUser scope
# Export-Clixml would give a SecureString  - CurrentUser-scope ciphertext is
# only decryptable by the exact logon session that encrypted it, which broke
# once the daemon started running from non-interactive/Session-0 logons
# (operator 2026-08-30). LocalMachine scope decrypts from any logon session on
# THIS machine; it is still not portable off the box.
$CredDir = Join-Path $env:ProgramData 'egpt'

# Every diagnostic goes to STDERR ONLY. The inner process's stdout is wired
# straight through to THIS script's own stdout handle (step f)  - anything
# this script itself wrote to stdout would land in the same pipe Node is
# parsing as claude's stream-json output and could corrupt it.
function Log([string]$msg) { [Console]::Error.WriteLine("sandbox-logon-launcher: $msg") }

function New-RandomPassword {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  # base64 already mixes upper/lower/digits/symbols (+, /, =); append a fixed
  # symbol+digit+letter run so complexity policy is satisfied even if the
  # random draw happens to omit a category.
  return ([Convert]::ToBase64String($bytes) + '!Aa1')
}

# Single source of truth for the pool account names  - both the provisioner
# and the launcher call this, never hardcode the list twice.
function Get-SandboxPoolAccountNames {
  0..($SandboxPoolSize - 1) | ForEach-Object { "{0}{1:D2}" -f $SandboxPoolPrefix, $_ }
}

# The pool account a given conversation PREFERS  - a stable index derived from
# that conversation's own folder, so the same conversation leases the same
# account every time (operator ruling 2026-09-06). The launcher tries this name
# FIRST and falls back to any other free one; see its leasing block. This
# function only NAMES a preference - it takes no lock and makes no promise that
# the account is free.
#
# WHY STICKINESS IS WANTED: per-conversation browser state. Chrome seals its
# cookie master key with DPAPI bound to the WINDOWS ACCOUNT that wrote it
# (verified 2026-09-06 on the live profile: Local State's os_crypt.encrypted_key
# is a 293-byte DPAPI blob, and ProtectedData.Unprotect at CurrentUser scope
# succeeds only as the account that wrote it). A profile written by egpt-sbx-04
# is undecryptable by egpt-sbx-11, so a conversation that lands on a different
# account each time is silently logged out of everything.
#
# THE FOLDER IS THE KEY because it is the only conversation-stable thing the
# launcher is handed: -TargetFolder is the conversation's own directory and the
# one path the per-turn ACE is granted on. (-SharePath is the BEING's
# allowed_paths, shared by every conversation of that being, so it identifies
# the wrong thing.) Normalised first  - full path, no trailing separator,
# lowercased  - so C:/x/y/, C:\X\Y and C:\x\z\..\y cannot map to three
# different accounts.
#
# SHA256, NOT [string]::GetHashCode(): .NET's string hash is explicitly not
# stable across processes (randomized string hashing is a switch in .NET
# Framework and is always on in .NET Core), and "the same account next time"
# is precisely a cross-process contract.
function Get-SandboxPoolAccountForFolder {
  param([Parameter(Mandatory = $true)][string]$Folder)
  $names = @(Get-SandboxPoolAccountNames)
  $key = [System.IO.Path]::GetFullPath($Folder).TrimEnd('\').ToLowerInvariant()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key))
  } finally {
    $sha.Dispose()
  }
  # [int64] of the UNSIGNED first four bytes: PowerShell's % on a negative left
  # operand yields a negative remainder, which would be an out-of-range index.
  $index = [int]([int64][System.BitConverter]::ToUInt32($digest, 0) % $names.Count)
  return $names[$index]
}

# The ORDER the launcher walks the pool in for one conversation: its preferred
# account first, then EVERY other account, shuffled. Nothing here leases
# anything - the launcher's leasing block does that, unchanged, one name at a
# time down this list.
#
# THE TAIL IS THE SAFETY PROPERTY, and the reason this returns the WHOLE pool
# rather than just the preference: stickiness must never become starvation. If
# the preferred account is held - by a concurrent turn, or by a lease that is
# simply stuck - the conversation walks on and runs on another account. It is
# shuffled so that many turns whose preference is taken do not all pile onto the
# same next name.
function Get-SandboxPoolLeaseOrder {
  param([Parameter(Mandatory = $true)][string]$Folder)
  $preferred = Get-SandboxPoolAccountForFolder -Folder $Folder
  $rest = @(Get-SandboxPoolAccountNames | Where-Object { $_ -ne $preferred })
  $order = @($preferred)
  # Get-Random throws on an empty -InputObject, which is what a pool of one
  # would hand it.
  if ($rest.Count -gt 0) { $order += @(Get-Random -InputObject $rest -Count $rest.Count) }
  # NO leading comma here, deliberately, unlike ConvertFrom-JsonArgv in the
  # launcher: `return ,$order` writes a NESTED array to the pipeline, and while
  # an assignment unrolls that back to the 16 names, `@(Get-SandboxPoolLeaseOrder
  # ...)` at a call site collects ONE element - the whole array as a single
  # object. The comma exists to protect an EMPTY or one-element return; this
  # order always has at least the preferred account in it, so there is nothing
  # to protect and the comma only buys an inconsistency.
  return $order
}

# [System.Security.Cryptography.ProtectedData] lives in System.Security.dll,
# which is not loaded by default in every PowerShell host (confirmed: even a
# plain `powershell -File` run throws TypeNotFound without this) -- load it
# explicitly once so Protect-/Unprotect-SandboxCredentialBytes below can rely
# on the type being present regardless of caller.
Add-Type -AssemblyName System.Security

# Raw DPAPI byte protect/unprotect at LocalMachine scope  - the
# Export-/Import-Clixml convenience path only offers CurrentUser scope for a
# SecureString, so credential bytes go through these instead. No optional
# entropy: the ciphertext is already confined to $CredDir by
# Protect-SandboxCredDir's ACLs.
function Protect-SandboxCredentialBytes {
  param([Parameter(Mandatory = $true)][byte[]]$PlainBytes)
  return [System.Security.Cryptography.ProtectedData]::Protect(
    $PlainBytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
}

function Unprotect-SandboxCredentialBytes {
  param([Parameter(Mandatory = $true)][byte[]]$CipherBytes)
  return [System.Security.Cryptography.ProtectedData]::Unprotect(
    $CipherBytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
}

# Small on-disk wrapper (account name + DPAPI ciphertext) replacing the
# PSCredential/Clixml round-trip  - BinaryWriter.Write(string) length-prefixes
# the name itself, so the ciphertext (the rest of the stream) needs no
# separate length field.
function Save-SandboxCredentialFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$AccountName,
    [Parameter(Mandatory = $true)][byte[]]$CipherBytes
  )
  $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Create)
  try {
    $writer = New-Object System.IO.BinaryWriter($stream)
    $writer.Write($AccountName)
    $writer.Write($CipherBytes)
    $writer.Flush()
  } finally { $stream.Dispose() }
}

function Read-SandboxCredentialFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open)
  try {
    $reader = New-Object System.IO.BinaryReader($stream)
    $accountName = $reader.ReadString()
    $cipherBytes = $reader.ReadBytes([int]($stream.Length - $stream.Position))
    return [PSCustomObject]@{ AccountName = $accountName; CipherBytes = $cipherBytes }
  } finally { $stream.Dispose() }
}

# (a) Ensure ONE named account exists  - idempotent, local-admin only,
# fail loudly (never silently degrade) if creation is not possible.
function Get-SandboxCredential {
  param(
    [Parameter(Mandatory = $true)][string]$AccountName
  )
  $credPath = Join-Path $CredDir "sandbox-cred-$AccountName.bin"
  $existing = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
  if ($existing -and (Test-Path -LiteralPath $credPath)) {
    try {
      $stored = Read-SandboxCredentialFile -Path $credPath
      $plainBytes = Unprotect-SandboxCredentialBytes -CipherBytes $stored.CipherBytes
      $plainPwd = [System.Text.Encoding]::UTF8.GetString($plainBytes)
      $securePwd = ConvertTo-SecureString -String $plainPwd -AsPlainText -Force
      return New-Object System.Management.Automation.PSCredential($AccountName, $securePwd)
    }
    catch { throw "sandbox-logon-launcher: account '$AccountName' exists but its stored credential at $credPath could not be read ($($_.Exception.Message))  - delete that file to force a self-heal, or fix its permissions" }
  }
  $plainPwd = New-RandomPassword
  $securePwd = ConvertTo-SecureString -String $plainPwd -AsPlainText -Force
  if (-not $existing) {
    Log "creating sandbox pool account '$AccountName' (first use on this node)"
    try {
      New-LocalUser -Name $AccountName -Password $securePwd `
        -FullName 'egpt sandbox' `
        -Description 'egpt sandboxed:true logon (managed)' `
        -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -ErrorAction Stop | Out-Null
    } catch {
      throw "sandbox-logon-launcher: failed to create local account '$AccountName'  - $($_.Exception.Message) (this must run as a local Administrator)"
    }
  } else {
    # Account exists but the credential file we'd need to log it on with is
    # gone (deleted, moved node, etc.)  - self-heal by resetting its password
    # to a freshly generated one we DO have, rather than getting stuck.
    Log "account '$AccountName' exists but its credential file is missing  - resetting its password to restore a known credential"
    try { Set-LocalUser -Name $AccountName -Password $securePwd -ErrorAction Stop }
    catch { throw "sandbox-logon-launcher: account '$AccountName' exists but its password could not be reset to restore a known credential  - $($_.Exception.Message) (must run as a local Administrator)" }
  }
  try {
    New-Item -ItemType Directory -Path $CredDir -Force -ErrorAction Stop | Out-Null
    $cipherBytes = Protect-SandboxCredentialBytes -PlainBytes ([System.Text.Encoding]::UTF8.GetBytes($plainPwd))
    Save-SandboxCredentialFile -Path $credPath -AccountName $AccountName -CipherBytes $cipherBytes
  } catch {
    throw "sandbox-logon-launcher: account '$AccountName' is ready but its credential could not be persisted to $credPath  - $($_.Exception.Message)"
  }
  return New-Object System.Management.Automation.PSCredential($AccountName, $securePwd)
}

# Ensure every pool account exists  - idempotent, same self-heal as
# Get-SandboxCredential above, just looped over the whole pool. Returns how
# many accounts were freshly created vs already existed, for the provisioner
# script to report.
function Ensure-SandboxPool {
  $created = 0
  $existed = 0
  foreach ($name in (Get-SandboxPoolAccountNames)) {
    $existedBefore = [bool](Get-LocalUser -Name $name -ErrorAction SilentlyContinue)
    Get-SandboxCredential -AccountName $name | Out-Null
    if ($existedBefore) { $existed++ } else { $created++ }
  }
  [PSCustomObject]@{ Created = $created; Existed = $existed }
}

# Ensure the shared pool group exists and every pool account is a member  -
# idempotent (checks membership before adding, not exception-message
# matching). This group is what Grant-SandboxPoolAccess below grants
# ReadAndExecute to, once, instead of granting each account individually.
function Ensure-SandboxPoolGroup {
  if (-not (Get-LocalGroup -Name $SandboxPoolGroup -ErrorAction SilentlyContinue)) {
    Log "creating local group '$SandboxPoolGroup'"
    New-LocalGroup -Name $SandboxPoolGroup -Description 'egpt sandbox pool accounts (managed)' -ErrorAction Stop | Out-Null
  }
  $existingMembers = @((Get-LocalGroupMember -Group $SandboxPoolGroup -ErrorAction SilentlyContinue) | ForEach-Object { $_.Name -replace '^.*\\', '' })
  foreach ($name in (Get-SandboxPoolAccountNames)) {
    if ($existingMembers -notcontains $name) {
      Log "adding '$name' to group '$SandboxPoolGroup'"
      Add-LocalGroupMember -Group $SandboxPoolGroup -Member $name -ErrorAction Stop
    }
  }
}

# Grant the pool group ReadAndExecute on a CLI binary's directory (recurses to
# files/subdirs via inheritance) so a leased account can actually launch it --
# CreateProcessWithLogonW otherwise fails with ERROR_ACCESS_DENIED against a
# path only the operator's own account can read (e.g. ~/.local/bin). Additive
# only: never removes or replaces existing ACEs.
function Grant-SandboxPoolAccess {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "sandbox-logon-launcher: cannot grant pool access -- path does not exist: $Path"
  }
  $groupSid = (New-Object System.Security.Principal.NTAccount($SandboxPoolGroup)).Translate([System.Security.Principal.SecurityIdentifier])
  $acl = Get-Acl -LiteralPath $Path
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $groupSid, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
  Log "granted ReadAndExecute to $SandboxPoolGroup on $Path"
}

# Modify (read+write) for the pool on a directory it OWNS -- the pool's own pi
# config dir under ProgramData, and (2026-09-10) ~/bin/egpt, the RUNNING eGPT
# tree, so a being can change the code it runs. That second one IS inside the
# operator's profile, which this function avoided until the operator ruled it.
function Grant-SandboxPoolModify {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )
  $groupSid = (New-Object System.Security.Principal.NTAccount($SandboxPoolGroup)).Translate([System.Security.Principal.SecurityIdentifier])
  $acl = Get-Acl -LiteralPath $Path
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $groupSid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
  Log "granted Modify to $SandboxPoolGroup on $Path"
}

# Lock down $CredDir  - C:\ProgramData\egpt, which holds one DPAPI-encrypted
# password file per pool account plus the sandbox-pool-locks lease directory.
#
# WHY (operator 2026-08-21): that directory INHERITS BUILTIN\Users
# ReadAndExecute *and* Write from C:\ProgramData, and every pool account is in
# Users. So a sandboxed being could read every credential blob and create files
# in there. The blobs are user-scoped DPAPI (only the operator's account can
# decrypt them), so reading them is not currently exploitable -- but the file
# permission layer was contributing nothing, and the inherited Write also let a
# sandboxed process plant lock files in sandbox-pool-locks and starve the pool.
#
# LOAD-BEARING: the operator's own FullControl. The LAUNCHER runs UNELEVATED, as
# the operator, and must keep being able to read the credential files and
# create/delete lease locks -- so the account running this provisioner is
# granted explicitly alongside SYSTEM and Administrators. (Caveat: that is
# WindowsIdentity::GetCurrent(), i.e. whoever approved the UAC prompt. If this
# is ever elevated with a DIFFERENT admin's credentials than the account the
# daemon runs as, the daemon loses access -- run it as the operator.)
#
# Idempotent: inheritance is disabled, every pre-existing rule is dropped, and
# exactly these three are written, so re-running converges rather than
# accumulating. Existing credential files and sandbox-pool-locks are covered by
# ContainerInherit,ObjectInherit -- they inherit, so they pick the new set up.
#
# NOT Get-Acl/Set-Acl, deliberately (measured 2026-08-21, do not "simplify" it
# back): Set-Acl persists the SACL as well, so the SECOND run against an
# already-protected directory dies with PrivilegeNotHeldException
# ('SeSecurityPrivilege'). Going through DirectoryInfo with an explicit
# AccessControlSections::Access on BOTH the read and the write touches only the
# DACL, needs no privilege beyond WRITE_DAC, and re-runs cleanly - verified by
# running it three times in a row against a throwaway directory.
function Protect-SandboxCredDir {
  New-Item -ItemType Directory -Path $CredDir -Force -ErrorAction Stop | Out-Null
  $dir = New-Object System.IO.DirectoryInfo($CredDir)
  $acl = $dir.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
  # $true = protect from inheritance, $false = do NOT copy the inherited rules
  # in as explicit ones (copying them would keep the very Users grants this
  # function exists to remove).
  $acl.SetAccessRuleProtection($true, $false)
  # Any EXPLICIT rules that survive go too, so the result is exactly the three
  # added below whatever state the directory was in. Enumerated by SID, not by
  # NTAccount: an orphaned SID that no longer resolves to a name must still be
  # removable, not throw IdentityNotMappedException.
  foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
    $acl.RemoveAccessRuleAll($rule)
  }
  $principals = @(
    (New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)),
    (New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)),
    ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User
  )
  foreach ($sid in $principals) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  $dir.SetAccessControl($acl)
  Log "hardened $CredDir  - inheritance off, FullControl for SYSTEM, Administrators and $($principals[2].Translate([System.Security.Principal.NTAccount]).Value) only"
}

# NOTE (2026-08-26): the per-lease scratch-profile wipe used to live here as
# Clear-SandboxAccountProfile, deleting the whole Win32_UserProfile (registry
# entry + directory) via Remove-CimInstance. That needs local-Administrator
# rights, which the launcher HAD only while it still ran elevated; since the
# launch path moved to CreateProcessWithLogonW the daemon is unelevated by
# design, so that wipe failed on EVERY turn ("A required privilege is not held
# by the client") and the leak it existed to prevent was live. It is replaced by
# Clear-SandboxProfileContents in sandbox-logon-launcher.ps1, which scrubs the
# profile's CONTENTS as the leased account itself and needs no privilege at all.
# Do not resurrect an admin-only wipe here: nothing on the launch path can call
# it.

# ---- THE LEASE LEDGER, and the ACE revoke that rides the stale-lease reclaim
# (operator 2026-09-11). These five functions live HERE, beside
# Get-SandboxPoolLeaseOrder, because they are lease machinery and because
# sandbox-account.ps1 is the only half of the sandbox that is dot-sourceable -
# sandbox-logon-launcher.ps1 has a param block and runs, so nothing can unit
# test it. setup/sandbox-account.Tests.ps1 exercises all five for real.
#
# THE PROBLEM THEY CLOSE. The launcher grants the leased pool account a Modify
# ACE on TargetFolder and on each -SharePath entry, and revokes them in its
# finally. A HARD-killed turn (taskkill /F, crash, reboot) never runs that
# finally, so the ACE stays forever - and pool accounts are REUSED across
# different conversations, so the next lease of that same account by a DIFFERENT
# conversation still holds Modify on the first one's folder and on its
# ~/.egpt-jsonl/<thread> store. That is the cross-conversation leak the whole
# scrub design exists to prevent, arriving through the ACL instead of through
# the profile. MEASURED unelevated on this node 2026-09-11, before the fix: all
# 15 lease locks stale (no handle on any of them) and 42 explicit egpt-sbx-NN
# Modify ACEs surviving across the live conversation folders, one folder
# carrying TWELVE pool accounts at once.
#
# WHY THE RECLAIM AND NOT A SWEEPER. The launcher ALREADY has a mechanism for
# exactly this class of problem: the stale-lease-lock reclaim, which takes a
# lock file no process holds and logs "RECLAIMED stale lease lock ... was
# hard-killed before its release ran". A lease being reclaimed is precisely the
# moment we know a finally was skipped, and it is the moment BEFORE that account
# runs anything again. So the revoke rides it. No second lifecycle, no timer, no
# separate sweeper to go stale on its own.
#
# WHY THE LOCK FILE IS THE LEDGER. The reclaim has to know WHAT to revoke, and
# the lock file is the only artifact that already (a) survives the hard kill,
# (b) is created and deleted with the lease, (c) is per-ACCOUNT, which is
# exactly the key the leak is indexed by, and (d) is what the reclaim already
# has in its hand. It holds PATHS ONLY, one per line - never a credential, never
# an environment value - and it is unreadable by anyone else for the life of the
# lease because the launcher holds it FileShare::None.
$SandboxLeaseLedgerHeader = '# egpt sandbox lease ledger - one path per line, each granted a Modify ACE to this lock''s pool account by the turn holding it. A RECLAIM of this lock revokes them: the turn that wrote them was hard-killed before its own release ran. Deleted with the lock on a clean release.'

# Read the ledger back. Comment lines and blanks are skipped, so an EMPTY or
# pre-ledger lock file (every lock written before 2026-09-11 is 0 bytes) reads
# as zero paths rather than as an error - honest: those turns' ACEs were never
# recorded and this cannot invent them.
#
# Leaves the stream positioned at the end, so an Add- straight afterwards
# appends rather than overwrites. NO leading comma on the return, for the same
# reason Get-SandboxPoolLeaseOrder documents above: `return ,$out` puts a NESTED
# array on the pipeline, and every call site here is an @(...) that would then
# collect ONE element - the whole list as a single object. Callers wrap in @().
function Read-SandboxLeaseLedger {
  param([Parameter(Mandatory = $true)][System.IO.FileStream]$Stream)
  $Stream.Position = 0
  $len = [int]$Stream.Length
  $text = ''
  if ($len -gt 0) {
    $bytes = New-Object byte[] $len
    $read = 0
    while ($read -lt $len) {
      $n = $Stream.Read($bytes, $read, $len - $read)
      if ($n -le 0) { break }
      $read += $n
    }
    $text = [System.Text.Encoding]::UTF8.GetString($bytes, 0, $read)
  }
  $Stream.Position = $Stream.Length
  $out = @($text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
  return $out
}

# Replace the whole ledger: truncate, header, then these paths. Used twice - to
# stamp a header on a freshly CreateNew'd lock, and to rewrite a reclaimed one
# with whatever the revoke could NOT clear (see Clear-SandboxStaleLease).
#
# Flush($true) is flush-TO-DISK, not flush-to-cache, and it is the whole point:
# the reader of this file is the launcher that runs after this process was
# killed, so anything still sitting in a buffer is anything still leaking.
function Write-SandboxLeaseLedger {
  param(
    [Parameter(Mandatory = $true)][System.IO.FileStream]$Stream,
    [string[]]$Paths = @()
  )
  $lines = @($SandboxLeaseLedgerHeader) + @($Paths | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
  $bytes = [System.Text.Encoding]::UTF8.GetBytes((($lines -join "`r`n") + "`r`n"))
  $Stream.SetLength(0)
  $Stream.Position = 0
  $Stream.Write($bytes, 0, $bytes.Length)
  $Stream.Flush($true)
}

# Append ONE path. The launcher calls this BEFORE the matching Set-Acl, so the
# ledger is a SUPERSET of what actually landed - the safe direction for a crash
# log. A Set-Acl that threw leaves no ACE behind, and Revoke-SandboxLeaseAces
# skips a path that carries none, so the superset costs a read and never a stray
# write.
function Add-SandboxLeaseLedgerPath {
  param(
    [Parameter(Mandatory = $true)][System.IO.FileStream]$Stream,
    [Parameter(Mandatory = $true)][string]$Path
  )
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($Path.Trim() + "`r`n"))
  $Stream.Position = $Stream.Length
  $Stream.Write($bytes, 0, $bytes.Length)
  $Stream.Flush($true)
}

# THE ONE REVOKE IMPLEMENTATION. Both callers go through it - the launcher's
# finally on the normal path and the reclaim on the hard-kill path - so the two
# can never drift into disagreeing about what "revoked" means.
#
# RETURNS RECORDS, LOGS NOTHING. The "sandbox-logon-launcher:" prefix belongs to
# the launcher, and a function that writes to a host's stderr cannot be asserted
# on in Pester. Each record is { Path, Account, Sid, Status, Message } with
# Status one of:
#   revoked  explicit ACEs for this account were found and purged
#   clean    the path exists and carried none - nothing was written
#   missing  the path is gone, so no ACE can survive on it
#   failed   it could not be done, and the ACE may well still be there
# A 'failed' is the only one a caller must act on, and it must never be
# swallowed: the path is still granted.
#
# EXPLICIT RULES ONLY ($false for the inherited ones), and matched BY SID, not
# by name: an orphaned SID that no longer resolves to an account must still be
# countable, the same reason Protect-SandboxCredDir enumerates by SID. Purging
# is left to PurgeAccessRules, which is what the launcher's finally has always
# used - this moves it, it does not change it.
#
# THE PRESENCE CHECK IS THE DOCTRINE, not an optimisation: "a path that was
# missing, or whose Set-Acl threw, must not be touched on the way out - re-ACLing
# a folder this turn never modified is how a cleanup path turns into a bug."
function Revoke-SandboxLeaseAces {
  param(
    [Parameter(Mandatory = $true)][string]$AccountName,
    [string[]]$Paths = @()
  )
  $wanted = @($Paths | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
  $records = New-Object System.Collections.Generic.List[object]
  if ($wanted.Count -eq 0) { return @() }
  $sid = $null
  try {
    $sid = (New-Object System.Security.Principal.NTAccount($AccountName)).Translate([System.Security.Principal.SecurityIdentifier])
  } catch {
    # Cannot name the principal => cannot purge it. Every path is reported
    # 'failed' rather than quietly skipped, because every one of them is still
    # granted to an account that exists as far as the filesystem is concerned.
    $why = $_.Exception.Message
    foreach ($p in $wanted) {
      [void]$records.Add([pscustomobject]@{ Path = $p; Account = $AccountName; Sid = $null; Status = 'failed'; Message = "could not resolve the SID of '$AccountName' - $why" })
    }
    return $records.ToArray()
  }
  foreach ($p in $wanted) {
    # ONE try EACH, deliberately, and for the reason the grant loop has one
    # each: a path that cannot be purged now must not cost the paths after it in
    # the list their cleanup.
    try {
      if (-not (Test-Path -LiteralPath $p)) {
        [void]$records.Add([pscustomobject]@{ Path = $p; Account = $AccountName; Sid = $sid.Value; Status = 'missing'; Message = 'the path no longer exists, so no ACE can survive on it' })
        continue
      }
      $acl = Get-Acl -LiteralPath $p
      $mine = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $sid.Value })
      if ($mine.Count -eq 0) {
        [void]$records.Add([pscustomobject]@{ Path = $p; Account = $AccountName; Sid = $sid.Value; Status = 'clean'; Message = 'no explicit ACE for this account was on it - nothing written' })
        continue
      }
      $acl.PurgeAccessRules($sid)
      Set-Acl -LiteralPath $p -AclObject $acl
      [void]$records.Add([pscustomobject]@{ Path = $p; Account = $AccountName; Sid = $sid.Value; Status = 'revoked'; Message = "$($mine.Count) explicit ACE(s) purged" })
    } catch {
      [void]$records.Add([pscustomobject]@{ Path = $p; Account = $AccountName; Sid = $sid.Value; Status = 'failed'; Message = $_.Exception.Message })
    }
  }
  return $records.ToArray()
}

# THE RECLAIM'S HALF, in one call: read the dead turn's ledger off the lock we
# just took, revoke every path on it, and then rewrite the ledger with the ones
# that FAILED.
#
# THE CARRY-OVER IS THE POINT of rewriting rather than just truncating. A path
# the revoke could not clear is still leaking; dropping it here would forget the
# leak forever, and the next reclaim of this account would have nothing to
# retry. So it stays on the list, and the turn that now owns this lock will also
# try it again in its own finally.
#
# Everything else - 'revoked', 'clean', 'missing' - is resolved and leaves. The
# caller gets every record, including those, because a reclaim that revoked
# nothing and a reclaim that revoked eleven ACEs must not look the same in the
# log.
function Clear-SandboxStaleLease {
  param(
    [Parameter(Mandatory = $true)][System.IO.FileStream]$Stream,
    [Parameter(Mandatory = $true)][string]$AccountName
  )
  $ledger = @(Read-SandboxLeaseLedger -Stream $Stream)
  $records = @(Revoke-SandboxLeaseAces -AccountName $AccountName -Paths $ledger)
  $carry = @($records | Where-Object { $_.Status -eq 'failed' } | ForEach-Object { $_.Path })
  Write-SandboxLeaseLedger -Stream $Stream -Paths $carry
  return $records
}
