# Unit coverage for setup\share-beeper-primary-profile.ps1's plan (loaded with -LoadFunctionsOnly;
# states are built here). The machinery itself needs an elevated box and is the live phase.
#   Invoke-Pester -Script setup\share-beeper-primary-profile.Tests.ps1   (Pester 3.4: `Should Be`)
# ASCII ONLY.

. (Join-Path $PSScriptRoot 'share-beeper-primary-profile.ps1') -LoadFunctionsOnly

function New-State([hashtable] $Over = @{}, [hashtable] $Service = @{}) {
  $svc = [ordered]@{
    exists = $true; state = 'Running'; account = 'LocalSystem'; exe = 'C:\B\Beeper.exe'
    appParameters = '--disable-gpu --disable-gpu-compositing'; stopConsole = '1500'; preHook = ''; nssmVersion = '2.24-101-g897c7ad'
  }
  foreach ($k in $Service.Keys) { $svc[$k] = $Service[$k] }
  $s = [ordered]@{
    serviceName = 'egpt-beeper-primary'; appData = 'C:\Users\an\AppData\Roaming'; profile = 'C:\Users\an\AppData\Roaming\BeeperTexts'
    profileExists = $true; recordPath = 'C:\h\state\beeper-share.json'; record = $null; hooks = $true; spineLive = $true
    service = $svc; windowUp = $true; runValue = '"C:\B\Beeper.exe"'; config = [ordered]@{ primary = $true; primaryGui = $true }
    user = 'reve\an'; task = $null; launcherRunValue = $null; shortcutExists = $false; launcherRunning = $false
  }
  foreach ($k in $Over.Keys) { $s[$k] = $Over[$k] }
  return [pscustomobject]$s
}

Describe 'Get-SharePlan - convert' {
  It 'eight steps, backup first, the record before the token, the launcher last' {
    $p = Get-SharePlan (New-State) $false
    $p.ok | Should Be $true
    @($p.steps).Count | Should Be 8
    ($p.steps | ForEach-Object { ($_ -split ':')[0] }) -join ',' | Should Be 'backup,window,token,config,service,reconciler,logon,launcher'
    $p.steps[0] | Should Match 'quit it'
    $p.steps[2] | Should Match 'beeper-share\.json'
    $p.steps[4] | Should Match ([regex]::Escape('--user-data-dir="C:\Users\an\AppData\Roaming\BeeperTexts"'))
    $p.steps[4] | Should Match 'AppStopMethodConsole 10000'
  }
  It 'refuses, before anything: no service, an existing record, not LocalSystem, already shared, no profile, old NSSM, no primary' {
    (Get-SharePlan (New-State @{} @{ exists = $false }) $false).step | Should Be 'service'
    (Get-SharePlan (New-State @{ record = [pscustomobject]@{ a = 1 } }) $false).step | Should Be 'record'
    (Get-SharePlan (New-State @{} @{ account = '.\an' }) $false).step | Should Be 'account'
    (Get-SharePlan (New-State @{} @{ appParameters = '--user-data-dir="C:\Users\an\AppData\Roaming\BeeperTexts" --disable-gpu' }) $false).step | Should Be 'shared'
    (Get-SharePlan (New-State @{ profileExists = $false }) $false).step | Should Be 'profile'
    (Get-SharePlan (New-State @{ hooks = $false }) $false).step | Should Be 'nssm'
    (Get-SharePlan (New-State @{ config = [pscustomobject]@{ primary = $false } }) $false).step | Should Be 'config'
  }
}

