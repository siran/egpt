@echo off
rem egpt-tick.cmd — minimal action for the egpt-tick scheduled task.
rem Appends one line to ~/.egpt/logs/egpt-tick.log so we can verify the
rem PT10M wake fired. The wake side effect (giving the NSSM-managed
rem egpt-daemon service execution time) is the actual purpose; this
rem script's job is just to exist as a wakeable task action.

setlocal
set "LOG=C:\Users\an\.egpt\logs\egpt-tick.log"
if not exist "C:\Users\an\.egpt\logs" mkdir "C:\Users\an\.egpt\logs"
echo %DATE% %TIME% tick>> "%LOG%"
endlocal
