# egpt manual

A practical guide. Cheat sheet first, then the sections explain what each piece does.

---

## Cheat sheet

Bash-flavored, copy-paste ready.

```bash
# ────────────────────────────────────────────────────────────────────────
# Setup (one time)
# ────────────────────────────────────────────────────────────────────────
cd ~/src/egpt
npm install

# Optional: make `egpt` a global command
npm link                 # then `egpt` works from anywhere

# Optional: confirm dependencies
node --version           # need >= 18
which claude             # Claude Code CLI on PATH (for the ccode brain)


# ────────────────────────────────────────────────────────────────────────
# Daily: chat with ccode (no Chrome needed)
# ────────────────────────────────────────────────────────────────────────
node egpt.mjs                                 # uses ./conversation.md
node egpt.mjs ~/notes/2026-05-02.md           # explicit file path
node egpt.mjs --help                          # CLI usage (does not create a file)
node egpt.mjs profile alex 69f68099-5cf8-8328-ad8f-37d991ff0071
                                              # create ~/.egpt/brains/alex.yaml
# inside egpt:
/open ccode ccode1                            # add local Claude Code participant
@ccode1 hola                                  # say hello to that session
/file                                         # which file are we writing to?
/last 5                                       # show last 5 turns from the file
/exit


# ────────────────────────────────────────────────────────────────────────
# Multi-brain: bring in ChatGPT and/or Claude.ai
# ────────────────────────────────────────────────────────────────────────
# Run egpt, then /chrome inside it to launch Chrome with the extension
# loaded. The shell starts the CDP proxy and joins the bus when Chrome
# is reachable. Log into chatgpt.com / claude.ai once in that Chrome
# window — the profile persists at ~/.egpt/egpt-brain.

# in egpt (brain Chrome running):
# at startup egpt scans tabs and auto-attaches:
#    auto-attached 2 tab(s): cgpt1 (chatgpt-cdp), claude1 (claude-cdp)
/sessions                                     # who's in the room
/tabs                                         # what's open in the brain Chrome
@cgpt1 ¿qué piensas de esto?                  # address one tab for a single turn
@claude1 segunda opinión?                     # address another tab for a single turn
hello everyone                                # broadcast to all sessions in the room
/open chatgpt-cdp                             # open a NEW chatgpt tab → cgpt2
/attach                                       # rescan Chrome for new tabs
/send-file via=codex1 @cgpt1 "find the TPOEF book and send everything before chapter 8"
                                              # codex finds/prepares it, egpt sends it
/send-file via=codex1 "C:\Users\an\src\siran\writing\site\books\The Physics of Energy Flow\The Physics of Energy Flow.md" @cgpt1 "before chapter 8"
                                              # codex prepares the excerpt, egpt sends it
/paste-file alex "C:\Users\an\src\siran\writing\site\books\The Physics of Energy Flow\The Physics of Energy Flow.md" --before "# 8."
                                              # deterministic marker paste


# ------------------------------------------------------------------------
# Brain profiles (named presets)
# ------------------------------------------------------------------------
# Put YAML in one of:
#   ~/.egpt/brains/alex.yaml                  # personal
#   ./.egpt/brains/alex.yaml                  # project-local
#   <egpt repo>/brains/type/alex.yaml         # repo-defined
#
# Example:
#   name: alex
#   type: codex                               # codex | code | cdp_chat | cdp_claude
#   model: gpt-5.5
#   effort: low
#   cwd: C:\Users\an\src\egpt
#   summary: alex                             # inject ~/.egpt/summaries/alex.md on attach
#   chat_name: Alex
#
/profiles                                     # list configured profiles and paths
/profile alex https://chatgpt.com/c/69f68099-5cf8-8328-ad8f-37d991ff0071
                                              # create ~/.egpt/brains/alex.yaml
/profile 69f68099-5cf8-8328-ad8f-37d991ff0071 alex --attach
                                              # bare id -> ChatGPT URL, then attach
/attach alex                                  # start profile "alex" as @alex
/sessions                                     # shows profile, cwd, model, effort, thread/log


# ────────────────────────────────────────────────────────────────────────
# Resume a past ccode session (real session continuity, no cloning)
# ────────────────────────────────────────────────────────────────────────
/history                                      # list Claude Code JSONLs on disk
/session 26b30e57                             # resume by 8-char id; cwd auto-detected
/session none                                 # back to stateless mode (.md file is memory)


# ────────────────────────────────────────────────────────────────────────
# Multi-brain etiquette (rooms with several AIs)
# ────────────────────────────────────────────────────────────────────────
/rules                                        # write room rules into the file:
                                              #   - reply only when addressed or relevant
                                              #   - reply "..." when nothing to add
                                              #   - use @mention to address each other


# ────────────────────────────────────────────────────────────────────────
# Telegram bridge (drive egpt from your phone)
# ────────────────────────────────────────────────────────────────────────
# 1. Talk to @BotFather on Telegram, /newbot, get a bot_token.
# 2. Find your numeric Telegram user ID (e.g. via @userinfobot).
# 3. Write ~/.egpt/config.json:
#    {
#      "telegram": {
#        "bot_token": "1234567890:AA...",
#        "allowed_users": [<your numeric user id>]
#      }
#    }
# 4. Send any message to your bot once so Telegram routes future replies.
# 5. Launch egpt — see "telegram bridge enabled" in the transcript.
#
# Then from the phone:
#   "hello"                # broadcasts to all participants in the room
#   "@ccode1 git status"   # routes to a specific session
#   "@codex exec: pwd"     # run an operator command on the computer
#   "@codex exec: cd ~/src/siran/writing"  # change codex cwd
#   "/sessions"            # any slash command works (it's the same submit())
#   "/save my-thought"     # zombie commands work even with no brain present


# ────────────────────────────────────────────────────────────────────────
# Reusable distillations (saved in ~/.egpt/summaries/<name>.md)
# ────────────────────────────────────────────────────────────────────────
/save my-answer                                # save the latest non-system msg verbatim
/summarize today                               # fresh agent compresses the room → today.md
/summaries                                     # list saved summaries
/inject today                                  # drop today.md into room as a system note

# typical flow:
#   long conversation in room A about topic X
#   /summarize topic-x         → ~/.egpt/summaries/topic-x.md
#   in a new egpt session against room B:
#   /inject topic-x            → topic-x context now ambient in room B
#   /inject topic-x codex      → topic-x context sent directly to codex


# ────────────────────────────────────────────────────────────────────────
# Recovery / when things go weird
# ────────────────────────────────────────────────────────────────────────
Ctrl+R                                        # force-reset UI if a brain hangs
                                              # (the in-flight stream is abandoned)
/refresh                                      # re-poll the CDP tab; append latest text
                                              # (use when streaming finalized too early)
/last 20                                      # the file is the truth — read it
/exit                                         # then relaunch if Ink itself wedges


# ────────────────────────────────────────────────────────────────────────
# Working with the conversation file alongside egpt
# ────────────────────────────────────────────────────────────────────────
# in another terminal:
tail -f ~/notes/today.md                      # follow turns as they land
vim   ~/notes/today.md                        # edit history (the file is canonical)
rg "claude_code" ~/notes/                     # grep across many conversations
```

