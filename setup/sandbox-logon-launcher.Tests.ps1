# Unit coverage for the launcher's WORKING-DIRECTORY GATE - the read-back that
# stands between step (d)'s grant and step (f)'s CreateProcessWithLogonW.
#
# THE LIVE FAILURE THIS REPRODUCES, measured on kg 2026-09-23 07:44:57. A ccode
# turn died and the being's chat showed "Sending failed":
#   warm: evicted ken:ccode:whatsapp:<chat> (turn failed: claude exited 1
#     mid-turn: + FullyQualifiedErrorId : sandbox-logon-launcher:
#     CreateProcessWithLogonW('egpt-sbx-05') failed for launching,
#     Win32 error 267)
# Win32 267 is ERROR_DIRECTORY; for CreateProcessWithLogonW that is what
# lpCurrentDirectory answers when the directory is not reachable BY THE TARGET
# USER. icacls on that conversation folder read:
#   reve\egpt-sbx-12:(OI)(CI)(M)      reve\egpt-sbx-13:(OI)(CI)(M)
#   reve\egpt-sbx-07:(OI)(CI)(M)      NT AUTHORITY\SYSTEM:(I)(OI)(CI)(F)
#   BUILTIN\Administrators:(I)(OI)(CI)(F)   reve\an:(I)(OI)(CI)(F)
# The LEASED account - egpt-sbx-05 - has no ACE on the folder it was handed as
# its cwd. Step (d) had just reported a grant on it. The three that ARE there
# are other leases' leftovers, and none of them is the account running.
#
# THE DEFECT: Grant-SandboxPoolAce reads the DACL BEFORE its write (the
# check-first fast path) and branches on icacls's EXIT CODE afterwards - and
# this repo measured on 2026-09-20 that icacls can exit 0, print "Successfully
# processed 1 files" and write no ACE at all. Nothing between (d) and (f) ever
# read the DACL back, so a grant that silently did not land was
# indistinguishable from one that did, and the launch went ahead into a
# directory the account could not enter. Revoke-SandboxPathAces was given the
# opposite rule the same day, in capitals - "THE DACL DECIDES, NOT THE EXIT
# CODE", read before and after - and the grant half never got it.
#
# NOTHING IN HERE TOUCHES THE OS, and that is a hard constraint, not a style
# choice - the live pool accounts, conversation folders and ACLs on this node
# are load-bearing. In the three ways this code can reach the OS:
#   - icacls.exe is shadowed by a SPY THAT NEVER FORWARDS (the stricter shape
#     setup\provision-service-account.Tests.ps1 uses; sandbox-account.Tests.ps1's
#     spy falls through when unarmed because that suite grants for real on
#     throwaway directories - this one must not, so there is no fall-through).
#   - every DACL is either BUILT IN MEMORY and injected through
#     Test-SandboxPathReachable's -Acl parameter, or READ - never written - off a
#     throwaway directory under $env:TEMP.
#   - the launcher itself cannot be dot-sourced (loading it leases a pool account
#     and launches a process), so its two gate statements are EXTRACTED from its
#     source and run, the same trick the launcher-grant describe in
#     setup\sandbox-account.Tests.ps1 uses. A copy pasted in here would pass
#     while the shipped launcher still launched blind, which is the exact defect
#     this covers.
# No pool account, no conversation folder and no real ACL is named anywhere
# below: every SID that stands in for a pool account is SYNTHETIC.
#
# NOT part of vitest -- `npm test` never runs a .ps1. Run it by hand:
#   Invoke-Pester -Script setup\sandbox-logon-launcher.Tests.ps1
# (Pester 3.4.0, the version Windows ships, hence `Should Be` and not `Should -Be`.)

# Declared BEFORE the dot-source: PowerShell resolves an unqualified command
# inside a dot-sourced function by walking that function's LEXICAL parent scope
# chain, i.e. the scope it was dot-sourced into.
$script:IcaclsSpy = New-Object System.Collections.Generic.List[object]
function icacls.exe {
  [void]$script:IcaclsSpy.Add(@($args))
  $global:LASTEXITCODE = 0
  return 'icacls spy: not executed'
}

. (Join-Path $PSScriptRoot 'sandbox-account.ps1')

