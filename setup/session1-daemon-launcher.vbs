' session1-daemon-launcher.vbs - the hidden shim behind the SCHEDULED TASK that starts
' the SESSION 1 DAEMON at logon. Registered, inspected and removed by
' setup/register-session1-daemon-task.ps1.
'
' ASCII ONLY, same house rule as the .ps1 scripts beside it.
'
' IT IS session1-logon-launcher.vbs WITH TWO DIFFERENCES, and both matter:
'
'   1. IT STARTS egpt-daemon.mjs, NOT egpt-spine.mjs. Until 2026-09-11 it could not:
'      daemon-runtime.mjs's singleton was scoped to the PROFILE, so a daemon launched at
'      logon met the session 0 spine's fresh beat and exited before spawning anything (the
'      long DECISION 1 block in register-session1-autostart.ps1 is about exactly that).
'      The singleton is scoped to the SESSION now - state/daemon-s0.pid vs
'      state/daemon-s1.pid - so the logon daemon is an ordinary, allowed second daemon,
'      and the session 1 spine finally gets a supervisor that can act on its 42/43/44
'      lifecycle exits instead of letting each one become a handback to session 0.
'
'   2. IT WAITS: sh.Run(cmd, 0, True), and quits with the child's exit code. The spine
'      shim uses False (fire and forget) because the HKCU Run key never looks back. A
'      SCHEDULED TASK does: "restart the task if it fails" is measured on the exit code of
'      the process the action started, so a shim that returned 0 immediately would tell
'      Task Scheduler the task had succeeded and no restart would ever fire. The cost is
'      one resident wscript.exe and one resident cmd.exe for the life of the daemon.
'
' EGPT_SESSION1=1 IS SET HERE AND ONLY HERE, per process. The daemon reads it to key its
' singleton to the logon session, and the spine it spawns inherits it and reads it to know
' it is the successor (src/spine/successor-announce.mjs). One flag, one meaning, and the two
' can never disagree about which session they are in. It must NEVER be set in
' HKCU\Environment: that leaks into every process the operator starts and, because the NSSM
' service runs as the operator, potentially into the session 0 daemon as well - telling the
' incumbent that it is its own successor.
'
' The quoted `set "VAR=1"` form is deliberate: cmd takes everything between the `=` and the
' `&&` as the value, trailing space included (measured on reve 2026-09-06), and a spine that
' read EGPT_SESSION1 as "1 " would decide it is NOT the successor and boot as a second spine
' on a shared profile.
'
' ARGUMENTS - four, each one plain path, none containing a quote:
'   0  node.exe   ABSOLUTE path. Not bare `node`: a scheduled task's PATH is not a terminal's.
'   1  repo       the eGPT checkout. Becomes the process cwd.
'   2  EGPT_HOME  the profile. Passed EXPLICITLY, never left to default: the session 0
'                 service carries EGPT_HOME in its own service environment and the
'                 interactive logon environment does not have to agree. Two different
'                 profiles is not a degraded handover, it is no handover at all.
'   3  log        stdout+stderr are APPENDED here. Without it a failed handover is invisible.

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
          " && """ & nodeExe & """ ""egpt-daemon.mjs"" >> """ & logPath & """ 2>&1"

Set sh = CreateObject("WScript.Shell")
rc = sh.Run(cmdLine, 0, True)
WScript.Quit rc
