@echo off
REM share-beeper-primary-profile.cmd - double-click ONCE: run the primary account from your own
REM Beeper window's profile (the window while Beeper is open, the egpt-beeper-primary service
REM otherwise). Backs the profile up first. Asks for administrator itself.
REM Preview, changes nothing:  share-beeper-primary-profile.cmd -DryRun
REM Undo:                      share-beeper-primary-profile.cmd -Revert
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0share-beeper-primary-profile.ps1" -Pause %*
echo.
pause
