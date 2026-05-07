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

You keep a Chrome instance logged in to the web brains. The daemon (shell or extension) talks to its tabs over CDP. No API keys to manage, no token bills to watch.

**Chrome setup (one time):** type `/chrome` inside egpt and the shell launches Chrome with the right flags (`--remote-debugging-port=9221`, `--user-data-dir=~/.egpt/chrome/profiles/brain`, `--load-extension=extension/dist`). First time, log into ChatGPT, Claude, and your Google account (for bookmark sync) in that Chrome window — the profile persists at `~/.egpt/chrome/profiles/brain` so you only do it once. Chrome is spawned **detached** — survives shell restarts; close it manually when done.

The shell never spawns Chrome on startup; it only attaches if Chrome is already running. So if you'd rather start Chrome yourself (e.g. via a desktop shortcut), point it at the same flags and the shell will detect and attach:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9221 --user-data-dir="%USERPROFILE%\.egpt\chrome\profiles\brain" --load-extension="%USERPROFILE%\src\egpt\extension\dist" --no-first-run --new-window
```

Linux/macOS: `google-chrome --remote-debugging-port=9221 --user-data-dir=~/.egpt/chrome/profiles/brain --load-extension=~/src/egpt/extension/dist`

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
- ✅ A **Telegram bridge** (`bridges/telegram.mjs`) — Bot API long polling. One bot token per node is the recommended setup, so each off-LAN node has independent access; LAN coordination uses the CDP bus, not Telegram. Incoming messages route into the same room; brain replies stream back to the chat.
- ✅ A **WhatsApp bridge** (`bridges/whatsapp.mjs`) — personal-account login via `@whiskeysockets/baileys`. First run: `/whatsapp pair` shows a QR; scan from your phone (Settings → Linked devices); auth persists at `~/.egpt/wa-auth/`. Same room model as Telegram: inbound becomes `room-utterance` with `via:'whatsapp[<jid>]'`; brain replies route back to the originating chat. Per-chat-type awareness: `awareness: { self_chat: 'both', personal: 'incoming', groups: 'mentions' }` in config controls whether the bridge processes self-DMs, personal DMs, and group messages. Enable with `"whatsapp": { "enabled": true, "allowed_users": ["<your-number>"] }` in `~/.egpt/config.json`. Personal-account use of the WhatsApp Web protocol is a ToS gray area — fine for personal volume, ban-prone if abused.
- ✅ **`@egpt` persona** — a node-global default brain (defaults to `claude-code`, configurable to `codex`) with its own persistent conversation thread. `@egpt <question>` from anywhere — shell, Telegram DM, WhatsApp DM, group with the bot addressed — runs the same persistent thread. `/help @<who>` and `/rules @<who>` prepend the recipient's name so the message is delivered to them in the chat.
- ✅ Plain Markdown file as conversation source-of-truth (`tail -f`-friendly, vim-editable, grep-able)
- ✅ Four working brains/operators:
  - `ccode` — local subprocess of `claude` CLI; full conversation history sent each turn; streaming via `stream-json` (`claude-code` is accepted as a legacy alias)
  - `codex` — local Codex CLI plus `exec:` operator commands with a persistent cwd
  - `chatgpt-cdp` — drives ChatGPT.com in a CDP-exposed Chrome; tab keeps its own history
  - `claude-cdp` — drives Claude.ai the same way
- ✅ Multi-participant model: register as many sessions as you want (`/open chatgpt-cdp gpt1`, `/open claude-cdp claude1`); each shows up as a distinct author in the log
- ✅ YAML brain profiles: `/profiles` lists configured presets and `/attach <profile>` starts one with model/effort/cwd plus optional summary injection
- ✅ Auto-recovery: when a tab dies, the daemon silently rebinds to a single matching open tab
- ✅ Browser lifecycle: `/chrome` launches the brain Chrome with the extension loaded; shell polls every 5s for Chrome to attach to (whether you started it via `/chrome`, a desktop shortcut, or it came back from a crash). Chrome is detached and survives shell restarts. Persistent profile at `~/.egpt/chrome/profiles/brain`.
- ✅ **Token-authenticated CDP proxy** (`tools/cdp-proxy.mjs`) — Chrome listens on 9221 (localhost-only); proxy on 9222 requires a secret token in the URL path so LAN access is safe without `--remote-allow-origins`
- ✅ **Browser extension** (`extension/`) — same brains and Telegram bridge running inside Chrome; uses `chrome.debugger` API instead of external ports; `/open chatgpt-cdp` opens and attaches a ChatGPT tab in the same Chrome window
- ✅ `/refresh` — re-poll the current CDP tab and append the full assistant message (recovery from premature streaming-end detection)
- ✅ `/last [N]` — replay the last N messages from the conversation file
- ✅ **Terminal themes** — 10 built-in color themes (`/themes` to list, `/theme <name>` or `/theme next|prev` to switch live)
- ✅ **Per-project config** — `.egpt/config.json` in the working directory overrides `~/.egpt/config.json`; `/config key value` reads/writes it live

## What's coming

- 🛠 **`/agents`** — broadcast a discovery query to the room; each live node replies with its session list; the result is a real-time map of every brain available across all connected machines and people.
- 🛠 **Shell ↔ extension CDP bridge** — shell reaches into extension Chrome's tabs via the proxy; `@cgpt1` in the shell routes to the same tab the extension opened.
- 🛠 **Passive recording** — every node records the full Telegram stream to its local conversation copy, even for turns handled by another node. Currently nodes only write turns they route themselves.
- 🛠 **Admin / queue / flush** — controls when a queue of messages gets flushed to brains; useful in shared rooms to prevent noise polluting brain context.

## Quick start

```bash
# install (one time)
cd ~/src/egpt
npm install
npm run build:ext                            # build the browser extension