---

## What egpt is, in one paragraph

A small Node daemon that gives you one terminal-based chat surface where multiple AIs participate as named peers in a shared Markdown-backed conversation. Talks to **ChatGPT.com / Claude.ai** by driving real browser tabs over Chrome DevTools Protocol (no API tokens — uses your existing accounts) and to **Claude Code / Codex** as local CLIs (full shell + filesystem access). The conversation file is yours, portable, and the only canonical record.

---

## The conversation file

Every chat is a plain Markdown file. The default is `./conversation.md` in the directory where you ran `node egpt.mjs`. Override with the first argument:

```bash
node egpt.mjs ~/notes/2026-05-02.md
```

The format:

```markdown
# Conversation

---

## 2026-05-02 14:32 — You
hola, qué tal?

## 2026-05-02 14:32 — ccode1
Bien gracias. ¿En qué te ayudo?

## 2026-05-02 14:33 — You
@cgpt1 y tú qué dices?

## 2026-05-02 14:33 — cgpt1
Coincido con ccode1 en lo principal, pero...
```

This file is **the source of truth**. egpt appends to it on every turn. You can:

- `tail -f` it in another terminal to follow live
- Edit it in vim — delete embarrassing turns, fix typos, condense earlier sections
- Copy it into a new egpt session as a starting point
- Grep across many of them with `rg`

