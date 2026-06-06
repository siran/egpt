#!/usr/bin/env bash
# uninstall-service.sh -- back out install-service.sh.
#
# macOS:  launchctl unload + delete the LaunchAgent plist.
# Linux:  systemctl --user disable + delete the unit file.
#
# Does NOT delete ~/.egpt or any of its contents (auth state, transcripts,
# conversations, service logs). Remove those manually if you want.

set -euo pipefail

case "$(uname -s)" in
  Darwin)
    label="com.egpt.daemon"
    plist="$HOME/Library/LaunchAgents/$label.plist"

    if [[ -f "$plist" ]]; then
      echo "unloading $label..."
      launchctl unload "$plist" 2>/dev/null || true
      rm -f "$plist"
      echo "removed $plist"
    else
      echo "no LaunchAgent plist at $plist (already removed?)"
    fi
    ;;

  Linux)
    if ! command -v systemctl >/dev/null 2>&1; then
      echo "error: systemctl not found." >&2
      exit 1
    fi
    unit="egpt-daemon.service"
    unit_dir="$HOME/.config/systemd/user"

    if systemctl --user list-unit-files 2>/dev/null | grep -q "^$unit"; then
      echo "stopping + disabling $unit..."
      systemctl --user disable --now "$unit" 2>/dev/null || true
    fi
    rm -f "$unit_dir/$unit"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "removed $unit_dir/$unit"
    ;;

  *)
    echo "error: unsupported platform: $(uname -s)" >&2
    echo "       For Windows, use setup/uninstall-nssm-service.cmd." >&2
    exit 1
    ;;
esac

echo
echo "Done. ~/.egpt (auth, conversations, logs) is preserved."
