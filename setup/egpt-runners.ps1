# egpt-runners.ps1 - the node's two egpt-daemon runners, from a script: the Session 1 task and the
# Session 0 service of the same name (Task Scheduler and the SCM are separate namespaces).
# Dot-sourced by start-egpt.ps1, stop-egpt.ps1, install-nssm-service.ps1 and s0-identity-reconcile.ps1.
# The node side (src\daemon-singleton.mjs): state\s1.claim is held by the Session 1 daemon for its
# whole life, state\runner.lock by the daemon whose spine holds the profile.
# Functions only (it loads beeper-desktop.ps1, also functions only): tests dot-source it.
# ASCII ONLY: PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI.

. (Join-Path $PSScriptRoot 'beeper-desktop.ps1')

# The pid in <EgptHome>\state\<File>, if it is alive AND its command line still runs <Script>; else
# $null (pids are reused). A command line this process may not read counts as not running it.
function Get-EgptLivePid([string] $EgptHome, [string] $File, [string] $Script) {
  $path = Join-Path (Join-Path $EgptHome 'state') $File
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $n = 0
  if (-not [int]::TryParse("$(Get-Content -LiteralPath $path -Raw)".Trim(), [ref]$n) -or $n -le 0) { return $null }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$n" -ErrorAction SilentlyContinue
  if ($p -and $p.CommandLine -match [regex]::Escape($Script)) { return $n }
  return $null
}

function Get-EgptS1ClaimPath([string] $EgptHome) { return Join-Path $EgptHome 'state\s1.claim' }

# Is $User ('DOMAIN\name') logged on at a desktop: an explorer.exe of theirs outside session 0?
# Pure over $Explorers ({ SessionId; User }). The caller may itself sit in session 0 (ssh, S4U).
function Test-EgptInteractiveLogon($Explorers, [string] $User) {
  return @($Explorers | Where-Object { [int]$_.SessionId -ne 0 -and [string]$_.User -ieq $User }).Count -gt 0
}

function Get-EgptExplorers {
  return @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | ForEach-Object {
    $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
    [pscustomobject]@{ SessionId = [int]$_.SessionId; User = "$($o.Domain)\$($o.User)" }
  })
}

# What Get-EgptServiceStartVerdict needs, read live. Read-only.
function Read-EgptServiceFacts([string] $Name, [string] $EgptHome) {
  $w = Get-CimInstance Win32_Service -Filter "Name='$Name'"
  return [pscustomobject][ordered]@{
    exists = [bool]$w; status = [string]$w.State; startMode = [string]$w.StartMode
    stopFile = Test-Path -LiteralPath (Join-Path $EgptHome 'STOP')
    s1DaemonPid = Get-EgptLivePid $EgptHome 'daemon-s1.pid' 'egpt-daemon.mjs'
    s1Claimed = Test-BeeperClaimHeld (Get-EgptS1ClaimPath $EgptHome)
  }
}

# May the egpt-daemon service be started now? Pure over Read-EgptServiceFacts (Win32_Service words:
# State Stopped/Running, StartMode Auto/Manual/Disabled). -AutoOnly: only an Automatic one (the
# unattended backstop); otherwise anything not Disabled (an operator's start). A Session 1 daemon
# that runs without holding state\s1.claim is older code that would not make way: never beside it.
function Get-EgptServiceStartVerdict($Facts, [switch] $AutoOnly) {
  $no = { param($why) [ordered]@{ start = $false; reason = $why } }
  if (-not $Facts.exists) { return & $no 'not installed (setup\install-nssm-service.cmd, at the console)' }
  if ($Facts.status -ne 'Stopped') { return & $no "it is $($Facts.status)" }
  if ($Facts.startMode -eq 'Disabled') { return & $no 'it is Disabled' }
  if ($AutoOnly -and $Facts.startMode -ne 'Auto') { return & $no "it is $($Facts.startMode), not Automatic" }
  if ($Facts.stopFile) { return & $no 'the STOP file is there (setup\start-egpt.cmd removes it and starts the service)' }
  if ($Facts.s1DaemonPid -and -not $Facts.s1Claimed) {
    return & $no "the Session 1 daemon (pid $($Facts.s1DaemonPid)) does not hold state\s1.claim: older code that would not make way for the service. Restart the Session 1 daemon first: setup\stop-egpt.cmd, then setup\start-egpt.cmd (it starts this service too)"
  }
  $why = if ($Facts.s1DaemonPid) { "the Session 1 daemon (pid $($Facts.s1DaemonPid)) holds the profile; the service holds off until it ends" } else { 'no Session 1 daemon: the service runs the node' }
  return [ordered]@{ start = $true; reason = $why }
}
