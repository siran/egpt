#!/usr/bin/env bash
# launch-brain.sh — manage the brain Chrome (CDP-exposed) for egpt
#
# Usage:
#   ./launch-brain.sh                 # start (default url: chatgpt.com)
#   ./launch-brain.sh start [url]
#   ./launch-brain.sh stop            # close brain via CDP Browser.close
#   ./launch-brain.sh status
#   ./launch-brain.sh restart [url]
#
# Env:
#   PORT=9222   debug port
#   PROFILE=/tmp/egpt-brain-profile   user-data-dir
set -euo pipefail

PORT="${PORT:-9222}"
PROFILE="${PROFILE:-${HOME}/.egpt/brain-profile}"
HOST="localhost:${PORT}"

close_via_cdp() {
  EGPT_HOST="${HOST}" node --eval '
    const host = process.env.EGPT_HOST;
    (async () => {
      try {
        const v = await fetch(`http://${host}/json/version`).then(r => r.json());
        await new Promise(resolve => {
          const ws = new WebSocket(v.webSocketDebuggerUrl);
          const done = () => { try { ws.close(); } catch {} ; resolve(); };
          ws.addEventListener("open", () => ws.send(JSON.stringify({id:1, method:"Browser.close"})));
          ws.addEventListener("close", done);
          ws.addEventListener("error", done);
          setTimeout(done, 2500);
        });
      } catch {}
    })();
  ' 2>/dev/null || true
}

is_running() {
  curl -sf --max-time 1 "http://${HOST}/json/version" > /dev/null 2>&1
}

find_chrome() {
  case "$(uname -s)" in
    Linux*)
      for c in google-chrome-stable google-chrome chromium chromium-browser; do
        command -v "$c" >/dev/null && { echo "$c"; return; }
      done
      ;;
    Darwin*)
      local p="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      [ -x "$p" ] && { echo "$p"; return; }
      ;;
    MINGW*|MSYS*|CYGWIN*)
      for p in \
        "/c/Program Files/Google/Chrome/Application/chrome.exe" \
        "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"; do
        [ -f "$p" ] && { echo "$p"; return; }
      done
      ;;
  esac
  return 1
}

stop_brain() {
  if ! is_running; then
    echo "🧠 no brain running on ${HOST}"
    return 0
  fi
  echo "🧠 closing brain on ${HOST}..."
  close_via_cdp
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    is_running || { echo "✅ closed"; return 0; }
    sleep 0.5
  done
  echo "⚠️  brain still answering after 5s — may need manual kill"
  return 1
}

show_status() {
  if ! is_running; then
    echo "🧠 no brain on ${HOST}"
    return 0
  fi
  local browser
  browser=$(curl -s "http://${HOST}/json/version" | grep -oP '"Browser":\s*"\K[^"]+' || true)
  local pages
  pages=$(curl -s "http://${HOST}/json" | grep -oP '"type":\s*"page"' | wc -l)
  echo "🧠 running on ${HOST}"
  [ -n "$browser" ] && echo "   ${browser}"
  echo "   pages: ${pages}"
  echo "   profile: ${PROFILE}"
}

start_brain() {
  local url="${1:-https://chatgpt.com}"
  if is_running; then
    echo "⚠️  brain already running on ${HOST}"
    echo "   $0 stop      to close it"
    echo "   $0 restart   to relaunch"
    return 1
  fi
  local chrome
  chrome=$(find_chrome) || { echo "!! chrome not found"; return 1; }
  mkdir -p "${PROFILE}"
  echo "🧠 launching brain Chrome"
  echo "   binary:  ${chrome}"
  echo "   port:    ${PORT}"
  echo "   profile: ${PROFILE}"
  echo "   url:     ${url}"
  echo ""
  echo "(Ctrl+C closes the brain cleanly via CDP. Or run \`$0 stop\` from any other terminal.)"
  echo ""

  "${chrome}" \
    --remote-debugging-port="${PORT}" \
    --remote-allow-origins=* \
    --user-data-dir="${PROFILE}" \
    --no-first-run \
    --disable-features=ChromeWhatsNewUI \
    --new-window \
    "${url}" &
  CHROME_PID=$!

  trap '
    echo ""
    echo "🧠 received signal, closing brain via CDP..."
    close_via_cdp
    wait "$CHROME_PID" 2>/dev/null || true
    echo "✅ closed"
    exit 0
  ' INT TERM

  wait "$CHROME_PID"
}

# --- dispatch ---
ACTION="${1:-start}"
ARG="${2:-}"

# tolerate "launch-brain.sh https://...": treat URL as start
case "$ACTION" in
  http://*|https://*) ARG="$ACTION"; ACTION="start" ;;
esac

case "$ACTION" in
  start)   start_brain "${ARG:-}" ;;
  stop)    stop_brain ;;
  status)  show_status ;;
  restart) stop_brain; sleep 0.5; start_brain "${ARG:-}" ;;
  -h|--help|help)
    cat <<EOF
launch-brain.sh — manage the brain Chrome (CDP-exposed) for egpt

Usage:
  $0                 # start (default: chatgpt.com)
  $0 start [url]
  $0 stop            # close brain via CDP Browser.close
  $0 status
  $0 restart [url]

Env:
  PORT=9222          debug port
  PROFILE=\$HOME/.egpt/brain-profile   user-data-dir (persistent across reboots)
EOF
    ;;
  *)
    echo "unknown action: $ACTION"
    echo "use: $0 [start|stop|status|restart] [url]"
    exit 2 ;;
esac
