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

BRAIN_PORT="${BRAIN_PORT:-9221}"   # Chrome's private CDP port
PROXY_PORT="${PROXY_PORT:-9222}"   # token-auth proxy exposed to LAN
EXT_PORT="${EXT_PORT:-9223}"
BRAIN_PROFILE="${BRAIN_PROFILE:-${HOME}/.egpt/egpt-brain}"
EXT_PROFILE="${EXT_PROFILE:-${HOME}/.egpt/egpt-extension}"
BRAIN_HOST="localhost:${BRAIN_PORT}"
PROXY_HOST="localhost:${PROXY_PORT}"
EXT_HOST="localhost:${EXT_PORT}"
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

_cdp_close() {
  local host="$1"
  EGPT_HOST="${host}" node --eval '
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

close_brain_via_cdp()  {
  # Try proxy first (has token rewrite); fall back to direct if proxy not running.
  TOKEN=""
  [ -f "${HOME}/.egpt/cdp-token" ] && TOKEN="$(cat "${HOME}/.egpt/cdp-token")"
  if [ -n "${TOKEN}" ]; then
    _cdp_close "${PROXY_HOST}/${TOKEN}"
  else
    _cdp_close "${BRAIN_HOST}"
  fi
}
close_ext_via_cdp()    { _cdp_close "${EXT_HOST}"; }

is_brain_running() {
  curl -sf --max-time 1 "http://${PROXY_HOST}/json/version" > /dev/null 2>&1 ||
  curl -sf --max-time 1 "http://${BRAIN_HOST}/json/version" > /dev/null 2>&1
}

start_proxy() {
  PROXY_PORT="${PROXY_PORT}" CHROME_PORT="${BRAIN_PORT}" \
    node "${SCRIPT_DIR}/tools/cdp-proxy.mjs" &
  PROXY_PID=$!
}

is_ext_running() {
  curl -sf --max-time 1 "http://${EXT_HOST}/json/version" > /dev/null 2>&1
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
  echo "   CDP port:  ${EXT_PORT}"
  "${chrome}" \
    --remote-debugging-port="${EXT_PORT}" \
    --load-extension="$(to_native_path "${EXTENSION_DIR}")" \
    --user-data-dir="$(to_native_path "${EXT_PROFILE}")" \
    --silent-debugger-extension-api \
    --no-first-run \
    --disable-features=ChromeWhatsNewUI \
    --new-window \
    "about:blank" &
  EXT_PID=$!
  trap '
    echo ""
    echo "🧩 closing extension via CDP..."
    close_ext_via_cdp
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
    --user-data-dir="$(to_native_path "${BRAIN_PROFILE}")" \
    --no-first-run \
    --disable-features=ChromeWhatsNewUI \
    --new-window \
    "${url}" &
  BRAIN_PID=$!

  echo "🔒 starting CDP proxy (port ${PROXY_PORT})"
  start_proxy

  echo "🧩 launching extension Chrome"
  "${chrome}" \
    --remote-debugging-port="${EXT_PORT}" \
    --load-extension="$(to_native_path "${EXTENSION_DIR}")" \
    --user-data-dir="$(to_native_path "${EXT_PROFILE}")" \
    --silent-debugger-extension-api \
    --no-first-run \
    --disable-features=ChromeWhatsNewUI \
    --new-window \
    "about:blank" &
  EXT_PID=$!

  echo ""
  echo "   brain CDP:   http://${BRAIN_HOST}/json  (private)"
  echo "   CDP proxy:   http://${PROXY_HOST}/<token>/json"
  echo "   ext CDP:     http://${EXT_HOST}/json"
  echo "   brain dir:   ${BRAIN_PROFILE}"
  echo "   ext dir:     ${EXT_PROFILE}"
  echo ""
  echo "(Ctrl+C closes both via CDP — clean shutdown, no restore-pages prompt)"

  trap '
    echo ""
    echo "🧠 shutting down..."
    close_brain_via_cdp
    close_ext_via_cdp
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$BRAIN_PID" "$EXT_PID" "$PROXY_PID" 2>/dev/null || true
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
  echo "🧩 closing extension Chrome via CDP..."
  close_ext_via_cdp
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
    echo "   running on ${EXT_HOST}   profile: ${EXT_PROFILE}"
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
  proxy)
    # Start proxy only — use when Chrome is already running (e.g. via shortcut)
    if ! is_brain_running; then
      echo "⚠️  Chrome not detected on ${BRAIN_HOST} — start it first"
      exit 1
    fi
    echo "🔒 starting CDP proxy (port ${PROXY_PORT} → ${BRAIN_HOST})"
    start_proxy
    trap '
      kill "$PROXY_PID" 2>/dev/null || true
      echo "✅ proxy stopped"
      exit 0
    ' INT TERM
    wait "$PROXY_PID"
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
  $0 brain [url]         # brain Chrome only (+ proxy)
  $0 proxy               # proxy only — Chrome already running via shortcut
  $0 extension           # extension Chrome only
  $0 stop                # stop brain Chrome
  $0 stop extension      # stop extension Chrome
  $0 stop all            # stop both
  $0 status
  $0 restart [url]

Env:
  BRAIN_PORT=9221   (Chrome CDP, localhost only)
  PROXY_PORT=9222   (token-auth proxy, LAN-accessible)
  BRAIN_PROFILE=\$HOME/.egpt/egpt-brain
  EXT_PROFILE=\$HOME/.egpt/egpt-extension
EOF
    ;;
  *)
    echo "unknown action: $ACTION"
    echo "use: $0 [both|brain|proxy|extension|stop|status|restart]"
    exit 2
    ;;
esac
