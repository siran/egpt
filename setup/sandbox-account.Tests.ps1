# THROWAWAY unit coverage (operator 2026-08-30) for the DPAPI LocalMachine-
# scope credential rewrite in sandbox-account.ps1. Covers what CAN be tested
# in-process: the byte-level protect/unprotect round trip, the on-disk
# wrapper format, and Get-SandboxCredential's self-heal branches with
# Get-/New-/Set-LocalUser shadowed (never touches real Windows accounts or
# C:\ProgramData\egpt). Protect-then-Unprotect in the SAME process trivially
# succeeds under EITHER DPAPI scope, so none of this proves the cross-session
# fix -- only a real cross-logon-session run (SSH/Session-0) proves that.
#
# It also now covers the STICKY LEASE preference (2026-09-06) at the bottom --
# same reason, same limits: those functions are pure string/array work, so they
# unit-test honestly, but the launcher's leasing LOOP around them still only
# proves itself in a real concurrent run.
#
# NOT part of vitest -- `npm test` never runs a .ps1. Run it by hand:
#   Invoke-Pester -Script setup\sandbox-account.Tests.ps1
# (Pester 3.4.0, the version Windows ships, hence `Should Be` and not `Should -Be`.)

# Shadow functions MUST be defined before the dot-source below: PowerShell
# resolves an unqualified command name inside a dot-sourced function by
# walking up that function's LEXICAL parent scope chain, i.e. the scope it
# was dot-sourced into -- so these need to exist in that same top-level scope
# first, not nested inside a Describe/It block, or Get-SandboxCredential will
# call the real cmdlets instead.
$script:FakeExistingUser = $null
$script:NewLocalUserCalls = 0
$script:SetLocalUserCalls = 0

function Get-LocalUser {
  [CmdletBinding()]
  param($Name)
  return $script:FakeExistingUser
}
function New-LocalUser {
  [CmdletBinding()]
  param($Name, $Password, $FullName, $Description, [switch]$PasswordNeverExpires, [switch]$UserMayNotChangePassword, [switch]$AccountNeverExpires)
  $script:NewLocalUserCalls++
}
function Set-LocalUser {
  [CmdletBinding()]
  param($Name, $Password)
  $script:SetLocalUserCalls++
}

# THE icacls SPY (2026-09-20). The revoke is now ONE icacls pass per PATH naming
# every account that leaked an ACE onto it, and "one pass" is the whole property
# - twelve Set-Acl passes over ~\src\egpt cost minutes, one icacls pass over the
# same twelve accounts cost 2 s. An outcome test cannot tell the two apart, so
# the COMMAND is observed directly.
#
# A FUNCTION shadows an external command in PowerShell's resolution order
# (Alias > Function > Cmdlet > External), and it has to be declared up here for
# the same lexical-scope reason the Get-LocalUser shadow above does, or the
# dot-sourced library resolves the real binary instead.
#
# OFF BY DEFAULT: with no spy list set it forwards to the real icacls.exe and
# leaves $LASTEXITCODE alone, so every other test below still edits a real DACL
# for real. Set $script:IcaclsSpy to a list to intercept.
$script:IcaclsSpy = $null
function icacls.exe {
  if ($null -ne $script:IcaclsSpy) {
    [void]$script:IcaclsSpy.Add(@($args))
    $global:LASTEXITCODE = 0
    return 'icacls spy: not executed'
  }
  & (Join-Path $env:SystemRoot 'System32\icacls.exe') @args
}

. (Join-Path $PSScriptRoot 'sandbox-account.ps1')

# Kept in a script-scoped variable for the cross-process determinism test at the
# bottom, which re-dot-sources this same file in a SEPARATE powershell.exe:
# $PSScriptRoot is not reliably populated inside a Pester It block.
$script:SandboxAccountScript = Join-Path $PSScriptRoot 'sandbox-account.ps1'

function Get-PlainPassword($cred) {
  [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($cred.Password))
}

Describe 'Protect-/Unprotect-SandboxCredentialBytes' {
  It 'round-trips arbitrary bytes through LocalMachine-scope DPAPI' {
    $plain = [System.Text.Encoding]::UTF8.GetBytes('correct horse battery staple!Aa1')
    $cipher = Protect-SandboxCredentialBytes -PlainBytes $plain
    $roundTripped = Unprotect-SandboxCredentialBytes -CipherBytes $cipher
    ($roundTripped -join ',') | Should Be ($plain -join ',')
  }

  It 'produces ciphertext that differs from the plaintext' {
    $plain = [System.Text.Encoding]::UTF8.GetBytes('some-password')
    $cipher = Protect-SandboxCredentialBytes -PlainBytes $plain
    [System.Convert]::ToBase64String($cipher) | Should Not Be ([System.Convert]::ToBase64String($plain))
  }
}

