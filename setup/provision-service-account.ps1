# provision-service-account.ps1  - operator-run, one-time (idempotent)
# provisioning of the ONE local account a being on the other node reaches this
# node through: a NON-administrator service account whose ~\.ssh\authorized_keys
# carries a supplied public key.
#
# WHY A SEPARATE ACCOUNT AND NOT 'an' (the whole reason this file exists).
# Windows OpenSSH ships this in C:\ProgramData\ssh\sshd_config:
#
#     Match Group administrators
#            AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
#
# 'an' IS an administrator, so for that user sshd reads ONLY
# C:\ProgramData\ssh\administrators_authorized_keys and a key appended to
# ~\.ssh\authorized_keys is SILENTLY IGNORED  - measured live 2026-09-22: three
# installs with a key in the home-directory file, zero authentications between
# them. A NON-administrator account does not hit that Match block, so its own
# ~\.ssh\authorized_keys is the file sshd actually reads. That is the whole
# reason this account exists rather than reusing 'an', and it is also why step 2
# REFUSES an account of this name that is already in Administrators: demoting it
# would be a human decision, and leaving it promoted would reproduce the bug.
#
# The shell this key gets is deliberately UNELEVATED and non-administrator
# (operator ruling 2026-09-22). Peer sshd measured: OpenSSH_for_Windows_10.0p2
# on port 2222 (the POSIX-preferred port; 22 is a second sshd and is the
# secondary).
#
# SHAPE COPIED FROM provision-sandbox-account.ps1 (operator 2026-09-20, "it
# shouldn't be complicated, it has to be easy to review" / "script seem to have
# hung"): N numbered steps, Start-Step / one line of work / Stop-Step, elapsed
# seconds per step, and CHECK BEFORE YOU WRITE  - a grant is a fact to converge
# on, not a command to re-issue. A run that changes nothing writes nothing and
# takes well under a second; none of the steps here is slow enough to need the
# "not hung" warning that file's ~\src grant needs.
#
# ACL WRITES GO THROUGH icacls, NEVER Set-Acl  - same rule, same reasons, as
# Grant-SandboxPoolAce in sandbox-account.ps1 (Set-Acl persists the SACL too and
# hung twice against a profile root; icacls edits the DACL and returns at once).
# Grant-SandboxPoolAce ITSELF is not the tool for the one ACL this script writes
# and is deliberately not called: it is ADDITIVE by contract (plain /grant, never
# /grant:r, "it never narrows a broader grant already made"), and what
# authorized_keys needs is the opposite  - a CLOSED SET. sshd refuses a key file
# any other account can write, so the inherited BUILTIN\Users grant that every
# fresh profile carries has to come OFF. That is a /inheritance:r + /grant:r +
# /remove:g job, which Grant-SandboxPoolAce cannot express and must not learn.
# No second GRANTING helper was written; New-RandomPassword is reused rather than
# re-implemented, which is why this file dot-sources sandbox-account.ps1.
#
# RUN IT VIA provision-service-account.cmd (it puts up the UAC prompt). This
# script REFUSES to run unelevated rather than self-elevating the way
# provision-sandbox-account.ps1 does: creating an account and taking ownership of
# a file are exactly the operations that fail obscurely halfway through an
# unelevated run, and a refusal that names the place is worth more than a second
# UAC dialog.
#
# WHAT IT WILL NOT DO: create the account's Windows PROFILE. See step 3  - a
# profile is materialised by a LOGON and nothing else, and this script stops
# there rather than inventing one.

param(
  # The account. Parameterised, defaulted, and checked against $env:USERNAME in
  # step 1 so a slip cannot point any of this at the operator's own account.
  [string]$AccountName = 'egpt-svc',
  # The key to install. Exactly one of these two; step 1 refuses both or neither.
  [string]$PublicKey,
  [string]$PublicKeyPath,
  # -Force buys exactly ONE thing (step 4): permission to drop an EXPLICIT Allow
  # ACE on ~\.ssh or authorized_keys that this script did not put there. Nothing
  # else in this file has a -Force path; everywhere else the default is to refuse
  # rather than overwrite something unexpected.
  [switch]$Force,
  # Dry run: print every intended change, write nothing. A plain switch and NOT
  # [CmdletBinding(SupportsShouldProcess)] on purpose  - ShouldProcess would also
  # bring -Confirm and a $ConfirmPreference this script never consults, i.e. one
  # more thing a reviewer has to hold in their head for no behaviour.
  [switch]$WhatIf,
  # Dot-source hook for setup\provision-service-account.Tests.ps1. The sandbox's
  # launcher cannot be unit tested at all because it has a param block and RUNS
  # (see sandbox-account.ps1's note on why the lease machinery lives in the
  # library half); this switch is that problem's fix, and it is the only reason
  # it exists. `. .\provision-service-account.ps1 -LoadFunctionsOnly` defines
  # every function below and performs no work.
  [switch]$LoadFunctionsOnly
)

# NOT at script scope: dot-sourcing sets variables in the CALLER's scope, so an
# $ErrorActionPreference here would silently re-arm the test runner that
# dot-sources this file. It is set inside Invoke-ProvisionServiceAccount, which
# is the only thing that does work.

