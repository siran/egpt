@echo off
REM uninstall-tick-task.cmd - remove the egpt-tick scheduled task.

setlocal
net session >nul 2>&1
if %errorLevel% NEQ 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

schtasks /End    /TN egpt-tick 2>&1
schtasks /Delete /TN egpt-tick /F 2>&1

echo.
echo Press any key to close this window.
pause >nul
endlocal
