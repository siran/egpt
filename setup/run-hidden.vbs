' run-hidden.vbs -- truly invisible process launch, no flash.
'
' WHY (operator, 2026-08-17, live: "i still see flashing ... it switches focus and
' disappears"): `powershell.exe -WindowStyle Hidden` still briefly flashes/steals focus
' on some Windows configs -- Windows allocates the console window as part of process
' creation, BEFORE powershell.exe's own code even runs to apply -WindowStyle. wscript.exe
' is a GUI-subsystem host, not a console-subsystem one -- it never allocates a console
' window at all, so there is nothing to flash. This is the standard, long-established
' technique for genuinely invisible scheduled process launches on Windows.
'
' Usage: wscript.exe //B //NoLogo run-hidden.vbs "<full command line to run>"
'   0    = window style: hidden
'   True = wait for the child to exit before this script (and so the wscript.exe
'          process Task Scheduler is tracking) returns -- callers that need Task
'          Scheduler to see the REAL child's lifetime (not just an instant launch-and-
'          exit) depend on this.
Set objShell = CreateObject("WScript.Shell")
cmd = WScript.Arguments(0)
exitCode = objShell.Run(cmd, 0, True)
WScript.Quit(exitCode)
