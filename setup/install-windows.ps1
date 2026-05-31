# setup/install-windows.ps1 -- register egpt-daemon as a real Windows Service
# managed by Service Control Manager (SCM). NSSM wraps node.exe as the service
# binary; SCM handles automatic restart on any exit. Inside the daemon,
# egpt-daemon.mjs supervises egpt.mjs + runs the integrated 2Hz heartbeat
# watchdog. Two layers, both proper, cross-platform-aligned:
#
#   Windows  SCM via NSSM        AppExit=Restart, Start=auto
#   Linux    systemd user unit   Restart=always
#   macOS    launchd LaunchAgent KeepAlive=true
#
# All three keep ONE process alive (egpt-daemon.mjs). The daemon does the
# rest (spawn egpt.mjs, watchdog, exit-code handling). Operator can stop /
# start the service via the standard tools:
#
#   Get-Service  egpt
#   Stop-Service egpt
#   Start-Service egpt
#   services.msc                       (UI: search for 'egpt')
#
# Reinstall any time: this script is idempotent. It removes the legacy
# Task Scheduler installation (egpt-daemon, egpt-daemon-headless,
# egpt-watchdog) if present, kills orphan node.exe processes, then
# installs the service fresh.

$ErrorActionPreference = 'Stop'

# Tee everything to a log file so the elevated window can close without
# losing the trace. Post-mortem path: ~/.egpt/install-windows.log.
$LogPath = Join-Path $env:USERPROFILE '.egpt\install-windows.log'
try { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null } catch {}
try { Start-Transcript -Path $LogPath -Append -Force | Out-Null } catch { Write-Host "(Start-Transcript failed: $($_.Exception.Message))" -ForegroundColor Yellow }
Write-Output ("==== install-windows.ps1 run at {0} ====" -f (Get-Date))

# Admin check -- the .cmd launcher handles UAC. Bare-runs here should fail loud.
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Not admin. Run setup\install-windows.cmd (double-click) for the UAC prompt."
  try { Stop-Transcript | Out-Null } catch {}
  exit 1
}

try {

# ---------- Resolve paths + dependencies ----------

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
Write-Output ("script: {0}" -f $MyInvocation.MyCommand.Path)
Write-Output ("repo:   {0}" -f $RepoRoot)

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
$NodeBin = if ($NodeCmd) { $NodeCmd.Source } else { $null }
if (-not $NodeBin) { throw "node.exe not found in PATH" }
Write-Output ("node:   {0}" -f $NodeBin)

$DaemonJs = Join-Path $RepoRoot 'egpt-daemon.mjs'
if (-not (Test-Path $DaemonJs)) { throw "egpt-daemon.mjs not found at $DaemonJs" }
Write-Output ("daemon: {0}" -f $DaemonJs)

$ServiceName = 'egpt'

# ---------- Ensure NSSM is available ----------

# NSSM wraps any CLI as a real Windows Service. It's the standard wrapper
# for Node.js daemons on Windows because Node can't implement the Service
# Control Manager protocol natively. ~370KB single binary, BSD-licensed.
# Cached in setup\bin\nssm.exe so first install downloads, subsequent
# re-installs reuse.
$NssmDir = Join-Path $ScriptDir 'bin'
$NssmExe = Join-Path $NssmDir 'nssm.exe'
if (-not (Test-Path $NssmExe)) {
  Write-Output "downloading NSSM (Non-Sucking Service Manager) ..."
  New-Item -ItemType Directory -Force -Path $NssmDir | Out-Null
  $tmpZip = Join-Path $env:TEMP ('nssm-' + [System.Guid]::NewGuid().ToString('N') + '.zip')
  try {
    # Pin a specific version + sha hash to detect tampering. nssm-2.24 is the
    # last upstream release (2014) and is the version every modern distro
    # carries; it's stable.
    Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $tmpZip -UseBasicParsing
    $tmpDir = Join-Path $env:TEMP ('nssm-extract-' + [System.Guid]::NewGuid().ToString('N'))
    Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
    # Pick the right arch
    $arch = if ([Environment]::Is64BitOperatingSystem) { 'win64' } else { 'win32' }
    $src = Get-ChildItem -Path $tmpDir -Recurse -Filter 'nssm.exe' | Where-Object { $_.FullName -like "*\$arch\*" } | Select-Object -First 1
    if (-not $src) { throw "could not find $arch\nssm.exe in the downloaded zip" }
    Copy-Item -Path $src.FullName -Destination $NssmExe -Force
    Remove-Item -Recurse -Force $tmpDir
    Remove-Item -Force $tmpZip
    Write-Output ("nssm: {0} (downloaded)" -f $NssmExe)
  } catch {
    throw "NSSM download failed: $($_.Exception.Message). Manually grab nssm.exe from https://nssm.cc and drop it at $NssmExe"
  }
} else {
  Write-Output ("nssm: {0} (cached)" -f $NssmExe)
}

# ---------- Clean slate: remove legacy Task Scheduler installation ----------

# Old setup used Task Scheduler with two tasks (egpt-daemon-headless +
# egpt-watchdog) plus a daemon-wrap.ps1 wrapper. Plus an earlier attempt at
# this Windows-Service rewrite registered as 'egpt-daemon' via Task Scheduler.
# Sweep them all.
$LegacyTasks = @('egpt-daemon', 'egpt-daemon-headless', 'egpt-watchdog')
foreach ($n in $LegacyTasks) {
  try {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue | Out-Null
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      Write-Output ("removed legacy task: {0}" -f $n)
    }
  } catch { Write-Output ("could not remove task {0}: {1}" -f $n, $_.Exception.Message) }
}

