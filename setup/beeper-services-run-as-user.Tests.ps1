# Unit coverage for setup\beeper-services-run-as-user.ps1's plan (loaded with -LoadFunctionsOnly;
# states are built here). No service, credential, LSA policy or registry key is touched.
#   Invoke-Pester -Script setup\beeper-services-run-as-user.Tests.ps1   (Pester 3.4: `Should Be`)
# ASCII ONLY.

. (Join-Path $PSScriptRoot 'beeper-services-run-as-user.ps1') -LoadFunctionsOnly

function New-Svc([hashtable] $Over = @{}) {
  $v = [ordered]@{
    name = 'egpt-beeper-secondary'; state = 'Running'; account = 'LocalSystem'; udd = 'C:/Users/an/.egpt/state/rodz-beeper/userdata'
    uddExists = $true; connection = 'secondary'; lockHeld = $true; aclGaps = 0; firstGap = $null; profileMB = 505; shared = $false; hasToken = $true
  }
  foreach ($k in $Over.Keys) { $v[$k] = $Over[$k] }
  return [pscustomobject]$v
}
function New-State($Services, [hashtable] $Over = @{}) {
  $s = [ordered]@{ user = '.\an'; sid = 'S-1-5-21-1-2-3-1001'; rightHeld = $null; recordPath = 'C:\h\state\beeper-run-as-user.json'; record = $null; services = @($Services) }
  foreach ($k in $Over.Keys) { $s[$k] = $Over[$k] }
  return [pscustomobject]$s
}
$script:Primary = @{ name = 'egpt-beeper-primary'; udd = $null; uddExists = $false; connection = 'primary' }

Describe 'Get-RunAsRow - the hard guard and the other refusals' {
  It 'reve today: the secondary switches; the primary (no --user-data-dir) is refused, saying why' {
    (Get-RunAsRow (New-Svc) '.\an').action | Should Be 'switch'
    $p = Get-RunAsRow (New-Svc $script:Primary) '.\an'
    $p.action | Should Be 'refuse'
    $p.reason | Should Match 'no --user-data-dir'
    $p.reason | Should Match 'two instances of one device'
  }
  It 'already the user: skipped, whatever the spelling' {
    (Get-RunAsRow (New-Svc @{ account = '.\an' }) '.\an').action | Should Be 'skip'
    (Get-RunAsRow (New-Svc @{ account = "$env:COMPUTERNAME\an" }) '.\an').action | Should Be 'skip'
  }
  It 'refuses another account, a missing profile, no token, a window holding the profile, and ACL gaps' {
    (Get-RunAsRow (New-Svc @{ account = 'NT AUTHORITY\LocalService' }) '.\an').reason | Should Match 'only LocalSystem'
    (Get-RunAsRow (New-Svc @{ uddExists = $false }) '.\an').reason | Should Match 'not there'
    (Get-RunAsRow (New-Svc @{ hasToken = $false }) '.\an').reason | Should Match 'no token'
    (Get-RunAsRow (New-Svc @{ state = 'Stopped'; lockHeld = $true }) '.\an').reason | Should Match 'quit Beeper from the tray'
    (Get-RunAsRow (New-Svc @{ aclGaps = 3; firstGap = 'C:\p\x.db' }) '.\an').reason | Should Match '3 entries .* full control \(first: C:\\p\\x\.db\)'
  }
  It 'a stopped service whose profile nobody holds can switch' {
    (Get-RunAsRow (New-Svc @{ state = 'Stopped'; lockHeld = $false }) '.\an').action | Should Be 'switch'
  }
}

