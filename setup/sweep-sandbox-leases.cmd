@echo off
REM sweep-sandbox-leases.cmd - double-clickable wrapper that runs
REM sweep-sandbox-leases.ps1: revokes the filesystem ACEs that abandoned sandbox
REM leases left granted to pool accounts, releases their lock files, and prints
REM every path it took an ACE off.
REM
REM RUN IT WHEN a pool account still has access to a conversation it is not
REM working in - which is the normal residue of turns ending by TerminateProcess.
REM Safe to run at any time, including mid-turn: a LIVE lease holds its lock open
REM and is reported and left alone, never revoked.
REM
REM NO ELEVATION, and no UAC prompt: the operator already owns the folders these
REM ACEs are on, and removing an ACE needs nothing more. (Re-provisioning the
REM pool does need admin - that is provision-sandbox-account.cmd, which also runs
REM this sweep as its last step.)
REM
REM Idempotent: a second run over a cleared pool writes nothing and reports zero.
REM Pass --whatif on the command line to see what it WOULD revoke and touch
REM nothing.

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%sweep-sandbox-leases.ps1"

if not exist "%PS1%" (
  echo ERROR: sweep-sandbox-leases.ps1 not found next to this script.
  echo Expected: %PS1%
  pause
  exit /b 1
)

if /I "%~1"=="--whatif" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -WhatIf
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
)
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === sweep-sandbox-leases.ps1 finished: nothing is still granted ===
) else (
  echo === sweep-sandbox-leases.ps1 exited with code %RC% - read the STILL GRANTED lines above ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
