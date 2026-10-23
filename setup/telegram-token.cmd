@echo off
REM telegram-token.cmd - double-click to store a Telegram bot token for eGPT.
REM Runs telegram-token.mjs: asks the connection name (default main) and the token, writes
REM %EGPT_HOME%\secrets\telegram-<connection>.token and prints only its length and hash.
REM Optional argument: the connection name.

setlocal
set "MJS=%~dp0telegram-token.mjs"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: node is not on PATH.
  pause
  exit /b 1
)

node "%MJS%" %*
set "RC=%ERRORLEVEL%"
echo.
echo Press any key to close this window.
pause >nul
exit /b %RC%
