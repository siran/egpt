# Unit coverage for setup\beeper-s0-naming.ps1 - the ONE place that decides what a Session 0
# Beeper service is called and how it labels itself.
#
# WHAT THIS CAN AND CANNOT PROVE. The naming module is pure string work, so it unit-tests
# honestly and completely: every branch of every function is reachable from here, and the
# old -> new map is a literal. What it does NOT prove is the rename itself - installing,
# copying a registry subtree and removing a service needs a real elevated box with a real NSSM
# service on it, and nothing here touches the SCM or HKLM. Those paths are covered by
# -WhatIf on a live node, not by Pester.
#
# NOT part of vitest -- `npm test` never runs a .ps1. Run it by hand:
#   Invoke-Pester -Script setup\beeper-s0-naming.Tests.ps1
# (Pester 3.4.0, the version Windows ships, hence `Should Be` and not `Should -Be`.)
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).

. (Join-Path $PSScriptRoot 'beeper-s0-naming.ps1')

$script:SetupDir = $PSScriptRoot

Describe 'Get-BeeperS0Role' {
  It 'reads primary off the suffix' {
    Get-BeeperS0Role 'egpt-beeper-primary' | Should Be 'primary'
  }
  It 'reads secondary off the suffix' {
    Get-BeeperS0Role 'egpt-beeper-secondary' | Should Be 'secondary'
  }
  It 'still reads a role off the retired names, so a rename can label its target' {
    Get-BeeperS0Role 'egpt-primary'   | Should Be 'primary'
    Get-BeeperS0Role 'egpt-secondary' | Should Be 'secondary'
  }
  It 'is case-insensitive, because service names are' {
    Get-BeeperS0Role 'EGPT-BEEPER-PRIMARY' | Should Be 'primary'
  }
  It 'matches the SUFFIX only - a name that merely contains the word is not a role' {
    Get-BeeperS0Role 'egpt-primary-beeper' | Should BeNullOrEmpty
    Get-BeeperS0Role 'egpt-secondary-daemon' | Should BeNullOrEmpty
  }
  It 'gives no role to the spine supervisor - it is not a Beeper at all' {
    Get-BeeperS0Role 'egpt-daemon' | Should BeNullOrEmpty
  }
  It 'gives no role to an empty name rather than throwing' {
    Get-BeeperS0Role '' | Should BeNullOrEmpty
  }
}

Describe 'Get-BeeperS0DisplayName' {
  It 'names the primary an ear, in words a human reads' {
    Get-BeeperS0DisplayName 'egpt-beeper-primary' | Should Be 'Beeper Desktop - primary account (ear)'
  }
  It 'names the secondary a mouth' {
    Get-BeeperS0DisplayName 'egpt-beeper-secondary' | Should Be 'Beeper Desktop - secondary account (mouth)'
  }
  It 'falls back to the service name for an unrecognised suffix, never to a guessed role' {
    Get-BeeperS0DisplayName 'egpt-beeper-third' | Should Be 'Beeper Desktop (Session 0) - egpt-beeper-third'
  }
  It 'always says Beeper Desktop first, so the list cannot read as a spine' {
    foreach ($n in @('egpt-beeper-primary', 'egpt-beeper-secondary', 'egpt-beeper-third')) {
      (Get-BeeperS0DisplayName $n).StartsWith('Beeper Desktop') | Should Be $true
    }
  }
}

Describe 'Get-BeeperS0Description' {
  # The operator's complaint was prose: the Services console shows ONE truncated line, so the
  # useful part was cut off. These have to be short, and the load-bearing words have to be first.
  It 'is one line - no newline can reach the registry' {
    foreach ($n in @('egpt-beeper-primary', 'egpt-beeper-secondary', 'egpt-daemon')) {
      (Get-BeeperS0Description $n) -match "[\r\n]" | Should Be $false
    }
  }
  It 'survives truncation: under 120 characters' {
    foreach ($n in @('egpt-beeper-primary', 'egpt-beeper-secondary', 'egpt-daemon')) {
      (Get-BeeperS0Description $n).Length -lt 120 | Should Be $true
    }
  }
  It 'says NOT a spine inside the first 30 characters, which is the whole point' {
    foreach ($n in @('egpt-beeper-primary', 'egpt-beeper-secondary', 'egpt-daemon')) {
      (Get-BeeperS0Description $n).Substring(0, 30) | Should Match 'NOT a spine'
    }
  }
  It 'names the account for the primary and says what stopping it costs' {
    $d = Get-BeeperS0Description 'egpt-beeper-primary'
    $d | Should Match 'PRIMARY account'
    $d | Should Match 'the ear'
    $d | Should Match 'goes offline'
  }
  It 'names the account for the secondary and says what stopping it costs' {
    $d = Get-BeeperS0Description 'egpt-beeper-secondary'
    $d | Should Match 'SECONDARY account'
    $d | Should Match 'the mouth'
    $d | Should Match 'cannot reply'
  }
  It 'is ASCII only, like the scripts that write it' {
    foreach ($n in @('egpt-beeper-primary', 'egpt-beeper-secondary', 'egpt-daemon')) {
      $d = Get-BeeperS0Description $n
      ([int[]][char[]]$d | Where-Object { $_ -gt 127 }).Count | Should Be 0
    }
  }
}

