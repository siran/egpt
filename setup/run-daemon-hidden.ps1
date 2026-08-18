# run-daemon-hidden.ps1 -- the actual daemon launch, as a real script file instead of a
# command-line one-liner. Invoked by the egpt-daemon-session1 scheduled task
# (powershell.exe -WindowStyle Hidden -File run-daemon-hidden.ps1) so node.exe attaches to
# that already-hidden console instead of opening its own visible window (operator
# 2026-08-17: "why not run that tab headless" -- the console only ever needed to exist for
# Chrome, never for the daemon itself).
#
# A SCRIPT FILE, not a -Command one-liner: three straight rounds of nested-quote collisions
# (outer -Command "..." vs inner path literals; then 'Continue' vs the outer '...' wrapper)
# proved the one-liner too fragile to maintain. A real .ps1 file needs zero escaping and is
# directly testable on its own.
#
# $ErrorActionPreference='Continue' is required: node's own children write ordinary INFO
# lines to stderr (e.g. reap-port's log() calls), and under 'Stop' the FIRST such line
# throws a NativeCommandError that kills this whole blocking call -- the daemon was
# confirmed running fine underneath even while the wrapper died from this.
#
# Blocking (`&`, not Start-Process): this script's own process IS what Task Scheduler
# tracks as "the task" -- it must stay alive for exactly as long as node does, or
# RestartCount/RestartInterval (registered in register-daemon-task.ps1) would only ever see
# this wrapper exit instantly and never notice the real daemon dying.

param(
  [string]$Repo     = (Join-Path $env:USERPROFILE 'bin\egpt'),
  [string]$EgptHome = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' })
)

$ErrorActionPreference = 'Continue'

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeExe = if ($nodeCmd) { $nodeCmd.Source } else { 'C:\Program Files\nodejs\node.exe' }
$daemonScript = Join-Path $Repo 'egpt-daemon.mjs'

$logDir = Join-Path $EgptHome 'config\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdout = Join-Path $logDir 'daemon-session1.log'
$stderr = Join-Path $logDir 'daemon-session1-err.log'

Set-Location $Repo
& $nodeExe $daemonScript 1>> $stdout 2>> $stderr

# ALWAYS exit non-zero here (learned live, 2026-08-17): this daemon runs FOREVER under
# normal operation, so the blocking call above returning AT ALL -- crash, kill, anything --
# means something went wrong and Task Scheduler's RestartCount/RestartInterval (registered
# in register-daemon-task.ps1) needs to fire. Without this, the script just falls off the
# end with exit 0 ("success"), which Task Scheduler reads as "the task did its job, nothing
# to restart" -- confirmed live: killed the daemon, waited 75s past the 1-minute restart
# interval, nothing came back, because LastTaskResult was 0. A deliberate operator stop
# (Stop-ScheduledTask) bypasses this entirely -- that terminates the whole process tree
# directly, never reaches this line.
exit 1
