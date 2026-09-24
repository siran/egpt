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
# The lease locks live under $CredDir (which is why Protect-SandboxCredDir's
# hardening covers them). Derived HERE rather than in the launcher so that the
# provisioner's pool-wide reclaim (Clear-SandboxAbandonedLeases, below) and the
# launcher's per-lease one cannot end up looking in two different directories.
$SandboxLocksDir = Join-Path $CredDir 'sandbox-pool-locks'

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
# SAYS WHICH ACCOUNT IT IS ON, every one of the sixteen (operator 2026-09-20,
# "please make script show progress"): this is the FIRST thing the provisioner
# runs, so it is also the first proof the run is alive rather than wedged. One
# line per account, the same Log shape everything else here uses.
function Ensure-SandboxPool {
  $created = 0
  $existed = 0
  $names = @(Get-SandboxPoolAccountNames)
  $i = 0
  foreach ($name in $names) {
    $i++
    Log "pool account $i/$($names.Count): $name"
    $existedBefore = [bool](Get-LocalUser -Name $name -ErrorAction SilentlyContinue)
    Get-SandboxCredential -AccountName $name | Out-Null
    if ($existedBefore) { $existed++ } else { $created++ }
  }
  [PSCustomObject]@{ Created = $created; Existed = $existed }
}

# Ensure the shared pool group exists and every pool account is a member  -
# idempotent (checks membership before adding, not exception-message
# matching). This group is what Grant-SandboxPoolAce below grants to, once,
# instead of granting each account individually.
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

# EVERY ACE THE SANDBOX EVER GRANTS, AS ONE TABLE. Three of them, and this is
# the only place any is spelled:
#
#   Traverse  (X,RA,RC), NOT inheritable, on each directory of the ancestor chain
#             above a conversation folder. Walk THROUGH it; do not LIST it. RD is
#             withheld on purpose, so a sandboxed being reaches the one folder it
#             was granted BY NAME and still cannot enumerate the operator's home
#             or the names of other conversations. The mask is not what it looks
#             like: measured end to end as a real pool account (2026-09-13), the
#             token DOES hold SeChangeNotify so the kernel walk is already
#             covered - what fails without an ACE is Node's per-component lstat,
#             i.e. OPENING an ancestor as an object in its own right.
#   Read      (OI)(CI)(RX), inheritable, on a CLI binary's directory or on ~\src.
#             The whole subtree is the point - CreateProcessWithLogonW otherwise
#             fails ERROR_ACCESS_DENIED on a path only the operator can read.
#   Modify    (OI)(CI)(M), inheritable, on a directory the pool OWNS - pi's
#             config dir, which pi WRITES to.
#
# THE LAUNCHER'S TWO PER-LEASE GRANTS COME OUT OF THIS SAME TABLE, to the LEASED
# ACCOUNT's SID instead of the group's: Modify on the conversation folder, Read
# on a read-only share from a being's allowed_paths. There is no second table and
# no second writer (operator 2026-09-20, told the launcher still used Set-Acl
# while the provisioner had moved: "i think we can use always the fast way").
#
# Rights is the mask the ACE LANDS AS on disk, which is what the check below
# compares. Measured 2026-09-20 on reve, every combination this table can
# produce, icacls against Set-Acl, mask + inheritance + propagation + type:
#   (OI)(CI)(M)  -> 1245631 ContainerInherit,ObjectInherit   identical
#   (OI)(CI)(RX) -> 1179817 ContainerInherit,ObjectInherit   identical
#   (M)          -> 1245631 None                             identical
#   (RX)         -> 1179817 None                             identical
#   (X,RA,RC)    ->  131232 None                             identical
# So moving these writes to icacls changed nothing about WHAT is granted.
$SandboxPoolGrants = @{
  Traverse = @{ Spec = '(X,RA,RC)';    Rights = [int][System.Security.AccessControl.FileSystemRights]'ExecuteFile, ReadAttributes, ReadPermissions'; Inherit = [System.Security.AccessControl.InheritanceFlags]'None' }
  Read     = @{ Spec = '(OI)(CI)(RX)'; Rights = [int][System.Security.AccessControl.FileSystemRights]'ReadAndExecute, Synchronize';                  Inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
  Modify   = @{ Spec = '(OI)(CI)(M)';  Rights = [int][System.Security.AccessControl.FileSystemRights]'Modify, Synchronize';                          Inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
}

# A GRANT IS A FACT TO CONVERGE ON, NOT A COMMAND TO RE-ISSUE (operator
# 2026-09-20, watching the provisioner sit on the ancestor chain: "the script is
# doing something slow and perhaps weird with the ACLs.... it shouldn't be
# complicated, it has to be easy to review").
#
# SO: READ THE DACL FIRST, WRITE ONLY WHAT IS MISSING OR WRONG. Writing a DACL on
# a container makes Windows re-run inheritance propagation over the whole
# subtree, so re-issuing a grant that is already correct is not free - ~\src
# measured 307 s for ONE pass on reve, and Set-Acl HUNG twice against
# C:\Users\an and had to be killed. All five ancestors and ~\src were already
# correct before the run the operator watched, so it should have been seconds.
#
# icacls, NEVER Set-Acl, for the write (measured 2026-09-13): Set-Acl persists
# the SACL as well - see Protect-SandboxCredDir's note on
# PrivilegeNotHeldException - and is the one that hung on the profile root.
# icacls edits the DACL only and returns at once. Plain /grant, never /grant:r,
# so this stays ADDITIVE: it never narrows a broader grant already made to that
# principal, and narrowing one stays a hand operation (as it was for ~\bin\egpt:
# `icacls "%USERPROFILE%\bin\egpt" /remove:g egpt-sandbox-pool`, then re-run the
# provisioner).
#
# WHAT "ALREADY GRANTED" MEANS, exactly: an EXPLICIT Allow ACE on THIS object,
# for the granted principal's SID, with exactly this grant's inheritance flags
# and carrying at least its rights.
#  - EXPLICIT ONLY. An inherited ACE is a fact about a parent; the fact this
#    converges on is an ACE here. (Test-SandboxPoolReadCovered answers the other
#    question - "can the pool already read this?" - and does accept inherited.)
#  - THE FLAGS ARE PART OF THE FACT. An inheritable (OI)(CI)(RX) does not satisfy
#    the non-inheritable traverse grant, and vice versa: they are different ACEs
#    on purpose, and a grant present with the wrong inheritance is corrected by
#    writing the right one beside it.
#  - AT LEAST, NOT EXACTLY, on the rights. Allow ACEs union, so a broader ACE
#    already satisfies the grant - and plain /grant could not narrow it anyway.
#
# A LEAF TAKES THE SAME MASK WITHOUT THE INHERITANCE FLAGS. A share path from a
# being's allowed_paths may be a single FILE, and (OI)(CI) is meaningless on one:
# .NET throws 'This flag may not be set on a leaf object', and icacls does
# something worse - it ACCEPTS (OI)(CI) on a file, exits 0, and writes no ACE at
# all (measured 2026-09-20). So the leaf case is derived here, once, rather than
# left to each caller: strip the inheritance from the spec and from the flags the
# check compares, and the two agree by construction.
#
# THIS HEADER COVERS THE THREE FUNCTIONS BELOW, which are one thing split in
# 2026-09-23 only so the QUESTION can be asked without the WRITE: the shape a
# grant lands as, the predicate that says whether it is already there, and the
# grant itself, which is both of the others plus one icacls call.

# THE SHAPE ONE GRANT LANDS AS, derived in ONE place (2026-09-23). Pulled out of
# Grant-SandboxPoolAce so the predicate below and the grant itself cannot drift
# about what "this grant" means - the leaf derivation especially, which is easy
# to reproduce nearly-right. Pure: a table row plus whether the target is a leaf.
function Get-SandboxPoolGrantShape {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidateSet('Traverse', 'Read', 'Modify')][string]$Grant
  )
  $want = $SandboxPoolGrants[$Grant]
  $isLeaf = -not (Test-Path -LiteralPath $Path -PathType Container)
  $spec    = if ($isLeaf) { $want.Spec -replace '^\(OI\)\(CI\)', '' } else { $want.Spec }
  $inherit = if ($isLeaf) { [System.Security.AccessControl.InheritanceFlags]::None } else { $want.Inherit }
  return [PSCustomObject]@{ Spec = $spec; Rights = $want.Rights; Inherit = $inherit }
}

# IS THIS EXACT GRANT ALREADY ON THIS OBJECT? - the "already granted" fact of
# Grant-SandboxPoolAce's header, as a function, so it can be ASKED without
# writing (2026-09-23). Grant-SandboxPoolAce is its first caller and the reason
# it says what it says; the provisioner's ~\src retirement is the second, and
# needs to know whether the WIDE read grant is there before it revokes anything,
# because the revoke it would otherwise run takes the traverse ACE off too.
#
# EXPLICIT ONLY ($false for inherited), flags included, rights AT LEAST - every
# clause of that header applies here unchanged, because this IS that check.
# -ErrorAction Stop: a DACL this process cannot read must not come back as an
# empty rule set and be mistaken for "not granted yet".
function Test-SandboxPoolAcePresent {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidateSet('Traverse', 'Read', 'Modify')][string]$Grant,
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$Sid
  )
  $want = Get-SandboxPoolGrantShape -Path $Path -Grant $Grant
  $present = @((Get-Acl -LiteralPath $Path -ErrorAction Stop).GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | Where-Object {
      $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      $_.IdentityReference.Value -eq $Sid.Value -and
      $_.InheritanceFlags -eq $want.Inherit -and
      $_.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None -and
      ([int]$_.FileSystemRights -band $want.Rights) -eq $want.Rights
    })
  return ($present.Count -gt 0)
}

# The pool GROUP's own SID, resolved by NAME. Its own function because three
# callers now need it and each one translating for itself is three chances to
# name a principal that merely SHARES the name (see Grant-SandboxPoolAce's note
# on why the translation happens at all).
function Get-SandboxPoolGroupSid {
  return (New-Object System.Security.Principal.NTAccount($SandboxPoolGroup)).Translate([System.Security.Principal.SecurityIdentifier])
}

function Grant-SandboxPoolAce {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidateSet('Traverse', 'Read', 'Modify')][string]$Grant,
    # WHO. Defaults to the pool GROUP - the standing grants the provisioner
    # writes. The launcher passes the LEASED ACCOUNT's own SID for its two
    # per-lease grants; same table, same check-first rule, same tool.
    [System.Security.Principal.SecurityIdentifier]$Sid,
    # How that principal is NAMED in the log, nothing more.
    [string]$Principal
  )
  if (-not $Sid) {
    # By SID. Translating first means a missing pool group fails loudly right
    # here instead of letting icacls resolve some other principal that happens to
    # carry the same name. '*' is icacls's prefix for a SID literal.
    $Sid = Get-SandboxPoolGroupSid
    if (-not $Principal) { $Principal = $SandboxPoolGroup }
  }
  if (-not $Principal) { $Principal = $Sid.Value }
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "sandbox-logon-launcher: cannot grant $Grant to $Principal -- path does not exist: $Path"
  }
  $spec = (Get-SandboxPoolGrantShape -Path $Path -Grant $Grant).Spec
  if (Test-SandboxPoolAcePresent -Path $Path -Grant $Grant -Sid $Sid) {
    Log "already granted $Grant $spec to $Principal on $Path  - nothing written"
    return 'already granted'
  }
  # No 2>&1: PS 5.1 turns a redirected native stderr into NativeCommandError
  # records, which under the provisioner's $ErrorActionPreference='Stop' throws
  # something unrelated to what went wrong. icacls's own reason goes to the
  # console; the exit code is what this branches on.
  $out = & icacls.exe $Path '/grant' "*$($Sid.Value):$spec"
  if ($LASTEXITCODE -ne 0) {
    throw "sandbox-logon-launcher: icacls could not grant $Grant $spec to $Principal on $Path  - exit $LASTEXITCODE ($($out -join ' '))"
  }
  Log "granted $Grant $spec to $Principal on $Path"
  return 'granted'
}

