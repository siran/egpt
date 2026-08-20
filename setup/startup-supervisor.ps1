# startup-supervisor.ps1 -- launches AND supervises the egpt daemon, replacing BOTH the
# egpt-daemon-session1 and egpt-daemon-watchdog scheduled tasks.
#
# WHY (operator, 2026-08-19): Task Scheduler's `LogonType Interactive` proved unreliable on
# DOLLY (Windows 11 Home) -- confirmed live, twice, including against a GENUINELY fresh
# reboot+auto-logon (ruling out session staleness as the cause): every task registered that
# way reported success (LastTaskResult 0) while silently never attaching to the real
# interactive session at all -- no process launched, no file written, nothing. The exact
# same registration worked fine on REVE (Windows 11 Pro), but the operator does not want
# this feature to depend on being on Pro. The Startup folder is a far older, simpler
# mechanism -- Explorer processes it as part of its OWN logon sequence, including an
# AutoAdminLogon-driven logon (functionally identical to a typed one from the shell's own
# perspective) -- present unconditionally on every Windows edition since Windows 95, no
# Task Scheduler involved at all. Also more transportable to other OSes later (the same
# launch-on-login + self-monitor-loop shape maps to a macOS LaunchAgent or a Linux systemd
# user service, where Task Scheduler XML would not).
#
# THIS SCRIPT IS THE WHOLE SUPERVISOR: launches the daemon hidden, then loops forever,
# restarting it if the process dies outright OR its heartbeat goes stale (the same two
# failure modes egpt-daemon-session1's RestartCount and egpt-daemon-watchdog covered
# separately -- now one script, one loop, no Task Scheduler dependency for either).
#
# Installed by register-startup.ps1 (drops a tiny .vbs launcher into shell:startup that
# runs THIS script hidden). Never run this directly outside that -- it loops forever.

param(
  [string]$Repo                 = (Join-Path $env:USERPROFILE 'bin\egpt'),
  [string]$EgptHome             = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [int]$StaleSeconds            = 90,
  [int]$CheckIntervalSeconds    = 20
)

$ErrorActionPreference = 'Continue'

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeExe = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }
$daemonScript = Join-Path $Repo 'egpt-daemon.mjs'
$vbsWrapper = Join-Path $Repo 'setup\run-hidden.vbs'
$aliveFile = Join-Path $EgptHome 'state\alive.txt'

$logDir = Join-Path $EgptHome 'config\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$daemonStdout = Join-Path $logDir 'daemon-startup.log'
$daemonStderr = Join-Path $logDir 'daemon-startup-err.log'
$supervisorLog = Join-Path $logDir 'supervisor.log'

function Log($msg) {
  Add-Content -Path $supervisorLog -Value "[supervisor $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffZ')] $msg"
}

# Launches the daemon HIDDEN via the same wscript.exe/run-hidden.vbs trick
# register-daemon-task.ps1 used (powershell.exe -WindowStyle Hidden alone still flashes on
# window creation -- confirmed live, 2026-08-17; wscript.exe is a GUI-subsystem host, never
# allocates a console at all). Returns the wscript.exe process -- it's what's tracked as
# "the daemon is alive", since run-hidden.vbs's Run(cmd, 0, True) blocks wscript.exe for
# exactly as long as the real node.exe child runs (True = wait), so wscript.exe's own
# lifetime mirrors the daemon's.
function Start-Daemon {
  Log "starting daemon"
  $q = [char]34
  $qEsc = '\' + $q
  $innerCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command " + $qEsc + "& " + $qEsc + $nodeExe + $qEsc + " " + $qEsc + $daemonScript + $qEsc + " 1>> " + $qEsc + $daemonStdout + $qEsc + " 2>> " + $qEsc + $daemonStderr + $qEsc + $qEsc
  $vbsArgs = "//B //NoLogo `"$vbsWrapper`" `"$innerCmd`""
  Start-Process -FilePath 'wscript.exe' -ArgumentList $vbsArgs -WorkingDirectory $Repo -PassThru
}

Log "=== supervisor starting (repo=$Repo egpthome=$EgptHome) ==="
$proc = Start-Daemon

while ($true) {
  Start-Sleep -Seconds $CheckIntervalSeconds
  $restart = $false

  if ($proc.HasExited) {
    Log "daemon process exited outright (exit code $($proc.ExitCode)) -- restarting"
    $restart = $true
  } elseif (Test-Path $aliveFile) {
    $age = (Get-Date) - (Get-Item $aliveFile).LastWriteTime
    if ($age.TotalSeconds -gt $StaleSeconds) {
      Log "heartbeat stale ($([math]::Round($age.TotalSeconds))s > ${StaleSeconds}s) -- killing + restarting"
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
      # the daemon's own child (egpt-spine.mjs) can outlive a killed daemon -- clean it up
      # too, so the restart doesn't fight an orphaned process for ports/state.
      Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*egpt-spine.mjs*' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
      $restart = $true
    }
  }
  # else: no alive.txt yet at all -- still booting, not yet a problem; $proc.HasExited
  # above already catches an instant-crash-before-first-heartbeat case.

  if ($restart) {
    Start-Sleep -Seconds 2
    $proc = Start-Daemon
  }
}
