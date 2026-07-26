@echo off
REM stop-egpt.cmd — THE STOP BUTTON. Double-clickable, or a desktop shortcut.
REM Writes EGPT_HOME\STOP (the kill-switch file, so the node stays down across a
REM service restart or a reboot) and then stops the NSSM service.
REM
REM Undo with: start-egpt.cmd   (deletes the file, starts the service)
REM
REM WINDOW (live report 2026-07-26: UAC accepted, window vanished, service still
REM running, no STOP file): elevation now launches POWERSHELL WITH -NoExit, so the
REM elevated window CANNOT close by itself whatever happens inside — the operator
REM reads the result and closes it. The old shape re-launched THIS .cmd elevated and
REM relied on reaching a `pause` at the very end; anything exiting early took the
REM window with it. Nothing here depends on reaching a pause any more.
REM
REM QUOTING: the argument string is built with [char]34, not backslash-escaped
REM quotes. Round-trip verified with a path containing spaces. Two forms that do NOT
REM work and must not be reintroduced: -ArgumentList @('-File',$p,...) TRUNCATES at
REM the first space, and cmd's \" escaping does not survive cmd -> PowerShell here.

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%stop-egpt.ps1"

REM --- which profile? Resolved BEFORE elevating: UAC can run the elevated instance
REM     under a different account whose EGPT_HOME / USERPROFILE are NOT yours, and a
REM     STOP file written into the wrong profile stops nothing.
set "PROFILE_DIR=%EGPT_HOME%"
if not defined PROFILE_DIR set "PROFILE_DIR=%USERPROFILE%\.egpt"

if not exist "%PS1%" (
  echo ERROR: stop-egpt.ps1 not found next to this script.
  echo Expected: %PS1%
  echo.
  echo Press any key to close this window.
  pause >nul
  exit /b 1
)

REM --- already elevated (e.g. a shortcut with "Run as administrator", or an admin
REM     console)? then run it right here, in this window.
net session >nul 2>&1
if %errorLevel% EQU 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -EgptHome "%PROFILE_DIR%"
  echo.
  echo Press any key to close this window.
  pause >nul
  exit /b
)

REM --- not elevated: hand the .ps1 straight to an elevated PowerShell that STAYS OPEN.
echo Requesting administrator privileges...
powershell -NoProfile -Command "$q=[char]34; try { Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoExit -NoProfile -ExecutionPolicy Bypass -File ' + $q + '%PS1%' + $q + ' -EgptHome ' + $q + '%PROFILE_DIR%' + $q) -Verb RunAs -ErrorAction Stop } catch { Write-Host ('Elevation failed or was declined: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 (
  echo.
  echo === Could not get administrator privileges - egpt was NOT stopped ===
  echo.
  echo Press any key to close this window.
  pause >nul
  exit /b 1
)

echo An elevated window has opened with the result. Close it when you are done.
endlocal