Describe 'Get-BeeperS0LegacyNameMap' {
  # The retired names are the reason this module exists: `Get-Service egpt-*` showed egpt-daemon,
  # egpt-primary and egpt-secondary, and two of those three were Beeper Desktops reading like
  # spines. This map is what lets the installer DETECT an un-migrated node and refuse.
  $map = Get-BeeperS0LegacyNameMap

  It 'maps egpt-primary to the name that says it is a Beeper' {
    $map['egpt-primary'] | Should Be 'egpt-beeper-primary'
  }
  It 'maps egpt-secondary to the name that says it is a Beeper' {
    $map['egpt-secondary'] | Should Be 'egpt-beeper-secondary'
  }
  It 'maps the account-named hand installs too - do still carries BeeperRodz' {
    # A GUESS from the account (An is the ear, Rodz the mouth). migrations\0001 takes the role
    # from each service's own CDP port and refuses when that evidence disagrees with this.
    $map['BeeperAn']   | Should Be 'egpt-beeper-primary'
    $map['BeeperRodz'] | Should Be 'egpt-beeper-secondary'
  }
  It 'lists every retired name exactly once, keyed by the exact spelling the SCM shows' {
    @($map.Keys) -join ',' | Should BeExactly 'egpt-primary,egpt-secondary,BeeperAn,BeeperRodz'
  }
  It 'does not claim egpt-daemon needs renaming - that name is accurate' {
    $map.Contains('egpt-daemon') | Should Be $false
  }
  It 'every target name carries beeper, so the two classes can never collide again' {
    foreach ($old in $map.Keys) {
      $map[$old] -like '*beeper*' | Should Be $true
      $map[$old] | Should Not Be $old
    }
  }
  It 'every target resolves to a role, so a renamed service always gets a real label' {
    foreach ($old in $map.Keys) {
      Get-BeeperS0Role $map[$old] | Should Not BeNullOrEmpty
    }
  }
}

Describe 'the scripts take their names from this module' {
  # A second copy of these strings is how a rename half-lands: the installer stamps one label and
  # the rename tool stamps another, and nobody notices until the Services list disagrees with
  # itself. Both must dot-source this file, and neither may hardcode a label.
  It 'install-beeper-s0-service.ps1 dot-sources the naming module' {
    $src = Get-Content (Join-Path $script:SetupDir 'install-beeper-s0-service.ps1') -Raw
    $src | Should Match "beeper-s0-naming\.ps1"
    $src | Should Match "Get-BeeperS0DisplayName"
    $src | Should Match "Get-BeeperS0Description"
    $src | Should Match "Get-BeeperS0LegacyNameMap"
  }
  It 'rename-beeper-s0-service.ps1 dot-sources the naming module' {
    $src = Get-Content (Join-Path $script:SetupDir 'rename-beeper-s0-service.ps1') -Raw
    $src | Should Match "beeper-s0-naming\.ps1"
    $src | Should Match "Get-BeeperS0DisplayName"
    $src | Should Match "Get-BeeperS0Description"
  }
  It 'neither script hardcodes a DisplayName literal beside the module' {
    foreach ($f in @('install-beeper-s0-service.ps1', 'rename-beeper-s0-service.ps1')) {
      $src = Get-Content (Join-Path $script:SetupDir $f) -Raw
      $src | Should Not Match 'DisplayName\s+"Beeper Desktop'
    }
  }
}

Describe 'the rename carries the whole configuration' {
  # The first version of rename-beeper-s0-service.ps1 copied a hand-picked list of nine
  # parameters and silently dropped everything else a service can carry -- Description, the
  # environment block, the exit actions, the throttle, the stop-method timeouts, the rotation
  # settings and the SCM failure actions. A hand-picked list is the bug; copying the whole
  # Parameters subtree is the fix, and these assertions are what stops it regressing to a list.
  $script:RenameSrc = Get-Content (Join-Path $PSScriptRoot 'rename-beeper-s0-service.ps1') -Raw

  It 'copies the Parameters registry subtree wholesale rather than enumerating values' {
    $script:RenameSrc | Should Match 'Copy-RegistrySubtree'
    $script:RenameSrc | Should Match 'GetSubKeyNames'
    $script:RenameSrc | Should Match 'GetValueKind'
  }
  It 'carries the service-key settings NSSM does not own, failure actions included' {
    foreach ($v in @('FailureActions', 'DelayedAutostart', 'DependOnService', 'ErrorControl')) {
      $script:RenameSrc | Should Match $v
    }
  }
  It 'keeps a REG_EXPAND_SZ unexpanded - this process env is not the service env' {
    $script:RenameSrc | Should Match 'DoNotExpandEnvironmentNames'
  }
  It 'creates the new service BEFORE removing the old one' {
    $install = $script:RenameSrc.IndexOf('nssm install $To')
    $remove  = $script:RenameSrc.IndexOf('nssm remove $From')
    $install | Should Not Be -1
    $remove  | Should Not Be -1
    ($install -lt $remove) | Should Be $true
  }
  It 'tears the half-built service down if configuring it fails, leaving the old one installed' {
    $script:RenameSrc | Should Match 'nssm remove \$To confirm'
  }
  It 'refuses to rename into a service that cannot start, rather than dropping the password' {
    $script:RenameSrc | Should Match 'Get-Credential'
    $script:RenameSrc | Should Match 'refusing to rename'
  }
  It 'rewrites the log path, so the renamed service stops writing to the old file' {
    $script:RenameSrc | Should Match 'AppStdout'
    $script:RenameSrc | Should Match 'AppStderr'
  }
}