# New-RandomPassword lives here (one password generator on this node, not two -
# it also carries the note about why the complexity-policy suffix is appended).
. (Join-Path $PSScriptRoot 'sandbox-account.ps1')

$ServiceAccountStepCount = 5
$script:ServiceStepIndex = 0

function Start-Step {
  param([Parameter(Mandatory = $true)][string]$What, [string]$Warn = '')
  $script:ServiceStepIndex++
  Write-Host "[$script:ServiceStepIndex/$ServiceAccountStepCount] $What"
  if ($Warn) { Write-Host "         $Warn" }
  return [System.Diagnostics.Stopwatch]::StartNew()
}
function Stop-Step {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Stopwatch]$Watch, [string]$Result = 'done')
  $Watch.Stop()
  Write-Host ("         {0}  - {1:n1}s" -f $Result, $Watch.Elapsed.TotalSeconds)
}

function Test-IsElevated {
  return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------------------------------------------------------------------------
# THE KEY: parsing, and what counts as "the same key"
# ---------------------------------------------------------------------------

# Accepted OpenSSH public key types. rsa-sha2-256/512 are deliberately absent:
# those are SIGNATURE algorithms, never a key type in an authorized_keys line -
# an RSA key is still 'ssh-rsa' there.
$SshPublicKeyTypes = @(
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com'
)
# KNOWN AND REFUSED, with a reason, rather than falling through to "not a key
# type". Installing a key the peer sshd will ignore is the exact failure this
# whole account exists to fix, so it is worth its own message.
$SshRefusedKeyTypes = @{
  'ssh-dss' = "DSA is disabled in OpenSSH 7+ and removed in 9.8+, so the peer (OpenSSH_for_Windows_10.0p2) would ignore it - you would get a key that authenticates zero times, which is the bug this account exists to fix"
}

# The algorithm name encoded INSIDE the blob, or $null if the token is not a
# well-formed base64 OpenSSH key blob. An OpenSSH blob opens with a 4-byte
# big-endian length followed by that many ASCII bytes of the algorithm name, so
# this is a real parse of the key rather than a look at the text beside it - it
# catches a truncated paste, a line-wrapped blob, and a body glued to the wrong
# type field, none of which a regex on the line would notice.
function Get-SshKeyBlobType {
  param([AllowNull()][AllowEmptyString()][string]$Token)
  if ([string]::IsNullOrWhiteSpace($Token)) { return $null }
  if ($Token -notmatch '^[A-Za-z0-9+/]+={0,2}$') { return $null }
  try { $bytes = [Convert]::FromBase64String($Token) } catch { return $null }
  if ($bytes.Length -lt 8) { return $null }
  $n = ([int]$bytes[0] -shl 24) -bor ([int]$bytes[1] -shl 16) -bor ([int]$bytes[2] -shl 8) -bor [int]$bytes[3]
  if ($n -le 0 -or $n -gt 64 -or ($n + 4) -gt $bytes.Length) { return $null }
  return [System.Text.Encoding]::ASCII.GetString($bytes, 4, $n)
}

# THE IDENTITY OF A KEY IS ITS BLOB, NEVER ITS COMMENT. Re-encoding the decoded
# bytes is what makes that comparison total: two pastes of the same key can
# differ in base64 padding and still be the same key, and a comment is free text
# that says nothing about which key it is. Returns $null for anything that is not
# a key blob, so a caller can sweep every token of a line without pre-filtering.
function Get-SshKeyBodyCanonical {
  param([AllowNull()][AllowEmptyString()][string]$Token)
  if (-not (Get-SshKeyBlobType -Token $Token)) { return $null }
  return [Convert]::ToBase64String([Convert]::FromBase64String($Token))
}

# Parse ONE supplied public key. Throws, naming the place, on anything that is
# not exactly one plain `type base64 [comment]` line.
function Get-SshPublicKey {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][AllowNull()][string]$Text,
    [string]$Source = 'the -PublicKey argument'
  )
  $lines = @()
  if ($null -ne $Text) {
    $lines = @($Text -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and -not $_.TrimStart().StartsWith('#') })
  }
  if ($lines.Count -eq 0) {
    throw "provision-service-account: refusing the key from $Source  - it is empty. Supply the CONTENTS of an id_*.pub file (one line, 'type base64 comment')."
  }
  if ($lines.Count -gt 1) {
    throw "provision-service-account: refusing the key from $Source  - it carries $($lines.Count) non-blank lines. Supply exactly ONE public key; installing several at once hides which one this run actually authorised."
  }
  $line = $lines[0].Trim()
  $tokens = @($line -split '\s+' | Where-Object { $_ -ne '' })
  if ($tokens.Count -lt 2) {
    throw "provision-service-account: refusing the key from $Source  - '$line' is not 'type base64 [comment]'."
  }
  $type = $tokens[0]
  if ($SshRefusedKeyTypes.ContainsKey($type)) {
    throw "provision-service-account: refusing the key from $Source  - key type '$type': $($SshRefusedKeyTypes[$type])."
  }
  if ($SshPublicKeyTypes -notcontains $type) {
    throw "provision-service-account: refusing the key from $Source  - '$type' is not an OpenSSH public key type (expected one of: $($SshPublicKeyTypes -join ', ')). If this line begins with authorized_keys OPTIONS (command=, from=, no-pty, restrict, ...), strip them: this script will not install a key whose options it did not read, and it will not silently drop them either."
  }
  $blobType = Get-SshKeyBlobType -Token $tokens[1]
  if (-not $blobType) {
    throw "provision-service-account: refusing the key from $Source  - the second field is not a base64 OpenSSH key blob. A truncated or line-wrapped paste looks exactly like this."
  }
  if ($blobType -ne $type) {
    throw "provision-service-account: refusing the key from $Source  - the type field says '$type' but the algorithm name inside the blob is '$blobType'. The two halves of this line came from different keys."
  }
  $comment = ''
  if ($tokens.Count -gt 2) { $comment = ($tokens[2..($tokens.Count - 1)] -join ' ') }
  $body = Get-SshKeyBodyCanonical -Token $tokens[1]
  return [PSCustomObject]@{
    Type    = $type
    Body    = $body
    Comment = $comment
    Line    = (@($type, $body, $comment) -join ' ').Trim()
  }
}

