@echo off
REM stop-egpt.cmd — THE STOP BUTTON. Double-clickable wrapper that auto-elevates
REM and runs stop-egpt.ps1: writes EGPT_HOME\STOP (the kill-switch file, so the
REM node stays down across a service restart or a reboot) and then stops the
REM NSSM service.
REM
REM Undo with: start-egpt.cmd   (deletes the file, starts the service)

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%stop-egpt.ps1"

REM --- which profile? Resolved BEFORE elevating and handed to the elevated copy:
REM     UAC can run the elevated instance under a different account, whose
REM     EGPT_HOME / USERPROFILE are NOT yours — and a STOP file written into the
REM     wrong profile stops nothing. %~1 is the value passed by the first pass.
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
    echo === Could not get administrator privileges - egpt was NOT stopped ===
    echo.
    echo Press any key to close this window.
    pause >nul
  )
  exit /b
)

if not exist "%PS1%" (
  echo ERROR: stop-egpt.ps1 not found next to this script.
  echo Expected: %PS1%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -EgptHome "%PROFILE_DIR%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === stop-egpt.ps1 finished successfully ===
) else (
  echo === stop-egpt.ps1 exited with code %RC% ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
