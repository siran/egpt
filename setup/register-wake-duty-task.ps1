# register-wake-duty-task.ps1 - register / inspect / remove the SCHEDULED TASK that fires the
# wake-duty cycle (setup\egpt-wake-duty.vbs -> egpt-wake-duty.ps1). CONFIG-DRIVEN: whether the
# duty runs at all, and how often, come from the live profile's config.yaml `wake_up:` block
# (enabled / frequency_minutes; defaults true / 30 min). enabled:false removes the task, and
# -RepeatMinutes overrides the configured frequency.
#
#   .\setup\register-wake-duty-task.ps1            # register (idempotent)
#   .\setup\register-wake-duty-task.ps1 -Status    # read-only: is it registered, and to what
#   .\setup\register-wake-duty-task.ps1 -Remove    # remove exactly what was added
#   .\setup\register-wake-duty-task.ps1 -DryRun    # print what would be registered, register nothing
#
# NODE-AGNOSTIC. The task name and the duty script name no being, and the action path is
# resolved from $PSScriptRoot, so once this file is deployed to bin/egpt/setup it points at
# bin/egpt/setup/egpt-wake-duty.vbs on whichever node it runs.
#
# ASCII ONLY (PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI).
#
# THE SETTINGS THAT MAKE THIS A WAKE DUTY AND NOT JUST A TIMER:
#   - WakeToRun: the whole point. Task Scheduler arms a wake timer so a SLEEPING machine comes
#     up for the trigger. Without it the task only runs when the machine happens to be awake.
#   - AC-ONLY: DisallowStartIfOnBatteries and StopIfGoingOnBatteries are ON BY DEFAULT in
#     New-ScheduledTaskSettingsSet, so this script does NOT pass -AllowStartIfOnBatteries /
#     -DontStopIfGoingOnBatteries. Waking a laptop every 30 min on battery would drain it; the
#     duty is for a machine on mains.
#   - ExecutionTimeLimit ZERO (unlimited): the default 3-day kill is irrelevant to a 30-min
#     task, but a time limit here could reap a cycle that is legitimately holding the machine
#     awake up to its own $MAXMIN. The script self-limits; the scheduler must not.
#   - StartWhenAvailable: if the trigger is missed (machine was off/asleep and the wake timer
#     did not fire), run it at the next opportunity rather than skipping the cycle outright.
#   - LogonType Interactive / RunLevel Limited, as the current user: the duty needs no
#     elevation and no stored password, and runs in the operator's own session.
#
# Registering a task that runs as yourself needs no elevation. Idempotent: -Force replaces an
# existing registration in place.

param(
  [string] $TaskName      = 'egpt-wake-duty',
  [int]    $RepeatMinutes = 30,
  [string] $VbsPath       = '',
  [switch] $Status,
  [switch] $Remove,
  [switch] $DryRun,
  [switch] $LoadFunctionsOnly   # dot-source without doing any OS work (the Tests harness)
)

$ErrorActionPreference = 'Stop'

# --- the task definition, factored out as a PURE function so the Tests can inspect its shape
#     without registering anything. Every New-ScheduledTask* cmdlet below builds an in-memory
#     CIM object and touches no OS state; only Register/Unregister (in the body) do. ---
function Get-WakeDutyTaskDefinition {
  param(
    [string] $TaskName      = 'egpt-wake-duty',
    [int]    $RepeatMinutes = 30,
    [Parameter(Mandatory = $true)][string] $VbsPath,
    [string] $User = ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
  )
  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $q = [char]34
  # //B batch mode (no WSH error dialog on a headless wake), //Nologo no banner.
  $arguments = "//B //Nologo $q$VbsPath$q"
  $action    = New-ScheduledTaskAction -Execute $wscript -Argument $arguments
  # -Once + -RepetitionInterval with NO -RepetitionDuration => repeat every N min INDEFINITELY.
  # An empty Duration is Task Scheduler's "repeat forever" (measured on this host: Interval
  # PT30M, Duration empty); it sidesteps the [TimeSpan]::MaxValue validation bug.
  $trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $RepeatMinutes)
  $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
  # AC-only is the DEFAULT (see header) - do not pass the battery switches. WakeToRun wakes the
  # box; ExecutionTimeLimit 0 = no kill; StartWhenAvailable catches a missed trigger.
  $settings  = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  return [PSCustomObject]@{
    TaskName  = $TaskName
    Action    = $action
    Trigger   = $trigger
    Principal = $principal
    Settings  = $settings
    Wscript   = $wscript
    Arguments = $arguments
    VbsPath   = $VbsPath
  }
}

