# egpt

**Multi-brain chat orchestrator. No API tokens — just your existing ChatGPT, Claude, Claude Code, and Codex accounts, talking through one terminal.**

```
Claude  +  ChatGPT  +  Codex  +  Claude Code  +  Telegram  +  shell  +  browser ext
                            ──── all connected ────
```

The pitch in one breath: it joins your **web AIs** (ChatGPT.com, Claude.ai — driven via Chrome DevTools Protocol) with your **local CLIs** (Claude Code, Codex — driven as subprocesses), inside a single Markdown-backed conversation, accessible from terminal today and from Telegram + browser extension soon. Like a desktop bridge for multiple AIs, but **account-driven, not API-driven**.

> **Just want to use it?** See **[MANUAL.md](./MANUAL.md)** — cheat sheet up top, descriptive sections below.

## Why this exists

The model card says "GPT-5" or "Claude Sonnet" — but the *envelope* around the model on chatgpt.com or claude.ai is dramatically more capable than the same model called over the API. The envelope is what you're really paying for:

- A long, carefully tuned system prompt — personality, formatting rules, when to ask clarifying questions, when to switch to thinking mode
- First-class tools used by reflex — Code Interpreter (Python sandbox), web browsing, image gen, file analysis, Connectors
- Cross-conversation memory, custom instructions, projects, and quiet retrieval over your past threads
- Variable reasoning effort, auto-routed by the front-end (or forceable into "Thinking" mode)
- Rendered output — KaTeX math, syntax-highlighted code, tables, citations

The API strips most of that away and gives you a barer model. That's why GPT-5 or Claude Sonnet over the API often feels duller than the same model in their respective web apps.

**The original motivator behind egpt (across multiple rewrites): automate the web UI from a shell.** Use the rich envelope you're already paying for via your ChatGPT Plus / Claude Pro subscription, drive its tabs over CDP, get all those features for free in any script.

Then bring in **CLI agents** (Claude Code, Codex) for what web envelopes can't do — actually edit your files, run your tests, commit, ssh into a server. CLI envelopes feel less articulate but actually touch the world. The two complement each other directly:

- **Web brain** — more articulate, more memory, more tools, no fingers
- **CLI brain** — fewer features, less polished, but real hands on real files

`egpt` joins both kinds of envelopes in one conversation log, addressable as named participants:

```
@chatgpt explain the refactor strategy
@ccode apply it to these files
@codex run the test suite and report
@claude give a second opinion on the result
```

Same model families you'd reach for over the API, but speaking through their richer native envelopes. With multiple of them addressable in one room, the possibilities open up surreally fast.

## What this unlocks (a.k.a. why this is an AI manager, not just a chat tool)

Once the conversation is a plain Markdown file you own — and the brains are interchangeable bridges over it — a class of things that's awkward or impossible elsewhere becomes natural:

- **Cross-brain context teleportation.** Switch from `chatgpt-cdp` to `claude-cdp` mid-thread; the new brain joins the room with the full transcript as context (planned: `/invite ... --with-history` injects the log on first turn). It's the *"invite = replay scrollback"* pattern that's already implicit in the architecture.

- **No vendor lock-in.** ChatGPT, Claude, Codex all keep your conversations trapped in their UI. egpt inverts it: the file is the primary artifact, the UI is a renderer over it. If a provider raises prices, deprecates a feature, or just frustrates you that day, you carry your conversations to whichever brain still serves you. No migration project, no lost continuity.

- **Conversation revival.** Months later, open `~/conversations/refactor-2026-q2.md` in egpt and resume — with any brain. The brain doesn't even need to be the original one. New brain, fresh perspective, full prior context.

- **Side-by-side comparisons.** Replay the same prompt set across multiple brains in different files. Compare how Claude vs GPT-5 vs Codex approach an identical problem with identical context. Real evaluations, not anecdotes.

- **The conversation as a document.** It's a Markdown file. `vim` it, paste it into Notion, share it as a gist, version it with git, search across years with `rg`. Your AI thinking becomes searchable like any other text you've ever written.

- **Hand-edit the past.** If a brain produced something off, delete those lines. If you typo'd, fix it before resuming. The conversation isn't sacred history — it's a working document.

The brains are tools. The conversation log is the work. egpt makes the work primary, and that's the difference between *using* AIs and *managing* them.

## Three asymmetries this fixes

