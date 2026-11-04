@echo off
REM ecs-deploy.cmd - runs ecs-deploy.sh in WSL (Ubuntu-22.04) to point a deployment's ECS service at the image in ECR (pinned by digest).
REM Dry run unless --apply. Arguments pass through:  ecs-deploy.cmd [--deploy <name>] --apply
title egpt ecs-deploy %*
wsl -d Ubuntu-22.04 --cd "%~dp0." --exec bash -lc "bash ./ecs-deploy.sh %*"
echo.
pause