$script:LauncherScript = Join-Path $PSScriptRoot 'sandbox-logon-launcher.ps1'
$script:LauncherLines = @(Get-Content -LiteralPath $script:LauncherScript)
$script:TempRoot = Join-Path $env:TEMP ('egpt-launcher-gate-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:TempRoot -Force | Out-Null

# SYNTHETIC SIDs, never resolved against this machine and never used on a real
# object: one standing in for the LEASED account (egpt-sbx-05 in the failure
# above) and three for the accounts whose leftover ACEs were on the folder.
$script:LeasedSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-21-1111111111-2222222222-3333333333-1005')
$script:LeftoverSids = @(
  (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-21-1111111111-2222222222-3333333333-1007')),
  (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-21-1111111111-2222222222-3333333333-1012')),
  (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-21-1111111111-2222222222-3333333333-1013'))
)
$script:LeasedName = 'egpt-sbx-05'
# What the conversation folder really looked like. Built in memory; the two
# well-known SIDs stand in for the inherited SYSTEM and Administrators entries
# (a rule built in memory cannot be marked inherited, and nothing here depends
# on that flag).
function New-FailingFolderAcl {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  foreach ($sid in $script:LeftoverSids) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
          $sid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  foreach ($wellKnown in @('S-1-5-18', 'S-1-5-32-544')) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
          (New-Object System.Security.Principal.SecurityIdentifier($wellKnown)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  return $acl
}
function New-AclAllowing([System.Security.Principal.SecurityIdentifier]$Sid, [string]$Rights) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $Sid, $Rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  return $acl
}
function New-GateTempDir {
  $p = Join-Path $script:TempRoot ([guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $p -Force | Out-Null
  return $p
}
# A SID this throwaway directory's OWN DACL already allows ReadAndExecute,
# whatever it happens to be on this node (a group, usually). Read, never
# written - which is how the positive on-disk case is proved without a single
# ACL write.
function Get-SidAlreadyOn([string]$Path) {
  $need = [int][System.Security.AccessControl.FileSystemRights]::ReadAndExecute
  $hit = @((Get-Acl -LiteralPath $Path).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) |
      Where-Object {
        $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        ([int]$_.FileSystemRights -band $need) -eq $need
      } | ForEach-Object { $_.IdentityReference })
  return $hit[0]
}
# Exactly ONE launcher line may match, or the extraction is lying about what
# the shipped script does. Same contract as sandbox-account.Tests.ps1's copy.
function Get-LauncherStatement([string]$Pattern) {
  $hits = @($script:LauncherLines | Where-Object { $_ -match $Pattern })
  if ($hits.Count -ne 1) { throw "expected exactly ONE launcher line matching /$Pattern/, found $($hits.Count)" }
  return $hits[0]
}
function Get-LauncherLineIndex([string]$Pattern) {
  $hits = @(0..($script:LauncherLines.Count - 1) | Where-Object { $script:LauncherLines[$_] -match $Pattern })
  if ($hits.Count -ne 1) { throw "expected exactly ONE launcher line matching /$Pattern/, found $($hits.Count)" }
  return $hits[0]
}
$script:GrantPattern = 'Grant-SandboxPoolAce -Path \$TargetFolder'
$script:GateDPattern = "Assert-SandboxPathReachable -Path \`$TargetFolder .*-Stage 'step \(d\)"
$script:GateFPattern = "Assert-SandboxPathReachable -Path \`$TargetFolder .*-Stage 'step \(f\)"
$script:LaunchPattern = '-WorkingDirectory \$sandboxCwd'
$script:ScrubCallPattern = '\$sandboxCwd = Clear-SandboxProfileContents'
$script:CwdGuardPattern = 'if \(-not \$sandboxCwd\)'

Describe 'REPRODUCE: the 2026-09-23 turn that launched into a cwd its leased account could not enter' {
  AfterEach { $script:IcaclsSpy.Clear() }

  It 'the measured DACL does NOT make the leased account reachable - the three ACEs on it belong to other leases' {
    # This is the whole failure in one assertion. Before the gate existed
    # nothing asked this question, so the answer - no - never stopped anything.
    $verdict = Test-SandboxPathReachable -Path 'C:\conversations\whatsapp\a-chat' -Sid $script:LeasedSid -Acl (New-FailingFolderAcl)

    $verdict.Reachable | Should Be $false
    # And it says WHO is on it instead, which is the diagnostic the live log
    # never had: on the real folder this printed the three other pool accounts.
    foreach ($leftover in $script:LeftoverSids) { $verdict.Reason | Should Match ([regex]::Escape($leftover.Value)) }
  }

  It 'the GATE REFUSES instead of letting the launch happen, and says the account, the folder and what was expected' {
    $folder = New-GateTempDir
    $threw = $null
    try {
      Assert-SandboxPathReachable -Path $folder -Sid $script:LeasedSid -AccountName $script:LeasedName -Stage 'step (f), the test'
    } catch { $threw = $_.Exception.Message }

    ($null -ne $threw) | Should Be $true
    $threw | Should Match ([regex]::Escape($script:LeasedName))
    $threw | Should Match ([regex]::Escape($folder))
    $threw | Should Match 'ReadAndExecute'
    # The error a turn now dies with names the one it used to die with, so an
    # operator reading either log lands in the same place.
    $threw | Should Match '267'
  }

  It 'REFUSING writes nothing - the fix never widens a grant to make the check pass' {
    # THE LOAD-BEARING RULE (setup\SANDBOX.md, and the launcher header): never
    # Everyone, never a parent directory, never a broader mask. A gate that
    # "repaired" the DACL would be a widening with extra steps.
    $folder = New-GateTempDir
    try { Assert-SandboxPathReachable -Path $folder -Sid $script:LeasedSid -AccountName $script:LeasedName -Stage 'step (f), the test' } catch { }

    $script:IcaclsSpy.Count | Should Be 0
  }

  It 'the SAME folder with the leased account really on it passes, and costs no write either' {
    $acl = New-FailingFolderAcl
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
          $script:LeasedSid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))

    $verdict = Test-SandboxPathReachable -Path 'C:\conversations\whatsapp\a-chat' -Sid $script:LeasedSid -Acl $acl

    $verdict.Reachable | Should Be $true
    $script:IcaclsSpy.Count | Should Be 0
  }
}

Describe 'Test-SandboxPathReachable (the read-back itself, against DACLs built in memory)' {
  It 'the Modify ACE step (d) writes is enough' {
    (Test-SandboxPathReachable -Path 'C:\x' -Sid $script:LeasedSid -Acl (New-AclAllowing $script:LeasedSid 'Modify')).Reachable | Should Be $true
  }

  It 'ReadAndExecute alone is enough - entering a cwd is not the same promise as writing in it' {
    # Deliberately NOT Modify: 267 is about whether the directory can be
    # ENTERED. Whether the exact (OI)(CI)(M) landed stays Grant-SandboxPoolAce's
    # own check, and the two questions are kept apart on purpose.
    (Test-SandboxPathReachable -Path 'C:\x' -Sid $script:LeasedSid -Acl (New-AclAllowing $script:LeasedSid 'ReadAndExecute')).Reachable | Should Be $true
  }

  It 'the traverse-only ancestor mask is NOT enough - it withholds read-data on purpose' {
    # (X,RA,RC) is what the provisioner puts on the ancestor chain so a being
    # can walk THROUGH a directory without listing it. A conversation folder
    # carrying only that is not a working directory, and must not read as one.
    $acl = New-AclAllowing $script:LeasedSid 'ExecuteFile, ReadAttributes, ReadPermissions'
    (Test-SandboxPathReachable -Path 'C:\x' -Sid $script:LeasedSid -Acl $acl).Reachable | Should Be $false
  }

  It 'a Deny for this SID beats an Allow for this SID' {
    $acl = New-AclAllowing $script:LeasedSid 'Modify'
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
          $script:LeasedSid, 'ReadData', 'ContainerInherit,ObjectInherit', 'None', 'Deny')))

    $verdict = Test-SandboxPathReachable -Path 'C:\x' -Sid $script:LeasedSid -Acl $acl

    $verdict.Reachable | Should Be $false
    $verdict.Reason | Should Match 'Deny'
  }

  It "another account's ACE is not this one's - which is exactly what the live folder had" {
    $acl = New-AclAllowing $script:LeftoverSids[0] 'Modify'
    (Test-SandboxPathReachable -Path 'C:\x' -Sid $script:LeasedSid -Acl $acl).Reachable | Should Be $false
  }

  It 'an empty DACL is not reachable, and says so rather than saying nothing' {
    $verdict = Test-SandboxPathReachable -Path 'C:\x' -Sid $script:LeasedSid -Acl (New-Object System.Security.AccessControl.DirectorySecurity)
    $verdict.Reachable | Should Be $false
    $verdict.Reason | Should Match 'no Allow ACE at all'
  }

  It 'FAILS CLOSED on a path that is not there - the opposite of Test-SandboxPoolReadCovered, deliberately' {
    # That one answers $false on an unreadable DACL because the safe direction
    # for a GRANT is to write it. The safe direction for a LAUNCH is to refuse.
    $verdict = Test-SandboxPathReachable -Path (Join-Path $script:TempRoot 'never-existed') -Sid $script:LeasedSid
    $verdict.Reachable | Should Be $false
    $verdict.Reason | Should Match 'does not exist'
  }

  It 'reads a REAL DACL off disk and finds a SID that is genuinely on it' {
    # The on-disk half, with no ACL write anywhere: the throwaway directory's
    # own inherited DACL is read, a SID it already allows is taken out of it,
    # and the function must agree. Inherited counts - the kernel does not care
    # where an Allow came from.
    $d = New-GateTempDir
    $present = Get-SidAlreadyOn $d
    ($null -ne $present) | Should Be $true

    (Test-SandboxPathReachable -Path $d -Sid $present).Reachable | Should Be $true
    (Test-SandboxPathReachable -Path $d -Sid $script:LeasedSid).Reachable | Should Be $false
  }

  It 'returns a RECORD and logs nothing, so a caller can act on it and a test can assert it' {
    $verdict = Test-SandboxPathReachable -Path 'C:\x' -Sid $script:LeasedSid -Principal 'S-1-x (egpt-sbx-05)' -Acl (New-FailingFolderAcl)
    $verdict.Path | Should Be 'C:\x'
    $verdict.Sid | Should Be $script:LeasedSid.Value
    $verdict.Principal | Should Be 'S-1-x (egpt-sbx-05)'
    ($verdict.Reachable -is [bool]) | Should Be $true
    [string]::IsNullOrWhiteSpace($verdict.Reason) | Should Be $false
  }
}