Describe 'Get-SharePlan - revert' {
  It 'needs the record, undoes in reverse and names the profile backup' {
    (Get-SharePlan (New-State) $true).step | Should Be 'record'
    $r = [pscustomobject]@{ appParameters = '--disable-gpu'; runValue = '"C:\B\Beeper.exe"'; configBackup = 'C:\h\config.yaml.bak-share-1'; profileBackup = 'C:\Users\an\AppData\Roaming\BeeperTexts.backup-1'; profileBackupMB = 1843 }
    $p = Get-SharePlan (New-State @{ record = $r }) $true
    $p.ok | Should Be $true
    ($p.steps | ForEach-Object { ($_ -split ':')[0] }) -join ',' | Should Be 'launcher,logon,reconciler,service,config,service,spine,backup'
    $p.steps[-1] | Should Match 'BeeperTexts\.backup-1 \(1843 MB\)'
  }
}

Describe 'Test-NssmHooks' {
  It 'Start/Pre hooks exist from 2.24-101' {
    Test-NssmHooks '2.24-101-g897c7ad' | Should Be $true
    Test-NssmHooks '2.24-94' | Should Be $false
    Test-NssmHooks '2.24' | Should Be $false
  }
}

Describe 'Get-SharePlan - revert while the service logs on as the user' {
  It 'is refused: back to no --user-data-dir as the user would be that user''s own window profile' {
    $r = [pscustomobject]@{ appParameters = '--disable-gpu'; runValue = ''; configBackup = 'c'; profileBackup = 'p'; profileBackupMB = 1 }
    $p = Get-SharePlan (New-State @{ record = $r } @{ account = '.\an' }) $true
    $p.step | Should Be 'account'
    $p.remedy | Should Match 'beeper-services-run-as-user\.cmd -Revert'
  }
}

# reve 2026-10-22 00:30: steps 1-5 done, step 6 failed. The state -Resume starts from.
function New-HalfState([hashtable] $Over = @{}, [hashtable] $Service = @{}) {
  $svc = @{
    state = 'Stopped'; stopConsole = '10000'
    appParameters = '--user-data-dir="C:\Users\an\AppData\Roaming\BeeperTexts" --disable-gpu'
    preHook = 'powershell.exe -NoProfile -File "C:\Users\an\bin\egpt\setup\s0-identity-reconcile.ps1" -PreStart -LogPath "C:\h\s0.log"'
  }
  foreach ($k in $Service.Keys) { $svc[$k] = $Service[$k] }
  $o = @{ record = [pscustomobject]@{ appParameters = '--disable-gpu'; runValue = '"C:\B\Beeper.exe"' }; config = [pscustomobject]@{ primary = $true; primaryGui = $false } }
  foreach ($k in $Over.Keys) { $o[$k] = $Over[$k] }
  return New-State $o $svc
}
function Get-Ids($p) { @($p.steps | ForEach-Object { ($_ -split ':')[0] }) -join ',' }
$script:Repeating = @([pscustomobject]@{ kind = 'Time'; interval = 'PT2M'; duration = '' }, [pscustomobject]@{ kind = 'Boot'; interval = ''; duration = '' })
$script:S4U = [pscustomobject]@{ userId = 'reve\an'; logonType = 'S4U'; triggers = $script:Repeating }
# reve 2026-10-22 01:16: registered, Ready, never ran - its 2-min repetition hung off AtStartup only.
$script:BootOnly = [pscustomobject]@{ userId = 'reve\an'; logonType = 'S4U'; triggers = @([pscustomobject]@{ kind = 'Boot'; interval = 'PT2M'; duration = '' }) }