# IS THIS PATH ALREADY READABLE BY THE WHOLE POOL? (operator 2026-09-20: "~/src
# now carries (OI)(CI)(RX) for egpt-sandbox-pool, so every per-turn read-only
# share under it is redundant work that also re-creates the leak.")
#
# WHAT IT ANSWERS, exactly: does this path's own DACL already carry an Allow for
# the POOL GROUP that covers ReadAndExecute, with no Deny that could take it
# back. If it does, the launcher's per-turn ReadAndExecute ACE for the leased
# account buys the being nothing - Windows UNIONS Allow ACEs - and costs a DACL
# write on a tree plus one more ACE that a hard-killed turn leaks.
#
# WHY IT IS RELIABLE, which is the only reason it may be used to SKIP a grant (a
# wrong skip means a being silently loses read access mid-turn):
#  - GROUP, NOT ACCOUNT. Matched by the pool group's SID, so a lease ACE naming
#    an individual egpt-sbx-NN - litter, by definition - can never satisfy it.
#    Every pool account is a member of that group by construction
#    (Ensure-SandboxPoolGroup), and membership is baked into the token at logon,
#    which is what CreateProcessWithLogonW performs.
#  - INHERITED OR EXPLICIT, both accepted, because both are STANDING: the ACE the
#    operator named is the inherited one from ~\src, and an explicit one on this
#    very path is the same fact one directory up. Neither is written per turn.
#  - THE WHOLE MASK, not a bit of it: ($rights -band RX) -eq RX. A grant of, say,
#    traverse-only (X,RA,RC) from Grant-SandboxPoolAce must NOT satisfy this
#    - it deliberately withholds read-data, and that is the difference between a
#    being that can open the tree and one that can only walk through it.
#  - ANY DENY IS A NO. An explicit Allow for the leased ACCOUNT beats an
#    INHERITED Deny for the group, so where a Deny exists the per-account grant
#    is not redundant and must still be written. Deny for either principal =>
#    do not skip.
# Anything that throws returns $false: the safe direction is to grant.
function Test-SandboxPoolReadCovered {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$LeasedSid
  )
  try {
    $groupSid = (New-Object System.Security.Principal.NTAccount($SandboxPoolGroup)).Translate([System.Security.Principal.SecurityIdentifier])
    # BOTH explicit and inherited ($true, $true), by SID like everything else
    # here. -ErrorAction Stop so an unreadable DACL reaches the catch and answers
    # $false (grant it) instead of reading as "no rules at all".
    $rules = @((Get-Acl -LiteralPath $Path -ErrorAction Stop).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    foreach ($rule in $rules) {
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Deny) { continue }
      if ($rule.IdentityReference.Value -eq $groupSid.Value -or $rule.IdentityReference.Value -eq $LeasedSid.Value) { return $false }
    }
    $readAndExecute = [int][System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    foreach ($rule in $rules) {
      if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
      if ($rule.IdentityReference.Value -ne $groupSid.Value) { continue }
      if (([int]$rule.FileSystemRights -band $readAndExecute) -eq $readAndExecute) { return $true }
    }
    return $false
  } catch {
    return $false
  }
}

# ---- CAN THIS ACCOUNT ACTUALLY REACH THIS DIRECTORY? (2026-09-23)
#
# THE FAILURE THIS EXISTS FOR, measured on kg 2026-09-23. A turn died with
#   sandbox-logon-launcher: CreateProcessWithLogonW('egpt-sbx-05') failed for
#   launching, Win32 error 267
# and Win32 267 is ERROR_DIRECTORY: for CreateProcessWithLogonW that is what
# lpCurrentDirectory returns when the directory is not reachable BY THE TARGET
# USER. icacls on that conversation folder showed explicit ACEs for
# egpt-sbx-07, -12 and -13 - and NONE for egpt-sbx-05, the account the turn had
# leased and just "granted" Modify on it. So step (d) reported a grant that was
# not on the object, and step (f) launched into a cwd the account could not
# enter.
#
# WHY THAT WAS POSSIBLE AT ALL, and it is one line of missing discipline:
# Grant-SandboxPoolAce reads the DACL BEFORE the write (its check-first fast
# path) and never reads it back AFTER. It branches on icacls's EXIT CODE, and
# this same file already records, in capitals, that the exit code is not the
# fact: `icacls` accepts (OI)(CI) on a leaf, EXITS 0, prints "Successfully
# processed 1 files" and writes no ACE at all (measured 2026-09-20). Its
# sibling Revoke-SandboxPathAces was given the opposite rule the same day -
# "THE DACL DECIDES, NOT THE EXIT CODE", read before and after - and the grant
# half never got it. A write nobody read back is a promise, not a fact.
#
# SO THIS IS THE READ-BACK, and it answers exactly one question: does this SID
# hold an Allow ACE on THIS object that carries at least ReadAndExecute, with
# nothing denying it. That is the mask entering a directory as a cwd needs -
# deliberately NOT Modify, because "can enter" and "may write" are two
# different promises and only the first one is what 267 is about. The other
# half, "did the exact (OI)(CI)(M) step (d) promised land", stays
# Grant-SandboxPoolAce's own check.
#
# EXPLICIT OR INHERITED, both count ($true, $true), unlike Grant-SandboxPoolAce
# and like Test-SandboxPoolReadCovered: the question here is what the kernel
# will do with this object, and an inherited Allow is as real to the kernel as
# an explicit one.
#
# ANY DENY FOR THIS SID IS A NO. A Deny that touches any of the bits reach
# needs beats every Allow, wherever it came from.
#
# WHAT IT IS NOT, said plainly: this is a DACL check for ONE SID, not an
# access check against a token. A principal that could enter only through a
# GROUP it belongs to reads as unreachable here. That is exact for the case it
# guards and not a general-purpose answer: a conversation folder lives under
# the operator's home, whose DACL is SYSTEM / Administrators / the operator
# plus whatever the launcher granted - no BUILTIN\Users, no Authenticated
# Users, and the pool group is granted traverse on the ANCESTORS and never on
# the folder itself. So a pool account's only way in is its own ACE, which is
# the one this looks for. Anywhere else it would be too strict.
#
# AND IT FAILS CLOSED, which is the one place it deliberately disagrees with
# Test-SandboxPoolReadCovered. There, an unreadable DACL answers $false and the
# safe direction is to GRANT. Here, an unreadable DACL answers "not reachable"
# and the safe direction is to REFUSE THE TURN: the whole point is that a turn
# which cannot be sandboxed fails saying so rather than launching into a
# directory nobody verified.
#
# RETURNS A RECORD, LOGS NOTHING - the same shape and the same reason as
# Revoke-SandboxPathAces: { Path, Sid, Principal, Reachable, Reason }. A
# function that writes to a host's stderr cannot be asserted on in Pester.
#
# -Acl IS INJECTABLE so the whole predicate is testable against a
# FileSecurity built in memory, with no path, no DACL write and no elevation -
# the same trick provision-service-account.ps1's Get-SshAclPlan uses. Left out,
# it is read off $Path.
function Test-SandboxPathReachable {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$Sid,
    # How the principal is NAMED in the reason string, nothing more.
    [string]$Principal,
    [System.Security.AccessControl.FileSystemSecurity]$Acl
  )
  if (-not $Principal) { $Principal = $Sid.Value }
  $verdict = {
    param([bool]$Reachable, [string]$Reason)
    [pscustomobject]@{ Path = $Path; Sid = $Sid.Value; Principal = $Principal; Reachable = $Reachable; Reason = $Reason }
  }
  if (-not $Acl) {
    if (-not (Test-Path -LiteralPath $Path)) {
      return (& $verdict $false 'the path does not exist, so nothing can be reachable on it')
    }
    try {
      $Acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    } catch {
      return (& $verdict $false "its DACL could not be read, so nothing here is verified  - $($_.Exception.Message)")
    }
  }
  try {
    $rules = @($Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  } catch {
    return (& $verdict $false "its access rules could not be enumerated, so nothing here is verified  - $($_.Exception.Message)")
  }
  $need = [int][System.Security.AccessControl.FileSystemRights]::ReadAndExecute
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Deny) { continue }
    if ($rule.IdentityReference.Value -ne $Sid.Value) { continue }
    if (([int]$rule.FileSystemRights -band $need) -ne 0) {
      return (& $verdict $false "a Deny ACE for this SID takes back part of ReadAndExecute here (rights $([int]$rule.FileSystemRights), inherited=$($rule.IsInherited)), and a Deny beats every Allow")
    }
  }
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    if ($rule.IdentityReference.Value -ne $Sid.Value) { continue }
    if (([int]$rule.FileSystemRights -band $need) -eq $need) {
      $how = if ($rule.IsInherited) { 'inherited' } else { 'explicit' }
      return (& $verdict $true "an $how Allow ACE for this SID carries ReadAndExecute (rights $([int]$rule.FileSystemRights))")
    }
  }
  # NOT REACHABLE, and the useful half of saying so is WHO is on it instead:
  # on the folder that produced the 2026-09-23 failure this would have printed
  # egpt-sbx-07, -12 and -13, i.e. three other pool accounts' leaked ACEs and
  # not the leased one. Names are best-effort - a leaked ACE can name a SID
  # that no longer resolves, which must not turn a diagnostic into a throw.
  $others = @($rules | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow } |
      ForEach-Object { $_.IdentityReference.Value } | Select-Object -Unique | ForEach-Object {
      $named = $_
      try { $named = "$_ (" + (New-Object System.Security.Principal.SecurityIdentifier($_)).Translate([System.Security.Principal.NTAccount]).Value + ')' } catch { }
      $named
    })
  $who = if ($others.Count -gt 0) { $others -join ', ' } else { 'no Allow ACE at all' }
  return (& $verdict $false "no Allow ACE for this SID carries ReadAndExecute here; the DACL allows: $who")
}