# ── shell (Ink terminal UI) ──────────────────────────────────────────────────
# Just run egpt — it starts polling for a brain Chrome on :9221 / :9222.
# Type /chrome inside to launch one with the extension loaded, then log
# into chatgpt.com / claude.ai once (profile persists at ~/.egpt/chrome/profiles/brain).
# Or start Chrome yourself first, with --remote-debugging-port=9221, and
# the shell attaches when it sees it.

node egpt.mjs                                # uses ./conversation.md
node egpt.mjs ~/conversations/foo.md         # explicit path
node egpt.mjs --help                         # CLI usage
node egpt.mjs profile alex 69f68099-5cf8-8328-ad8f-37d991ff0071
                                             # create ~/.egpt/brains/alex.yaml

# inside egpt
/help                                        # all commands

# ── extension-only (no shell needed) ────────────────────────────────────────
# Click the egpt icon in the Chrome the shell launched (or in any Chrome
# you started with --load-extension=extension/dist):
#   /open chatgpt-cdp         ← opens + attaches a ChatGPT tab
#   /open claude-cdp          ← same for Claude
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
/exit · /file · /help · /status · /last [N] · /rules

Conversation files:
/conversations                  list available conversation files
/conversation <name|path>       switch the room to a different conversation file

Sessions:
/open <brain> [name]            open a new tab/subprocess and register a session
/attach                         re-scan Chrome and attach matching tabs
/attach <profile> [name]        start a configured YAML brain profile
/attach <brain> [name] [tab]    attach CDP tabs or create a local session
                                (tabSpec: targetId | url | uuid | prefix)
/detach <name>                  remove a session from the room
/sessions                       list registered sessions
/handle · /emoji · /bio         rename / set avatar / set bio
/profiles · /profile · /create-profile   YAML brain profiles

