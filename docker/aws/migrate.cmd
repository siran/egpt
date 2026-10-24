@echo off
REM migrate.cmd - runs migrate.sh in WSL (Ubuntu-22.04) to move EDW's state from the laptop to the AWS instance.
REM Dry run unless --apply. Arguments pass through:  migrate.cmd --apply
title EDW migrate
wsl -d Ubuntu-22.04 --cd "%~dp0." --exec bash -lc "bash ./migrate.sh %*"
echo.
pause
