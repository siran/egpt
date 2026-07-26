@echo off
REM start-egpt.cmd — THE WAY BACK from stop-egpt.cmd. Double-clickable wrapper
REM that auto-elevates and runs start-egpt.ps1: deletes EGPT_HOME\STOP (printing
REM who stopped the node and why) and starts the NSSM service.

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%start-egpt.ps1"

REM --- which profile? Resolved BEFORE elevating and handed to the elevated copy
REM     (UAC may run it under another account whose EGPT_HOME is not yours) ---
set "PROFILE_DIR=%~1"
if not defined PROFILE_DIR set "PROFILE_DIR=%EGPT_HOME%"
if not defined PROFILE_DIR set "PROFILE_DIR=%USERPROFILE%\.egpt"

REM --- self-elevate if not already admin ---
net session >nul 2>&1
if %errorLevel% NEQ 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "try { Start-Process -FilePath '%~f0' -ArgumentList '\"%PROFILE_DIR%\"' -Verb RunAs -ErrorAction Stop } catch { Write-Host ('Elevation failed or was declined: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
  if errorlevel 1 (
    echo.
    echo === Could not get administrator privileges - egpt was NOT started ===
    echo.
    echo Press any key to close this window.
    pause >nul
  )
  exit /b
)

if not exist "%PS1%" (
  echo ERROR: start-egpt.ps1 not found next to this script.
  echo Expected: %PS1%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -EgptHome "%PROFILE_DIR%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === start-egpt.ps1 finished successfully ===
) else (
  echo === start-egpt.ps1 exited with code %RC% ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
