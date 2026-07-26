@echo off
REM start-egpt.cmd — THE WAY BACK from stop-egpt.cmd. Double-clickable, or a
REM desktop shortcut. Deletes EGPT_HOME\STOP (printing who stopped the node and
REM why) and starts the NSSM service.
REM
REM Same window + quoting rules as stop-egpt.cmd — see the header there.
REM -NoExit on the elevated PowerShell, so the window cannot close by itself;
REM the argument string is built with [char]34 (backslash-escaped quotes and
REM -ArgumentList @(...) both fail, the latter truncating at the first space).

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%start-egpt.ps1"

REM --- which profile? Resolved BEFORE elevating (UAC may run the elevated instance
REM     under another account whose EGPT_HOME / USERPROFILE is not yours) ---
set "PROFILE_DIR=%EGPT_HOME%"
if not defined PROFILE_DIR set "PROFILE_DIR=%USERPROFILE%\.egpt"

if not exist "%PS1%" (
  echo ERROR: start-egpt.ps1 not found next to this script.
  echo Expected: %PS1%
  echo.
  echo Press any key to close this window.
  pause >nul
  exit /b 1
)

REM --- already elevated? run it here, in this window ---
net session >nul 2>&1
if %errorLevel% EQU 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -EgptHome "%PROFILE_DIR%"
  echo.
  echo Press any key to close this window.
  pause >nul
  exit /b
)

REM --- not elevated: hand the .ps1 to an elevated PowerShell that STAYS OPEN ---
echo Requesting administrator privileges...
powershell -NoProfile -Command "$q=[char]34; try { Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoExit -NoProfile -ExecutionPolicy Bypass -File ' + $q + '%PS1%' + $q + ' -EgptHome ' + $q + '%PROFILE_DIR%' + $q) -Verb RunAs -ErrorAction Stop } catch { Write-Host ('Elevation failed or was declined: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 (
  echo.
  echo === Could not get administrator privileges - egpt was NOT started ===
  echo.
  echo Press any key to close this window.
  pause >nul
  exit /b 1
)

echo An elevated window has opened with the result. Close it when you are done.
endlocal
