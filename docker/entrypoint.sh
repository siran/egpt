#!/bin/bash
# Starts the virtual screen, VNC, Beeper Desktop, and the egpt daemon.
# Beeper and egpt are restarted if they exit.
set -u
log() { echo "[entrypoint] $*"; }

REPO=$HOME/src/egpt
REPO_URL=${EGPT_REPO_URL:-https://github.com/siran/egpt.git}

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
  websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
  log "noVNC on :6080 (http://localhost:6080/vnc.html, same password)"
else
  log "VNC disabled (set VNC_PASSWORD to enable)"
fi

# First boot: the eGPT checkout on its volume. /upgrade pulls it later.
if [ ! -d "$REPO/.git" ]; then
  log "cloning $REPO_URL (main) into $REPO"
  git clone --branch main "$REPO_URL" "$REPO" || { log "clone failed"; exit 1; }
fi
if [ ! -d "$REPO/node_modules" ]; then
  log "npm ci in $REPO"
  (cd "$REPO" && npm ci && npm cache clean --force) || { log "npm ci failed"; exit 1; }
fi

# First boot: seed the profile config from the shipped skeleton.
if [ ! -f "$EGPT_HOME/config/config.yaml" ]; then
  mkdir -p "$EGPT_HOME/config"
  cp "$REPO/config/skeletons/config.yaml" "$EGPT_HOME/config/config.yaml"
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

cd "$REPO"
keep_running egpt node egpt-daemon.mjs &
wait
