#!/usr/bin/env bash
# install-macos-deps.sh — the HEAVY half of macOS setup: Homebrew casks, a whisper.cpp
# build, a model download, and a Python venv for piper. Minutes to hours, not seconds.
#
# WHY THIS IS A SECOND SCRIPT. setup/install-macos.sh is the BOOTSTRAP — preflight,
# profile dirs, shell token — fast, idempotent, and safe to re-run on every clone and
# every reboot. Nothing below belongs on that path: nobody wants a cask install and a
# multi-hundred-MB model download every time they re-bootstrap a profile. So the two
# stay single-purpose and neither calls the other:
#     install-macos.sh        → "can I run the spine right now?"      (seconds)
#     install-macos-deps.sh   → "make the media/chat surfaces work"   (slow, one-shot)
# Order does not matter. Run this one never, if you like — the spine and the operator
# console boot without a single thing in this file. It buys you voice notes (whisper),
# video frames + Opus encoding (ffmpeg), the chat surfaces (Beeper), the browser
# surface (Chrome), and text-to-speech (piper).
#
# WHAT IT DELIBERATELY WILL NOT DO:
#   • install Homebrew — an interactive, sudo-touching installer is the operator's
#     call, not a script's. Missing brew is a hard stop with the official line printed.
#   • install the claude CLI — that is the default persona engine (a node with no
#     claude boots and answers nothing), but it is verified here, never auto-installed.
#   • touch config.yaml. Not one byte. Every path and value this script produces is
#     PRINTED for the operator to paste. Config is sacred, same as in the sibling.
#   • read, write, or guess the Beeper token. It cannot be automated: the token does
#     not exist until a human has logged in to the desktop app.
#
# IDEMPOTENT BY STEP. Every step DETECTS before it installs and skips when already
# satisfied, so a second run on a provisioned Mac installs nothing and exits 0. It also
# detects the thing, not the brew receipt — a Chrome or Beeper installed by hand counts,
# and a `brew install` is never re-run over it.
#
#   Usage:  ./setup/install-macos-deps.sh [--dry-run]
#
#     --dry-run       print what WOULD be installed, change nothing. The only flag.
#
#     $EGPT_HOME      profile root (default ~/.egpt) — models/ and piper/ land here
#     $WHISPER_MODEL  GGUF model to fetch (default base.en — small on purpose, so a
#                     first run is a ~150MB wait, not a ~3GB one). large-v3 is the
#                     quality option:  WHISPER_MODEL=large-v3 ./setup/install-macos-deps.sh
#     $RADIO_PIPER    piper install root (default $EGPT_HOME/piper)
#
# bash 3.2 — stock /bin/bash on macOS is still 3.2, so: no associative arrays, no
# mapfile, and no empty-array expansion under `set -u` (that trap already bit the
# sibling script). The summary table is a tab-separated STRING for exactly that reason.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EGPT_HOME="${EGPT_HOME:-$HOME/.egpt}"
WHISPER_MODEL="${WHISPER_MODEL:-base.en}"
PIPER_ROOT="${RADIO_PIPER:-$EGPT_HOME/piper}"
MODELS_DIR="$EGPT_HOME/models"
WHISPER_SRC="$EGPT_HOME/opt/whisper.cpp"
DRY_RUN=0

# The one flag. Anything else is a typo, and a typo that silently installs 3GB is worse
# than a usage error.
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '1,50p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1"; echo "usage: ./setup/install-macos-deps.sh [--dry-run]"; exit 2 ;;
  esac
done

FAILED=0
SUMMARY=""

ok()   { echo "✅ $1"; }
warn() { echo "⚠️  $1"; }
bad()  { echo "❌ $1"; echo "   → fix: $2"; FAILED=$((FAILED + 1)); }
have() { command -v "$1" >/dev/null 2>&1; }

