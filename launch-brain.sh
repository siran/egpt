#!/usr/bin/env bash
# launch-brain.sh — manage egpt Chrome instances
#
# Usage:
#   ./launch-brain.sh                     # start both (brain CDP + extension)
#   ./launch-brain.sh brain [url]         # brain Chrome only  (old default)
#   ./launch-brain.sh extension           # extension Chrome only
#   ./launch-brain.sh stop                # stop brain Chrome
#   ./launch-brain.sh stop extension      # stop extension Chrome
#   ./launch-brain.sh stop all            # stop both
#   ./launch-brain.sh status
#   ./launch-brain.sh restart [url]
#
# Env:
#   BRAIN_PORT=9222
#   BRAIN_PROFILE=$HOME/.egpt/egpt-brain
#   EXT_PROFILE=$HOME/.egpt/egpt-extension
set -euo pipefail

BRAIN_PORT="${BRAIN_PORT:-9222}"
BRAIN_PROFILE="${BRAIN_PROFILE:-${HOME}/.egpt/egpt-brain}"
EXT_PROFILE="${EXT_PROFILE:-${HOME}/.egpt/egpt-extension}"
BRAIN_HOST="localhost:${BRAIN_PORT}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_DIR="${SCRIPT_DIR}/extension"

# Chrome on Windows (via Git Bash) needs backslash paths for --load-extension / --user-data-dir
to_native_path() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) cygpath -w "$1" 2>/dev/null || echo "$1" ;;
    *) echo "$1" ;;
  esac
}

# ── helpers ─────────────────────────────────────────────────────────────────

