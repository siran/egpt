@echo off
REM run.cmd - runs run.sh in WSL (Ubuntu-22.04) to (re)start the container on the plain-EC2 host.
REM Dry run unless --apply. Arguments pass through:  run.cmd --apply
title egpt run
wsl -d Ubuntu-22.04 --cd "%~dp0." --exec bash -lc "bash ./run.sh %*"
echo.
pause
