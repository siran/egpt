' beeper-window.vbs - silent launcher for beeper-window.ps1 beside it (the HKCU Run value and the
' "Beeper (eGPT)" shortcut point here). Window style 0 = hidden; does not wait.
' ASCII ONLY, same house rule as the .ps1 scripts beside it.

Option Explicit
Dim fso, sh, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
ps1 = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "beeper-window.ps1")
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