When using a CDP brain or `claude --resume`, the brain has its *own* native memory (the chatgpt tab keeps its history; claude has its JSONL). The file remains the cross-brain log everyone in the room sees.

---

## Sessions and brains

A **session** is a named participant in the conversation. It has:

- A **brain** — the type of AI (`ccode`, `codex`, `chatgpt-cdp`, `claude-cdp`)
- A **name** — like `ccode1`, `codex1`, `cgpt1`, `claude1`
- **Options** — which tab, which Claude Code session ID, etc.

### Auto-naming

Sessions auto-name by convention:

| Brain          | Session prefix | Example names                |
|----------------|----------------|------------------------------|
| `ccode`        | `ccode`        | `ccode1`, `ccode2`, `ccode3` |
| `chatgpt-cdp`  | `cgpt`         | `cgpt1`, `cgpt2`             |
| `claude-cdp`   | `claude`       | `claude1`, `claude2`         |
| `codex`        | `codex`        | `codex1`, `codex2`           |

Numbers grow per brain. Names are auto-assigned on `/open` and `/attach`. You can pass an explicit name to override (`/open chatgpt-cdp gpt-research`).

### What egpt does at startup

1. Starts the room using the chosen Markdown conversation file.
2. Detects brain Chrome on port 9221 (its private debug port). If found and the
   token-auth proxy isn't already running on 9222, egpt auto-starts the proxy
   and writes `~/.egpt/cdp-token` so future calls go through it.
3. Once the proxy is up (port 9222), scans tabs and auto-attaches each
   matching one as `cgpt1`, `claude1`, etc.
4. Leaves the room otherwise empty until you `/open` or `/attach` a participant.

If Chrome isn't running, slash commands still work in empty-room mode. Type `/chrome` to launch a brain Chrome with the extension, or add a local brain with `/open ccode ccode1`, `/open codex`, or `/attach codex`.

### Brain profiles

A brain profile is a YAML preset for a named participant. `/attach alex` looks for `alex.yaml` in:

- `./.egpt/brains/` for project-local profiles
- `~/.egpt/brains/` for personal profiles
- `<egpt repo>/brains/type/` or `<egpt repo>/brains/types/` for repo-defined profiles

Minimal Codex profile:

```yaml
name: alex
type: codex
model: gpt-5.5
effort: low
cwd: C:\Users\an\src\egpt
summary: alex
chat_name: Alex
```

`type` accepts `codex`, `code`/`ccode`, `cdp_chat`, and `cdp_claude`. `summary: alex` injects `~/.egpt/summaries/alex.md` into the new session on attach. Native Codex/Claude thread IDs are not resumed by default; set `resume: true` or `session_id: <id>` if you explicitly want native resume instead of a fresh session plus summary context.

For existing web conversations, let egpt write the minimal profile:

```text
/profile alex https://chatgpt.com/c/69f68099-5cf8-8328-ad8f-37d991ff0071
/profile 69f68099-5cf8-8328-ad8f-37d991ff0071 alex
```

The first form is `<name> <urlOrId>`; the second is `<urlOrId> <name>`. Bare UUIDs become `https://chatgpt.com/c/<id>`. Full `chatgpt.com`, `chat.openai.com`, and `claude.ai` URLs are detected from the host. Profiles are saved to `~/.egpt/brains/` by default; use `--project` or `--repo` to write elsewhere, `--force` to overwrite the same file, and `--attach` to attach immediately after saving.

The same writer works from the shell:

```bash
node egpt.mjs profile alex 69f68099-5cf8-8328-ad8f-37d991ff0071
```

Runtime state is written to `~/.egpt/brain-state/<profile>.json`. It records the last cwd, thread id, model/effort, log path, and tab target when available. `/profiles` lists profiles; `/sessions` shows which live sessions came from a profile.

### Routing

A leading `@name` sends a turn to one session:

```
@cgpt1 ¿qué piensas?
```

The `@mention` syntax is recognized only at the **start** of a message. Messages without a leading mention broadcast to every session in the room. If the room is empty, egpt does not append the message to the conversation file.

```
@codex exec: pwd                              # one session
hello all                                     # broadcast
```

---

## The brain types

### `ccode` (local Claude Code CLI)

