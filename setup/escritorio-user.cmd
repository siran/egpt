@echo off
REM escritorio-user.cmd - double-click to add, remove or list a chatbox client's escritorio staff.
REM Runs escritorio-user.mjs: asks the client, the action and the username, and for add the password
REM twice (not shown). Writes %EGPT_HOME%\secrets\chatbox-<client>-escritorio.users.
REM Optional arguments: <client> add|remove|list [<username>]

setlocal
set "MJS=%~dp0escritorio-user.mjs"

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
