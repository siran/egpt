@echo off
REM beeper-window.cmd - open Beeper on the profile it shares with the egpt-beeper-primary service
REM (stops the service first; reopens Beeper when it exits). Keeps running until logoff.
REM Preview, changes nothing:  beeper-window.cmd -DryRun
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0beeper-window.ps1" %*