close_brain_via_cdp() {
  EGPT_HOST="${BRAIN_HOST}" node --eval '
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

is_brain_running() {
  curl -sf --max-time 1 "http://${BRAIN_HOST}/json/version" > /dev/null 2>&1
}

is_ext_running() {
  pgrep -f "$(to_native_path "${EXT_PROFILE}")" > /dev/null 2>&1
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

ensure_ext_built() {
  if [ ! -f "${EXTENSION_DIR}/dist/background.js" ]; then
    echo "🔧 extension/dist/ not found — building..."
    (cd "${SCRIPT_DIR}" && npm run build:ext) || { echo "!! build failed"; return 1; }
  fi
}

# ── start functions ──────────────────────────────────────────────────────────

start_brain() {
  local url="${1:-https://chatgpt.com}"
  if is_brain_running; then
    echo "⚠️  brain already running on ${BRAIN_HOST}"
    echo "   $0 stop      to close it"
    echo "   $0 restart   to relaunch"
    return 1
  fi
  local chrome
  chrome=$(find_chrome) || { echo "!! chrome not found"; return 1; }
  mkdir -p "${BRAIN_PROFILE}"
  echo "🧠 launching brain Chrome"
  echo "   port:    ${BRAIN_PORT}"
  echo "   profile: ${BRAIN_PROFILE}"
  echo "   url:     ${url}"
  "${chrome}" \
    --remote-debugging-port="${BRAIN_PORT}" \
    --remote-allow-origins='*' \
    --user-data-dir="$(to_native_path "${BRAIN_PROFILE}")" \
    --no-first-run \
    --disable-features=ChromeWhatsNewUI \
    --new-window \
    "${url}" &
  BRAIN_PID=$!
  trap '
    echo ""
    echo "🧠 closing brain via CDP..."
    close_brain_via_cdp
    wait "$BRAIN_PID" 2>/dev/null || true
    echo "✅ closed"
    exit 0
  ' INT TERM
  wait "$BRAIN_PID"
}

start_extension() {
  ensure_ext_built || return 1
  local chrome
  chrome=$(find_chrome) || { echo "!! chrome not found"; return 1; }
  mkdir -p "${EXT_PROFILE}"
  echo "🧩 launching extension Chrome"
  echo "   profile:   ${EXT_PROFILE}"
  echo "   extension: ${EXTENSION_DIR}"
  "${chrome}" \
    --load-extension="$(to_native_path "${EXTENSION_DIR}")" \
    --user-data-dir="$(to_native_path "${EXT_PROFILE}")" \
    --silent-debugger-extension-api \
    --no-first-run \
    --disable-features=ChromeWhatsNewUI \
    --new-window \
    "about:blank" &
  EXT_PID=$!
  trap '
    kill "$EXT_PID" 2>/dev/null || true
    wait "$EXT_PID" 2>/dev/null || true
    echo "✅ closed"
    exit 0
  ' INT TERM
  wait "$EXT_PID"
}

start_both() {
  local url="${1:-https://chatgpt.com}"
  if is_brain_running; then
    echo "⚠️  brain already running on ${BRAIN_HOST} — $0 stop first"
    return 1
  fi
  ensure_ext_built || return 1
  local chrome
  chrome=$(find_chrome) || { echo "!! chrome not found"; return 1; }
  mkdir -p "${BRAIN_PROFILE}" "${EXT_PROFILE}"

  echo "🧠 launching brain Chrome (CDP port ${BRAIN_PORT})"
  "${chrome}" \
    --remote-debugging-port="${BRAIN_PORT}" \
    --remote-allow-origins='*' \
    --user-data-dir="$(to_native_path "${BRAIN_PROFILE}")" \
    --no-first-run \
    --disable-features=ChromeWhatsNewUI \
    --new-window \
    "${url}" &
  BRAIN_PID=$!

  echo "🧩 launching extension Chrome"
  "${chrome}" \
    --load-extension="$(to_native_path "${EXTENSION_DIR}")" \
    --user-data-dir="$(to_native_path "${EXT_PROFILE}")" \
    --silent-debugger-extension-api \
    --no-first-run \
    --disable-features=ChromeWhatsNewUI \
    --new-window \
    "about:blank" &
  EXT_PID=$!

  echo ""
  echo "   brain CDP:   http://${BRAIN_HOST}/json"
  echo "   brain dir:   ${BRAIN_PROFILE}"
  echo "   ext dir:     ${EXT_PROFILE}"
  echo ""
  echo "(Ctrl+C closes brain via CDP and stops extension Chrome)"

  trap '
    echo ""
    echo "🧠 shutting down..."
    close_brain_via_cdp
    kill "$EXT_PID" 2>/dev/null || true
    wait "$BRAIN_PID" "$EXT_PID" 2>/dev/null || true
    echo "✅ done"
    exit 0
  ' INT TERM

  wait "$BRAIN_PID"
  # brain exited naturally — also stop extension Chrome
  kill "$EXT_PID" 2>/dev/null || true
}

# ── stop functions ───────────────────────────────────────────────────────────

stop_brain() {
  if ! is_brain_running; then
    echo "🧠 no brain running on ${BRAIN_HOST}"
    return 0
  fi
  echo "🧠 closing brain on ${BRAIN_HOST}..."
  close_brain_via_cdp
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    is_brain_running || { echo "✅ brain closed"; return 0; }
    sleep 0.5
  done
  echo "⚠️  brain still answering after 5s — may need manual kill"
  return 1
}

stop_extension() {
  if ! is_ext_running; then
    echo "🧩 extension Chrome not running"
    return 0
  fi
  pkill -f "$(to_native_path "${EXT_PROFILE}")" 2>/dev/null || true
  echo "✅ extension Chrome stopped"
}

# ── status ───────────────────────────────────────────────────────────────────

show_status() {
  echo "🧠 brain:"
  if is_brain_running; then
    local browser
    browser=$(curl -s "http://${BRAIN_HOST}/json/version" | grep -oP '"Browser":\s*"\K[^"]+' || true)
    local pages
    pages=$(curl -s "http://${BRAIN_HOST}/json" | grep -oP '"type":\s*"page"' | wc -l)
    echo "   running on ${BRAIN_HOST}"
    [ -n "$browser" ] && echo "   ${browser}"
    echo "   pages: ${pages}   profile: ${BRAIN_PROFILE}"
  else
    echo "   not running"
  fi
  echo ""
  echo "🧩 extension Chrome:"
  if is_ext_running; then
    echo "   running   profile: ${EXT_PROFILE}"
  else
    echo "   not running"
  fi
}

# ── dispatch ─────────────────────────────────────────────────────────────────

ACTION="${1:-both}"
ARG="${2:-}"

# bare URL → treat as "brain start <url>"
case "$ACTION" in
  http://*|https://*) ARG="$ACTION"; ACTION="brain" ;;
esac

case "$ACTION" in
  both|start)
    start_both "${ARG:-}"
    ;;
  brain)
    start_brain "${ARG:-}"
    ;;
  extension)
    start_extension
    ;;
  stop)
    case "${ARG:-}" in
      extension) stop_extension ;;
      all)       stop_brain; stop_extension ;;
      *)         stop_brain ;;
    esac
    ;;
  status)
    show_status
    ;;
  restart)
    stop_brain
    sleep 0.5
    start_both "${ARG:-}"
    ;;
  -h|--help|help)
    cat <<EOF
launch-brain.sh — manage egpt Chrome instances

Usage:
  $0                     # start both (brain CDP + extension)
  $0 brain [url]         # brain Chrome only
  $0 extension           # extension Chrome only
  $0 stop                # stop brain Chrome
  $0 stop extension      # stop extension Chrome
  $0 stop all            # stop both
  $0 status
  $0 restart [url]

Env:
  BRAIN_PORT=9222
  BRAIN_PROFILE=\$HOME/.egpt/egpt-brain
  EXT_PROFILE=\$HOME/.egpt/egpt-extension
EOF
    ;;
  *)
    echo "unknown action: $ACTION"
    echo "use: $0 [both|brain|extension|stop|status|restart]"
    exit 2
    ;;
esac
