@echo off
REM ayde-user.cmd - double-click to add, re-level, remove or list the /ayde users.
REM Runs ayde-user.mjs: asks the action, the username and the level (team, devs, admin, root), and for
REM add the password twice (not shown). Writes %EGPT_HOME%\secrets\ayde.users.
REM Optional arguments: add <user> <level> | set-level <user> <level> | remove <user> | list

setlocal
set "MJS=%~dp0ayde-user.mjs"

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
