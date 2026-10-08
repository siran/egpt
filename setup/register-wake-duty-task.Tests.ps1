# Unit coverage for setup\register-wake-duty-task.ps1.
#
# NOTHING IN HERE TOUCHES THE OS. No task is registered, inspected or removed, and nothing
# needs elevation. The registrar is dot-sourced with -LoadFunctionsOnly (the same trick
# provision-service-account.Tests.ps1 uses), which defines Get-WakeDutyTaskDefinition and
# returns before any Register/Unregister. That function builds the action, trigger, principal
# and settings with the New-ScheduledTask* cmdlets - every one of which builds an IN-MEMORY
# CIM object and touches no Task Scheduler state - so the test can assert the exact shape the
# registrar would send to Windows without sending it.
#
# WHAT THIS CANNOT COVER, and no in-process test can: that Register-ScheduledTask accepts this
# definition, that WakeToRun actually arms a wake timer on the host, and that a sleeping
# machine comes up for the trigger. Those are a real registration plus watching the log wake.
#
# NOT part of vitest -- `npm test` never runs a .ps1. Run it by hand:
#   Invoke-Pester -Script setup\register-wake-duty-task.Tests.ps1
# (Pester 3.4.0, the version Windows ships, hence `Should Be` and not `Should -Be`.)
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).

. (Join-Path $PSScriptRoot 'register-wake-duty-task.ps1') -LoadFunctionsOnly

$script:SetupDir      = $PSScriptRoot
$script:RegistrarPath = Join-Path $PSScriptRoot 'register-wake-duty-task.ps1'
$script:FakeVbs       = 'C:\deployed\bin\egpt\setup\egpt-wake-duty.vbs'

Describe 'Get-WakeDutyTaskDefinition (the exact shape the registrar sends to Windows)' {
  $script:Def = Get-WakeDutyTaskDefinition -VbsPath $script:FakeVbs

  It 'WakeToRun is on - the whole point of the duty' {
    $script:Def.Settings.WakeToRun | Should Be $true
  }

  It 'repeats every 30 minutes' {
    $script:Def.Trigger.Repetition.Interval | Should Be 'PT30M'
  }

  It 'repeats INDEFINITELY - an empty Duration is Task Scheduler for "forever"' {
    [string]$script:Def.Trigger.Repetition.Duration | Should Be ''
  }

  It 'honours a non-default repeat interval' {
    $d = Get-WakeDutyTaskDefinition -VbsPath $script:FakeVbs -RepeatMinutes 10
    $d.Trigger.Repetition.Interval | Should Be 'PT10M'
  }

  It 'is AC-ONLY: DisallowStartIfOnBatteries and StopIfGoingOnBatteries are both true' {
    $script:Def.Settings.DisallowStartIfOnBatteries | Should Be $true
    $script:Def.Settings.StopIfGoingOnBatteries | Should Be $true
  }

  It 'has NO execution time limit (PT0S) - the script self-limits, the scheduler must not' {
    $script:Def.Settings.ExecutionTimeLimit | Should Be 'PT0S'
  }

  It 'starts when available, so a missed wake is caught at the next opportunity' {
    $script:Def.Settings.StartWhenAvailable | Should Be $true
  }

  It 'runs as an interactive, non-elevated task' {
    "$($script:Def.Principal.LogonType)" | Should Be 'Interactive'
    "$($script:Def.Principal.RunLevel)" | Should Be 'Limited'
  }

  It 'the action is wscript.exe //B //Nologo <the egpt-wake-duty.vbs it was handed>' {
    $script:Def.Action.Execute | Should Match 'wscript\.exe$'
    $script:Def.Arguments | Should Match '^//B //Nologo '
    # Quoted and ending in the vbs it was given - so a deployed registrar points at the
    # deployed vbs, never at a hardcoded node path.
    $script:Def.Action.Arguments.TrimEnd('"').EndsWith('egpt-wake-duty.vbs') | Should Be $true
    $script:Def.Action.Arguments | Should Match ([regex]::Escape($script:FakeVbs))
  }
}

