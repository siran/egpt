@echo off
REM enable-worker-llm.cmd - double-clickable wrapper that auto-elevates and
REM runs enable-worker-llm.ps1: opens the llama-server firewall port (default
REM 8080, Private profile) and restarts egpt-daemon so it picks up the
REM local_llm block in ~/.egpt/config.yaml. Run on a WORKER that hosts @l.
REM
REM Reverse: Remove-NetFirewallRule -DisplayName egpt-llama  (+ set
REM local_llm.enabled: false in config.yaml and restart the service)

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%enable-worker-llm.ps1"

net session >nul 2>&1
if %errorLevel% NEQ 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

if not exist "%PS1%" (
  echo ERROR: enable-worker-llm.ps1 not found next to this script.
  echo Expected: %PS1%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === enable-worker-llm.ps1 finished successfully ===
) else (
  echo === enable-worker-llm.ps1 exited with code %RC% ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
