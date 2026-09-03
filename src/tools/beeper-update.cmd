@echo off
REM beeper-update.cmd - double-clickable launcher for beeper-update.ps1.
REM The .ps1 self-elevates, so a plain double-click is enough; the UAC prompt comes from there.
REM Any arguments are passed straight through:  beeper-update.cmd -WhatIf
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0beeper-update.ps1" %*
echo.
pause