# Converge an authorized_keys file's LINES on "this key is in there, once".
# Pure: takes lines, returns lines, touches no disk. Never removes anything it
# did not add and never rewrites a line it found.
#
# THE MATCH IS ON THE BODY OF ANY TOKEN OF THE LINE, not on the line's first
# field, which is what makes it correct for a line that carries OPTIONS. If the
# key is already installed as `command="..." ssh-ed25519 AAAA... ` then appending
# a bare copy would silently WIDEN it from a forced command to a free shell, and
# an options-blind comparison would do exactly that. So an options line counts as
# present, and says so loudly instead.
function Merge-AuthorizedKeyLine {
  param(
    [AllowNull()][AllowEmptyCollection()][string[]]$ExistingLines,
    [Parameter(Mandatory = $true)]$Key
  )
  $lines = @()
  if ($ExistingLines) { $lines = @($ExistingLines) }
  foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line.TrimStart().StartsWith('#')) { continue }
    $tokens = @($line -split '\s+' | Where-Object { $_ -ne '' })
    $hit = $false
    foreach ($tok in $tokens) {
      if ((Get-SshKeyBodyCanonical -Token $tok) -eq $Key.Body) { $hit = $true; break }
    }
    if (-not $hit) { continue }

    $hasOptions = ($SshPublicKeyTypes -notcontains $tokens[0])
    if ($hasOptions) {
      return [PSCustomObject]@{
        Lines   = $lines
        Changed = $false
        Action  = 'already present'
        Detail  = "the key is already installed on a line that carries OPTIONS ('$($tokens[0])...'), which this run has deliberately NOT widened by appending a bare copy. If the bare key is what you wanted, remove that line by hand first."
      }
    }
    $foundComment = ''
    if ($tokens.Count -gt 2) { $foundComment = ($tokens[2..($tokens.Count - 1)] -join ' ') }
    if ($foundComment -ne $Key.Comment) {
      return [PSCustomObject]@{
        Lines   = $lines
        Changed = $false
        Action  = 'already present'
        Detail  = "same key body, different comment (on disk: '$foundComment', supplied: '$($Key.Comment)') - the line on disk is left exactly as it is. A comment is free text and names no key."
      }
    }
    return [PSCustomObject]@{
      Lines   = $lines
      Changed = $false
      Action  = 'already present'
      Detail  = 'byte-for-byte the supplied key'
    }
  }
  return [PSCustomObject]@{
    Lines   = @($lines + $Key.Line)
    Changed = $true
    Action  = 'appended'
    Detail  = "one line added; $($lines.Count) line(s) already in the file were left alone"
  }
}

# ---------------------------------------------------------------------------
# THE ACL sshd WILL ACCEPT
# ---------------------------------------------------------------------------
#
# WHAT WIN32-OPENSSH REQUIRES, and how much of it is verified: sshd on Windows
# refuses a key file that accounts other than its owner, SYSTEM and the
# administrators can WRITE, and it logs "bad permissions" and falls through to
# the next auth method - i.e. it fails the way a missing key fails, which is
# indistinguishable from the administrators_authorized_keys redirect this account
# exists to dodge. The target below is the one the OpenSSHUtils module's
# Repair-AuthorizedKeyPermission converges on and is STRICTER than the stated
# requirement (a closed set of three FullControl ACEs, not merely "nobody else
# may write"). The exact predicate inside sshd is TAKEN ON FAITH here, not
# measured: nothing in this task ran sshd. If a future run shows sshd still
# unhappy, the thing to read is the peer's sshd log at -ddd, not this comment.
$SshAclFullRights = [int][System.Security.AccessControl.FileSystemRights]::FullControl

