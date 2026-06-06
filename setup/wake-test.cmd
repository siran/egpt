@echo off
rem wake-test.cmd — fires from the wake-test scheduled task every PT1M.
rem Logs a timestamped line + connectivity probe + WiFi link state to
rem C:\Users\an\wake-test.log so we can tell, post-test, whether wakes
rem during sleep had the NIC actually up.
rem
rem Format per fire:
rem   <date> <time> tick net=UP|DOWN  rtt=<ms>  wifi=<state>  ip=<addr>
rem
rem net=UP/DOWN is a raw TCP-ish probe (ping ICMP, 1 packet, 500ms)
rem wifi=<state> is the WiFi adapter "Connect state" per netsh
rem ip=<addr>    is the v4 address bound to Wi-Fi (or n/a)
rem
rem Output goes to a SINGLE line per fire (no multi-line blocks) so
rem the log stays grep-able.

setlocal enabledelayedexpansion
set "LOG=C:\Users\an\wake-test.log"
set "TS=%DATE% %TIME%"

rem -- ping 1.1.1.1 once, 500ms timeout, suppress output --
rem    The summary line is: "    Minimum = Nms, Maximum = Nms, Average = Nms"
rem    Splitting on "=" gives token 4 == " Nms" which is what we want.
set "NET=DOWN"
set "RTT=-"
for /f "tokens=4 delims==" %%A in ('ping -n 1 -w 500 1.1.1.1 2^>nul ^| findstr /C:"Average ="') do (
  set "RTT=%%A"
  set "NET=UP"
)
if defined RTT set "RTT=!RTT: =!"

rem -- WiFi adapter state via netsh --
set "WIFI=unknown"
for /f "tokens=2 delims=:" %%S in ('netsh interface show interface name^="Wi-Fi" 2^>nul ^| findstr /C:"Connect state"') do (
  set "WIFI=%%S"
  set "WIFI=!WIFI: =!"
)

rem -- IPv4 bound to Wi-Fi (first match) --
set "IP=n/a"
for /f "tokens=2 delims=:" %%I in ('netsh interface ipv4 show address name^="Wi-Fi" 2^>nul ^| findstr /C:"IP Address"') do (
  set "IP=%%I"
  set "IP=!IP: =!"
  goto :done_ip
)
:done_ip

echo %TS% tick net=%NET% rtt=%RTT% wifi=%WIFI% ip=%IP%>> "%LOG%"
endlocal
