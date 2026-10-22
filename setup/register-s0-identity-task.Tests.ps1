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
  It 'the registration uses that principal, and nothing names SYSTEM or Highest' {
    $code = (Get-Content (Join-Path $PSScriptRoot 'register-s0-identity-task.ps1')) | Where-Object { $_ -notmatch '^\s*#' }
    ($code -join "`n") | Should Match '-Principal \(Get-S0IdentityTaskPrincipal \$UserId\)'
    ($code -join "`n") | Should Not Match "-User 'SYSTEM'|-RunLevel Highest|RepetitionDuration"
  }
}
