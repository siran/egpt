# install-nssm-service.ps1 - install an egpt v2 node as a Windows Service via NSSM.
#
# A node is one profile: EGPT_HOME selects its config/conversations/state/sessions
# (default ~/.egpt). Independent nodes coexist by using different profiles - each
# gets its own service, its own ~/.egptN. This installs ONE such node.
#
# The service runs:  node egpt-daemon.mjs   (the supervisor; it spawns `node
# egpt-spine.mjs` = boot(), respawns on crash, restarts a wedged spine, handles the
# /upgrade /restart /rewind exit codes). No --headless, no role flags - boot()
# IS the node. EGPT_HOME is set in the service environment and inherited by the
# spine, so the whole node follows the one profile.
#
# ONE SERVICE CAN CARRY SEVERAL PROFILES. The supervision axis is the SESSION, not the
# account (operator 2026-09-11): egpt-daemon.mjs reads EGPT_HOMES (';'-separated) and runs one
# supervisor per profile inside the one process, so the session 0 service carries every session
# 0 profile instead of there being one service per account. Pass -EgptHomes for that; -EgptHome
# alone keeps the one-profile shape it always had.
#
# Run from any PowerShell, from the repo root - it SELF-ELEVATES (one UAC prompt):
#   # production node (default profile ~/.egpt, service 'egpt-daemon'):
#   powershell -ExecutionPolicy Bypass -File .\setup\install-nssm-service.ps1
#   # one service supervising BOTH session 0 profiles:
#   powershell -ExecutionPolicy Bypass -File .\setup\install-nssm-service.ps1 -EgptHomes "$env:USERPROFILE\.egpt;$env:USERPROFILE\.egpt-secondary"
#   # a second, isolated node on profile ~/.egpt2 (service 'egpt2-daemon'):
#   powershell -ExecutionPolicy Bypass -File .\setup\install-nssm-service.ps1 -EgptHome "$env:USERPROFILE\.egpt2"
#
# Remove:  setup\uninstall-nssm-service.ps1 -ServiceName <name>
#
# =====================================================================================
# WHICH CHECKOUT THE SERVICE RUNS, AND WHY THIS SCRIPT NOW REFUSES TO GUESS
# =====================================================================================
# This script used to derive the repo from $PSScriptRoot\.. and say nothing about it. Run
# once from ~/src/egpt - the checkout people EDIT - and the service silently becomes that
# tree. THAT HAPPENED ON reve 2026-09-11: both daemons were pointed at C:\Users\an\src\egpt,
# so every uncommitted edit (including background agents' in-flight work) was live code on a
# serving node, and setup\upgrade.ps1 reported "NO HEARTBEAT" because it health-checks
# ~/bin/egpt. The operator repointed both services by hand.
#
# The repo already names the two trees, in setup\upgrade.ps1's own defaults: ~/bin/egpt is
# the RUNNING copy and ~/src/egpt is "the CHECKOUT people edit and run by hand". So this
# script refuses to install a service pointing anywhere but the deployed checkout while a
# deployed checkout exists, and -AllowThisTree is the deliberate, typed-out override.
param(
  [string]$EgptHome    = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string]$EgptHomes   = '',
  [string]$ServiceName = '',
  [string]$Repo        = '',
  [switch]$AllowThisTree
)

$ErrorActionPreference = 'Stop'

# Derive the service name from the profile folder: ~/.egpt -> egpt-daemon,
# ~/.egpt2 -> egpt2-daemon. Keeps nodes from colliding on one machine.
if (-not $ServiceName) {
  $base = (Split-Path $EgptHome -Leaf) -replace '^\.', ''   # ".egpt2" -> "egpt2"
  # THROW, never fall back to 'egpt' (2026-09-11): an empty leaf means EgptHome arrived
  # empty or mangled, and silently resolving that to the PRIMARY node's service is how
  # `uninstall -EgptHome <mangled>` removed egpt-daemon instead of the node it named.
  if (-not $base) { throw "cannot derive a service name: -EgptHome is empty or has no leaf ('$EgptHome'). Pass -ServiceName explicitly." }
  $ServiceName = "$base-daemon"
}

# --- 1. resolve paths, and REFUSE to make a development tree the running node ---
#        Deliberately BEFORE the elevation below: a wrong checkout must be refused without
#        costing a UAC prompt, and the refusal is more readable in the shell you typed in
#        than in an elevated console that closes itself.
if ($Repo) { $repoRoot = (Resolve-Path $Repo).Path }
else       { $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$daemonPath = Join-Path $repoRoot 'egpt-daemon.mjs'
$node       = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $daemonPath)) { throw "egpt-daemon.mjs not found at $daemonPath" }
if (-not (Test-Path $node))       { throw "node.exe not found at $node - install Node.js or edit the node path in this script" }

