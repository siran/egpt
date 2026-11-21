' session1-daemon-launcher.vbs - the hidden shim behind the SCHEDULED TASK that starts
' the SESSION 1 DAEMON at logon. Registered, inspected and removed by
' setup/register-session1-daemon-task.ps1.
'
' ASCII ONLY, same house rule as the .ps1 scripts beside it.
'
' Two things matter:
'
'   1. IT STARTS egpt-daemon.mjs, NOT egpt-spine.mjs. The daemon's singleton is scoped to
'      the SESSION - state/daemon-s1.pid - and since 2026-10-17 this daemon is the node's
'      one runner (the session 0 service is retired).
'
'   2. IT WAITS: sh.Run(cmd, 0, True), and quits with the child's exit code. A
'      SCHEDULED TASK looks back: "restart the task if it fails" is measured on the exit code of
'      the process the action started, so a shim that returned 0 immediately would tell
'      Task Scheduler the task had succeeded and no restart would ever fire. The cost is
'      one resident wscript.exe and one resident cmd.exe for the life of the daemon.
'
'   3. 46 (/upgrade full) RUNS IT AGAIN, on the code just pulled. EGPT_DAEMON_RESPAWNS=1 tells
'      the daemon (and its spine) that this relaunch exists.
'
' EGPT_SESSION1=1 IS SET HERE AND ONLY HERE, per process. The daemon reads it to key its
' singleton to the logon session and to hold the browsers and claude sessions. It must NEVER
' be set in HKCU\Environment: that leaks into every process the operator starts.
'
' The quoted `set "VAR=1"` form is deliberate: cmd takes everything between the `=` and the
' `&&` as the value, trailing space included (measured on reve 2026-09-06).
'
' ARGUMENTS - four, each one plain path, none containing a quote:
'   0  node.exe   ABSOLUTE path. Not bare `node`: a scheduled task's PATH is not a terminal's.
'   1  repo       the eGPT checkout. Becomes the process cwd.
'   2  EGPT_HOME  the profile. Passed EXPLICITLY, never left to default: the interactive
'                 logon environment does not have to name the profile this task serves.
'   3  log        stdout+stderr are APPENDED here. Without it a failed start is invisible.

Option Explicit
Dim sh, args, nodeExe, repoDir, egptHome, logPath, cmdLine, rc

Set args = WScript.Arguments
If args.Count < 4 Then
  ' Nobody sees this (the host is windowless), but the exit code is visible to a human
  ' running it by hand, and to Task Scheduler's Last Run Result column.
  WScript.Quit 2
End If

nodeExe  = args(0)
repoDir  = args(1)
egptHome = args(2)
logPath  = args(3)

cmdLine = "cmd.exe /c cd /d """ & repoDir & """" & _
          " && echo [%DATE% %TIME%] session1-daemon-launcher: starting egpt-daemon.mjs (EGPT_HOME=" & egptHome & ") >> """ & logPath & """" & _
          " && set ""EGPT_HOME=" & egptHome & """" & _
          " && set ""EGPT_SESSION1=1""" & _
          " && set ""EGPT_DAEMON_RESPAWNS=1""" & _
          " && """ & nodeExe & """ ""egpt-daemon.mjs"" >> """ & logPath & """ 2>&1"

Set sh = CreateObject("WScript.Shell")
Do
  rc = sh.Run(cmdLine, 0, True)
Loop While rc = 46
WScript.Quit rc
