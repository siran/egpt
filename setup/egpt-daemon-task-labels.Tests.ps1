# Unit coverage for setup\egpt-daemon-task-labels.ps1 - the ONE place that says how the session 1
# logon task describes itself, and the two consumers that must take it from there:
# register-session1-daemon-task.ps1 (a fresh node) and migrations\0005 (a node registered before).
#
# WHAT THIS CAN AND CANNOT PROVE. The module is pure string work and unit-tests completely. The
# registrar is exercised for real in -DryRun against a throwaway profile folder: that reads Task
# Scheduler and HKLM for a task and a service that do not exist, and registers nothing. What it does
# NOT prove is Register-ScheduledTask itself - where Task Scheduler puts the Description in the
# exported XML was measured on a throwaway task, and tests\migrations-0005-* holds that shape.
#
# NOT part of vitest -- `npm test` never runs a .ps1. Run it by hand:
#   Invoke-Pester -Script setup\egpt-daemon-task-labels.Tests.ps1
# (Pester 3.4.0, the version Windows ships, hence `Should Be` and not `Should -Be`.)
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).

. (Join-Path $PSScriptRoot 'egpt-daemon-task-labels.ps1')

$script:SetupDir = $PSScriptRoot
$script:RepoDir  = Split-Path -Parent $PSScriptRoot

Describe 'Get-EgptDaemonTaskDescription' {
  It 'is the one line both nodes get for egpt-daemon' {
    Get-EgptDaemonTaskDescription -Name 'egpt-daemon' | Should Be 'eGPT spine supervisor (egpt-daemon.mjs) in session 1, started at logon. Disable it and the spine stays in session 0 (the egpt-daemon service), where any browser it starts is invisible.'
  }
  It 'names the service of its own name, so a second profile does not point at the first' {
    Get-EgptDaemonTaskDescription -Name 'egpt-secondary-daemon' | Should Match '\(the egpt-secondary-daemon service\)'
  }
  It 'is one line with no XML metacharacters - migrations\0005 writes it into the XML verbatim' {
    $d = Get-EgptDaemonTaskDescription -Name 'egpt-daemon'
    $d -match "[\r\n]" | Should Be $false
    $d -match "[<>&`"']" | Should Be $false
  }
  It 'opens in the voice of the service Description install-nssm-service.ps1 stamps' {
    $installer = Get-Content (Join-Path $script:SetupDir 'install-nssm-service.ps1') -Raw
    $installer | Should Match ([regex]::Escape('"eGPT spine supervisor (egpt-daemon.mjs) for profile(s)'))
    (Get-EgptDaemonTaskDescription -Name 'egpt-daemon').StartsWith('eGPT spine supervisor (egpt-daemon.mjs) ') | Should Be $true
  }
  It 'says what disabling it costs' {
    Get-EgptDaemonTaskDescription -Name 'egpt-daemon' | Should Match 'Disable it and the spine stays in session 0'
  }
}

Describe 'the registrar and migrations\0005 take it from this module' {
  $script:RegistrarSrc = Get-Content (Join-Path $script:SetupDir 'register-session1-daemon-task.ps1') -Raw

  It 'register-session1-daemon-task.ps1 dot-sources the module and registers with its text' {
    $script:RegistrarSrc | Should Match ([regex]::Escape(". (Join-Path `$PSScriptRoot 'egpt-daemon-task-labels.ps1')"))
    $script:RegistrarSrc | Should Match ([regex]::Escape('$Description = Get-EgptDaemonTaskDescription -Name $TaskName'))
    $script:RegistrarSrc | Should Match '-Description \$Description -Force'
  }
  It 'the registrar hardcodes no Description beside the module' {
    $script:RegistrarSrc | Should Not Match "-Description\s+['`"]"
  }
  It 'migrations\0005 dot-sources the same module in its probe' {
    $src = Get-Content (Join-Path $script:RepoDir 'migrations\0005-daemon-task-has-description.mjs') -Raw
    $src | Should Match ([regex]::Escape("'egpt-daemon-task-labels.ps1'"))
    $src | Should Match ([regex]::Escape('Get-EgptDaemonTaskDescription -Name $name'))
  }
  It 'the registrar, run with -DryRun, would register exactly the module text for its derived task name' {
    $profileDir = Join-Path $TestDrive '.egpt-pestertest'
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    # Each Write-Host line as its own string: Out-String would wrap them at the console width.
    $out = (& (Join-Path $script:SetupDir 'register-session1-daemon-task.ps1') -EgptHome $profileDir -DryRun 6>&1 | ForEach-Object { "$_" }) -join "`n"
    $out | Should Match ([regex]::Escape('[dry run] would CREATE the task ''egpt-pestertest-daemon'''))
    $out | Should Match ([regex]::Escape('[dry run]   describe  : ' + (Get-EgptDaemonTaskDescription -Name 'egpt-pestertest-daemon')))
  }
}
