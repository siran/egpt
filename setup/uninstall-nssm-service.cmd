@echo off
REM uninstall-nssm-service.cmd — double-clickable wrapper that auto-elevates
REM and runs uninstall-nssm-service.ps1, which asks for the service name and
REM stops + removes that NSSM-wrapped service. egpt-daemon is the Session 0 runner:
REM without it nothing runs the node while nobody is logged on (install-nssm-service.cmd).

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%uninstall-nssm-service.ps1"

REM --- self-elevate if not already admin ---
net session >nul 2>&1
if %errorLevel% NEQ 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

if not exist "%PS1%" (
  echo ERROR: uninstall-nssm-service.ps1 not found next to this script.
  echo Expected: %PS1%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === uninstall-nssm-service.ps1 finished successfully ===
) else (
  echo === uninstall-nssm-service.ps1 exited with code %RC% ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
