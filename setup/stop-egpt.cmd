@echo off
REM stop-egpt.cmd - THE STOP BUTTON. Double-clickable, or a desktop shortcut.
REM Writes EGPT_HOME\STOP (the kill-switch file, so the node stays down across a
REM runner restart or a reboot), stops the egpt-daemon service and the Session 1 task,
REM and kills the daemon tree.
REM
REM Undo with: start-egpt.cmd   (deletes the file, starts the task and the service)
REM
REM No elevation: the task and its processes are the operator's own. The window
REM waits for a key, so the result stays readable.

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%stop-egpt.ps1"

set "PROFILE_DIR=%EGPT_HOME%"
if not defined PROFILE_DIR set "PROFILE_DIR=%USERPROFILE%\.egpt"

if not exist "%PS1%" (
  echo ERROR: stop-egpt.ps1 not found next to this script.
  echo Expected: %PS1%
  echo.
  echo Press any key to close this window.
  pause >nul
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -EgptHome "%PROFILE_DIR%"
echo.
echo Press any key to close this window.
pause >nul
endlocal
