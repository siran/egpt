# Unit coverage for setup\provision-service-account.ps1.
#
# NOTHING IN HERE TOUCHES THE OS. No account is created, no real DACL is read or
# written, nothing needs elevation. That is a hard constraint and not a style
# choice: this suite exists to be run casually, by anyone, on a node whose live
# accounts and ACLs are load-bearing.
#
# HOW, in the three ways the script can reach the OS:
#   - the LocalAccounts cmdlets and Get-CimInstance are SHADOWED by functions
#     defined below, the same trick setup\sandbox-account.Tests.ps1 uses. They
#     MUST be declared before the dot-source: PowerShell resolves an unqualified
#     command inside a dot-sourced function by walking that function's LEXICAL
#     parent scope chain, i.e. the scope it was dot-sourced into.
#   - icacls.exe is shadowed by a SPY that never forwards. sandbox-account's spy
#     falls through to the real binary when no list is set, because that suite
#     deliberately grants for real on throwaway directories; this one must not,
#     so there is no fall-through at all.
#   - elevation and the security descriptor are INJECTED as parameters
#     (-IsElevated, -Acl) rather than shadowed, because both are pure inputs to
#     pure functions. Get-SshAclPlan never reads a file, so the whole
#     check-before-you-write property is testable against a FileSecurity built
#     in memory.
#
# WHAT THIS CANNOT COVER, and no in-process test can: that sshd on the peer
# actually accepts the ACL this converges on, that the account it creates can log
# on, and that a Windows profile appears where step 3 says it must. Those are a
# real provisioner run plus an `ssh -p 2222` from the other node.
#
# NOT part of vitest -- `npm test` never runs a .ps1. Run it by hand:
#   Invoke-Pester -Script setup\provision-service-account.Tests.ps1
# (Pester 3.4.0, the version Windows ships, hence `Should Be` and not `Should -Be`.)

$script:FakeLocalUser = $null
$script:NewLocalUserCalls = 0
$script:NewLocalUserSeen = $null
$script:FakeAdminMembers = @()
$script:FakeUserProfiles = @()
$script:IcaclsSpy = New-Object System.Collections.Generic.List[object]

function Get-LocalUser {
  [CmdletBinding()]
  param($Name)
  return $script:FakeLocalUser
}
function New-LocalUser {
  [CmdletBinding()]
  param($Name, $Password, $FullName, $Description,
    [switch]$PasswordNeverExpires, [switch]$UserMayNotChangePassword, [switch]$AccountNeverExpires)
  $script:NewLocalUserCalls++
  $script:NewLocalUserSeen = [PSCustomObject]@{
    Name                     = $Name
    FullName                 = $FullName
    Description              = $Description
    PasswordNeverExpires     = [bool]$PasswordNeverExpires
    UserMayNotChangePassword = [bool]$UserMayNotChangePassword
    AccountNeverExpires      = [bool]$AccountNeverExpires
  }
}
function Get-LocalGroupMember {
  [CmdletBinding()]
  param($SID, $Group, $Name)
  return $script:FakeAdminMembers
}
# Win32_UserProfile only. Shadowing Get-CimInstance wholesale is acceptable
# because nothing else in this process calls it (Pester 3.4 does not).
function Get-CimInstance {
  [CmdletBinding()]
  param($ClassName)
  return $script:FakeUserProfiles
}
function icacls.exe {
  [void]$script:IcaclsSpy.Add(@($args))
  $global:LASTEXITCODE = 0
  return 'icacls spy: not executed'
}

. (Join-Path $PSScriptRoot 'provision-service-account.ps1') -LoadFunctionsOnly

