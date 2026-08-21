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
# DPAPI (Export-Clixml's SecureString protection) is scoped to the Windows
# account that encrypts it  - only decryptable by that same account. Fine
# here: this daemon always runs under one fixed operator account (Startup-
# folder supervisor), never as a rotating service identity.
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

# (a) Ensure ONE named account exists  - idempotent, local-admin only,
# fail loudly (never silently degrade) if creation is not possible.
function Get-SandboxCredential {
  param(
    [Parameter(Mandatory = $true)][string]$AccountName
  )
  $credPath = Join-Path $CredDir "sandbox-cred-$AccountName.xml"
  $existing = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
  if ($existing -and (Test-Path -LiteralPath $credPath)) {
    try { return Import-Clixml -Path $credPath }
    catch { throw "sandbox-logon-launcher: account '$AccountName' exists but its stored credential at $credPath could not be read ($($_.Exception.Message))  - delete that file to force a self-heal, or fix its permissions" }
  }
  $securePwd = ConvertTo-SecureString -String (New-RandomPassword) -AsPlainText -Force
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
  $cred = New-Object System.Management.Automation.PSCredential($AccountName, $securePwd)
  try {
    New-Item -ItemType Directory -Path $CredDir -Force -ErrorAction Stop | Out-Null
    $cred | Export-Clixml -Path $credPath -Force
  } catch {
    throw "sandbox-logon-launcher: account '$AccountName' is ready but its credential could not be persisted to $credPath  - $($_.Exception.Message)"
  }
  return $cred
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

# Explicit DENY for the pool on ONE file, layered under a broader grant.
# Windows evaluates explicit Deny before Allow, so this carves a hole in an
# inherited ReadAndExecute without widening or removing it.
#
# Used for pi's ~/.pi/agent/auth.json: the pool needs the CONFIG dir (models.json
# is how `--model reve/local` resolves its baseUrl), but auth.json holds provider
# credentials and must stay unreadable. pi's config dir cannot be relocated for
# the sandboxed process -- PI_CODING_AGENT_DIR would do it, but the launcher
# passes lpEnvironment = NULL, so the inner process gets the LEASED ACCOUNT's
# environment, not ours.
#
# The file is created empty if absent, deliberately: a file that appears later
# would inherit the directory's grant, and there would be no deny on it.
# CAVEAT: an editor that replaces auth.json by delete+recreate drops this ACE.
# Re-run this provisioner after any `pi auth` / `/login` that writes credentials.
function Deny-SandboxPoolOnFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType File -Path $Path -Force -ErrorAction Stop | Out-Null
    Log "created empty $Path so the deny ACE exists before any credential does"
  }
  $groupSid = (New-Object System.Security.Principal.NTAccount($SandboxPoolGroup)).Translate([System.Security.Principal.SecurityIdentifier])
  $acl = Get-Acl -LiteralPath $Path
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $groupSid, 'FullControl', 'None', 'None', 'Deny')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
  Log "DENIED $SandboxPoolGroup on $Path"
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