# THE SAME VERDICT, AS A GATE - one call site shape for every point in the
# launcher that must not proceed without it, so the message a turn dies with
# is written once.
#
# THROWS, which in the launcher means: the try's finally still revokes and
# releases the lease, and the script exits non-zero with this on stderr. That
# is the whole ruling - src/sandbox-cli-session.mjs already states it for
# engine and platform ("a misconfigured being fails loudly instead of silently
# running unsandboxed", "AN EXPLICIT REQUEST MAY NOT BE SILENTLY DOWNGRADED")
# and the working directory is no different: a turn that cannot be sandboxed
# fails saying so. It is NEVER run somewhere else instead, and the grant is
# NEVER widened to make it pass - not Everyone, not a parent directory, not a
# broader mask. The named path only.
function Assert-SandboxPathReachable {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$Sid,
    [Parameter(Mandatory = $true)][string]$AccountName,
    # Where in the launcher this gate sits, so the log says which of the two
    # fired: the grant did not land, or something took it away afterwards.
    [Parameter(Mandatory = $true)][string]$Stage
  )
  $verdict = Test-SandboxPathReachable -Path $Path -Sid $Sid -Principal "$($Sid.Value) ($AccountName)"
  if ($verdict.Reachable) {
    Log "verified at $Stage that '$AccountName' ($($Sid.Value)) can reach $Path  - $($verdict.Reason)"
    return $verdict
  }
  throw ("sandbox-logon-launcher: REFUSING at $Stage  - the leased account '$AccountName' ($($Sid.Value)) cannot reach $Path, " +
    "which is the working directory this turn was about to be given. EXPECTED: an Allow ACE for that SID on exactly that folder " +
    "carrying at least ReadAndExecute  - step (d) writes (OI)(CI)(M) there, to that SID, on that one named path. FOUND: $($verdict.Reason). " +
    "Proceeding is how a turn dies at CreateProcessWithLogonW with Win32 error 267 (ERROR_DIRECTORY: lpCurrentDirectory not reachable BY THE " +
    "TARGET USER), because icacls can exit 0 and write no ACE at all. A turn that cannot be sandboxed fails here saying so; it is never run " +
    "somewhere else, and the grant is never widened to make this pass.")
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
# THE ONE .NET DACL WRITER LEFT, and the exemption from "always the fast way"
# (operator 2026-09-20) is this: it strips EVERY explicit ACE including orphaned
# SIDs that no longer resolve to a name, and icacls has no verb for that -
# /remove needs a principal to name and /grant:r only replaces the one it names.
#
# NOT Get-Acl/Set-Acl either, deliberately (measured 2026-08-21, do not
# "simplify" it back): Set-Acl persists the SACL as well, so the SECOND run
# against an already-protected directory dies with PrivilegeNotHeldException
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

# THE JUNCTIONS EVERY POOL PROFILE GETS, AS ONE STATEMENT - the tail of the
# payload Clear-SandboxProfileContents runs as the leased account after the wipe.
#
# TWO LINKS, ONE GENERATOR. The table below is the only place either is named,
# because adding one by copying the other is how the two would drift into
# disagreeing about the existence guard or the error handling:
#   src   -> ~\src\egpt, the EDITABLE eGPT checkout, read-only
#   egpt  -> this lease's Room (see below - not a convenience)
#
# `src` IS THE REPO, AND IT USED TO BE THE OPERATOR'S WHOLE ~\src (operator
# ruling 2026-09-23: "dismiss mounting ~/src always, that was a faux-pas", and
# "in the same way that the conversation directory is mounted in the sandbox
# account, the src/egpt can also be mounted as src/"). What that retires, in one
# move, is a STANDING (OI)(CI)(RX) for the whole pool on every line of source the
# operator has ever checked out - which was the stated cost of the 2026-09-20
# shape and is now judged too high. The mount mechanism is unchanged; only the
# target narrowed, from ~\src to ~\src\egpt.
#
# AND `my-code` IS GONE, folded into this one name. It pointed at ~\src\egpt -
# exactly what `src` now points at - so keeping it would be a second name for one
# target. The ask it came from ("keep my-code/ so egpt can see itself") is
# satisfied by `src`: the being still reaches its own checkout, under the name the
# operator's later ruling gave it. Nothing outside this repo ever named it (no
# identity card, no skeleton, no config key - grepped 2026-09-23), and dropping
# the row buys about 34 characters of the scrub payload's 1024-character ceiling,
# which is a ceiling that REFUSES THE TURN when it is crossed. One row is easy to
# add back if the operator wants the alias; that is the only thing this decision
# costs.
#
# BOTH HALVES OR IT IS A LIE, and the other half is NOT here: a junction is only
# a name, and the target's DACL decides. ~\src\egpt carries a STANDING
# (OI)(CI)(RX) for the pool GROUP, written by provision-sandbox-account.ps1,
# which carries the reasoning for why that one is standing rather than per-turn.
# It must NOT be per-lease: a DACL write on that tree re-propagates inheritance
# through node_modules and was measured at minutes, and the turn path cannot pay
# that (see Grant-SandboxPoolAce's header and Revoke-SandboxPathAces's).
#
# IT LIVES HERE, not inline in the launcher, for the reason the lease-ledger
# block below gives: sandbox-logon-launcher.ps1 has a param block and runs, so
# nothing can dot-source it, and this returns the literal statement that
# setup/sandbox-account.Tests.ps1 then runs FOR REAL against a throwaway profile.
# A copy of the statement in a test would pass while the shipped one was broken -
# which is not hypothetical: the first version read `-EA 0>$null` without the
# space, and PowerShell binds that as part of a PARAMETER NAME.
#
# KEEP IT SHORT - the WHOLE scrub payload must fit in a 1024-character command
# line (see Invoke-AsLeasedAccount's BUDGET note; the single-junction version
# measured 775 characters). That is why this is one `foreach` over a pair list
# rather than one statement per link, why it uses aliases, and why NOTHING here
# uses a double quote: Format-Win32Arg escapes every `"` as `\"`, costing two
# characters each.
# WHAT THE THIRD LINK COSTS, measured 2026-09-23 against the real profile and
# ~\src lengths on reve, whole command line including the exe and the flags:
#   slug  30 chars -> 935     slug 37 -> 942     slug 80 -> 985
# i.e. roughly 40 characters of headroom at an 80-character conversation slug.
# A much longer slug overruns, and then CreateProcessWithLogonW fails outright
# with E_INVALIDARG rather than truncating. THAT IS NOT SILENT: the scrub is the
# only thing that plants `egpt`, so a scrub that did not run returns no working
# directory and the launcher refuses the turn by name (see the guard after
# Clear-SandboxProfileContents). No invented character limit is enforced here -
# the real ceiling between 1024 and the measured 3074 failure is unknown, and
# guessing one would refuse turns that work.
#
# -EA 0 AND NOTHING ELSE ON FAILURE, deliberately: on a node with no ~\src\egpt,
# New-Item refuses a junction whose target does not exist and creates nothing
# (measured 2026-09-20 - no dangling link is left behind). A missing convenience
# link must not cost the turn. That is true of `src`; it is NOT true of `egpt`
# below, and the launcher acts on the difference.
#
# ---- `egpt` IS THE THIRD LINK, AND IT IS NOT A CONVENIENCE (operator ruling
# 2026-09-23). It is THE BEING'S WORKING DIRECTORY, and the reason it exists is
# privacy of the path itself. A sandboxed being's cwd used to be the durable
# Room, `C:\Users\an\.egpt\conversations\whatsapp\<slug>`, and it QUOTED that
# path into group chats all day - verbose tool lines read
#   Bash(cd "C:/Users/an/.egpt/conversations/whatsapp/Reencuentro CR...")
# which discloses two things to everyone in the room: the OPERATOR's username
# and profile layout, and - because a slug is usually a PERSON'S NAME - a third
# party's private conversation name. Through the junction the same line reads
#   Bash(ls /c/Users/egpt-sbx-02/egpt/transcripts/...)
# a disposable pool account number and nothing else. MEASURED 2026-09-23:
# process.cwd() and `pwd` both return the JUNCTION path; only fs.realpathSync
# and `pwd -P` resolve to the target, so the neutral name is the one that gets
# quoted.
#
# ONE JUNCTION AT `egpt`, NOT ONE PER SUBDIRECTORY, and that is load-bearing: a
# single reparse point carries the Room's ROOT-LEVEL FILES across, so
# transcript.md needs no special handling. Per-directory mounting cannot carry a
# file, and hardlinking transcript.md would break silently because rollTranscript
# RENAMES it into transcripts/<thread>.md and writes a fresh one - the hardlink
# would follow the archive and the being would read a stale transcript for ever.
# No slug segment either: a lease is ONE conversation, so there is nothing to
# disambiguate.
#
# REMOVE-THEN-CREATE, which replaced "create only if absent" for ALL the links
# when `egpt` arrived. src has a CONSTANT target, so leaving a
# surviving link alone was harmless; egpt's target is a DIFFERENT Room every
# lease, so a stale one that outlived the wipe - a link the scrub could not
# delete because some orphan still had it as its cwd - would silently hand this
# conversation the PREVIOUS conversation's Room. That is the cross-conversation
# leak the whole scrub exists to prevent, arriving through a name instead of
# through a file. One `ri` before the `ni` closes it for every link at once.
#
# THE `ri` IS THE SAME CALL THE WIPE ONE LINE ABOVE ALREADY MAKES OVER THESE
# VERY LINKS, and it deletes a junction as a LINK, never through it (measured
# 2026-08-26, re-verified 2026-09-23 against a Room-shaped target with
# root-level files and a nested subtree: the link goes, the target is untouched).
# -Recurse is REQUIRED and is not a hazard here: WITHOUT it, Remove-Item on a
# junction whose target is non-empty PROMPTS, and the scrub child runs
# -NonInteractive, so it throws and the stale link survives (measured
# 2026-09-23). If anything here ever starts recursing THROUGH a reparse point,
# this is a conversation-history shredder - stop rather than adjust it.
function Get-SandboxProfileJunctionStatement {
  param(
    # THE REPO, not the operator's ~\src: C:\Users\an\src\egpt. Named -RepoRoot
    # rather than -OperatorSrc so that a caller still passing the old, wider
    # target fails to bind instead of silently re-mounting all of ~\src.
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    # MANDATORY on purpose: a caller that forgot it would silently produce a
    # profile with no `egpt` mount, i.e. a turn with nowhere to run.
    [Parameter(Mandatory = $true)][string]$RoomTarget
  )
  $links = [ordered]@{
    'src'  = $RepoRoot
    'egpt' = $RoomTarget
  }
  $pairs = @($links.Keys | ForEach-Object { "@('$_','$($links[$_])')" }) -join ','
  return "foreach(`$j in @($pairs)){`$s=Join-Path `$r `$j[0];ri -LiteralPath `$s -Recurse -Force -EA 0;ni -ItemType Junction -Path `$s -Target `$j[1] -EA 0 >`$null}"
}

# Render a Windows path msys-style: C:\Users\egpt-sbx-09\egpt becomes
# /c/Users/egpt-sbx-09/egpt (drive letter lowercased, backslashes turned into
# forward slashes). Pure. An already-posix path, a UNC path, or anything else
# that is not <letter>:<sep> is returned unchanged.
#
# A SECOND IMPLEMENTATION OF ONE RULE, KNOWINGLY, and the only reason it is
# acceptable: src\conversations-state.mjs's toMsysPath is the original (migration
# 0023 renders home_dir with it), but that is JavaScript and this is the only
# PowerShell in the launch path - there is no runtime the two share, so nothing
# can be imported here. It mirrors that function line for line rather than
# inventing a second rule, and setup\sandbox-logon-launcher.Tests.ps1 asserts it
# against the SAME examples tests\conversations-state.test.mjs asserts the
# original against, so the pair cannot drift without a red test.
#
# WHO NEEDS IT: New-SandboxEnvironmentBlock's PWD row. A being's shell echoes
# $PWD verbatim (measured 2026-09-23), so a Windows-form value would be quoted
# into the chat as C:\Users\egpt-sbx-09/egpt - mixed separators, worse than the
# junction path bash computes on its own.
function ConvertTo-MsysPath {
  param(
    # AllowEmptyString: '' is a legitimate input that must come back as '',
    # not as a parameter-binding exception the caller cannot act on.
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Path
  )
  $s = $Path -replace '\\', '/'
  if ($s -match '^([A-Za-z]):/(.*)$') { return "/$($Matches[1].ToLowerInvariant())/$($Matches[2])" }
  return $s
}