Describe 'the launcher wiring (the statements the launcher really runs)' {
  AfterEach { $script:IcaclsSpy.Clear() }

  It 'step (d) READS THE GRANT BACK: the gate is there, and it is after the grant' {
    # On the code that produced the 2026-09-23 failure there was no such line
    # at all, and Get-LauncherStatement throws rather than matching nothing.
    Get-LauncherStatement $script:GateDPattern | Should Not BeNullOrEmpty
    (Get-LauncherLineIndex $script:GateDPattern) | Should BeGreaterThan (Get-LauncherLineIndex $script:GrantPattern)
  }

  It "the extracted step (d) gate REFUSES on a folder the leased SID is not on - the launch is never reached" {
    # The shipped line, run verbatim, against a throwaway directory and a
    # synthetic SID: this is the whole live failure with nothing faked but the
    # names. Before the fix this statement does not exist.
    $stmt = Get-LauncherStatement $script:GateDPattern
    $TargetFolder = New-GateTempDir
    $leasedSid = $script:LeasedSid
    $leasedName = $script:LeasedName

    { Invoke-Expression $stmt } | Should Throw
    $script:IcaclsSpy.Count | Should Be 0
  }

  It 'the extracted step (d) gate PASSES for a SID the folder really allows' {
    $stmt = Get-LauncherStatement $script:GateDPattern
    $TargetFolder = New-GateTempDir
    $leasedSid = Get-SidAlreadyOn $TargetFolder
    $leasedName = $script:LeasedName

    { Invoke-Expression $stmt } | Should Not Throw
  }

  It 'step (f) asks AGAIN, immediately before the one launch whose cwd is the conversation folder' {
    # Two reads, not one: every -SharePath ACE, the private desktop and a whole
    # CreateProcessWithLogonW round trip for the profile scrub happen in
    # between, and an ACE can be purged by SID in that window - the lease lock
    # keeps two turns off one ACCOUNT, not off one FOLDER.
    $gateD = Get-LauncherLineIndex $script:GateDPattern
    $gateF = Get-LauncherLineIndex $script:GateFPattern
    $launch = Get-LauncherLineIndex $script:LaunchPattern

    $gateF | Should BeGreaterThan $gateD
    $launch | Should BeGreaterThan $gateF
  }

  It 'the extracted step (f) gate refuses the same way - an ACE that went away between (d) and (f) stops the turn' {
    $stmt = Get-LauncherStatement $script:GateFPattern
    $TargetFolder = New-GateTempDir
    $leasedSid = $script:LeasedSid
    $leasedName = $script:LeasedName

    { Invoke-Expression $stmt } | Should Throw
  }

  It 'BOTH gates ask about the durable Room, which is where every ACE actually lives' {
    # Since 2026-09-23 the launch cwd is the `egpt` MOUNT, not the Room - but an
    # ACE on a junction would be an ACE on nothing, so the grant, the ledger, the
    # revoke and both gates still name $TargetFolder. A gate that followed the
    # cwd would be verifying a name instead of the fact behind it.
    (Get-LauncherStatement $script:GateDPattern) | Should Match '-Path \$TargetFolder'
    (Get-LauncherStatement $script:GateFPattern) | Should Match '-Path \$TargetFolder'
    (Get-LauncherStatement $script:GrantPattern) | Should Match '-Path \$TargetFolder'
  }

  It 'the scrub pass is NOT gated, because its cwd is %SystemRoot% and every account can enter that' {
    (Get-LauncherStatement '-WorkingDirectory \$env:SystemRoot') | Should Match "-Label 'profile scrub'"
  }

  It 'NOTHING IS WIDENED: the launcher still grants only TargetFolder and the declared share paths' {
    # The rule the fix must not break. If the gate had been "made to pass" by
    # granting a parent directory or Everyone, it would show up here.
    $src = Get-Content -LiteralPath $script:LauncherScript -Raw
    (@([regex]::Matches($src, '(?m)^\s*Grant-SandboxPoolAce ')).Count) | Should Be 2
    ($src -match "(?m)^\s*Grant-SandboxPoolAce .*'Everyone'") | Should Be $false
  }
}