Describe 'Get-SharePlan - resume a conversion that stopped' {
  It 'the live state (task, logon, launcher missing): exactly steps 6, 7, 8' {
    $p = Get-SharePlan (New-HalfState) $false $true
    $p.ok | Should Be $true
    Get-Ids $p | Should Be 'reconciler,logon,launcher'
    $p.steps[0] | Should Match 'as reve\\an \(S4U'
    $p.steps[1] | Should Match 'com\.automattic\.beeper\.desktop \(present\) -> egpt-beeper-window \(absent\)'
  }
  It 'picks up at each step boundary' {
    Get-Ids (Get-SharePlan (New-HalfState @{ task = $script:S4U }) $false $true) | Should Be 'logon,launcher'
    Get-Ids (Get-SharePlan (New-HalfState @{ task = $script:S4U; runValue = $null; launcherRunValue = 'x'; shortcutExists = $true }) $false $true) | Should Be 'launcher'
    Get-Ids (Get-SharePlan (New-HalfState @{ task = $script:S4U; runValue = $null; launcherRunValue = 'x'; shortcutExists = $true; launcherRunning = $true }) $false $true) | Should Be ''
  }
  It 'a half-done logon step (Beeper''s Run value gone, no shortcut yet) is redone whole' {
    Get-Ids (Get-SharePlan (New-HalfState @{ task = $script:S4U; runValue = $null; launcherRunValue = 'x'; shortcutExists = $false }) $false $true) | Should Be 'logon,launcher'
  }
  It 'reve after the resume: a task whose repetition hangs off AtStartup only is registered again; nothing else' {
    $done = @{ runValue = $null; launcherRunValue = 'x'; shortcutExists = $true; launcherRunning = $true }
    $p = Get-SharePlan (New-HalfState ($done + @{ task = $script:BootOnly })) $false $true
    Get-Ids $p | Should Be 'reconciler'
    $p.steps[0] | Should Match 'every 2 min from now on, and at boot\) - replacing one with no repeating time trigger'
    Get-Ids (Get-SharePlan (New-HalfState ($done + @{ task = $script:S4U })) $false $true) | Should Be ''
    $finite = [pscustomobject]@{ userId = 'reve\an'; logonType = 'S4U'; triggers = @([pscustomobject]@{ kind = 'Time'; interval = 'PT2M'; duration = 'P1D' }) }
    Get-Ids (Get-SharePlan (New-HalfState ($done + @{ task = $finite })) $false $true) | Should Be 'reconciler'
  }
  It 'a task that runs as SYSTEM (or not S4U) is registered again, as the user' {
    $p = Get-SharePlan (New-HalfState @{ task = [pscustomobject]@{ userId = 'SYSTEM'; logonType = 'ServiceAccount' } }) $false $true
    Get-Ids $p | Should Be 'reconciler,logon,launcher'
    $p.steps[0] | Should Match 'replacing the one that runs as SYSTEM'
    Get-Ids (Get-SharePlan (New-HalfState @{ task = [pscustomobject]@{ userId = 'reve\an'; logonType = 'Password' } }) $false $true) | Should Be 'reconciler,logon,launcher'
  }
  It 'earlier gaps come first: primary_gui still there, the hook or the Ctrl+C grace not set' {
    Get-Ids (Get-SharePlan (New-HalfState @{ config = [pscustomobject]@{ primary = $true; primaryGui = $true } }) $false $true) | Should Be 'config,reconciler,logon,launcher'
    Get-Ids (Get-SharePlan (New-HalfState @{} @{ preHook = '' }) $false $true) | Should Be 'service,reconciler,logon,launcher'
    Get-Ids (Get-SharePlan (New-HalfState @{} @{ stopConsole = '1500' }) $false $true) | Should Be 'service,reconciler,logon,launcher'
  }
  It 'refused without a record, and when the service does not run the profile yet (stopped before step 5)' {
    (Get-SharePlan (New-HalfState @{ record = $null }) $false $true).step | Should Be 'record'
    $p = Get-SharePlan (New-HalfState @{} @{ appParameters = '--disable-gpu' }) $false $true
    $p.step | Should Be 'service'
    $p.remedy | Should Match '-Revert'
  }
  It 'a plain rerun on the half state points at -Resume' {
    (Get-SharePlan (New-HalfState) $false).remedy | Should Be 'run with -Resume to finish it, or -Revert to undo it'
  }
}