$deployedRoot = Join-Path $env:USERPROFILE 'bin\egpt'
$deployedOk   = Test-Path (Join-Path $deployedRoot 'egpt-daemon.mjs')
$sameTree     = $false
if ($deployedOk) { $sameTree = ((Resolve-Path $deployedRoot).Path -eq $repoRoot) }

if (-not $sameTree) {
  if ($deployedOk -and -not $AllowThisTree) {
    Write-Host ""
    Write-Host "REFUSING: this would point '$ServiceName' at a checkout that is NOT the deployed one." -ForegroundColor Red
    Write-Host "  would run : $repoRoot"
    Write-Host "  deployed  : $deployedRoot   (what setup\upgrade.ps1 and setup\deploy.ps1 health-check)"
    Write-Host ""
    Write-Host "A service pointed at an editable checkout makes every uncommitted edit live code on a" -ForegroundColor Yellow
    Write-Host "serving node - that happened on 2026-09-11 and both daemons had to be repointed by hand." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Install from the deployed checkout instead:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$deployedRoot\setup\install-nssm-service.ps1`" -EgptHome `"$EgptHome`""
    Write-Host "or say you mean it:  -AllowThisTree"
    exit 1
  }
  if (-not $deployedOk) {
    Write-Host ""
    Write-Host "WARNING: there is no deployed checkout at $deployedRoot, so this service will run from" -ForegroundColor Yellow
    Write-Host "         $repoRoot. If that is a tree you EDIT, every uncommitted change is live code" -ForegroundColor Yellow
    Write-Host "         on a serving node. Deploy to $deployedRoot and re-run when you can." -ForegroundColor Yellow
  } else {
    Write-Host "-AllowThisTree given: installing from $repoRoot rather than the deployed $deployedRoot." -ForegroundColor Yellow
  }
}

# Whatever tree wins, SAY what is in it. A dirty tree is not fatal here (deploy.ps1 keeps the
# deployed copy clean with reset --hard), but a service quietly serving 9 uncommitted files is
# the shape of the 2026-08-30 boot-failure incident, so it is never left unsaid.
$gitExe = (Get-Command git -ErrorAction SilentlyContinue).Source
$repoHead = '?'
$repoDirty = @()
if ($gitExe) {
  $repoHead = (& $gitExe -C $repoRoot rev-parse --short HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $repoHead) { $repoHead = '?' } else { $repoHead = ([string]$repoHead).Trim() }
  $repoDirty = @(& $gitExe -C $repoRoot status --porcelain 2>$null)
}

# EGPT_HOMES is the multi-profile knob; EGPT_HOME stays the single-profile one and the
# fallback the daemon uses when EGPT_HOMES says nothing.
$profileList = @($EgptHome)
# COMMA OR SEMICOLON (2026-09-11). A `;` is a statement separator in bash, so the documented
# semicolon form has to be quoted, and an unquoted or line-wrapped paste silently loses the
# argument and then tries to RUN the second path -- which is exactly what happened to the
# operator. A comma costs nothing and survives an unquoted paste.
if ($EgptHomes) { $profileList = @($EgptHomes.Split(@(';', ','), [StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }

Write-Host ""
Write-Host "About to install node:" -ForegroundColor Cyan
Write-Host "  service : $ServiceName"
Write-Host "  repo    : $repoRoot   (HEAD $repoHead)"
if ($repoDirty.Count -gt 0) {
  Write-Host "  tree    : DIRTY - $($repoDirty.Count) uncommitted path(s); this service will run them" -ForegroundColor Yellow
  foreach ($ln in ($repoDirty | Select-Object -First 10)) { Write-Host "            $ln" -ForegroundColor DarkYellow }
} else {
  Write-Host "  tree    : clean"
}
Write-Host "  profile : $EgptHome   (EGPT_HOME)"
if ($EgptHomes) { Write-Host "  profiles: $($profileList -join ', ')   (EGPT_HOMES - one supervisor each, in this one service)" }
Write-Host ""

# --- 2. ensure elevated -----------------------------------------------------------------------
# SELF-ELEVATES rather than refusing (operator 2026-09-05). Refusing made this a two-step dance
# from an ordinary shell, and the second step is easy to get wrong: an MSYS/git-bash prompt eats
# the backslashes out of a Windows path, so the retyped command fails with a mangled filename
# rather than a clear error. Relaunching ourselves removes the retype entirely.
#
# The elevated child gets its OWN console window, and Get-Credential below prompts INSIDE it, so
# -Wait is required: without it this returns immediately and the caller thinks it finished while
# the password box is still open. -Pause keeps that window readable after it ends.
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Not elevated - relaunching as administrator (approve the UAC prompt)..." -ForegroundColor Yellow
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File', ('"' + $PSCommandPath + '"'))
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [switch]) { if ($kv.Value.IsPresent) { $a += "-$($kv.Key)" } }
    else { $a += @("-$($kv.Key)", ('"' + $kv.Value + '"')) }
  }
  try { Start-Process powershell -Verb RunAs -ArgumentList $a -Wait }
  catch { Write-Host "Elevation was refused or cancelled." -ForegroundColor Red; exit 1 }
  exit 0
}

