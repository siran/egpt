#!/usr/bin/env bash
# install-macos.sh — the macOS bootstrap for an eGPT node: get an operator from a
# fresh clone to a running spine with a shell console attached, and nothing more.
#
# WHY THIS FILE EXISTS. README step 3 has always pointed macOS users at
# `./setup/install-service.sh`, which has never existed — every .sh in this repo was
# a .ps1/.cmd plus a committed Windows NSSM binary, so the documented Mac path dead-
# ended at a missing file. This is the POSIX entry point that was missing.
#
# WHAT IT DELIBERATELY IS NOT: a service installer. No launchd plist, no daemon, no
# background supervisor. The fastest honest path to "playing with egpt" on a Mac is
# the FOREGROUND pair — the spine in one terminal, the shell editor in another — and
# a launchd job in front of that only adds a way to fail silently. Daemonizing is a
# separate decision for a separate script.
#
# THE GOTCHA THIS SCRIPT EXISTS TO PREVENT — the shell token. The operator console
# (`node egpt.mjs`) is FAIL-CLOSED: with no `shell.token` in config.yaml the spine
# boots fine and logs
#     shell: DISABLED — no shell token configured …
# and port 23375 is never bound, so the editor just cannot connect and nothing says
# why. That is deliberate (src/shell/auth.mjs: loopback is not an authenticator on a
# machine with sandboxed accounts), but it is also the single most common first-run
# wall, and the README never mentions it. So this script generates the secret and
# appends it once. Both processes read the SAME ~/.egpt/config/config.yaml, so one
# token in one file arms both ends.
#
# BEEPER IS REQUIRED HERE (operator ruling), though not by the code. The measured fact:
# with no Beeper token the bridge logs a 401 and retries with backoff — the spine boots
# and stays up, and the shell console works fine. So the CODE treats Beeper as optional.
# But Beeper is the transport for every chat surface (WhatsApp/Telegram/Signal), which is
# the point of a node, so a missing Beeper is reported here as a FAILURE rather than a
# shrug. Install it with setup/install-macos-deps.sh. Set EGPT_SKIP_BEEPER=1 for a
# shell-console-only trial.
#
# CONFIG IS SACRED. An existing config.yaml is never overwritten and never rewritten
# — at most a `shell:` block is APPENDED, and only when one is absent. Rerunning this
# script is safe. Profile seeding (config/agents, config/identities, config/skeletons)
# is NOT done here: the spine does it copy-if-missing on first boot (src/spine/seed.mjs).
#
#   Usage:  ./setup/install-macos.sh          (honors $EGPT_HOME, default ~/.egpt)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EGPT_HOME="${EGPT_HOME:-$HOME/.egpt}"
CONFIG="$EGPT_HOME/config/config.yaml"
FAILED=0

# The fix line prints right under its ❌ and a counter (NOT an array) tallies them:
# stock macOS is still bash 3.2, where an empty array expanded under `set -u` aborts the
# script. Nothing here needs bash 4. A failing check records and returns; the run stops
# at the end of preflight, so one command shows the operator EVERY missing dependency.
ok()   { echo "✅ $1"; }
warn() { echo "⚠️  $1"; }
bad()  { echo "❌ $1"; echo "   → fix: $2"; FAILED=$((FAILED + 1)); }

echo "egpt macOS bootstrap — repo '$REPO_ROOT', profile '$EGPT_HOME'"
echo ""
echo "── preflight ──"

# macOS only. The rest of this script assumes brew-shaped fixes and a POSIX profile.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "❌ this script is macOS-only (uname -s = $(uname -s)). On Windows use setup\\install-nssm-service.cmd."
  exit 1
fi
ok "macOS ($(sw_vers -productVersion 2>/dev/null || echo Darwin))"

# Node >= 22 (package.json engines).
if ! command -v node >/dev/null 2>&1; then
  bad "node: not found" "install Node 22+:  brew install node   (or use nvm: nvm install 22)"
else
  NODE_V="$(node -v)"; NODE_MAJOR="${NODE_V#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then ok "node $NODE_V (>= 22)"
  else bad "node $NODE_V is too old — package.json requires >= 22" "upgrade Node:  brew upgrade node   (or: nvm install 22 && nvm use 22)"; fi
fi

command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || bad "npm: not found" "npm ships with Node — reinstall Node:  brew install node"
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || bad "git: not found" "install git:  xcode-select --install"

# The persona engine. Resolution order is src/warm-cli-session.mjs:198-205 —
# config `bin` → $EGPT_CLAUDE_BIN → ~/.local/bin/claude → bare `claude` on PATH.
# No claude binary = no persona = the node boots but cannot answer anything.
if [ -n "${EGPT_CLAUDE_BIN:-}" ] && [ -x "${EGPT_CLAUDE_BIN}" ]; then ok "claude: \$EGPT_CLAUDE_BIN → $EGPT_CLAUDE_BIN"
elif [ -x "$HOME/.local/bin/claude" ]; then ok "claude: $HOME/.local/bin/claude"
elif command -v claude >/dev/null 2>&1; then ok "claude: $(command -v claude)"
else bad "claude: not found — no persona engine (the default agent is the warm Claude Code CLI)" \
       "install the Claude Code CLI, or if it is already installed elsewhere:  export EGPT_CLAUDE_BIN=/full/path/to/claude"; fi

# lsof — the POSIX branch of src/tools/reap-port.mjs shells out to it to free a
# stuck listener. Stock on macOS; flag it only if something has removed it.
command -v lsof >/dev/null 2>&1 && ok "lsof: $(command -v lsof) (port reaper)" || warn "lsof missing (unusual on macOS) — src/tools/reap-port.mjs cannot free a stuck 23375"

