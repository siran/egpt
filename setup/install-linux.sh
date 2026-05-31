#!/usr/bin/env bash
# setup/install-linux.sh — register egpt-daemon as a systemd user unit.
#
# The user-mode systemd unit runs without root, restarts the daemon on any
# exit (Restart=always), and starts at boot via linger if you enable it.
# It's the OUTER supervisor; egpt-daemon.mjs itself supervises the egpt.mjs
# child + runs the integrated heartbeat watchdog (operator 2026-05-31).
#
# Install:
#   bash setup/install-linux.sh
#
# After install:
#   systemctl --user status egpt
#   systemctl --user restart egpt
#   journalctl --user -u egpt -f       (live logs)
#
# To start at boot without an active login session:
#   sudo loginctl enable-linger "$USER"

set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
REPO_ROOT=$( dirname "$SCRIPT_DIR" )
NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then echo "node not found in PATH"; exit 1; fi

UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/egpt.service"
mkdir -p "$UNIT_DIR"

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=egpt — personal WA/TG bridge daemon
After=network-online.target

[Service]
Type=simple
ExecStart=$NODE_BIN $REPO_ROOT/egpt-daemon.mjs --headless
WorkingDirectory=$REPO_ROOT
Restart=always
RestartSec=2
# Use SIGTERM and give the daemon a few seconds to flush bridges before SIGKILL.
KillSignal=SIGTERM
TimeoutStopSec=10
# Capture stdout/stderr to journald; the daemon also writes ~/.egpt/headless.log
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

echo "wrote $UNIT_PATH"

systemctl --user daemon-reload
systemctl --user enable egpt.service
systemctl --user restart egpt.service

echo
echo "installed and started. status:"
systemctl --user --no-pager status egpt.service || true
echo
echo "to follow logs:    journalctl --user -u egpt -f"
echo "to start at boot:  sudo loginctl enable-linger \"$USER\""