# Pure. Takes a security descriptor (a real one from Get-Acl, or one built in
# memory by a test) and answers what is wrong with it. Nothing here reads or
# writes a file, which is what lets the check-first property be tested without
# touching a single real ACL.
function Get-SshAclPlan {
  param(
    [Parameter(Mandatory = $true)]$Acl,
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$AccountSid,
    [switch]$IsDirectory
  )
  $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
  $admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
  $expected = @($AccountSid, $system, $admins)
  $expectedValues = @($expected | ForEach-Object { $_.Value })
  # A LEAF TAKES THE SAME MASK WITHOUT THE INHERITANCE FLAGS - the same rule
  # Grant-SandboxPoolAce derives once rather than leaving to its callers, and for
  # the same measured reason: icacls ACCEPTS (OI)(CI) on a file, exits 0, and
  # writes no ACE at all.
  $inherit = if ($IsDirectory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
  $spec = if ($IsDirectory) { '(OI)(CI)(F)' } else { '(F)' }

  $owner = $null
  try { $owner = $Acl.GetOwner([System.Security.Principal.SecurityIdentifier]) } catch { $owner = $null }
  $ownerOk = ($null -ne $owner -and $owner.Value -eq $AccountSid.Value)

  # Inheritance must be OFF. This is not tidiness: the inherited ACEs a fresh
  # profile carries are precisely what gives other accounts write access, and
  # /grant can never take an INHERITED ace away.
  $inheritanceOff = [bool]$Acl.AreAccessRulesProtected

  $explicit = @($Acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
  $allows = @($explicit | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow })

  $missing = @()
  foreach ($sid in $expected) {
    $have = @($allows | Where-Object {
        $_.IdentityReference.Value -eq $sid.Value -and
        $_.InheritanceFlags -eq $inherit -and
        $_.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None -and
        (([int]$_.FileSystemRights) -band $SshAclFullRights) -eq $SshAclFullRights
      })
    if ($have.Count -eq 0) { $missing += $sid }
  }

  # ONLY ALLOW ACEs COUNT AS STRANGERS. A Deny for somebody else only narrows
  # what this file grants, which is the direction sshd wants; removing it would
  # be this script overriding a decision nobody asked it to override.
  $strangers = @($allows |
      Where-Object { $expectedValues -notcontains $_.IdentityReference.Value } |
      ForEach-Object { $_.IdentityReference.Value } |
      Sort-Object -Unique)

  $reasons = @()
  if (-not $ownerOk) { $reasons += "owner is $(if ($owner) { $owner.Value } else { '<unreadable>' }), wanted $($AccountSid.Value)" }
  if (-not $inheritanceOff) { $reasons += 'inheritance is still on' }
  if ($missing.Count -gt 0) { $reasons += "missing $spec for $(($missing | ForEach-Object { $_.Value }) -join ', ')" }
  if ($strangers.Count -gt 0) { $reasons += "explicit Allow for $($strangers -join ', ')" }

  return [PSCustomObject]@{
    Ok             = ($ownerOk -and $inheritanceOff -and $missing.Count -eq 0 -and $strangers.Count -eq 0)
    OwnerOk        = $ownerOk
    Owner          = $owner
    InheritanceOff = $inheritanceOff
    Expected       = $expected
    Missing        = $missing
    Strangers      = $strangers
    Spec           = $spec
    Reasons        = $reasons
  }
}

# CHECK FIRST, WRITE ONLY WHAT IS WRONG. Three possible icacls passes, each
# guarded by its own fact, and a descriptor that is already right costs ZERO
# invocations. Kept as three passes rather than one combined command line
# because each is a separate fact and reads as one; the file is a few hundred
# bytes, so there is no propagation cost to amortise (unlike the sandbox's ~\src,
# where "one pass" IS the property).
function Repair-SshPathAcl {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$AccountSid,
    [switch]$IsDirectory,
    [switch]$Force,
    [switch]$DryRun,
    # Injection point for the tests, which must never read or write a real DACL.
    # Unset in every real run.
    $Acl
  )
  if (-not $Acl) { $Acl = Get-Acl -LiteralPath $Path -ErrorAction Stop }
  $plan = Get-SshAclPlan -Acl $Acl -AccountSid $AccountSid -IsDirectory:$IsDirectory
  if ($plan.Ok) {
    return [PSCustomObject]@{ Action = 'already correct'; Plan = $plan; Commands = @() }
  }
  if ($plan.Strangers.Count -gt 0 -and -not $Force) {
    throw "provision-service-account: refusing to rewrite the ACL of $Path  - it carries EXPLICIT Allow ACE(s) this script did not put there ($($plan.Strangers -join ', ')). sshd refuses a key file another account can write, so they cannot stay; dropping somebody's deliberate grant is not something to do silently either. Read them with 'icacls $Path', then re-run with -Force."
  }
  $commands = @()
  # /setowner, not Set-Acl: SeRestorePrivilege is held (this run is elevated) and
  # icacls returns at once. Its own pass because the owner is its own fact - a
  # descriptor can have a perfect DACL and the wrong owner.
  if (-not $plan.OwnerOk) {
    $commands += , @($Path, '/setowner', "*$($AccountSid.Value)")
  }
  # /inheritance:r drops every INHERITED ace (the BUILTIN\Users write that comes
  # with a fresh profile is one of them). /grant:r, not plain /grant, and this is
  # the one place this codebase departs from Grant-SandboxPoolAce's additive
  # rule: authorized_keys is a closed set, so an existing wrong grant for one of
  # the three expected principals must be REPLACED, not unioned with.
  if (-not $plan.InheritanceOff -or $plan.Missing.Count -gt 0) {
    $grant = @($Path, '/inheritance:r', '/grant:r')
    foreach ($sid in $plan.Expected) { $grant += "*$($sid.Value):$($plan.Spec)" }
    $commands += , $grant
  }
  if ($plan.Strangers.Count -gt 0) {
    $remove = @($Path, '/remove:g')
    foreach ($s in $plan.Strangers) { $remove += "*$s" }
    $commands += , $remove
  }
  if ($DryRun) {
    return [PSCustomObject]@{ Action = 'would fix'; Plan = $plan; Commands = $commands }
  }
  foreach ($argv in $commands) {
    # No 2>&1: PS 5.1 turns a redirected native stderr into NativeCommandError
    # records, which under $ErrorActionPreference='Stop' throws something
    # unrelated to what went wrong. The exit code is what this branches on.
    $out = & icacls.exe @argv
    if ($LASTEXITCODE -ne 0) {
      throw "provision-service-account: icacls failed on $Path (icacls $($argv -join ' '))  - exit $LASTEXITCODE ($($out -join ' '))"
    }
  }
  return [PSCustomObject]@{ Action = 'fixed'; Plan = $plan; Commands = $commands }
}

