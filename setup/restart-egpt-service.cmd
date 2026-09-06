@echo off
REM restart-egpt-service.cmd - double-clickable wrapper that auto-elevates and
REM runs restart-egpt-service.ps1: a clean stop, an orphan sweep scoped to that
REM one node, and a start.
REM
REM Double-click restarts the DEFAULT node, egpt-daemon (profile ~/.egpt).
REM To restart another node, pass its service name as the only argument:
REM
REM   restart-egpt-service.cmd                 (= egpt-daemon,  ~/.egpt)
REM   restart-egpt-service.cmd egpt2-daemon    (=              ~/.egpt2)
REM
REM A shortcut is the double-click way to the second one: point it at this file
REM with the service name appended in the Target box.

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%restart-egpt-service.ps1"
set "SVC=%~1"

REM --- self-elevate if not already admin (forwarding the service name) ---
net session >nul 2>&1
if %errorLevel% NEQ 0 (
  echo Requesting administrator privileges...
  if defined SVC (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%SVC%' -Verb RunAs"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  )
  exit /b
)

if not exist "%PS1%" (
  echo ERROR: restart-egpt-service.ps1 not found next to this script.
  echo Expected: %PS1%
  pause
  exit /b 1
)

if defined SVC (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -ServiceName "%SVC%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
)
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === restart-egpt-service.ps1 finished successfully ===
) else (
  echo === restart-egpt-service.ps1 exited with code %RC% ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
