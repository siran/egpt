@echo off
REM install-tick-task.cmd - double-clickable wrapper that auto-elevates
REM and runs install-tick-task.ps1.

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%install-tick-task.ps1"

net session >nul 2>&1
if %errorLevel% NEQ 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

if not exist "%PS1%" (
  echo ERROR: install-tick-task.ps1 not found.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === install-tick-task.ps1 finished ===
) else (
  echo === install-tick-task.ps1 exited with code %RC% ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
