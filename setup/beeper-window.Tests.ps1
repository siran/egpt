# Unit coverage for setup\beeper-window.ps1's decisions (loaded with -LoadFunctionsOnly; nothing
# runs, no service or Beeper is touched).
#   Invoke-Pester -Script setup\beeper-window.Tests.ps1      (Pester 3.4: `Should Be`)
# ASCII ONLY.

. (Join-Path $PSScriptRoot 'beeper-window.ps1') -LoadFunctionsOnly

Describe 'Get-BeeperWindowPlan' {
  It 'no shared service (the baseline): just open Beeper' {
    (Get-BeeperWindowPlan $false $false '' $false) -join ',' | Should Be 'open'
  }
  It 'logon: stop the service, wait for its Beeper to let go, open the window, watch' {
    (Get-BeeperWindowPlan $true $true 'Running' $false) -join ',' | Should Be 'stop-service,wait-release,open,watch'
  }
  It 'the service already stopped: open and watch; a window already open: only watch' {
    (Get-BeeperWindowPlan $true $true 'Stopped' $false) -join ',' | Should Be 'open,watch'
    (Get-BeeperWindowPlan $true $true 'Stopped' $true) -join ',' | Should Be 'watch'
  }
  It 'another launcher owns the profile: surface its window, or do nothing mid-handover' {
    (Get-BeeperWindowPlan $true $false 'Stopped' $true) -join ',' | Should Be 'show'
    @(Get-BeeperWindowPlan $true $false 'Running' $false).Count | Should Be 0
  }
  It 'never opens the window without stopping a service that is not Stopped' {
    foreach ($st in 'Running', 'StartPending', 'StopPending') {
      $p = @(Get-BeeperWindowPlan $true $true $st $false)
      [array]::IndexOf($p, 'stop-service') | Should BeLessThan ([array]::IndexOf($p, 'open'))
      $p -contains 'wait-release' | Should Be $true
    }
  }
}

Describe 'Get-BeeperWatchCount' {
  It 'Beeper exits after two empty polls; a hidden window, an update or the installer resets it' {
    Get-BeeperWatchCount $false $false 0 | Should Be 1
    Get-BeeperWatchCount $false $false 1 | Should Be 2
    Get-BeeperWatchCount $true $false 1 | Should Be 0
    Get-BeeperWatchCount $false $true 1 | Should Be 0
  }
}