| Tool | Strength | Trapped where |
|---|---|---|
| ChatGPT.com / Claude.ai | rich rendering, memory, paid features, polished envelope | inside the browser |
| Claude Code / Codex CLI | shell + filesystem access, real agent loops | on the laptop in front of you |
| Anthropic / OpenAI API | scriptable, automatable | per-token billing, dropped envelope |

`egpt` is the small daemon that gives one canonical conversation a way to talk to all three.

## Practical trade-off

You keep a Chrome instance logged in to the web brains. You launch it once with `launch-brain.sh` and its profile persists at `~/.egpt/brain-profile`. The daemon talks to its tabs over CDP. No API keys to manage, no token bills to watch.

## Brain profiles

Reusable participants can be described as YAML profiles. `/attach alex` looks for `alex.yaml` in `./.egpt/brains/`, `~/.egpt/brains/`, or the repo's `brains/type/` / `brains/types/` directories.

```yaml
name: alex
type: codex                 # codex | code | cdp_chat | cdp_claude
model: gpt-5.5
effort: low
cwd: C:\Users\an\src\egpt
summary: alex               # injects ~/.egpt/summaries/alex.md on attach
chat_name: Alex
```

Profile runtime state is stored separately in `~/.egpt/brain-state/<profile>.json`. That file records details like the last cwd, Codex thread id, CDP target id, model/effort, and log path while keeping the YAML declarative.

For a ChatGPT conversation that is already configured in the web UI, create the
minimal profile directly:

```text
/profile alex https://chatgpt.com/c/69f68099-5cf8-8328-ad8f-37d991ff0071
/profile 69f68099-5cf8-8328-ad8f-37d991ff0071 alex --attach
```

The same writer is available from the shell as
`node egpt.mjs profile alex <urlOrId>`.

Bare UUIDs become `https://chatgpt.com/c/<id>`. Use `--project`, `--repo`,
`--force`, or `--attach` when needed.

## What works today

- ✅ A terminal chat shell (Ink + plain Node, no build step) — multi-line input, ↑/↓ history recall, slash commands, streaming reply display
- ✅ A **Telegram bridge** (`bridges/telegram.mjs`) — long-poll a Telegram bot, route incoming messages into the same room, mirror brain replies back to the chat. Works with or without any AI present (zombie mode runs slash commands over Telegram)
- ✅ Plain Markdown file as conversation source-of-truth (`tail -f`-friendly, vim-editable, grep-able)
- ✅ Four working brains/operators:
  - `ccode` — local subprocess of `claude` CLI; full conversation history sent each turn; streaming via `stream-json` (`claude-code` is accepted as a legacy alias)
  - `codex` — local Codex CLI plus `exec:` operator commands with a persistent cwd
  - `chatgpt-cdp` — drives ChatGPT.com in a CDP-exposed Chrome; tab keeps its own history
  - `claude-cdp` — drives Claude.ai the same way
- ✅ Multi-participant model: register as many sessions as you want (`/open chatgpt-cdp gpt1`, `/open claude-cdp claude1`); each shows up as a distinct author in the log
- ✅ YAML brain profiles: `/profiles` lists configured presets and `/attach <profile>` starts one with model/effort/cwd plus optional summary injection
- ✅ Auto-recovery: when a tab dies, the daemon silently rebinds to a single matching open tab
- ✅ Browser lifecycle: `launch-brain.sh start | stop | status | restart`, persistent profile dir at `~/.egpt/brain-profile`, Ctrl+C in the launching terminal closes the brain cleanly via CDP `Browser.close`
- ✅ `/refresh` — re-poll the current CDP tab and append the full assistant message (recovery from premature streaming-end detection)
- ✅ `/last [N]` — replay the last N messages from the conversation file
- ✅ **Terminal themes** — 10 built-in color themes (`/themes` to list, `/theme <name>` or `/theme next|prev` to switch live)
- ✅ **Per-project config** — `.egpt/config.json` in the working directory overrides `~/.egpt/config.json`; `/config key value` reads/writes it live

## What's coming

- 🛠 **Browser extension** — egpt is plain ES modules (JS all the way down); the extension port runs the same CDP brains and Telegram bridge inside Chrome itself, with a tab-based UI replacing the Ink terminal. `ccode`/`codex` are the only true shell dependencies; everything else is browser-native.
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
node egpt.mjs --help                         # CLI usage
node egpt.mjs profile alex 69f68099-5cf8-8328-ad8f-37d991ff0071
                                             # create ~/.egpt/brains/alex.yaml

