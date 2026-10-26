@echo off
REM chrome-signin.cmd - open an eGPT browser profile in a plain Chrome window, to sign in or pass a check
REM yourself; eGPT's Chrome on that profile is closed first and reuses the session afterwards.
REM Usage: chrome-signin.cmd [profile] [url]   (default: brain, Google sign-in; quote a url with &)
REM While the node runs, prefer the chat command: /<handle> browser refresh [url]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0chrome-signin.ps1" %*
echo.
echo Press any key to close this window.
pause >nul
