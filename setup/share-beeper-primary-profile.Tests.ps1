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