# ---------------------------------------------------------------------------
# THE ACCOUNT AND ITS PROFILE
# ---------------------------------------------------------------------------

# Is this SID in the local Administrators group? BY SID on both sides: the group
# name is localised (Administradores, Administratoren, ...) and a member's name
# is not a stable key either.
#
# FAILS LOUDLY rather than answering "no". Get-LocalGroupMember is known to throw
# on a group holding an orphaned SID, and an unread membership list that defaults
# to "not an administrator" would walk straight into installing a key on an
# administrator account - the exact configuration this file exists to avoid.
function Test-InAdministrators {
  param(
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$Sid,
    [string]$AccountName = ''
  )
  $adminsSid = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
  try {
    $members = @(Get-LocalGroupMember -SID $adminsSid -ErrorAction Stop)
  } catch {
    throw "provision-service-account: refusing to go on  - the membership of the local Administrators group ($($adminsSid.Value)) could not be read ($($_.Exception.Message)), so whether '$AccountName' is an administrator is UNKNOWN. A key installed on an administrator account is read from C:\ProgramData\ssh\administrators_authorized_keys instead and this account's own file is ignored, which is the failure this script exists to avoid."
  }
  foreach ($m in $members) {
    if ($m.SID -and $m.SID.Value -eq $Sid.Value) { return $true }
  }
  return $false
}

# Where this account's Windows profile lives, or $null when it has none yet.
#
# THE GUARDS ARE Get-SandboxProfilePath's, deliberately duplicated rather than
# called: that function lives in sandbox-logon-launcher.ps1, which has a param
# block and RUNS, so nothing can dot-source it - and its GUARD 1 hard-refuses any
# name outside the 'egpt-sbx-' pool prefix, which is every name this script will
# ever be given. Select BY SID, never by matching a path string a lookalike
# directory could fool; then make the path agree with the SID independently.
function Get-ServiceAccountProfilePath {
  param(
    [Parameter(Mandatory = $true)][string]$AccountName,
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$Sid
  )
  $found = @(Get-CimInstance -ClassName Win32_UserProfile -ErrorAction Stop |
      Where-Object { $_.SID -eq $Sid.Value })
  # NORMAL CASE, not an error: the account has never been logged on to.
  if ($found.Count -eq 0) { return $null }
  if ($found.Count -gt 1) {
    throw "provision-service-account: refusing to use the profile of '$AccountName'  - $($found.Count) Win32_UserProfile entries match SID $($Sid.Value)"
  }
  $candidate = $found[0]
  if ($candidate.Special) {
    throw "provision-service-account: refusing to use the profile of '$AccountName' (SID $($Sid.Value))  - it is flagged Special, i.e. a system profile"
  }
  if ([string]::IsNullOrWhiteSpace($candidate.LocalPath)) {
    throw "provision-service-account: refusing to use the profile of '$AccountName' (SID $($Sid.Value))  - its Win32_UserProfile entry has no LocalPath"
  }
  $leaf = Split-Path -Path $candidate.LocalPath -Leaf
  if ($leaf -ne $AccountName) {
    throw "provision-service-account: refusing to use the profile of '$AccountName' (SID $($Sid.Value))  - it lives at '$($candidate.LocalPath)', whose leaf '$leaf' is not the account name"
  }
  return $candidate.LocalPath
}

