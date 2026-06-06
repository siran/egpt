@echo off
REM install-nssm-service.cmd — double-clickable wrapper that auto-elevates
REM and runs install-nssm-service.ps1. Stops the egpt-spine Task Scheduler
REM task, installs egpt-daemon as a Windows Service via NSSM, and starts
REM it. Prompts once for your Windows password (used by SCM to run the
REM service as you, so it can read ~/.egpt).
REM
REM Reverse with: uninstall-nssm-service.cmd

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%install-nssm-service.ps1"

REM --- self-elevate if not already admin ---
net session >nul 2>&1
if %errorLevel% NEQ 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

if not exist "%PS1%" (
  echo ERROR: install-nssm-service.ps1 not found next to this script.
  echo Expected: %PS1%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === install-nssm-service.ps1 finished successfully ===
) else (
  echo === install-nssm-service.ps1 exited with code %RC% ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