Spawns `claude --print` as a subprocess. Two modes:

**Stateless (default)** — each turn pipes the entire `.md` file as input. Claude reads the whole conversation as one big prompt, replies, exits. The `.md` file IS the memory; ccode itself has no continuity between turns.

**Resume mode** — set with `/session <id>`:

```
/history                                      # list available Claude Code JSONLs
/session 26b30e57                             # resume by id (cwd auto-detected)
```

In resume mode, egpt runs `claude --resume <id>` each turn and pipes only the *new* user message. Claude reads its native JSONL session memory directly. This is real session continuity — same memory as if you were typing in the Claude Code TUI.

Trade-off: in resume mode, claude only sees the new turn, not the cross-brain shared room. The `.md` file still gets appended for human readability.

### `chatgpt-cdp`, `claude-cdp` (web UI via CDP)

Drive a tab in a CDP-exposed Chrome instance. Each session is bound to one tab; the tab keeps its own conversation history natively.

Setup:

```bash
node egpt.mjs                                 # then /chrome inside to launch the brain Chrome
# log in to chatgpt.com / claude.ai once if needed (profile persists at ~/.egpt/egpt-brain)
# start or open a conversation in that tab
```

The tab gets auto-attached on startup. Or `/open chatgpt-cdp` to launch a fresh one.

How it works internally:

- egpt opens a WebSocket to the tab's CDP URL
- Sends `Runtime.evaluate` to paste the message into `#prompt-textarea` and click submit
- Polls the DOM every 250ms for the latest assistant message
- Resolves when the stop button is gone AND text is stable for ≥1 second
- Has a 5-second text-stability fallback if stop-button detection fails entirely

Selectors use **only** locale-stable signals: `data-testid`, `id`, `data-is-streaming`. No `aria-label` (those get translated and overmatch).

### `codex` (local CLI + shell operator)

Address `@codex ...` to use the local Codex integration. `@codex exec: <command>` runs a shell command in the Codex session's persistent cwd and returns:

```
$ <command>
<stdout/stderr>
```

`@codex exec: cd <dir>` updates that cwd for later commands. Non-`exec:` messages are passed to `codex exec` non-interactively, and later turns resume the Codex thread. Codex does not receive the whole egpt transcript automatically; summarize and inject context intentionally with `/summarize <name>` followed by `/inject <name> codex`.

Codex storage is separate from the egpt room:

- `conversation.md` is the shared room transcript.
- `~/.egpt/codex/<session>.jsonl` is egpt's tail-able mirror of Codex events.
- `~/.codex/sessions/.../rollout-<timestamp>-<thread-id>.jsonl` is Codex's native rollout file.

Run `/sessions` after the first Codex turn to see the Codex thread id, cwd, model, effort, and egpt mirror log path. egpt invokes Codex with `model_reasoning_effort="low"` by default because that is the lowest effort supported by this CLI; set `EGPT_CODEX_REASONING_EFFORT=medium`, `high`, or `xhigh` before launch to override, or set `effort:` in a brain profile. A Codex profile can also pass `model:` through to `codex exec -m`.

---

## Multi-brain rooms

Once two or more AI sessions share a conversation, you want some etiquette. Two mechanisms:

### Routing (egpt does it for you)

Un-addressed messages broadcast to every session in the room. Use `@session` when you want a single recipient, especially for operator commands like `@codex exec: ...`.

### Polite silence (the brain decides)

When a brain *does* see a message (e.g., via `@mention`), it doesn't have to reply. By convention, replying with literally `...` (three or more dots, or the Unicode ellipsis `…`) means "acknowledged, nothing useful to add." egpt detects this and:

- **doesn't append** the silence to the file (keeps the canonical log clean)
- shows a small `cgpt1 acknowledged silently (...)` note in the transcript

For brains to honor this convention, they need to know about it. Use `/rules` once at the start of a multi-brain conversation:

```
/rules
```

This writes a system message into the file describing:
- the silence convention,
- when to speak (addressed, useful, asked by admin),
- the `@mention` mechanism for participants to ask each other things.

Any brain that reads the `.md` (stateless ccode, all CDP brains) will absorb this as ambient context.

### Sending local file excerpts

Use `/send-file` when the source of context is already on disk but the range is
best described in natural language. A local operator prepares the excerpt first,
then egpt sends the prepared file to the target:

