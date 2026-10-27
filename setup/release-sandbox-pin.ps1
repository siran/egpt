# release-sandbox-pin.ps1 - return a pinned sandbox account to the pool:
# revoke every standing ACE on its pin (read back), delete the pin, release the
# lease. Remove-SandboxPin in sandbox-account.ps1 does the work.
#
# The spine runs it for every pin whose conversations.yaml sandbox_pin is gone
# (src/spine/sandbox-pins.mjs); the operator may run it by hand. No elevation:
# the operator owns every folder these ACEs are on.
#
# Exit: 0 released (or no such pin), 2 busy (a live session holds the account;
# nothing touched), 1 something is still granted (the pin is kept; re-run).
[CmdletBinding(PositionalBinding = $false)]
param(
  # The pin's key= line, <being>:<surface>:<chat id>.
  [Parameter(Mandatory = $true)][string]$Key
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'sandbox-account.ps1')

$r = Remove-SandboxPin -Key $Key
foreach ($a in @($r.Aces)) { Log "pin release: $($a.Status) $($a.Path) - $($a.Message)" }
$who = if ($r.Account) { " ($($r.Account))" } else { '' }
Log "pin release '$Key'$($who): $($r.Status) - $($r.Message)"
if ($r.Status -eq 'released' -or $r.Status -eq 'absent') { exit 0 }
if ($r.Status -eq 'busy') { exit 2 }
exit 1
