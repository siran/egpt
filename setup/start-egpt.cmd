@echo off
REM start-egpt.cmd - THE WAY BACK from stop-egpt.cmd. Double-clickable, or a
REM desktop shortcut. Deletes EGPT_HOME\STOP (printing who stopped the node and
REM why), starts the Session 1 task while you are logged on, then the egpt-daemon service.
REM
REM No elevation, same window rules as stop-egpt.cmd - see the header there.

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%start-egpt.ps1"

set "PROFILE_DIR=%EGPT_HOME%"
if not defined PROFILE_DIR set "PROFILE_DIR=%USERPROFILE%\.egpt"

if not exist "%PS1%" (
  echo ERROR: start-egpt.ps1 not found next to this script.
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
