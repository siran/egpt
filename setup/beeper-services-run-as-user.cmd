@echo off
REM beeper-services-run-as-user.cmd - run this machine's Beeper services as you instead of
REM LocalSystem (asks your Windows password in a dialog; never stored). Asks for administrator itself.
REM A service with no --user-data-dir of its own is refused (it would open your window's profile).
REM Preview, changes nothing:  beeper-services-run-as-user.cmd -DryRun
REM One service only:          beeper-services-run-as-user.cmd -ServiceName egpt-beeper-secondary
REM Undo:                      beeper-services-run-as-user.cmd -Revert
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0beeper-services-run-as-user.ps1" -Pause %*
echo.
pause