# --- wake_up: config reader, a PURE function so the Tests can feed it text with no profile. ---
# Targeted FLAT-block parse of just this node's wake_up: enabled / frequency_minutes scalars.
# PowerShell 5.1 has no YAML parser; the repo's node-helper pattern (setup\global-read-paths.mjs)
# exists to keep a LIST in agreement with the SPINE's own reading - but nothing in the spine reads
# wake_up (this registrar is its ONLY reader), so a two-scalar parse here is the whole need.
# ASSUMES the block is simple and flat, the shape the skeleton ships: a column-0 'wake_up:' then
# indented 'enabled:' / 'frequency_minutes:' lines. Absent block or empty text => the documented
# defaults: enabled = true, frequency_minutes = 30.
function Get-WakeUpConfig {
  param([string] $Text = '')
  $enabled = $true
  $freq    = 30
  $inBlock = $false
  foreach ($line in ($Text -split "`r?`n")) {
    if (-not $inBlock) {
      if ($line -match '^wake_up:\s*(#.*)?$') { $inBlock = $true }
      continue
    }
    if ($line -match '^\S') { break }   # a column-0 line ends the block (next top-level key / comment)
    if ($line -match '^\s+enabled:\s*(.+?)\s*(#.*)?$') {
      $v = $Matches[1].Trim().Trim('"').Trim("'").ToLower()
      if ($v -eq 'false') { $enabled = $false } elseif ($v -eq 'true') { $enabled = $true }
    } elseif ($line -match '^\s+frequency_minutes:\s*(.+?)\s*(#.*)?$') {
      $v = $Matches[1].Trim().Trim('"').Trim("'")
      $n = 0
      if ([int]::TryParse($v, [ref]$n) -and $n -gt 0) { $freq = $n }
    }
  }
  return [PSCustomObject]@{ Enabled = $enabled; FrequencyMinutes = $freq }
}

if ($LoadFunctionsOnly) { return }

# --- resolve the vbs beside THIS registrar, so a deployed copy points at the deployed vbs ----
if (-not $VbsPath) { $VbsPath = Join-Path $PSScriptRoot 'egpt-wake-duty.vbs' }
$User    = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$WScript = Join-Path $env:SystemRoot 'System32\wscript.exe'

