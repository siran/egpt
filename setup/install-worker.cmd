@echo off
REM install-worker.cmd — double-clickable wrapper that auto-elevates and runs
REM install-worker.ps1: opens the transcriptor firewall port (private profile)
REM and installs the egpt-daemon Windows Service via NSSM. Use this on a
REM WORKER machine (transcriptor.enabled in ~/.egpt/config.yaml). Prompts once
REM for your Windows password (the service runs as you so it can read ~/.egpt).
REM
REM Reverse with: uninstall-nssm-service.cmd  (+ remove the firewall rule:
REM   Remove-NetFirewallRule -DisplayName egpt-transcriptor)

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%install-worker.ps1"

REM --- self-elevate if not already admin ---
net session >nul 2>&1
if %errorLevel% NEQ 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

if not exist "%PS1%" (
  echo ERROR: install-worker.ps1 not found next to this script.
  echo Expected: %PS1%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === install-worker.ps1 finished successfully ===
) else (
  echo === install-worker.ps1 exited with code %RC% ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