# dolly (inferred: unreachable 2026-10-22): egpt-beeper-primary already runs its own profile, and
# beeper.primary.token is that install's. The window opens on it; the device and token stay.
$script:DollyProfile = 'C:\Users\an\.egpt\state\an-beeper'
$script:DollyHook = 'powershell.exe -NoProfile -File "C:\Users\an\bin\egpt\setup\s0-identity-reconcile.ps1" -PreStart -LogPath "C:\h\s0.log"'
function New-DollyState([hashtable] $Over = @{}, [hashtable] $Service = @{}) {
  $svc = @{ appParameters = "--user-data-dir=$script:DollyProfile --disable-gpu --disable-gpu-compositing"; stopConsole = '' }
  foreach ($k in $Service.Keys) { $svc[$k] = $Service[$k] }
  $o = @{ profile = $script:DollyProfile; windowUp = $false; user = 'Dolly\an' }
  foreach ($k in $Over.Keys) { $o[$k] = $Over[$k] }
  return New-State $o $svc
}
function Read-Fixture([string] $Name) { Get-Content (Join-Path $PSScriptRoot "fixtures\share-state-$Name.json") -Raw | ConvertFrom-Json }

Describe 'Get-SharePlan - dolly: the service already runs its own profile' {
  It 'the fixture: eight steps on an-beeper; the service stopped for the backup, the window opened on it, the token kept and checked, AppParameters untouched' {
    $p = Get-SharePlan (Read-Fixture 'dolly') $false
    $p.ok | Should Be $true
    $p.keepToken | Should Be $true
    Get-Ids $p | Should Be 'backup,window,token,config,service,reconciler,logon,launcher'
    $p.steps[0] | Should Be 'backup: egpt-beeper-primary runs it: stopped first; copy C:\Users\an\.egpt\state\an-beeper to C:\Users\an\.egpt\state\an-beeper.backup-<time>'
    $p.steps[1] | Should Be 'window: open Beeper.exe --user-data-dir="C:\Users\an\.egpt\state\an-beeper" and wait for its API'
    $p.steps[2] | Should Match '^token: keep beeper\.primary\.token .*no mint.*answers on the window''s port, then write .*beeper-share\.json$'
    $p.steps[2] | Should Not Match 'click Approve'
    $p.steps[4] | Should Match 'AppParameters stay as they are; AppStopMethodConsole 10000; AppEvents Start/Pre'
    $p.steps[4] | Should Not Match 'AppParameters ->'
  }
  It 'the reve fixture (before its conversion) still mints and repoints' {
    $p = Get-SharePlan (Read-Fixture 'reve') $false
    $p.keepToken | Should Be $false
    $p.steps[1] | Should Be 'window: open Beeper again and wait for its API'
    $p.steps[2] | Should Match 'mint a token on the window \(click Approve there\)'
    $p.steps[4] | Should Match ([regex]::Escape('AppParameters -> --user-data-dir="C:\Users\an\AppData\Roaming\BeeperTexts"'))
  }
  It 'the profile spelled another way is still the service''s own' {
    (Get-SharePlan (New-DollyState @{} @{ appParameters = '--user-data-dir="c:/users/an/.egpt/state/an-beeper/" --disable-gpu' }) $false).keepToken | Should Be $true
  }
  It 'a window open on the profile is asked to quit; a Stopped service is still named as the holder' {
    (Get-SharePlan (New-DollyState @{ windowUp = $true } @{ state = 'Stopped' }) $false).steps[0] | Should Match '^backup: Beeper is open: you will be asked to quit it'
    (Get-SharePlan (New-DollyState @{} @{ state = 'Stopped' }) $false).steps[0] | Should Match '^backup: egpt-beeper-primary runs it: stopped first'
  }
  It 'refuses: an entry the desktop user lacks full control of (the first named), already shared, an existing record, no primary token' {
    $p = Get-SharePlan (New-DollyState @{ aclGaps = 3; firstGap = "$script:DollyProfile\Local State" }) $false
    $p.step | Should Be 'acl'
    $p.error | Should Be '3 entries in C:\Users\an\.egpt\state\an-beeper do not give Dolly\an full control (first: C:\Users\an\.egpt\state\an-beeper\Local State)'
    $p.remedy | Should Match ([regex]::Escape('give Dolly\an full control of C:\Users\an\.egpt\state\an-beeper'))
    (Get-SharePlan (New-DollyState @{} @{ preHook = $script:DollyHook }) $false).step | Should Be 'shared'
    (Get-SharePlan (New-DollyState @{ record = [pscustomobject]@{ a = 1 } }) $false).remedy | Should Be 'run with -Resume to finish it, or -Revert to undo it'
    (Get-SharePlan (New-DollyState @{ config = [pscustomobject]@{ primary = $false } }) $false).step | Should Be 'config'
  }
  It 'the ACL refusal applies to the reve shape too' {
    (Get-SharePlan (New-State @{ aclGaps = 1; firstGap = 'x' }) $false).step | Should Be 'acl'
  }
}