Describe 'Get-RunAsPlan' {
  It 'the steps: the credential first, then the right, then one line per switching service' {
    $p = Get-RunAsPlan (New-State @((New-Svc $script:Primary), (New-Svc))) $false
    $p.ok | Should Be $true
    @($p.rows).Count | Should Be 2
    @($p.steps).Count | Should Be 3
    $p.steps[0] | Should Match '^credential: .*never stored, logged or put on a command line'
    $p.steps[1] | Should Match '^logon right: grant SeServiceLogonRight'
    $p.steps[2] | Should Match '^egpt-beeper-secondary: hold the spine, stop, back up its profile'
  }
  It 'nothing switchable: refused, with the rows' {
    $p = Get-RunAsPlan (New-State @((New-Svc $script:Primary))) $false
    $p.ok | Should Be $false
    $p.step | Should Be 'nothing'
    @($p.rows).Count | Should Be 1
  }
  It 'a later run (record there): skips the switched one untouched, switches the primary and adds it to the record' {
    $rec = [pscustomobject]@{ user = '.\an'; rightAdded = $true; services = [pscustomobject]@{ 'egpt-beeper-secondary' = [pscustomobject]@{ backup = 'C:\s.backup-1' } } }
    $primary = New-Svc @{ name = 'egpt-beeper-primary'; connection = 'primary'; udd = 'C:\Users\an\AppData\Roaming\BeeperTexts'; state = 'Stopped'; lockHeld = $false; shared = $true; profileMB = 1753 }
    $p = Get-RunAsPlan (New-State @($primary, (New-Svc @{ account = '.\an' })) @{ record = $rec }) $false
    $p.ok | Should Be $true
    ($p.rows | ForEach-Object { "$($_.service)=$($_.action)" }) -join ',' | Should Be 'egpt-beeper-primary=switch,egpt-beeper-secondary=skip'
    $p.rows[1].reason | Should Be 'already runs as .\an - no stop, no backup'
    $p.steps[2] | Should Be 'egpt-beeper-primary: back up its profile beside it, log on as .\an, leave it Stopped as it is'
    $p.steps[-1] | Should Match '^record: add to .*keeping what is there'
  }
  It 'reve with the window open: the secondary skipped, the primary refused only because the window holds it' {
    $rec = [pscustomobject]@{ user = '.\an'; rightAdded = $true; services = [pscustomobject]@{ 'egpt-beeper-secondary' = [pscustomobject]@{ backup = 'b' } } }
    $primary = New-Svc @{ name = 'egpt-beeper-primary'; connection = 'primary'; udd = 'C:\Users\an\AppData\Roaming\BeeperTexts'; state = 'Stopped'; lockHeld = $true; shared = $true }
    $p = Get-RunAsPlan (New-State @($primary, (New-Svc @{ account = '.\an' })) @{ record = $rec }) $false
    $p.ok | Should Be $false
    $p.step | Should Be 'nothing'
    $p.rows[0].reason | Should Match '^your Beeper window holds its profile: quit Beeper from the tray first'
    $p.rows[1].action | Should Be 'skip'
  }
  It 'every eligible service already switched: nothing to do, not a refusal' {
    $rec = [pscustomobject]@{ user = '.\an'; rightAdded = $false; services = [pscustomobject]@{ a = 1 } }
    $p = Get-RunAsPlan (New-State @((New-Svc @{ account = '.\an' }), (New-Svc @{ name = 'egpt-beeper-primary'; account = 'reve\an' })) @{ record = $rec }) $false
    $p.ok | Should Be $true
    $p.nothing | Should Be $true
    @($p.steps).Count | Should Be 0
  }
  It 'revert: every recorded service back to LocalSystem, and the right removed only when this added it' {
    (Get-RunAsPlan (New-State @()) $true).step | Should Be 'record'
    $rec = [pscustomobject]@{ user = '.\an'; rightAdded = $true; services = [pscustomobject]@{ 'egpt-beeper-secondary' = [pscustomobject]@{ backup = 'C:\p.backup-1' } } }
    $p = Get-RunAsPlan (New-State @() @{ record = $rec }) $true
    $p.ok | Should Be $true
    $p.steps[0] | Should Match '^egpt-beeper-secondary: .*log on as LocalSystem.*C:\\p\.backup-1'
    $p.steps[-1] | Should Match 'remove SeServiceLogonRight from \.\\an: True'
    $rec.rightAdded = $false
    (Get-RunAsPlan (New-State @() @{ record = $rec }) $true).steps[-1] | Should Match ': False'
  }
}