# Optional, both of them.
command -v ffmpeg >/dev/null 2>&1 && ok "ffmpeg: $(command -v ffmpeg)" || warn "ffmpeg not found — OPTIONAL (voice notes / video frames only). Install later:  brew install ffmpeg"
if [ -d "/Applications/Beeper Desktop.app" ] || [ -d "/Applications/Beeper.app" ] || [ -d "$HOME/Applications/Beeper Desktop.app" ]; then
  ok "Beeper Desktop installed (chat surfaces available)"
elif [ -n "${EGPT_SKIP_BEEPER:-}" ]; then
  warn "Beeper Desktop not installed — skipped via EGPT_SKIP_BEEPER. Shell console only, no chat surfaces."
else
  bad "Beeper Desktop not installed — it is the transport for every chat surface" \
      "install it:  ./setup/install-macos-deps.sh   (or: brew install --cask beeper). For a shell-console-only trial, rerun with EGPT_SKIP_BEEPER=1 — the spine boots fine without it."
fi

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "preflight FAILED — $FAILED problem(s) above. Apply the 'fix:' lines and rerun."
  echo "Nothing was installed and nothing in $EGPT_HOME was touched."
  exit 1
fi

echo ""
echo "── dependencies ──"
( cd "$REPO_ROOT" && npm install )
ok "npm install complete"

echo ""
echo "── profile ──"
mkdir -p "$EGPT_HOME/config" "$EGPT_HOME/config/logs" "$EGPT_HOME/state"
ok "dirs: config/, config/logs/, state/   (config/logs must exist — a missing log dir is what killed the Windows service 80×)"

if [ -f "$CONFIG" ]; then
  ok "config: $CONFIG already exists — LEFT UNTOUCHED"
else
  cp "$REPO_ROOT/config/skeletons/config.yaml" "$CONFIG"
  ok "config: seeded from config/skeletons/config.yaml (node_name: kg, agent 'egpt' default: true)"
fi

# What does the config already say about `shell:`? Three answers, because appending is
# only safe for one of them: a SECOND top-level `shell:` key makes the file unparseable
# ("Map keys must be unique" — verified against this repo's yaml), so a block that exists
# but carries no token gets told what to paste, never an append. Handles the inline
# `shell: { token: … }` form too. A commented `# token:` correctly counts as no token.
shell_state() {
  awk '
    /^shell:/            { key = 1; if ($0 ~ /token:[[:space:]]*[^[:space:]}]/) tok = 1; inshell = 1; next }
    /^[^[:space:]#]/     { inshell = 0 }
    inshell && /^[[:space:]]+token:[[:space:]]*[^[:space:]]/ { tok = 1 }
    END { print (tok ? "token" : (key ? "key-only" : "none")) }
  ' "$1"
}

case "$(shell_state "$CONFIG")" in
  token)
    ok "shell token: already configured — not touching it" ;;
  key-only)
    warn "shell token: a top-level 'shell:' block exists with NO token. Appending a second one would BREAK the config, so add this line by hand, indented two spaces under that block:"
    echo "         token: \"$(openssl rand -hex 24)\""
    warn "until then the operator console stays DISABLED." ;;
  none)
    printf '\n# --- Operator console (added by setup/install-macos.sh) ----------------------\n# The shared secret arms BOTH ends of ws://127.0.0.1:23375: the spine (which serves the\n# port) and `node egpt.mjs` (which dials it). Without it the spine logs "shell: DISABLED"\n# and the editor cannot connect. Keep this file private.\nshell:\n  token: "%s"\n' "$(openssl rand -hex 24)" >> "$CONFIG"
    ok "shell token: generated and appended → the operator console is ENABLED" ;;
esac

echo ""
echo "── next steps ──"
echo "1. Edit $CONFIG"
echo "     node_name:  this node's name on the mesh (REQUIRED, ships as 'kg')"
echo "     user_name:  you, shown as <user_name>@<surface>"
echo "     beeper.main.token / .account — REQUIRED for chat surfaces. Launch Beeper, log in,"
echo "       then Settings -> Developer -> Desktop API, and paste the token here."
echo "       (Shell-console-only trial: leave it blank; the bridge logs 401 and retries, harmlessly.)"
echo ""
echo "2. Run the pair, in TWO terminals, both from $REPO_ROOT:"
echo "     terminal 1:   node egpt-spine.mjs      # the node; serves ws://127.0.0.1:23375"
echo "     terminal 2:   node egpt.mjs            # the shell console; dials in and talks to the persona"
echo "   Watch terminal 1 for 'shell: serving ws://127.0.0.1:23375'. If it instead says"
echo "   'shell: DISABLED', the token above is missing from the config that spine is reading."
if [ "$EGPT_HOME" != "$HOME/.egpt" ]; then
  echo "   NOTE: this profile is $EGPT_HOME — export EGPT_HOME=$EGPT_HOME in BOTH terminals."
fi
echo ""

echo "── verify ──"
node "$REPO_ROOT/setup/verify-install.mjs" egpt-daemon "$EGPT_HOME" || true
echo ""
echo "Reading that report on macOS:"
echo "  • the NSSM line is MEANINGLESS here — nssm is a Windows service manager; it degrades to a warning."
echo "  • config/conversations.yaml shows ❌ until the FIRST message arrives; the spine writes it then."
echo "  • liveness (spine.pid / alive.txt) is ❌/⚠️ until you have actually run node egpt-spine.mjs once."
echo "Everything else should be ✅. Now go to step 2 above."
