@echo off
REM lockdown.cmd — double-clickable wrapper for lockdown.ps1. Auto-elevates
REM (UAC) because the takeown step needs admin if any subdir is currently
REM owned by BUILTIN\Administrators (which is the case after an admin-run
REM install-nssm-service).

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%lockdown.ps1"

REM --- self-elevate if not already admin ---
net session >nul 2>&1
if %errorLevel% NEQ 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

if not exist "%PS1%" (
  echo ERROR: lockdown.ps1 not found next to this script.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === lockdown.ps1 finished successfully ===
) else (
  echo === lockdown.ps1 exited with code %RC% ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