# THE LAUNCH SUMMARY (2026-09-23): the one launcher line sandbox-cli-session.mjs
# forwards to the daemon log on a SUCCESSFUL turn - every other launcher line
# reaches the log only when a turn fails. Leased account, the cwd the launch is
# handed, and what is REALLY at that cwd, read back here: the statement above
# plants with -EA 0, so a mount that did not land is silent everywhere else.
#   ok             a junction; target= is where it points
#   missing        nothing there
#   not-a-junction something there that is not the mount (target=-)
#   unreadable     THIS process cannot look. The launcher runs as the operator,
#                  and a pool profile is normally the account's alone (measured
#                  on reve 2026-09-23: Access is denied on C:\Users\egpt-sbx-08),
#                  so this is an honest "not known from here", never a guess.
# Paths and the account name only - nothing from -SetEnv ever reaches it.
function Get-SandboxLaunchSummary {
  param(
    [Parameter(Mandatory = $true)][string]$AccountName,
    [Parameter(Mandatory = $true)][string]$Cwd
  )
  $junction = 'missing'
  $target = '-'
  try {
    $item = Get-Item -LiteralPath $Cwd -Force -ErrorAction Stop
    if ($item.LinkType -eq 'Junction') { $junction = 'ok'; $target = "$($item.Target)" } else { $junction = 'not-a-junction' }
  } catch [System.Management.Automation.ItemNotFoundException] {
    # 'missing', as initialised
  } catch {
    $junction = 'unreadable'
    $target = "- ($($_.Exception.Message))"
  }
  return "launch account=$AccountName cwd=$Cwd junction=$junction target=$target"
}

