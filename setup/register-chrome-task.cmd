@echo off
REM register-chrome-task.cmd — double-clickable wrapper that runs
REM register-chrome-task.ps1. Registers the `egpt-chrome` Task Scheduler task
REM so /chrome can launch Chrome on YOUR desktop (Session 1) from the
REM Session-0 spine. Run once per node.
REM
REM DELIBERATELY DOES NOT ELEVATE, unlike the other setup wrappers: the task is
REM registered for the user that runs this script, and a RunAs prompt could
REM register it for a different admin account instead of you. Registering a task
REM that runs as yourself needs no administrator rights.

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%register-chrome-task.ps1"

if not exist "%PS1%" (
  echo ERROR: register-chrome-task.ps1 not found next to this script.
  echo Expected: %PS1%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === register-chrome-task.ps1 finished successfully ===
) else (
  echo === register-chrome-task.ps1 exited with code %RC% ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