function Get-Task {
  try { return Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { return $null }
}

function Show-Status {
  Write-Host "scheduled task : $TaskName"
  $t = Get-Task
  if (-not $t) { Write-Host "  registered   : no" -ForegroundColor Yellow; return }
  Write-Host "  registered   : YES" -ForegroundColor Green
  Write-Host "  state        : $($t.State)"
  foreach ($a in $t.Actions)  { Write-Host "  action       : $($a.Execute) $($a.Arguments)" }
  foreach ($g in $t.Triggers) { Write-Host "  trigger      : $($g.CimClass.CimClassName)  repeat=$($g.Repetition.Interval)" }
  $p = $t.Principal
  Write-Host "  principal    : $($p.UserId)  LogonType=$($p.LogonType)  RunLevel=$($p.RunLevel)"
  $s = $t.Settings
  Write-Host "  wake to run  : $($s.WakeToRun)"
  Write-Host "  on batteries : DisallowStart=$($s.DisallowStartIfOnBatteries) StopGoing=$($s.StopIfGoingOnBatteries)  (both true = AC-only)"
  Write-Host "  time limit   : $($s.ExecutionTimeLimit)   (PT0S / empty = unlimited)"
  Write-Host "  when avail   : $($s.StartWhenAvailable)"
  try {
    $i = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
    Write-Host "  last run     : $($i.LastRunTime)  result=$($i.LastTaskResult)  missed=$($i.NumberOfMissedRuns)"
  } catch { }
}

# --- -Status: read only --------------------------------------------------------------------
if ($Status) { Show-Status; return }

# --- read this node's wake_up: block from the LIVE profile config (READ-ONLY) --------------
# enabled gates register-vs-remove; frequency_minutes is the repeat interval UNLESS -RepeatMinutes
# was passed explicitly. Absent file or block => defaults (enabled=true, 30 min).
$ConfigPath = Join-Path $env:USERPROFILE '.egpt\config\config.yaml'
$cfgText    = if (Test-Path -LiteralPath $ConfigPath) { [string](Get-Content -LiteralPath $ConfigPath -Raw) } else { '' }
$wake       = Get-WakeUpConfig -Text $cfgText
if (-not $PSBoundParameters.ContainsKey('RepeatMinutes')) { $RepeatMinutes = [int]$wake.FrequencyMinutes }
$removeBecauseDisabled = -not $wake.Enabled

# --- -Remove (explicit), or wake_up.enabled:false in config -> take the task away -----------
if ($Remove -or $removeBecauseDisabled) {
  if ($removeBecauseDisabled -and -not $Remove) {
    Write-Host "wake_up.enabled is false in $ConfigPath - this node declines the wake duty; removing." -ForegroundColor Yellow
  }
  $t = Get-Task
  if (-not $t) {
    Write-Host "'$TaskName' is not registered - nothing to remove."
  } elseif ($DryRun) {
    Write-Host "[dry run] would Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
  } else {
    # -ErrorAction Stop: a non-terminating failure here would fall through to the green line.
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  }
  Write-Host "Left alone (never created by this script): the duty scripts in $PSScriptRoot and the log under ~\.egpt\disposable."
  return
}

# --- register (the default), idempotent ----------------------------------------------------

Write-Host "task     : $TaskName"
Write-Host "vbs      : $VbsPath"
Write-Host "user     : $User   (LogonType Interactive - no stored password)"
Write-Host "repeat   : every $RepeatMinutes min, indefinitely, WakeToRun, AC-only, no time limit"
Write-Host ""

# Preflight. A missing wscript or vbs would otherwise surface as "the wake did nothing", hours
# later, with no console for the error to land in (the duty runs windowless).
if (-not (Test-Path -LiteralPath $WScript)) {
  throw "wscript.exe not found at $WScript. WSH is a Feature-on-Demand on recent Windows 11 builds; without it this launcher cannot run hidden."
}
if (-not (Test-Path -LiteralPath $VbsPath)) {
  throw "launcher not found: $VbsPath - the folder beside this registrar does not carry egpt-wake-duty.vbs. Deploy it there (setup\deploy.ps1) before registering a task that points at it."
}

$def = Get-WakeDutyTaskDefinition -TaskName $TaskName -RepeatMinutes $RepeatMinutes -VbsPath $VbsPath -User $User

$existing = Get-Task
if ($DryRun) {
  if ($existing) { Write-Host "[dry run] would REPLACE the existing task '$TaskName'" }
  else { Write-Host "[dry run] would CREATE the task '$TaskName'" }
  Write-Host "[dry run]   execute   : $($def.Wscript)"
  Write-Host "[dry run]   arguments : $($def.Arguments)"
  Write-Host "[dry run]   trigger   : Once, repeat every $RepeatMinutes min ($($def.Trigger.Repetition.Interval)), indefinitely"
  Write-Host "[dry run]   principal : $User Interactive/Limited"
  Write-Host "[dry run]   settings  : WakeToRun, AC-only (Disallow=$($def.Settings.DisallowStartIfOnBatteries) StopGoing=$($def.Settings.StopIfGoingOnBatteries)), ExecutionTimeLimit=$($def.Settings.ExecutionTimeLimit), StartWhenAvailable=$($def.Settings.StartWhenAvailable)"
  return
}

# -ErrorAction Stop, explicitly: $ErrorActionPreference = 'Stop' is NOT enough for this cmdlet.
# Register-ScheduledTask has been measured to fail with 0x80070534 as a NON-TERMINATING error
# on this repo's other registrars, printing a green "Registered" line for a task Windows did
# not have. -Force makes it idempotent (replace in place if it already exists).
try {
  Register-ScheduledTask -TaskName $TaskName -Action $def.Action -Trigger $def.Trigger `
    -Principal $def.Principal -Settings $def.Settings -Force -ErrorAction Stop | Out-Null
} catch {
  Write-Host "Register-ScheduledTask failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Registering a task for yourself usually needs no elevation. If this is an access" -ForegroundColor Yellow
  Write-Host "denial, re-run from an ADMIN PowerShell:" -ForegroundColor Yellow
  Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit 1
}

if ($existing) { Write-Host "Updated scheduled task '$TaskName'." -ForegroundColor Green }
else { Write-Host "Registered scheduled task '$TaskName'." -ForegroundColor Green }

Write-Host ""
Write-Host "Fires every $RepeatMinutes min and wakes the machine for it (AC only)."
Write-Host "  check   : .\setup\register-wake-duty-task.ps1 -Status"
Write-Host "  log     : Get-Content `"$env:USERPROFILE\.egpt\disposable\egpt-wake-duty.log`" -Tail 40 -Wait"
Write-Host "  remove  : .\setup\register-wake-duty-task.ps1 -Remove"

# --- status readback: what WINDOWS actually has now ----------------------------------------
Write-Host ""
Write-Host "Current status (read back from Windows):" -ForegroundColor Green
Show-Status