# --- 3. ensure NSSM is on the system ---
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
  Write-Host "NSSM not found. Installing via winget..." -ForegroundColor Yellow
  winget install --id NSSM.NSSM --silent --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
  $nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
  if (-not $nssm) { throw "NSSM install via winget didn't put nssm on the PATH. Install from https://nssm.cc/download and re-run." }
}
Write-Host "NSSM: $nssm" -ForegroundColor Cyan

# --- 3b. host the service from a renamed nssm copy so Task Manager shows a
#         friendly name (egpt-service.exe) instead of nssm.exe. The copy lives in
#         the repo (setup/bin, gitignored), not in the profile dir. ---
$serviceBinDir = Join-Path $PSScriptRoot 'bin'
if (-not (Test-Path $serviceBinDir)) { New-Item -ItemType Directory -Path $serviceBinDir -Force | Out-Null }
$serviceBin = Join-Path $serviceBinDir 'egpt-service.exe'
$nssmReal = (Get-Item $nssm).FullName
# EVERY node on this checkout hosts its service from this ONE renamed nssm copy, so
# installing a SECOND node while the first RUNS finds it locked -- Copy-Item then threw
# 'used by another process', the service was never created, and the elevated console closed
# before the operator could read why (2026-09-11, egpt-secondary-daemon).
# The refresh is an optimisation; an existing copy is already a working nssm.
if (-not (Test-Path $serviceBin) -or
    (Get-Item $serviceBin).Length -ne (Get-Item $nssmReal).Length -or
    (Get-Item $serviceBin).LastWriteTime -lt (Get-Item $nssmReal).LastWriteTime) {
  try {
    Copy-Item -Path $nssmReal -Destination $serviceBin -Force -ErrorAction Stop
  } catch {
    if (-not (Test-Path $serviceBin)) { throw }   # nothing to fall back to -- a real failure
    Write-Host "note: $serviceBin is in use by an already-installed node, so it was not refreshed -- using the existing copy" -ForegroundColor DarkYellow
  }
}

# --- 4. credentials: the service runs as you, so it can read the profile + your
#        `claude` login. ---
$svcUser = "$env:USERDOMAIN\$env:USERNAME"
$cred = Get-Credential -UserName $svcUser -Message "Password for $svcUser (the service runs as you so it can read $EgptHome and your claude login)"

# --- 5. clean reinstall of THIS service only (never touches other nodes/processes) ---
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "Removing existing $ServiceName service (clean reinstall)..." -ForegroundColor Yellow
  & $nssm stop   $ServiceName confirm | Out-Null
  & $nssm remove $ServiceName confirm | Out-Null
  Start-Sleep -Seconds 1
}

# --- 6. install + configure ---
# WHO OWNS service-{stdout,stderr}.log, and it depends on how many profiles there are.
#
# ONE PROFILE: nothing changes. NSSM captures the whole process - supervisor and spine, since
# the spine inherits the service handles - into <EGPT_HOME>/config/logs/service-*.log and
# rotates it at 10 MB. That is what it has always been and what every reader expects.
#
# SEVERAL: the spines can no longer inherit those handles, because they are ONE pair shared by
# every profile - kg2's lines landed in kg's file with nothing to tell them apart and kg2's own
# file went dead (measured on reve 2026-09-11, the day the merge shipped). So daemon-runtime
# opens <profile>/config/logs/service-*.log itself, one pair per profile, and NSSM must not be
# pointed at the primary's pair as well: two appenders on one file, and NSSM's own rotation
# would rename it out from under the daemon's handle. NSSM therefore captures the SUPERVISOR's
# own narrative - which is about the supervisor, and names the profile on every line - into
# daemon-*.log beside them.
$logDir = Join-Path (Join-Path $EgptHome 'config') 'logs'   # logs live under config/ now (operator 2026-07-03)
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
# Every profile gets its config/logs and its state/ made here: the daemon writes its session
# marker into one and opens its child log in the other, both before it spawns anything.
foreach ($p in $profileList) {
  foreach ($sub in @('state', 'config\logs')) {
    $d = Join-Path $p $sub
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
  }
}
if ($profileList.Count -gt 1) {
  $stdoutLog = Join-Path $logDir 'daemon-stdout.log'
  $stderrLog = Join-Path $logDir 'daemon-stderr.log'
} else {
  $stdoutLog = Join-Path $logDir 'service-stdout.log'
  $stderrLog = Join-Path $logDir 'service-stderr.log'
}

