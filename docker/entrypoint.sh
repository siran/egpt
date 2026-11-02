#!/bin/bash
# Starts the virtual screen, VNC, Beeper Desktop, and the egpt daemon.
# Beeper and egpt are restarted if they exit.
set -u
log() { echo "[entrypoint] $*"; }

keep_running() {  # name, command...
  local name=$1; shift
  while true; do
    "$@"; log "$name exited ($?), restarting in 5s"; sleep 5
  done
}

REPO=$HOME/src/egpt
REPO_URL=${EGPT_REPO_URL:-https://github.com/siran/egpt.git}

# Virtual screen + a minimal window manager so Beeper's windows behave.
rm -f /tmp/.X99-lock
# -nolisten local: no abstract socket, which a boxed being (docker/egpt-box) could still reach.
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -nolisten local &
for _ in $(seq 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
openbox >/dev/null 2>&1 &

# VNC for the one-time login. Requires a password; never runs open.
# Without VNC_PASSWORD the password lives in secrets/vnc.password (made once, 0600), like the other tokens.
if [ -z "${VNC_PASSWORD:-}" ]; then
  VNC_FILE=$EGPT_HOME/secrets/vnc.password
  if [ ! -s "$VNC_FILE" ]; then
    (umask 077 && mkdir -p "$EGPT_HOME/secrets" && head -c 6 /dev/urandom | base64 > "$VNC_FILE") \
      && log "generated $VNC_FILE"
  fi
  VNC_PASSWORD=$(tr -d '\r\n' 2>/dev/null < "$VNC_FILE")
fi
if [ -n "${VNC_PASSWORD:-}" ]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vncpass >/dev/null
  x11vnc -display :99 -rfbauth /tmp/vncpass -forever -shared -quiet -rfbport 5900 &
  log "VNC on :5900"
  websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
  log "noVNC on :6080 (http://localhost:6080/vnc.html, same password)"
else
  log "VNC disabled (no VNC_PASSWORD and no readable $VNC_FILE)"
fi

# SSH (EGPT_SSH_PORT): sshd as egpt, keys only. Host key (made once) and authorized_keys in secrets/ssh/.
if [ -n "${EGPT_SSH_PORT:-}" ]; then
  SSH_DIR=$EGPT_HOME/secrets/ssh
  (umask 077 && mkdir -p "$SSH_DIR")
  if [ ! -s "$SSH_DIR/ssh_host_ed25519_key" ]; then
    ssh-keygen -q -t ed25519 -N '' -f "$SSH_DIR/ssh_host_ed25519_key" </dev/null \
      && log "generated $SSH_DIR/ssh_host_ed25519_key"
  fi
  [ -s "$SSH_DIR/authorized_keys" ] || log "ssh: no keys yet; put public keys in $SSH_DIR/authorized_keys"
  # EGPT_SSH_PERMIT_LISTEN: remote forwards too, listening only on those host:port (GatewayPorts no: loopback).
  FWD=local
  [ -z "${EGPT_SSH_PERMIT_LISTEN:-}" ] || FWD="yes"$'\n'"PermitListen $EGPT_SSH_PERMIT_LISTEN"
  (umask 077 && cat >/tmp/sshd_config <<CFG
Port $EGPT_SSH_PORT
HostKey $SSH_DIR/ssh_host_ed25519_key
AuthorizedKeysFile $SSH_DIR/authorized_keys
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
AllowUsers egpt
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding $FWD
PermitTunnel no
PidFile /tmp/sshd.pid
ClientAliveInterval 60
SetEnv EGPT_HOME=$EGPT_HOME CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR DISPLAY=$DISPLAY
Subsystem sftp internal-sftp
CFG
  )
  keep_running sshd /usr/sbin/sshd -D -e -f /tmp/sshd_config >/tmp/sshd.log 2>&1 &
  log "sshd on :$EGPT_SSH_PORT (log /tmp/sshd.log)"
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

# EGPT_BEEPER=primary,secondary: one Beeper Desktop per account, all on the same screen.
# The first keeps the default profile, the others use ~/.config/BeeperTexts-<name> (Beeper's own
# BEEPER_PROFILE naming). Instance i serves its Desktop API on 23373+i, inside egpt's token lookup.
beeper_run() {  # index profile-dir
  env BEEPER_USER_DATA_DIR="$2" /opt/beeper/beepertexts --no-sandbox --password-store=basic \
    --disable-gpu --pas-port=$((23373 + $1)) &
  local pid=$!
  # Beeper centres every new window on the same spot; give each instance its own.
  timeout 300 xdotool search --sync --all --onlyvisible --pid $pid --class Beeper \
    windowmove %@ $((20 + $1 % 3 * 480)) $((20 + 60 * ($1 / 3))) >/dev/null 2>&1 &
  wait $pid
}

start_beepers() {  # list
  local names name dir out i=0 seen=' '
  IFS=', ' read -r -a names <<<"$1"
  for name in "${names[@]}"; do
    if [[ ! $name =~ ^[A-Za-z0-9_-]+$ || $seen == *" $name "* || $i -ge 10 ]]; then
      log "beeper: skipping '$name'"; continue
    fi
    seen+="$name "
    dir=$HOME/.config/BeeperTexts; [ $i = 0 ] || dir+=-$name
    out=/tmp/beeper-$name.log
    mkdir -p "$dir"
    mountpoint -q "$dir" || log "beeper $name: $dir is not a mounted volume; its login goes with the container"
    log "beeper $name: profile $dir, Desktop API 127.0.0.1:$((23373 + i)), log $out"
    keep_running "beeper $name" beeper_run $i "$dir" >"$out" 2>&1 &
    i=$((i + 1))
  done
}

if [ "${EGPT_BEEPER:-on}" = off ]; then
  log "Beeper off (EGPT_BEEPER=off)"
elif [ "${EGPT_BEEPER:-on}" = on ]; then
  # --password-store=basic: no desktop keyring in the container.
  keep_running beeper /opt/beeper/beepertexts --no-sandbox --password-store=basic \
    --disable-gpu >/tmp/beeper.log 2>&1 &
else
  start_beepers "$EGPT_BEEPER"
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
