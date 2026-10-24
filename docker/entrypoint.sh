#!/bin/bash
# Starts the virtual screen, VNC, Beeper Desktop, and the egpt daemon.
# Beeper and egpt are restarted if they exit.
set -u
log() { echo "[entrypoint] $*"; }

REPO=$HOME/src/egpt
REPO_URL=${EGPT_REPO_URL:-https://github.com/siran/egpt.git}

# Virtual screen + a minimal window manager so Beeper's windows behave.
rm -f /tmp/.X99-lock
# -nolisten local: no abstract socket, which a boxed being (docker/egpt-box) could still reach.
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -nolisten local &
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

# A new container is a new pid namespace: pid files left by the previous one name other processes.
rm -f "$EGPT_HOME"/state/daemon-s0.pid "$EGPT_HOME"/state/daemon-s1.pid "$EGPT_HOME"/state/spine.pid

# First boot: the eGPT checkout on its volume. /upgrade pulls it later.
if [ ! -d "$REPO/.git" ]; then
  BRANCH=${EGPT_BRANCH:-main}
  log "cloning $REPO_URL ($BRANCH) into $REPO"
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO" || { log "clone failed"; exit 1; }
else
  log "checkout $REPO on branch $(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
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

if [ "${EGPT_BEEPER:-on}" = off ]; then
  log "Beeper off (EGPT_BEEPER=off)"
else
  # --password-store=basic: no desktop keyring in the container.
  keep_running beeper /opt/beeper/beepertexts --no-sandbox --password-store=basic \
    --disable-gpu >/tmp/beeper.log 2>&1 &
fi

# One long-lived Claude token (claude setup-token) for every being, kept on the data volume so it
# survives restarts and rebuilds. Boxed beings read the same file per turn; replacing it needs a
# container restart for the unboxed ones.
if [ -s "$EGPT_HOME/secrets/claude-oauth.token" ]; then
  CLAUDE_CODE_OAUTH_TOKEN=$(tr -d '\r\n' < "$EGPT_HOME/secrets/claude-oauth.token")
  export CLAUDE_CODE_OAUTH_TOKEN
  log "claude: using secrets/claude-oauth.token"
fi

cd "$REPO"
keep_running egpt node egpt-daemon.mjs &
wait