```text
/send-file via=codex1 @cgpt1 "find the TPOEF book and send everything before chapter 8"
/send-file via=codex1 "C:\Users\an\src\siran\writing\site\books\The Physics of Energy Flow\The Physics of Energy Flow.md" @cgpt1 "before chapter 8"
/send-file "C:\Users\an\.egpt\prepared-files\2026-05-03T01-03-30-619Z-codex1-null" @cgpt1
```

The source path is optional; if omitted, the operator infers/finds the file from
the instruction and local context. The target `@session` must already be
registered. If `via=` is omitted, egpt uses the only registered local operator
when there is exactly one.

If a prepared excerpt is over the default 120k character guard, egpt saves it
and does not paste it yet. Use the reported file path with `/send-file
"<prepared-path>" @target` to send exactly that prepared artifact. Paths under
`~/.egpt/prepared-files/` are treated as already prepared and are sent directly
instead of going back through the operator.

Use `/paste-file` when you already know the exact marker and want deterministic
slicing without asking an operator:

```text
/paste-file alex "C:\Users\an\src\siran\writing\site\books\The Physics of Energy Flow\The Physics of Energy Flow.md" --before "# 8."
```

Both commands send the excerpt to the target session but only write a short
system note to `conversation.md`. By default egpt sends only the file content;
it does not prepend response instructions. Add `--ask "what do you think of
Part I?"` to append a question after the pasted content. `/paste-file` marker
options are plain substring matches:

- `--before <marker>` excludes the marker and everything after it
- `--after <marker>` excludes everything through the marker
- `--from <marker>` includes the marker and everything after it
- `--to <marker>` includes text through the marker

Large accidental pastes are capped at 120k characters; use `--max 0` or `--all`
to send a larger excerpt intentionally.

---

## Slash command reference

The shell's `/help` is generated from `interpreter.mjs`, which is the source
of truth. The list below mirrors it; if they ever diverge, the registry wins.

```
Room:
  /exit                         leave egpt
  /file                         show the conversation file path
  /status                       room snapshot: sessions, files, config
  /conversations                list available conversation files
  /conversation <name|path>     switch the room to a different conversation file
                                (creates it with a stub header if missing)
  /last [N]                     show last N messages from the file (default 10)
  /rules                        write room-rules system message into the file
  /help                         this list

Sessions (named participants in the room):
  /open <brain> [name]          open a new tab/subprocess and register a session
  /attach                       rescan Chrome and attach any new tabs
  /attach <profile> [name]      start a YAML brain profile
  /attach <brain> [name] [tab]  attach CDP tabs or create a local session
  /detach <name>                remove a session from the room
  /sessions                     list registered sessions
  /sessions default <name>      set the default operator session (persisted)
  /sessions default clear       clear the default
  /handle <old> <new>           rename a session
  /emoji [name emoji]           show or set a session avatar
  /bio [name [text]]            show or set a session bio

Profiles (~/.egpt/brains/*.yaml):
  /profiles                     list YAML brain profiles
  /profile <name> <urlOrId>     create a ChatGPT/Claude URL profile
  /create-profile [name]        interactive profile wizard

Browser brains:
  /tabs [all]                   list pages in brain Chrome (chrome:// hidden)
  /refresh [@<session>]         re-poll a CDP tab; append latest assistant text
                                (recovery for premature streaming termination)
  /browse [via=<op>] [url] [@name] ["instr"]
                                drive Chrome via CDP (auto-attaches operator if none active)
  /continue                     resume after browser.waitForHuman() pause
  /mirror [@<src>] [@<tgt>]     forward a message between sessions

Files:
  /send-file [via=<op>] [<path>] @<session> ["<instruction>"]
                                prepare excerpt, or send prepared file
  /paste-file <session> <path>  paste a local file/excerpt into one session
                                supports --before/--after markers and --ask

Local brains/operators:
  /history [N]                  list recent ccode sessions on disk (newest first)
  /session [<name>] <id>        --resume the session against an existing JSONL
                                (cwd auto-detected unless overridden)
  /session [<name>] none        back to stateless mode
  @codex exec: <command>        run shell command in codex cwd
  @codex exec: cd <dir>         change codex cwd for later commands

Reusable distillations (~/.egpt/summaries/<name>.md):
  /save <name>                  save the latest non-system message verbatim
  /summarize [all|last N] <name> [<brain>]
                                fresh agent compresses the room → summary file
  /summaries                    list saved summaries
  /inject <name> [session]      drop a saved summary into the room or one session
  /prompts [on|off]             show/hide the full prompt sent to operators

Appearance & config:
  /themes                       list available color themes
  /theme <name|next|prev>       switch theme live (no restart needed)
  /config                       show local .egpt/config.json + valid keys
  /config <key>                 read a config value
  /config <key> <value>         write a config value
                                keys: theme, show_prompts, unix_paths, tz_label
                                (tz_label overrides the system tz suffix on
                                 timestamps with a short city tag like NYC,
                                 MAD, BEI — useful in distributed rooms)

Conversation routing:
  @<name> <message>             address one session for THIS turn only
  <message>                     broadcast to every session in the room

tabSpec accepts: full URL · UUID · targetId · 6+ char id prefix
Brains: ccode, codex, chatgpt-cdp, claude-cdp

Brain Chrome lifecycle is automatic — the shell handles spawn + connect.
Close the Chrome window manually when you're done.
```