# One row of the closing table. A tab-separated string, NOT an array — see the bash 3.2
# note above. Status is one of: ok / installed / MISSING / would-install / manual.
row() { SUMMARY="${SUMMARY}$(printf '%s\t%s\t%s' "$1" "$2" "$3")
"; }

# In --dry-run a missing dependency is reported as a plan row and its step RETURNS
# immediately — before any brew/curl/git line is reached. That is what makes the dry run
# safe without a run() wrapper threaded through every command: the mutating calls are
# simply never reached. Read-only probes still run, so a dry run tells the truth about
# what is already on the machine.
plan() { echo "   [dry-run] would install: $2"; row "$1" "would-install" "$2"; }

# Fetch a large file atomically, and only keep it if it is plausibly a model rather than
# an error page. HuggingFace answers a bad path with a few-KB HTML body; without this
# gate that HTML lands as "the model" and fails hours later inside whisper with an
# unreadable error. The .part + mv means a Ctrl-C never leaves a truncated file that the
# next run's non-empty check would happily skip over.
fetch_big() {   # dest url min_bytes label
  local dest="$1" url="$2" min="$3" label="$4"
  local tmp="$1.part" size
  rm -f "$tmp"
  if ! curl -fL --progress-bar -o "$tmp" "$url"; then
    rm -f "$tmp"
    bad "$label: download failed — $url" "check network/URL and rerun; nothing was written"
    return 1
  fi
  size="$(wc -c < "$tmp" | tr -d ' ')"
  if [ "$size" -lt "$min" ]; then
    rm -f "$tmp"
    bad "$label: got only ${size} bytes (expected > ${min}) — that is an error page, not a model" \
        "check the name/URL and rerun; the partial file was deleted"
    return 1
  fi
  mv "$tmp" "$dest"
  ok "$label: $dest (${size} bytes)"
  return 0
}

echo "egpt macOS dependency install — repo '$REPO_ROOT', profile '$EGPT_HOME'"
[ "$DRY_RUN" -eq 1 ] && echo "DRY RUN — nothing will be installed, downloaded, or written."
echo ""

# ── gates ────────────────────────────────────────────────────────────────────
# macOS only: every fix line below is brew-shaped and every path is a .app bundle.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "❌ this script is macOS-only (uname -s = $(uname -s))."
  exit 1
fi

# Homebrew. NOT auto-installed — see the header. The second branch is the Apple Silicon
# gotcha: brew is installed at /opt/homebrew but a shell that never sourced shellenv
# cannot see it, which looks identical to "brew is missing" and gets it installed twice.
if ! have brew; then
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$candidate" ]; then
      echo "❌ Homebrew is installed at $candidate but is NOT on this shell's PATH."
      echo "   → fix: eval \"\$($candidate shellenv)\"    (add that line to ~/.zprofile too)"
      exit 1
    fi
  done
  echo "❌ Homebrew not found — it is required for everything below, and this script will not install it for you"
  echo "   (it is interactive and touches sudo; that is the operator's call, not a script's)."
  echo "   → fix: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
  echo "     …then rerun this script."
  exit 1
fi
ok "brew $(brew --version 2>/dev/null | head -1 | awk '{print $2}')"

echo ""
echo "── verify only (never auto-installed) ──"

# The persona engine. Resolution order mirrors src/warm-cli-session.mjs:198-205 —
# $EGPT_CLAUDE_BIN → ~/.local/bin/claude → bare `claude` on PATH. No claude binary means
# the node boots, connects, and cannot answer anything.
if [ -n "${EGPT_CLAUDE_BIN:-}" ] && [ -x "${EGPT_CLAUDE_BIN}" ]; then
  ok "claude: \$EGPT_CLAUDE_BIN → $EGPT_CLAUDE_BIN"; row "claude" "ok" "$EGPT_CLAUDE_BIN"
elif [ -x "$HOME/.local/bin/claude" ]; then
  ok "claude: $HOME/.local/bin/claude"; row "claude" "ok" "$HOME/.local/bin/claude"
elif have claude; then
  ok "claude: $(command -v claude)"; row "claude" "ok" "$(command -v claude)"
else
  bad "claude: not found — no persona engine (the default agent is the warm Claude Code CLI)" \
      "install the Claude Code CLI, or point at an existing one:  export EGPT_CLAUDE_BIN=/full/path/to/claude"
  row "claude" "MISSING" "install the CLI or set \$EGPT_CLAUDE_BIN"
fi

if have git; then ok "git $(git --version | awk '{print $3}')"; row "git" "ok" "$(command -v git)"
else bad "git: not found" "xcode-select --install"; row "git" "MISSING" "xcode-select --install"; fi

# lsof + kill: the POSIX branch of src/tools/reap-port.mjs (lines 42-47) shells out to
# `lsof -t` and then `kill -9` to free a stuck listener. Both are stock macOS, so this is
# a confirmation, not an install. NOTE the /bin/kill probe: `kill` is also a shell
# builtin, and `command -v kill` would answer "yes" for the builtin — but reap-port
# spawns kill as a PROCESS, which needs the binary on disk.
if have lsof; then ok "lsof: $(command -v lsof) (port reaper)"; row "lsof" "ok" "$(command -v lsof)"
else warn "lsof missing (unusual on macOS) — src/tools/reap-port.mjs cannot free a stuck port"; row "lsof" "MISSING" "unusual on macOS — reap-port degraded"; fi
if [ -x /bin/kill ]; then ok "kill: /bin/kill (port reaper)"; row "kill" "ok" "/bin/kill"
else warn "/bin/kill missing (very unusual) — reap-port.mjs cannot kill a stale listener"; row "kill" "MISSING" "very unusual — reap-port degraded"; fi

# ── 1. Beeper Desktop ────────────────────────────────────────────────────────
# Hard requirement (operator ruling): the chat surfaces are how the node reaches
# WhatsApp/Telegram/Signal. The APP installs fine here; the TOKEN cannot be automated at
# all — it only exists once a human has logged in — so this step ends in a printed
# manual instruction every single run, by design.
echo ""
echo "── 1. Beeper Desktop ──"
BEEPER_APP=""
for p in "/Applications/Beeper Desktop.app" "/Applications/Beeper.app" "$HOME/Applications/Beeper Desktop.app" "$HOME/Applications/Beeper.app"; do
  [ -d "$p" ] && { BEEPER_APP="$p"; break; }
done
if [ -n "$BEEPER_APP" ]; then
  ok "Beeper Desktop already installed → $BEEPER_APP"
  row "beeper" "ok" "$BEEPER_APP"
elif [ "$DRY_RUN" -eq 1 ]; then
  plan "beeper" "brew install --cask beeper"
else
  # The cask name has moved before; a rename must not take the whole script down with it.
  if brew install --cask beeper; then
    ok "Beeper Desktop installed"
    row "beeper" "installed" "cask beeper"
  else
    warn "the 'beeper' cask did not resolve (renamed or delisted) — install it by hand from https://www.beeper.com/download"
    row "beeper" "MISSING" "https://www.beeper.com/download"
  fi
fi
echo "   TOKEN (manual, unavoidable — this script never reads or writes it):"
echo "     1. launch Beeper and log in"
echo "     2. Settings → Developer → Desktop API → copy the token"
echo "     3. paste it into $EGPT_HOME/config/config.yaml, replacing PASTE_YOUR_TOKEN_HERE:"
echo "          beeper:"
echo "            use: main"
echo "            main:"
echo "              account: \"you@example.com\""
echo "              token:   \"<the token you just copied>\""
row "beeper token" "manual" "Settings → Developer → Desktop API, paste into config.yaml"

# ── 2. ffmpeg (with libopus) + ffprobe ───────────────────────────────────────
# "Is ffmpeg installed" is the WRONG check. src/tools/synthesizer.mjs:79 encodes replies
# with `-c:a libopus` (WhatsApp-ready Opus/ogg), and an ffmpeg built without that encoder
# is present, on PATH, and useless — it fails per-message, at render time, not here. So
# the check is for the ENCODER. ffprobe is checked too because src/video-frames.mjs:16
# derives its path from the ffmpeg path by regex, so a stray ffmpeg without a matching
# ffprobe beside it breaks video frames.
echo ""
echo "── 2. ffmpeg (libopus) ──"
ffmpeg_report() {
  local bin; bin="$(command -v ffmpeg)"
  if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libopus; then
    ok "ffmpeg: $bin — libopus encoder present (src/tools/synthesizer.mjs:79)"
    row "ffmpeg" "ok" "$bin (libopus)"
  else
    bad "ffmpeg: $bin has NO libopus encoder — voice replies will fail at encode time, not here" \
        "brew reinstall ffmpeg   (brew's build ships libopus; a hand-built or third-party ffmpeg may not)"
    row "ffmpeg" "MISSING" "present but no libopus encoder"
  fi
  # Mirrors ffprobeFromFfmpeg() in src/video-frames.mjs:16 — same trailing-name swap.
  local probe="${bin%ffmpeg}ffprobe"
  if [ -x "$probe" ]; then ok "ffprobe: $probe (derived from the ffmpeg path, as video-frames.mjs does)"; row "ffprobe" "ok" "$probe"
  elif have ffprobe; then warn "ffprobe is on PATH at $(command -v ffprobe) but NOT beside ffmpeg — src/video-frames.mjs derives it from the ffmpeg path and will miss it"; row "ffprobe" "MISSING" "not beside ffmpeg (path-derived)"
  else bad "ffprobe: not found beside ffmpeg ($probe)" "brew reinstall ffmpeg — ffprobe ships with it"; row "ffprobe" "MISSING" "$probe"; fi
}
if have ffmpeg; then
  ffmpeg_report
elif [ "$DRY_RUN" -eq 1 ]; then
  plan "ffmpeg" "brew install ffmpeg (then verify the libopus encoder)"
else
  # Every mutating install in this script is guarded rather than left to `set -e`. A bare
  # failing install would abort the run before the summary and the next-steps ever print,
  # which is the least useful moment to go silent — and the rerun is safe anyway, since
  # each step is idempotent and only touches what is still missing.
  brew install ffmpeg || warn "brew install ffmpeg failed — see the output above"
  if have ffmpeg; then ffmpeg_report
  else bad "ffmpeg: still not on PATH after 'brew install ffmpeg'" "check 'brew doctor' and that brew's bin dir is on PATH"; row "ffmpeg" "MISSING" "install did not put it on PATH"; fi
fi

# ── 3. whisper.cpp (whisper-cli + whisper-server) ────────────────────────────
# Two binaries, two callers: `whisper-cli` is the default command in
# src/tools/transcribe.mjs:76 (the per-note path and the universal fallback), and
# `whisper-server` is the resident-model server in src/tools/whisper-server.mjs (default
# port 8089) used by the transcriptor worker role. Prefer brew, but VERIFY both names
# actually landed on PATH afterwards — whisper.cpp's binary names have changed across
# releases (main → whisper-cli), so "brew install succeeded" is not evidence that
# `whisper-cli` exists. When it is not, fall back to a source build.
echo ""
echo "── 3. whisper.cpp ──"
whisper_paths_note() {
  echo "   put these in $EGPT_HOME/config/config.yaml (transcription block):"
  echo "     transcription:"
  echo "       cli:    { command: $1, model_path: $MODELS_DIR/ggml-$WHISPER_MODEL.bin }"
  # An `&&` as the LAST line of a function would return 1 when $2 is empty, and under
  # `set -e` a function that returns 1 kills the script. Hence the if, and the return 0.
  if [ -n "$2" ]; then
    echo "       server: { command: $2, model: $MODELS_DIR/ggml-$WHISPER_MODEL.bin }"
  fi
  return 0
}
WHISPER_CLI=""; WHISPER_SERVER=""
have whisper-cli    && WHISPER_CLI="$(command -v whisper-cli)"
have whisper-server && WHISPER_SERVER="$(command -v whisper-server)"
[ -z "$WHISPER_CLI" ]    && [ -x "$WHISPER_SRC/build/bin/whisper-cli" ]    && WHISPER_CLI="$WHISPER_SRC/build/bin/whisper-cli"
[ -z "$WHISPER_SERVER" ] && [ -x "$WHISPER_SRC/build/bin/whisper-server" ] && WHISPER_SERVER="$WHISPER_SRC/build/bin/whisper-server"

if [ -n "$WHISPER_CLI" ] && [ -n "$WHISPER_SERVER" ]; then
  ok "whisper-cli:    $WHISPER_CLI"
  ok "whisper-server: $WHISPER_SERVER"
  row "whisper-cli" "ok" "$WHISPER_CLI"
  row "whisper-server" "ok" "$WHISPER_SERVER"
  whisper_paths_note "$WHISPER_CLI" "$WHISPER_SERVER"
elif [ "$DRY_RUN" -eq 1 ]; then
  plan "whisper.cpp" "brew install whisper-cpp (source-build fallback into $WHISPER_SRC if the binaries do not land)"
else
  if ! brew list --formula whisper-cpp >/dev/null 2>&1; then
    brew install whisper-cpp || warn "brew install whisper-cpp failed — falling through to the source build"
  else
    ok "brew formula whisper-cpp already installed — re-checking the binary names"
  fi
  have whisper-cli    && WHISPER_CLI="$(command -v whisper-cli)"
  have whisper-server && WHISPER_SERVER="$(command -v whisper-server)"

  # Source build — only when brew genuinely did not produce the binaries. Needs the
  # Xcode command line tools (cc) and cmake; check BEFORE cloning, so a missing
  # toolchain is one clear message instead of a half-cloned tree and a wall of cmake.
  if [ -z "$WHISPER_CLI" ] || [ -z "$WHISPER_SERVER" ]; then
    warn "brew did not put both binaries on PATH (cli='${WHISPER_CLI:-none}' server='${WHISPER_SERVER:-none}') — building from source"
    MISSING_TOOLS=""
    have cc    || MISSING_TOOLS="$MISSING_TOOLS cc(xcode-select --install)"
    have cmake || MISSING_TOOLS="$MISSING_TOOLS cmake(brew install cmake)"
    if [ -n "$MISSING_TOOLS" ]; then
      bad "whisper.cpp source build needs:$MISSING_TOOLS" "install the tool(s) in parentheses, then rerun this script"
      row "whisper.cpp" "MISSING" "toolchain missing:$MISSING_TOOLS"
    else
      mkdir -p "$(dirname "$WHISPER_SRC")"
      if [ -d "$WHISPER_SRC/.git" ]; then
        ok "source tree already cloned → $WHISPER_SRC (not re-cloning, not pulling)"
      else
        git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$WHISPER_SRC" \
          || warn "clone failed — see above"
      fi
      ( cd "$WHISPER_SRC" && cmake -B build && cmake --build build -j --config Release ) \
        || warn "the whisper.cpp build failed — see the compiler output above"
      [ -x "$WHISPER_SRC/build/bin/whisper-cli" ]    && WHISPER_CLI="$WHISPER_SRC/build/bin/whisper-cli"
      [ -x "$WHISPER_SRC/build/bin/whisper-server" ] && WHISPER_SERVER="$WHISPER_SRC/build/bin/whisper-server"
    fi
  fi

  if [ -n "$WHISPER_CLI" ]; then ok "whisper-cli: $WHISPER_CLI"; row "whisper-cli" "installed" "$WHISPER_CLI"
  else bad "whisper-cli: still missing after brew and source build" "build by hand in $WHISPER_SRC, then set transcription.cli.command to the binary"; row "whisper-cli" "MISSING" "not produced by brew or the source build"; fi
  if [ -n "$WHISPER_SERVER" ]; then ok "whisper-server: $WHISPER_SERVER"; row "whisper-server" "installed" "$WHISPER_SERVER"
  else warn "whisper-server not found — the resident-server worker role (port 8089) is unavailable; the whisper-cli path still works"; row "whisper-server" "MISSING" "worker role unavailable; cli path unaffected"; fi
  [ -n "$WHISPER_CLI" ] && whisper_paths_note "$WHISPER_CLI" "$WHISPER_SERVER"
fi

# ── 4. the GGUF model ────────────────────────────────────────────────────────
# Default base.en on purpose: ~150MB, so a first run works in a minute instead of
# blocking on ~3GB. large-v3 is markedly better on accented speech and long notes —
# WHISPER_MODEL=large-v3 when you want it. Both binaries above share ONE model file.
echo ""
echo "── 4. whisper model ($WHISPER_MODEL) ──"
MODEL_PATH="$MODELS_DIR/ggml-$WHISPER_MODEL.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$WHISPER_MODEL.bin"
if [ -s "$MODEL_PATH" ]; then
  ok "model already present → $MODEL_PATH ($(wc -c < "$MODEL_PATH" | tr -d ' ') bytes) — not re-downloading"
  row "model $WHISPER_MODEL" "ok" "$MODEL_PATH"
elif [ "$DRY_RUN" -eq 1 ]; then
  plan "model $WHISPER_MODEL" "curl $MODEL_URL → $MODEL_PATH"
else
  mkdir -p "$MODELS_DIR"
  if fetch_big "$MODEL_PATH" "$MODEL_URL" 1000000 "model $WHISPER_MODEL"; then
    row "model $WHISPER_MODEL" "installed" "$MODEL_PATH"
  else
    row "model $WHISPER_MODEL" "MISSING" "download failed — see above"
  fi
fi

# ── 5. Google Chrome ─────────────────────────────────────────────────────────
# The browser surface. Verified at the EXACT path src/tools/chrome-launcher.mjs:22-25
# probes on darwin — Chrome installed anywhere else is invisible to the launcher, so
# checking `command -v` or the brew receipt would be checking the wrong thing.
echo ""
echo "── 5. Google Chrome ──"
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "$CHROME_BIN" ]; then
  ok "Chrome: $CHROME_BIN (the exact path chrome-launcher.mjs probes)"
  row "chrome" "ok" "$CHROME_BIN"
