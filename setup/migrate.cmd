@echo off
REM migrate.cmd -- double-clickable wrapper for setup\migrate.mjs: bring THIS node's structure
REM forward by running the pending migrations\NNNN-*.mjs in order.
REM
REM A plain double-click runs what needs no elevation and reports the rest as PENDING.
REM Right-click > Run as administrator to apply those too. Arguments pass straight through:
REM   migrate.cmd --dry-run
REM   migrate.cmd --egpt-home "C:\Users\an\.egpt"

setlocal
set "MJS=%~dp0migrate.mjs"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: node is not on PATH.
  pause
  exit /b 1
)

node "%MJS%" %*
set "RC=%ERRORLEVEL%"

echo.
echo === migrate.mjs exited with code %RC% ===
echo Press any key to close this window.
pause >nul
exit /b %RC%
