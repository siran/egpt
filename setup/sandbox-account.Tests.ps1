# THROWAWAY unit coverage (operator 2026-08-30) for the DPAPI LocalMachine-
# scope credential rewrite in sandbox-account.ps1. Covers what CAN be tested
# in-process: the byte-level protect/unprotect round trip, the on-disk
# wrapper format, and Get-SandboxCredential's self-heal branches with
# Get-/New-/Set-LocalUser shadowed (never touches real Windows accounts or
# C:\ProgramData\egpt). Protect-then-Unprotect in the SAME process trivially
# succeeds under EITHER DPAPI scope, so none of this proves the cross-session
# fix -- only a real cross-logon-session run (SSH/Session-0) proves that.

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
