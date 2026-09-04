@echo off
REM beeper-whoami.cmd - double-clickable launcher for beeper-whoami.mjs.
REM Read-only: it asks every local port who is there and prints one table. No admin, no UAC.
REM Any arguments are passed straight through:  beeper-whoami.cmd --host other-node
setlocal
node "%~dp0beeper-whoami.mjs" %*
echo.
pause
