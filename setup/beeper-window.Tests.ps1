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

Describe 'Get-BeeperWindowOpen - where the window opens' {
  $appData = 'C:\Users\user\AppData\Roaming'
  It 'reve (the service shares the default profile): that profile, no --user-data-dir' {
    $o = Get-BeeperWindowOpen $true '--user-data-dir="C:\Users\user\AppData\Roaming\BeeperTexts" --disable-gpu' $appData
    $o.profile | Should Be 'C:\Users\user\AppData\Roaming\BeeperTexts'
    $o.args | Should Be ''
  }
  It 'dolly (the service shares its own profile): that profile, with --user-data-dir' {
    $o = Get-BeeperWindowOpen $true '--user-data-dir=C:\Users\user\.egpt\state\an-beeper --disable-gpu' $appData
    $o.profile | Should Be 'C:\Users\user\.egpt\state\an-beeper'
    $o.args | Should Be '--user-data-dir="C:\Users\user\.egpt\state\an-beeper"'
  }
  It 'not shared (the baseline, or dolly before its conversion): the user''s default profile, never the service''s own' {
    $o = Get-BeeperWindowOpen $false '--user-data-dir=C:\Users\user\.egpt\state\an-beeper --disable-gpu' $appData
    $o.profile | Should Be 'C:\Users\user\AppData\Roaming\BeeperTexts'
    $o.args | Should Be ''
    (Get-BeeperWindowOpen $false '' $appData).args | Should Be ''
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

# Watch-BeeperWindow on a scripted timeline: one entry per poll, $true = Beeper up. Open-Window
# brings it up unless $script:OpenFails. The loop never ends on its own while the operator is
# logged in: the test ends it after the timeline.
Describe 'Watch-BeeperWindow - while the operator is logged in the window is supervised' {
  function Test-WindowUp { }
  function Open-Window { }
  function Say($m) { }
  function Get-Token { }
  function Use-Timeline([bool[]] $Up, [bool[]] $Update = @(), [switch] $OpenFails, [int] $Polls = 30) {
    $script:Up = $Up; $script:Update = $Update; $script:OpenFails = [bool]$OpenFails; $script:Polls = $Polls
    $script:poll = 0; $script:opened = $false; $script:openedAt = @(); $script:disposed = $false
    Mock Start-Sleep { $script:poll++; if ($script:poll -gt $script:Polls) { throw 'end of timeline' } }
    Mock Test-WindowUp { if ($script:poll -le $script:Up.Count) { $script:Up[$script:poll - 1] } else { $script:opened -and -not $script:OpenFails } }
    Mock Test-UpdateRunning { $script:poll -le $script:Update.Count -and $script:Update[$script:poll - 1] }
    Mock Test-BeeperLockHeld { $false }
    Mock Open-Window { $script:opened = $true; $script:openedAt += $script:poll }
    Mock Enter-EgptBeeperHold { $false }
    Mock Exit-EgptBeeperHold { }
    Mock Start-Service { }
    Mock Say { }
  }
  $claim = New-Object psobject | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:disposed = $true } -PassThru
  $profileDir = 'C:\Users\user\AppData\Roaming\BeeperTexts'

  It '(a) Beeper exits (tray Quit, a crash): the window is reopened, the claim kept, the service never started' {
    Use-Timeline @($true, $true, $false, $false)
    try { Watch-BeeperWindow } catch { }
    Assert-MockCalled Open-Window -Times 1 -Exactly -Scope It
    Assert-MockCalled Start-Service -Times 0 -Exactly -Scope It
    $script:disposed | Should Be $false
  }
  It '(b) an update (beeper-update or Beeper''s own installer) with the window down is not an exit; the window reopens after it' {
    Use-Timeline @($true, $false, $false, $false, $false, $false, $false, $false) @($false, $true, $true, $true, $true, $true)
    try { Watch-BeeperWindow } catch { }
    Assert-MockCalled Start-Service -Times 0 -Exactly -Scope It
    Assert-MockCalled Open-Window -Times 1 -Exactly -Scope It
    $script:openedAt[0] | Should BeGreaterThan 6
  }
  It 'kg 2026-11-14 20:31: the watch starts after Beeper''s own installer already ended - reopen, not the service' {
    Use-Timeline @($false, $false)
    try { Watch-BeeperWindow } catch { }
    Assert-MockCalled Open-Window -Times 1 -Exactly -Scope It
    Assert-MockCalled Start-Service -Times 0 -Exactly -Scope It
  }
  It 'a window that cannot be started: the service takes the profile after a few tries, said loudly' {
    Use-Timeline @($false, $false) -OpenFails
    try { Watch-BeeperWindow } catch { }
    Assert-MockCalled Open-Window -Times 3 -Exactly -Scope It
    Assert-MockCalled Start-Service -Times 1 -Exactly -Scope It -ParameterFilter { $Name -eq 'egpt-beeper-primary' }
    Assert-MockCalled Say -Scope It -ParameterFilter { $m -match '^FAILED' }
    $script:disposed | Should Be $true
  }
  It 'a window that comes back resets the tries' {
    Use-Timeline @($false, $false, $false, $false, $true, $false, $false, $false, $false, $true, $false, $false, $false, $false) -OpenFails -Polls 14
    try { Watch-BeeperWindow } catch { }
    Assert-MockCalled Start-Service -Times 0 -Exactly -Scope It
  }
}

# Test-UpdateRunning: what keeps the watcher from reopening Beeper.
Describe 'Test-UpdateRunning - Beeper must stay closed only while an update needs it closed' {
  $home_ = Join-Path ([IO.Path]::GetTempPath()) ('bw-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Force -Path (Join-Path $home_ 'config\logs') | Out-Null
  $EgptHome = $home_
  $LocalAppData = Join-Path $home_ 'local'
  $session = 1
  $log = Join-Path $home_ 'config\logs\beeper-update.log'
  $tool = [pscustomobject]@{ Name = 'powershell.exe'; ExecutablePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'; CommandLine = 'powershell.exe -File C:\Users\user\bin\egpt\src\tools\beeper-update.ps1 -NoElevate' }
  $installer = [pscustomobject]@{ Name = 'Beeper x64 4.3.308.exe'; ExecutablePath = (Join-Path $LocalAppData 'beepertexts-updater\pending\Beeper x64 4.3.308.exe'); CommandLine = '' }
  function Use-Facts($Procs, [bool] $Locked, [string[]] $LogLines, [int] $AgeSec = 5) {
    $script:Procs = $Procs; $script:Locked = $Locked
    Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue
    if ($LogLines) { Set-Content -LiteralPath $log -Value $LogLines; (Get-Item -LiteralPath $log).LastWriteTime = (Get-Date).AddSeconds(-$AgeSec) }
    Mock Get-CimInstance { $script:Procs }
    Mock Test-BeeperClaimHeld { $script:Locked }
  }

  It 'the update in its closed phase (close the app, stop, install): running' {
    Use-Facts @($tool) $true @('[beeper-update] stopping egpt-beeper-secondary')
    Test-UpdateRunning | Should Be $true
  }
  It 'between /update beeper''s two runs (the close-app run ended with quit:true): running' {
    Use-Facts @() $false @('[beeper-update] closing the Beeper app (waiting up to 30s)', '{"ok":true,"quit":true}')
    Test-UpdateRunning | Should Be $true
  }
  It 'Beeper''s own installer: running' {
    Use-Facts @($installer) $false @()
    Test-UpdateRunning | Should Be $true
  }
  It 'dolly 2026-11-15: the update handed the window back and waits for its connection - not running, the watcher reopens it' {
    Use-Facts @($tool) $false @('[beeper-update] starting egpt-beeper-secondary', '[beeper-update] relaunching the Beeper app')
    Test-UpdateRunning | Should Be $false
  }
  It 'the update is over (its result is the last line, written seconds ago): not running' {
    Use-Facts @() $false @('[beeper-update] done', '{"ok":true,"flow":"services"}')
    Test-UpdateRunning | Should Be $false
  }
  It 'a close-app result older than a minute: not running' {
    Use-Facts @() $false @('{"ok":true,"quit":true}') 120
    Test-UpdateRunning | Should Be $false
  }
}
