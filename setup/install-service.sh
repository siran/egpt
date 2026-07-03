#!/usr/bin/env bash
# install-service.sh -- install egpt-daemon as a per-user service.
#
# Auto-detects the platform and does the equivalent of what the Windows
# install-nssm-service.{ps1,cmd} pair does:
#
#   macOS:  writes ~/Library/LaunchAgents/com.egpt.daemon.plist and loads
#           it via `launchctl load`. KeepAlive + RunAtLoad so the daemon
#           starts at login and auto-restarts on crash.
#
#   Linux:  writes ~/.config/systemd/user/egpt-daemon.service and
#           enables + starts it via `systemctl --user`. Restart=always +
#           RestartSec=5s, same auto-restart semantics.
#
# Both run as the current user (so the daemon can read ~/.egpt/wa-auth and
# the rest of ~/.egpt). No sudo required for either install — only for the
# optional Linux `enable-linger` step at the end, which lets the service
# keep running after the user logs out (server use case).
#
# Reversal: setup/uninstall-service.sh.
#
# Usage:
#   ./setup/install-service.sh
#
# Verify:
#   macOS:  launchctl list | grep com.egpt.daemon
#   Linux:  systemctl --user status egpt-daemon
#   both:   tail -f ~/.egpt/service-stdout.log

set -euo pipefail

# Resolve paths relative to this script so it works whether invoked from
# the repo root, the setup/ dir, or wherever.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
daemon_path="$repo_root/egpt-daemon.mjs"
log_dir="$HOME/.egpt/config/logs"

# Sanity checks
if [[ ! -f "$daemon_path" ]]; then
  echo "error: $daemon_path not found (this script must live in <repo>/setup/)." >&2
  exit 1
fi
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo "error: 'node' is not on PATH. Install Node.js first." >&2
  exit 1
fi

mkdir -p "$log_dir"

case "$(uname -s)" in
  Darwin)
    # ---- macOS / launchd ----------------------------------------------
    label="com.egpt.daemon"
    plist="$HOME/Library/LaunchAgents/$label.plist"
    mkdir -p "$(dirname "$plist")"

    # Unload any existing instance first (so we re-load fresh config).
    if launchctl list 2>/dev/null | grep -q "$label"; then
      echo "unloading existing $label..."
      launchctl unload "$plist" 2>/dev/null || true
    fi

    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$daemon_path</string>
    <string>--headless</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$repo_root</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$log_dir/service-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$log_dir/service-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$PATH</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
EOF

    echo "loading $plist..."
    launchctl load "$plist"

    cat <<EOF

egpt-daemon installed as a launchd LaunchAgent.

verify:   launchctl list | grep $label
logs:     tail -f $log_dir/service-stdout.log
stop:     launchctl unload $plist
remove:   setup/uninstall-service.sh
EOF
    ;;

  Linux)
    # ---- Linux / systemd --user ---------------------------------------
    if ! command -v systemctl >/dev/null 2>&1; then
      echo "error: systemctl not found. This script supports systemd-based distros only." >&2
      echo "On non-systemd systems, run 'node $daemon_path --headless' under your init / supervisor of choice." >&2
      exit 1
    fi
    unit="egpt-daemon.service"
    unit_dir="$HOME/.config/systemd/user"
    mkdir -p "$unit_dir"

    cat > "$unit_dir/$unit" <<EOF
[Unit]
Description=egpt personal AI bridge daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$node_bin $daemon_path --headless
WorkingDirectory=$repo_root
Restart=always
RestartSec=5s
StandardOutput=append:$log_dir/service-stdout.log
StandardError=append:$log_dir/service-stderr.log
Environment=PATH=$PATH
Environment=HOME=$HOME

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable --now "$unit"

    cat <<EOF

egpt-daemon installed as a systemd --user service.

verify:   systemctl --user status $unit
logs:     tail -f $log_dir/service-stdout.log
stop:     systemctl --user stop $unit
remove:   setup/uninstall-service.sh
EOF

    if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
      cat <<EOF

note: without 'lingering', this service stops when you log out. Enable it
      with (one-time, requires sudo):

          sudo loginctl enable-linger $USER

      Useful on a headless / server box where no interactive session
      stays open.
EOF
    fi
    ;;

  *)
    echo "error: unsupported platform: $(uname -s)" >&2
    echo "       For Windows, use setup/install-nssm-service.cmd." >&2
    exit 1
    ;;
esac