---

## Brain Chrome lifecycle

Spawn is explicit; attach is automatic. On startup, `egpt.mjs`:

1. Checks for the proxy on `:9222`. If up, attaches.
2. Else checks for raw Chrome on `:9221`. If up, starts the proxy and attaches.
3. Else surfaces a hint: type `/chrome` to launch one, or start Chrome yourself.

`/chrome` (shell command) spawns Chrome with `--remote-debugging-port=9221 --user-data-dir=~/.egpt/egpt-brain --load-extension=<repo>/extension/dist`. A 5-second poll then picks up the new instance and proceeds with proxy + attach. The same poll handles a manually-launched Chrome (e.g. via desktop shortcut) and recovery if the connection drops.

Chrome is spawned **detached**, so it survives shell restart. Close it
manually when you're done with the session. The profile at
`~/.egpt/egpt-brain` persists your ChatGPT/Claude logins across runs.

To start Chrome manually with the right flags (no shell needed):

```bash
google-chrome \
  --remote-debugging-port=9221 \
  --user-data-dir=~/.egpt/egpt-brain \
  --load-extension=~/src/egpt/extension/dist \
  --no-first-run --new-window
```

Or on Windows (PowerShell):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9221 `
  --user-data-dir="$env:USERPROFILE\.egpt\egpt-brain" `
  --load-extension="$env:USERPROFILE\src\egpt\extension\dist" `
  --no-first-run --new-window
```

---

## Recovery

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot reach Chrome at localhost:9222` | Brain Chrome isn't running | type `/chrome` inside egpt to launch one, or run Chrome manually with the flags in the lifecycle section above |
| Streaming reply seems frozen, no progress | Premature finalize OR locale-specific selector miss | `Ctrl+R` to reset, then `/refresh` to pull the actual final text from the tab |
| `auto-bound cgpt1 to tab abc12345…` | Old tab closed; egpt found a single matching replacement | Normal recovery — nothing to do |
| Multiple `cgpt` tabs open and a brain-name address is ambiguous | Ambiguity is intentional — pick one | `@cgpt2 ...` (use the explicit name) |
| Spinner counts up past 30s with no first token | ccode processing a large file | Wait, or `Ctrl+R` and try with a shorter `/file` |
| egpt UI itself hangs (Ink wedge) | Rare; usually after an Ink render error | `/exit` and relaunch — the file is intact |
| `claude not found on PATH` | Claude Code CLI not installed | `npm i -g @anthropic-ai/claude-code` |
| Want to undo a brain reply | Edit the .md file directly | `vim` — remove the offending `## ts — name` block |

---

## Layout

