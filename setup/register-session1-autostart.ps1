# register-session1-autostart.ps1 - register / inspect / remove the HKCU Run entry
# that starts the SESSION 1 spine at logon. Chunk 4 of
# plans/2609061200-SESSION-0-TO-1-HANDOVER-PLAN.md.
#
#   .\setup\register-session1-autostart.ps1                 # register (idempotent)
#   .\setup\register-session1-autostart.ps1 -Status         # read-only: is it registered, and to what
#   .\setup\register-session1-autostart.ps1 -Remove         # remove exactly what was added
#   .\setup\register-session1-autostart.ps1 -DryRun         # print the exact writes, perform none
#   .\setup\register-session1-autostart.ps1 -EgptHome "$env:USERPROFILE\.egpt2"   # a second node
#
# NO ELEVATION. HKCU is the current user's own hive and this writes one string
# value into it. That is half the reason the plan chose it over Task Scheduler -
# the other half being that `schtasks /run` is fire-and-forget with a command
# line frozen at registration. ROADMAP.md:1378 records that Beeper already starts
# this way on these machines ("Beeper starts at LOGON via the HKCU Run key");
# VERIFIED on reve 2026-09-06 - HKCU\...\CurrentVersion\Run holds
# `com.automattic.beeper.desktop = "C:\Users\an\AppData\Local\Programs\BeeperTexts\Beeper.exe"`.
# This entry sits beside it, same key, same shape.
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).
#
# =====================================================================================
# DECISION 1 - THIS ENTRY LAUNCHES A BARE SPINE. THERE IS NOW A BETTER OPTION.
# =====================================================================================
# SUPERSEDED 2026-09-11, and the reason it was written is gone. Use
# setup/register-session1-daemon-task.ps1 unless you specifically want the
# no-supervisor shape below; this script is kept as the fallback.
#
# WHAT CHANGED. The original decision here was that the Run entry could not
# launch a DAEMON, because daemon-runtime.mjs's checkSingleton() read
# state/spine.pid and the state/alive.txt mtime - both under the SHARED
# EGPT_HOME - and exited 0 with "another egpt daemon is already alive ...
# refusing to start a second daemon" whenever the beat was fresh (liveDaemonPid's
# staleMs = 120_000) and that pid was live. At logon the Session 0 spine is alive
# and beating every 60s, so the successor's daemon met a fresh beat EVERY time. A
# supervisor that self-refuses at the only moment it is ever launched is not a
# supervisor.
#
# The singleton is scoped to the SESSION now, not to the profile: each daemon
# reads and writes state/daemon-s0.pid or state/daemon-s1.pid according to
# EGPT_SESSION1, so one daemon per profile PER SESSION is allowed and a second
# daemon in the SAME session on the SAME profile is still refused. The other two
# objections went with it:
#
#   - THE PROFILE FILES. state/spine.pid, alive.txt, restart-announce.json,
#     last-good.json and rewind-target.txt are written by whichever spine holds
#     the profile, and exactly one spine holds it at a time - the console port is
#     the mutex. The one file that was genuinely per-supervisor is the singleton
#     marker, and that is now per session by name.
#   - THE BOOT-FAILURE LADDER acts on the CHECKOUT (archive to a rescue branch,
#     roll back to last-known-good). Two daemons could still reach for one
#     working tree, but only after three consecutive boots that never beat -
#     and a session 1 daemon in that state has a session 0 daemon holding the
#     profile beside it, which is the recoverable half of the trade the operator
#     accepted when he asked for a second daemon at all.
#
# WHAT THIS SCRIPT'S SHAPE COSTS, unchanged and still true of a bare spine: the
# lifecycle exit codes. daemon-runtime.mjs turns 42/43/44 (/upgrade, /restart,
# /rewind) into a respawn; nothing here does. From Session 1 each becomes a plain
# process exit, the port goes quiet, and the Session 0 daemon takes the profile
# back - a working spine, in Session 0, losing the browser until the next logon.
# That is precisely what the daemon task fixes.
#
# WHAT IT IS STILL GOOD FOR: no supervisor to keep up, no Task Scheduler, one
# registry value. If the task mechanism ever misbehaves, this is the way back to
# a Session 1 spine in one command.
#
# =====================================================================================
# DECISION 2 - LOCK DOES NOT HAND BACK. LOGOFF DOES.
# =====================================================================================
# The operator's ruling of 2026-09-06 ("locking does not hand back; only the
# session ending does") is stated in the plan as falling out of the mechanism
# rather than needing code. It does, and here is the mechanism:
#
# A Run entry is processed by userinit/Explorer at LOGON, and what it starts is
# an ordinary user process INSIDE the interactive session.
#   - LOCKING (Win+L) does not end that session. Winlogon switches the INPUT
#     DESKTOP from WinSta0\Default to WinSta0\Winlogon (the secure desktop). No
#     process is signalled, none is terminated; the session, the Default desktop
#     and everything running on it continue. So the Session 1 spine keeps the
#     port and keeps the profile, and the handover never sees a "lock" event at
#     all. That is the ruling, for free.
#   - LOGOFF does end it. The session manager sends WM_QUERYENDSESSION /
#     WM_ENDSESSION to top-level windows and then TERMINATES every process in the
#     session. A hidden console process with no message loop is simply killed.
#     The port goes quiet and the Session 0 daemon resumes. Windows has no nohup:
#     nothing started inside a session survives that session's logoff.
#
# HONESTY ABOUT WHAT WAS NOT VERIFIED: this was written without logging out or
# locking the machine, so the above is the mechanism, not an observation of it.
# If a future test ever finds a Run-launched process dying on LOCK, that
# invalidates the operator's ruling and the plan's "lock is not an event this
# design ever sees" - say so loudly rather than working around it here.
#
# THREE CASES THAT LOOK LIKE A HANDBACK AND ARE NOT, worth knowing before someone
# files them as a bug: fast user switching and an RDP disconnect leave the
# session DISCONNECTED rather than ended, so the spine lives on and keeps holding
# the profile; and Restart / Shut down end the session like a logoff, after which
# the Session 0 service brings the node back at boot with nobody logged in.
#
# =====================================================================================
# WHY EGPT_SESSION1=1 AND NOT A CONFIG KEY
# =====================================================================================
# Both spines read the SAME config file - that is the point of sharing one
# EGPT_HOME - so config cannot tell them apart. The successor flag has to travel
# per-process, which on Windows means the environment. EGPT_SESSION1 matches the
# existing EGPT_* convention (EGPT_HOME, EGPT_SUPERVISED, EGPT_CLAUDE_BIN,
# EGPT_PI_BIN, EGPT_BUS_KEY, EGPT_CDP_HOST).
# It is set PER PROCESS, inside the shim's cmd line. It must NEVER be set in
# HKCU\Environment or via [Environment]::SetEnvironmentVariable(..., 'User'):
# that leaks into every process the operator starts - and, because the NSSM
# service runs as the operator, potentially into the SESSION 0 spine as well,
# telling the incumbent that it is its own successor.

