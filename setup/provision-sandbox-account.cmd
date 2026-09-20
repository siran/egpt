@echo off
REM provision-sandbox-account.cmd - double-clickable wrapper that runs
REM provision-sandbox-account.ps1: creates the pool of disposable local accounts
REM (egpt-sbx-00..15) and the egpt-sandbox-pool group, grants the group its
REM standing read-only and traverse ACEs, hardens the credential dir, and sweeps
REM abandoned lease locks. Idempotent - re-run it any time.
REM
REM DELIBERATELY DOES NOT ELEVATE HERE, unlike the other admin wrappers: the .ps1
REM self-elevates on its own (it checks its token, relaunches itself with -Verb
REM RunAs and waits). A RunAs from this file too would put up a SECOND UAC prompt
REM for the same run.
REM
REM IT IS SLOW AND IT IS NOT HUNG. Every step now announces itself before it
REM starts and reports its own elapsed seconds; the grant on ~\src alone measured
REM 307 s on reve. Read the step line, do not close the window.

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%provision-sandbox-account.ps1"

if not exist "%PS1%" (
  echo ERROR: provision-sandbox-account.ps1 not found next to this script.
  echo Expected: %PS1%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === provision-sandbox-account.ps1 finished successfully ===
) else (
  echo === provision-sandbox-account.ps1 exited with code %RC% ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