# dolly after step 3: the record is written, the hook and the rest not yet.
function New-DollyHalfState([hashtable] $Over = @{}, [hashtable] $Service = @{}) {
  $rec = [pscustomobject]@{ profile = $script:DollyProfile; appParameters = "--user-data-dir=$script:DollyProfile --disable-gpu --disable-gpu-compositing"; runValue = '"C:\B\Beeper.exe"'; configBackup = 'C:\h\config.yaml.bak-share-1'; profileBackup = "$script:DollyProfile.backup-1"; profileBackupMB = 900 }
  $o = @{ record = $rec; windowUp = $true }
  foreach ($k in $Over.Keys) { $o[$k] = $Over[$k] }
  $svc = @{ state = 'Stopped' }
  foreach ($k in $Service.Keys) { $svc[$k] = $Service[$k] }
  return New-DollyState $o $svc
}

Describe 'Get-SharePlan - dolly: resume and revert' {
  It 'resume picks up after step 3: AppParameters never change, so it is never "before step 5"' {
    Get-Ids (Get-SharePlan (New-DollyHalfState) $false $true) | Should Be 'config,service,reconciler,logon,launcher'
    Get-Ids (Get-SharePlan (New-DollyHalfState @{ config = [pscustomobject]@{ primary = $true; primaryGui = $false } } @{ preHook = $script:DollyHook; stopConsole = '10000' }) $false $true) | Should Be 'reconciler,logon,launcher'
    $done = @{ config = [pscustomobject]@{ primary = $true; primaryGui = $false }; task = $script:S4U; runValue = $null; launcherRunValue = 'x'; shortcutExists = $true; launcherRunning = $true }
    Get-Ids (Get-SharePlan (New-DollyHalfState $done @{ preHook = $script:DollyHook; stopConsole = '10000' }) $false $true) | Should Be ''
  }
  It 'revert: AppParameters stay, Beeper on the profile is quit before the service takes it back' {
    $p = Get-SharePlan (New-DollyHalfState @{} @{ preHook = $script:DollyHook; stopConsole = '10000' }) $true
    $p.ok | Should Be $true
    Get-Ids $p | Should Be 'launcher,logon,reconciler,service,config,window,service,spine,backup'
    $p.steps[3] | Should Be "service: stop egpt-beeper-primary; AppParameters stay '--user-data-dir=C:\Users\an\.egpt\state\an-beeper --disable-gpu --disable-gpu-compositing'; Start/Pre hook and Ctrl+C grace back"
    $p.steps[5] | Should Match ('^' + [regex]::Escape('window: Beeper on C:\Users\an\.egpt\state\an-beeper quit first'))
    $p.steps[6] | Should Be 'service: start egpt-beeper-primary (the device the window ran)'
    $p.steps[-1] | Should Match 'an-beeper\.backup-1 \(900 MB\)'
  }
  It 'revert while the service logs on as the user is not refused: it keeps its --user-data-dir' {
    (Get-SharePlan (New-DollyHalfState @{} @{ account = '.\an' }) $true).ok | Should Be $true
  }
}
