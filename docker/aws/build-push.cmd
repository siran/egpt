@echo off
REM build-push.cmd - runs build-push.sh in WSL (Ubuntu-22.04) to build the EDW image and push it to ECR.
REM Dry run unless --apply. Arguments pass through:  build-push.cmd --apply
title EDW build-push
wsl -d Ubuntu-22.04 --cd "%~dp0." --exec bash -lc "bash ./build-push.sh %*"
echo.
pause