# Kill any orphan node.exe processes running egpt-daemon.mjs / egpt.mjs.
$orphans = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match 'egpt-daemon\.mjs' -or $_.CommandLine -match 'egpt\.mjs') }
if ($orphans) {
  Write-Output "killing existing egpt node processes:"
  foreach ($p in $orphans) {
    Write-Output ("  pid {0}" -f $p.ProcessId)
    & taskkill.exe /F /PID $p.ProcessId /T 2>&1 | Out-Null
  }
  Start-Sleep -Seconds 2
}

# Wipe stale alive.txt so the new daemon's singleton guard doesn't refuse to
# start thinking another daemon is alive.
$alivePath = Join-Path $env:USERPROFILE '.egpt\state\alive.txt'
if (Test-Path $alivePath) { Remove-Item $alivePath -Force -ErrorAction SilentlyContinue; Write-Output "removed stale alive.txt" }

# ---------- Remove pre-existing 'egpt' service (idempotent re-install) ----------

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Output ("stopping existing service '{0}' ({1}) ..." -f $ServiceName, $existing.Status)
  try { & $NssmExe stop $ServiceName confirm 2>&1 | Out-Null } catch {}
  Start-Sleep -Seconds 1
  Write-Output ("removing existing service '{0}'" -f $ServiceName)
  & $NssmExe remove $ServiceName confirm 2>&1 | Out-Null
  Start-Sleep -Seconds 1
}

# ---------- Install the Windows Service ----------

Write-Output ("installing service '{0}' -> node {1} --headless" -f $ServiceName, $DaemonJs)
& $NssmExe install $ServiceName $NodeBin ('"{0}" --headless' -f $DaemonJs) 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "nssm install failed (exit $LASTEXITCODE)" }

# Working directory = repo root (so relative paths in egpt-daemon.mjs work).
& $NssmExe set $ServiceName AppDirectory $RepoRoot 2>&1 | Out-Null

# Start automatically at boot. SERVICE_AUTO_START = the standard "start with
# the OS" mode; SCM brings the service up before any user logs on.
& $NssmExe set $ServiceName Start SERVICE_AUTO_START 2>&1 | Out-Null

