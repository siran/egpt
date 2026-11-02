@echo off
REM ecs-cutover.cmd - runs ecs-cutover.sh in WSL (Ubuntu-22.04) to move EDW from edw-node to the ECS service (or --rollback); for a new deployment, start it.
REM Dry run unless --apply. Arguments pass through:  ecs-cutover.cmd [--deploy nu] --apply
title egpt ecs-cutover %*
wsl -d Ubuntu-22.04 --cd "%~dp0." --exec bash -lc "bash ./ecs-cutover.sh %*"
echo.
pause
