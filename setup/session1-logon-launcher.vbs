' session1-logon-launcher.vbs - the hidden shim behind the HKCU Run entry that
' starts the SESSION 1 spine at logon. Registered, inspected and removed by
' setup/register-session1-autostart.ps1. Do NOT also drop this in the Startup
' folder: that would start a second copy, and two spines on one profile is the
' one failure the handover plan calls unrecoverable.
'
' ASCII ONLY, same house rule as the .ps1 scripts beside it.
'
' WHY A SHIM AT ALL, when a Run value can just name node.exe: node.exe is a
' CONSOLE program, and Explorer creates a Run entry's process with default
' creation flags. `node egpt-spine.mjs` straight from the Run value therefore
' allocates and SHOWS a console window for the whole session. That window is not
' merely untidy - closing it kills the Session 1 spine, which releases the
' console port, which hands the profile back to Session 0 and takes the browser
' with it. On Windows the only ways to get a windowless child without shipping a
' launcher binary are WSH (this file) or a CREATE_NO_WINDOW spawn from a process
' that is already running. `powershell.exe -WindowStyle Hidden` was the other
' candidate and was rejected twice over: it still flashes its own console before
' hiding it, and it then sits resident as a second process for the life of the
' spine purely to hold the redirection open.
'
' WScript.Shell.Run(cmd, 0, False): 0 = hidden window, False = do not wait. This
' is the same call setup/register-startup.ps1 already generates for its
' Startup-folder launcher, so the mechanism is proven on these machines rather
' than newly invented here.
'
' VBScript IS on Microsoft's deprecation path (a Feature-on-Demand as of Windows
' 11 24H2; removal announced, not scheduled). MEASURED on reve 2026-09-06:
' C:\Windows\System32\wscript.exe present, Windows 10.0.26200.9278, and this
' exact shim ran end to end - hidden, env vars propagated, log appended. If a
' future build drops WSH the Run entry stops working SILENTLY, which is why
' register-session1-autostart.ps1 has a -Status that prints the resolved command
' line instead of hiding it.
'
' ARGUMENTS - four, each one plain path, none containing a quote:
'   0  node.exe   ABSOLUTE path. Not bare `node`: this inherits Explorer's logon
'                 environment, and a PATH that is fine in a terminal is not a
'                 thing to bet the logon on.
'   1  repo       the eGPT checkout. Becomes the process cwd, matching what
'                 daemon-runtime.mjs's spawnShell already does (cwd: root).
'   2  EGPT_HOME  the profile. Passed EXPLICITLY, never left to default: the
'                 Session 0 service carries EGPT_HOME in its own service
'                 environment (AppEnvironmentExtra) and the interactive logon
'                 environment does not have to agree. Two different profiles is
'                 not a degraded handover, it is no handover at all.
'   3  log        stdout+stderr are APPENDED here. Without it the Session 1
'                 spine's console log goes nowhere - the spine logs to stdout and
'                 only NSSM's redirection saves the Session 0 one - so a failed
'                 handover would be invisible, which is the exact shape of the
'                 33-minute silent-restart incident daemon-runtime.mjs's ladder
'                 exists to prevent.
'
' WHY `set "VAR=1"` AND NOT `set VAR=1`. MEASURED on reve 2026-09-06:
'   cmd /c set A=1   && node -e "...JSON.stringify(process.env.A)"  ->  "1 "
'   cmd /c set "B=1" && node -e "...JSON.stringify(process.env.B)"  ->  "1"
' cmd takes everything between the `=` and the `&&` as the value, trailing space
' included. A spine testing EGPT_SESSION1 === '1' would read '1 ', decide it is
' NOT the successor, and boot as an ordinary second spine on a shared profile.
' The quoted form is not style; it is the difference between a handover and the
' overlap the plan says is fatal.
'
' WHY THE COMMAND LINE STARTS WITH `cd` AND NOT WITH A QUOTE: `cmd /c` strips the
' outermost pair of quotes when the first character after /c is a quote and the
' line holds more than two. Starting on `cd` sidesteps that rule entirely, so
' every quote below is the quote it looks like. (`cmd /s /c` is the other fix; it
' needs the whole line wrapped in one more quote pair, which is worse to read.)
'
' The echo banner is the only proof the Run entry fired at all. If a logon leaves
' no new banner in the log, the entry did not run - check -Status first.

Option Explicit
Dim sh, args, nodeExe, repoDir, egptHome, logPath, cmdLine

Set args = WScript.Arguments
If args.Count < 4 Then
  ' Nobody sees this (the host is windowless), but the exit code is visible to a
  ' human running it by hand, which is how it will be debugged.
  WScript.Quit 2
End If

nodeExe  = args(0)
repoDir  = args(1)
egptHome = args(2)
logPath  = args(3)

cmdLine = "cmd.exe /c cd /d """ & repoDir & """" & _
          " && echo [%DATE% %TIME%] session1-logon-launcher: starting egpt-spine.mjs (EGPT_HOME=" & egptHome & ") >> """ & logPath & """" & _
          " && set ""EGPT_HOME=" & egptHome & """" & _
          " && set ""EGPT_SESSION1=1""" & _
          " && """ & nodeExe & """ ""egpt-spine.mjs"" >> """ & logPath & """ 2>&1"

Set sh = CreateObject("WScript.Shell")
sh.Run cmdLine, 0, False