```
~/src/egpt/
├── egpt.mjs               # main app — Ink UI, slash commands, room state
├── interpreter.mjs        # shared input parser + command registry (shell + extension)
├── brains/
│   ├── claude-code.mjs    # subprocess brain (stateless or --resume)
│   ├── codex.mjs          # Codex CLI + exec: shell operator
│   ├── chatgpt-cdp.mjs    # ChatGPT.com selectors + inject + poll
│   ├── claude-cdp.mjs     # Claude.ai (same shape, different selectors)
│   └── type/              # repo-defined YAML brain profiles + skeleton
├── bridges/
│   └── telegram.mjs       # Telegram Bot API bridge (long-poll + send)
├── tools/
│   ├── cdp.mjs            # shared CDP plumbing: listTabs, openTab, peekTab,
│   │                      #   streamFromTab, browseTab, closeBrowser, isRunning
│   ├── cdp-proxy.mjs      # token-auth reverse proxy (Chrome:9221 → LAN:9222)
│   ├── chrome-launcher.mjs# locate + spawn Chrome (one Chrome hosts brain tabs, extension, and bus)
│   ├── browser-tools.mjs  # CDP control library for operator scripts
│   ├── template.mjs       # command prompt template loader
│   └── theme.mjs          # color theme loader + listThemes()
├── commands/              # operator prompt templates ({{variable}} substitution)
│   ├── browse.md          # CDP browser-automation task
│   ├── codex-task.md
│   ├── inject.md
│   ├── send-file.md
│   └── summarize.md
├── extension/             # Chrome MV3 extension (same brains, no external ports)
│   ├── manifest.json
│   ├── build.mjs          # esbuild; shims tools/cdp.mjs → chrome.debugger adapter
│   └── src/
│       ├── tab/           # main UI (App.jsx, Input.jsx, style.css, index.html)
│       ├── settings/      # settings page (Settings.jsx, style.css)
│       ├── tools/cdp-ext.js  # chrome.debugger adapter (drop-in for tools/cdp.mjs)
│       ├── storage.js     # IndexedDB conversation history
│       └── background.js  # service worker (opens the tab)
├── themes/                # 10 built-in color themes (override in ~/.egpt/themes/)
│   ├── catppuccin.json    # shipped default
│   └── ...
├── package.json           # type:module · ink + react + yaml + codemirror
├── README.md              # what & why
└── MANUAL.md              # this file

~/.egpt/
├── config.json            # global config (bot tokens, theme, etc.) — DO NOT commit
├── egpt-brain/            # persistent Chrome profile for the brain Chrome
├── egpt-extension/        # persistent Chrome profile for the extension Chrome
├── cdp-token              # token for the localhost-LAN CDP proxy
├── brain-state/<name>.json # runtime state per attached brain profile
├── prepared-files/        # excerpts staged by /send-file
├── codex/<session>.jsonl  # egpt's mirror of codex events
├── summaries/<name>.md    # saved & summarized conversations
└── themes/<name>.json     # user theme overrides (same keys as themes/*.json)

.egpt/                     # project-local config (in cwd, can be committed)
└── config.json            # overrides ~/.egpt/config.json (keys: theme, show_prompts, unix_paths)
```

A few thousand lines of code. The shell has no build step (plain Node ESM); the
browser extension is bundled with esbuild via `npm run build:ext`. Runtime
dependencies: `ink`, `react`, `react-dom`, `yaml`, plus CodeMirror for the
extension input.

---

## Conventions and ergonomics worth knowing

- **Auto-naming, never required**: pass a name explicitly when you want one (`/open chatgpt-cdp planning`), otherwise let egpt pick (`cgpt1`, `cgpt2`, ...).
- **Auto-attach on startup**: every matching tab in the brain Chrome is registered as a session before the first prompt. You don't run `/attach` unless you opened tabs after egpt started.
- **The `.md` file is the truth for routing**: if you ever feel egpt and the brains are out of sync about what was said, trust the `.md`. CDP brains have their own tab memory; you can manually paste the `.md` contents into any tab to reset its internal context.
- **Streaming and elapsed time visible always**: when a brain is working, you see a spinner + elapsed seconds + char count of the in-progress reply. If those numbers stop moving, something is stuck — `Ctrl+R` to escape.
- **Locale-stable selectors**: the CDP brains do not look at any user-facing UI text (`aria-label`, button labels). Only `data-testid`, `id`, and DOM-state attributes. Switching ChatGPT to a different language doesn't break egpt.

---

## See also

- [`README.md`](./README.md) — the project's "why" and architecture overview
- The conversation file format — read your own `conversation.md` to see how plain it is

The seed of egpt is small enough that all of `egpt.mjs` is worth a read end-to-end. Most of what's here is one or two lines of code per concept; the architecture is just the names we agreed on for those lines.
