@echo off
REM migrate.cmd - runs migrate.sh in WSL (Ubuntu-22.04) to move the local container's state to the plain-EC2 host.
REM Dry run unless --apply. Arguments pass through:  migrate.cmd --apply
title egpt migrate
wsl -d Ubuntu-22.04 --cd "%~dp0." --exec bash -lc "bash ./migrate.sh %*"
echo.
pause
