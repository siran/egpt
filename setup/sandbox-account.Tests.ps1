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