# The message step 3 stops on. Its own function so the test can assert on the
# text a reviewer will actually read, and so the reason lives beside the words.
function Get-ProfileStopMessage {
  param([Parameter(Mandatory = $true)][string]$AccountName)
  return @"
STOP: '$AccountName' exists but has no Windows profile yet, and this script will not create one.

WHY IT STOPS INSTEAD OF CARRYING ON. A Windows account has no %USERPROFILE%
until it has LOGGED ON once. Every way to materialise one is a logon:

  - the sandbox's way, sandbox-logon-launcher.ps1 step (f): CreateProcessWithLogonW
    with LOGON_WITH_PROFILE, i.e. a LOGON32_LOGON_INTERACTIVE logon. It needs the
    account's plaintext password in memory and SeInteractiveLogonRight, and the
    launcher only ever does it for 'egpt-sbx-NN' pool accounts as a side effect of
    a real turn. There is no profile-only entry point in it to call.
  - a scheduled task with a stored password: a BATCH logon. Same class.
  - userenv!CreateProfile: the one documented non-logon route, and a P/Invoke
    nothing on this node has ever run. Inventing it unreviewed, in the script that
    also hands out an ssh key, is not a trade worth making.

AND DO NOT PRE-CREATE C:\Users\$AccountName BY HAND. Windows will not adopt a
directory that is already there; it creates C:\Users\$($AccountName).<HOSTNAME>
instead and the key you install in the first one is read by nobody.

WHAT TO DO (one time, then re-run this script, which will pick up from here):
  1. As an administrator, give the account a password you choose:
       net user $AccountName *
     It prompts and does not echo. This script generated a random password it
     deliberately never stored, so there is nothing to look up.
  2. Log the account on once, any way that loads its profile:
       runas /profile /user:$AccountName cmd.exe
     or sign in to it once and sign out again.
  3. Re-run this script. It is idempotent: the account is left alone and steps
     4 and 5 do the rest.
  4. Optional, once the key works: reset the password to something you discard,
     or leave it - the account is reached by KEY, not by password.

Nothing was written past step 2.
"@
}

# ---------------------------------------------------------------------------
# THE RUN
# ---------------------------------------------------------------------------

