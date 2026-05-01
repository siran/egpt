# egpt

**Multi-brain chat orchestrator. No API tokens — just your existing ChatGPT, Claude, Claude Code, and Codex accounts, talking through one terminal.**

```
Claude  +  ChatGPT  +  Codex  +  Claude Code  +  Telegram  +  shell  +  browser ext
                            ──── all connected ────
```

The pitch in one breath: it joins your **web AIs** (ChatGPT.com, Claude.ai — driven via Chrome DevTools Protocol) with your **local CLIs** (Claude Code, Codex — driven as subprocesses), inside a single Markdown-backed conversation, accessible from terminal today and from Telegram + browser extension soon. Like a desktop bridge for multiple AIs, but **account-driven, not API-driven**.

## Why no API?

Because the API isn't where most of you live. ChatGPT Plus and Claude Pro have memory, projects, custom GPTs, file uploads, web browsing — features that don't exist (or cost extra) over the API. You're already paying. egpt drives those accounts directly through their web UI.

The trade-off: you keep a Chrome instance logged in. You launch it once with `launch-brain.sh`. The daemon talks to its tabs over CDP.

## Three asymmetries this fixes

| Tool | Strength | Trapped where |
|---|---|---|
| ChatGPT.com / Claude.ai | rich rendering, memory, paid features | inside the browser |
| Claude Code / Codex CLI | shell + filesystem access, real agent loops | on the laptop in front of you |
| Anthropic / OpenAI API | scriptable, automatable | per-token billing, no UI features |

`egpt` is the small daemon that gives one canonical conversation a way to talk to all three.

## What works today

- ✅ A terminal chat shell (Ink + plain Node, no build step) — multi-line input, ↑/↓ history recall, visible spaces, slash commands, streaming reply display
- ✅ Plain Markdown file as conversation source-of-truth (`tail -f`-friendly, vim-editable, grep-able)
- ✅ Three working brains:
  - `claude-code` — local subprocess of `claude` CLI; full conversation history sent each turn; streaming via `stream-json`
  - `chatgpt-cdp` — drives ChatGPT.com in a CDP-exposed Chrome; tab keeps its own history
  - `claude-cdp` — drives Claude.ai the same way
- ✅ Multi-participant model: register as many sessions as you want (`/open chatgpt-cdp gpt1`, `/open claude-cdp claude1`); each shows up as a distinct author in the log
- ✅ Auto-recovery: when a tab dies, the daemon silently rebinds to a single matching open tab
- ✅ Browser lifecycle: `launch-brain.sh start | stop | status | restart`, persistent profile dir at `~/.egpt/brain-profile`, Ctrl+C in the launching terminal closes the brain cleanly via CDP `Browser.close`
- ✅ `/refresh` — re-poll the current CDP tab and append the full assistant message (recovery from premature streaming-end detection)
- ✅ `/last [N]` — replay the last N messages from the conversation file

## What's coming

- 🛠 **`@mentions`** — address a guest brain without changing principal (`@claude1 ¿qué piensas?`). Replies mirror back to the principal's tab.
- 🛠 **Telegram bridge** — same conversation, accessible from your phone. Bot polls Telegram; messages flow into the same Markdown file; replies go back via the bot.
- 🛠 **Browser extension** — display surface for the conversation, plus a CDP brain runner so the daemon can be on a home server while the brains live in your laptop's Chrome
- 🛠 **Admin / queue / flush** — when multiple humans are chatting in a Telegram group, the admin controls when the queue gets flushed to the brains (avoids noise polluting brain context)
- 🛠 **Federation (v2)** — multiple egpt daemons connected by a peer bridge; one conversation can span home server + laptop + phone

## Quick start

```bash
# install (one time)
cd ~/src/egpt
npm install

# in terminal A — launch the brain Chrome (logs in once, profile persists)
./launch-brain.sh                            # default: opens chatgpt.com
./launch-brain.sh start https://claude.ai    # or claude
./launch-brain.sh status                     # is it running?
./launch-brain.sh stop                       # close cleanly via CDP

# in terminal B — run the chat
node egpt.mjs                                # uses ./conversation.md
node egpt.mjs ~/conversations/foo.md         # explicit path

# inside egpt
/help                                        # all commands
/principal claude-code                       # default; local subprocess
/principal chatgpt-cdp                       # auto-binds the open chatgpt tab
/open claude-cdp claude1                     # opens a fresh claude.ai tab, named claude1
/sessions                                    # see who's registered
/last 5                                      # replay last 5 messages from the file
/refresh                                     # if a streaming reply got cut off
/exit
```

The conversation file (`conversation.md`) stays open for tail/edit:

```markdown
# Conversation

---

## 2026-05-01 14:32 — You
hola, ¿qué tal?

## 2026-05-01 14:32 — chatgpt-cdp
Bien, gracias. ¿En qué te ayudo?

## 2026-05-01 14:33 — You
abre claude también para comparar respuestas

## 2026-05-01 14:34 — claude1
Sobre la pregunta original...
```

## Slash commands