Browser brains (CDP):
/tabs [all]                     list pages in the brain Chrome (chrome:// hidden)
/refresh [@name]                re-poll a CDP tab; append full text
                                (use when streaming was cut off)
/browse [via=<op>] [url] [@<n>] ["instr"]
                                drive Chrome via CDP, or delegate to operator
/continue                       resume after a browser.waitForHuman() pause
/mirror [@src] [@tgt]           forward a message between sessions

Files:
/send-file [via=<op>] [<path>] @<session> ["<instruction>"]
                                prepare excerpt, or send prepared file
/paste-file <session> <path>     paste a local file/excerpt into one session
                                (--before/--after markers, --ask prompt)

Operators / ccode resume:
/history [N] · /session [name] [<id>|none] [cwd]
@codex exec: <command>          run shell command in codex cwd
@codex exec: cd <dir>           change codex cwd for later commands

Reusable distillations:
/save · /summarize · /summaries · /inject · /prompts

Appearance & config:
/themes · /theme <name|next|prev> · /config [key [value]]

Brain Chrome lifecycle is /chrome (launch with the extension loaded) and
nothing else: the shell polls every 5s for Chrome on :9221 and attaches
when it sees one. Close the Chrome window manually when you're done.
Tabs survive shell restarts.
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

## The distributed room

The single-machine setup (one shell, one Chrome) is just the starting point. The deeper design is a **distributed room**: any number of egpt nodes — shells on different machines, the browser extension, phones via Telegram — sharing one conversation through two channels:

- **CDP bus** — for LAN coordination. A tab in the brain Chrome (`tools/bus.html`) that every local egpt node attaches to. It carries short control events: node presence, cross-node mention forwarding, Telegram polling handoff. Long content (full brain replies, file pastes) does not travel here — it stays in `conversation.md` and Telegram.
- **Telegram bot** — for off-LAN bridges only. Recommended: one bot token per off-LAN node, so each one has independent access and there is no contention for the polling slot. LAN nodes don't need Telegram at all.

Each node:
1. Joins the bus on startup and announces its sessions
2. Sees peer nodes as **zombie sessions** in `/sessions` — addressable handles owned by another node
3. When `@<name>` matches a zombie session, the local node posts a mention event on the bus; the owning node picks it up, runs the turn, and posts the reply back

```
machine A  egpt-shell   [codex1, ccode1]  ─┐
machine B  egpt-shell   [codex2]            ├──  CDP bus (LAN)
browser    egpt-ext     [cgpt1, claude1]  ─┘            │
                                                         │
phone      Telegram app (human)  ── Telegram bot ────────┘  (off-LAN)
```

`@codex2 look at ~/src/project` — typed from the browser extension, routed through the CDP bus to machine B, answered by codex2, reply delivered back over the bus. No VPN. No SSH. No server.

**Brain ownership**: each node is authoritative only for the sessions it has attached. The bus's `node-online` event includes each node's session list, so peers know which `@<name>` to forward where. `/agents` (coming) is a live re-discovery on demand.

**Telegram polling**: a single bot token can only be long-polled by one client at a time. Within egpt, polling is owned by exactly one node at a time — no competition. `/telegram` (no arg) reports who currently owns it. `/telegram <node>` transfers polling to another node over the bus. With the recommended one-token-per-node setup, none of this matters because each node polls its own bot.

**Multi-human rooms**: multiple people, each running their own egpt node, each contributing their own brains. The `allowed_users` list in `~/.egpt/config.json` is the only access control. When one person's daily limit on a free-tier account is hit, another person's isn't — natural failover across accounts, machines, and providers.

**Works on any tier — free or paid**: egpt drives the web UI, not the API, so you get whatever the account gets. A free chatgpt.com account works (with daily limits and the free model envelope). A paid subscription works *better* (more capable models, higher limits, longer context, premium features like deep research) — and you still pay zero on top of the subscription you already have. No API billing, no shared credentials, no infrastructure beyond a Telegram bot token per off-LAN node. A group can pool subscriptions or free-tier accounts across ChatGPT, Claude, and Codex for natural failover when one person hits a limit.

## Layout

```
egpt/
├── egpt.mjs               # main app: Ink UI + slash commands + session state
├── interpreter.mjs        # shared input parser + command registry (shell + extension)
├── brains/
│   ├── chatgpt-cdp.mjs    # ChatGPT.com selectors + inject + poll
│   ├── claude-cdp.mjs     # Claude.ai selectors + inject + poll
│   ├── claude-code.mjs    # subprocess `claude --print --output-format stream-json`
│   ├── codex.mjs          # subprocess `codex exec` + direct `exec:` shell operator
│   └── type/              # repo-defined YAML brain profiles + skeleton
├── bridges/
│   └── telegram.mjs       # Telegram Bot API bridge; competitive polling, handoff protocol
├── tools/
│   ├── cdp.mjs            # CDP plumbing for shell: listTabs, streamFromTab, etc.
│   ├── cdp-proxy.mjs      # token-auth reverse proxy (Chrome:9221 → LAN:9222)
│   ├── chrome-launcher.mjs# locate + spawn Chrome (one Chrome hosts brain tabs, extension, and bus)
│   ├── bus.mjs            # control-plane bus client (find/post/subscribe to bus.html)
│   ├── bus.html           # in-page bus board (visible CDP-driven event log)
│   ├── browser-tools.mjs  # CDP control library for operator scripts
│   ├── template.mjs       # command prompt template loader
│   └── theme.mjs          # terminal color theme loader
├── extension/             # Chrome MV3 extension (same brains, no external ports)
│   ├── manifest.json
│   ├── build.mjs          # esbuild; shims tools/cdp.mjs → chrome.debugger adapter
│   └── src/
│       ├── tab/           # main UI (App.jsx, Input.jsx, style.css, index.html)
│       ├── settings/      # settings page (bot token, allowed users, mirror mode)
│       ├── tools/cdp-ext.js  # chrome.debugger adapter (drop-in for tools/cdp.mjs)
│       ├── storage.js     # IndexedDB conversation history
│       └── background.js  # service worker (opens the tab)
├── commands/              # operator prompt templates with {{variable}} substitution
├── themes/                # terminal color themes (10 shipped)
├── package.json
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

## Tests

Vitest. Tests live in `tests/`.

```bash
npm test                # one-shot
npm run test:watch      # re-run on save
npx vitest run --coverage   # whole-project coverage report (HTML in coverage/)
```

Current coverage (whole project, `vitest.config.mjs` includes every source file even when not imported by a test):

| Area                     | Lines | Notes |
|--------------------------|-------|-------|
| `interpreter.mjs`        | 100%  | parseInput, command-set integrity, helpText / helpHtml |
| `room.mjs`               | 100%  | resolveRoute decision tree, planMirrors |
| Everything else          | 0%    | egpt.mjs, App.jsx, brains, bridges, tools — untested |
| **Project total**        | **~2%** | Routing nucleus extracted; brain mocks + bus tests next |

`tests/interpreter.test.mjs` (22 tests) covers input classification, command-registry integrity, and help-renderer structure. `tests/room.test.mjs` (24 tests) covers the routing decision tree: command dispatch, direct local @-mention, brain-alias auto-open vs CDP "open one first", peer routing (single match, ambiguous, local-wins-over-peer), broadcast vs single-recipient, empty-room, and one-hop CDP-to-CDP mirror planning. `tests/integrity.test.mjs` (54 tests) cross-checks the COMMANDS registry against actual dispatch sites in both surfaces, and ensures every `EGPT_CONFIG.<key>` reference is registered in `CONFIG_SCHEMA`.

Both surfaces — `egpt.mjs`'s submit handler and the extension's `App.jsx` — import `room.mjs`, so the routing decisions are tested through the same pure functions the production code uses on either surface. The brain calls, .md writes, bus posts, and React state updates remain in the surface files as the side-effecting layer; only the *decision* lives in `room.mjs`. The shell and extension cannot drift on routing without breaking the shared tests.

For the surface behaviors that don't fit unit tests — Chrome spawn, bridge integration, multi-surface coordination, transcript rendering — there's a step-by-step manual checklist at [`TESTING.md`](TESTING.md). Run through the relevant section after any non-trivial change.

## Protocol

The wire format that nodes use to coordinate is documented in [`LEDGER_PROTOCOL.md`](LEDGER_PROTOCOL.md). Lineage: small envelope and bridge attribution borrowed from Matrix; channel/presence pattern from IRC; AI-participants-as-room-members is the egpt-shaped piece. Read that doc to build a second implementation (different language, different surface).

## Run on boot (egpt-daemon)

`egpt-daemon.mjs` keeps `node egpt.mjs` running across crashes and self-upgrades. Run it instead of `node egpt.mjs` directly:

```
node egpt-daemon.mjs
```

It spawns the shell as a child, restarts on crash with exponential backoff (2s → 60s cap), and recognizes four special exit codes:

- **0** — clean exit (you typed `/exit`, or Ctrl+C the shell). egpt-daemon stops too — that's what you wanted.
- **42** — `/upgrade`. egpt-daemon runs `git pull --ff-only && npm install && npm run build:ext`, then restarts the shell.
- **43** — `/restart`. egpt-daemon respawns the shell from current disk state. Picks up any code changes already pulled externally (so it's an implicit upgrade if you `git pull`-ed by hand) but does no install/build itself.
- **44** — `/rewind <ref>`. The shell writes `~/.egpt/rewind-target.txt` with the target ref (commit SHA, tag, branch, `HEAD~N`); egpt-daemon runs `git checkout <ref> && npm install && npm run build:ext`, then restarts. Use it to drop back to a known-good tag (`/rewind unified-room`) when an upgrade brings in a regression.

To stop everything, Ctrl+C the daemon (or `SIGTERM` it).

### Start at boot

**Windows** (Task Scheduler — runs at logon):

```
schtasks /Create /TN "egpt-daemon" ^
  /TR "node \"%USERPROFILE%\src\egpt\egpt-daemon.mjs\"" ^
  /SC ONLOGON /RL HIGHEST /F
```

Then `schtasks /Run /TN "egpt-daemon"` to start it once without rebooting. `/Delete /TN "egpt-daemon"` to remove.

**macOS** (launchd, user agent — `~/Library/LaunchAgents/egpt.daemon.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>egpt.daemon</string>
  <key>ProgramArguments</key>
    <array><string>/usr/local/bin/node</string><string>/Users/you/src/egpt/egpt-daemon.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

`launchctl load ~/Library/LaunchAgents/egpt.daemon.plist` to enable.

**Linux** (systemd user unit — `~/.config/systemd/user/egpt-daemon.service`):

```ini
[Unit]
Description=egpt daemon

[Service]
ExecStart=/usr/bin/node /home/you/src/egpt/egpt-daemon.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

`systemctl --user enable --now egpt-daemon` to start at login.

## Caveats and known limits

- **Selectors break.** When ChatGPT or Claude redesigns their UI, the inject/poll scripts in `brains/*-cdp.mjs` will need tweaking. They're written defensively (multiple fallback selectors), but not future-proof.
- **One language detected, others guessed.** Stop-button labels are matched in English, Spanish, French, German, Swedish, Portuguese. Other locales may need adding.
- **Tab-as-context.** A CDP brain remembers conversation history *in its tab*. If you switch from `ccode` to `chatgpt-cdp` mid-conversation, ChatGPT only knows what it had in its own tab — not the egpt log. Solved cleanly by the planned multi-participant model where each session has full context.
- **Markdown file as truth.** Slash commands aren't logged. Your messages and brain replies are.

## License

Personal project. Not redistributing for now.

## Origin

Successor to [`siran/egptjs`](https://github.com/siran/egptjs) — a Chrome MV3 extension that bridged Telegram → ChatGPT via CDP. The original idea (CDP + chat-id-to-tab mapping + multi-Telegram-user with attribution prefixes) was sound; the MV3 service worker was the wrong runtime for an orchestrator. egpt rewrites it as a Node daemon, with the extension demoted to a future display surface.
