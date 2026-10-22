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
$script:S4U = [pscustomobject]@{ userId = 'reve\an'; logonType = 'S4U' }

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
