# Unit coverage for setup\s0-identity-reconcile.ps1 (loaded with -LoadFunctionsOnly): the egpt-daemon
# part of the pass, and that the Beeper part and it never skip each other. Services are mocks.
#   Invoke-Pester -Script setup\s0-identity-reconcile.Tests.ps1   (Pester 3.4: `Should Be`)
# ASCII ONLY.

. (Join-Path $PSScriptRoot 'egpt-runners.ps1')
. (Join-Path $PSScriptRoot 's0-identity-reconcile.ps1') -LoadFunctionsOnly -ServiceName 'egpt-beeper-primary' -EgptHome 'C:\h\.egpt'

function New-Facts([hashtable] $Over = @{}) {
  $f = [ordered]@{ exists = $true; status = 'Stopped'; startMode = 'Auto'; stopFile = $false; s1DaemonPid = $null; s1Claimed = $false }
  foreach ($k in $Over.Keys) { $f[$k] = $Over[$k] }
  return [pscustomobject]$f
}

Describe 'Invoke-ReconcilePass - one part failing never skips the other' {
  It 'a Beeper failure still runs the egpt-daemon part' {
    Mock Say { }
    Mock Invoke-BeeperPart { throw 'no such service' }
    Mock Invoke-EgptDaemonPart { }
    Invoke-ReconcilePass | Should Be 1
    Assert-MockCalled Invoke-EgptDaemonPart -Times 1 -Exactly -Scope It
    Assert-MockCalled Say -Times 1 -Exactly -Scope It -ParameterFilter { $m -eq 'FAILED (egpt-beeper-primary): no such service' }
  }
  It 'an egpt-daemon failure comes after the Beeper part ran' {
    Mock Say { }
    Mock Invoke-BeeperPart { 0 }
    Mock Invoke-EgptDaemonPart { throw 'access denied' }
    Invoke-ReconcilePass | Should Be 1
    Assert-MockCalled Invoke-BeeperPart -Times 1 -Exactly -Scope It
    Assert-MockCalled Say -Times 1 -Exactly -Scope It -ParameterFilter { $m -eq 'FAILED (egpt-daemon): access denied' }
  }
  It 'both fail: 2; both fine: 0' {
    Mock Say { }
    Mock Invoke-BeeperPart { throw 'a' }
    Mock Invoke-EgptDaemonPart { throw 'b' }
    Invoke-ReconcilePass | Should Be 2
    Mock Invoke-BeeperPart { 0 }
    Mock Invoke-EgptDaemonPart { }
    Invoke-ReconcilePass | Should Be 0
  }
}

Describe 'Invoke-EgptDaemonPart' {
  It 'starts a Stopped, Automatic egpt-daemon with no STOP file, and says so' {
    Mock Say { }
    Mock Start-Service { }
    Mock Read-EgptServiceFacts { New-Facts }
    Invoke-EgptDaemonPart
    Assert-MockCalled Start-Service -Times 1 -Exactly -Scope It -ParameterFilter { $Name -eq 'egpt-daemon' }
    Assert-MockCalled Read-EgptServiceFacts -Times 1 -Exactly -Scope It -ParameterFilter { $Name -eq 'egpt-daemon' -and $EgptHome -eq 'C:\h\.egpt' }
    Assert-MockCalled Say -Times 1 -Exactly -Scope It
  }
  It 'beside a Session 1 daemon that holds s1.claim it starts too: the service holds off on its own' {
    Mock Say { }
    Mock Start-Service { }
    Mock Read-EgptServiceFacts { New-Facts @{ s1DaemonPid = 4242; s1Claimed = $true } }
    Invoke-EgptDaemonPart
    Assert-MockCalled Start-Service -Times 1 -Exactly -Scope It
  }
  It 'leaves alone, quietly: Running, Manual, Disabled, a STOP file, an older Session 1 daemon, no service' {
    Mock Say { }
    Mock Start-Service { }
    foreach ($o in @(@{ status = 'Running' }, @{ startMode = 'Manual' }, @{ startMode = 'Disabled' }, @{ stopFile = $true }, @{ s1DaemonPid = 29500 }, @{ exists = $false })) {
      $script:Over = $o
      Mock Read-EgptServiceFacts { New-Facts $script:Over }
      Invoke-EgptDaemonPart
    }
    Assert-MockCalled Start-Service -Times 0 -Exactly -Scope It
    Assert-MockCalled Say -Times 0 -Exactly -Scope It
  }
  It '-WhatIf: says it, starts nothing' {
    Mock Say { }
    Mock Start-Service { }
    Mock Read-EgptServiceFacts { New-Facts }
    $WhatIf = $true
    Invoke-EgptDaemonPart
    Assert-MockCalled Say -Times 1 -Exactly -Scope It
    Assert-MockCalled Start-Service -Times 0 -Exactly -Scope It
  }
}