$script:ProvisionScript = Join-Path $PSScriptRoot 'provision-service-account.ps1'
$script:TempRoot = Join-Path $env:TEMP ('egpt-svc-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:TempRoot -Force | Out-Null

# Three SIDs that are SYNTHETIC on purpose: they are never resolved to a name and
# never used against a real object, so no test can accidentally name a live
# principal. The account SID has the shape of a local user's; SYSTEM and
# Administrators are the well-known ones the script converges on.
$script:AccountSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-21-1111111111-2222222222-3333333333-1234')
$script:StrangerSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-21-1111111111-2222222222-3333333333-5678')
$script:SystemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$script:AdminsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')

# A well-formed ssh-ed25519 blob: 4-byte big-endian length, the algorithm name,
# then the 32-byte key. Built rather than pasted so no real public key ends up in
# the repository, and so the "type field disagrees with the blob" case can be
# constructed at all.
function New-TestKeyBody {
  param([int]$Seed = 1, [string]$Algorithm = 'ssh-ed25519')
  $name = [System.Text.Encoding]::ASCII.GetBytes($Algorithm)
  $bytes = New-Object System.Collections.Generic.List[byte]
  $bytes.AddRange([byte[]]@(0, 0, 0, [byte]$name.Length))
  $bytes.AddRange($name)
  $bytes.AddRange([byte[]]@(0, 0, 0, 32))
  1..32 | ForEach-Object { $bytes.Add([byte]((($_ * 7) + $Seed) % 256)) }
  return [Convert]::ToBase64String($bytes.ToArray())
}
$script:BodyA = New-TestKeyBody -Seed 1
$script:BodyB = New-TestKeyBody -Seed 2
$script:KeyLineA = "ssh-ed25519 $script:BodyA kg@egpt"

# An in-memory security descriptor. Never attached to a file, so building one
# writes nothing and needs no rights.
function New-TestAcl {
  param(
    $Owner = $script:AccountSid,
    [bool]$Protected = $true,
    $Allow = $null,
    $Deny = $null,
    [switch]$IsDirectory
  )
  # A DirectorySecurity for a container, a FileSecurity for a leaf: .NET refuses
  # inheritance flags on the leaf type ("No flags can be set"), which is the
  # same distinction icacls makes and the reason Get-SshAclPlan derives its spec
  # from -IsDirectory instead of leaving it to callers.
  $acl = if ($IsDirectory) {
    New-Object System.Security.AccessControl.DirectorySecurity
  } else {
    New-Object System.Security.AccessControl.FileSecurity
  }
  if ($Owner) { $acl.SetOwner($Owner) }
  $acl.SetAccessRuleProtection($Protected, $false)
  $inherit = if ($IsDirectory) { 'ContainerInherit,ObjectInherit' } else { 'None' }
  if ($null -eq $Allow) { $Allow = @($script:AccountSid, $script:SystemSid, $script:AdminsSid) }
  foreach ($sid in $Allow) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $sid, 'FullControl', $inherit, 'None', 'Allow')))
  }
  foreach ($sid in @($Deny)) {
    if (-not $sid) { continue }
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $sid, 'FullControl', $inherit, 'None', 'Deny')))
  }
  return $acl
}

function Reset-TestFakes {
  $script:FakeLocalUser = $null
  $script:NewLocalUserCalls = 0
  $script:NewLocalUserSeen = $null
  $script:FakeAdminMembers = @()
  $script:FakeUserProfiles = @()
  $script:IcaclsSpy = New-Object System.Collections.Generic.List[object]
}
function New-TestProfileDir {
  param([string]$AccountName)
  $p = Join-Path (Join-Path $script:TempRoot ([guid]::NewGuid().ToString('N'))) $AccountName
  New-Item -ItemType Directory -Path $p -Force | Out-Null
  return $p
}