elif [ "$DRY_RUN" -eq 1 ]; then
  plan "chrome" "brew install --cask google-chrome"
else
  if brew install --cask google-chrome; then :; else warn "the google-chrome cask failed — install by hand from https://www.google.com/chrome/"; fi
  if [ -x "$CHROME_BIN" ]; then ok "Chrome: $CHROME_BIN"; row "chrome" "installed" "$CHROME_BIN"
  else bad "Chrome not at $CHROME_BIN" "chrome-launcher.mjs:22-25 only looks there (and at Chromium.app) — install Chrome to /Applications"; row "chrome" "MISSING" "$CHROME_BIN"; fi
fi

# ── 6. piper TTS + its venv ──────────────────────────────────────────────────
# piper is a Python MODULE in a venv, not a binary (src/tools/synthesizer.mjs runs
# `python -m piper`), and the spine finds it through $RADIO_PIPER — an env var pointing
# at a root that contains venv/ and voices/ (src/spine/synthesizer-worker.mjs:55-68).
# That var is read from the ENVIRONMENT and ONLY the environment: the worker refuses to
# start when it is unset, and a value in config.yaml is explicitly not consulted (it is
# machine-local layout, not portable config). So the export line below is not a
# convenience — without it the synthesizer role logs a refusal and stays down.
echo ""
echo "── 6. piper TTS ($PIPER_ROOT) ──"
PIPER_PY="$PIPER_ROOT/venv/bin/python3"
VOICE="en_US-lessac-medium"
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/$VOICE"
VOICE_ONNX="$PIPER_ROOT/voices/$VOICE.onnx"
PIPER_OK=1

