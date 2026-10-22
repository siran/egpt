# Unit coverage for the "one profile, two runtimes" helpers in setup\beeper-desktop.ps1, and for
# Close-BeeperAppWindows. Fakes only: TestDrive files, process objects built here, and a hidden
# window in a throwaway child process. No service, registry key, task or Beeper is touched.
#   Invoke-Pester -Script setup\beeper-desktop.Tests.ps1      (Pester 3.4: `Should Be`)
# ASCII ONLY.

. (Join-Path $PSScriptRoot 'beeper-desktop.ps1')

# A throwaway powershell with NO console: a console of its own would open a tab wherever Windows
# Terminal is the default terminal. Its WinForms window still exists.
function Start-NoConsole([string] $Script) {
  $si = New-Object Diagnostics.ProcessStartInfo 'powershell.exe', ('-NoProfile -ExecutionPolicy Bypass -File "' + $Script + '"')
  $si.UseShellExecute = $false
  $si.CreateNoWindow = $true
  return [Diagnostics.Process]::Start($si)
}

$script:Flags = '--disable-gpu --disable-gpu-compositing --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows'

Describe 'Get-BeeperUserDataDir' {
  It 'reads a quoted, an unquoted and a forward-slash path' {
    Get-BeeperUserDataDir '--user-data-dir="C:\Users\an\AppData\Roaming\BeeperTexts" --disable-gpu' | Should Be 'C:\Users\an\AppData\Roaming\BeeperTexts'
    Get-BeeperUserDataDir '--user-data-dir=C:/Users/an/.egpt/state/rodz-beeper/userdata --disable-gpu' | Should Be 'C:/Users/an/.egpt/state/rodz-beeper/userdata'
  }
  It 'is null for the default profile' {
    Get-BeeperUserDataDir $script:Flags | Should BeNullOrEmpty
  }
}

Describe 'Test-BeeperSharedProfile' {
  It 'matches the desktop user default profile, whatever the spelling' {
    Test-BeeperSharedProfile '--user-data-dir="C:\Users\an\AppData\Roaming\BeeperTexts" --disable-gpu' 'C:\Users\an\AppData\Roaming' | Should Be $true
    Test-BeeperSharedProfile '--user-data-dir=c:/users/an/appdata/roaming/beepertexts/ --disable-gpu' 'C:\Users\an\AppData\Roaming' | Should Be $true
  }
  It 'is false for another profile and for no --user-data-dir (the system profile)' {
    Test-BeeperSharedProfile '--user-data-dir=C:/Users/an/.egpt/state/rodz-beeper/userdata' 'C:\Users\an\AppData\Roaming' | Should Be $false
    Test-BeeperSharedProfile $script:Flags 'C:\Users\an\AppData\Roaming' | Should Be $false
  }
  # dolly: the service shares its own --user-data-dir; the conversion's Start/Pre hook says so.
  It 'a service on its own --user-data-dir is shared only behind the conversion''s Start/Pre hook' {
    $dolly = '--user-data-dir=C:\Users\an\.egpt\state\an-beeper --disable-gpu'
    $hook = 'powershell.exe -NoProfile -File "C:\Users\an\bin\egpt\setup\s0-identity-reconcile.ps1" -PreStart -LogPath "C:\h\s0.log"'
    Test-BeeperSharedProfile $dolly 'C:\Users\an\AppData\Roaming' | Should Be $false
    Test-BeeperSharedProfile $dolly 'C:\Users\an\AppData\Roaming' '' | Should Be $false
    Test-BeeperSharedProfile $dolly 'C:\Users\an\AppData\Roaming' $hook | Should Be $true
    Test-BeeperSharedProfile $dolly 'C:\Users\an\AppData\Roaming' 'powershell.exe -File other.ps1' | Should Be $false
    Test-BeeperSharedProfile $script:Flags 'C:\Users\an\AppData\Roaming' $hook | Should Be $false
  }
}

