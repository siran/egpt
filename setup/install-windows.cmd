@echo off
setlocal

REM setup/install-windows.cmd  --  double-click installer for egpt-daemon.
REM Self-elevates via UAC, then runs install-windows.ps1 in the elevated
REM shell. Pauses at the end so output stays visible if anything errors.

REM ---- self-elevate ----
net session >nul 2>&1
if errorlevel 1 (
  echo Not admin -- requesting elevation. Click Yes on the UAC prompt.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

REM ---- elevated from here ----
echo.
echo Admin OK. Running install-windows.ps1 ...
echo.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "install-windows.ps1"
set EXITCODE=%errorlevel%

echo.
echo ====================================================================
echo install-windows.ps1 exited with code %EXITCODE%
echo Log:  %USERPROFILE%\.egpt\install-windows.log
echo ====================================================================
echo.
pause
