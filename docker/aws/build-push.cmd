@echo off
REM build-push.cmd - runs build-push.sh in WSL (Ubuntu-22.04) to build the image and push it to the deployment's ECR.
REM Dry run unless --apply. Arguments pass through:  build-push.cmd [--deploy <name>] --apply
title egpt build-push %*
wsl -d Ubuntu-22.04 --cd "%~dp0." --exec bash -lc "bash ./build-push.sh %*"
echo.
pause
