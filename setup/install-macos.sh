#!/usr/bin/env bash
# setup/install-macos.sh — register egpt-daemon as a launchd LaunchAgent.
#
# LaunchAgents run in the user's session (no sudo). KeepAlive=true tells
# launchd to restart the daemon on any exit. RunAtLoad=true starts it at
# user login. It's the OUTER supervisor; egpt-daemon.mjs supervises egpt.mjs
# + runs the integrated heartbeat watchdog (operator 2026-05-31).
#
# Install:
#   bash setup/install-macos.sh
#
# After install:
#   launchctl list | grep com.egpt
#   launchctl kickstart -k gui/$(id -u)/com.egpt.daemon       (restart)
#   tail -f ~/.egpt/headless.log

set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
REPO_ROOT=$( dirname "$SCRIPT_DIR" )
NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then echo "node not found in PATH"; exit 1; fi

LABEL="com.egpt.daemon"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/.egpt"
mkdir -p "$PLIST_DIR" "$LOG_DIR"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_ROOT/egpt-daemon.mjs</string>
    <string>--headless</string>
  </array>
  <key>WorkingDirectory</key>     <string>$REPO_ROOT</string>
  <key>KeepAlive</key>            <true/>
  <key>RunAtLoad</key>            <true/>
  <key>ThrottleInterval</key>     <integer>2</integer>
  <key>StandardOutPath</key>      <string>$LOG_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key>    <string>$LOG_DIR/launchd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>               <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

echo "wrote $PLIST_PATH"

# Use the modern bootstrap/bootout pair (replaces the deprecated load/unload).
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo
echo "installed and started. label: $LABEL"
echo "logs:  tail -f $LOG_DIR/headless.log"
echo "       tail -f $LOG_DIR/launchd.err.log"
echo "stop / start / restart:"
echo "  launchctl bootout   gui/\$(id -u)/$LABEL"
echo "  launchctl bootstrap gui/\$(id -u) $PLIST_PATH"
echo "  launchctl kickstart -k gui/\$(id -u)/$LABEL"