Describe 'the shared profile and the window that opens it' {
  It 'the service''s own --user-data-dir when it has one (dolly), else the window''s default profile (reve)' {
    Get-BeeperShareProfile '--user-data-dir=C:\Users\an\.egpt\state\an-beeper --disable-gpu' 'C:\Users\an\AppData\Roaming' | Should Be 'C:\Users\an\.egpt\state\an-beeper'
    Get-BeeperShareProfile $script:Flags 'C:\Users\an\AppData\Roaming' | Should Be 'C:\Users\an\AppData\Roaming\BeeperTexts'
  }
  It 'the window needs --user-data-dir for any profile but the default one' {
    Get-BeeperWindowArgs 'C:\Users\an\AppData\Roaming\BeeperTexts' 'C:\Users\an\AppData\Roaming' | Should Be ''
    Get-BeeperWindowArgs 'c:/users/an/appdata/roaming/beepertexts/' 'C:\Users\an\AppData\Roaming' | Should Be ''
    Get-BeeperWindowArgs 'C:\Users\an\.egpt\state\an-beeper' 'C:\Users\an\AppData\Roaming' | Should Be '--user-data-dir="C:\Users\an\.egpt\state\an-beeper"'
    Get-BeeperUserDataDir (Get-BeeperWindowArgs 'C:\Users\an\.egpt\state\an-beeper' 'C:\Users\an\AppData\Roaming') | Should Be 'C:\Users\an\.egpt\state\an-beeper'
  }
  It 'Test-BeeperRunsProfile: a --user-data-dir naming the profile, whatever the spelling; none is not' {
    Test-BeeperRunsProfile '--user-data-dir="C:\Users\an\.egpt\state\an-beeper" --disable-gpu' 'c:/users/an/.egpt/state/an-beeper/' | Should Be $true
    Test-BeeperRunsProfile '--user-data-dir=C:\other' 'C:\Users\an\.egpt\state\an-beeper' | Should Be $false
    Test-BeeperRunsProfile $script:Flags 'C:\Users\an\AppData\Roaming\BeeperTexts' | Should Be $false
  }
}

Describe 'Get-BeeperServiceArgLine' {
  It 'is the profile plus the Session 0 flags, round-tripping through Get-BeeperUserDataDir' {
    $l = Get-BeeperServiceArgLine 'C:\Users\an\AppData\Roaming\BeeperTexts'
    $l | Should Be ('--user-data-dir="C:\Users\an\AppData\Roaming\BeeperTexts" ' + $script:Flags)
    Get-BeeperUserDataDir $l | Should Be 'C:\Users\an\AppData\Roaming\BeeperTexts'
  }
}

Describe 'the claim' {
  It 'is a sibling of the profile' {
    Get-BeeperClaimPath 'C:\Users\an\AppData\Roaming\BeeperTexts\' | Should Be 'C:\Users\an\AppData\Roaming\BeeperTexts.egpt-s1-claim'
  }
  It 'is held while one handle has it, refused to a second, and gone when released' {
    $p = Join-Path $TestDrive 'claim'
    Test-BeeperClaimHeld $p | Should Be $false
    $c = Open-BeeperClaim $p
    $c | Should Not BeNullOrEmpty
    Test-BeeperClaimHeld $p | Should Be $true
    Open-BeeperClaim $p | Should BeNullOrEmpty
    $c.Dispose()
    Test-Path $p | Should Be $false
    Test-BeeperClaimHeld $p | Should Be $false
  }
  It 'a leftover file nobody holds is not a claim' {
    $p = Join-Path $TestDrive 'stale-claim'
    Set-Content $p 'x'
    Test-BeeperClaimHeld $p | Should Be $false
  }
}

Describe 'Test-BeeperLockHeld (Chromium lockfile: write, share read, delete-on-close)' {
  It 'no lockfile: not held' {
    Test-BeeperLockHeld (Join-Path $TestDrive 'none') | Should Be $false
  }
  It 'held open the way Chromium holds it: held, and left in place' {
    $d = Join-Path $TestDrive 'live'; New-Item -ItemType Directory $d | Out-Null
    $lock = Join-Path $d 'lockfile'
    $h = New-Object IO.FileStream($lock, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read, 1, [IO.FileOptions]::DeleteOnClose)
    try {
      Test-BeeperLockHeld $d | Should Be $true
      Test-Path $lock | Should Be $true
    } finally { $h.Dispose() }
    Test-BeeperLockHeld $d | Should Be $false
  }
  It 'a lockfile no instance holds (a power cut) is not held, and is removed' {
    $d = Join-Path $TestDrive 'stale'; New-Item -ItemType Directory $d | Out-Null
    Set-Content (Join-Path $d 'lockfile') ''
    Test-BeeperLockHeld $d | Should Be $false
    Test-Path (Join-Path $d 'lockfile') | Should Be $false
  }
}

