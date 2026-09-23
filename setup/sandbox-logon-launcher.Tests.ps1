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
$script:LaunchPattern = '-WorkingDirectory \$TargetFolder'

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

  It 'the gate checks the SAME path the launch is given - one variable, no second spelling' {
    # The third way this could have failed: grant one directory, enter another
    # (a trailing separator, a short name, a junction). Both gates and the
    # launch name $TargetFolder itself, so there is nothing to disagree about.
    (Get-LauncherStatement $script:GateDPattern) | Should Match '-Path \$TargetFolder'
    (Get-LauncherStatement $script:GateFPattern) | Should Match '-Path \$TargetFolder'
    (Get-LauncherStatement $script:LaunchPattern) | Should Match '-WorkingDirectory \$TargetFolder'
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

# Everything this suite made lives under one throwaway root, as in
# provision-service-account.Tests.ps1. Nothing outside it was created or
# modified, and no DACL anywhere was written.
Remove-Item -LiteralPath $script:TempRoot -Recurse -Force -ErrorAction SilentlyContinue