# ---------------------------------------------------------------------------
# THE -SetEnv ENVIRONMENT BLOCK (2026-09-23). Second live failure, different
# from the 267 above and NOT a regression of it:
#   2026-09-23 12:35:44  turn ken/o1TO4f1is79x0uJ3eYEv: claude exited 1 mid-turn
#     + FullyQualifiedErrorId : sandbox-logon-launcher:
#       CreateEnvironmentBlock for 'egpt-sbx-08' failed, Win32 error 5
# A DIFFERENT pool account each time - egpt-sbx-12, then -05, then -08 - so not
# one broken account. 5 is ERROR_ACCESS_DENIED, raised inside userenv.
#
# THE CAUSE, measured on reve 2026-09-23, unelevated and read-only:
#   HKU\S-1-5-21-...-1013 (= reve\egpt-sbx-09, its hive loaded at that moment)
#     -> "Requested registry access is not allowed"
#   the operator's OWN hive, same call  -> opened, 6 values
#   this session's privileges: SeShutdown, SeChangeNotify, SeUndock,
#     SeIncreaseWorkingSet, SeTimeZone - no SeImpersonate, no SeBackup/SeRestore
#   IsInRole(Administrator) -> False  (unelevated: Administrators is deny-only)
# CreateEnvironmentBlock(hToken) has to read HKEY_USERS\<that SID> once the
# account's hive is LOADED. This caller may not, and may not impersonate or
# load its way in either. Hive not loaded -> userenv falls back to the DEFAULT
# profile and the call succeeds (which is the C:\Users\Default measurement the
# launcher already carried); hive loaded -> ACCESS_DENIED and the turn dies.
# The scrub pass is a LOGON_WITH_PROFILE logon as that same account moments
# earlier, and its unload is not instant - hence random, hence any account.
#
# THE FIX under test: the second logon is gone and the block is rendered with
# hToken = NULL, which reads no user hive at all. Every per-user name is
# supplied by the rebase that already existed.
#
# HOW THIS IS TESTED WITHOUT A LOGON. Two seams, both honest:
#  - the P/Invoke seam is FAKED by a [SandboxLogon] type defined here whose
#    CreateEnvironmentBlock encodes the measured rule: a NULL token succeeds, a
#    USER token is refused. The launcher's own statement is then EXTRACTED from
#    its source and run against it, so a copy pasted in here could not pass
#    while the shipped script still asked for a user token.
#  - the facts the fix RESTS on are measured against the REAL userenv in this
#    process: CreateEnvironmentBlock(NULL) needs no logon, no account and no
#    privilege, and writes nothing, so calling it touches nothing.
if (-not ([System.Management.Automation.PSTypeName]'SandboxLogon').Type) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
// A STAND-IN for the launcher's inline P/Invoke class, with the same three
// signatures the environment-block path uses. It never calls Windows.
public static class SandboxLogon {
  public static List<IntPtr> EnvBlockTokensSeen = new List<IntPtr>();
  public static int LogonUserCalls = 0;
  // THE MEASURED RULE, encoded: rendering a block from a USER token means
  // reading that user's hive, which the unelevated launcher may not do.
  public static bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit) {
    EnvBlockTokensSeen.Add(hToken);
    if (hToken != IntPtr.Zero) { lpEnvironment = IntPtr.Zero; return false; }
    lpEnvironment = Marshal.StringToHGlobalUni("SystemRoot=C:\\WINDOWS\0USERPROFILE=C:\\Users\\Default\0\0");
    return true;
  }
  public static bool DestroyEnvironmentBlock(IntPtr p) { if (p != IntPtr.Zero) Marshal.FreeHGlobal(p); return true; }
  public static bool LogonUser(string u, string d, string p, int t, int pr, out IntPtr tok) {
    LogonUserCalls++; tok = new IntPtr(1234); return true;
  }
}
'@
}
# The REAL userenv, under its own name so the fake above can keep the
# launcher's. Used only for the two measurements the fix rests on.
if (-not ([System.Management.Automation.PSTypeName]'SandboxEnvProbe').Type) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SandboxEnvProbe {
  [DllImport("userenv.dll", SetLastError = true)]
  public static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);
  [DllImport("userenv.dll", SetLastError = true)]
  public static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);
}
'@
}
# Walk a Win32 environment block: NUL-terminated UTF-16 NAME=VALUE runs, one
# extra NUL closing the block. The same walk the launcher does.
function Read-EnvBlock([IntPtr]$Block) {
  $o = 0
  $out = New-Object System.Collections.Generic.List[string]
  while ($true) {
    $s = [Runtime.InteropServices.Marshal]::PtrToStringUni([IntPtr]::Add($Block, $o))
    if ([string]::IsNullOrEmpty($s)) { break }
    [void]$out.Add($s)
    $o += ($s.Length + 1) * 2
  }
  return $out
}
# The REAL system-variables block, read once. No token, no logon, no write.
function Get-RealSystemEnvBlock {
  $b = [IntPtr]::Zero
  if (-not [SandboxEnvProbe]::CreateEnvironmentBlock([ref]$b, [IntPtr]::Zero, $false)) { return $null }
  try { return @(Read-EnvBlock $b) } finally { [SandboxEnvProbe]::DestroyEnvironmentBlock($b) | Out-Null }
}
# A MULTI-LINE extraction, because these statements are not one line. Starts at
# the single line matching $Pattern and takes following lines until the
# accumulated text PARSES as a complete statement - so it is the shipped code
# and never a guess about where it ends.
function Get-LauncherStatementBlock([string]$Pattern) {
  $start = @(0..($script:LauncherLines.Count - 1) | Where-Object { $script:LauncherLines[$_] -match $Pattern })
  if ($start.Count -ne 1) { throw "expected exactly ONE launcher line matching /$Pattern/, found $($start.Count)" }
  $i = $start[0]
  for ($n = 1; $n -le 60; $n++) {
    if (($i + $n - 1) -ge $script:LauncherLines.Count) { break }
    $text = ($script:LauncherLines[$i..($i + $n - 1)]) -join "`r`n"
    $errs = $null
    [void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$errs)
    if (@($errs).Count -eq 0) { return $text }
  }
  throw "could not complete a statement starting at launcher line $($i + 1) for /$Pattern/"
}
$script:EnvBlockCallPattern = 'CreateEnvironmentBlock\(\[ref\]\$block'
$script:PerUserTablePattern = '\$perUser = \[ordered\]@\{'
# The names the launcher's rebase overwrites, taken by RUNNING its own table
# with a stand-in profile rather than by listing them here a second time.
function Get-LauncherRebaseKeys {
  $AccountName = 'egpt-sbx-08'
  $profilePath = 'C:\Users\egpt-sbx-08'
  $localAppData = Join-Path $profilePath 'AppData\Local'
  $userTemp = Join-Path $localAppData 'Temp'
  $homeDrive = [System.IO.Path]::GetPathRoot($profilePath).TrimEnd('\')
  Invoke-Expression (Get-LauncherStatementBlock $script:PerUserTablePattern)
  return @($perUser.Keys)
}

Describe 'REPRODUCE: CreateEnvironmentBlock ACCESS_DENIED on the -SetEnv path' {
  BeforeEach {
    [SandboxLogon]::EnvBlockTokensSeen.Clear()
    [SandboxLogon]::LogonUserCalls = 0
  }

  It 'a USER token is refused by the faked seam - that refusal IS the live failure' {
    # The model the rest of this describe rests on, asserted directly so it
    # cannot quietly stop meaning anything.
    $p = [IntPtr]::Zero
    [SandboxLogon]::CreateEnvironmentBlock([ref]$p, (New-Object IntPtr 1234), $false) | Should Be $false
  }

  It 'the SHIPPED statement asks for the block with NO user token, and therefore succeeds' {
    # Pre-fix this same extraction hands the fake the token from LogonUser and
    # throws; post-fix it hands it IntPtr::Zero and returns.
    $stmt = Get-LauncherStatementBlock $script:EnvBlockCallPattern
    $block = [IntPtr]::Zero
    $AccountName = 'egpt-sbx-08'
    # A token in scope, non-zero, as if LogonUser had SUCCEEDED - which is
    # exactly what happened live: the logon worked and the RENDER was denied.
    # So a statement that still reaches for $token fails here, and one that
    # asks for IntPtr::Zero does not.
    $token = New-Object IntPtr 1234

    { Invoke-Expression $stmt } | Should Not Throw

    @([SandboxLogon]::EnvBlockTokensSeen).Count | Should Be 1
    [SandboxLogon]::EnvBlockTokensSeen[0] | Should Be ([IntPtr]::Zero)
  }

  It 'no second logon is performed for the environment block' {
    $stmt = Get-LauncherStatementBlock $script:EnvBlockCallPattern
    $block = [IntPtr]::Zero
    $AccountName = 'egpt-sbx-08'
    $token = New-Object IntPtr 1234
    Invoke-Expression $stmt

    [SandboxLogon]::LogonUserCalls | Should Be 0
  }

  It 'and there is no LogonUser left in the launcher to perform one' {
    # Prose may still explain why it went; a CALL or an IMPORT must not exist.
    $src = Get-Content -LiteralPath $script:LauncherScript -Raw
    ($src -match '\[SandboxLogon\]::LogonUser\(') | Should Be $false
    ($src -match 'extern bool LogonUser') | Should Be $false
    ($src -match 'LOGON32_LOGON_INTERACTIVE = ') | Should Be $false
  }

  It 'the block function is no longer handed the account password' {
    $src = Get-Content -LiteralPath $script:LauncherScript -Raw
    ($src -match 'New-SandboxEnvironmentBlock -AccountName \$AccountName -SetEnv \$SetEnv') | Should Be $true
    ($src -match 'New-SandboxEnvironmentBlock -AccountName \$AccountName -Password') | Should Be $false
    # ...and its own param block does not take one either.
    $fnStart = @(0..($script:LauncherLines.Count - 1) | Where-Object { $script:LauncherLines[$_] -match '^function New-SandboxEnvironmentBlock \{' })[0]
    $close = @(($fnStart + 1)..($script:LauncherLines.Count - 1) | Where-Object { $script:LauncherLines[$_] -match '^\s*\)\s*$' })[0]
    (($script:LauncherLines[$fnStart..$close] -join "`n") -match '\$Password') | Should Be $false
  }

  It 'THE TRAP still holds: bInherit is $false, so the operator environment is never folded in' {
    # The single most load-bearing argument in this feature, and untouched by
    # this change: $true here would fold the OPERATOR's environment into the
    # block and point a pool account at C:\Users\an. A lock, not a reproduce -
    # it held before and must go on holding.
    (Get-LauncherStatementBlock $script:EnvBlockCallPattern) | Should Match ',\s*\$false\)'
  }
}

Describe 'the system-variables block is enough (measured against the REAL userenv, nothing touched)' {
  It 'CreateEnvironmentBlock(NULL) succeeds for an unelevated caller with no logon at all' {
    # The fact the whole fix rests on, so it is measured rather than faked.
    $entries = Get-RealSystemEnvBlock
    ($null -ne $entries) | Should Be $true
    ($entries.Count -gt 0) | Should Be $true
  }

  It 'it carries the machine half a child actually needs' {
    $names = @(Get-RealSystemEnvBlock | ForEach-Object { $_.Substring(0, $_.IndexOf('=')) })
    foreach ($n in @('Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'windir')) {
      ($names -contains $n) | Should Be $true
    }
  }

  It 'EVERY name in it that carries a USER is one the rebase overwrites - nothing user-shaped survives' {
    # THE REAL RISK OF THIS FIX, locked: the NULL block is not user-free, it is
    # SYSTEM/Default-shaped (USERPROFILE=C:\Users\Default, USERNAME=SYSTEM,
    # TEMP=C:\WINDOWS\TEMP). If a node's block carried some other such name that
    # the rebase does not set, the child would run pointed at it. This fails
    # then, by name.
    $keys = @(Get-LauncherRebaseKeys)
    $leaky = @(Get-RealSystemEnvBlock | Where-Object {
        $v = $_.Substring($_.IndexOf('=') + 1)
        $v -match '(?i)\\Users\\Default' -or $v -eq 'SYSTEM' -or $v -match '(?i)^%?SystemRoot%?\\TEMP$' -or $v -match '(?i)^C:\\WINDOWS\\TEMP$'
      } | ForEach-Object { $_.Substring(0, $_.IndexOf('=')) })
    # There IS at least one on any normal node - if there were none, this test
    # would be passing vacuously and proving nothing.
    ($leaky.Count -gt 0) | Should Be $true
    foreach ($n in $leaky) { ($keys -contains $n) | Should Be $true }
  }
}

Describe 'the rebase is the sole authority for every per-user name (the launcher table, extracted and run)' {
  $table = $null

  BeforeEach {
    # The shipped table, run with a stand-in profile. The three locals it closes
    # over are set exactly as the launcher sets them, three lines above it.
    $AccountName = 'egpt-sbx-08'
    $profilePath = 'C:\Users\egpt-sbx-08'
    $localAppData = Join-Path $profilePath 'AppData\Local'
    $userTemp = Join-Path $localAppData 'Temp'
    $homeDrive = [System.IO.Path]::GetPathRoot($profilePath).TrimEnd('\')
    Invoke-Expression (Get-LauncherStatementBlock $script:PerUserTablePattern)
    $table = $perUser
  }

  It 'covers every per-user name the removed user token used to contribute' {
    # MEASURED 2026-09-23: a real user token's block carried exactly these
    # beyond the NULL block, besides that user's own HKCU\Environment values.
    foreach ($n in @('USERPROFILE', 'USERNAME', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA',
        'HOMEDRIVE', 'HOMEPATH', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'LOGONSERVER')) {
      ($table.Contains($n)) | Should Be $true
    }
  }

  It 'points them at the LEASED ACCOUNT - never C:\Users\Default, never the operator' {
    $table['USERPROFILE'] | Should Be 'C:\Users\egpt-sbx-08'
    $table['USERNAME'] | Should Be 'egpt-sbx-08'
    $table['TEMP'] | Should Be 'C:\Users\egpt-sbx-08\AppData\Local\Temp'
    $table['APPDATA'] | Should Be 'C:\Users\egpt-sbx-08\AppData\Roaming'
    foreach ($v in $table.Values) { ([string]$v -match '(?i)\\Users\\Default') | Should Be $false }
    foreach ($v in $table.Values) { ([string]$v -match '(?i)\\Users\\an(\\|$)') | Should Be $false }
  }

  It 'derives the two logon-session names from this machine, as a LOCAL account requires' {
    $table['USERDOMAIN'] | Should Be ([System.Environment]::MachineName)
    $table['USERDOMAIN_ROAMINGPROFILE'] | Should Be ([System.Environment]::MachineName)
    $table['LOGONSERVER'] | Should Be ("\\" + [System.Environment]::MachineName)
  }

  It 'SESSIONNAME is the ONE name that is gone, and it is NOT invented' {
    # The whole difference the fix makes to the child's environment. It is not
    # derivable from here, so it is left out rather than guessed - and said out
    # loud in the source rather than discovered later.
    ($table.Contains('SESSIONNAME')) | Should Be $false
    $src = Get-Content -LiteralPath $script:LauncherScript -Raw
    ($src -match 'SESSIONNAME') | Should Be $true
  }

  It 'the -SetEnv overlay still runs AFTER the rebase, so an explicit caller outranks it' {
    $rebase = (Get-LauncherLineIndex 'foreach \(\$n in \$perUser\.Keys\)')
    $overlay = (Get-LauncherLineIndex 'foreach \(\$pair in \$SetEnv\)')
    $overlay | Should BeGreaterThan $rebase
  }
}

# ---------------------------------------------------------------------------
# THE `egpt` MOUNT AS THE BEING'S CWD (operator ruling 2026-09-23).
#
# WHAT IT IS FOR. A sandboxed being's cwd used to be the durable Room,
# C:\Users\an\.egpt\conversations\whatsapp\<slug>, and it quoted that path into
# group chats all day - verbose tool lines read
#   Bash(cd "C:/Users/an/.egpt/conversations/whatsapp/Reencuentro CR...")
# disclosing the OPERATOR's username and profile layout and, because a slug is
# usually a PERSON'S NAME, a third party's private conversation name, to
# everyone else in the room. The cwd is now C:\Users\egpt-sbx-NN\egpt, a
# junction onto that same Room: a disposable account number and nothing else.
#
# TWO NAMES THAT MUST NOT COLLAPSE, which is what these lock:
#   $TargetFolder - the Room. EVERY ACL names it: the grant, the ledger, the
#                   revoke, and both reachability gates. A junction is a name;
#                   the target's DACL is the fact the kernel reads.
#   $sandboxCwd   - the mount. The cwd, and nothing else.
# The mount itself - that it carries the Room's ROOT-LEVEL FILES, that it is
# re-pointed per lease, and that deleting it never recurses into the Room - is
# locked where the statement lives, in setup\sandbox-account.Tests.ps1.
Describe 'the working directory is the mount, never the Room (the launcher wiring)' {
  It 'the launch cwd is $sandboxCwd - the Room path is not what the being is given' {
    (Get-LauncherStatement $script:LaunchPattern) | Should Match '-WorkingDirectory \$sandboxCwd'
    $src = Get-Content -LiteralPath $script:LauncherScript -Raw
    # Exactly one -WorkingDirectory names the Room... none. The scrub uses
    # %SystemRoot%, the launch uses the mount.
    ($src -match '-WorkingDirectory \$TargetFolder') | Should Be $false
  }

  It 'the cwd comes from the SCRUB, because only the scrub can plant it' {
    # The scrub runs AS the leased account, the one principal allowed to write
    # inside that profile. Deriving the cwd anywhere else would be a second
    # source of truth for one path, and the two would drift.
    (Get-LauncherStatementBlock $script:ScrubCallPattern) | Should Match '-RoomTarget \$TargetFolder'
  }

  It 'PLANTED AFTER THE SCRUB AND BEFORE THE LAUNCH - the ordering the design requires' {
    $grant = Get-LauncherLineIndex $script:GrantPattern
    $scrub = Get-LauncherLineIndex $script:ScrubCallPattern
    $guard = Get-LauncherLineIndex $script:CwdGuardPattern
    $gateF = Get-LauncherLineIndex $script:GateFPattern
    $launch = Get-LauncherLineIndex $script:LaunchPattern

    $scrub | Should BeGreaterThan $grant
    $guard | Should BeGreaterThan $scrub
    $gateF | Should BeGreaterThan $guard
    $launch | Should BeGreaterThan $gateF
  }

  It 'a scrub that planted NOTHING refuses the turn - it never falls back to the Room path' {
    # The one downgrade that would defeat the whole feature: running in the
    # conversation folder anyway. $null in, refusal out.
    $stmt = Get-LauncherStatementBlock $script:CwdGuardPattern
    $sandboxCwd = $null
    $leasedName = 'egpt-sbx-08'
    $TargetFolder = 'C:\Users\an\.egpt\conversations\whatsapp\a-person-name-1234'

    $threw = $null
    try { Invoke-Expression $stmt } catch { $threw = $_.Exception.Message }

    ($null -ne $threw) | Should Be $true
    $threw | Should Match 'REFUSING'
    $threw | Should Match ([regex]::Escape($leasedName))
    # It says what is missing and how to fix it, and says why the obvious
    # fallback is not taken.
    $threw | Should Match 'egpt'
    $threw | Should Match 'profile'
  }

  It 'a scrub that DID plant one lets the turn through' {
    $stmt = Get-LauncherStatementBlock $script:CwdGuardPattern
    $sandboxCwd = 'C:\Users\egpt-sbx-08\egpt'
    $leasedName = 'egpt-sbx-08'
    $TargetFolder = 'C:\Users\an\.egpt\conversations\whatsapp\a-person-name-1234'

    { Invoke-Expression $stmt } | Should Not Throw
  }

  It 'THE SCRUB IS STILL THE ONLY PLANTER - the launcher grew no junction code of its own' {
    $src = Get-Content -LiteralPath $script:LauncherScript -Raw
    ($src -match '-ItemType Junction') | Should Be $false
    # Prose may name the generator; exactly one line may CALL it.
    (@([regex]::Matches($src, '\(Get-SandboxProfileJunctionStatement -OperatorSrc')).Count) | Should Be 1
    (@([regex]::Matches($src, '(?m)^\s*\$sandboxCwd = ')).Count) | Should Be 1
  }
}

# Everything this suite made lives under one throwaway root, as in
# provision-service-account.Tests.ps1. Nothing outside it was created or
# modified, and no DACL anywhere was written.
Remove-Item -LiteralPath $script:TempRoot -Recurse -Force -ErrorAction SilentlyContinue