Describe 'Get-SshPublicKey (a key that does not parse never reaches authorized_keys)' {
  It 'parses type, canonical body and comment out of a well-formed line' {
    $key = Get-SshPublicKey -Text $script:KeyLineA
    $key.Type | Should Be 'ssh-ed25519'
    $key.Body | Should Be $script:BodyA
    $key.Comment | Should Be 'kg@egpt'
    $key.Line | Should Be $script:KeyLineA
  }

  It 'keeps a multi-word comment whole' {
    $key = Get-SshPublicKey -Text "ssh-ed25519 $script:BodyA two words here"
    $key.Comment | Should Be 'two words here'
  }

  It 'accepts a key with no comment at all' {
    $key = Get-SshPublicKey -Text "ssh-ed25519 $script:BodyA"
    $key.Comment | Should Be ''
    $key.Line | Should Be "ssh-ed25519 $script:BodyA"
  }

  It 'REFUSES an empty key' {
    { Get-SshPublicKey -Text '' } | Should Throw 'it is empty'
  }

  It 'REFUSES a body that is not base64 at all' {
    { Get-SshPublicKey -Text 'ssh-ed25519 not-base64!!! kg@egpt' } | Should Throw 'not a base64 OpenSSH key blob'
  }

  It 'REFUSES a TRUNCATED blob, which is what a wrapped paste looks like' {
    $truncated = $script:BodyA.Substring(0, 8)
    { Get-SshPublicKey -Text "ssh-ed25519 $truncated kg@egpt" } | Should Throw
  }

  It 'REFUSES a line whose type field disagrees with the algorithm inside the blob' {
    # The half-measure a regex would wave through: right shape, two different
    # keys glued together.
    { Get-SshPublicKey -Text "ssh-rsa $script:BodyA kg@egpt" } | Should Throw 'the algorithm name inside the blob'
  }

  It 'REFUSES a DSA key by name, because the peer would ignore it' {
    $dsa = New-TestKeyBody -Seed 4 -Algorithm 'ssh-dss'
    { Get-SshPublicKey -Text "ssh-dss $dsa kg@egpt" } | Should Throw 'DSA'
  }

  It 'REFUSES an authorized_keys OPTIONS prefix rather than dropping or honouring it silently' {
    { Get-SshPublicKey -Text "restrict,command=`"x`" ssh-ed25519 $script:BodyA kg@egpt" } | Should Throw 'OPTIONS'
  }

  It 'REFUSES two keys at once, so the run authorises exactly what was named' {
    { Get-SshPublicKey -Text "ssh-ed25519 $script:BodyA a`nssh-ed25519 $script:BodyB b" } | Should Throw 'non-blank lines'
  }

  It 'ignores blank and #-comment lines around the one real key' {
    $key = Get-SshPublicKey -Text "`n# a comment`n$script:KeyLineA`n`n"
    $key.Body | Should Be $script:BodyA
  }
}

Describe 'Merge-AuthorizedKeyLine (the key BODY is the identity; the comment names nothing)' {
  It 'appends to an empty file' {
    $key = Get-SshPublicKey -Text $script:KeyLineA
    $merged = Merge-AuthorizedKeyLine -ExistingLines @() -Key $key
    $merged.Changed | Should Be $true
    $merged.Action | Should Be 'appended'
    $merged.Lines.Count | Should Be 1
    $merged.Lines[0] | Should Be $script:KeyLineA
  }

  It 'THE IDEMPOTENCE: the same key twice leaves exactly one line and writes nothing' {
    $key = Get-SshPublicKey -Text $script:KeyLineA
    $first = Merge-AuthorizedKeyLine -ExistingLines @() -Key $key
    $second = Merge-AuthorizedKeyLine -ExistingLines $first.Lines -Key $key
    $second.Changed | Should Be $false
    $second.Action | Should Be 'already present'
    $second.Lines.Count | Should Be 1
  }

  It 'THE COMMENT IS NOT THE KEY: the same body with a DIFFERENT comment is still one line' {
    # Every re-generated id_*.pub carries a new user@host comment. Matching on
    # the comment would append a duplicate of the same key on every run.
    $key = Get-SshPublicKey -Text $script:KeyLineA
    $onDisk = @("ssh-ed25519 $script:BodyA somebody-else@some-other-host")
    $merged = Merge-AuthorizedKeyLine -ExistingLines $onDisk -Key $key
    $merged.Changed | Should Be $false
    $merged.Lines.Count | Should Be 1
    $merged.Lines[0] | Should Be $onDisk[0]
    $merged.Detail | Should Match 'different comment'
  }

  It 'converges: ten passes over the same key leave one line' {
    $key = Get-SshPublicKey -Text $script:KeyLineA
    $lines = @()
    foreach ($i in 1..10) { $lines = (Merge-AuthorizedKeyLine -ExistingLines $lines -Key $key).Lines }
    @($lines).Count | Should Be 1
  }

  It 'a DIFFERENT key is appended beside the first, not instead of it' {
    $keyA = Get-SshPublicKey -Text $script:KeyLineA
    $keyB = Get-SshPublicKey -Text "ssh-ed25519 $script:BodyB do@egpt"
    $lines = (Merge-AuthorizedKeyLine -ExistingLines @() -Key $keyA).Lines
    $merged = Merge-AuthorizedKeyLine -ExistingLines $lines -Key $keyB
    $merged.Changed | Should Be $true
    $merged.Lines.Count | Should Be 2
  }

  It 'does not WIDEN a key already installed on a line carrying options' {
    # Appending a bare copy of a key that is there as `command="..." ssh-ed25519
    # AAAA...` would turn a forced command into a free shell, silently.
    $key = Get-SshPublicKey -Text $script:KeyLineA
    $onDisk = @("command=`"egpt-relay`",no-pty ssh-ed25519 $script:BodyA kg@egpt")
    $merged = Merge-AuthorizedKeyLine -ExistingLines $onDisk -Key $key
    $merged.Changed | Should Be $false
    $merged.Lines.Count | Should Be 1
    $merged.Detail | Should Match 'OPTIONS'
  }

  It 'leaves every unrelated line in the file exactly as it was' {
    $key = Get-SshPublicKey -Text $script:KeyLineA
    $onDisk = @('# somebody notes something', "ssh-ed25519 $script:BodyB do@egpt", '')
    $merged = Merge-AuthorizedKeyLine -ExistingLines $onDisk -Key $key
    $merged.Lines.Count | Should Be 4
    $merged.Lines[0] | Should Be '# somebody notes something'
    $merged.Lines[1] | Should Be "ssh-ed25519 $script:BodyB do@egpt"
    $merged.Lines[3] | Should Be $script:KeyLineA
  }
}

Describe 'Get-SshAclPlan (what is wrong with this descriptor, computed without reading a file)' {
  It 'a descriptor that is already right is Ok with no reasons' {
    $plan = Get-SshAclPlan -Acl (New-TestAcl) -AccountSid $script:AccountSid
    $plan.Ok | Should Be $true
    @($plan.Reasons).Count | Should Be 0
    $plan.Spec | Should Be '(F)'
  }

  It 'a directory wants the inheritable spec, a file wants the bare one' {
    $dirPlan = Get-SshAclPlan -Acl (New-TestAcl -IsDirectory) -AccountSid $script:AccountSid -IsDirectory
    $dirPlan.Ok | Should Be $true
    $dirPlan.Spec | Should Be '(OI)(CI)(F)'
  }

  It 'a file ACL carrying (OI)(CI) does NOT satisfy the leaf grant' {
    # icacls accepts (OI)(CI) on a file, exits 0 and writes no ACE at all
    # (measured for the sandbox 2026-09-20), so the check has to agree with the
    # spec by construction or the script loops writing nothing.
    $plan = Get-SshAclPlan -Acl (New-TestAcl -IsDirectory) -AccountSid $script:AccountSid
    $plan.Ok | Should Be $false
  }

  It 'catches the wrong owner' {
    $plan = Get-SshAclPlan -Acl (New-TestAcl -Owner $script:AdminsSid) -AccountSid $script:AccountSid
    $plan.OwnerOk | Should Be $false
    $plan.Ok | Should Be $false
  }

  It 'catches inheritance still being on - the BUILTIN\Users write a fresh profile carries' {
    $plan = Get-SshAclPlan -Acl (New-TestAcl -Protected $false) -AccountSid $script:AccountSid
    $plan.InheritanceOff | Should Be $false
    $plan.Ok | Should Be $false
  }

  It 'catches a missing SYSTEM or Administrators grant' {
    $plan = Get-SshAclPlan -Acl (New-TestAcl -Allow @($script:AccountSid)) -AccountSid $script:AccountSid
    @($plan.Missing).Count | Should Be 2
    $plan.Ok | Should Be $false
  }

  It 'names an explicit Allow for anybody else as a stranger' {
    $acl = New-TestAcl -Allow @($script:AccountSid, $script:SystemSid, $script:AdminsSid, $script:StrangerSid)
    $plan = Get-SshAclPlan -Acl $acl -AccountSid $script:AccountSid
    @($plan.Strangers).Count | Should Be 1
    $plan.Strangers[0] | Should Be $script:StrangerSid.Value
  }

  It 'leaves a DENY for somebody else alone: it only narrows, which is the direction sshd wants' {
    $acl = New-TestAcl -Deny @($script:StrangerSid)
    $plan = Get-SshAclPlan -Acl $acl -AccountSid $script:AccountSid
    @($plan.Strangers).Count | Should Be 0
    $plan.Ok | Should Be $true
  }
}

Describe 'Repair-SshPathAcl (check first; a descriptor that is already right costs ZERO icacls)' {
  BeforeEach { $script:IcaclsSpy = New-Object System.Collections.Generic.List[object] }

  It 'THE PROPERTY: an already-correct ACL writes nothing at all' {
    $result = Repair-SshPathAcl -Path 'C:\nowhere\authorized_keys' -AccountSid $script:AccountSid -Acl (New-TestAcl)
    $result.Action | Should Be 'already correct'
    $script:IcaclsSpy.Count | Should Be 0
  }

  It 'an already-correct DIRECTORY ACL writes nothing either' {
    $result = Repair-SshPathAcl -Path 'C:\nowhere\.ssh' -AccountSid $script:AccountSid -IsDirectory -Acl (New-TestAcl -IsDirectory)
    $result.Action | Should Be 'already correct'
    $script:IcaclsSpy.Count | Should Be 0
  }

  It 'a wrong OWNER costs exactly one /setowner pass, by SID' {
    $result = Repair-SshPathAcl -Path 'C:\nowhere\authorized_keys' -AccountSid $script:AccountSid -Acl (New-TestAcl -Owner $script:AdminsSid)
    $result.Action | Should Be 'fixed'
    $script:IcaclsSpy.Count | Should Be 1
    $call = @($script:IcaclsSpy[0])
    $call[0] | Should Be 'C:\nowhere\authorized_keys'
    ($call -contains '/setowner') | Should Be $true
    ($call -contains "*$($script:AccountSid.Value)") | Should Be $true
  }

  It 'inheritance still on costs one /inheritance:r + /grant:r pass naming exactly three principals' {
    $result = Repair-SshPathAcl -Path 'C:\nowhere\authorized_keys' -AccountSid $script:AccountSid -Acl (New-TestAcl -Protected $false)
    $script:IcaclsSpy.Count | Should Be 1
    $call = @($script:IcaclsSpy[0])
    ($call -contains '/inheritance:r') | Should Be $true
    # /grant:r, NOT the additive plain /grant Grant-SandboxPoolAce uses: this
    # file is a closed set, so a wrong grant must be replaced, not unioned with.
    ($call -contains '/grant:r') | Should Be $true
    ($call -contains '/grant') | Should Be $false
    ($call -contains "*$($script:AccountSid.Value):(F)") | Should Be $true
    ($call -contains "*$($script:SystemSid.Value):(F)") | Should Be $true
    ($call -contains "*$($script:AdminsSid.Value):(F)") | Should Be $true
  }

  It 'a directory gets the inheritable spec on the wire' {
    Repair-SshPathAcl -Path 'C:\nowhere\.ssh' -AccountSid $script:AccountSid -IsDirectory -Acl (New-TestAcl -Protected $false -IsDirectory) | Out-Null
    $call = @($script:IcaclsSpy[0])
    ($call -contains "*$($script:AccountSid.Value):(OI)(CI)(F)") | Should Be $true
  }

  It 'REFUSES a stranger ACE without -Force, and writes nothing while refusing' {
    $acl = New-TestAcl -Allow @($script:AccountSid, $script:SystemSid, $script:AdminsSid, $script:StrangerSid)
    { Repair-SshPathAcl -Path 'C:\nowhere\authorized_keys' -AccountSid $script:AccountSid -Acl $acl } | Should Throw 'EXPLICIT Allow'
    $script:IcaclsSpy.Count | Should Be 0
  }

  It 'with -Force, removes the stranger by SID in its own pass' {
    $acl = New-TestAcl -Allow @($script:AccountSid, $script:SystemSid, $script:AdminsSid, $script:StrangerSid)
    $result = Repair-SshPathAcl -Path 'C:\nowhere\authorized_keys' -AccountSid $script:AccountSid -Acl $acl -Force
    $result.Action | Should Be 'fixed'
    $script:IcaclsSpy.Count | Should Be 1
    $call = @($script:IcaclsSpy[0])
    ($call -contains '/remove:g') | Should Be $true
    ($call -contains "*$($script:StrangerSid.Value)") | Should Be $true
  }

  It 'DRY RUN plans the same passes and runs none of them' {
    $result = Repair-SshPathAcl -Path 'C:\nowhere\authorized_keys' -AccountSid $script:AccountSid -Acl (New-TestAcl -Owner $script:AdminsSid -Protected $false) -DryRun
    $result.Action | Should Be 'would fix'
    @($result.Commands).Count | Should Be 2
    $script:IcaclsSpy.Count | Should Be 0
  }
}

Describe 'Invoke-ProvisionServiceAccount refusals (each one names the place)' {
  BeforeEach { Reset-TestFakes }

  It 'REFUSES to run unelevated, and creates nothing while refusing' {
    $threw = $null
    try {
      Invoke-ProvisionServiceAccount -AccountName 'egpt-svc-test' -PublicKey $script:KeyLineA -IsElevated $false | Out-Null
    } catch { $threw = $_.Exception.Message }
    $threw | Should Match 'UNELEVATED'
    $threw | Should Match 'New-LocalUser'
    $script:NewLocalUserCalls | Should Be 0
    $script:IcaclsSpy.Count | Should Be 0
  }

  It 'REFUSES a key that does not parse, before it gets anywhere near an account' {
    $threw = $null
    try {
      Invoke-ProvisionServiceAccount -AccountName 'egpt-svc-test' -PublicKey 'ssh-ed25519 not-a-blob x' -IsElevated $true | Out-Null
    } catch { $threw = $_.Exception.Message }
    $threw | Should Match 'not a base64 OpenSSH key blob'
    $script:NewLocalUserCalls | Should Be 0
    $script:IcaclsSpy.Count | Should Be 0
  }

  It 'REFUSES both -PublicKey and -PublicKeyPath at once' {
    { Invoke-ProvisionServiceAccount -AccountName 'egpt-svc-test' -PublicKey $script:KeyLineA -PublicKeyPath 'C:\nope.pub' -IsElevated $true } |
      Should Throw 'exactly one'
  }

  It 'REFUSES no key at all' {
    { Invoke-ProvisionServiceAccount -AccountName 'egpt-svc-test' -IsElevated $true } | Should Throw 'no key'
  }

  It 'REFUSES an existing account that IS in Administrators, rather than demoting it' {
    # THE WHOLE REASON THIS ACCOUNT EXISTS. For an administrator, sshd reads only
    # administrators_authorized_keys, so a key in its ~\.ssh would authenticate
    # zero times - the measured bug. Demotion is a human decision.
    $script:FakeLocalUser = [PSCustomObject]@{ Name = 'egpt-svc-test'; SID = $script:AccountSid }
    $script:FakeAdminMembers = @([PSCustomObject]@{ SID = $script:AccountSid })
    $threw = $null
    try {
      Invoke-ProvisionServiceAccount -AccountName 'egpt-svc-test' -PublicKey $script:KeyLineA -IsElevated $true | Out-Null
    } catch { $threw = $_.Exception.Message }
    $threw | Should Match 'administrators_authorized_keys'
    $script:NewLocalUserCalls | Should Be 0
    $script:IcaclsSpy.Count | Should Be 0
  }

  It 'accepts an existing account that is NOT in Administrators (the same fake, empty group)' {
    $script:FakeLocalUser = [PSCustomObject]@{ Name = 'egpt-svc-test'; SID = $script:AccountSid }
    $script:FakeAdminMembers = @([PSCustomObject]@{ SID = $script:StrangerSid })
    $threw = $null
    try {
      Invoke-ProvisionServiceAccount -AccountName 'egpt-svc-test' -PublicKey $script:KeyLineA -IsElevated $true | Out-Null
    } catch { $threw = $_.Exception.Message }
    # It gets PAST step 2 and stops at step 3 on the missing profile instead.
    $threw | Should Match 'STOP'
    $script:NewLocalUserCalls | Should Be 0
  }

  It 'REFUSES to point at the account running the script' {
    { Invoke-ProvisionServiceAccount -AccountName $env:USERNAME -PublicKey $script:KeyLineA -IsElevated $true } |
      Should Throw 'the account running this script'
  }

  It 'REFUSES an account name Windows would not accept' {
    { Invoke-ProvisionServiceAccount -AccountName 'this-name-is-far-too-long-for-sam' -PublicKey $script:KeyLineA -IsElevated $true } |
      Should Throw 'usable local account name'
  }

  It 'REFUSES a -PublicKeyPath that is not there' {
    { Invoke-ProvisionServiceAccount -AccountName 'egpt-svc-test' -PublicKeyPath (Join-Path $script:TempRoot 'never-written.pub') -IsElevated $true } |
      Should Throw 'does not point at a file'
  }
}

Describe 'Invoke-ProvisionServiceAccount step 3 (a profile is made by a LOGON and by nothing else)' {
  BeforeEach { Reset-TestFakes }

  It 'STOPS on an account with no Win32_UserProfile, and says what the operator must do' {
    $script:FakeLocalUser = [PSCustomObject]@{ Name = 'egpt-svc-test'; SID = $script:AccountSid }
    $threw = $null
    try {
      Invoke-ProvisionServiceAccount -AccountName 'egpt-svc-test' -PublicKey $script:KeyLineA -IsElevated $true | Out-Null
    } catch { $threw = $_.Exception.Message }
    # The 'STOP:' prefix is what the script's own catch turns into exit code 2.
    $threw.StartsWith('STOP:') | Should Be $true
    $threw | Should Match 'LOGON'
    $threw | Should Match 'Nothing was written past step 2'
    $script:IcaclsSpy.Count | Should Be 0
  }

  It 'the STOP text warns against pre-creating C:\Users\<name> by hand' {
    # Windows does not adopt an existing directory; it makes C:\Users\<name>.<HOST>
    # and the key lands where nobody reads it. That trap is the reason the message
    # is long.
    $message = Get-ProfileStopMessage -AccountName 'egpt-svc-test'
    $message | Should Match 'DO NOT PRE-CREATE'
    $message | Should Match 'HOSTNAME'
  }

  It 'REFUSES a profile whose registered directory leaf is not the account name' {
    $script:FakeLocalUser = [PSCustomObject]@{ Name = 'egpt-svc-test'; SID = $script:AccountSid }
    $script:FakeUserProfiles = @([PSCustomObject]@{ SID = $script:AccountSid.Value; LocalPath = 'C:\Users\somebody-else'; Special = $false })
    { Invoke-ProvisionServiceAccount -AccountName 'egpt-svc-test' -PublicKey $script:KeyLineA -IsElevated $true } |
      Should Throw 'is not the account name'
  }

  It 'REFUSES a profile flagged Special' {
    $script:FakeLocalUser = [PSCustomObject]@{ Name = 'egpt-svc-test'; SID = $script:AccountSid }
    $script:FakeUserProfiles = @([PSCustomObject]@{ SID = $script:AccountSid.Value; LocalPath = 'C:\Users\egpt-svc-test'; Special = $true })
    { Invoke-ProvisionServiceAccount -AccountName 'egpt-svc-test' -PublicKey $script:KeyLineA -IsElevated $true } |
      Should Throw 'Special'
  }
}

Describe 'Invoke-ProvisionServiceAccount -WhatIf (prints every intended change, writes nothing)' {
  BeforeEach { Reset-TestFakes }

  It 'with a profile in place: no directory, no file, no icacls, no account' {
    $profileDir = New-TestProfileDir -AccountName 'egpt-svc-test'
    $script:FakeLocalUser = [PSCustomObject]@{ Name = 'egpt-svc-test'; SID = $script:AccountSid }
    $script:FakeUserProfiles = @([PSCustomObject]@{ SID = $script:AccountSid.Value; LocalPath = $profileDir; Special = $false })

    $report = Invoke-ProvisionServiceAccount -AccountName 'egpt-svc-test' -PublicKey $script:KeyLineA -IsElevated $true -DryRun

    $report.'key-install' | Should Be 'appended'
    (Test-Path -LiteralPath (Join-Path $profileDir '.ssh')) | Should Be $false
    $script:IcaclsSpy.Count | Should Be 0
    $script:NewLocalUserCalls | Should Be 0
  }

  It 'with no account at all: says it would create one, creates none, and still stops at nothing' {
    $report = Invoke-ProvisionServiceAccount -AccountName 'egpt-svc-test' -PublicKey $script:KeyLineA -IsElevated $true -DryRun
    $script:NewLocalUserCalls | Should Be 0
    $script:IcaclsSpy.Count | Should Be 0
    $report.account | Should Be 'would be created'
    # Everything downstream depends on a SID that does not exist yet, and says so
    # rather than guessing a profile path.
    $report.profile | Should Match 'not evaluated'
  }
}

Describe 'the shape of the shipped script (the rules it is meant to keep)' {
  It 'ONE ACL TOOL: it writes no DACL with the .NET API' {
    # Same ruling as sandbox-account.Tests.ps1's: icacls for every ACL WRITE,
    # never Set-Acl (which persists the SACL too and hung against a profile
    # root). Reading a descriptor with .NET is fine and is what Get-Acl does.
    $src = Get-Content -LiteralPath $script:ProvisionScript -Raw
    ($src -match '(?m)^\s*Set-Acl ') | Should Be $false
    ($src -match 'AddAccessRule') | Should Be $false
    ($src -match 'SetAccessControl') | Should Be $false
  }

  It 'never writes a password anywhere but into New-LocalUser' {
    # The generated password is a throwaway: not echoed, not persisted, not even
    # DPAPI-wrapped the way the sandbox pool's is, because nothing here ever logs
    # this account on.
    $src = Get-Content -LiteralPath $script:ProvisionScript -Raw
    ($src -match 'Save-SandboxCredentialFile') | Should Be $false
    ($src -match 'Write-Host.*\$plain') | Should Be $false
    (@([regex]::Matches($src, 'New-RandomPassword')).Count -ge 1) | Should Be $true
  }

  It 'is dot-sourceable without doing any work, which is the only reason -LoadFunctionsOnly exists' {
    (Get-Command Invoke-ProvisionServiceAccount -ErrorAction SilentlyContinue) | Should Not Be $null
    (Get-Command Merge-AuthorizedKeyLine -ErrorAction SilentlyContinue) | Should Not Be $null
    $script:NewLocalUserCalls | Should Be 0
  }
}

# The temp root only ever held empty directories standing in for a profile.
Remove-Item -LiteralPath $script:TempRoot -Recurse -Force -ErrorAction SilentlyContinue
