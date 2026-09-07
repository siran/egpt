@echo off
REM beeper-mint-token.cmd - double-clickable launcher for beeper-mint-token.mjs.
REM Mints a Desktop API token for the Beeper on port 23373 (the Session 1 GUI, usually).
REM YOU MUST APPROVE THE PROMPT THAT APPEARS IN BEEPER - the tool blocks until you do.
REM Any arguments are passed straight through:  beeper-mint-token.cmd --port 23378
setlocal
node "%~dp0beeper-mint-token.mjs" %*
echo.
pause