Describe 'Save-/Read-SandboxCredentialFile' {
  $tempDir = $null
  $tempFile = $null

  BeforeEach {
    $tempDir = Join-Path $env:TEMP ("sandbox-cred-file-test-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    $tempFile = Join-Path $tempDir 'sandbox-cred-test.bin'
  }

  AfterEach {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  It 'round-trips account name and cipher bytes' {
    $cipherBytes = [byte[]](1, 2, 3, 4, 5, 250, 251, 252)
    Save-SandboxCredentialFile -Path $tempFile -AccountName 'egpt-sbx-07' -CipherBytes $cipherBytes
    $result = Read-SandboxCredentialFile -Path $tempFile
    $result.AccountName | Should Be 'egpt-sbx-07'
    ($result.CipherBytes -join ',') | Should Be ($cipherBytes -join ',')
  }
}

Describe 'Get-SandboxCredential self-heal on a fresh/missing file' {
  $tempDir = $null

  BeforeEach {
    $tempDir = Join-Path $env:TEMP ("sandbox-cred-selfheal-" + [Guid]::NewGuid())
    $script:CredDir = $tempDir
    $script:FakeExistingUser = $null
    $script:NewLocalUserCalls = 0
    $script:SetLocalUserCalls = 0
  }

  AfterEach {
    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
  }

  It 'creates a brand-new account, persists the new-format file, and returns a matching PSCredential' {
    $script:FakeExistingUser = $null

    $result = Get-SandboxCredential -AccountName 'egpt-sbx-test-new'

    $script:NewLocalUserCalls | Should Be 1
    $result.UserName | Should Be 'egpt-sbx-test-new'

    $credFile = Join-Path $tempDir 'sandbox-cred-egpt-sbx-test-new.bin'
    Test-Path -LiteralPath $credFile | Should Be $true

    $stored = Read-SandboxCredentialFile -Path $credFile
    $stored.AccountName | Should Be 'egpt-sbx-test-new'
    $rawBytes = Unprotect-SandboxCredentialBytes -CipherBytes $stored.CipherBytes
    ([System.Text.Encoding]::UTF8.GetString($rawBytes)) | Should Be (Get-PlainPassword $result)
  }

  It 'resets the password and rewrites the file when the account exists but the file is missing' {
    $script:FakeExistingUser = [PSCustomObject]@{ Name = 'egpt-sbx-test-existing' }

    $result = Get-SandboxCredential -AccountName 'egpt-sbx-test-existing'

    $script:SetLocalUserCalls | Should Be 1
    $script:NewLocalUserCalls | Should Be 0
    $result.UserName | Should Be 'egpt-sbx-test-existing'

    $credFile = Join-Path $tempDir 'sandbox-cred-egpt-sbx-test-existing.bin'
    Test-Path -LiteralPath $credFile | Should Be $true
  }

  It 'reads back an already-persisted file without calling New-/Set-LocalUser' {
    $script:FakeExistingUser = [PSCustomObject]@{ Name = 'egpt-sbx-test-cached' }
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    $credFile = Join-Path $tempDir 'sandbox-cred-egpt-sbx-test-cached.bin'
    $cipherBytes = Protect-SandboxCredentialBytes -PlainBytes ([System.Text.Encoding]::UTF8.GetBytes('cached-pass!Aa1'))
    Save-SandboxCredentialFile -Path $credFile -AccountName 'egpt-sbx-test-cached' -CipherBytes $cipherBytes

    $result = Get-SandboxCredential -AccountName 'egpt-sbx-test-cached'

    $script:NewLocalUserCalls | Should Be 0
    $script:SetLocalUserCalls | Should Be 0
    (Get-PlainPassword $result) | Should Be 'cached-pass!Aa1'
  }
}

# ---- STICKY LEASES (operator ruling 2026-09-06) --------------------------
# Before this, sandbox-logon-launcher.ps1 walked the pool in a fresh
# `Get-Random -InputObject $poolNames -Count $poolNames.Count` order every
# sweep, so the SAME conversation leased a different Windows account each
# time. That is fatal to any per-conversation state Windows binds to the
# account that wrote it - above all a Chrome profile, whose cookie master key
# is DPAPI-sealed to its writer. These pin the replacement: a preference that
# is stable, and a walk that still reaches every other account.
#
# Pure functions over a STRING - no account, no lock file, no filesystem - so
# they need neither the pool provisioned nor ProgramData written.
$script:PoolTestFolder = 'C:\egpt-test\conversations\whatsapp\conv-alpha'

Describe 'Get-SandboxPoolAccountForFolder (which account a conversation prefers)' {
  It 'returns the SAME account for the same folder on two consecutive leases' {
    $first = Get-SandboxPoolAccountForFolder -Folder $script:PoolTestFolder
    $second = Get-SandboxPoolAccountForFolder -Folder $script:PoolTestFolder
    $second | Should Be $first
  }

  It 'returns the same account from a SEPARATE powershell process' {
    # THE test that rules out [string]::GetHashCode(): a lease happens in a
    # brand-new powershell.exe every warm session, so an in-process-only hash
    # would satisfy the test above and still hand out a different account
    # tomorrow.
    $inProcess = Get-SandboxPoolAccountForFolder -Folder $script:PoolTestFolder
    $cmd = ". '$script:SandboxAccountScript'; Get-SandboxPoolAccountForFolder -Folder '$script:PoolTestFolder'"
    $child = & (Join-Path $PSHOME 'powershell.exe') -NoProfile -NonInteractive -Command $cmd
    (@($child)[-1]).Trim() | Should Be $inProcess
  }

  It 'normalises the folder, so one conversation cannot map to two accounts' {
    # All four are the same directory: the launcher is handed a Node-normalised
    # 'C:/...' cwd, and Windows paths are case-insensitive.
    $expected = Get-SandboxPoolAccountForFolder -Folder $script:PoolTestFolder
    (Get-SandboxPoolAccountForFolder -Folder 'C:/egpt-test/conversations/whatsapp/conv-alpha') | Should Be $expected
    (Get-SandboxPoolAccountForFolder -Folder 'C:\egpt-test\conversations\whatsapp\conv-alpha\') | Should Be $expected
    (Get-SandboxPoolAccountForFolder -Folder 'C:\EGPT-TEST\Conversations\WhatsApp\CONV-ALPHA') | Should Be $expected
    (Get-SandboxPoolAccountForFolder -Folder 'C:\egpt-test\conversations\slack\..\whatsapp\conv-alpha') | Should Be $expected
  }

  It 'always names an account that is actually in the pool' {
    $pool = @(Get-SandboxPoolAccountNames)
    foreach ($i in 1..50) {
      $pool -contains (Get-SandboxPoolAccountForFolder -Folder "C:\egpt-test\conversations\conv-$i") | Should Be $true
    }
  }

  It 'spreads distinct conversations across the pool rather than piling them on one account' {
    $chosen = 1..200 | ForEach-Object { Get-SandboxPoolAccountForFolder -Folder "C:\egpt-test\conversations\conv-$_" }
    $distinct = @($chosen | Select-Object -Unique)
    # 16 accounts, 200 folders: anything below half means the digest is being
    # thrown away somewhere.
    ($distinct.Count -ge 8) | Should Be $true
  }
}

Describe 'Get-SandboxPoolLeaseOrder (the order the launcher walks the pool in)' {
  It 'puts the preferred account first, on every single sweep' {
    $preferred = Get-SandboxPoolAccountForFolder -Folder $script:PoolTestFolder
    foreach ($i in 1..20) {
      (Get-SandboxPoolLeaseOrder -Folder $script:PoolTestFolder)[0] | Should Be $preferred
    }
  }

  It 'still contains EVERY other account, so a held preferred account falls back instead of wedging' {
    $order = @(Get-SandboxPoolLeaseOrder -Folder $script:PoolTestFolder)
    $pool = @(Get-SandboxPoolAccountNames)
    $order.Count | Should Be $pool.Count
    (($order | Sort-Object) -join ',') | Should Be (($pool | Sort-Object) -join ',')
  }

  It 'shuffles the fallback tail, so turns that lose their preference do not all pile onto the same next name' {
    $tails = 1..10 | ForEach-Object { (@(Get-SandboxPoolLeaseOrder -Folder $script:PoolTestFolder) | Select-Object -Skip 1) -join ',' }
    (@($tails | Select-Object -Unique).Count -gt 1) | Should Be $true
  }
}

# ---------------------------------------------------------------------------
# THE LEASE LEDGER AND THE ACE REVOKE (2026-09-11). This is the REAL coverage
# for the hard-kill ACE leak: tests/sandbox-ace-reclaim.test.mjs can only lock
# the launcher's SOURCE (it is a .ps1 with a param block, so vitest cannot run
# it), and everything below actually grants, kills and revokes.
#
# Everything here runs UNELEVATED against a throwaway directory under $env:TEMP
# and against the CURRENT user's own SID. It never touches a pool account, the
# real C:\ProgramData\egpt, or any conversation folder.
$script:LedgerTempRoot = Join-Path $env:TEMP ("egpt-ledger-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:LedgerTempRoot -Force | Out-Null
$script:MeName = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).Name
$script:MeSid  = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User

function New-LedgerTempDir {
  $p = Join-Path $script:LedgerTempRoot ([guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $p -Force | Out-Null
  return $p
}
function Grant-TestModify([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $script:MeSid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Grant-TestReadAndExecute([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $script:MeSid, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Get-TestExplicitAceCount([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  return @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) |
    Where-Object { $_.IdentityReference.Value -eq $script:MeSid.Value }).Count
}
function New-TestLock([string]$Path) {
  return [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite)
}
# A SECOND and THIRD principal for the grouped revoke, so "N accounts off ONE
# path in ONE pass" can be tested at all. Both are well-known SIDs that resolve
# on any Windows box, and they are only ever granted on a throwaway directory
# under $env:TEMP that this file created and deletes.
$script:OtherNames = @('Everyone', 'BUILTIN\Guests')
function Grant-TestModifyTo([string]$Path, [string]$AccountName) {
  $sid = (New-Object System.Security.Principal.NTAccount($AccountName)).Translate([System.Security.Principal.SecurityIdentifier])
  $acl = Get-Acl -LiteralPath $Path
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $sid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Get-TestExplicitAceCountFor([string]$Path, [string]$AccountName) {
  $sid = (New-Object System.Security.Principal.NTAccount($AccountName)).Translate([System.Security.Principal.SecurityIdentifier])
  $acl = Get-Acl -LiteralPath $Path
  return @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) |
    Where-Object { $_.IdentityReference.Value -eq $sid.Value }).Count
}

Describe 'the lease ledger (the lock file doubles as the list of ACEs this turn granted)' {
  It 'round-trips paths and hides its own header from readers' {
    $lock = Join-Path $script:LedgerTempRoot 'a.lock'
    $s = New-TestLock $lock
    try {
      Write-SandboxLeaseLedger -Stream $s
      (@(Read-SandboxLeaseLedger -Stream $s).Count) | Should Be 0
      Add-SandboxLeaseLedgerPath -Stream $s -Path 'C:\one'
      Add-SandboxLeaseLedgerPath -Stream $s -Path 'C:\two dir\with space'
      ((Read-SandboxLeaseLedger -Stream $s) -join '|') | Should Be 'C:\one|C:\two dir\with space'
    } finally { $s.Close(); Remove-Item -LiteralPath $lock -Force }
  }

  It 'reads a PRE-LEDGER lock file (every lock written before this change is 0 bytes) as zero paths, not as an error' {
    $lock = Join-Path $script:LedgerTempRoot 'legacy.lock'
    [System.IO.File]::WriteAllBytes($lock, (New-Object byte[] 0))
    $s = [System.IO.File]::Open($lock, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try { (@(Read-SandboxLeaseLedger -Stream $s).Count) | Should Be 0 }
    finally { $s.Close(); Remove-Item -LiteralPath $lock -Force }
  }

  It 'Write-SandboxLeaseLedger REPLACES the list, so a reclaim can drop what it cleaned' {
    $lock = Join-Path $script:LedgerTempRoot 'b.lock'
    $s = New-TestLock $lock
    try {
      Write-SandboxLeaseLedger -Stream $s -Paths @('C:\x', 'C:\y', 'C:\z')
      Write-SandboxLeaseLedger -Stream $s -Paths @('C:\y')
      ((Read-SandboxLeaseLedger -Stream $s) -join '|') | Should Be 'C:\y'
    } finally { $s.Close(); Remove-Item -LiteralPath $lock -Force }
  }

  It 'SURVIVES A REAL HARD KILL: entries written by a process that is then TerminateProcess-d are still on disk' {
    # THE WHOLE POINT OF Flush($true). A child powershell takes the lock exactly
    # the way the launcher does, records two paths, and is then killed with
    # Stop-Process -Force -- no finally, no flush, no close. The parent then
    # takes the lock exclusively (which is how the launcher's reclaim detects a
    # dead turn in the first place) and must still find both paths.
    $lock = Join-Path $script:LedgerTempRoot 'killed.lock'
    $ready = Join-Path $script:LedgerTempRoot 'killed.ready'
    $lib = $script:SandboxAccountScript
    $cmd = ". '$lib'; " +
      "`$s = [System.IO.File]::Open('$lock', [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite); " +
      "Write-SandboxLeaseLedger -Stream `$s; " +
      "Add-SandboxLeaseLedgerPath -Stream `$s -Path 'C:\dead-turn\conversation'; " +
      "Add-SandboxLeaseLedgerPath -Stream `$s -Path 'C:\dead-turn\jsonl-store'; " +
      "Set-Content -LiteralPath '$ready' -Value 'go'; " +
      "while (`$true) { Start-Sleep -Seconds 5 }"
    $child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', $cmd) -PassThru -WindowStyle Hidden
    try {
      $waited = 0
      while (-not (Test-Path -LiteralPath $ready) -and $waited -lt 300) { Start-Sleep -Milliseconds 100; $waited++ }
      (Test-Path -LiteralPath $ready) | Should Be $true
      Stop-Process -Id $child.Id -Force
      $child.WaitForExit(15000) | Out-Null
      # Exactly the reclaim's own test: an exclusive open succeeds only because
      # no process holds the file any more.
      $s2 = $null
      $waited = 0
      while ($null -eq $s2 -and $waited -lt 100) {
        try { $s2 = [System.IO.File]::Open($lock, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
        catch { Start-Sleep -Milliseconds 100; $waited++ }
      }
      ($null -ne $s2) | Should Be $true
      try { ((Read-SandboxLeaseLedger -Stream $s2) -join '|') | Should Be 'C:\dead-turn\conversation|C:\dead-turn\jsonl-store' }
      finally { $s2.Close() }
    } finally {
      try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch { }
      Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $ready -Force -ErrorAction SilentlyContinue
    }
  }
}

# THE GROUPED REVOKE (operator 2026-09-20). Revoke-SandboxPathAces is now the one
# ACL edit in the sandbox, and it is keyed by PATH: every account that leaked an
# ACE onto a path comes off it in a SINGLE icacls pass, because the cost of a
# revoke is the tree (inheritance re-propagation), not the ACE. Measured by hand
# on reve that day: twelve Set-Acl passes over ~\src\egpt = minutes and looked
# like a hang; `icacls ~\src\egpt /remove:g egpt-sbx-00 ... /C` = 2 s for all
# twelve.
Describe 'Revoke-SandboxPathAces (one path, every account on it, ONE icacls pass)' {
  AfterEach { $script:IcaclsSpy = $null }

  It 'takes THREE accounts off one directory and reports each of them revoked' {
    $d = New-LedgerTempDir
    $accounts = @($script:MeName) + $script:OtherNames
    foreach ($a in $accounts) { Grant-TestModifyTo $d $a }
    foreach ($a in $accounts) { (Get-TestExplicitAceCountFor $d $a) | Should Be 1 }

    $recs = @(Revoke-SandboxPathAces -Path $d -AccountNames $accounts)

    $recs.Count | Should Be 3
    (@($recs | Where-Object { $_.Status -eq 'revoked' }).Count) | Should Be 3
    foreach ($a in $accounts) { (Get-TestExplicitAceCountFor $d $a) | Should Be 0 }
  }

  It 'REPRODUCE-FIRST: it is ONE command for the path, naming every account - not one command per account' {
    # The defect this locks: the sweep used to call Set-Acl once per ACCOUNT, so
    # fifteen abandoned leases on one shared tree walked that tree fifteen times.
    $d = New-LedgerTempDir
    $accounts = @($script:MeName) + $script:OtherNames
    foreach ($a in $accounts) { Grant-TestModifyTo $d $a }
    $script:IcaclsSpy = New-Object System.Collections.Generic.List[object]

    Revoke-SandboxPathAces -Path $d -AccountNames $accounts | Out-Null

    $script:IcaclsSpy.Count | Should Be 1
    $callArgs = @($script:IcaclsSpy[0])
    $callArgs[0] | Should Be $d
    ($callArgs -contains '/remove:g') | Should Be $true
    # Every account is on that ONE command line, as a SID literal.
    foreach ($a in $accounts) {
      $sid = (New-Object System.Security.Principal.NTAccount($a)).Translate([System.Security.Principal.SecurityIdentifier])
      ($callArgs -contains "*$($sid.Value)") | Should Be $true
    }
    # No /T: a lease ACE is explicit and on the named object only, so recursing
    # would re-walk the very tree this change exists to stop re-walking.
    ($callArgs -contains '/T') | Should Be $false
  }

  It 'AN ACE THAT IS ALREADY GONE IS SUCCESS, AND COSTS NO WRITE AT ALL' {
    # Operator 2026-09-20, after removing the twelve leaked ACEs by hand: "a
    # revoke of an ACE that is already gone is SUCCESS, not failure". It must
    # reconcile to 'clean' - and it must not run icacls at all, which is what
    # makes the fifteen already-cleared locks sweep in milliseconds.
    $d = New-LedgerTempDir
    $script:IcaclsSpy = New-Object System.Collections.Generic.List[object]

    $recs = @(Revoke-SandboxPathAces -Path $d -AccountNames @($script:MeName, 'Everyone'))

    $recs.Count | Should Be 2
    (@($recs | Where-Object { $_.Status -eq 'clean' }).Count) | Should Be 2
    $script:IcaclsSpy.Count | Should Be 0
  }

  It 'names only the accounts that actually carry an ACE, and calls the others clean' {
    $d = New-LedgerTempDir
    Grant-TestModifyTo $d 'Everyone'
    $script:IcaclsSpy = New-Object System.Collections.Generic.List[object]

    $recs = @(Revoke-SandboxPathAces -Path $d -AccountNames @($script:MeName, 'Everyone'))

    $script:IcaclsSpy.Count | Should Be 1
    $everyone = (New-Object System.Security.Principal.NTAccount('Everyone')).Translate([System.Security.Principal.SecurityIdentifier])
    (@($script:IcaclsSpy[0]) -contains "*$($everyone.Value)") | Should Be $true
    (@($script:IcaclsSpy[0]) -contains "*$($script:MeSid.Value)") | Should Be $false
    (@($recs | Where-Object { $_.Account -eq $script:MeName }).Status) | Should Be 'clean'
  }

  It 'reports FAILED, not revoked, when the ACE is still standing afterwards - the DACL decides, not the exit code' {
    # The spy returns exit 0 without touching anything. A revoke that trusted the
    # exit code would call that success and forget a live leak.
    $d = New-LedgerTempDir
    Grant-TestModifyTo $d $script:MeName
    $script:IcaclsSpy = New-Object System.Collections.Generic.List[object]

    $recs = @(Revoke-SandboxPathAces -Path $d -AccountNames @($script:MeName))

    $recs[0].Status | Should Be 'failed'
    (Get-TestExplicitAceCount $d) | Should Be 1
  }

  It 'reports MISSING for every account when the path is gone, and FAILED for an account nobody can name' {
    $recs = @(Revoke-SandboxPathAces -Path (Join-Path $script:LedgerTempRoot 'never-existed-grouped') -AccountNames @($script:MeName, 'Everyone'))
    (@($recs | Where-Object { $_.Status -eq 'missing' }).Count) | Should Be 2

    $d = New-LedgerTempDir; Grant-TestModifyTo $d $script:MeName
    $mixed = @(Revoke-SandboxPathAces -Path $d -AccountNames @('egpt-no-such-account-zzz', $script:MeName))
    (@($mixed | Where-Object { $_.Status -eq 'failed' }).Count) | Should Be 1
    (@($mixed | Where-Object { $_.Status -eq 'revoked' }).Count) | Should Be 1
    # One unnameable principal must not cost the nameable one its cleanup.
    (Get-TestExplicitAceCount $d) | Should Be 0
  }

  It 'is a no-op on an empty account list' {
    (@(Revoke-SandboxPathAces -Path (New-LedgerTempDir) -AccountNames @()).Count) | Should Be 0
  }
}

Describe 'Revoke-SandboxLeaseAces (the ONE revoke both the finally and the reclaim go through)' {
  It 'purges a real explicit ACE off a real directory and reports it revoked' {
    $d = New-LedgerTempDir
    (Get-TestExplicitAceCount $d) | Should Be 0
    Grant-TestModify $d
    (Get-TestExplicitAceCount $d) | Should Be 1
    $recs = @(Revoke-SandboxLeaseAces -AccountName $script:MeName -Paths @($d))
    $recs.Count | Should Be 1
    $recs[0].Status | Should Be 'revoked'
    (Get-TestExplicitAceCount $d) | Should Be 0
  }

  It 'purges a READ-ONLY (ReadAndExecute) ACE too - the revoke is by SID, not by rights' {
    # THE NEW CLASS (2026-09-13): a -SharePathReadOnly entry gets ReadAndExecute
    # instead of Modify. It rides the SAME ledger and the SAME revoke, and this
    # is what proves the revoke does not quietly only understand Modify - a
    # read-only ACE nobody ever revokes is the identical leak this ledger exists
    # to prevent, and pool accounts are REUSED across conversations.
    $d = New-LedgerTempDir
    Grant-TestReadAndExecute $d
    (Get-TestExplicitAceCount $d) | Should Be 1
    $recs = @(Revoke-SandboxLeaseAces -AccountName $script:MeName -Paths @($d))
    $recs[0].Status | Should Be 'revoked'
    (Get-TestExplicitAceCount $d) | Should Be 0
  }

  It 'reports CLEAN and writes nothing when the path carries no ACE of ours' {
    $d = New-LedgerTempDir
    $recs = @(Revoke-SandboxLeaseAces -AccountName $script:MeName -Paths @($d))
    $recs[0].Status | Should Be 'clean'
  }

  It 'reports MISSING for a path that is gone, rather than throwing' {
    $recs = @(Revoke-SandboxLeaseAces -AccountName $script:MeName -Paths @((Join-Path $script:LedgerTempRoot 'never-existed')))
    $recs[0].Status | Should Be 'missing'
  }

  It 'keeps going after a bad entry, so one unpurgeable path cannot cost the others their cleanup' {
    $d1 = New-LedgerTempDir; Grant-TestModify $d1
    $d2 = New-LedgerTempDir; Grant-TestModify $d2
    $recs = @(Revoke-SandboxLeaseAces -AccountName $script:MeName -Paths @($d1, (Join-Path $script:LedgerTempRoot 'gone'), $d2))
    $recs.Count | Should Be 3
    (Get-TestExplicitAceCount $d1) | Should Be 0
    (Get-TestExplicitAceCount $d2) | Should Be 0
  }

  It 'reports every path FAILED when the account cannot even be named  - never a silent skip' {
    $d = New-LedgerTempDir; Grant-TestModify $d
    $recs = @(Revoke-SandboxLeaseAces -AccountName 'egpt-no-such-account-zzz' -Paths @($d, 'C:\whatever'))
    $recs.Count | Should Be 2
    (@($recs | Where-Object { $_.Status -eq 'failed' }).Count) | Should Be 2
    # ...and it did NOT quietly purge somebody else's ACE to make itself succeed.
    (Get-TestExplicitAceCount $d) | Should Be 1
  }

  It 'is a no-op on an empty list' {
    (@(Revoke-SandboxLeaseAces -AccountName $script:MeName -Paths @()).Count) | Should Be 0
  }
}

Describe 'Clear-SandboxStaleLease (what a RECLAIM does to a hard-killed turns leftovers)' {
  It 'revokes every ACE the dead turn recorded and empties the ledger' {
    $conv = New-LedgerTempDir; Grant-TestModify $conv
    $store = New-LedgerTempDir; Grant-TestModify $store
    $lock = Join-Path $script:LedgerTempRoot 'reclaim.lock'
    $s = New-TestLock $lock
    try {
      Write-SandboxLeaseLedger -Stream $s -Paths @($conv, $store)
      $recs = @(Clear-SandboxStaleLease -Stream $s -AccountName $script:MeName)
      (@($recs | Where-Object { $_.Status -eq 'revoked' }).Count) | Should Be 2
      (Get-TestExplicitAceCount $conv) | Should Be 0
      (Get-TestExplicitAceCount $store) | Should Be 0
      (@(Read-SandboxLeaseLedger -Stream $s).Count) | Should Be 0
    } finally { $s.Close(); Remove-Item -LiteralPath $lock -Force }
  }

  It 'CARRIES OVER what it could not revoke, so the leak is not forgotten' {
    $d = New-LedgerTempDir; Grant-TestModify $d
    $lock = Join-Path $script:LedgerTempRoot 'carry.lock'
    $s = New-TestLock $lock
    try {
      Write-SandboxLeaseLedger -Stream $s -Paths @($d)
      $recs = @(Clear-SandboxStaleLease -Stream $s -AccountName 'egpt-no-such-account-zzz')
      $recs[0].Status | Should Be 'failed'
      # Still granted, and still on the list for the next reclaim to retry.
      (Get-TestExplicitAceCount $d) | Should Be 1
      ((Read-SandboxLeaseLedger -Stream $s) -join '|') | Should Be $d
    } finally { $s.Close(); Remove-Item -LiteralPath $lock -Force }
  }

  It 'leaves a fresh, headed ledger behind, so the turn that now owns the lock can append to it' {
    $conv = New-LedgerTempDir; Grant-TestModify $conv
    $lock = Join-Path $script:LedgerTempRoot 'fresh.lock'
    $s = New-TestLock $lock
    try {
      Write-SandboxLeaseLedger -Stream $s -Paths @($conv)
      Clear-SandboxStaleLease -Stream $s -AccountName $script:MeName | Out-Null
      Add-SandboxLeaseLedgerPath -Stream $s -Path 'C:\this-turn'
      ((Read-SandboxLeaseLedger -Stream $s) -join '|') | Should Be 'C:\this-turn'
    } finally { $s.Close(); Remove-Item -LiteralPath $lock -Force }
  }
}

# ---------------------------------------------------------------------------
# THE TRAVERSE CHAIN (2026-09-13). Grant-SandboxPoolTraverse is what makes the
# five ancestor directories above a conversation folder WALKABLE by the pool
# without making them LISTABLE - the property the whole grant exists for, and
# the one an eyeball on an icacls line gets wrong easily, since (Rc,X,RA) and
# (RX) look alike and differ by exactly the read-data bit.
#
# These grant FOR REAL, against a throwaway directory under $env:TEMP, with
# $SandboxPoolGroup pointed at the CURRENT USER's own account - the same
# substitution the credential tests make with $CredDir, for the same reason:
# nothing here may touch the real pool group, the operator's profile, or any
# live ACL. Unelevated, like everything else below the ledger banner.
#
# WHAT THIS CANNOT COVER, and no in-process test can: that the real
# egpt-sandbox-pool group resolves on a real node, that the chain in
# provision-sandbox-account.ps1 names the right five directories, and that a
# leased egpt-sbx-NN can then actually walk them. Those are a provisioner run
# and an icacls read on a live node; see setup/SANDBOX.md's "Checking it".
$script:TraverseSavedGroup = $null

function Get-TestExplicitAces([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  return @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) |
    Where-Object { $_.IdentityReference.Value -eq $script:MeSid.Value })
}

# ExecuteFile (32, the traverse bit) | ReadAttributes (128) | ReadPermissions
# (131072). Spelled as a number because that is what the assertions compare, and
# spelled out here so a future reader does not have to decode it.
$script:TraverseRights = 131232

Describe 'Grant-SandboxPoolTraverse (walk through the directory, do not list it)' {
  BeforeEach {
    $script:TraverseSavedGroup = $SandboxPoolGroup
    $script:SandboxPoolGroup = $script:MeName
  }

  AfterEach {
    $script:SandboxPoolGroup = $script:TraverseSavedGroup
  }

  It 'writes exactly (X,RA,RC) and nothing else' {
    $d = New-LedgerTempDir
    (Get-TestExplicitAceCount $d) | Should Be 0
    Grant-SandboxPoolTraverse -Path $d
    $aces = @(Get-TestExplicitAces $d)
    $aces.Count | Should Be 1
    ([int]$aces[0].FileSystemRights) | Should Be $script:TraverseRights
    ($aces[0].AccessControlType.ToString()) | Should Be 'Allow'
  }

  It 'does NOT grant list-directory, so the operator home and the chat-folder names stay unenumerable' {
    # THE SECURITY PROPERTY. ListDirectory is the same bit as ReadData (1); if
    # this ever comes back non-zero, a sandboxed being can enumerate every
    # conversation slug on the box, which is precisely what the chain is shaped
    # to prevent while still letting it reach the one folder it was granted.
    $d = New-LedgerTempDir
    Grant-SandboxPoolTraverse -Path $d
    $rights = [int](@(Get-TestExplicitAces $d)[0].FileSystemRights)
    ($rights -band [int][System.Security.AccessControl.FileSystemRights]::ListDirectory) | Should Be 0
    ($rights -band [int][System.Security.AccessControl.FileSystemRights]::WriteData) | Should Be 0
    ($rights -band [int][System.Security.AccessControl.FileSystemRights]::ExecuteFile) | Should Not Be 0
  }

  It 'is NOT inheritable, so nothing under the directory picks the grant up' {
    $d = New-LedgerTempDir
    Grant-SandboxPoolTraverse -Path $d
    (@(Get-TestExplicitAces $d)[0].InheritanceFlags.ToString()) | Should Be 'None'
    $child = Join-Path $d 'child'
    New-Item -ItemType Directory -Path $child | Out-Null
    $inheritedHere = @((Get-Acl -LiteralPath $child).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
      Where-Object { [int]$_.FileSystemRights -eq $script:TraverseRights })
    $inheritedHere.Count | Should Be 0
  }

  It 'converges instead of accumulating: three runs leave exactly one ACE' {
    $d = New-LedgerTempDir
    foreach ($i in 1..3) { Grant-SandboxPoolTraverse -Path $d }
    (@(Get-TestExplicitAces $d).Count) | Should Be 1
    ([int](@(Get-TestExplicitAces $d)[0].FileSystemRights)) | Should Be $script:TraverseRights
  }

  It 'is ADDITIVE - a broader ACE already on the directory survives, and still nothing accumulates' {
    # icacls folds the grant into an existing ACE when the inheritance flags
    # match and writes a SEPARATE one when they do not, which is this case:
    # (OI)(CI)(RX) already there, traverse-only added beside it. Two ACEs after
    # the first run and still two after the third. This function never narrows -
    # the same additive character Grant-SandboxPoolAccess and
    # Grant-SandboxPoolModify have, and the reason ~\bin\egpt needed a hand
    # removal when its grant was reversed.
    $d = New-LedgerTempDir
    Grant-TestReadAndExecute $d
    foreach ($i in 1..3) { Grant-SandboxPoolTraverse -Path $d }
    $aces = @(Get-TestExplicitAces $d)
    $aces.Count | Should Be 2
    (@($aces | Where-Object { $_.InheritanceFlags.ToString() -ne 'None' }).Count) | Should Be 1
    (@($aces | Where-Object { [int]$_.FileSystemRights -eq $script:TraverseRights }).Count) | Should Be 1
  }

  It 'throws on a path that is not there, rather than reporting a grant it never made' {
    { Grant-SandboxPoolTraverse -Path (Join-Path $script:LedgerTempRoot 'never-existed-traverse') } | Should Throw
  }

  It 'fails loudly when the group cannot be resolved, instead of letting icacls pick a principal' {
    $d = New-LedgerTempDir
    $script:SandboxPoolGroup = 'egpt-no-such-group-zzz'
    { Grant-SandboxPoolTraverse -Path $d } | Should Throw
    (Get-TestExplicitAceCount $d) | Should Be 0
  }
}

# ---------------------------------------------------------------------------
# THE STANDING READ GRANT (2026-09-20). Grant-SandboxPoolAccess is what
# provision-sandbox-account.ps1 now puts on the operator's ~\src, so that the
# `src` junction the launcher plants in every pool profile resolves to something
# the leased account may actually open. The function had no coverage at all, and
# the one property that matters here is the one an eyeball gets wrong:
# ReadAndExecute and NOT Modify. Windows UNIONS Allow ACEs, so a slip here could
# never be narrowed again by anything granted per-turn afterwards.
#
# Same substitution as the traverse describe above - $SandboxPoolGroup points at
# the current user and the target is a throwaway directory under $env:TEMP - so
# nothing here touches the real pool group, the real ~\src, or any live ACL.
Describe 'Grant-SandboxPoolAccess (the standing read grant behind the src junction)' {
  BeforeEach {
    $script:TraverseSavedGroup = $SandboxPoolGroup
    $script:SandboxPoolGroup = $script:MeName
  }

  AfterEach {
    $script:SandboxPoolGroup = $script:TraverseSavedGroup
  }

  It 'grants ReadAndExecute and NOT Modify' {
    $d = New-LedgerTempDir
    Grant-SandboxPoolAccess -Path $d
    $aces = @(Get-TestExplicitAces $d)
    $aces.Count | Should Be 1
    $rights = [int]$aces[0].FileSystemRights
    ($rights -band [int][System.Security.AccessControl.FileSystemRights]::WriteData) | Should Be 0
    ($rights -band [int][System.Security.AccessControl.FileSystemRights]::AppendData) | Should Be 0
    ($rights -band [int][System.Security.AccessControl.FileSystemRights]::Delete) | Should Be 0
    ($rights -band [int][System.Security.AccessControl.FileSystemRights]::ReadData) | Should Not Be 0
    ($rights -band [int][System.Security.AccessControl.FileSystemRights]::ExecuteFile) | Should Not Be 0
    ($aces[0].AccessControlType.ToString()) | Should Be 'Allow'
  }

  It 'IS inheritable, unlike the traverse grant - the whole subtree under ~\src is the point' {
    $d = New-LedgerTempDir
    Grant-SandboxPoolAccess -Path $d
    (@(Get-TestExplicitAces $d)[0].InheritanceFlags.ToString()) | Should Be 'ContainerInherit, ObjectInherit'
    $child = Join-Path $d 'child'
    New-Item -ItemType Directory -Path $child | Out-Null
    $inherited = @((Get-Acl -LiteralPath $child).GetAccessRules($false, $true, [System.Security.Principal.SecurityIdentifier]) |
      Where-Object { $_.IdentityReference.Value -eq $script:MeSid.Value })
    $inherited.Count | Should Not Be 0
  }

  It 'is idempotent: three runs leave exactly one ACE' {
    $d = New-LedgerTempDir
    foreach ($i in 1..3) { Grant-SandboxPoolAccess -Path $d }
    (@(Get-TestExplicitAces $d).Count) | Should Be 1
  }

  It 'throws on a path that is not there, rather than reporting a grant it never made' {
    { Grant-SandboxPoolAccess -Path (Join-Path $script:LedgerTempRoot 'never-existed-access') } | Should Throw
  }
}

# ---------------------------------------------------------------------------
# THE POOL-WIDE RECLAIM (2026-09-20) - the repair path for the leak measured on
# kg: twelve standing (OI)(CI)(RX) ACEs on ~\src\egpt, one per pool account,
# because the launcher's per-account reclaim only fires when THAT account is
# leased again and several of them never were.
#
# The current user stands in for a pool account throughout: $SandboxPoolPrefix
# is pointed at $env:USERNAME (the same substitution the two describes above
# make with $SandboxPoolGroup) so the lock file can be named after an account
# whose SID really resolves, and -LocksDir always points at a throwaway
# directory, never at C:\ProgramData\egpt\sandbox-pool-locks.
$script:MeUser = $env:USERNAME
$script:PrefixSaved = $null

Describe 'Clear-SandboxAbandonedLeases (the repair path for leases nothing will lease again)' {
  $locks = $null

  BeforeEach {
    $script:PrefixSaved = $SandboxPoolPrefix
    $script:SandboxPoolPrefix = $script:MeUser
    $locks = Join-Path $script:LedgerTempRoot ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $locks -Force | Out-Null
  }

  AfterEach {
    $script:SandboxPoolPrefix = $script:PrefixSaved
    $script:IcaclsSpy = $null
    Remove-Item -LiteralPath $locks -Recurse -Force -ErrorAction SilentlyContinue
  }

  It 'revokes what a dead lease ledger names and releases the lock' {
    $shared = New-LedgerTempDir; Grant-TestReadAndExecute $shared
    $conv = New-LedgerTempDir; Grant-TestModify $conv
    $lock = Join-Path $locks "$($script:MeUser).lock"
    $s = New-TestLock $lock
    try { Write-SandboxLeaseLedger -Stream $s -Paths @($shared, $conv) } finally { $s.Close() }

    $recs = @(Clear-SandboxAbandonedLeases -LocksDir $locks)

    $recs.Count | Should Be 1
    $recs[0].Status | Should Be 'reclaimed'
    (Get-TestExplicitAceCount $shared) | Should Be 0
    (Get-TestExplicitAceCount $conv) | Should Be 0
    (Test-Path -LiteralPath $lock) | Should Be $false
  }

  It 'LEAVES A LIVE LEASE ALONE - an open handle is the lease, exactly as the launcher reads it' {
    $conv = New-LedgerTempDir; Grant-TestModify $conv
    $lock = Join-Path $locks "$($script:MeUser).lock"
    $s = New-TestLock $lock
    try {
      Write-SandboxLeaseLedger -Stream $s -Paths @($conv)
      $recs = @(Clear-SandboxAbandonedLeases -LocksDir $locks)
      $recs.Count | Should Be 1
      $recs[0].Status | Should Be 'held'
      # Still granted and still locked: a running turn must not have its ACE
      # pulled out from under it, and must not lose its lease either.
      (Get-TestExplicitAceCount $conv) | Should Be 1
      (Test-Path -LiteralPath $lock) | Should Be $true
    } finally { $s.Close() }
  }

  It 'KEEPS the lock when a revoke failed, so the leak is not forgotten' {
    # The account the lock is named after does not resolve to a SID, so every
    # path on its ledger comes back 'failed'. The lock must survive, holding
    # exactly those paths, for the next reclaim to retry.
    $script:SandboxPoolPrefix = 'egpt-no-such-account-zzz'
    $d = New-LedgerTempDir; Grant-TestModify $d
    $lock = Join-Path $locks 'egpt-no-such-account-zzz-01.lock'
    $s = New-TestLock $lock
    try { Write-SandboxLeaseLedger -Stream $s -Paths @($d) } finally { $s.Close() }

    $recs = @(Clear-SandboxAbandonedLeases -LocksDir $locks)

    $recs[0].Status | Should Be 'partial'
    (Get-TestExplicitAceCount $d) | Should Be 1
    (Test-Path -LiteralPath $lock) | Should Be $true
    $s2 = [System.IO.File]::Open($lock, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try { ((Read-SandboxLeaseLedger -Stream $s2) -join '|') | Should Be $d } finally { $s2.Close() }
  }

  It 'refuses a lock whose name is not a pool account, rather than purging ACEs for whoever it names' {
    $lock = Join-Path $locks 'Administrator.lock'
    $s = New-TestLock $lock
    try { Write-SandboxLeaseLedger -Stream $s -Paths @('C:\Windows') } finally { $s.Close() }

    $recs = @(Clear-SandboxAbandonedLeases -LocksDir $locks)

    $recs[0].Status | Should Be 'skipped'
    (Test-Path -LiteralPath $lock) | Should Be $true
  }

  It 'is a no-op on a locks directory that is not there' {
    (@(Clear-SandboxAbandonedLeases -LocksDir (Join-Path $script:LedgerTempRoot 'no-such-locks-dir')).Count) | Should Be 0
  }

  # ---- THE SHAPE OF THE LEAK AS IT WAS ACTUALLY FOUND (operator 2026-09-20):
  # fifteen abandoned locks, twelve of them naming the SAME path, ~\src\egpt.
  # $SandboxPoolPrefix is widened to '' here so that more than one lock name can
  # be a "pool account" - a prefix every string starts with - which is the only
  # way to get two DIFFERENT resolvable principals into one sweep.
  It 'REPRODUCE-FIRST: two dead leases on ONE shared path are revoked in ONE icacls pass' {
    # THE SHAPE OF THE LEAK AS IT WAS ACTUALLY FOUND: fifteen abandoned locks,
    # twelve of them naming the SAME path, ~\src\egpt. The old sweep walked that
    # tree once per ACCOUNT. $SandboxPoolPrefix is widened to '' - a prefix every
    # string starts with - because that is the only way to get two DIFFERENT
    # resolvable principals into one sweep on a box with one real user.
    $script:SandboxPoolPrefix = ''
    $shared = New-LedgerTempDir
    Grant-TestModifyTo $shared $script:MeName
    Grant-TestModifyTo $shared 'Everyone'
    foreach ($a in @($script:MeUser, 'Everyone')) {
      $s = New-TestLock (Join-Path $locks "$a.lock")
      try { Write-SandboxLeaseLedger -Stream $s -Paths @($shared) } finally { $s.Close() }
    }

    $script:IcaclsSpy = New-Object System.Collections.Generic.List[object]
    Clear-SandboxAbandonedLeases -LocksDir $locks | Out-Null

    # ONE pass for the ONE path, both accounts named on it - not one pass each.
    $script:IcaclsSpy.Count | Should Be 1
    $callArgs = @($script:IcaclsSpy[0])
    $callArgs[0] | Should Be $shared
    foreach ($a in @($script:MeName, 'Everyone')) {
      $sid = (New-Object System.Security.Principal.NTAccount($a)).Translate([System.Security.Principal.SecurityIdentifier])
      ($callArgs -contains "*$($sid.Value)") | Should Be $true
    }
  }

  It 'REPRODUCE-FIRST: the same two leases really do come off, and both locks are released' {
    # The spy off: the end-to-end version of the test above.
    $script:SandboxPoolPrefix = ''
    $shared = New-LedgerTempDir
    Grant-TestModifyTo $shared $script:MeName
    Grant-TestModifyTo $shared 'Everyone'
    foreach ($a in @($script:MeUser, 'Everyone')) {
      $s = New-TestLock (Join-Path $locks "$a.lock")
      try { Write-SandboxLeaseLedger -Stream $s -Paths @($shared) } finally { $s.Close() }
    }

    $recs = @(Clear-SandboxAbandonedLeases -LocksDir $locks)

    (@($recs | Where-Object { $_.Status -eq 'reclaimed' }).Count) | Should Be 2
    (Get-TestExplicitAceCountFor $shared $script:MeName) | Should Be 0
    (Get-TestExplicitAceCountFor $shared 'Everyone') | Should Be 0
    (@(Get-ChildItem -LiteralPath $locks -Filter '*.lock' -File).Count) | Should Be 0
  }

  It 'ACCEPTANCE: locks whose ACEs are ALREADY gone clear cleanly, with no icacls run at all' {
    # THE FIFTEEN. The operator removed the twelve leaked ACEs by hand and left
    # the locks behind; the next sweep must reconcile them to "not granted",
    # release every lock, and cost nothing. A revoke of an absent ACE is SUCCESS.
    $script:SandboxPoolPrefix = ''
    $gone = New-LedgerTempDir
    foreach ($a in @($script:MeUser, 'Everyone')) {
      $s = New-TestLock (Join-Path $locks "$a.lock")
      try { Write-SandboxLeaseLedger -Stream $s -Paths @($gone) } finally { $s.Close() }
    }
    $script:IcaclsSpy = New-Object System.Collections.Generic.List[object]

    $recs = @(Clear-SandboxAbandonedLeases -LocksDir $locks)

    (@($recs | Where-Object { $_.Status -eq 'reclaimed' }).Count) | Should Be 2
    (@($recs | ForEach-Object { $_.Aces } | Where-Object { $_.Status -eq 'clean' }).Count) | Should Be 2
    (@(Get-ChildItem -LiteralPath $locks -Filter '*.lock' -File).Count) | Should Be 0
    $script:IcaclsSpy.Count | Should Be 0
  }
}

# ---------------------------------------------------------------------------
# THE SKIP-WHEN-ALREADY-COVERED RULE (operator 2026-09-20). ~\src now carries a
# standing (OI)(CI)(RX) for the pool GROUP, so a per-turn read-only share ACE
# under it grants a being what it already has and leaves one more ACE for a hard
# kill to leak. Test-SandboxPoolReadCovered is what the launcher asks before it
# skips one, and a WRONG SKIP means a being silently loses read access mid-turn -
# so every one of its four conditions is pinned here against a real DACL.
#
# Same substitution as the grant describes above: $SandboxPoolGroup points at the
# current user, so "the group" is a principal these tests can really grant.
Describe 'Test-SandboxPoolReadCovered (is a per-turn read ACE redundant here?)' {
  BeforeEach {
    $script:TraverseSavedGroup = $SandboxPoolGroup
    $script:SandboxPoolGroup = $script:MeName
  }

  AfterEach {
    $script:SandboxPoolGroup = $script:TraverseSavedGroup
  }

  It 'says NO on a bare directory - nothing is covered, so the grant must still happen' {
    (Test-SandboxPoolReadCovered -Path (New-LedgerTempDir) -LeasedSid $script:MeSid) | Should Be $false
  }

  It 'says YES on a child that INHERITS the group (OI)(CI)(RX) - the case the operator named' {
    $parent = New-LedgerTempDir
    Grant-SandboxPoolAccess -Path $parent
    $child = Join-Path $parent 'egpt'
    New-Item -ItemType Directory -Path $child | Out-Null
    (Test-SandboxPoolReadCovered -Path $child -LeasedSid $script:MeSid) | Should Be $true
  }

  It 'says YES on the granted directory itself - an explicit standing group grant is the same fact' {
    $d = New-LedgerTempDir
    Grant-SandboxPoolAccess -Path $d
    (Test-SandboxPoolReadCovered -Path $d -LeasedSid $script:MeSid) | Should Be $true
  }

  It 'says NO to a TRAVERSE-only grant - (X,RA,RC) withholds read-data on purpose' {
    # THE ONE THAT MATTERS MOST. (X,RA,RC) and (RX) look alike in an icacls dump
    # and differ by exactly the read-data bit. Skipping on a traverse grant would
    # hand a being a directory it can walk through and cannot open.
    $d = New-LedgerTempDir
    Grant-SandboxPoolTraverse -Path $d
    (Test-SandboxPoolReadCovered -Path $d -LeasedSid $script:MeSid) | Should Be $false
  }

  It 'says NO when a lease ACE for the ACCOUNT is the only read there - litter never satisfies it' {
    # An ACE naming an individual pool account is exactly what the sweep exists
    # to remove. If it could satisfy this check, one leaked ACE would suppress
    # the grant that replaces it.
    $d = New-LedgerTempDir
    $script:SandboxPoolGroup = 'Everyone'
    Grant-TestReadAndExecute $d
    (Test-SandboxPoolReadCovered -Path $d -LeasedSid $script:MeSid) | Should Be $false
  }

  It 'says NO when a DENY touches either principal, even with the group read in place' {
    # An explicit Allow for the leased ACCOUNT beats an inherited Deny for the
    # group, so where a Deny exists the per-account grant is NOT redundant.
    $d = New-LedgerTempDir
    Grant-SandboxPoolAccess -Path $d
    (Test-SandboxPoolReadCovered -Path $d -LeasedSid $script:MeSid) | Should Be $true
    $acl = Get-Acl -LiteralPath $d
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
      $script:MeSid, 'Write', 'ContainerInherit,ObjectInherit', 'None', 'Deny')))
    Set-Acl -LiteralPath $d -AclObject $acl
    (Test-SandboxPoolReadCovered -Path $d -LeasedSid $script:MeSid) | Should Be $false
  }

  It 'says NO rather than throwing when the path is gone or the group does not resolve' {
    (Test-SandboxPoolReadCovered -Path (Join-Path $script:LedgerTempRoot 'never-existed-cover') -LeasedSid $script:MeSid) | Should Be $false
    $d = New-LedgerTempDir
    Grant-SandboxPoolAccess -Path $d
    $script:SandboxPoolGroup = 'egpt-no-such-group-zzz'
    (Test-SandboxPoolReadCovered -Path $d -LeasedSid $script:MeSid) | Should Be $false
  }
}

# ---------------------------------------------------------------------------
# THE TWO JUNCTIONS IN A POOL PROFILE (2026-09-20). The statement under test is
# NOT copied here - Get-SandboxProfileJunctionStatement is asked for the very
# string the launcher puts in the scrub payload, and that string is then RUN,
# because a copy would pass while the shipped one was broken. That is not
# hypothetical: the first version of it read `-EA 0>$null` without the space,
# which PowerShell binds as part of a PARAMETER NAME, and no structural test
# would have caught it. (It used to be scraped out of the launcher by line match;
# the generator moved into sandbox-account.ps1 when `my-code` joined `src`, so
# the test can now just call it.)
#
# It runs against a throwaway directory under $env:TEMP with $r bound to it, so
# nothing here touches a real pool profile, and -OperatorSrc is a throwaway tree
# rather than the operator's own ~\src.
$script:LauncherScript = Join-Path $PSScriptRoot 'sandbox-logon-launcher.ps1'

Describe 'the pool profile junctions (as the launcher scrub really plants them)' {
  $fakeProfile = $null
  $target = $null
  $stmt = $null

  BeforeEach {
    $fakeProfile = New-LedgerTempDir
    # Stands in for ~\src, with an `egpt` child standing in for the checkout.
    $target = New-LedgerTempDir
    New-Item -ItemType Directory -Path (Join-Path $target 'marker') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $target 'egpt') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $target 'egpt\src') -Force | Out-Null
    $stmt = Get-SandboxProfileJunctionStatement -OperatorSrc $target
  }

  It 'plants BOTH junctions - src at the operator src, my-code at the eGPT checkout - and says nothing on stdout' {
    $r = $fakeProfile
    Invoke-Expression $stmt | Should BeNullOrEmpty
    $src = Get-Item -LiteralPath (Join-Path $r 'src') -Force
    ([bool]($src.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) | Should Be $true
    $src.Target | Should Be $target
    (Test-Path -LiteralPath (Join-Path (Join-Path $r 'src') 'marker')) | Should Be $true

    $mine = Get-Item -LiteralPath (Join-Path $r 'my-code') -Force
    ([bool]($mine.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) | Should Be $true
    $mine.Target | Should Be (Join-Path $target 'egpt')
    (Test-Path -LiteralPath (Join-Path (Join-Path $r 'my-code') 'src')) | Should Be $true
  }

  It 'is idempotent: three passes leave exactly the two junctions and throw nothing' {
    $r = $fakeProfile
    foreach ($i in 1..3) { Invoke-Expression $stmt | Out-Null }
    (@(Get-ChildItem -LiteralPath $r -Force).Count) | Should Be 2
    (Get-Item -LiteralPath (Join-Path $r 'src') -Force).Target | Should Be $target
    (Get-Item -LiteralPath (Join-Path $r 'my-code') -Force).Target | Should Be (Join-Path $target 'egpt')
  }

  It 'both are wiped as LINKS by the scrub that precedes them - the targets survive' {
    # The scrub deletes the profile children before the junctions are re-planted,
    # and Remove-Item must take each link itself rather than recursing into the
    # operator's src. That is the assertion that keeps the two safe together.
    $r = $fakeProfile
    Invoke-Expression $stmt | Out-Null
    Get-ChildItem -LiteralPath $r -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    (@(Get-ChildItem -LiteralPath $r -Force).Count) | Should Be 0
    (Test-Path -LiteralPath (Join-Path $target 'marker')) | Should Be $true
    (Test-Path -LiteralPath (Join-Path $target 'egpt\src')) | Should Be $true
  }

  It 'creates NOTHING - not even a dangling link - when the target is not there' {
    # A node with no ~\src. -EA 0 and no repair: the turn must not pay for a
    # missing convenience link.
    $r = New-LedgerTempDir
    Invoke-Expression (Get-SandboxProfileJunctionStatement -OperatorSrc (Join-Path $script:LedgerTempRoot 'no-such-src')) | Out-Null
    (@(Get-ChildItem -LiteralPath $r -Force).Count) | Should Be 0
  }

  It 'the whole scrub payload still fits the 1024-character CreateProcessWithLogonW budget' {
    # MSDN's lpCommandLine limit is real and ENFORCED (see Invoke-AsLeasedAccount's
    # BUDGET note) - a long command line fails with E_INVALIDARG rather than
    # truncating - and the whole payload is ONE argv element. The three scrub
    # lines measured 677 characters with one junction; this is the real statement
    # against the real profile and target lengths, with headroom left for them.
    $real = Get-SandboxProfileJunctionStatement -OperatorSrc (Join-Path $env:USERPROFILE 'src')
    ($real.Length -lt 320) | Should Be $true
    # Not one double quote in it: Format-Win32Arg escapes every " as \", costing
    # two characters of a budget that is already two thirds spent.
    ($real -match '"') | Should Be $false
  }

  It 'is the statement the LAUNCHER actually uses - not a second copy of it' {
    $src = Get-Content -LiteralPath $script:LauncherScript -Raw
    ($src -match '\(Get-SandboxProfileJunctionStatement -OperatorSrc \$srcRoot\)') | Should Be $true
    # ...and the launcher no longer spells a junction out for itself.
    ($src -match '-ItemType Junction') | Should Be $false
  }
}
