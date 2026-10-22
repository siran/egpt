@echo off
REM beeper-window.cmd - open Beeper on the profile it shares with the egpt-beeper-primary service
REM (stops the service first; starts it again when Beeper exits). Keeps running while Beeper is open.
REM Preview, changes nothing:  beeper-window.cmd -DryRun
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0beeper-window.ps1" %*