Write-Host "Installing $ServiceName (host: $serviceBin)..." -ForegroundColor Cyan
& $serviceBin install $ServiceName $node "$daemonPath"
& $nssm set $ServiceName AppDirectory        $repoRoot
# EGPT_HOME selects the profile; EGPT_HOMES, when given, selects several and EGPT_HOME stays
# as the fallback the daemon uses if EGPT_HOMES is ever cleared.
if ($EgptHomes) {
  & $nssm set $ServiceName AppEnvironmentExtra "EGPT_HOME=$EgptHome" "EGPT_HOMES=$($profileList -join ';')"
} else {
  & $nssm set $ServiceName AppEnvironmentExtra "EGPT_HOME=$EgptHome"
}
& $nssm set $ServiceName DisplayName          "egpt node ($ServiceName)"
& $nssm set $ServiceName Description           "egpt v2 node - node egpt-daemon.mjs (supervisor) -> egpt-spine.mjs (boot). Profile(s) $($profileList -join ', ')."
& $nssm set $ServiceName Start                SERVICE_AUTO_START
& $nssm set $ServiceName ObjectName           $cred.UserName $cred.GetNetworkCredential().Password
& $nssm set $ServiceName AppStdout            $stdoutLog
& $nssm set $ServiceName AppStderr            $stderrLog
& $nssm set $ServiceName AppStdoutCreationDisposition 4   # OPEN_ALWAYS (append)
& $nssm set $ServiceName AppStderrCreationDisposition 4
& $nssm set $ServiceName AppRotateFiles       1
& $nssm set $ServiceName AppRotateOnline      1
& $nssm set $ServiceName AppRotateBytes       10485760   # 10 MB
& $nssm set $ServiceName AppExit Default      Restart
& $nssm set $ServiceName AppRestartDelay      5000       # 5s before restart on crash
& $nssm set $ServiceName AppStopMethodConsole 10000      # 10s graceful Ctrl+C (SIGTERM -> boot stop)

# SCM-level recovery: restart the wrapper if it (not just the node child) is killed.
& sc.exe failure $ServiceName reset=86400 actions=restart/5000/restart/5000/restart/5000 | Out-Null
& sc.exe failureflag $ServiceName 1 | Out-Null

# --- 7. start ---
Write-Host "Starting $ServiceName..." -ForegroundColor Cyan
& $nssm start $ServiceName
Start-Sleep -Seconds 3
$svc = Get-Service $ServiceName
Write-Host ""
Write-Host "Service state: $($svc.Status)" -ForegroundColor $(if ($svc.Status -eq 'Running') {'Green'} else {'Red'})

if ($svc.Status -eq 'Running') {
  Write-Host ""
  Write-Host "Done. '$ServiceName' is running egpt from $repoRoot on profile(s) $($profileList -join ', ')." -ForegroundColor Green
  if ($profileList.Count -gt 1) {
    Write-Host "  Confirm it came up with ALL of them - the daemon prints 'supervising N profile(s): ...'" -ForegroundColor Cyan
    Write-Host "  and shouts if fewer came up than were asked for."
    Write-Host ""
    Write-Host "  Logs, one node per file:" -ForegroundColor Cyan
    foreach ($p in $profileList) {
      Write-Host "    $(Join-Path (Join-Path $p 'config\logs') 'service-stderr.log')"
    }
    Write-Host "  The supervisor's own narrative (every line tagged with the profile it is about):"
    Write-Host "    $stderrLog"
  }
  Write-Host "  Get-Content `"$stdoutLog`" -Tail 20 -Wait"
  Write-Host "  Stop:   Stop-Service $ServiceName"
  Write-Host "  Remove: setup\uninstall-nssm-service.ps1 -ServiceName $ServiceName"
} else {
  Write-Host "Service did not reach Running. Check: Get-Content `"$stderrLog`" -Tail 40" -ForegroundColor Red
  exit 1
}