Describe 'Invoke-BeeperPart - the normal pass starts only a service that shares the window profile' {
  $dollyAp = '--user-data-dir="C:\Users\an\.egpt\state\an-beeper" --disable-gpu --disable-gpu-compositing'
  $hook = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\Users\an\bin\egpt\setup\s0-identity-reconcile.ps1" -PreStart -LogPath "C:\Users\an\.egpt\config\logs\s0-identity.log"'
  $reveAp = Get-BeeperServiceArgLine (Get-BeeperDefaultProfile $env:APPDATA)
  function Use-Service([string] $Ap, [string] $Hook, [string] $Status = 'Stopped', [bool] $Claimed = $false) {
    $script:Ap = $Ap; $script:Hook = $Hook; $script:Status = $Status; $script:Claimed = $Claimed
    Mock Get-ItemProperty { [pscustomobject]@{ AppParameters = $script:Ap } }
    Mock Get-BeeperPreStartHook { $script:Hook }
    Mock Test-BeeperClaimHeld { $script:Claimed }
    Mock Test-BeeperProfileInUse { $false }
    Mock Get-CimInstance { @() }
    Mock Get-Service { [pscustomobject]@{ Status = $script:Status } }
    Mock Start-Service { }
    Mock Say { }
    Mock Write-Host { }
  }
  It 'dolly unconverted (its own --user-data-dir, no hook): left alone, one console line, nothing in the log' {
    Use-Service $dollyAp ''
    Invoke-BeeperPart | Should Be 0
    Assert-MockCalled Start-Service -Times 0 -Exactly -Scope It
    Assert-MockCalled Test-BeeperClaimHeld -Times 0 -Exactly -Scope It
    Assert-MockCalled Say -Times 0 -Exactly -Scope It
    Assert-MockCalled Write-Host -Times 1 -Exactly -Scope It
  }
  It 'dolly converted (its own --user-data-dir behind the Start/Pre hook): started when Stopped and unclaimed' {
    Use-Service $dollyAp $hook
    Invoke-BeeperPart | Should Be 0
    Assert-MockCalled Start-Service -Times 1 -Exactly -Scope It -ParameterFilter { $Name -eq 'egpt-beeper-primary' }
  }
  It 'dolly converted: left alone while Session 1 claims the profile' {
    Use-Service $dollyAp $hook 'Stopped' $true
    Invoke-BeeperPart | Should Be 0
    Assert-MockCalled Start-Service -Times 0 -Exactly -Scope It
  }
  It 'reve (the window default profile): unchanged - started when Stopped and unclaimed, hook or not' {
    Use-Service $reveAp ''
    Invoke-BeeperPart | Should Be 0
    Assert-MockCalled Start-Service -Times 1 -Exactly -Scope It
  }
  It 'reve: a Running service is left alone' {
    Use-Service $reveAp $hook 'Running'
    Invoke-BeeperPart | Should Be 0
    Assert-MockCalled Start-Service -Times 0 -Exactly -Scope It
  }
  It 'no --user-data-dir at all: left alone' {
    Use-Service '--disable-gpu' ''
    Invoke-BeeperPart | Should Be 0
    Assert-MockCalled Start-Service -Times 0 -Exactly -Scope It
  }
  It '-PreStart is unchanged: it never reads the hook, refuses while claimed, and passes a service with no --user-data-dir' {
    $PreStart = $true
    Use-Service $dollyAp '' 'Stopped' $true
    Invoke-BeeperPart | Should Be 99
    Use-Service $dollyAp '' 'Stopped' $false
    Invoke-BeeperPart | Should Be 0
    Use-Service '--disable-gpu' ''
    Invoke-BeeperPart | Should Be 0
    Assert-MockCalled Get-BeeperPreStartHook -Times 0 -Exactly -Scope It
    Assert-MockCalled Start-Service -Times 0 -Exactly -Scope It
  }
}

Describe 'the pass and the hook' {
  $src = (Get-Content (Join-Path $PSScriptRoot 's0-identity-reconcile.ps1')) | Where-Object { $_ -notmatch '^\s*#' }
  It '-PreStart stays the Beeper hook only: it exits with the Beeper part and never reaches the pass' {
    $code = $src -join "`n"
    $code | Should Match 'exit \(Invoke-BeeperPart\)'
    $code.IndexOf('exit (Invoke-BeeperPart)') | Should BeLessThan $code.IndexOf('if (Invoke-ReconcilePass)')
  }
}