Describe 'Get-WakeUpConfig (config-driven cadence + enable flag, parsed from text, no profile)' {
  It 'frequency_minutes: 15 yields a 15-minute definition (fed into Get-WakeDutyTaskDefinition)' {
    $cfg = @('node_name: kg', 'wake_up:', '  enabled: true', '  frequency_minutes: 15', 'user_name: "x"') -join "`n"
    $w = Get-WakeUpConfig -Text $cfg
    $w.FrequencyMinutes | Should Be 15
    $w.Enabled | Should Be $true
    $d = Get-WakeDutyTaskDefinition -VbsPath $script:FakeVbs -RepeatMinutes $w.FrequencyMinutes
    $d.Trigger.Repetition.Interval | Should Be 'PT15M'
  }

  It 'enabled: false is the flag the registrar removes on (routes to removal)' {
    $cfg = @('wake_up:', '  enabled: false', '  frequency_minutes: 30') -join "`n"
    (Get-WakeUpConfig -Text $cfg).Enabled | Should Be $false
  }

  It 'an ABSENT wake_up block falls back to 30 minutes, enabled' {
    $cfg = @('node_name: kg', 'user_name: "x"') -join "`n"
    $w = Get-WakeUpConfig -Text $cfg
    $w.Enabled | Should Be $true
    $w.FrequencyMinutes | Should Be 30
  }

  It 'empty config text falls back to the defaults (30, enabled)' {
    $w = Get-WakeUpConfig -Text ''
    $w.Enabled | Should Be $true
    $w.FrequencyMinutes | Should Be 30
  }

  It 'strips the skeleton inline comment on frequency_minutes' {
    $cfg = @('wake_up:', '  enabled: true', '  frequency_minutes: 45   # egpt wakes up to check around') -join "`n"
    (Get-WakeUpConfig -Text $cfg).FrequencyMinutes | Should Be 45
  }

  It 'the block ends at the next column-0 key - a later top-level enabled: does not leak in' {
    $cfg = @('wake_up:', '  frequency_minutes: 20', 'some_other_block:', '  enabled: false') -join "`n"
    $w = Get-WakeUpConfig -Text $cfg
    $w.FrequencyMinutes | Should Be 20
    $w.Enabled | Should Be $true   # the false below belongs to some_other_block, not wake_up
  }
}

Describe 'the shape of the shipped scripts (the rules they are meant to keep)' {
  $script:RegistrarSrc = Get-Content -LiteralPath $script:RegistrarPath -Raw
  $script:VbsSrc       = Get-Content -LiteralPath (Join-Path $script:SetupDir 'egpt-wake-duty.vbs') -Raw
  $script:DutySrc      = Get-Content -LiteralPath (Join-Path $script:SetupDir 'egpt-wake-duty.ps1') -Raw

  It 'is dot-sourceable with -LoadFunctionsOnly without registering anything' {
    (Get-Command Get-WakeDutyTaskDefinition -ErrorAction SilentlyContinue) | Should Not Be $null
  }

  It 'resolves the vbs from $PSScriptRoot, so a deployed copy is self-locating' {
    $script:RegistrarSrc | Should Match ([regex]::Escape("Join-Path `$PSScriptRoot 'egpt-wake-duty.vbs'"))
  }

  It 'registers idempotently with -Force and -ErrorAction Stop' {
    $script:RegistrarSrc | Should Match 'Register-ScheduledTask'
    $script:RegistrarSrc | Should Match '-Force -ErrorAction Stop'
  }

  It 'reads wake_up from the live profile config and routes removal when disabled' {
    $script:RegistrarSrc | Should Match 'Get-WakeUpConfig'
    $script:RegistrarSrc | Should Match ([regex]::Escape('.egpt\config\config.yaml'))
    $script:RegistrarSrc | Should Match '\$removeBecauseDisabled'
  }

  It 'keeps -RepeatMinutes as an explicit override of the configured frequency' {
    $script:RegistrarSrc | Should Match ([regex]::Escape("PSBoundParameters.ContainsKey('RepeatMinutes')"))
  }

  It 'does NOT pass the battery switches on the settings line, so AC-only holds by default' {
    # Scan the actual New-ScheduledTaskSettingsSet INVOCATION, not the header comment that
    # names the two switches to explain why they are omitted.
    $settingsLine = (($script:RegistrarSrc -split "`n") | Where-Object { $_ -match 'New-ScheduledTaskSettingsSet' -and $_ -notmatch '^\s*#' }) -join "`n"
    $settingsLine | Should Match 'New-ScheduledTaskSettingsSet'
    $settingsLine | Should Not Match '-AllowStartIfOnBatteries'
    $settingsLine | Should Not Match '-DontStopIfGoingOnBatteries'
  }

  It 'the vbs is self-locating via WScript.ScriptFullName, not a hardcoded path' {
    $script:VbsSrc | Should Match 'WScript\.ScriptFullName'
    $script:VbsSrc | Should Match 'BuildPath'
    $script:VbsSrc | Should Match 'egpt-wake-duty\.ps1'
  }

  It 'the duty logs to ~\.egpt\disposable and names no node and no LAN host' {
    $script:DutySrc | Should Match ([regex]::Escape(".egpt\disposable"))
    $script:DutySrc | Should Not Match '192\.168\.'
  }
}
