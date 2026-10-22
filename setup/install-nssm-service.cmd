@echo off
REM install-nssm-service.cmd - double-click at the console: install (or bring up to date) the
REM egpt-daemon service, the Session 0 runner. It runs eGPT as you while nobody is logged on; at
REM logon the Session 1 task takes over. Asks your Windows password in a dialog (checked, never
REM stored) and asks for administrator itself. Not over ssh: the password dialog would hang.
REM Preview, changes nothing:  install-nssm-service.cmd -DryRun
REM Remove:                    uninstall-nssm-service.cmd
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-nssm-service.ps1" -Pause %*
echo.
pause
