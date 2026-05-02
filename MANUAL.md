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
# inside egpt:
/open ccode ccode1                            # add local Claude Code participant
@ccode1 hola                                  # say hello to that session
/file                                         # which file are we writing to?
/last 5                                       # show last 5 turns from the file
/exit


# ────────────────────────────────────────────────────────────────────────
# Multi-brain: bring in ChatGPT and/or Claude.ai
# ────────────────────────────────────────────────────────────────────────
~/src/egpt/launch-brain.sh                    # start brain Chrome (chatgpt.com)
~/src/egpt/launch-brain.sh start https://claude.ai/new
~/src/egpt/launch-brain.sh status             # running? how many tabs?
~/src/egpt/launch-brain.sh stop               # close cleanly via CDP

# log in to chatgpt.com / claude.ai once in the brain Chrome window
# the profile persists at ~/.egpt/brain-profile

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
- A **name** — like `ccode1`, `codex`, `cgpt1`, `claude1`
- **Options** — which tab, which Claude Code session ID, etc.

### Auto-naming

Sessions auto-name by convention:

| Brain          | Session prefix | Example names                |
|----------------|----------------|------------------------------|
| `ccode`        | `ccode`        | `ccode1`, `ccode2`, `ccode3` |
| `chatgpt-cdp`  | `cgpt`         | `cgpt1`, `cgpt2`             |
| `claude-cdp`   | `claude`       | `claude1`, `claude2`         |
| `codex`        | `codex`        | `codex`, `codex1`, `codex2`  |

Numbers grow per brain. Names are auto-assigned on `/open` and `/attach`. You can pass an explicit name to override (`/open chatgpt-cdp gpt-research`).

### What egpt does at startup

1. Starts the room using the chosen Markdown conversation file.
2. If brain Chrome is running on port 9222, scans tabs and auto-attaches each matching one as `cgpt1`, `claude1`, etc.
3. Leaves the room otherwise empty until you `/open` or `/attach` a participant.

If Chrome isn't running, slash commands still work in empty-room mode. Add a local brain with `/open ccode ccode1` or `/open codex`.

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
~/src/egpt/launch-brain.sh                    # opens chatgpt.com on port 9222
# log in if needed (profile persists)
# start or open a conversation in that tab
```

Then in egpt, the tab gets auto-attached on startup. Or `/open chatgpt-cdp` to launch a fresh one.

How it works internally:

- egpt opens a WebSocket to the tab's CDP URL
- Sends `Runtime.evaluate` to inject the message into `#prompt-textarea` and click submit
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

Run `/sessions` after the first Codex turn to see the Codex thread id, cwd, effort, and egpt mirror log path. egpt invokes Codex with `model_reasoning_effort="low"` by default because that is the lowest effort supported by this CLI; set `EGPT_CODEX_REASONING_EFFORT=medium`, `high`, or `xhigh` before launch to override.

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

---

## Slash command reference

```
General:
  /exit                         leave egpt
  /file                         show the conversation file path
  /help                         this list

Sessions (named participants in the room):
  /open <brain> [name]          open a new tab + register session (auto-name if no name)
  /attach                       rescan Chrome and attach any new tabs
  /attach <brain>               attach all unattached tabs of that brain
  /attach <brain> <name> [tab]  explicit attach
  /sessions                     list registered sessions

Browser brains:
  /tabs [all]                   list pages in brain Chrome (chrome:// hidden)
  /brain [status|stop]          brain Chrome lifecycle (CDP-based)
  /refresh                      re-poll current CDP tab; append the latest assistant text
                                (recovery for premature streaming termination)

Local brains/operators:
  /history [N]                  list recent ccode sessions on disk (newest first)
  /session [<id>]               continue an existing ccode session via --resume
                                (cwd auto-detected from the JSONL)
  /session <id> <cwd>           explicit cwd if auto-detection fails
  /session none                 back to stateless mode
  @codex exec: <command>        run shell command in codex cwd
  @codex exec: cd <dir>         change codex cwd for later commands

Conversation:
  /rules                        write room-rules system message into the file
  /last [N]                     show last N messages from the file (default 10)
  @<name> <message>             address a session for THIS turn only

Reusable distillations (~/.egpt/summaries/<name>.md):
  /save <name>                  save the latest non-system message verbatim
  /summarize <name>              fresh agent compresses the room → summary file
  /summaries                    list saved summaries
  /inject <name> [session]      drop a saved summary into the room or one session

tabSpec accepts: full URL · UUID · targetId · 6+ char id prefix
Brains: ccode, codex, chatgpt-cdp, claude-cdp
```

---

## Brain Chrome lifecycle

Manage from any terminal — no need to be inside egpt:

```bash
~/src/egpt/launch-brain.sh                    # default: chatgpt.com on 9222
~/src/egpt/launch-brain.sh start [url]
~/src/egpt/launch-brain.sh stop               # CDP Browser.close — clean shutdown
~/src/egpt/launch-brain.sh status             # running? how many pages?
~/src/egpt/launch-brain.sh restart [url]

# Override port or profile via env vars:
PORT=9223 ~/src/egpt/launch-brain.sh start
PROFILE=~/.brain-experiment ~/src/egpt/launch-brain.sh start
```

Notes:

- The launcher traps `SIGINT` and `SIGTERM`. So `Ctrl+C` in the terminal where you launched it closes the brain Chrome via CDP cleanly (not a hard kill).
- The default profile is `$HOME/.egpt/brain-profile` — completely separate from your normal Chrome profile, persists across reboots so you don't have to re-log in.
- The launcher refuses to start if a brain is already running on the port. Use `restart` to swap.

---

## Recovery

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot reach Chrome at localhost:9222` | Brain Chrome isn't running | `~/src/egpt/launch-brain.sh start` |
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
├── brains/
│   ├── cdp.mjs            # shared CDP plumbing: listTabs, openTab, peekTab,
│   │                      #   streamFromTab, closeBrowser, isRunning
│   ├── claude-code.mjs    # subprocess brain (stateless or --resume)
│   ├── chatgpt-cdp.mjs    # ChatGPT.com selectors + inject + poll
│   └── claude-cdp.mjs     # Claude.ai (same shape, different selectors)
├── bridges/
│   └── telegram.mjs       # Telegram bot bridge (long-poll + send)
├── launch-brain.sh        # platform-aware Chrome launcher (Linux/macOS/MSYS2)
├── package.json           # type:module · ink + react
├── README.md              # what & why
└── MANUAL.md              # this file

~/.egpt/
├── config.json            # secrets (bot tokens, allowed users) — DO NOT commit
├── brain-profile/         # persistent Chrome profile for the brain Chrome
└── summaries/<name>.md    # saved & summarized conversations
```

About a thousand lines of code, no build step, two runtime dependencies (`ink`, `react`).

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
