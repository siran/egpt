#!/bin/bash
# Starts the virtual screen, VNC, Beeper Desktop, and the egpt daemon.
# Beeper and egpt are restarted if they exit.
set -u
log() { echo "[entrypoint] $*"; }

# Virtual screen + a minimal window manager so Beeper's windows behave.
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
for _ in $(seq 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
openbox >/dev/null 2>&1 &

# VNC for the one-time login. Requires a password; never runs open.
if [ -n "${VNC_PASSWORD:-}" ]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vncpass >/dev/null
  x11vnc -display :99 -rfbauth /tmp/vncpass -forever -shared -quiet -rfbport 5900 &
  log "VNC on :5900"
else
  log "VNC disabled (set VNC_PASSWORD to enable)"
fi

# First boot: seed the profile config from the shipped skeleton.
if [ ! -f "$EGPT_HOME/config/config.yaml" ]; then
  mkdir -p "$EGPT_HOME/config"
  cp /opt/egpt/config/skeletons/config.yaml "$EGPT_HOME/config/config.yaml"
  log "seeded $EGPT_HOME/config/config.yaml - fill in beeper.main.token"
fi

keep_running() {  # name, command...
  local name=$1; shift
  while true; do
    "$@"; log "$name exited ($?), restarting in 5s"; sleep 5
  done
}

# --password-store=basic: no desktop keyring in the container.
keep_running beeper /opt/beeper/beepertexts --no-sandbox --password-store=basic \
  --disable-gpu >/tmp/beeper.log 2>&1 &

cd /opt/egpt
keep_running egpt node egpt-daemon.mjs &
wait
