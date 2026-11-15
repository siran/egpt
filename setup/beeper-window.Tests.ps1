# Unit coverage for setup\beeper-window.ps1's decisions (loaded with -LoadFunctionsOnly; nothing
# runs, no service or Beeper is touched).
#   Invoke-Pester -Script setup\beeper-window.Tests.ps1      (Pester 3.4: `Should Be`)
# ASCII ONLY.

. (Join-Path $PSScriptRoot 'beeper-window.ps1') -LoadFunctionsOnly

Describe 'Get-BeeperWindowPlan' {
  It 'no shared service (the baseline): just open Beeper' {
    (Get-BeeperWindowPlan $false $false '' $false) -join ',' | Should Be 'open'
  }
  It 'the service holds the profile (dolly 2026-11-15, S1 live): stop it, wait for its Beeper to let go, open the window' {
    (Get-BeeperWindowPlan $true $true 'Running' $false) -join ',' | Should Be 'stop-service,wait-release,open'
  }
  It 'no window (logon, a tray Quit, a crash): wait for the profile, open it; a window already open: nothing' {
    (Get-BeeperWindowPlan $true $true 'Stopped' $false) -join ',' | Should Be 'wait-release,open'
    @(Get-BeeperWindowPlan $true $true 'Stopped' $true).Count | Should Be 0
  }
  It 'an update needs Beeper closed: nothing, shared or not' {
    @(Get-BeeperWindowPlan $true $true 'Stopped' $false $true).Count | Should Be 0
    @(Get-BeeperWindowPlan $true $true 'Running' $false $true).Count | Should Be 0
    @(Get-BeeperWindowPlan $false $false '' $false $true).Count | Should Be 0
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
  It 'dolly as it is (forward slashes, unquoted): the an-beeper profile; the default-profile Beeper there is not it' {
    $o = Get-BeeperWindowOpen $true '--user-data-dir=C:/Users/user/.egpt/state/an-beeper/userdata --disable-gpu --disable-gpu-compositing' $appData
    $o.profile | Should Be 'C:/Users/user/.egpt/state/an-beeper/userdata'
    $o.args | Should Be '--user-data-dir="C:/Users/user/.egpt/state/an-beeper/userdata"'
    $stray = [pscustomobject]@{ Name = 'Beeper.exe'; CommandLine = '"C:\Users\user\AppData\Local\Programs\BeeperTexts\Beeper.exe" ' }
    @(Select-BeeperProfileProcesses @($stray) $o.profile).Count | Should Be 0
  }
  It 'not shared (the baseline, or dolly before its conversion): the user''s default profile, never the service''s own' {
    $o = Get-BeeperWindowOpen $false '--user-data-dir=C:\Users\user\.egpt\state\an-beeper --disable-gpu' $appData
    $o.profile | Should Be 'C:\Users\user\AppData\Roaming\BeeperTexts'
    $o.args | Should Be ''
    (Get-BeeperWindowOpen $false '' $appData).args | Should Be ''
  }
}

# Invoke-BeeperWindow: one pass. -Once is the Session 1 egpt daemon's (it holds state\s1.claim and
# runs a pass every few seconds); without it, the "Beeper (eGPT)" shortcut. Nothing here loops.
Describe 'Invoke-BeeperWindow - the Session 1 daemon keeps the window open' {
  function Test-WindowUp { }
  function Open-Window { }
  function Say($m) { }
  function Get-Token { }
  $EgptHome = 'C:\h\.egpt'
  $ServiceName = 'egpt-beeper-primary'
  $profileDir = 'C:/Users/user/.egpt/state/an-beeper/userdata'
  $claimPath = Get-BeeperClaimPath $profileDir
  $WaitSec = 60
  $DryRun = $false
  function Use-Node([string] $Status = 'Stopped', [bool] $Up = $false, [bool] $Update = $false, [bool] $S1Claim = $false, [bool] $ClaimFree = $true) {
    $script:Status = $Status; $script:Up = $Up; $script:Update = $Update
    $script:S1Claim = $S1Claim; $script:ClaimFree = $ClaimFree
    $script:disposed = 0
    Mock Test-WindowUp { $script:Up }
    Mock Test-UpdateRunning { $script:Update }
    Mock Test-BeeperClaimHeld { $script:S1Claim } -ParameterFilter { $Path -eq 'C:\h\.egpt\state\s1.claim' }
    Mock Test-BeeperClaimHeld { -not $script:ClaimFree } -ParameterFilter { $Path -ne 'C:\h\.egpt\state\s1.claim' }
    Mock Open-BeeperClaim { if ($script:ClaimFree) { New-Object psobject | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:disposed++ } -PassThru } }
    Mock Get-Service { New-Object psobject -Property @{ Status = $script:Status } | Add-Member -MemberType ScriptMethod -Name WaitForStatus -Value { } -PassThru }
    Mock Stop-Service { $script:Status = 'Stopped' }
    Mock Start-Service { }
    Mock Test-BeeperLockHeld { $false }
    Mock Start-Sleep { }
    Mock Open-Window { }
    Mock Enter-EgptBeeperHold { $false }
    Mock Exit-EgptBeeperHold { }
    Mock Say { }
  }
  It 'S1 live, no window: the pass opens it on the shared profile and lets go of the claim' {
    Use-Node
    $Once = $true; $shared = $true
    Invoke-BeeperWindow | Should Be 0
    Assert-MockCalled Open-Window -Times 1 -Exactly -Scope It
    Assert-MockCalled Stop-Service -Times 0 -Exactly -Scope It
    $script:disposed | Should Be 1
  }
  It 'the window exited (tray Quit, a crash, Beeper''s own update): the next pass reopens it' {
    Use-Node -Up $true
    $Once = $true; $shared = $true
    Invoke-BeeperWindow | Should Be 0
    $script:Up = $false
    Invoke-BeeperWindow | Should Be 0
    Assert-MockCalled Open-Window -Times 1 -Exactly -Scope It
  }
  It 'dolly 2026-11-15: S1 live but egpt-beeper-primary holds the profile - taken over: stop, wait, open' {
    Use-Node 'Running'
    $Once = $true; $shared = $true
    Invoke-BeeperWindow | Should Be 0
    Assert-MockCalled Stop-Service -Times 1 -Exactly -Scope It -ParameterFilter { $Name -eq 'egpt-beeper-primary' }
    Assert-MockCalled Open-Window -Times 1 -Exactly -Scope It
    Assert-MockCalled Start-Service -Times 0 -Exactly -Scope It
  }
  It 'the service''s Beeper never lets go: the window is not opened, the pass fails loudly, Beeper is never killed' {
    Use-Node 'Running'
    Mock Test-BeeperLockHeld { $true }
    $Once = $true; $shared = $true; $WaitSec = 0
    Invoke-BeeperWindow | Should Be 1
    Assert-MockCalled Open-Window -Times 0 -Exactly -Scope It
    Assert-MockCalled Say -Scope It -ParameterFilter { $m -match '^FAILED' }
  }
  It 'an update needs Beeper closed: the pass waits - nothing stopped, nothing opened' {
    Use-Node 'Running' -Update $true
    $Once = $true; $shared = $true
    Invoke-BeeperWindow | Should Be 0
    Assert-MockCalled Stop-Service -Times 0 -Exactly -Scope It
    Assert-MockCalled Open-Window -Times 0 -Exactly -Scope It
  }
  It 'another launcher holds the profile''s claim (the update installing, a shortcut mid-handover): nothing, never a show' {
    Use-Node -Up $true -ClaimFree $false
    $Once = $true; $shared = $true
    Invoke-BeeperWindow | Should Be 0
    Assert-MockCalled Open-Window -Times 0 -Exactly -Scope It
  }
  It 'no service shares the profile: the daemon''s pass leaves Beeper alone' {
    Use-Node
    $Once = $true; $shared = $false
    Invoke-BeeperWindow | Should Be 0
    Assert-MockCalled Open-Window -Times 0 -Exactly -Scope It
    Assert-MockCalled Open-BeeperClaim -Times 0 -Exactly -Scope It
  }
  It 'the shortcut while the S1 daemon holds s1.claim: surfaces an open window, never claims, stops or watches' {
    Use-Node 'Running' -Up $true -S1Claim $true
    $Once = $false; $shared = $true
    Invoke-BeeperWindow | Should Be 0
    Assert-MockCalled Open-Window -Times 1 -Exactly -Scope It
    Assert-MockCalled Open-BeeperClaim -Times 0 -Exactly -Scope It
    Assert-MockCalled Stop-Service -Times 0 -Exactly -Scope It
  }
  It 'the shortcut while the S1 daemon holds s1.claim and no window is up: nothing (the daemon opens it)' {
    Use-Node -S1Claim $true
    $Once = $false; $shared = $true
    Invoke-BeeperWindow | Should Be 0
    Assert-MockCalled Open-Window -Times 0 -Exactly -Scope It
    Assert-MockCalled Stop-Service -Times 0 -Exactly -Scope It
  }
  It 'the shortcut with no S1 daemon: the handover once, then it returns (no watcher)' {
    Use-Node 'Running'
    $Once = $false; $shared = $true
    Invoke-BeeperWindow | Should Be 0
    Assert-MockCalled Stop-Service -Times 1 -Exactly -Scope It
    Assert-MockCalled Open-Window -Times 1 -Exactly -Scope It
    $script:disposed | Should Be 1
  }
}

Describe 'beeper-window.ps1 has no watcher left' {
  $code = ((Get-Content (Join-Path $PSScriptRoot 'beeper-window.ps1')) | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
  It 'no loop and no fallback to the service' {
    $code | Should Not Match 'while \(\$true\)'
    $code | Should Not Match 'Start-Service'
    $code | Should Not Match 'Watch-BeeperWindow'
  }
}

# Test-UpdateRunning: what keeps the daemon's pass from reopening Beeper.
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
  It 'dolly 2026-11-15: the update handed the window back and waits for its connection - not running, the daemon''s pass reopens it' {
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
