# Unit coverage for setup\register-s0-identity-task.ps1 (loaded with -LoadFunctionsOnly). The
# principal is an in-memory CIM object: nothing is registered.
#   Invoke-Pester -Script setup\register-s0-identity-task.Tests.ps1   (Pester 3.4: `Should Be`)
# ASCII ONLY.

. (Join-Path $PSScriptRoot 'register-s0-identity-task.ps1') -LoadFunctionsOnly

Describe 'the reconciler task principal' {
  It 'is the desktop user, S4U (logged on or not, no stored password), Limited' {
    $p = Get-S0IdentityTaskPrincipal 'reve\an'
    $p.UserId | Should Be 'reve\an'
    "$($p.LogonType)" | Should Be 'S4U'
    "$($p.RunLevel)" | Should Be 'Limited'
  }
  It 'is never SYSTEM or another built-in account: the script sits in a user-writable folder' {
    foreach ($u in 'SYSTEM', 'NT AUTHORITY\SYSTEM', 'NT AUTHORITY\LocalService', 'NT AUTHORITY\NetworkService') {
      { Get-S0IdentityTaskPrincipal $u } | Should Throw 'never runs as'
    }
  }
  It 'the registration uses that principal and those triggers, and nothing names SYSTEM or Highest' {
    $code = (Get-Content (Join-Path $PSScriptRoot 'register-s0-identity-task.ps1')) | Where-Object { $_ -notmatch '^\s*#' }
    ($code -join "`n") | Should Match '-Principal \(Get-S0IdentityTaskPrincipal \$UserId\)'
    ($code -join "`n") | Should Match '-Trigger \(Get-S0IdentityTaskTriggers \$IntervalMin\)'
    ($code -join "`n") | Should Not Match "-User 'SYSTEM'|-RunLevel Highest|RepetitionDuration"
  }
}

Describe 'the reconciler command line' {
  $p = 'C:\Users\an\bin\egpt\setup\s0-identity-reconcile.ps1'
  It 'the Beeper service and the log, as before; no -EgptHome unless given (the reconciler defaults it)' {
    Get-S0IdentityTaskArgument $p 'egpt-beeper-primary' 'C:\h\s0.log' '' | Should Be '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\Users\an\bin\egpt\setup\s0-identity-reconcile.ps1" -ServiceName egpt-beeper-primary -LogPath "C:\h\s0.log"'
  }
  It 'carries the profile whose STOP file the egpt-daemon part honours' {
    Get-S0IdentityTaskArgument $p 'egpt-beeper-primary' '' 'C:\Users\an\.egpt' | Should Match ' -EgptHome "C:\\Users\\an\\\.egpt"$'
  }
  It 'the registration uses it' {
    $code = (Get-Content (Join-Path $PSScriptRoot 'register-s0-identity-task.ps1')) | Where-Object { $_ -notmatch '^\s*#' }
    ($code -join "`n") | Should Match '-Argument \(Get-S0IdentityTaskArgument \$ScriptPath \$ServiceName \$LogPath \$EgptHome\)'
  }
}

Describe 'the reconciler task triggers' {
  $at = Get-Date '2026-10-22T01:20:00'
  $t = @(Get-S0IdentityTaskTriggers 2 $at)
  It 'a time trigger from now, repeating every 2 min with no end, and AtStartup' {
    $t.Count | Should Be 2
    $t[0].CimClass.CimClassName | Should Be 'MSFT_TaskTimeTrigger'
    $t[0].Repetition.Interval | Should Be 'PT2M'
    [string]$t[0].Repetition.Duration | Should BeNullOrEmpty
    ([datetime]$t[0].StartBoundary) | Should Be $at
    $t[1].CimClass.CimClassName | Should Be 'MSFT_TaskBootTrigger'
  }
  It 'another cadence is that interval' {
    (@(Get-S0IdentityTaskTriggers 5 $at))[0].Repetition.Interval | Should Be 'PT5M'
  }
}