Describe 'Select-BeeperProfileProcesses' {
  $win = 'C:\Users\an\AppData\Roaming\BeeperTexts'
  $procs = @(
    [pscustomobject]@{ Name = 'Beeper.exe'; CommandLine = 'Beeper.exe' },
    [pscustomobject]@{ Name = 'Beeper.exe'; CommandLine = 'Beeper.exe --type=renderer --user-data-dir=C:\Users\an\AppData\Roaming\BeeperTexts' },
    [pscustomobject]@{ Name = 'Beeper.exe'; CommandLine = 'Beeper.exe --user-data-dir=C:/Users/an/.egpt/state/rodz-beeper/userdata' },
    [pscustomobject]@{ Name = 'Beeper.exe'; CommandLine = $null },
    [pscustomobject]@{ Name = 'node.exe'; CommandLine = 'node --user-data-dir=C:\Users\an\AppData\Roaming\BeeperTexts' }
  )
  It 'finds the children naming the profile, not another profile, an unreadable line or another program' {
    @(Select-BeeperProfileProcesses $procs $win).Count | Should Be 1
  }
  It 'in use = lockfile held OR a process naming it' {
    Test-BeeperProfileInUse (Join-Path $TestDrive 'nolock') $procs | Should Be $false
    $d = Join-Path $TestDrive 'BeeperTexts'; New-Item -ItemType Directory $d -Force | Out-Null
    $mine = @([pscustomobject]@{ Name = 'Beeper.exe'; CommandLine = "Beeper.exe --type=gpu-process --user-data-dir=$d" })
    Test-BeeperProfileInUse $d $mine | Should Be $true
  }
}

Describe 'the decisions' {
  It 'Start/Pre: 99 while Session 1 claims or runs the profile, 0 otherwise' {
    Get-BeeperPreStartCode $false $false | Should Be 0
    Get-BeeperPreStartCode $true $false | Should Be 99
    Get-BeeperPreStartCode $false $true | Should Be 99
  }
  It 'the reconciler only ever starts a Stopped service nobody claims or runs' {
    Get-BeeperReconcileAction 'Stopped' $false $false | Should Be 'start'
    Get-BeeperReconcileAction 'Stopped' $true $false | Should Be 'none'
    Get-BeeperReconcileAction 'Stopped' $false $true | Should Be 'none'
    Get-BeeperReconcileAction 'Running' $false $false | Should Be 'none'
    Get-BeeperReconcileAction 'StopPending' $false $false | Should Be 'none'
  }
}

Describe 'the spine, from a script' {
  It 'live = spine.pid names a running process and alive.txt beat within 2 min' {
    $h = Join-Path $TestDrive 'home'; New-Item -ItemType Directory (Join-Path $h 'state') -Force | Out-Null
    Test-EgptSpineLive $h | Should Be $false
    Set-Content (Join-Path $h 'state\spine.pid') $PID
    Set-Content (Join-Path $h 'state\alive.txt') 'beat'
    Test-EgptSpineLive $h | Should Be $true
    (Get-Item (Join-Path $h 'state\alive.txt')).LastWriteTime = (Get-Date).AddMinutes(-5)
    Test-EgptSpineLive $h | Should Be $false
  }
  It 'an ingest line lands whole, under a name the sweep reads' {
    $h = Join-Path $TestDrive 'home2'
    Send-EgptIngestLine $h '/beeper-hold on'
    $f = @(Get-ChildItem (Join-Path $h 'state\ingest'))
    $f.Count | Should Be 1
    $f[0].Name | Should Match '^beeper-hold-on-\d{17}$'
    [IO.File]::ReadAllText($f[0].FullName) | Should Be '/beeper-hold on'
  }
}

