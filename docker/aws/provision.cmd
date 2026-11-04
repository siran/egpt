@echo off
REM provision.cmd - runs provision.sh in WSL (Ubuntu-22.04) to create the plain-EC2 host (VPC, role, volume, instance).
REM Dry run unless --apply. Arguments pass through:  provision.cmd --apply
title egpt provision
wsl -d Ubuntu-22.04 --cd "%~dp0." --exec bash -lc "bash ./provision.sh %*"
echo.
pause