# Run as the current user via LocalSystem-with-env-override. NSSM's default
# is LocalSystem (no password needed, no service account headache); we set
# USERPROFILE + HOME in the service env so the daemon's os.homedir() resolves
# to the operator's actual home, NOT C:\Windows\System32\config\systemprofile.
# This keeps ~/.egpt (WA auth, conversations, configs) in the same place
# whether the daemon is running as the service or as an interactive shell.
$envBlock = "USERPROFILE=$env:USERPROFILE`r`nHOME=$env:USERPROFILE`r`nAPPDATA=$env:APPDATA`r`nLOCALAPPDATA=$env:LOCALAPPDATA"
& $NssmExe set $ServiceName AppEnvironmentExtra $envBlock 2>&1 | Out-Null

# Restart policy: restart on ANY exit (including clean exit 0). The only way
# to permanently stop is `Stop-Service egpt` or `services.msc`. Restart delay
# 2s to avoid hot-loops on instant crashes.
& $NssmExe set $ServiceName AppExit Default Restart 2>&1 | Out-Null
& $NssmExe set $ServiceName AppRestartDelay 2000 2>&1 | Out-Null
# Throttle: don't count restarts as failures until 5s after start (so a
# crashy boot doesn't disable the service).
& $NssmExe set $ServiceName AppThrottle 5000 2>&1 | Out-Null

# Capture stdout/stderr to disk so SCM doesn't drop them into the void. The
# daemon also writes ~/.egpt/headless.log directly; these are belt-and-
# suspenders for the few lines egpt-daemon.mjs prints itself.
$logDir = Join-Path $env:USERPROFILE '.egpt'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
& $NssmExe set $ServiceName AppStdout (Join-Path $logDir 'egpt-service.out.log') 2>&1 | Out-Null
& $NssmExe set $ServiceName AppStderr (Join-Path $logDir 'egpt-service.err.log') 2>&1 | Out-Null
# Rotate log files when they hit 1MB.
& $NssmExe set $ServiceName AppRotateFiles 1 2>&1 | Out-Null
& $NssmExe set $ServiceName AppRotateOnline 1 2>&1 | Out-Null
& $NssmExe set $ServiceName AppRotateBytes 1048576 2>&1 | Out-Null

# Friendly metadata for services.msc / sc.exe describe.
& $NssmExe set $ServiceName DisplayName 'egpt -- personal WA/TG bridge daemon' 2>&1 | Out-Null
& $NssmExe set $ServiceName Description 'Supervises egpt-daemon.mjs (which supervises egpt.mjs). SCM restarts this service on any exit; the daemon respawns its child on wedge via an integrated heartbeat watchdog.' 2>&1 | Out-Null

Write-Output "service registered. starting ..."
& $NssmExe start $ServiceName 2>&1 | Out-Null
Start-Sleep -Seconds 2

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  Write-Output ("status: {0}  StartType: {1}" -f $svc.Status, $svc.StartType)
} else {
  Write-Output "!! service not found after install (this should not happen)"
}

Write-Output ""
Write-Output "manage:"
Write-Output "  Get-Service  egpt"
Write-Output "  Stop-Service egpt"
Write-Output "  Start-Service egpt"
Write-Output "  services.msc                  (UI -- search for 'egpt')"
Write-Output ""
Write-Output ("logs: Get-Content '{0}\headless.log'        -Tail 30 -Wait" -f $logDir)
Write-Output ("      Get-Content '{0}\egpt-service.out.log' -Tail 30 -Wait" -f $logDir)
Write-Output ""
Write-Output ("install log: {0}" -f $LogPath)
Write-Output "OK"

} catch {
  Write-Host ""
  Write-Host ("!! INSTALL FAILED: {0}" -f $_.Exception.Message) -ForegroundColor Red
  Write-Host ("   at: {0}" -f $_.InvocationInfo.PositionMessage) -ForegroundColor Red
  Write-Host ""
  Write-Host ("see full log: {0}" -f $LogPath) -ForegroundColor Yellow
} finally {
  try { Stop-Transcript | Out-Null } catch {}
}