if [ -x "$PIPER_PY" ]; then
  ok "venv already present → $PIPER_PY"
elif [ "$DRY_RUN" -eq 1 ]; then
  # Both plan lines here: with no venv yet there is nothing to probe `import piper`
  # against, and a dry run that silently omitted the pip step would under-report the plan.
  plan "piper venv" "python3 -m venv $PIPER_ROOT/venv"
  plan "piper-tts"  "$PIPER_ROOT/venv/bin/pip install piper-tts"
  PIPER_OK=0
elif ! have python3; then
  bad "python3 not found — piper needs a venv" "brew install python"
  row "piper venv" "MISSING" "brew install python"
  PIPER_OK=0
else
  mkdir -p "$PIPER_ROOT"
  if python3 -m venv "$PIPER_ROOT/venv" && [ -x "$PIPER_PY" ]; then
    ok "venv created → $PIPER_PY"
  else
    bad "could not create a venv at $PIPER_ROOT/venv" "check python3 has the venv module:  python3 -m venv --help   (brew install python)"
    row "piper venv" "MISSING" "python3 -m venv failed"
    PIPER_OK=0
  fi
fi

if [ "$PIPER_OK" -eq 1 ] && [ -x "$PIPER_PY" ]; then
  if "$PIPER_PY" -c 'import piper' >/dev/null 2>&1; then
    ok "piper-tts already importable in the venv — not reinstalling"
    row "piper" "ok" "$PIPER_ROOT"
  elif [ "$DRY_RUN" -eq 1 ]; then
    plan "piper-tts" "$PIPER_ROOT/venv/bin/pip install piper-tts"
  else
    "$PIPER_ROOT/venv/bin/pip" install piper-tts || warn "pip install piper-tts failed — see above"
    if "$PIPER_PY" -c 'import piper' >/dev/null 2>&1; then ok "piper-tts installed"; row "piper" "installed" "$PIPER_ROOT"
    else bad "piper-tts installed but 'import piper' still fails" "check the pip output above; the venv is at $PIPER_ROOT/venv"; row "piper" "MISSING" "import piper fails"; fi
  fi
