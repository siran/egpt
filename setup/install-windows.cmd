@echo off
REM setup/install-windows.cmd — double-clickable installer for Windows.
REM
REM Self-elevates via UAC (a single "Yes" prompt) and runs install-windows.ps1.
REM Idempotent: re-run to update / repair / migrate from the old setup.
REM
REM What it does:
REM   1. Removes legacy tasks 'egpt-daemon-headless' and 'egpt-watchdog'
REM      (kills their running processes via the Task Scheduler service).
REM   2. Registers a single new task 'egpt-daemon' that runs
REM      `node egpt-daemon.mjs --headless` directly (no PowerShell wrapper).
REM   3. Starts it. Restart-on-failure is built into the task settings.

powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0install-windows.ps1' -Verb RunAs"