# inside egpt
/help                                        # all commands
/profiles                                    # list configured YAML brain profiles
/profile alex https://chatgpt.com/c/69f68099-5cf8-8328-ad8f-37d991ff0071
                                             # create a minimal ChatGPT URL profile
/attach alex                                 # start profile "alex" if configured
/open ccode ccode1                           # local Claude Code subprocess
/open codex                                  # local Codex session (auto-name: codex1)
@codex exec: pwd                             # run a shell command in codex's cwd
@codex exec: cd ../siran/writing             # change codex's persistent cwd
/open chatgpt-cdp                            # opens/registers a ChatGPT tab
/open claude-cdp claude1                     # opens a fresh claude.ai tab, named claude1
/send-file via=codex1 @cgpt1 "find the TPOEF book and send everything before chapter 8"
                                             # codex finds/prepares it, egpt sends it
/send-file via=codex1 "C:\Users\an\src\siran\writing\site\books\The Physics of Energy Flow\The Physics of Energy Flow.md" @cgpt1 "before chapter 8"
                                             # codex prepares the excerpt, egpt sends it
/paste-file alex "C:\Users\an\src\siran\writing\site\books\The Physics of Energy Flow\The Physics of Energy Flow.md" --before "# 8."
                                             # deterministic marker paste
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
/open <brain> [name]            open/register a new session
/profiles                       list YAML brain profiles
/profile <name> <urlOrId>       create a ChatGPT/Claude URL profile
/attach <profile>               start a configured brain profile
/attach                         re-scan Chrome and attach matching tabs
/attach <brain>                 attach CDP tabs or create a local session
/attach <brain> <name> [tab]    explicit attach; tabSpec: targetId | url | uuid | prefix
/sessions                       list registered sessions
/tabs [all]                     list pages in the brain Chrome (chrome:// hidden)
/brain [status|stop]            brain Chrome lifecycle (CDP-based)
/refresh                        re-poll current CDP tab; append full text
                                (use when streaming was cut off)
/send-file [via=<op>] [<path>] @<session> ["<instruction>"]
                                prepare excerpt, or send prepared file
/paste-file <session> <path>     paste a local file/excerpt into one session
                                (--before/--after markers, --ask prompt)
/last [N]                       show last N messages from the file (default 10)
@codex exec: <command>          run shell command in codex cwd
@codex exec: cd <dir>           change codex cwd for later commands
```

`/send-file` uses a local operator (`codex`/`ccode`) to prepare an excerpt, then
egpt sends that prepared file to the target session. The target `@session` must
already be registered. If the prepared file is too large for the default guard,
egpt saves it and tells you exactly which prepared path to send next.

```text
/send-file via=codex1 @cgpt1 "find the TPOEF book and send everything before chapter 8"
/send-file via=codex1 "C:\Users\an\src\siran\writing\site\books\The Physics of Energy Flow\The Physics of Energy Flow.md" @cgpt1 "before chapter 8"
/send-file "C:\Users\an\.egpt\prepared-files\2026-05-03T01-03-30-619Z-codex1-null" @cgpt1
```

Paths under `~/.egpt/prepared-files/` are treated as already prepared and are
sent directly; they do not go back through the operator.

`/paste-file` is the deterministic version when you already know the exact
marker:

```text
/paste-file alex "C:\Users\an\src\siran\writing\site\books\The Physics of Energy Flow\The Physics of Energy Flow.md" --before "# 8."
```

Use `--ask "..."` to append a question after the pasted content. Without
`--ask`, egpt sends only the file content; it does not prepend response
instructions.

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
│ shell │  │ccode       │         │ fs     │
│  ✅   │  │  ✅        │         │  ✅    │
│telegram│ │chatgpt-cdp │         │chrome- │
│  ✅   │  │  ✅        │         │ storage│
│ext    │  │claude-cdp  │         │  🛠    │
│  🛠   │  │  ✅        │         │        │
│       │  │codex ✅    │         │        │
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
│   ├── codex.mjs          # subprocess `codex exec` + direct `exec:` shell operator
│   ├── chatgpt-cdp.mjs    # ChatGPT.com selectors + inject + poll
│   └── claude-cdp.mjs     # Claude.ai selectors + inject + poll
├── bridges/
│   └── telegram.mjs       # Telegram long-poll bridge (bot_token from config)
├── tools/
│   ├── template.mjs       # command prompt template loader (commands/*.md)
│   └── theme.mjs          # terminal color theme loader (themes/*.json)
├── commands/              # operator prompt templates with {{variable}} substitution
│   ├── browse.md          # CDP browser-automation task prompt
│   ├── codex-task.md      # codex operator task passthrough
│   └── ...
├── themes/                # terminal color themes (10 shipped; override in ~/.egpt/themes/)
│   ├── catppuccin.json    # default
│   ├── dracula.json
│   └── ...
├── launch-brain.sh        # platform-aware Chrome launcher (Linux/macOS/MSYS2/Windows)
├── package.json           # type:module · ink + react
├── README.md
└── MANUAL.md
```

Optional repo-defined brain profiles live under `brains/type/*.yaml` or `brains/types/*.yaml`; personal profiles normally live in `~/.egpt/brains/*.yaml`.

## How the brains work

### Subprocess brain (`ccode`)

Each turn: spawn `claude --print --output-format stream-json --include-partial-messages`, pipe the full conversation history to stdin, parse newline-delimited JSON for token deltas, accumulate, return final text on `result` event.

### Codex brain/operator (`codex`)

Address `@codex ...` to use the local Codex integration. `@codex exec: <command>` runs the command directly in a shell and returns output as `$ <command>` followed by stdout/stderr. `@codex exec: cd <dir>` updates that Codex session's cwd, so the next `exec:` runs there.

Non-`exec:` messages are sent to `codex exec` non-interactively and later turns resume the Codex thread. egpt forces `model_reasoning_effort="low"` by default for these Codex turns; override with `EGPT_CODEX_REASONING_EFFORT=medium|high|xhigh` if needed. To give Codex room context, use `/summarize <name>` and then `/inject <name> codex`.

There are three storage layers: the room stays in `conversation.md`, egpt mirrors Codex events to `~/.egpt/codex/<session>.jsonl` for `tail -f`, and Codex stores its native rollout under `~/.codex/sessions/.../rollout-<timestamp>-<thread-id>.jsonl`. `/sessions` shows the Codex thread id, current cwd, effort, and egpt mirror log path after the first Codex turn.

### CDP brains (`chatgpt-cdp`, `claude-cdp`)

Each turn:
1. Connect to Chrome's HTTP debug endpoint, find the bound tab by `targetId`
2. Open a WebSocket to that tab's `webSocketDebuggerUrl`
3. `Runtime.evaluate` an inject script: dispatch a paste event into the page's prompt-textarea (or contenteditable), fall back to one whole-value set if needed, then click submit
4. Poll the DOM at 250ms ticks via `Runtime.evaluate`, watching for the latest assistant message
5. Resolve when the stop-button is gone *and* text is stable — both for ≥4 consecutive ticks (~1s of agreement). Locale-aware (Spanish, French, German, etc.) so it doesn't false-finalize when the UI isn't English.

### Why polling and not streaming events?

Both web UIs render via React; they don't expose the SSE token stream cleanly to extensions or CDP scripts. Polling the rendered DOM is brittle but universal. The 1-second stability window is a deliberate tradeoff against false "done" signals during LaTeX/code rendering pauses.

## Caveats and known limits

- **Selectors break.** When ChatGPT or Claude redesigns their UI, the inject/poll scripts in `brains/*-cdp.mjs` will need tweaking. They're written defensively (multiple fallback selectors), but not future-proof.
- **One language detected, others guessed.** Stop-button labels are matched in English, Spanish, French, German, Swedish, Portuguese. Other locales may need adding.
- **Tab-as-context.** A CDP brain remembers conversation history *in its tab*. If you switch from `ccode` to `chatgpt-cdp` mid-conversation, ChatGPT only knows what it had in its own tab — not the egpt log. Solved cleanly by the planned multi-participant model where each session has full context.
- **Markdown file as truth.** Slash commands aren't logged. Your messages and brain replies are.

## License

Personal project. Not redistributing for now.

## Origin

Successor to [`siran/egptjs`](https://github.com/siran/egptjs) — a Chrome MV3 extension that bridged Telegram → ChatGPT via CDP. The original idea (CDP + chat-id-to-tab mapping + multi-Telegram-user with attribution prefixes) was sound; the MV3 service worker was the wrong runtime for an orchestrator. egpt rewrites it as a Node daemon, with the extension demoted to a future display surface.