# Wipe ONE pool account's Windows user profile. Called by
# sandbox-logon-launcher.ps1 on LEASE ACQUIRE, before the account is logged on.
#
# WHY (operator ruling 2026-08-21: the account profile is SCRATCH, the
# conversation folder is the only durable storage): pool accounts are REUSED
# across DIFFERENT conversations, and LOGON_WITH_PROFILE materialises
# C:\Users\<account>\. Anything the inner CLI writes under %USERPROFILE% /
# %APPDATA% / %LOCALAPPDATA%  - browser profiles, caches, tokens, app config  -
# survives there and is visible to whichever DIFFERENT conversation leases that
# account next. That is a cross-conversation information leak the per-turn
# folder ACE cannot catch, because it is not a permissions failure at all; it
# can only be fixed by wiping.
#
# WHY Win32_UserProfile AND NOT Remove-Item: deleting only the directory leaves
# the profile's ProfileList registry entry behind, and the next logon then
# creates egpt-sbx-07.REVE, then .REVE.000, accumulating forever while the wipe
# silently stops working. Remove-CimInstance drops the registry hive entry and
# the directory together. Do NOT add a Remove-Item -Recurse fallback.
#
# SAFETY: this function DELETES USER PROFILES, so a targeting bug could destroy
# the operator's own. Every guard below is belt-and-braces and REFUSES (throws)
# rather than proceeding.
function Clear-SandboxAccountProfile {
  param(
    [Parameter(Mandatory = $true)][string]$AccountName
  )
  # ---- GUARD 1 (pool prefix): checked FIRST, before a SID is even resolved, so
  # that no code path in this function can target 'an', 'Administrator' or any
  # other non-pool account even if it is called wrongly.
  if (-not $AccountName.StartsWith($SandboxPoolPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "sandbox-logon-launcher: refusing to wipe the profile of '$AccountName'  - it is not a sandbox pool account (its name must start with '$SandboxPoolPrefix')"
  }

  # Resolve the NAME to a SID and select the profile BY SID  - never by matching
  # path strings, which a lookalike directory name could fool.
  try {
    $sid = (New-Object System.Security.Principal.NTAccount($AccountName)).Translate([System.Security.Principal.SecurityIdentifier])
  } catch {
    # The account does not exist yet (first-ever use on this node  - the pool is
    # created lazily by Get-SandboxCredential later in the launcher's flow). No
    # account means no profile: nothing to wipe, and nothing was deleted.
    Log "no profile to wipe for '$AccountName'  - the account does not resolve to a SID ($($_.Exception.Message))"
    return
  }

  $found = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
    Where-Object { $_.SID -eq $sid.Value })

  # NORMAL CASE, not an error: first-ever use of this account, or already wiped.
  if ($found.Count -eq 0) { return }
  # ---- GUARD 2 (exactly one match): a SID matching several profiles means
  # something is wrong that this function is not equipped to reason about.
  if ($found.Count -gt 1) {
    throw "sandbox-logon-launcher: refusing to wipe the profile of '$AccountName'  - $($found.Count) Win32_UserProfile entries match SID $($sid.Value)"
  }
  $candidate = $found[0]
  # ---- GUARD 3 (not a system profile).
  if ($candidate.Special) {
    throw "sandbox-logon-launcher: refusing to wipe the profile of '$AccountName' (SID $($sid.Value))  - it is flagged Special, i.e. a system profile"
  }
  # ---- GUARD 4 (independent path check): the SID lookup above and this leaf
  # comparison must AGREE. Deliberately redundant with GUARD 1.
  if ([string]::IsNullOrWhiteSpace($candidate.LocalPath)) {
    throw "sandbox-logon-launcher: refusing to wipe the profile of '$AccountName' (SID $($sid.Value))  - its Win32_UserProfile entry has no LocalPath"
  }
  $leaf = Split-Path -Path $candidate.LocalPath -Leaf
  if ($leaf -ne $AccountName) {
    throw "sandbox-logon-launcher: refusing to wipe the profile of '$AccountName' (SID $($sid.Value))  - it lives at '$($candidate.LocalPath)', whose leaf '$leaf' is not the account name"
  }

  # NON-FATAL: the wipe is a HYGIENE step, not a security gate. The usual
  # failure is the profile still being loaded because a previous turn's process
  # has not fully exited  - warn on stderr (stdout is the inner process's own
  # stream-json pipe, see Log's comment) and let the turn proceed.
  try {
    Remove-CimInstance -InputObject $candidate -ErrorAction Stop
    Log "wiped scratch profile for '$AccountName' ($($candidate.LocalPath))"
  } catch {
    Log "WARNING: could not wipe the scratch profile for '$AccountName' at $($candidate.LocalPath)  - $($_.Exception.Message) (continuing anyway: hygiene step, not a security gate)"
  }
}
