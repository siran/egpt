@echo off
REM ecs-provision.cmd - runs ecs-provision.sh in WSL (Ubuntu-22.04) to create EDW's ECS cluster, launch template, ASG, task definition and service.
REM Dry run unless --apply. Arguments pass through:  ecs-provision.cmd --apply
title EDW ecs-provision
wsl -d Ubuntu-22.04 --cd "%~dp0." --exec bash -lc "bash ./ecs-provision.sh %*"
echo.
pause
