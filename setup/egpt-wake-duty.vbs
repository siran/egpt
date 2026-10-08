' egpt-wake-duty.vbs - silent launcher for egpt-wake-duty.ps1 (operator: a visible shell
' popped on every wake). wscript runs the duty PowerShell with window style 0 = fully hidden;
' works under the interactive task principal, no elevation needed.
'
' SELF-LOCATING: it runs the egpt-wake-duty.ps1 sitting BESIDE it, derived from
' WScript.ScriptFullName, so it works whether this file is at src/egpt/setup or the deployed
' bin/egpt/setup - no path is hardcoded to any node or checkout.
'
' ASCII ONLY, same house rule as the .ps1 scripts beside it.

Option Explicit
Dim fso, sh, here, ps1, cmdLine
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "egpt-wake-duty.ps1")

cmdLine = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & ps1 & """"

Set sh = CreateObject("WScript.Shell")
sh.Run cmdLine, 0, False