```
/exit · /file · /help
/open <brain> <name>            open a fresh tab and register a new session
/principal [name [tabSpec]]     switch (or create) principal session.
                                tabSpec: targetId | url | uuid | prefix
/sessions                       list registered sessions
/tabs [all]                     list pages in the brain Chrome (chrome:// hidden)
/brain [status|stop]            brain Chrome lifecycle (CDP-based)
/refresh                        re-poll current CDP tab; append full text
                                (use when streaming was cut off)
/last [N]                       show last N messages from the file (default 10)
```

## Architecture

A small core, many bridges. The core is platform-agnostic logic; the bridges translate between core and the outside world. The whole thing is plain ES modules so future bridges (Telegram bot, browser extension) can share the same code.

```
┌─────────────────────────────────────┐
│              core                   │  conversation, routing,
│   (currently inline in egpt.mjs)    │  sessions, mirroring rules
└─────────────────────────────────────┘
           ▲           ▲           ▲
   ┌───────┘     ┌─────┘    └──────────┐
   │             │                     │
┌──┴────┐  ┌─────┴──────┐         ┌────┴───┐
│ human │  │   brain    │         │storage │
│bridges│  │  bridges   │         │bridges │
├───────┤  ├────────────┤         ├────────┤
│ shell │  │claude-code │         │ fs     │
│  ✅   │  │  ✅        │         │  ✅    │
│telegram│ │chatgpt-cdp │         │chrome- │
│  🛠   │  │  ✅        │         │ storage│
│ext    │  │claude-cdp  │         │  🛠    │
│  🛠   │  │  ✅        │         │        │
│       │  │codex 🛠    │         │        │
└───────┘  └────────────┘         └────────┘
```

A new brain is one file in `brains/`. A new input is one file in (eventually) `bridges-node/humans/` or `bridges-extension/humans/`.

## Layout

```
egpt/
├── egpt.mjs               # main app: Ink UI + slash commands + session state
├── brains/
│   ├── cdp.mjs            # shared CDP plumbing: listTabs, openTab, findTab,
│   │                      #   streamFromTab, peekTab, closeBrowser
│   ├── claude-code.mjs    # subprocess `claude --print --output-format stream-json`
│   ├── chatgpt-cdp.mjs    # ChatGPT.com selectors + inject + poll
│   └── claude-cdp.mjs     # Claude.ai selectors + inject + poll
├── launch-brain.sh        # platform-aware Chrome launcher (Linux/macOS/MSYS2)
├── package.json           # type:module, ink + react as deps
└── README.md
```

Around 1100 lines of code total, ~10 files.

## How the brains work

### Subprocess brain (`claude-code`)

Each turn: spawn `claude --print --output-format stream-json --include-partial-messages`, pipe the full conversation history to stdin, parse newline-delimited JSON for token deltas, accumulate, return final text on `result` event.

### CDP brains (`chatgpt-cdp`, `claude-cdp`)

Each turn:
1. Connect to Chrome's HTTP debug endpoint, find the bound tab by `targetId`
2. Open a WebSocket to that tab's `webSocketDebuggerUrl`
3. `Runtime.evaluate` an inject script: drop the message into the page's prompt-textarea (or contenteditable), dispatch input events, click the submit button
4. Poll the DOM at 250ms ticks via `Runtime.evaluate`, watching for the latest assistant message
5. Resolve when the stop-button is gone *and* text is stable — both for ≥4 consecutive ticks (~1s of agreement). Locale-aware (Spanish, French, German, etc.) so it doesn't false-finalize when the UI isn't English.

### Why polling and not streaming events?

Both web UIs render via React; they don't expose the SSE token stream cleanly to extensions or CDP scripts. Polling the rendered DOM is brittle but universal. The 1-second stability window is a deliberate tradeoff against false "done" signals during LaTeX/code rendering pauses.

## Caveats and known limits

- **Selectors break.** When ChatGPT or Claude redesigns their UI, the inject/poll scripts in `brains/*-cdp.mjs` will need tweaking. They're written defensively (multiple fallback selectors), but not future-proof.
- **One language detected, others guessed.** Stop-button labels are matched in English, Spanish, French, German, Swedish, Portuguese. Other locales may need adding.
- **Tab-as-context.** A CDP brain remembers conversation history *in its tab*. If you switch from `claude-code` to `chatgpt-cdp` mid-conversation, ChatGPT only knows what it had in its own tab — not the egpt log. Solved cleanly by the planned multi-participant model where each session has full context.
- **Markdown file as truth.** Slash commands aren't logged. Your messages and brain replies are.

## License

Personal project. Not redistributing for now.

## Origin

Successor to [`siran/egptjs`](https://github.com/siran/egptjs) — a Chrome MV3 extension that bridged Telegram → ChatGPT via CDP. The original idea (CDP + chat-id-to-tab mapping + multi-Telegram-user with attribution prefixes) was sound; the MV3 service worker was the wrong runtime for an orchestrator. egpt rewrites it as a Node daemon, with the extension demoted to a future display surface.