Describe 'Close-BeeperAppWindows' {
  It 'reaches a window hidden in the tray, which Process.CloseMainWindow cannot (the 2026-10-21 17:02 kill)' {
    $form = Join-Path $TestDrive 'hidden-form.ps1'
    Set-Content $form @'
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form
$f.ShowInTaskbar = $false
$f.add_Shown({ $f.Hide() })
[Windows.Forms.Application]::Run($f)
'@
    $p = Start-NoConsole $form
    try {
      Start-Sleep -Seconds 4   # the form shows, then hides itself
      $p.CloseMainWindow() | Should Be $false
      Start-Sleep -Milliseconds 500
      $p.HasExited | Should Be $false
      (Close-BeeperAppWindows @($p.Id) 'WindowsForms10.Window.*') -gt 0 | Should Be $true
      $p.WaitForExit(10000) | Should Be $true
    } finally { if (-not $p.HasExited) { $p.Kill() } }
  }
  It 'sends nothing to processes it was not given' {
    Close-BeeperAppWindows @(-1) | Should Be 0
  }
}

Describe 'Close-BeeperApp (-CloseAppOnly)' {
  # A hidden window in a throwaway process; -Hides swallows WM_CLOSE, as Beeper does with
  # "Quit Beeper when closing the main window" off.
  function Start-Form([string] $Name, [switch] $Hides) {
    $f = Join-Path $TestDrive "$Name.ps1"
    $eat = "Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition 'public class EatClose : System.Windows.Forms.IMessageFilter { public bool PreFilterMessage(ref System.Windows.Forms.Message m) { return m.Msg == 0x10; } }'; [Windows.Forms.Application]::AddMessageFilter((New-Object EatClose))"
    Set-Content $f @(
      'Add-Type -AssemblyName System.Windows.Forms'
      $(if ($Hides) { $eat } else { '' })
      '$f = New-Object Windows.Forms.Form; $f.ShowInTaskbar = $false; $f.add_Shown({ $f.Hide() })'
      '[Windows.Forms.Application]::Run($f)'
    )
    $p = Start-NoConsole $f
    Start-Sleep -Seconds 4
    return $p
  }
  $noLock = Join-Path $TestDrive 'profile-none'

  It 'an app that quits on WM_CLOSE: $true once its process is gone' {
    $p = Start-Form 'quits'
    try {
      $get = { @(Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)") }.GetNewClosure()
      Close-BeeperApp 15 $noLock $get 'WindowsForms10.Window.*' | Should Be $true
      $p.HasExited | Should Be $true
    } finally { if (-not $p.HasExited) { $p.Kill() } }
  }
  It 'an app that only hides (Beeper with quit_on_close off): $false after the wait, and still running' {
    $p = Start-Form 'hides' -Hides
    try {
      $get = { @(Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)") }.GetNewClosure()
      Close-BeeperApp 3 $noLock $get 'WindowsForms10.Window.*' | Should Be $false
      $p.HasExited | Should Be $false
    } finally { if (-not $p.HasExited) { $p.Kill() } }
  }
  It 'gone, but its profile lockfile still held: not quit until the lock clears' {
    $d = Join-Path $TestDrive 'held'; New-Item -ItemType Directory $d | Out-Null
    $h = New-Object IO.FileStream((Join-Path $d 'lockfile'), [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read, 1, [IO.FileOptions]::DeleteOnClose)
    $script:polls = 0
    $get = { $script:polls++; if ($script:polls -eq 1) { @([pscustomobject]@{ ProcessId = -1; CommandLine = 'Beeper.exe' }) } else { @() } }
    try { Close-BeeperApp 2 $d $get | Should Be $false } finally { $h.Dispose() }
    $script:polls = 0
    Close-BeeperApp 2 $d $get | Should Be $true
  }
  It 'not running at all: $true at once, nothing sent' {
    Close-BeeperApp 30 $noLock { @() } | Should Be $true
  }
}

Describe 'running a Beeper service as the desktop user - the pieces (no LogonUser, no LSA)' {
  It 'a service logon result in words: 1385 is a right password without the right yet' {
    (Get-BeeperLogonVerdict 0).ok | Should Be $true
    $v = Get-BeeperLogonVerdict 1385; $v.ok | Should Be $true; $v.rightMissing | Should Be $true
    (Get-BeeperLogonVerdict 1326).message | Should Be 'wrong user name or password'
    (Get-BeeperLogonVerdict 1327).message | Should Be $BeeperBlankPasswordLine
    (Get-BeeperLogonVerdict 1909).ok | Should Be $false
    (Get-BeeperLogonVerdict 5).message | Should Match 'Win32 error 5'
  }
  It 'a blank password is refused with one line, before LogonUser is ever called' {
    $blank = New-Object pscredential('.\an', (New-Object Security.SecureString))
    $v = Test-BeeperCredential $blank
    $v.ok | Should Be $false
    $v.message | Should Be 'a blank password cannot run a service: Windows allows blank-password accounts to log on at the console only'
  }
  It 'account names: .\an, MACHINE\an and a bare name all mean this machine' {
    (Split-BeeperAccount '.\an').account | Should Be '.\an'
    (Split-BeeperAccount "$env:COMPUTERNAME\an").account | Should Be '.\an'
    (Split-BeeperAccount 'an').account | Should Be '.\an'
    (Split-BeeperAccount 'DOMAIN\bob').domain | Should Be 'DOMAIN'
  }
  It 'the native type compiles (nothing in it is called)' {
    Add-BeeperAccountType
    @([EgptBeeper.Acct].GetMethods() | Where-Object { $_.IsStatic -and $_.DeclaringType.Name -eq 'Acct' } | ForEach-Object { $_.Name } | Sort-Object) -join ',' | Should Be 'Rights,SetRight,SetServiceAccount,TryServiceLogon'
  }
}

Describe 'the profile ACL check' {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $rule = { param($sid, $type, $rights, $prop = 0) [pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $sid }; AccessControlType = $type; FileSystemRights = $rights; PropagationFlags = $prop } }
  It 'full control (or GENERIC_ALL) for the SID passes; read only, a deny, an inherit-only ACE or another SID does not' {
    Test-BeeperAclRules @(& $rule $me 'Allow' 2032127) $me | Should Be $true
    Test-BeeperAclRules @(& $rule $me 'Allow' 0x10000000) $me | Should Be $true
    Test-BeeperAclRules @(& $rule $me 'Allow' 1179785) $me | Should Be $false
    Test-BeeperAclRules @((& $rule $me 'Allow' 2032127), (& $rule $me 'Deny' 278)) $me | Should Be $false
    Test-BeeperAclRules @(& $rule $me 'Allow' 2032127 2) $me | Should Be $false
    Test-BeeperAclRules @(& $rule 'S-1-5-18' 'Allow' 2032127) $me | Should Be $false
  }
  It 'Get-BeeperAclGaps finds the one file that does not give the user full control' {
    # DACL-only writes (Set-Acl would rewrite owner and SACL too). A profile in the user's own tree
    # gives full control by inheritance; TEMP may not, so the fixture says it itself.
    $sidObj = New-Object Security.Principal.SecurityIdentifier $me
    $d = Join-Path $TestDrive 'acl-profile'; New-Item -ItemType Directory $d -Force | Out-Null
    $dir = Get-Item $d; $da = $dir.GetAccessControl('Access')
    $da.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sidObj, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    $dir.SetAccessControl($da)
    New-Item -ItemType Directory (Join-Path $d 'sub') -Force | Out-Null
    Set-Content (Join-Path $d 'sub\ok.db') 'x'
    $bad = Join-Path $d 'sub\locked.db'; Set-Content $bad 'x'
    @(Get-BeeperAclGaps $d $me).Count | Should Be 0
    $f = Get-Item $bad; $fa = $f.GetAccessControl('Access')
    $fa.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sidObj, 'WriteExtendedAttributes', 'Deny')))   # harmless; still deletable
    $f.SetAccessControl($fa)
    $gaps = @(Get-BeeperAclGaps $d $me)
    $gaps.Count | Should Be 1
    $gaps[0] | Should Be $bad
  }
}