param(
  [string] $Repo      = '',
  [string] $EgptHome  = '',
  [string] $Node      = '',
  [string] $EntryName = '',
  [string] $LogPath   = '',
  [switch] $Remove,
  [switch] $Status,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

# No [CmdletBinding()] here, and the modes are explicit switches rather than
# -WhatIf. setup/sandbox-logon-launcher.ps1's header records what common
# parameters already cost this repo once (PowerShell PREFIX-MATCHES them, and an
# inner argv's own --verbose bound -Verbose instead of reaching the script).
# Nothing external is forwarded through this binder, so that trap is not armed
# here - but explicit -Status / -Remove / -DryRun costs nothing and cannot bite.

$RunKey      = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
# Task Manager / Settings > Startup apps writes the per-entry enable/disable
# marker HERE, not in the Run key. An entry present in Run but disabled here
# never runs, and nothing anywhere says so. This script READS it, never writes it.
$ApprovedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'

# --- resolve every input once, then print it; nothing below guesses twice ------------

if (-not $Repo) { $Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
if (-not $EgptHome) {
  if ($env:EGPT_HOME) { $EgptHome = $env:EGPT_HOME }
  else { $EgptHome = Join-Path $env:USERPROFILE '.egpt' }
}
# Derived from the profile folder exactly like install-nssm-service.ps1 derives
# its service name: ~/.egpt -> egpt-session1, ~/.egpt2 -> egpt2-session1. One
# machine can carry several nodes; they must not collide on one Run value name.
if (-not $EntryName) {
  $base = (Split-Path $EgptHome -Leaf) -replace '^\.', ''
  # THROW, never fall back to 'egpt' (2026-09-11): an empty leaf means EgptHome arrived
  # empty or mangled, and silently resolving that to the PRIMARY node's service is how
  # `uninstall -EgptHome <mangled>` removed egpt-daemon instead of the node it named.
  if (-not $base) { throw "cannot derive a service name: -EgptHome is empty or has no leaf ('$EgptHome'). Pass -ServiceName explicitly." }
  $EntryName = "$base-session1"
}
if (-not $LogPath) { $LogPath = Join-Path $EgptHome 'config\logs\session1-spine.log' }
if (-not $Node) {
  $found = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($found) { $Node = $found.Source }
  else { $Node = 'C:\Program Files\nodejs\node.exe' }   # the same fallback install-nssm-service.ps1 hardcodes
}

# The shim comes from -Repo, NOT from $PSScriptRoot (2026-09-11): running this
# script out of an editable checkout to register an entry against the DEPLOYED
# one is the ordinary case, and the shim is what sets EGPT_SESSION1 and names the
# entry point - it must ship with the code it launches.
$Shim    = Join-Path (Join-Path $Repo 'setup') 'session1-logon-launcher.vbs'
$Spine   = Join-Path $Repo 'egpt-spine.mjs'
$WScript = Join-Path $env:SystemRoot 'System32\wscript.exe'

$q = [char]34
$Command = "$q$WScript$q $q$Shim$q $q$Node$q $q$Repo$q $q$EgptHome$q $q$LogPath$q"

function Get-RunValue {
  try { return (Get-ItemProperty -Path $RunKey -Name $EntryName -ErrorAction Stop).$EntryName }
  catch { return $null }
}

function Get-ApprovedMarker {
  # REG_BINARY. Byte 0 is the flag; bytes 4..11 are a FILETIME of when it was
  # toggled. Observed on reve 2026-09-06: 0x02 and 0x06 on entries that run, 0x03
  # on entries the operator disabled in Settings. That mapping is Windows' own
  # convention rather than a documented contract, so anything else gets reported
  # raw and left to the operator instead of being interpreted.
  try {
    $b = (Get-ItemProperty -Path $ApprovedKey -Name $EntryName -ErrorAction Stop).$EntryName
    if ($b -and $b.Length -gt 0) { return $b }
  } catch { }
  return $null
}

function Format-ApprovedMarker($bytes) {
  if (-not $bytes) { return 'absent (an entry with no marker runs by default)' }
  $hex = ($bytes | ForEach-Object { '{0:X2}' -f $_ }) -join ''
  if ($bytes[0] -eq 3) { return "DISABLED by Task Manager / Settings (0x$hex) - this entry will NOT run" }
  if ($bytes[0] -eq 2 -or $bytes[0] -eq 6) { return "enabled (0x$hex)" }
  return "present, unrecognised first byte (0x$hex) - check Settings > Startup apps"
}

function Show-Status {
  Write-Host "HKCU Run entry : $EntryName"
  Write-Host "  key          : $RunKey"
  $cur = Get-RunValue
  if ($cur) {
    Write-Host "  registered   : YES" -ForegroundColor Green
    Write-Host "  command      : $cur"
    if ($cur -ne $Command) {
      Write-Host "  NOTE: the registered command line differs from what this script would write now:" -ForegroundColor Yellow
      Write-Host "        would be : $Command"
      Write-Host "        re-run without -Status to bring it up to date."
    }
  } else {
    Write-Host "  registered   : no" -ForegroundColor Yellow
    Write-Host "  would be     : $Command"
  }
  Write-Host "  startup flag : $(Format-ApprovedMarker (Get-ApprovedMarker))"
  $siblings = @()
  try {
    $p = Get-ItemProperty -Path $RunKey -ErrorAction Stop
    $siblings = $p.PSObject.Properties.Name | Where-Object { $_ -notmatch '^PS' -and $_ -ne $EntryName }
  } catch { }
  Write-Host "  alongside    : $($siblings -join ', ')"
}

function Test-Alignment {
  # The Session 1 spine and the Session 0 daemon must agree on BOTH the profile
  # and the code, because they share the profile and hand it back and forth. A
  # mismatch is not a degraded handover, it is two independent nodes - so this
  # reads the service's own NSSM registration (readable unelevated) and says so.
  $svcBase = (Split-Path $EgptHome -Leaf) -replace '^\.', ''
  if (-not $svcBase) { $svcBase = 'egpt' }
  $svcName = "$svcBase-daemon"
  $params  = "HKLM:\SYSTEM\CurrentControlSet\Services\$svcName\Parameters"
  $sp = $null
  try { $sp = Get-ItemProperty -Path $params -ErrorAction Stop } catch { }
  if (-not $sp) {
    Write-Host "note: no readable NSSM registration for service '$svcName' - skipping the Session 0 cross-check."
    return
  }
  $svcHome  = $null
  $svcHomes = $null
  foreach ($e in @($sp.AppEnvironmentExtra)) {
    if ($e -like 'EGPT_HOME=*')  { $svcHome  = $e.Substring('EGPT_HOME='.Length) }
    if ($e -like 'EGPT_HOMES=*') { $svcHomes = $e.Substring('EGPT_HOMES='.Length) }
  }
  # Separators normalised before comparing (2026-09-11): the service is registered with
  # EGPT_HOME=C:/Users/... and this script builds C:\Users\... - the same directory, and
  # warning that they differ would be a false alarm on the ONE thing this check exists to
  # catch. EGPT_HOMES, when present, is the list the merged session 0 daemon supervises.
  $norm = { param($p) ($p -replace '/', '\').TrimEnd('\').ToLowerInvariant() }
  $carried = @()
  if ($svcHomes) { $carried = @($svcHomes.Split(';') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
  elseif ($svcHome) { $carried = @($svcHome) }
  $hit = @($carried | Where-Object { (& $norm $_) -eq (& $norm $EgptHome) })
  if ($carried.Count -and -not $hit.Count) {
    Write-Warning "profile mismatch: service '$svcName' supervises $($carried -join ', '), this entry would serve $EgptHome. Different profiles means there is NO handover - the Run entry would start a second, independent node."
  }
  if ($sp.AppDirectory -and (& $norm $sp.AppDirectory) -ne (& $norm $Repo)) {
    Write-Warning "checkout mismatch: service '$svcName' runs from $($sp.AppDirectory), this entry would run from $Repo. Both spines share one profile, so they must agree on the stand-down token format and the config schema. Pass -Repo '$($sp.AppDirectory)' unless you are deliberately testing a second checkout."
  }
}

# --- -Status: read only. No preflight, no writes, safe to run any time ---------------
if ($Status) { Show-Status; return }

# --- -Remove: take away exactly what was added, and nothing else ---------------------
if ($Remove) {
  $cur = Get-RunValue
  if (-not $cur) {
    Write-Host "'$EntryName' is not in $RunKey - nothing to remove."
  } elseif ($DryRun) {
    Write-Host "[dry run] would Remove-ItemProperty -Path '$RunKey' -Name '$EntryName'"
    Write-Host "[dry run] current value: $cur"
  } else {
    Remove-ItemProperty -Path $RunKey -Name $EntryName
    Write-Host "Removed '$EntryName' from $RunKey." -ForegroundColor Green
    Write-Host "  was: $cur"
  }
  # The Run value is the ONLY thing this script ever creates in the registry. The
  # shim is a tracked file in the checkout, so it is not ours to delete; the log
  # is the operator's record of past handovers, so it is not ours to delete either.
  Write-Host "Left alone (never created by this script): the shim $Shim, and the log $LogPath."
  $marker = Get-ApprovedMarker
  if ($marker) {
    # Deleting it would be removing something this script did not add. Leaving it
    # silently would let a LATER re-register inherit a disabled marker and never run.
    Write-Warning "a StartupApproved marker for '$EntryName' remains: $(Format-ApprovedMarker $marker). Task Manager / Settings wrote it, not this script, so it stays - but a future re-register would inherit it. Clear it by hand if that is wrong: reg delete `"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`" /v `"$EntryName`" /f"
  }
  return
}

# --- register (the default), idempotent ----------------------------------------------

Write-Host "entry    : $EntryName"
Write-Host "repo     : $Repo"
Write-Host "profile  : $EgptHome   (EGPT_HOME)"
Write-Host "node     : $Node"
Write-Host "shim     : $Shim"
Write-Host "log      : $LogPath"
Write-Host ""

# Preflight. Every one of these failures would otherwise surface as "the logon did
# nothing", hours later, with no message anywhere - the shim runs windowless, so
# there is no console for an error to land in.
if (-not (Test-Path -LiteralPath $WScript)) {
  throw "wscript.exe not found at $WScript. WSH is a Feature-on-Demand on recent Windows 11 builds; without it this mechanism cannot run hidden. See the shim's header."
}
if (-not (Test-Path -LiteralPath $Shim))  { throw "launcher shim not found: $Shim" }
if (-not (Test-Path -LiteralPath $Node))  { throw "node.exe not found: $Node (pass -Node <path>)" }
if (-not (Test-Path -LiteralPath $Spine)) { throw "egpt-spine.mjs not found: $Spine (pass -Repo <checkout>)" }

# cmd's `>>` creates the FILE but not the DIRECTORY: a missing log dir kills the
# whole `&&` chain before node ever starts, silently, because the error goes to a
# hidden console. Create it here instead. This is the one write this script makes
# outside HKCU.
$logDir = Split-Path -Parent $LogPath
if (-not (Test-Path -LiteralPath $logDir)) {
  if ($DryRun) { Write-Host "[dry run] would create log directory $logDir" }
  else { New-Item -ItemType Directory -Path $logDir -Force | Out-Null; Write-Host "created log directory $logDir" }
}

Test-Alignment

# A reported limit on Run value data, not one measured here - but a truncated
# command line fails silently at logon, which is the worst way to find out.
if ($Command.Length -gt 260) {
  Write-Warning "the command line is $($Command.Length) characters; Run entries are reported to truncate past 260. Shorten the checkout or log path, or move the shim nearer the drive root."
}

$existing = Get-RunValue
if ($existing -eq $Command) {
  Write-Host "already registered, byte-for-byte identical - nothing to do." -ForegroundColor Green
  Write-Host "  $Command"
} elseif ($DryRun) {
  if ($existing) { Write-Host "[dry run] would REPLACE the existing value"; Write-Host "[dry run]   old: $existing" }
  else { Write-Host "[dry run] would CREATE the value" }
  Write-Host "[dry run] New-ItemProperty -Path '$RunKey' -Name '$EntryName' -PropertyType String -Force"
  Write-Host "[dry run]   new: $Command"
} else {
  # -Force overwrites in place, and that is what makes this idempotent: running it
  # twice leaves ONE value under ONE name, never a second entry.
  New-ItemProperty -Path $RunKey -Name $EntryName -Value $Command -PropertyType String -Force | Out-Null
  if ($existing) {
    Write-Host "Updated '$EntryName' in $RunKey." -ForegroundColor Green
    Write-Host "  was: $existing"
    Write-Host "  now: $Command"
  } else {
    Write-Host "Registered '$EntryName' in $RunKey." -ForegroundColor Green
    Write-Host "  $Command"
  }
}

$marker = Get-ApprovedMarker
if ($marker -and $marker[0] -eq 3) {
  Write-Warning "'$EntryName' is DISABLED in Settings > Startup apps ($(Format-ApprovedMarker $marker)). The value is registered but Windows will NOT run it. Re-enable it there, or: reg delete `"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`" /v `"$EntryName`" /f"
}

Write-Host ""
Write-Host "Takes effect at the NEXT LOGON. Nothing starts now, and nothing should:"
Write-Host "  the Session 0 spine is holding $EgptHome right now, and two spines on one"
Write-Host "  profile is the failure this whole design exists to avoid."
Write-Host "  check   : .\setup\register-session1-autostart.ps1 -Status"
Write-Host "  log     : Get-Content `"$LogPath`" -Tail 40 -Wait"
Write-Host "  remove  : .\setup\register-session1-autostart.ps1 -Remove"
