@echo off
REM release-sandbox-pin.cmd - double-clickable wrapper for release-sandbox-pin.ps1:
REM returns a pinned sandbox account to the pool (every standing ACE revoked, pin
REM deleted). Pass the pin's key (<being>:<surface>:<chat id>, the key= line of
REM C:\ProgramData\egpt\sandbox-pins\<account>.pin), or run it bare and type it.
REM No elevation.

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%release-sandbox-pin.ps1"

if not exist "%PS1%" (
  echo ERROR: release-sandbox-pin.ps1 not found next to this script.
  echo Expected: %PS1%
  pause
  exit /b 1
)

set "KEY=%~1"
if "%KEY%"=="" set /p "KEY=Pin key to release: "
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Key "%KEY%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === released: nothing is still granted ===
) else if "%RC%"=="2" (
  echo === busy: a live session holds the account - end it and run this again ===
) else (
  echo === exited with code %RC% - read the lines above; the pin is kept ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
