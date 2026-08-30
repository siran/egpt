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

# Modify (read+write) for the pool on a directory it OWNS -- used for the
# pool's own pi config dir under ProgramData. Deliberately NOT used on anything
# inside the operator's profile.
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
