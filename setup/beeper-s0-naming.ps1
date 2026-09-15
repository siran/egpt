# beeper-s0-naming.ps1 - the ONE place that says what a Session 0 Beeper service is CALLED and
# how it describes itself. Dot-sourced by install-beeper-s0-service.ps1 and by
# rename-beeper-s0-service.ps1, so a service's name and its labels can never drift apart.
#
# WHY IT EXISTS (operator, 2026-09-15). `Get-Service egpt-*` on reve listed three services:
#
#   egpt-daemon      the real thing - nssm hosting `node egpt-daemon.mjs` -> egpt-spine.mjs
#   egpt-primary     NOT a spine. Beeper Desktop, primary account, CDP 9223
#   egpt-secondary   NOT a spine. Beeper Desktop, secondary account, CDP 9225
#
# Two of those three names read like eGPT spines and are not. The operator read the list and
# reasonably concluded there were three spines. Stopping `egpt-primary` does not stop a spine -
# it takes a WhatsApp account offline. A name that lies misleads hardest during an incident,
# which is the one time the list gets read. So THE NAME NOW SAYS WHAT THE PROCESS IS: anything
# that is a Beeper Desktop carries `beeper` in its name, and the two classes cannot be confused.
#
# THE DESCRIPTIONS ARE ONE LINE, AND THE LOAD-BEARING WORDS COME FIRST. The Services console
# shows a single truncated line, so "Beeper Desktop, NOT a spine" has to sit inside the first
# handful of words or the reader never sees it. The long-form explanation belongs in a script
# comment - this file - and not in the registry, which is where it was before.
#
# NO TOP-LEVEL SIDE EFFECTS. This file is dot-sourced, including by Pester
# (setup\beeper-s0-naming.Tests.ps1), so it must define functions and do nothing else.
#
# ASCII ONLY: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI, so one em-dash is a
# parse error.

# The hand-created names this node shipped with, mapped to what each one is now.
#
# Used ONLY to DETECT an old install and point at the rename. Never to rename silently: sc.exe
# has no rename verb, so renaming a Windows service is delete-and-recreate, and between the two
# the Desktop is DOWN and that account is off the air. That is a decision for a human at a
# keyboard, not a side effect of running an installer.
function Get-BeeperS0LegacyNameMap {
  return [ordered]@{
    'egpt-primary'   = 'egpt-beeper-primary'
    'egpt-secondary' = 'egpt-beeper-secondary'
  }
}

# 'primary' | 'secondary' | $null, from the service name's suffix.
#
# Reading a ROLE off a NAME is what commit b696a4e deliberately stopped doing when FINDING a
# running service - s0-identity-reconcile.ps1 discovers by start mode instead, because the names
# are whatever whoever installed them chose. This is the other direction and the safe one: the
# caller has just TYPED the name, and all that is derived from it is the cosmetic label that
# goes beside it. An unrecognised suffix gets a neutral label, never a guess.
function Get-BeeperS0Role {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $ServiceName)
  if ($ServiceName -match '(?i)-primary$')   { return 'primary' }
  if ($ServiceName -match '(?i)-secondary$') { return 'secondary' }
  return $null
}

# What the Services console shows in its Name column.
function Get-BeeperS0DisplayName {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $ServiceName)
  $role = Get-BeeperS0Role $ServiceName
  if ($role -eq 'primary')   { return 'Beeper Desktop - primary account (ear)' }
  if ($role -eq 'secondary') { return 'Beeper Desktop - secondary account (mouth)' }
  return "Beeper Desktop (Session 0) - $ServiceName"
}

# ONE line, and it must survive truncation: what it is, which account, what stopping it costs.
function Get-BeeperS0Description {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $ServiceName)
  $role = Get-BeeperS0Role $ServiceName
  if ($role -eq 'primary') {
    return 'Beeper Desktop, NOT a spine. Session 0, PRIMARY account (the ear). Stop it and that account goes offline.'
  }
  if ($role -eq 'secondary') {
    return 'Beeper Desktop, NOT a spine. Session 0, SECONDARY account (the mouth). Stop it and the agents cannot reply.'
  }
  return 'Beeper Desktop, NOT a spine. Session 0 account host. Stop it and that account goes offline.'
}
