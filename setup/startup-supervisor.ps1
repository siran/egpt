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
# HIDING, taken directly this time (operator live, 2026-08-19: "bummer" -- a whole evening
# lost to wscript.exe/VBS quoting through THREE different attempts, each breaking a
# different way: a -Command one-liner needing its own outer delimiter, Start-Process's
# single-string -ArgumentList re-tokenizing the nested "vbs" "innerCmd" shape, then its
# ARRAY form not auto-quoting multi-word elements). None of that indirection is needed:
# .NET's ProcessStartInfo.CreateNoWindow (with UseShellExecute=$false) tells Windows to
# never ALLOCATE a console for the child in the first place -- not "create it then hide
# it" (which is what -WindowStyle Hidden actually does, and why it flashes), a real
# CreateProcess-level flag with no window-creation step to flash. No VBS, no wscript.exe,
# no nested command-line escaping at all for the daemon launch.
#
# Installed by register-startup.ps1 (drops a tiny .vbs launcher into shell:startup that
# runs THIS script hidden -- that OUTER layer, VBScript's own native Run(), is unrelated to
# the Start-Process bugs above and stays as the proven, simple way to get the supervisor
# ITSELF started invisibly). Never run this directly outside that -- it loops forever.

param(
  [string]$Repo                 = (Join-Path $env:USERPROFILE 'bin\egpt'),
  [string]$EgptHome             = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [int]$StaleSeconds            = 90,
  [int]$CheckIntervalSeconds    = 20
)

$ErrorActionPreference = 'Continue'

$aliveFile = Join-Path $EgptHome 'state\alive.txt'
$logDir = Join-Path $EgptHome 'config\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$supervisorLog = Join-Path $logDir 'supervisor.log'
$daemonStdoutLog = Join-Path $logDir 'daemon-startup.log'
$daemonStderrLog = Join-Path $logDir 'daemon-startup-err.log'

function Log($msg) {
  Add-Content -Path $supervisorLog -Value "[supervisor $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffZ')] $msg"
}

# Launches the daemon with CreateNoWindow -- see the file header for why this replaces the
# earlier wscript.exe/VBS attempts entirely. Async output draining via Register-ObjectEvent
# (not just RedirectStandardOutput=$true with nobody reading it) is deliberate: an
# unconsumed redirected stream can fill its OS pipe buffer and DEADLOCK the child once full
# -- a real, well-documented .NET gotcha, not a hypothetical one, and daemon-runtime.mjs's
# own npm-install-on-upgrade step alone is chatty enough to hit it.
function Start-Daemon {
  Log "starting daemon"
  $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
  $nodeExe = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }
  $daemonScript = Join-Path $Repo 'egpt-daemon.mjs'

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $nodeExe
  $psi.Arguments = "`"$daemonScript`""
  $psi.WorkingDirectory = $Repo
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $proc.EnableRaisingEvents = $true

  $outHandler = { if ($EventArgs.Data) { Add-Content -Path $Event.MessageData -Value $EventArgs.Data } }
  Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action $outHandler -MessageData $daemonStdoutLog | Out-Null
  Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived  -Action $outHandler -MessageData $daemonStderrLog | Out-Null

  $proc.Start() | Out-Null
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()
  return $proc
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
    Get-EventSubscriber | Where-Object { $_.SourceObject -eq $proc } | Unregister-Event
    Start-Sleep -Seconds 2
    $proc = Start-Daemon
  }
}