function Invoke-ProvisionServiceAccount {
  param(
    [string]$AccountName = 'egpt-svc',
    [string]$PublicKey,
    [string]$PublicKeyPath,
    # Injected so the not-elevated refusal is testable without elevation, and so
    # there is exactly one place that asks the OS.
    [bool]$IsElevated = (Test-IsElevated),
    [switch]$Force,
    [switch]$DryRun
  )
  $ErrorActionPreference = 'Stop'
  $script:ServiceStepIndex = 0
  $runWatch = [System.Diagnostics.Stopwatch]::StartNew()
  $report = [ordered]@{}

  # ---- STEP 1: everything that can be refused before a single write.
  $step = Start-Step 'checking preconditions: elevation, the supplied key, the account name'
  if (-not $IsElevated) {
    throw "provision-service-account: refusing to run UNELEVATED. Step 2 calls New-LocalUser and step 4 calls icacls /setowner; both need local Administrator, and an unelevated run would get several steps in before failing in a way that reads like something else. Run setup\provision-service-account.cmd (it puts up the UAC prompt), or an elevated PowerShell. Nothing has been written."
  }
  if ($PublicKey -and $PublicKeyPath) {
    throw "provision-service-account: refusing  - both -PublicKey and -PublicKeyPath were given. Supply exactly one, so the key that gets installed is the key you named."
  }
  if (-not $PublicKey -and -not $PublicKeyPath) {
    throw "provision-service-account: refusing  - no key. Supply -PublicKey '<contents of an id_*.pub>' or -PublicKeyPath <path to one>."
  }
  $keySource = 'the -PublicKey argument'
  $keyText = $PublicKey
  if ($PublicKeyPath) {
    if (-not (Test-Path -LiteralPath $PublicKeyPath -PathType Leaf)) {
      throw "provision-service-account: refusing  - -PublicKeyPath does not point at a file: $PublicKeyPath"
    }
    $keySource = $PublicKeyPath
    $keyText = Get-Content -LiteralPath $PublicKeyPath -Raw
  }
  $key = Get-SshPublicKey -Text $keyText -Source $keySource
  if ([string]::IsNullOrWhiteSpace($AccountName)) {
    throw 'provision-service-account: refusing  - -AccountName is empty.'
  }
  # SAM account names cap at 20 characters and reject these; a name Windows
  # rejects would surface as an opaque New-LocalUser error three lines later.
  if ($AccountName.Length -gt 20 -or $AccountName -match '["/\\\[\]:;|=,+*?<>@]') {
    throw ("provision-service-account: refusing  - '$AccountName' is not a usable local account name " +
      '(20 characters maximum, and none of these: " / \ [ ] : ; | = , + * ? < > @).')
  }
  # THE ONE SLIP WORTH A GUARD: pointing any of this at the operator's own
  # account, which is an administrator and whose ~\.ssh sshd never reads anyway.
  if ($AccountName -eq $env:USERNAME) {
    throw "provision-service-account: refusing  - '$AccountName' is the account running this script. This provisions a SEPARATE non-administrator account precisely because sshd reads administrators_authorized_keys for an administrator and ignores their ~\.ssh\authorized_keys."
  }
  $report['key'] = "$($key.Type), comment '$($key.Comment)'"
  Stop-Step $step "key parses as $($key.Type) (comment '$($key.Comment)'), account name '$AccountName' is usable$(if ($DryRun) { ', DRY RUN: nothing will be written' })"

  # ---- STEP 2: the account.
  $step = Start-Step "the local, NON-administrator account '$AccountName'"
  $existing = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
  $accountSid = $null
  if ($existing) {
    $accountSid = $existing.SID
    if (Test-InAdministrators -Sid $accountSid -AccountName $AccountName) {
      throw "provision-service-account: refusing  - the local account '$AccountName' already exists and IS a member of Administrators. For an administrator, sshd reads ONLY C:\ProgramData\ssh\administrators_authorized_keys, so a key installed in its ~\.ssh\authorized_keys would authenticate zero times (measured on this node 2026-09-22). Demoting an existing administrator is a human decision, not something this script does silently: either remove it from Administrators by hand and re-run, or pass a different -AccountName."
    }
    # ITS PASSWORD IS NOT RESET. Nothing downstream needs one (the account is
    # reached by key), and resetting the password of an account that may be
    # doing something else is exactly the kind of quiet overwrite this script
    # refuses everywhere else.
    Stop-Step $step "already exists (SID $($accountSid.Value)), not an administrator  - left exactly as it is, password untouched"
    $report['account'] = 'already existed'
  } elseif ($DryRun) {
    Stop-Step $step "WOULD CREATE local user '$AccountName' (random password, never echoed and never stored; PasswordNeverExpires, UserMayNotChangePassword, AccountNeverExpires; added to NO group)"
    $report['account'] = 'would be created'
  } else {
    # THE PASSWORD IS A THROWAWAY. It is generated, handed to New-LocalUser, and
    # dropped - never echoed, never written to disk, not even DPAPI-wrapped the
    # way the sandbox pool's is, because unlike the pool nothing here ever needs
    # to log this account on. The account is reached by KEY. If a password is
    # ever needed (the one-time profile logon of step 3), an administrator sets
    # one with `net user <name> *`, which prompts without echoing.
    #
    # PasswordNeverExpires: YES, and it is a safety flag rather than a lax one -
    # nobody knows this password, so an expiry could only ever lock the account
    # out of the one-time logon it may still need, and a forced change at next
    # logon would wedge it outright. The secret is 256 random bits that exist
    # nowhere; age buys nothing against an attacker who cannot see it.
    # UserMayNotChangePassword: YES - it blocks SELF-service change only, so a
    # process running AS this account cannot rotate the password out from under
    # the operator. An administrator reset (`net user <name> *`) still works,
    # which is the only route anyone here would use.
    # AccountNeverExpires: YES, same reason - an expired account stops answering
    # ssh and the failure reads like a broken key.
    # NO GROUP IS ADDED. Not Administrators, obviously, but not BUILTIN\Users
    # either: Users already contains NT AUTHORITY\Authenticated Users, which is
    # what carries the logon rights, and the sandbox pool's 16 accounts log on
    # daily on exactly this basis. (Taken from the pool's behaviour, not measured
    # for this account.)
    $plain = New-RandomPassword
    $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
    $plain = $null
    New-LocalUser -Name $AccountName -Password $secure `
      -FullName 'egpt service' `
      -Description 'egpt peer-node ssh service account (managed by setup/provision-service-account.ps1) - deliberately NOT an administrator' `
      -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -ErrorAction Stop | Out-Null
    $created = Get-LocalUser -Name $AccountName -ErrorAction Stop
    $accountSid = $created.SID
    # Defensive, and cheap: a brand-new local user is in no group, so this can
    # only fire if something else on the box is watching for new accounts.
    if (Test-InAdministrators -Sid $accountSid -AccountName $AccountName) {
      throw "provision-service-account: refusing  - '$AccountName' was just created and is ALREADY in Administrators. Something else on this node put it there; sort that out before installing a key on it."
    }
    Stop-Step $step "created (SID $($accountSid.Value)), not an administrator, in no group; password random, not echoed, not stored"
    $report['account'] = 'created'
  }

  # ---- STEP 3: the profile. This is where a first run on a fresh account stops.
  $step = Start-Step "the Windows profile of '$AccountName' (~\.ssh has to live somewhere)"
  $profilePath = $null
  if (-not $accountSid) {
    Stop-Step $step 'not evaluated  - DRY RUN and the account does not exist yet, so it has no SID to look a profile up by'
    $report['profile'] = 'not evaluated (dry run, account absent)'
  } else {
    $profilePath = Get-ServiceAccountProfilePath -AccountName $AccountName -Sid $accountSid
    if (-not $profilePath) { throw (Get-ProfileStopMessage -AccountName $AccountName) }
    if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) {
      throw "provision-service-account: refusing  - Win32_UserProfile says '$AccountName' lives at '$profilePath' and that directory is not there. A profile registration without its directory is a broken profile, not something to write a key into."
    }
    Stop-Step $step "already materialised at $profilePath"
    $report['profile'] = $profilePath
  }

  # ---- STEP 4: ~\.ssh and authorized_keys, and the ACL sshd will accept.
  $step = Start-Step 'the ~\.ssh directory and authorized_keys, and their ACLs'
  $sshDir = $null
  $keysPath = $null
  if (-not $profilePath) {
    Stop-Step $step 'not evaluated  - no profile path from step 3'
    $report['acl'] = 'not evaluated'
  } else {
    $sshDir = Join-Path $profilePath '.ssh'
    $keysPath = Join-Path $sshDir 'authorized_keys'
    $aclResults = @()
    foreach ($target in @(
        @{ Path = $sshDir;   IsDir = $true;  Label = '.ssh' },
        @{ Path = $keysPath; IsDir = $false; Label = 'authorized_keys' }
      )) {
      $exists = Test-Path -LiteralPath $target.Path
      if (-not $exists) {
        if ($DryRun) {
          $spec = if ($target.IsDir) { '(OI)(CI)(F)' } else { '(F)' }
          Write-Host "         $($target.Label) ($($target.Path)): WOULD CREATE, then set owner=$AccountName and $spec for the account, SYSTEM and Administrators only, inheritance off"
          $aclResults += 'would create'
          continue
        }
        if ($target.IsDir) {
          New-Item -ItemType Directory -Path $target.Path -ErrorAction Stop | Out-Null
        } else {
          # Created EMPTY and hardened here, BEFORE step 5 writes the key into
          # it: a key must never exist for even a moment in a file other
          # accounts can read or rewrite.
          [System.IO.File]::WriteAllBytes($target.Path, (New-Object byte[] 0))
        }
        Write-Host "         $($target.Label) ($($target.Path)): created"
      }
      $fix = Repair-SshPathAcl -Path $target.Path -AccountSid $accountSid -IsDirectory:$target.IsDir -Force:$Force -DryRun:$DryRun
      if ($fix.Action -eq 'already correct') {
        Write-Host "         $($target.Label): ACL already correct  - nothing written"
      } elseif ($fix.Action -eq 'would fix') {
        Write-Host "         $($target.Label): WOULD FIX ACL ($($fix.Plan.Reasons -join '; ')) via $($fix.Commands.Count) icacls pass(es):"
        foreach ($argv in $fix.Commands) { Write-Host "           icacls $($argv -join ' ')" }
      } else {
        Write-Host "         $($target.Label): ACL fixed ($($fix.Plan.Reasons -join '; ')), $($fix.Commands.Count) icacls pass(es)"
      }
      $aclResults += $fix.Action
    }
    Stop-Step $step ($aclResults -join ', ')
    $report['acl'] = ($aclResults -join ', ')
  }

  # ---- STEP 5: the key itself, and the report.
  $step = Start-Step "the public key in $(if ($keysPath) { $keysPath } else { 'authorized_keys' })"
  if (-not $keysPath) {
    Stop-Step $step 'not evaluated  - no authorized_keys path from step 4'
    $report['key-install'] = 'not evaluated'
  } else {
    $existingLines = @()
    if (Test-Path -LiteralPath $keysPath -PathType Leaf) {
      $existingLines = @([System.IO.File]::ReadAllLines($keysPath))
    }
    $merged = Merge-AuthorizedKeyLine -ExistingLines $existingLines -Key $key
    Write-Host "         $($merged.Action): $($merged.Detail)"
    if ($merged.Changed -and -not $DryRun) {
      # UTF-8 WITHOUT A BOM, and LF. A BOM at the head of authorized_keys is read
      # as part of the first key type by some sshd builds, which is a key that
      # authenticates zero times for a reason nobody sees. Windows OpenSSH reads
      # LF happily.
      $encoding = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($keysPath, (($merged.Lines -join "`n") + "`n"), $encoding)
      Stop-Step $step "written  - $($merged.Lines.Count) key line(s) in the file"
    } elseif ($merged.Changed) {
      Stop-Step $step "WOULD WRITE  - the file would hold $($merged.Lines.Count) key line(s)"
    } else {
      Stop-Step $step "nothing written  - the file already holds this key, once"
    }
    $report['key-install'] = $merged.Action
  }

  $verb = if ($DryRun) { 'DRY RUN complete' } else { 'OK' }
  Write-Host ("{0}: '{1}' in {2:n1}s  - account {3}; profile {4}; ACLs {5}; key {6}. The shell this key gets is UNELEVATED and non-administrator, which is the point: sshd reads THIS account's own ~\.ssh\authorized_keys because it is not in Administrators. Check it from the peer with: ssh -p 2222 {1}@<this node>" -f `
      $verb, $AccountName, $runWatch.Elapsed.TotalSeconds, $report['account'], $report['profile'], $report['acl'], $report['key-install'])
  return [PSCustomObject]$report
}

# ---------------------------------------------------------------------------

if ($LoadFunctionsOnly) { return }

try {
  Invoke-ProvisionServiceAccount -AccountName $AccountName -PublicKey $PublicKey -PublicKeyPath $PublicKeyPath `
    -Force:$Force -DryRun:$WhatIf | Out-Null
  exit 0
} catch {
  $message = $_.Exception.Message
  # 'STOP:' is the step-3 profile case: an operator action is needed, nothing is
  # broken, and nothing past step 2 was written. Its own exit code so a caller
  # can tell "do one logon and re-run" from "this failed".
  if ($message.StartsWith('STOP:')) {
    Write-Host ''
    Write-Host $message
    exit 2
  }
  Write-Host ("FAILED at step {0}/{1}: {2}" -f $script:ServiceStepIndex, $ServiceAccountStepCount, $message)
  exit 1
}
