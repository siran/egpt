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
}

# ---------------------------------------------------------------------------
# THE src JUNCTION IN A POOL PROFILE (2026-09-20). The statement under test is
# NOT copied here - it is read out of sandbox-logon-launcher.ps1 and run
# verbatim, because a copy would pass while the shipped one was broken. That is
# not hypothetical: the first version of it read `-EA 0>$null` without the space,
# which PowerShell binds as part of a PARAMETER NAME, and no structural test
# would have caught it.
#
# It runs against a throwaway directory under $env:TEMP with $r bound to it, so
# nothing here touches a real pool profile. The junction target is substituted
# too - the launcher interpolates the operator's own ~\src there.
$script:LauncherScript = Join-Path $PSScriptRoot 'sandbox-logon-launcher.ps1'

function Get-JunctionStatement {
  $lines = @(Get-Content -LiteralPath $script:LauncherScript | Where-Object { $_ -match '-ItemType Junction' })
  # Loud rather than vacuous: a rename that stops this matching must FAIL the
  # test, not quietly leave it asserting nothing. A `throw` and not a `Should`:
  # Should writes to the PIPELINE, and inside a function that output joins the
  # return value - the statement would come back as @($true, '<statement>').
  if ($lines.Count -ne 1) {
    throw "expected exactly ONE '-ItemType Junction' line in $script:LauncherScript, found $($lines.Count) - the scrub's junction statement was renamed or removed"
  }
  $t = $lines[0].Trim()
  # The launcher holds the statement as a double-quoted PowerShell string whose
  # own $ signs are backtick-escaped. Strip the quotes and the escapes and what
  # is left is what the leased account really runs.
  return $t.Substring(1, $t.Length - 2).Replace('`', '')
}

Describe 'the pool profile src junction (as the launcher scrub really writes it)' {
  $fakeProfile = $null
  $target = $null
  $stmt = $null

  BeforeEach {
    $fakeProfile = New-LedgerTempDir
    $target = New-LedgerTempDir
    New-Item -ItemType Directory -Path (Join-Path $target 'marker') -Force | Out-Null
    $stmt = (Get-JunctionStatement).Replace("'`$srcRoot'", "'$target'")
  }

  It 'creates src as a junction pointing at the operator src, and says nothing on stdout' {
    $r = $fakeProfile
    Invoke-Expression $stmt | Should BeNullOrEmpty
    $link = Get-Item -LiteralPath (Join-Path $r 'src') -Force
    ([bool]($link.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) | Should Be $true
    $link.Target | Should Be $target
    (Test-Path -LiteralPath (Join-Path (Join-Path $r 'src') 'marker')) | Should Be $true
  }

  It 'is idempotent: three passes leave one junction and throw nothing' {
    $r = $fakeProfile
    foreach ($i in 1..3) { Invoke-Expression $stmt | Out-Null }
    (@(Get-ChildItem -LiteralPath $r -Force).Count) | Should Be 1
    (Get-Item -LiteralPath (Join-Path $r 'src') -Force).Target | Should Be $target
  }

  It 'is wiped as a LINK by the scrub that precedes it - the junction target survives' {
    # The scrub deletes the profile children before the junction is re-planted,
    # and Remove-Item must take the link itself rather than recursing into the
    # operator's src. That is the assertion that keeps the two safe together.
    $r = $fakeProfile
    Invoke-Expression $stmt | Out-Null
    Get-ChildItem -LiteralPath $r -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    (@(Get-ChildItem -LiteralPath $r -Force).Count) | Should Be 0
    (Test-Path -LiteralPath (Join-Path $target 'marker')) | Should Be $true
  }
}
