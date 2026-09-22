@echo off
REM provision-service-account.cmd - double-clickable wrapper that auto-elevates
REM and runs provision-service-account.ps1: creates the local, NON-administrator
REM service account (default egpt-svc), checks its Windows profile exists, and
REM installs a supplied public key into its ~\.ssh\authorized_keys with an ACL
REM sshd will accept. Idempotent - re-run it any time; a run that changes
REM nothing writes nothing.
REM
REM WHY THE KEY GOES ON A SEPARATE, NON-ADMINISTRATOR ACCOUNT: sshd's shipped
REM "Match Group administrators" block makes it read ONLY
REM C:\ProgramData\ssh\administrators_authorized_keys for an administrator, so a
REM key in an admin's own ~\.ssh\authorized_keys is silently ignored. The .ps1's
REM header carries the measurement.
REM
REM IT ELEVATES HERE, unlike provision-sandbox-account.cmd (whose .ps1
REM self-elevates): provision-service-account.ps1 deliberately REFUSES to run
REM unelevated rather than relaunching itself, so this wrapper is what puts up
REM the single UAC prompt.
REM
REM Double-clicked with no arguments it asks for the path to the .pub file.
REM Arguments, if you pass any, are forwarded to the .ps1 as typed - fine for
REM ordinary paths and switches (-AccountName, -WhatIf, -Force), not for a path
REM containing a single quote. For anything fancier, run the .ps1 directly from
REM an elevated PowerShell.
REM
REM NO GOTO IN HERE, deliberately: every other .cmd in this directory is stored
REM with LF line endings and cmd.exe reads a batch file by byte offset, which is
REM exactly what makes a label jump in an LF-only file go wrong. The prompt is
REM split across two IF blocks instead, because a variable set inside a
REM parenthesised block cannot be read back in that same block without delayed
REM expansion (which would in turn eat a "!" in a pasted path).

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%provision-service-account.ps1"

REM --- self-elevate if not already admin ---
net session >nul 2>&1
if %errorLevel% NEQ 0 (
  echo Requesting administrator privileges...
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  )
  exit /b
)

if not exist "%PS1%" (
  echo ERROR: provision-service-account.ps1 not found next to this script.
  echo Expected: %PS1%
  pause
  exit /b 1
)

set "KEYPATH="
if "%~1"=="" (
  echo.
  echo Paste the path to the PUBLIC key file to install - an id_*.pub from the
  echo peer node. The .pub, never the private half.
  echo.
  set /p "KEYPATH=Public key file: "
)

REM Strip any quotes the paste brought with it; the call below adds its own.
if defined KEYPATH set KEYPATH=%KEYPATH:"=%

if "%~1"=="" (
  if not defined KEYPATH (
    echo.
    echo No path given - nothing to do.
    echo.
    pause
    exit /b 1
  )
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -PublicKeyPath "%KEYPATH%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
)
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo === provision-service-account.ps1 finished successfully ===
) else if "%RC%"=="2" (
  echo === provision-service-account.ps1 STOPPED and needs one manual step ===
  echo === read the STOP block above, do it, then run this again          ===
) else (
  echo === provision-service-account.ps1 exited with code %RC% ===
)
echo.
echo Press any key to close this window.
pause >nul
endlocal
