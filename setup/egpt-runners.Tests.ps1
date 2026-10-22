# Unit coverage for setup\egpt-runners.ps1: the start verdict for the egpt-daemon service, the
# interactive-logon test and the pid probe. Nothing is started, stopped or written outside $TestDrive.
#   Invoke-Pester -Script setup\egpt-runners.Tests.ps1   (Pester 3.4: `Should Be`)
# ASCII ONLY.

. (Join-Path $PSScriptRoot 'egpt-runners.ps1')

function New-Facts([hashtable] $Over = @{}) {
  $f = [ordered]@{ exists = $true; status = 'Stopped'; startMode = 'Auto'; stopFile = $false; s1DaemonPid = $null; s1Claimed = $false }
  foreach ($k in $Over.Keys) { $f[$k] = $Over[$k] }
  return [pscustomobject]$f
}

Describe 'Get-EgptServiceStartVerdict' {
  It 'starts a Stopped service with no STOP file and no Session 1 daemon: it runs the node' {
    $v = Get-EgptServiceStartVerdict (New-Facts)
    $v.start | Should Be $true
    $v.reason | Should Match 'the service runs the node'
  }
  It 'starts beside a Session 1 daemon that holds s1.claim: the service holds off' {
    $v = Get-EgptServiceStartVerdict (New-Facts @{ s1DaemonPid = 4242; s1Claimed = $true })
    $v.start | Should Be $true
    $v.reason | Should Match 'pid 4242\) holds the profile'
  }
  It 'never beside a Session 1 daemon without s1.claim (older code), and says how to restart it' {
    $v = Get-EgptServiceStartVerdict (New-Facts @{ s1DaemonPid = 29500 })
    $v.start | Should Be $false
    $v.reason | Should Match 'pid 29500\) does not hold state\\s1\.claim'
    $v.reason | Should Match ([regex]::Escape('setup\stop-egpt.cmd, then setup\start-egpt.cmd (it starts this service too)'))
  }
  It 'never past a STOP file' {
    $v = Get-EgptServiceStartVerdict (New-Facts @{ stopFile = $true })
    $v.start | Should Be $false
    $v.reason | Should Match 'STOP file'
  }
  It 'leaves alone what is absent, not Stopped, or Disabled' {
    (Get-EgptServiceStartVerdict (New-Facts @{ exists = $false })).reason | Should Match 'not installed'
    (Get-EgptServiceStartVerdict (New-Facts @{ status = 'Running' })).reason | Should Be 'it is Running'
    (Get-EgptServiceStartVerdict (New-Facts @{ status = 'Start Pending' })).start | Should Be $false
    (Get-EgptServiceStartVerdict (New-Facts @{ startMode = 'Disabled' })).reason | Should Be 'it is Disabled'
  }
  It 'an operator may start a Manual one; the unattended backstop (-AutoOnly) only an Automatic one' {
    (Get-EgptServiceStartVerdict (New-Facts @{ startMode = 'Manual' })).start | Should Be $true
    $v = Get-EgptServiceStartVerdict (New-Facts @{ startMode = 'Manual' }) -AutoOnly
    $v.start | Should Be $false
    $v.reason | Should Be 'it is Manual, not Automatic'
    (Get-EgptServiceStartVerdict (New-Facts) -AutoOnly).start | Should Be $true
    (Get-EgptServiceStartVerdict (New-Facts @{ startMode = 'Disabled' }) -AutoOnly).start | Should Be $false
  }
}

Describe 'Test-EgptInteractiveLogon' {
  $s1 = [pscustomobject]@{ SessionId = 1; User = 'reve\an' }
  It 'an explorer of this user outside session 0 is a desktop logon, whatever the case of the name' {
    Test-EgptInteractiveLogon @($s1) 'REVE\an' | Should Be $true
  }
  It 'session 0 only, another user, or no explorer at all is no logon' {
    Test-EgptInteractiveLogon @([pscustomobject]@{ SessionId = 0; User = 'reve\an' }) 'reve\an' | Should Be $false
    Test-EgptInteractiveLogon @([pscustomobject]@{ SessionId = 2; User = 'reve\rodz' }) 'reve\an' | Should Be $false
    Test-EgptInteractiveLogon @() 'reve\an' | Should Be $false
    Test-EgptInteractiveLogon $null 'reve\an' | Should Be $false
  }
}

Describe 'Get-EgptLivePid' {
  $h = Join-Path $TestDrive '.egpt'
  New-Item -ItemType Directory -Path (Join-Path $h 'state') -Force | Out-Null
  It 'no file, or no pid in it: $null' {
    Get-EgptLivePid $h 'daemon-s1.pid' 'egpt-daemon.mjs' | Should BeNullOrEmpty
    Set-Content -LiteralPath (Join-Path $h 'state\daemon-s1.pid') -Value 'garbage'
    Get-EgptLivePid $h 'daemon-s1.pid' 'egpt-daemon.mjs' | Should BeNullOrEmpty
  }
  It 'a live pid counts only while its command line runs the script (pids are reused)' {
    Set-Content -LiteralPath (Join-Path $h 'state\daemon-s1.pid') -Value "$PID"
    Get-EgptLivePid $h 'daemon-s1.pid' 'egpt-daemon.mjs' | Should BeNullOrEmpty
    Get-EgptLivePid $h 'daemon-s1.pid' 'powershell' | Should Be $PID
  }
}

Describe 'Read-EgptServiceFacts' {
  It 'reads a missing service and an empty profile as nothing to start' {
    $f = Read-EgptServiceFacts 'egpt-pester-no-such-service' (Join-Path $TestDrive '.egpt-none')
    $f.exists | Should Be $false
    $f.stopFile | Should Be $false
    $f.s1Claimed | Should Be $false
    (Get-EgptServiceStartVerdict $f).start | Should Be $false
  }
}