fi

# A voice is TWO files: the .onnx weights and the .onnx.json sidecar that describes the
# sample rate and phoneme map. piper fails to load a voice whose sidecar is absent, so
# they are fetched as a pair and the pair is what "installed" means.
if [ -s "$VOICE_ONNX" ] && [ -s "$VOICE_ONNX.json" ]; then
  ok "voice already present → $VOICE_ONNX (+ .json sidecar)"
  row "piper voice" "ok" "$VOICE"
elif [ "$DRY_RUN" -eq 1 ]; then
  plan "piper voice" "curl $VOICE_BASE.onnx (+ .onnx.json) → $PIPER_ROOT/voices/"
else
  # mkdir lives HERE, not above the branch: a --dry-run that creates directories is not
  # a dry run, and an unconditional mkdir at the top of this step created voices/ on
  # every dry run until it was moved.
  mkdir -p "$PIPER_ROOT/voices"
  if fetch_big "$VOICE_ONNX" "$VOICE_BASE.onnx" 1000000 "voice $VOICE" \
     && fetch_big "$VOICE_ONNX.json" "$VOICE_BASE.onnx.json" 100 "voice $VOICE sidecar"; then
    row "piper voice" "installed" "$VOICE"
  else
    row "piper voice" "MISSING" "download failed — see above"
  fi
