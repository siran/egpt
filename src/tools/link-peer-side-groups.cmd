@echo off
REM link-peer-side-groups.cmd - launcher for link-peer-side-groups.mjs.
REM Dry run:  link-peer-side-groups.cmd <copy of the peer's conversations.yaml> --peer kg
REM Add --apply to write; refused while this node's spine runs.
setlocal
node "%~dp0link-peer-side-groups.mjs" %*
echo.
pause