# ---- THE FILE ID, AND WHY A LEDGER NEEDS ONE (2026-09-23).
#
# THE HOLE THIS CLOSES, measured on kg the day it was found. A lease grants one
# pool account a Modify ACE on exactly one conversation folder and records that
# PATH in its lock's ledger; the revoke looks the ACE up again by that path. A
# PATH IS A NAME, and NTFS carries a DACL through a rename - so renaming the
# folder leaves the ACE alive at the new name while the only record of it points
# at nothing:
#   egpt-sbx-08, -13 -> ...\conversations\whatsapp\Favel Konefka-2608141626
#   egpt-sbx-03, -04, -10 -> ...\conversations\whatsapp\Favel Elena Konefka-2608141626
# One conversation (the -2608141626 id is identical), renamed slug. The revoke
# reported 'missing', both callers read 'missing' as resolved, dropped the line
# and released the lock, and three pool accounts were left holding Modify on a
# conversation none of them was leased to - the exact cross-conversation exposure
# the lease design exists to prevent, re-opened one rename at a time.
#
# SO THE LEDGER RECORDS WHAT THE OBJECT IS, NOT ONLY WHAT IT IS CALLED. The name
# stays first and stays authoritative while it still names the same object; the
# id is what the revoke falls back to when it does not.
#
# ---- WHAT WAS MEASURED, unelevated as the operator on reve, 2026-09-23. All of
# it decided the shape below and none of it is reasoning:
#  * `fsutil file queryfileid <dir>` works on a DIRECTORY, UNELEVATED, and prints
#    the 128-bit id: 0x0000000000000000002900000008f38a. It agrees exactly with
#    GetFileInformationByHandleEx(FileIdInfo)'s FILE_ID_INFO.FileId - both were
#    run against the same directory and compared byte for byte.
#  * `fsutil file queryFileNameById <anydir-on-the-volume> <id>` FOLLOWS THE
#    RENAME, unelevated, and also follows a MOVE to a different parent. It
#    answers with the object's current path.
#  * A DELETED object answers `Error 87` and exit 1. That is the distinction this
#    whole block has to preserve: a folder that was deleted took its ACEs with it
#    and is genuinely resolved; a folder that was renamed did not.
#  * NTFS VALIDATES THE SEQUENCE NUMBER, which is the hazard that would otherwise
#    make this dangerous. A directory was created, its id recorded, deleted, and
#    the very next directory created REUSED its MFT record (the low 48 bits are
#    identical) with the sequence number bumped 0x0073 -> 0x0074. Resolving the
#    OLD id then returned Error 87 while the NEW id resolved. A recycled record
#    therefore CANNOT make a stale ledger line resolve to an innocent folder.
#  * OpenFileById via P/Invoke resolves the same thing, also unelevated, with the
#    128-bit ExtendedFileIdType and a hint handle to any directory on the volume
#    (the 64-bit FileIdType form is not needed and was not used). It is NOT what
#    this uses: fsutil is already the shape this file is built on - a native tool,
#    shelled to, spy-able in Pester exactly like icacls - and Add-Type costs a
#    C# compile (~130 ms measured, once per process) on the launcher's turn path
#    where fsutil costs ~14 ms per call. The P/Invoke buys precision this does not
#    need, because the round trip below re-checks every answer anyway.
#
# ---- NEVER ACT ON A HANDLE, ALWAYS ON A PATH. An id could be opened and its
# security descriptor written through the handle, and that would be a SECOND DACL
# writer in a file whose whole doctrine is "one icacls call, keyed by path, read
# back before and after". So the id is used for exactly one thing: to ask the
# filesystem what the object is CALLED NOW. What comes back is a path, and it
# goes through the same Revoke-SandboxPathAces as everything else.
#
# ---- THE VOLUME IS PART OF THE ID. A file id is unique within a volume and
# nowhere else, so the serial is recorded beside it and compared before a lookup.
# Measured the same day: Win32_LogicalDisk's VolumeSerialNumber for C: is
# 54118918, which is exactly the low half of FILE_ID_INFO's 64-bit
# VolumeSerialNumber 0x0854119754118918 - the same fact in two widths. The CIM
# read is ~137 ms, so it is cached per process and per drive letter; the launcher
# grants two paths on one volume, so it happens once.
$script:SandboxVolumeSerials = @{}
function Get-SandboxVolumeSerial {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path))
    # A UNC share has no drive letter and no file ids worth recording; '' means
    # "no volume identity", which every caller below treats as "do not check".
    if ($root -notmatch '^([A-Za-z]):\\$') { return '' }
    $drive = $Matches[1].ToUpperInvariant()
    if ($script:SandboxVolumeSerials.ContainsKey($drive)) { return $script:SandboxVolumeSerials[$drive] }
    $serial = ''
    try {
      $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$drive`:'" -ErrorAction Stop
      if ($disk -and $disk.VolumeSerialNumber) { $serial = ([string]$disk.VolumeSerialNumber).Trim().ToLowerInvariant() }
    } catch {
      # No serial is not an error: the id still works, it is just unconfirmed
      # which volume it came from. Cached as '' so a broken WMI is asked once.
      $serial = ''
    }
    $script:SandboxVolumeSerials[$drive] = $serial
    return $serial
  } catch { return '' }
}

# THE ID OF WHAT IS AT THIS PATH RIGHT NOW, as the one string the ledger stores:
# '<volume serial>:<32 hex digits>'. $null when it cannot be had, and $null is a
# FIRST-CLASS ANSWER, not a failure: the ledger line is then written exactly as
# it was before this change and the revoke behaves exactly as it did. Nothing
# here is allowed to cost a turn its grant.
#
# A REPARSE POINT IS DELIBERATELY REFUSED. fsutil follows a junction to its
# target, so the id of a link is the id of the thing it points AT, while the ACE
# this ledger is about sits on the LINK. Recording the target's id would let a
# renamed link resolve to the target and take ACEs off the wrong object. The
# launcher never grants on a junction anyway (an ACE on one would be an ACE on
# nothing), so this costs nothing real and removes the one case that could be
# wrong in the dangerous direction.
#
# A PATH WITH NO DRIVE LETTER IS REFUSED TOO, and for a sharper reason than
# tidiness: a UNC share has no volume this side of the wire to look an id up on,
# so an id recorded for one could never resolve - and an id that can never
# resolve reads as 'unknown', which is 'failed', which KEEPS THE LOCK FOR EVER.
# Recording nothing leaves such a path on the revoke-by-name path it has always
# been on, which is the honest answer rather than a permanent retry.
function Get-SandboxPathFileId {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $null }
    if ([System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path)) -notmatch '^[A-Za-z]:\\$') { return $null }
    # No 2>&1, for the reason Grant-SandboxPoolAce and Revoke-SandboxPathAces
    # both carry: PS 5.1 turns a redirected native stderr into NativeCommandError
    # records, which throw under the provisioner's $ErrorActionPreference='Stop'.
    $out = & fsutil.exe file queryfileid $Path
    if ($LASTEXITCODE -ne 0) { return $null }
    # PARSED WITHOUT THE ENGLISH. fsutil's wording is localised; the hex literal
    # is not. Any answer this misreads is caught by the round trip in
    # Resolve-SandboxFileId, which re-asks this same function about the path it
    # got back and refuses to act when the two disagree.
    $m = [regex]::Match(($out | Out-String), '0x([0-9a-fA-F]{1,32})')
    if (-not $m.Success) { return $null }
    $id = $m.Groups[1].Value.ToLowerInvariant().PadLeft(32, '0')
    if ($id -match '^0+$') { return $null }
    return "$(Get-SandboxVolumeSerial -Path $Path):$id"
  } catch { return $null }
}

# ARE THESE TWO RECORDS THE SAME OBJECT? Ids match, AND the volumes do not
# contradict each other. An empty serial on either side is "unknown", not
# "different" - an old ledger line and a WMI that would not answer both look like
# that, and neither is evidence of a mismatch. Two different volumes really can
# carry the same file id, which is the whole reason the serial is stored.
function Test-SandboxFileIdMatch {
  param([string]$Left, [string]$Right)
  if (-not $Left -or -not $Right) { return $false }
  $l = $Left.Split(':'); $r = $Right.Split(':')
  if ($l.Count -lt 2 -or $r.Count -lt 2) { return $false }
  if ($l[-1].ToLowerInvariant() -ne $r[-1].ToLowerInvariant()) { return $false }
  if ($l[0] -and $r[0] -and $l[0].ToLowerInvariant() -ne $r[0].ToLowerInvariant()) { return $false }
  return $true
}

# WHAT IS THIS OBJECT CALLED NOW? Returns { Status; Path; Message } with Status
# one of:
#   resolved  the object exists; Path is where it lives now, round-trip confirmed
#   gone      the filesystem says no such id on that volume. The object was
#             DELETED and its ACEs went with it - this one really is resolved,
#             and it is the distinction the 'missing' warning was written about.
#   unknown   it could not be looked up. NOT resolved, NOT proven gone: the
#             caller must keep the lease and retry rather than drop the line.
#
# THE VOLUME HINT IS THE NEAREST SURVIVING ANCESTOR of the recorded path, walked
# up until something exists. That is how the lookup stays on the volume the id
# came from without opening a device or guessing a drive letter - a renamed
# conversation folder still sits under the same ...\conversations\whatsapp, and
# in the worst case the walk reaches the drive root, which is always there.
#
# THE ROUND TRIP IS THE GUARANTEE, and it is why a localised fsutil or a parse
# that went wrong cannot cause a wrong revoke: whatever path comes back is asked
# for ITS OWN id, and unless that id is the one we were looking for, the answer
# is 'unknown' and nothing is written. Fail closed.
function Resolve-SandboxFileId {
  param(
    [Parameter(Mandatory = $true)][string]$FileId,
    [Parameter(Mandatory = $true)][string]$HintPath
  )
  $parts = $FileId.Split(':')
  if ($parts.Count -lt 2 -or -not $parts[-1]) {
    return [pscustomobject]@{ Status = 'unknown'; Path = $null; Message = "the ledger's file id '$FileId' is not in the '<volume serial>:<id>' form this can look up" }
  }
  $serial = $parts[0]
  $id = $parts[-1]
  try {
    $hint = [System.IO.Path]::GetFullPath($HintPath)
    while ($hint -and -not (Test-Path -LiteralPath $hint)) {
      $parent = [System.IO.Path]::GetDirectoryName($hint)
      if (-not $parent -or $parent -eq $hint) { $hint = $null; break }
      $hint = $parent
    }
    if (-not $hint) {
      return [pscustomobject]@{ Status = 'unknown'; Path = $null; Message = "nothing on the way up from '$HintPath' still exists, so there is no volume to ask about file id $id" }
    }
    if ($serial) {
      $now = Get-SandboxVolumeSerial -Path $hint
      if ($now -and $now -ne $serial.ToLowerInvariant()) {
        return [pscustomobject]@{ Status = 'unknown'; Path = $null; Message = "the volume behind '$hint' is serial $now, not the $serial this id was taken from - a file id means nothing on another volume, so nothing was looked up" }
      }
    }
    $out = & fsutil.exe file queryFileNameById $hint "0x$id"
    if ($LASTEXITCODE -ne 0) {
      return [pscustomobject]@{ Status = 'gone'; Path = $null; Message = "file id $id no longer exists on that volume, so the object itself was DELETED and took its ACEs with it" }
    }
    # Locale-free again: the answer is the only thing in the output shaped like a
    # rooted path. \\?\ is how the API spells it; icacls and Get-Acl want it off.
    $m = [regex]::Match(($out | Out-String), '(\\\\\?\\[^\r\n]+|[A-Za-z]:\\[^\r\n]+)')
    if (-not $m.Success) {
      return [pscustomobject]@{ Status = 'unknown'; Path = $null; Message = "file id $id resolved, but no path could be read out of what fsutil answered ($(($out | Out-String).Trim()))" }
    }
    $found = $m.Groups[1].Value.Trim()
    if ($found.StartsWith('\\?\UNC\')) { $found = '\\' + $found.Substring(8) }
    elseif ($found.StartsWith('\\?\')) { $found = $found.Substring(4) }
    $back = Get-SandboxPathFileId -Path $found
    if (-not (Test-SandboxFileIdMatch $back $FileId)) {
      return [pscustomobject]@{ Status = 'unknown'; Path = $null; Message = "file id $id was answered with '$found', but that path's own id reads '$back' - the two disagree, so nothing was touched" }
    }
    return [pscustomobject]@{ Status = 'resolved'; Path = $found; Message = "file id $id is now at '$found'" }
  } catch {
    return [pscustomobject]@{ Status = 'unknown'; Path = $null; Message = "file id $id could not be looked up - $($_.Exception.Message)" }
  }
}

# ---- THE LEASE LEDGER, and the ACE revoke that rides the stale-lease reclaim
# (operator 2026-09-11). These five functions live HERE, beside
# Get-SandboxPoolLeaseOrder, because they are lease machinery and because
# sandbox-account.ps1 is the only half of the sandbox that is dot-sourceable -
# sandbox-logon-launcher.ps1 has a param block and runs, so nothing can unit
# test it. setup/sandbox-account.Tests.ps1 exercises all five for real.
#
# THE PROBLEM THEY CLOSE. The launcher grants the leased pool account an ACE on
# TargetFolder and on each shared path (Modify, or ReadAndExecute for a
# -SharePathReadOnly entry), and revokes them in its
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
$SandboxLeaseLedgerHeader = '# egpt sandbox lease ledger - one granted path per line, each holding an explicit ACE (Modify, or ReadAndExecute for a read-only share path) to this lock''s pool account, written by the turn holding it. A line may carry the path''s NTFS file id after a ''|'' (|fid=<volume serial>:<id>); that is what follows the ACE when the folder is RENAMED, since NTFS carries a DACL through a rename and the name then finds nothing. A RECLAIM of this lock revokes them - by SID, whatever rights they carry: the turn that wrote them was hard-killed before its own release ran. Deleted with the lock on a clean release.'

# ---- THE LINE FORMAT, AND THE OLD LEDGERS IT MUST NOT BREAK (2026-09-23).
#
#   C:\Users\an\.egpt\conversations\whatsapp\Favel Konefka-2608141626
#   C:\Users\an\.egpt\conversations\whatsapp\Favel Konefka-2608141626|fid=54118918:0000000000000000002900000008f38a
#
# THE PATH IS STILL FIRST AND STILL WHOLE, so what an operator reads in a lock
# file is what it always was. Everything after the first '|' is machinery.
#
# '|' IS THE SEPARATOR BECAUSE IT CANNOT BE IN A PATH. Windows reserves
# \ / : * ? " < > | in a file name, so a '|' in a ledger line is never part of
# the path and the split can never be ambiguous. (A tab can be in an NTFS name;
# that is why it is not this.)
#
# A LINE WITH NO '|' IS AN OLD LEDGER LINE and reads as a path with no id, which
# is exactly what every lock written before today holds. Those leases behave
# precisely as they did: revoke by path, and 'missing' - with its "this cannot
# tell a delete from a rename" message - when the name finds nothing. Nothing
# about this change invents an id for a grant that never recorded one.
# UNKNOWN FIELDS ARE IGNORED rather than rejected, so a future field cannot make
# today's code refuse a ledger it could otherwise clean up.
function ConvertTo-SandboxLeaseLedgerLine {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$FileId = ''
  )
  $p = $Path.Trim()
  if (-not $FileId) { return $p }
  return "$p|fid=$($FileId.Trim())"
}

function ConvertFrom-SandboxLeaseLedgerLine {
  param([Parameter(Mandatory = $true)][string]$Line)
  $text = $Line.Trim()
  $cut = $text.IndexOf('|')
  if ($cut -lt 0) { return [pscustomobject]@{ Path = $text; FileId = '' } }
  $path = $text.Substring(0, $cut).Trim()
  $fileId = ''
  foreach ($field in @($text.Substring($cut + 1) -split '\|')) {
    $f = $field.Trim()
    if ($f.StartsWith('fid=', [System.StringComparison]::OrdinalIgnoreCase)) { $fileId = $f.Substring(4).Trim() }
  }
  return [pscustomobject]@{ Path = $path; FileId = $fileId }
}

# Read the ledger back AS ENTRIES - { Path, FileId } - which is what every
# revoke below actually wants. Comment lines and blanks are skipped, so an EMPTY
# or pre-ledger lock file (every lock written before 2026-09-11 is 0 bytes) reads
# as zero entries rather than as an error - honest: those turns' ACEs were never
# recorded and this cannot invent them.
#
# Leaves the stream positioned at the end, so an Add- straight afterwards
# appends rather than overwrites. NO leading comma on the return, for the same
# reason Get-SandboxPoolLeaseOrder documents above: `return ,$out` puts a NESTED
# array on the pipeline, and every call site here is an @(...) that would then
# collect ONE element - the whole list as a single object. Callers wrap in @().
function Read-SandboxLeaseLedgerEntries {
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
  $out = @($text -split "`r?`n" |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith('#') } |
    ForEach-Object { ConvertFrom-SandboxLeaseLedgerLine -Line $_ } |
    Where-Object { $_.Path })
  return $out
}

# THE PATHS ONLY, and it is a PROJECTION of the reader above rather than a
# second parser - one ledger, one thing that knows how a line is spelled. Kept
# because it is the honest answer to "what did that turn grant?", which is what
# the operator sweep's -WhatIf and every existing caller asks.
function Read-SandboxLeaseLedger {
  param([Parameter(Mandatory = $true)][System.IO.FileStream]$Stream)
  $out = @(Read-SandboxLeaseLedgerEntries -Stream $Stream | ForEach-Object { $_.Path })
  return $out
}

# Replace the whole ledger: truncate, header, then these lines. Used twice - to
# stamp a header on a freshly CreateNew'd lock, and to rewrite a reclaimed one
# with whatever the revoke could NOT clear (see Clear-SandboxStaleLease).
#
# -Paths OR -Entries, and the difference is only whether the ids survive the
# rewrite. -Paths is the old contract, unchanged, and writes path-only lines.
# -Entries takes { Path, FileId } records and keeps the id on the line, which is
# what every carry-over must use: a path the revoke could NOT clear is still
# leaking, and rewriting it WITHOUT its id would hand the next reclaim back the
# bare name - re-opening, on the retry, exactly the hole the id was recorded to
# close.
#
# Flush($true) is flush-TO-DISK, not flush-to-cache, and it is the whole point:
# the reader of this file is the launcher that runs after this process was
# killed, so anything still sitting in a buffer is anything still leaking.
function Write-SandboxLeaseLedger {
  param(
    [Parameter(Mandatory = $true)][System.IO.FileStream]$Stream,
    [string[]]$Paths = @(),
    [object[]]$Entries = @()
  )
  $written = @()
  if ($Entries -and $Entries.Count -gt 0) {
    $written = @($Entries |
      Where-Object { $_ -and $_.Path -and "$($_.Path)".Trim() } |
      ForEach-Object { ConvertTo-SandboxLeaseLedgerLine -Path "$($_.Path)" -FileId "$($_.FileId)" })
  } else {
    $written = @($Paths | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
  }
  $lines = @($SandboxLeaseLedgerHeader) + $written
  $bytes = [System.Text.Encoding]::UTF8.GetBytes((($lines -join "`r`n") + "`r`n"))
  $Stream.SetLength(0)
  $Stream.Position = 0
  $Stream.Write($bytes, 0, $bytes.Length)
  $Stream.Flush($true)
}

# Append ONE path, with the id of the object it names when one could be had. The
# launcher calls this BEFORE the matching grant, so the ledger is a SUPERSET of
# what actually landed - the safe direction for a crash log. A grant that threw
# leaves no ACE behind, and Revoke-SandboxLeaseAces skips a path that carries
# none, so the superset costs a read and never a stray write.
#
# -FileId IS OPTIONAL AND ITS ABSENCE IS NOT AN ERROR. A path whose id cannot be
# read (a junction, a filesystem without ids, an fsutil that would not answer)
# is recorded the way it always was. A turn must never fail, or lose a grant,
# over a cleanup optimisation.
function Add-SandboxLeaseLedgerPath {
  param(
    [Parameter(Mandatory = $true)][System.IO.FileStream]$Stream,
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$FileId = ''
  )
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(((ConvertTo-SandboxLeaseLedgerLine -Path $Path -FileId $FileId) + "`r`n"))
  $Stream.Position = $Stream.Length
  $Stream.Write($bytes, 0, $bytes.Length)
  $Stream.Flush($true)
}

# THE ONE REVOKE IMPLEMENTATION, AND IT IS KEYED BY PATH, NOT BY ACCOUNT
# (operator 2026-09-20). Every revoke in the sandbox ends here - the launcher's
# finally on the normal path, the launcher's per-account reclaim on the hard-kill
# path, and the provisioner's pool-wide sweep - so the three can never drift into
# disagreeing about what "revoked" means. They differ only in how they GROUP the
# work before calling it: one account and its paths, or one path and every
# account that leaked an ACE onto it.
#
# WHY THE PATH IS THE KEY. Writing a DACL on a container makes Windows re-run
# inheritance propagation over the whole subtree (see Grant-SandboxPoolAce's
# header for the measurement), so the cost of a revoke is the TREE, not the ACE.
# The old shape was one Set-Acl per ACCOUNT, and the sweep found fifteen
# abandoned leases with twelve of them naming ~\src\egpt - so it walked that tree
# twelve times, silently, which is what the operator read as a hang. MEASURED BY
# HAND on reve the same day, same tree, same twelve accounts:
#   icacls ~\src\egpt /remove:g egpt-sbx-00 ... egpt-sbx-15 /C  -> 2 s, all 12 gone
# One pass, every account named on it. That is this function, and it is why
# Set-Acl is gone from the revoke: icacls expresses the change exactly. The
# grants converged on the same tool afterwards (see Grant-SandboxPoolAce), so
# every DACL write in the sandbox is now one icacls call, and
# Protect-SandboxCredDir is the only .NET writer left.
#
# NO /T, deliberately: a lease ACE is explicit and on the named object only, so
# recursing would re-walk the tree for nothing. /remove:g and not /remove:
# only GRANTED (Allow) ACEs are ours to take back; a Deny on one of these paths
# was put there by something that is not this lease.
#
# BY SID, never by name ('*' is icacls's SID-literal prefix) - an orphaned SID
# that no longer resolves must still be removable, the same reason
# Protect-SandboxCredDir enumerates by SID.
#
# THE DACL DECIDES, NOT THE EXIT CODE (operator 2026-09-20: "a revoke of an ACE
# that is already gone is SUCCESS, not failure"). The explicit DACL is read
# before and after. An account carrying no explicit ACE is 'clean' and costs NOT
# ONE WRITE - which is what makes the fifteen locks whose ACEs the operator had
# already removed by hand clear in milliseconds instead of minutes - and an
# account whose ACE is gone afterwards is 'revoked' even if icacls exited
# non-zero over some unrelated entry. Only an ACE still standing is 'failed'.
#
# RETURNS RECORDS, LOGS NOTHING. The "sandbox-logon-launcher:" prefix belongs to
# the launcher, and a function that writes to a host's stderr cannot be asserted
# on in Pester. One record per account,
# { Path, ResolvedPath, FileId, Account, Sid, Status, Message }, with Status one
# of:
#   revoked  explicit ACEs for this account were there and are gone
#   clean    the path exists and carried none - nothing was written
#   missing  the path is gone FROM THAT NAME. See the warning below - this is
#            only equivalent to "no ACE survives" when the folder was DELETED,
#            which -FileId below is what finally tells apart.
#   failed   it could not be done, and the ACE may well still be there
# Path is ALWAYS the path the caller passed - it is the ledger's key and the
# sweep groups on it, so it must not move under a caller. ResolvedPath is where
# the ACE was really found when the id had to be followed, and $null otherwise.
# A 'failed' is the only one a caller must act on, and it must never be
# swallowed: the path is still granted.
#
# EXPLICIT RULES ONLY ($false for the inherited ones) on both reads: an inherited
# ACE is not this lease's to remove and icacls could not take it off the child
# anyway.
#
# ---- 'missing' IS NOT ALWAYS CLEAN, AND THAT IS A REAL HOLE, NAMED RATHER THAN
# PAPERED OVER (found 2026-09-23 while diagnosing why the reclaim was not
# keeping up). A ledger holds a path, and a path is a NAME. Rename the folder and
# NTFS carries its DACL with it - so the leaked ACE is alive at the new name
# while the only record of it, this ledger line, resolves to nothing. Both
# callers then treat 'missing' as resolved, drop the line and release the lock,
# and the ACE becomes UNFINDABLE: nothing on the box still names it.
# MEASURED on kg 2026-09-23, straight out of the live lock ledgers:
#   egpt-sbx-08.lock, egpt-sbx-13.lock -> ...\conversations\whatsapp\Favel Konefka-2608141626
#   egpt-sbx-03/-04/-10.lock           -> ...\conversations\whatsapp\Favel Elena Konefka-2608141626
# Same conversation (the -2608141626 id is identical), renamed display slug. Two
# of those five ledgers name a folder that is not there any more, and the ACEs
# they were written to revoke rode the rename.
#
# ---- -FileId IS THE FIX (2026-09-23, later the same day). A name is no longer
# all this is given: the ledger now records the granted object's NTFS file id
# beside its path, and an id survives a rename and a move because it IS the
# object (see the file-id block above for everything that was measured). So:
#
#   THE NAME IS TRIED FIRST AND IS STILL AUTHORITATIVE WHEN IT IS RIGHT. If the
#   path exists and its id is the recorded one, this is the same function it was
#   - one Get-Acl, one icacls pass, no lookup in the middle of the hot path.
#
#   THE ID IS THE FALLBACK, AND ALSO THE ARBITER. It is consulted when the path
#   is gone OR when the path exists and names a DIFFERENT object, which is the
#   rename-then-recreate case: a new folder wearing the old name must never be
#   the thing an old lease's ACEs are stripped from.
#
#   AN ID THAT RESOLVES TO NOTHING IS A DELETED FOLDER, and a deleted folder
#   took its ACEs with it. That is 'missing' and it is genuinely resolved -
#   measured, not assumed: NTFS answers Error 87 for an id that no longer
#   exists, and it validates the sequence number, so a recycled MFT record
#   cannot make a stale id resolve to an innocent folder.
#
#   AN ID THAT CANNOT BE LOOKED UP AT ALL IS 'failed', NOT 'missing'. Unknown is
#   not resolved. The lock is kept, the line is kept, the next reclaim retries -
#   the one direction that cannot lose a leak.
#
# WITHOUT -FileId NOTHING CHANGES, which is the whole back-compatibility story:
# every lock written before today holds bare paths, and for those this is
# exactly the function it was, 'missing' message included.
function Revoke-SandboxPathAces {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string[]]$AccountNames = @(),
    # '<volume serial>:<32 hex>' as the ledger stores it. Empty = an old ledger
    # line, or a path whose id could not be read at grant time.
    [string]$FileId = ''
  )
  $names = @($AccountNames | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() } | Select-Object -Unique)
  $records = New-Object System.Collections.Generic.List[object]
  if ($names.Count -eq 0) { return @() }
  # Resolve every principal FIRST. One that cannot be named cannot be purged, and
  # it is reported 'failed' rather than quietly skipped - the path is still
  # granted to an account that exists as far as the filesystem is concerned.
  $sids = @{}
  foreach ($n in $names) {
    try { $sids[$n] = (New-Object System.Security.Principal.NTAccount($n)).Translate([System.Security.Principal.SecurityIdentifier]) }
    catch { [void]$records.Add([pscustomobject]@{ Path = $Path; ResolvedPath = $null; FileId = $FileId; Account = $n; Sid = $null; Status = 'failed'; Message = "could not resolve the SID of '$n' - $($_.Exception.Message)" }) }
  }
  $named = @($names | Where-Object { $sids.ContainsKey($_) })
  if ($named.Count -eq 0) { return $records.ToArray() }
  # WHERE THE ACE ACTUALLY IS, which is the ledger path until the id says
  # otherwise. $resolved stays $null on the ordinary path, so a record only
  # carries a ResolvedPath when this really did follow the object somewhere.
  $target = $Path
  $resolved = $null
  if ($FileId) {
    $follow = $true
    if (Test-Path -LiteralPath $Path) {
      $here = Get-SandboxPathFileId -Path $Path
      # NO ID READABLE HERE is not evidence of a rename - a junction, or an
      # fsutil that would not answer. Trust the name, exactly as before.
      if (-not $here -or (Test-SandboxFileIdMatch $here $FileId)) { $follow = $false }
    }
    if ($follow) {
      $found = Resolve-SandboxFileId -FileId $FileId -HintPath $Path
      if ($found.Status -eq 'resolved') {
        $target = $found.Path
        $resolved = $found.Path
      } elseif ($found.Status -eq 'gone') {
        foreach ($n in $named) {
          [void]$records.Add([pscustomobject]@{ Path = $Path; ResolvedPath = $null; FileId = $FileId; Account = $n; Sid = $sids[$n].Value; Status = 'missing'; Message = "$($found.Message) - nothing to revoke" })
        }
        return $records.ToArray()
      } else {
        foreach ($n in $named) {
          [void]$records.Add([pscustomobject]@{ Path = $Path; ResolvedPath = $null; FileId = $FileId; Account = $n; Sid = $sids[$n].Value; Status = 'failed'; Message = "the recorded path is not this object any more and its file id could not be followed, so the ACE is neither found nor proven gone - $($found.Message)" })
        }
        return $records.ToArray()
      }
    }
  }
  try {
    if (-not (Test-Path -LiteralPath $target)) {
      foreach ($n in $named) {
        [void]$records.Add([pscustomobject]@{ Path = $Path; ResolvedPath = $resolved; FileId = $FileId; Account = $n; Sid = $sids[$n].Value; Status = 'missing'; Message = 'nothing is at that path any more. If the folder was DELETED its ACEs went with it and this is clean; if it was RENAMED or MOVED, NTFS carried its DACL along and this account is STILL granted at the new name, which nothing now records. This cannot tell the two apart.' })
      }
      return $records.ToArray()
    }
    # THE PRESENCE CHECK IS THE DOCTRINE, not an optimisation: "a path that was
    # missing, or whose grant threw, must not be touched on the way out -
    # re-ACLing a folder this turn never modified is how a cleanup path turns
    # into a bug." One read covers every account on this path.
    # -ErrorAction Stop on BOTH reads, deliberately: Get-Acl is non-terminating
    # by default, so a DACL this process cannot read would otherwise come back as
    # an EMPTY rule set - i.e. every account reported 'clean' and the leak
    # forgotten. It has to land in the catch below and be reported 'failed'.
    $before = @((Get-Acl -LiteralPath $target -ErrorAction Stop).GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value })
    $targets = @($named | Where-Object { $before -contains $sids[$_].Value })
    foreach ($n in @($named | Where-Object { $targets -notcontains $_ })) {
      [void]$records.Add([pscustomobject]@{ Path = $Path; ResolvedPath = $resolved; FileId = $FileId; Account = $n; Sid = $sids[$n].Value; Status = 'clean'; Message = 'no explicit ACE for this account was on it - nothing written' })
    }
    if ($targets.Count -eq 0) { return $records.ToArray() }
    # No 2>&1: PS 5.1 turns a redirected native stderr into NativeCommandError
    # records, which under the provisioner's $ErrorActionPreference='Stop' throws
    # something unrelated to what went wrong (the same note Grant-SandboxPoolAce
    # carries). Capturing stdout also keeps icacls's chatter off the launcher's
    # stdout, which is the inner process's stream-json pipe.
    $icaclsArgs = @($target, '/remove:g') + @($targets | ForEach-Object { "*$($sids[$_].Value)" }) + @('/C')
    $out = & icacls.exe @icaclsArgs
    $code = $LASTEXITCODE
    $after = @((Get-Acl -LiteralPath $target -ErrorAction Stop).GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value })
    $followed = if ($resolved) { " (followed by file id from '$Path' to '$resolved')" } else { '' }
    foreach ($n in $targets) {
      if ($after -contains $sids[$n].Value) {
        [void]$records.Add([pscustomobject]@{ Path = $Path; ResolvedPath = $resolved; FileId = $FileId; Account = $n; Sid = $sids[$n].Value; Status = 'failed'; Message = "the explicit ACE is STILL there after icacls /remove:g (exit $code)$followed - $($out -join ' ')" })
      } else {
        [void]$records.Add([pscustomobject]@{ Path = $Path; ResolvedPath = $resolved; FileId = $FileId; Account = $n; Sid = $sids[$n].Value; Status = 'revoked'; Message = "explicit ACE(s) removed in one icacls pass over $($targets.Count) account(s)$followed" })
      }
    }
  } catch {
    # Whatever is left unaccounted for is still granted. Say so per account
    # rather than throwing: one unpurgeable path must not cost the caller's other
    # paths their cleanup.
    $done = @($records | ForEach-Object { $_.Account })
    foreach ($n in @($named | Where-Object { $done -notcontains $_ })) {
      [void]$records.Add([pscustomobject]@{ Path = $Path; ResolvedPath = $resolved; FileId = $FileId; Account = $n; Sid = $sids[$n].Value; Status = 'failed'; Message = $_.Exception.Message })
    }
  }
  return $records.ToArray()
}

# ONE ACCOUNT, ITS OWN PATHS - the shape the launcher's finally and its
# per-account reclaim want. A thin grouping over Revoke-SandboxPathAces above and
# NOT a second revoke: one call per path, the same records, in the order the
# caller listed them. A path that cannot be purged does not cost the paths after
# it their cleanup, because Revoke-SandboxPathAces reports rather than throws.
#
# -Paths OR -Entries, exactly as Write-SandboxLeaseLedger takes them and for the
# same reason: -Entries carries each path's file id through to the revoke, so a
# renamed folder is followed; -Paths is the old contract and revokes by name
# alone. A ledger read gives entries, so the callers that matter pass those.
function Revoke-SandboxLeaseAces {
  param(
    [Parameter(Mandatory = $true)][string]$AccountName,
    [string[]]$Paths = @(),
    [object[]]$Entries = @()
  )
  $wanted = @()
  if ($Entries -and $Entries.Count -gt 0) {
    $wanted = @($Entries |
      Where-Object { $_ -and $_.Path -and "$($_.Path)".Trim() } |
      ForEach-Object { [pscustomobject]@{ Path = "$($_.Path)".Trim(); FileId = "$($_.FileId)".Trim() } })
  } else {
    $wanted = @($Paths |
      Where-Object { $_ -and $_.Trim() } |
      ForEach-Object { [pscustomobject]@{ Path = $_.Trim(); FileId = '' } })
  }
  if ($wanted.Count -eq 0) { return @() }
  $records = New-Object System.Collections.Generic.List[object]
  foreach ($e in $wanted) {
    foreach ($rec in @(Revoke-SandboxPathAces -Path $e.Path -FileId $e.FileId -AccountNames @($AccountName))) { [void]$records.Add($rec) }
  }
  return $records.ToArray()
}

# WHAT A CARRY-OVER LINE MUST SAY, in one place because three callers write one
# (the launcher's finally, the per-account reclaim, the pool sweep). A record
# that could not be cleared goes back on the ledger as:
#   * the path the ACE is really at, if the id had to be followed to find it -
#     so the next reclaim starts from the CURRENT name and the operator reading
#     the lock file sees the folder that actually carries the grant
#   * and its file id, always, because a retry without the id is a retry with
#     the hole back open.
function ConvertTo-SandboxLeaseCarryEntry {
  param([Parameter(Mandatory = $true)][object]$Record)
  $path = if ($Record.ResolvedPath) { $Record.ResolvedPath } else { $Record.Path }
  return [pscustomobject]@{ Path = $path; FileId = "$($Record.FileId)" }
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
  $ledger = @(Read-SandboxLeaseLedgerEntries -Stream $Stream)
  $records = @(Revoke-SandboxLeaseAces -AccountName $AccountName -Entries $ledger)
  $carry = @($records | Where-Object { $_.Status -eq 'failed' } | ForEach-Object { ConvertTo-SandboxLeaseCarryEntry -Record $_ })
  Write-SandboxLeaseLedger -Stream $Stream -Entries $carry
  return $records
}

# THE SAME RECLAIM, OVER THE WHOLE LOCKS DIRECTORY AT ONCE - and the answer to
# the one case Clear-SandboxStaleLease above structurally cannot reach.
#
# THE HOLE IT CLOSES (measured on kg 2026-09-20: TWELVE standing
# `(OI)(CI)(RX)` ACEs on ~\src\egpt, one per pool account). A sandboxed lease is
# held for the lifetime of the warm CLI process, and that process is ENDED BY
# TerminateProcess - warm-cli-session.mjs's close() calls proc.kill(), and on
# Windows every signal is TerminateProcess. So the launcher's `finally` does NOT
# run at the ordinary end of a sandboxed session: the hard-kill path is the
# NORMAL path here, not the exceptional one, and the reclaim is what actually
# does the revoking.
#
# But the reclaim is keyed to ONE account and fires only when THAT account is
# leased again. A conversation that goes quiet - or a being that is retired, or a
# pool name a shuffle simply does not reach - leaves its lock and its ACEs
# standing indefinitely. A path shared by MANY conversations (a being's
# `allowed_paths` entry, e.g. ~\src\egpt) therefore collects one ACE per pool
# account that ever ran that being, which is exactly what was found.
#
# ---- IT IS NOW ALSO WHAT THE LAUNCHER CALLS, ONCE, PER LEASE (2026-09-23), and
# that is the actual fix for the leak rather than a bigger broom. WHY IT CHANGED:
# the per-account reclaim above is keyed to one account and fires only when THAT
# account is leased again, so the accounts that leak and then go quiet keep their
# ACEs for ever. MEASURED on kg 2026-09-23, before this change, from the live
# artefacts and not from reasoning:
#   * 14 of the 16 pool locks exist and NOT ONE is held - every one opens
#     exclusively, i.e. every one is a turn that died without running its finally.
#   * each of those 14 ledgers names exactly 2 paths (a Room and a
#     ~\.egpt-jsonl\<thread> store), and every one of those 14 ACEs is STILL on
#     disk: 9 distinct thread stores carrying 14 explicit egpt-sbx-NN ACEs, one
#     store carrying three different pool accounts at once.
# So the reclaim is not broken - it is never reached. Nothing was going to
# revoke those 14 until the same account happened to be leased again, and two of
# the locks had been sitting for two days.
#
# AND IT STILL MUST NOT PUT AN ACL WALK ON THE TURN PATH, which is what kept it
# off there before. Two things make that safe now, and they are the price of the
# ruling that retired the ~\src grant (see Get-SandboxProfileJunctionStatement):
#   * the big trees are GONE from the ledgers. ~\src\egpt is reached through a
#     STANDING group grant, so it is never granted per lease and never written
#     into one. What is left on a ledger is a Room and a thread store - small
#     folders, measured in milliseconds, not the 307 s ~\src cost.
#   * -TimeBudgetSeconds. Phase 2 checks it before it STARTS each path (never in
#     the middle of one - an icacls pass is not interruptible), and whatever it
#     did not reach is DEFERRED: carried in the ledger, lock kept, retried by the
#     next turn or by the operator sweep. A turn can therefore be slow once; it
#     cannot be slow without limit.
# The launcher runs this AFTER its own lease is taken, so a sweep can never cost
# a turn its account - and its own lock is held FileShare::None, so this reports
# it 'held' and steps over it with no special case (the same staleness test, used
# on ourselves).
#
# IT IS ALSO STILL THE OPERATOR'S REPAIR PATH, unchanged and unbudgeted:
# setup/sweep-sandbox-leases.ps1 (and provision-sandbox-account.ps1's last step)
# call it with no budget, so they finish the job however long it takes. Same
# function, same definition of "revoked", no second lifecycle.
#
# A LIVE LEASE IS NEVER TOUCHED. The staleness test is the launcher's own and is
# exact in both directions: an exclusive open (FileShare::None) succeeds only
# when no handle is on the file. A lock a running turn holds fails that open and
# is reported 'held', untouched - and while THIS process holds one, a launcher
# racing for the same account sees it as live and walks on to the next name.
#
# The lock FILE is removed only when the revoke left nothing behind. A lock whose
# ledger still names a path that could NOT be revoked is kept, ledger and all, so
# the next reclaim - here or in the launcher - retries instead of forgetting.
#
# GROUPED BY PATH, IN THREE PHASES, and that is the whole reason this does not
# call Clear-SandboxStaleLease the way the launcher's one-account reclaim does
# (operator 2026-09-20). The leak is many ACCOUNTS on ONE shared path - twelve
# pool accounts on ~\src\egpt - and Revoke-SandboxPathAces takes all twelve off
# in a single icacls pass, 2 s against the minutes twelve separate Set-Acl passes
# cost. A revoke batched ACROSS locks cannot sit behind a per-lock helper, so the
# phases are here; what they call is still the one shared revoke, and the ledger
# read and rewrite are still Read-/Write-SandboxLeaseLedger.
#   1. take every stale lock exclusively and read its ledger  (no ACL writes yet)
#   2. one icacls pass per PATH, naming every account that leaked onto it
#   3. per lock: rewrite the ledger with what failed OR was not reached, release
#      it only when neither
# Phase 1 holds all the locks open until phase 3 finishes, which is exactly the
# same promise a single reclaim makes: while this process holds a lock, a
# launcher racing for that account sees a live lease and walks on to another name.
#
# IT SAYS WHERE IT IS (operator 2026-09-20, "please make script show progress").
# Every phase-2 pass announces the path, the number of accounts and its own
# elapsed seconds BEFORE and AFTER, because one of these can be a tree that takes
# minutes and silence there is what got read as a hang.
function Clear-SandboxAbandonedLeases {
  param(
    [string]$LocksDir = $SandboxLocksDir,
    # 0 (the default) = no budget, finish the job - what the provisioner and the
    # operator sweep want. Any other value caps how long phase 2 may keep
    # STARTING new paths, which is what makes this callable from the lease path.
    # It is not a timeout: a pass already running is always allowed to finish,
    # because an icacls call cannot be abandoned half way and leave a DACL in a
    # state anything could reason about.
    [double]$TimeBudgetSeconds = 0
  )
  $records = New-Object System.Collections.Generic.List[object]
  $budget = [System.Diagnostics.Stopwatch]::StartNew()
  if (-not (Test-Path -LiteralPath $LocksDir)) { return @() }
  $lockFiles = @(Get-ChildItem -LiteralPath $LocksDir -Filter '*.lock' -File -ErrorAction SilentlyContinue)
  if ($lockFiles.Count -eq 0) {
    Log "lease sweep: no lock files in $LocksDir - nothing to reclaim"
    return @()
  }

  # ---- phase 1: take what is stale, read what it says. No ACL is touched here.
  Log "lease sweep: $($lockFiles.Count) lock file(s) in $LocksDir - reading their ledgers"
  $leases = New-Object System.Collections.Generic.List[object]
  $n = 0
  foreach ($file in $lockFiles) {
    $n++
    $account = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    # The lock's NAME is what the revoke is aimed at, so it is guarded before it
    # is used - the same prefix guard Get-SandboxProfilePath puts first, for the
    # same reason: nothing reachable from here may purge ACEs belonging to 'an',
    # 'Administrator', or anything else that is not a pool account.
    if (-not $account.StartsWith($SandboxPoolPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      Log "lease sweep $n/$($lockFiles.Count): $($file.Name) is not a pool lease lock - skipped"
      [void]$records.Add([pscustomobject]@{ Account = $account; Lock = $file.FullName; Status = 'skipped'; Message = "not a pool lease lock - its name does not start with '$SandboxPoolPrefix'"; Aces = @() })
      continue
    }
    $stream = $null
    try {
      $stream = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    } catch {
      Log "lease sweep $n/$($lockFiles.Count): $account is LIVE - a process still holds its lease, left alone"
      [void]$records.Add([pscustomobject]@{ Account = $account; Lock = $file.FullName; Status = 'held'; Message = 'a process still holds this lease open - left alone'; Aces = @() })
      continue
    }
    try {
      # ENTRIES, not bare paths: a ledger line may carry the granted object's
      # file id, and that is what lets phase 2 follow a folder that was renamed
      # after the ACE was written. A line without one is an old ledger's line
      # and is revoked by name exactly as it always was.
      $ledger = @(Read-SandboxLeaseLedgerEntries -Stream $stream)
    } catch {
      $stream.Close()
      Log "lease sweep $n/$($lockFiles.Count): $account - its ledger could not be read ($($_.Exception.Message))"
      [void]$records.Add([pscustomobject]@{ Account = $account; Lock = $file.FullName; Status = 'failed'; Message = $_.Exception.Message; Aces = @() })
      continue
    }
    Log "lease sweep $n/$($lockFiles.Count): $account is abandoned - $($ledger.Count) path(s) on its ledger"
    [void]$leases.Add([pscustomobject]@{ Account = $account; Lock = $file.FullName; Stream = $stream; Entries = $ledger })
  }

  try {
    # ---- phase 2: one pass per PATH, every account that leaked onto it named in it.
    $byPath = [ordered]@{}
    foreach ($lease in $leases) {
      foreach ($e in $lease.Entries) {
        # Pure string math, used ONLY as the grouping key - icacls is still handed
        # the ledger's own spelling of the path, the first one seen for it.
        #
        # THE FILE ID IS PART OF THE KEY, and it has to be: two leases naming the
        # same path with DIFFERENT ids are two different objects (a folder
        # deleted and a new one created under the old name), and batching them
        # into one pass would revoke both leases' accounts off whichever object
        # the first entry's id points at. Same path, same id - or no id on
        # either, which is how every old ledger groups, exactly as before.
        $key = $e.Path.ToLowerInvariant().TrimEnd('\') + '|' + $e.FileId
        if (-not $byPath.Contains($key)) { $byPath[$key] = [pscustomobject]@{ Path = $e.Path; FileId = $e.FileId; Accounts = (New-Object System.Collections.Generic.List[string]) } }
        if (-not $byPath[$key].Accounts.Contains($lease.Account)) { [void]$byPath[$key].Accounts.Add($lease.Account) }
      }
    }
    $aceByKey = @{}
    $pathNo = 0
    $deferred = 0
    if ($byPath.Count -gt 0) { Log "lease sweep: revoking across $($byPath.Count) distinct path(s) - one icacls pass each, whatever the number of accounts on it" }
    foreach ($key in @($byPath.Keys)) {
      $pathNo++
      $entry = $byPath[$key]
      # THE BUDGET IS CHECKED HERE AND NOWHERE ELSE - before a pass starts, never
      # during one. A path not reached records NOTHING in $aceByKey, and phase 3
      # reads that absence as 'deferred': it stays on its lock's ledger and the
      # lock is kept, so the next turn (or the unbudgeted operator sweep) picks it
      # up. Forgetting it here would be the one move that makes the leak
      # unfindable, which is the whole failure mode this file exists around.
      # -ne 0, not -gt 0: 0 is the "no budget" sentinel and every OTHER value gets
      # its literal meaning, a NEGATIVE one included - elapsed is never below it,
      # so it reads as "already spent". That is a degenerate budget rather than a
      # special case, and it is what lets a test exercise this branch without
      # racing a stopwatch.
      if ($TimeBudgetSeconds -ne 0 -and $budget.Elapsed.TotalSeconds -ge $TimeBudgetSeconds) {
        $deferred++
        continue
      }
      Log "lease sweep: path $pathNo/$($byPath.Count) - revoking $($entry.Accounts.Count) account(s) from $($entry.Path) (a big tree can take minutes)"
      $watch = [System.Diagnostics.Stopwatch]::StartNew()
      $recs = @(Revoke-SandboxPathAces -Path $entry.Path -FileId $entry.FileId -AccountNames $entry.Accounts.ToArray())
      $watch.Stop()
      foreach ($rec in $recs) { $aceByKey["$($rec.Account)|$key"] = $rec }
      $followedTo = @($recs | Where-Object { $_.ResolvedPath } | ForEach-Object { $_.ResolvedPath } | Select-Object -Unique)
      if ($followedTo.Count -gt 0) {
        Log "lease sweep: path $pathNo/$($byPath.Count) was RENAMED since the grant - its file id put it at $($followedTo -join ', '), which is where the ACEs were taken off"
      }
      $revoked = @($recs | Where-Object { $_.Status -eq 'revoked' }).Count
      $stillThere = @($recs | Where-Object { $_.Status -eq 'failed' }).Count
      Log ("lease sweep: path {0}/{1} done in {2:n1}s - {3} revoked, {4} already clear, {5} still granted" -f $pathNo, $byPath.Count, $watch.Elapsed.TotalSeconds, $revoked, ($recs.Count - $revoked - $stillThere), $stillThere)
    }
    if ($deferred -gt 0) {
      Log ("lease sweep: {0} of {1} path(s) NOT reached - the {2:n1}s budget ran out. Their locks are KEPT with those paths still on the ledger; the next lease of this pool, or setup\sweep-sandbox-leases.ps1, retries them." -f $deferred, $byPath.Count, $TimeBudgetSeconds)
    }

    # ---- phase 3: carry over what is still granted OR was never reached, and
    # release only a lock with neither.
    foreach ($lease in $leases) {
      # A path with NO record is one phase 2 skipped for budget. Synthesised here
      # rather than left to fall out of the Where-Object below, because the old
      # filter DROPPED an unmatched path silently - which, with a budget in play,
      # would truncate the ledger and delete the lock for an ACE nobody touched.
      $aces = @($lease.Entries | ForEach-Object {
          $rec = $aceByKey["$($lease.Account)|$($_.Path.ToLowerInvariant().TrimEnd('\'))|$($_.FileId)"]
          if ($rec) { $rec }
          else { [pscustomobject]@{ Path = $_.Path; ResolvedPath = $null; FileId = $_.FileId; Account = $lease.Account; Sid = $null; Status = 'deferred'; Message = 'not reached before the sweep budget ran out - still granted, still on this ledger' } }
        })
      $stuck = @($aces | Where-Object { $_.Status -eq 'failed' -or $_.Status -eq 'deferred' })
      # SAID OUT LOUD, because it is the one outcome that looks like success and
      # is not necessarily one - see Revoke-SandboxPathAces's 'missing' note.
      $vanished = @($aces | Where-Object { $_.Status -eq 'missing' })
      # ...EXCEPT WHERE THE LEDGER RECORDED AN ID, and that is the whole point of
      # recording one. A 'missing' with an id was not guessed at: the filesystem
      # was asked for the object itself and answered that there is no such id on
      # that volume, so the folder was DELETED and its ACEs went with it. Only
      # the id-less lines - old ledgers - are still the ambiguous case the
      # warning was written for, so only they still get it.
      $vanishedBlind = @($vanished | Where-Object { -not $_.FileId })
      if ($vanishedBlind.Count -gt 0) {
        Log "lease sweep: WARNING - $($lease.Account) has $($vanishedBlind.Count) ledger path(s) that nothing is at any more, and NO file id was recorded for them (a lease written before ids were recorded): $(@($vanishedBlind | ForEach-Object { $_.Path }) -join ', '). Deleted folders took their ACEs with them; a RENAMED one did not, and that ACE is now at a name nothing records. This cannot tell which happened."
      }
      if ($vanished.Count -gt $vanishedBlind.Count) {
        Log "lease sweep: $($lease.Account) had $($vanished.Count - $vanishedBlind.Count) ledger path(s) whose recorded file id no longer exists on the volume - those folders were DELETED, so their ACEs went with them. Nothing is leaking there."
      }
      # THE CARRY-OVER IS THE POINT of rewriting rather than truncating - the same
      # discipline Clear-SandboxStaleLease applies on the launcher's path. A path
      # the revoke could not clear stays on the list so the next reclaim retries -
      # WITH ITS ID, and under the name the id resolved to if it had to be
      # followed (ConvertTo-SandboxLeaseCarryEntry).
      try {
        Write-SandboxLeaseLedger -Stream $lease.Stream -Entries @($stuck | ForEach-Object { ConvertTo-SandboxLeaseCarryEntry -Record $_ })
      } catch {
        $lease.Stream.Close()
        Log "lease sweep: $($lease.Account) - its ACEs were processed but the ledger could not be rewritten ($($_.Exception.Message)); the lock is KEPT"
        [void]$records.Add([pscustomobject]@{ Account = $lease.Account; Lock = $lease.Lock; Status = 'failed'; Message = "the ledger could not be rewritten - $($_.Exception.Message)"; Aces = $aces })
        continue
      }
      $lease.Stream.Close()
      if ($stuck.Count -gt 0) {
        Log "lease sweep: $($lease.Account) - $($stuck.Count) path(s) still granted, lock KEPT for the next reclaim"
        [void]$records.Add([pscustomobject]@{ Account = $lease.Account; Lock = $lease.Lock; Status = 'partial'; Message = "$($stuck.Count) path(s) still granted - the lock is KEPT so the next reclaim retries them"; Aces = $aces })
        continue
      }
      try {
        Remove-Item -LiteralPath $lease.Lock -Force -ErrorAction Stop
        Log "lease sweep: $($lease.Account) - $(@($aces | Where-Object { $_.Status -eq 'revoked' }).Count) ACE(s) revoked, lock released"
        [void]$records.Add([pscustomobject]@{ Account = $lease.Account; Lock = $lease.Lock; Status = 'reclaimed'; Message = "$(@($aces | Where-Object { $_.Status -eq 'revoked' }).Count) ACE(s) revoked, lock released"; Aces = $aces })
      } catch {
        [void]$records.Add([pscustomobject]@{ Account = $lease.Account; Lock = $lease.Lock; Status = 'failed'; Message = "the ACEs were cleared but the lock file could not be removed - $($_.Exception.Message)"; Aces = $aces })
      }
    }
  } finally {
    # Belt and braces - phase 3 closes each stream as it finishes with it, and a
    # second Close() on a FileStream is a no-op. A lock left OPEN here would look
    # like a live lease to every launcher on the box until this process exits.
    foreach ($lease in $leases) { try { $lease.Stream.Close() } catch { } }
  }
  return $records.ToArray()
}
