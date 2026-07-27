@echo off
REM upgrade.cmd -- double-clickable wrapper for the EVERYDAY deploy: drops /upgrade in the
REM ingest box and waits for the spine's heartbeat to prove it came back.
REM
REM DOES NOT ELEVATE, and does not need to: it writes one file inside your own profile.
REM Use deploy.cmd/deploy.ps1 instead for a SUPERVISOR-level change (entry-point rename),
REM which restarts the service and does need UAC.

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%upgrade.ps1"

if not exist "%PS1%" (
  echo ERROR: upgrade.ps1 not found next to this script.
  echo Expected: %PS1%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === upgrade.ps1 finished successfully ===
) else (
  echo === upgrade.ps1 exited with code %RC% ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