fi

# The worker reads this venv at venv/bin/python on POSIX. That join used to be hardcoded to
# the Windows layout (venv/Scripts/python.exe), which made the synthesizer role unable to
# spawn piper on a Mac at all; it is platform-aware as of the commit that added this branch,
# and tests/synthesizer-worker.test.mjs locks both layouts. Nothing to work around here — and
# note there is deliberately NO venv/Scripts shim: a fake path would make the filesystem lie.
row "synth worker" "ok" "venv/bin/python — synthesizer-worker.mjs is platform-aware"

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
echo "── summary ──"
printf '  %-18s %-14s %s\n' "COMPONENT" "STATUS" "DETAIL"
printf '%s' "$SUMMARY" | while IFS="$(printf '\t')" read -r c s d; do
  printf '  %-18s %-14s %s\n' "$c" "$s" "$d"
done

echo ""
echo "── next steps ──"
echo "1. Beeper token → $EGPT_HOME/config/config.yaml"
echo "     launch Beeper, log in, Settings → Developer → Desktop API, copy the token,"
echo "     replace PASTE_YOUR_TOKEN_HERE under beeper.main.token. No script can do this for you."
echo ""
echo "2. Add this to ~/.zprofile (or ~/.bash_profile) and open a NEW terminal:"
echo "     export RADIO_PIPER=\"$PIPER_ROOT\""
echo "   The spine reads RADIO_PIPER from the ENVIRONMENT only — putting it in config.yaml"
echo "   is explicitly refused by src/spine/synthesizer-worker.mjs."
if [ "$EGPT_HOME" != "$HOME/.egpt" ]; then
  echo "     export EGPT_HOME=\"$EGPT_HOME\"    # this run used a non-default profile"
fi
echo ""
echo "3. If you have not run the bootstrap yet:"
echo "     ./setup/install-macos.sh        # preflight, profile dirs, shell token"
echo "   Then start the pair: 'node egpt-spine.mjs' in one terminal, 'node egpt.mjs' in another."

echo ""
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY RUN complete — nothing was installed. Rerun without --dry-run to apply."
  exit 0
fi
if [ "$FAILED" -gt 0 ]; then
  echo "❌ $FAILED problem(s) above. Apply the 'fix:' lines and rerun — every step is idempotent,"
  echo "   so a rerun only touches what is still missing."
  exit 1
fi
echo "✅ all dependencies present. Rerunning this script now installs nothing."
