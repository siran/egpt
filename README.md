# eGPT

eGPT is a tool that joins multiple AI(s) and human(s) in a chat-like room, shell-script, WhatsApp, Telegram, and browser extension (Chrome, Firefox).

> **Anything that asks the operator to run a server has already lost.** Simplicity of operation — eGPT works, as an extension, wherever a browser works; or as a daemon-script where there's an OS to run it.

For example

```text
🦅 An@kg (10:30 EDT)
@cgpt1 @claude1 one sentence each on retrocomputing
🦊 cgpt1@kg (10:30 EDT)
Keeping old systems alive for what they reveal about computing's roots.
🧠 claude1@kg (10:30 EDT)
A scholarly + hobbyist thread that holds onto hardware the mainstream moved past.
```

eGPT is an "AI helper". It allows seamless interaction of

```text
        ┌──────────────────────────┐
        │  ChatGPT Web │ Claude    │   ← web "brains" (your existing login)
        │     Web      │           │
        └────┬──────────────┬──────┘
             │              │
             ▼              ▼
    ┌──────────────────────────────────┐
    │             eGPT                 │   ← orchestrator + shared room
    └────┬────────────┬────────────┬───┘
         │            │            │
         ▼            ▼            ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │  Codex   │  │  Claude  │  │  Shell / │   ← local CLIs + you
   │   CLI    │  │   Code   │  │   you    │
   └──────────┘  └──────────┘  └──────────┘
         │            │            │
         └────────────┼────────────┘
                      ▼
              ┌──────────────┐
              │  WhatsApp /  │   ← cross-surface mirroring,
              │  Telegram    │     same room everywhere
              └──────────────┘
```

For example:

```text
[An via WhatsApp]  @e qué hora es en Tokyo ahora?
🐶 egpt@kg          Son las 22:14 en Tokyo — 13h por delante de EDT.
[shell, same room] @e qué hora es en Tokyo ahora?     ← same turn, mirrored
                    Son las 22:14 en Tokyo — 13h por delante de EDT.
```

eGPT lets you use WhatsApp, or your shell, to access the files in your computer through codex, prompt a "brain", receive the response, mirror it to chats, save it to files, etc...

For example:

```text
🦅 An@kg (11:02 EDT) [m1]
@cx exec: ls -lh ~/Downloads/*.pdf
🐻 cx@kg (11:02 EDT) [m2]
-rw-r--r-- 1 an 2.3M May 10  paper-michelson-morley.pdf
-rw-r--r-- 1 an 540K May 12  invoice-april.pdf
🦅 An@kg (11:03 EDT) [m3]
/mirror @wa6 m2 --tagged
egpt@kg
→ /mirror @wa6: [cx@kg 2026-05-13 11:02 EDT] -rw-r--r-- 1 an 2.3M  paper-michelson-morley.pdf …
```

eGPT lets you prompt ChatGPT Web and Claude AI web from a custom, local chat interface.

For example:

```text
🦅 An@kg (14:20 EDT)
@cgpt1 explain quaternions in 3 lines
🦊 cgpt1@kg (14:20 EDT)
Quaternions are 4-component numbers (1 real + 3 imaginary) used to represent rotations in 3D…
🦅 An@kg (14:21 EDT)
@claude1 same question, but compare to rotation matrices
🧠 claude1@kg (14:21 EDT)
Quaternions encode the same rotations with 4 numbers instead of 9, compose by multiplication…
```


The web sessions use your existing browser login. The core flow does not need
OpenAI or Anthropic API keys.

# Other uses
  - you could bridge Telegram, WhatsApp and an AI
  - could be your agent reminding you of things, doing things. The other day eGPT almost bought a pair of bongos for me.
  - possibilities are endless :)

For full usage, see [MANUAL.md](./MANUAL.md). For manual checks, see
[TESTING.md](./TESTING.md).

## Requirements

- Node 18+
- npm
- Chrome for web brains
- optional `codex` and `claude` CLIs for local brains

## Quick Start

```bash
cd ~/src/egpt
npm install
npm run build:ext
node egpt.mjs
```

Use an explicit room file:

```bash
node egpt.mjs ~/notes/room.md
```

On Windows PowerShell, use `npm.cmd` if script execution blocks `npm`:

```powershell
npm.cmd install
npm.cmd run build:ext
npm.cmd test
```

## Resilient daemon

`egpt-daemon.mjs` is a tiny supervisor that keeps `egpt.mjs` running. It
restarts the shell on crash (with exponential backoff) and handles four
distinguished exit codes the shell uses to ask for self-update:

```text
0   user typed /exit          → daemon stops too
42  /upgrade                  → git pull + npm install + npm run build:ext, restart
43  /restart                  → restart immediately
44  /rewind <ref>              → git checkout <ref> + reinstall + rebuild, restart
```

Run it directly:

```bash
node egpt-daemon.mjs
```

### Always-on, even across reboots

#### Windows (Task Scheduler, ONLOGON)

```powershell
schtasks /Create /TN "egpt-daemon" `
  /TR "node `"$env:USERPROFILE\src\egpt\egpt-daemon.mjs`"" `
  /SC ONLOGON /RL HIGHEST /F
```

This runs the daemon on every Windows logon — i.e. as soon as you sign in,
the bridges come up and stay up across `/restart` / `/upgrade` cycles.

### Headless background mode

To keep eGPT running **across reboots even when nobody is logged in**, add
`--headless` and install the daemon as a persistent supervisor. The
**recommended** path on Windows since beta-19 is the NSSM-wrapped Windows
Service (`install-nssm-service.cmd`), because on Modern Standby hardware
(any laptop without S3 sleep in firmware — most newer Ryzen / Intel
laptops) Task Scheduler timer wakes are aggressively suppressed during
sleep, while a continuously-running service holding a live WebSocket
gets brief execution windows from Connected Standby. Validated 2026-06-05:
voice notes sent during a lid-closed Modern Standby window were received,
transcribed, and dispatched hands-off.

**Windows — NSSM service** (recommended):

Double-click `setup\install-nssm-service.cmd` from Explorer. UAC prompt
→ Yes → installer console opens → enter your Windows password once → the
script installs NSSM via winget if needed, stops the older Task Scheduler
task if present, registers `egpt-daemon` as an auto-start service, and
starts it. To revert: `setup\uninstall-nssm-service.cmd`.

**Windows — legacy Task Scheduler** (still works; useful if you can't
install NSSM):

Open Task Scheduler (`Win+R` → `taskschd.msc`), Right pane → `Import Task...`,
select `setup\egpt-spine.xml`. In the Properties dialog click `Change
User or Group...`, pick your own account, confirm `Run whether user is
logged on or not` is selected, click `OK`, enter your Windows password.

Or command-line (elevated PowerShell):

```powershell
schtasks /Create /XML "setup\egpt-spine.xml" `
  /TN "egpt-spine" `
  /RU "$env:USERNAME" /RP * /F
```

Either form prompts for your Windows password once. It's stored encrypted
in the SAM so the task can authenticate at boot before any logon.

In headless mode:

- WhatsApp / Telegram bridges, the bus, file logging, and media downloads
  all keep running — no terminal needed. Every incoming message lands in
  the conversation `.md`, media saves to `~/.egpt/media/...`, stable IDs
  and reply targets persist as usual.
- Ink output goes to `~/.egpt/headless.log` instead of a terminal.

### Ownership handshake (pidfile swap)

Only one process at a time can hold the WhatsApp pairing (baileys
single-client constraint). eGPT coordinates ownership through
`~/.egpt/egpt.pid`:

1. Headless engine starts on boot, writes its PID.
2. You log in and run `node egpt.mjs` (interactive). On startup it sees
   the pidfile, sends `SIGTERM` to the old PID, polls up to 10 seconds
   for it to release the WA pairing, then takes over.
3. Your shell now owns the bridges. The browser extension and any other
   bus observers see the swap as a brief peer reconnect.
4. When you `/exit`, the daemon supervisor can respawn either mode —
   typically headless again until your next login.

No live attach, no socket, no IPC negotiation — just one PID file and a
signal. Symmetric: a headless process started while an interactive shell
is up will also take over.

### macOS / Linux

> **Untested as of beta-19.** Primary development happens on Windows;
> the macOS launchd and Linux systemd paths below are written from
> Apple/freedesktop docs and the Windows experience, not from running
> production. Expected to work — the bridge code, chat-queue, and
> whisper-server integration are all Node.js + cross-platform tools —
> but report regressions if you hit them.

Single auto-detecting installer:

```bash
./setup/install-service.sh
```

It detects via `uname -s`:

- **macOS** → writes `~/Library/LaunchAgents/com.egpt.daemon.plist`
  with `RunAtLoad=true`, `KeepAlive=true`, `ThrottleInterval=5`, loads
  it via `launchctl load`. Logs to `~/.egpt/service-{stdout,stderr}.log`.
- **Linux (systemd)** → writes `~/.config/systemd/user/egpt-daemon.service`
  with `Restart=always`, `RestartSec=5s`, enables + starts via
  `systemctl --user enable --now`. On a headless / server box, run
  `sudo loginctl enable-linger $USER` once so the service stays up past
  logout — the installer prints this hint if linger isn't already
  enabled.

Reversal: `./setup/uninstall-service.sh`. Doesn't touch `~/.egpt`.

`stay-awake.mjs` is a no-op on non-Windows (it short-circuits on
`process.platform !== 'win32'`); this is intentional because a
continuously-running service doesn't need to fight idle-sleep the way
a Task-Scheduler-woken brief job did.

## Basic Use

```text
/help                         show commands
/chrome                       launch the persistent Chrome profile
/open codex codex1            open a Codex CLI session
/open ccode ccode1            open a Claude Code session
/open chatgpt-cdp cgpt1       open or attach a ChatGPT web tab
/open claude-cdp claude1      open or attach a Claude web tab
/sessions                     list sessions
@codex1 exec: pwd             run a shell command through codex1
@cgpt1 summarize this thread  send one turn to cgpt1
/use cgpt1                    route plain text to cgpt1
/use cgpt1,claude1            route plain text to both
/use clear                    clear plain-text routing
```

Plain text is not sent to every session by default. Use `@name message` for one
turn, or `/use` to set active recipients.

## Web Brains

Start Chrome:

```text
/chrome
```

Then log into `chatgpt.com` or `claude.ai` in that Chrome profile and attach a
tab:

```text
/open chatgpt-cdp cgpt1
/open claude-cdp claude1
```

Web tab history and the Markdown room log are separate. Send summaries or file
excerpts when a web tab needs more context.

## Core Commands

```text
/file                         show the current room file
/conversation <name|path>     switch room files
/open <brain> [name]          create a session
/attach [brain|profile] ...   attach CDP tabs or start a profile
/detach <name>                remove a session
/tabs [all]                   list Chrome pages
/refresh [@name]              read the latest CDP assistant message
/send-file ... @name "ask"    send a file excerpt
/paste-file <name> <path>     paste a deterministic file excerpt
/summarize ... <name>         save a summary
/inject <name> [session]      inject a saved summary
/config [key [value]]         read or write config
/theme <name|next|prev>       switch terminal theme
```

Run `/help` for the generated command list. `interpreter.mjs` is the command
registry used by the shell and extension.

## Project Layout

```text
egpt/
  egpt.mjs              shell app and side effects
  interpreter.mjs       parser and command registry
  room.mjs              routing decisions
  persona-state.mjs     persona state helpers
  brains/               Codex, Claude Code, ChatGPT CDP, Claude CDP
  bridges/              Telegram and WhatsApp bridges
  extension/            browser extension
  tools/                CDP, proxy, bus, browser, and theme tools
  commands/             operator prompt templates
  tests/                Vitest tests
  MANUAL.md             operating manual
  TESTING.md            manual test checklist
```

Runtime state lives under `~/.egpt/`: config, Chrome profiles, CDP token,
prepared files, summaries, and session state.

## Tests

```bash
npm test
npm run test:watch
npm test -- --coverage
```

The automated tests cover parser, routing, command registry, persona state,
bus/CDP helpers, extension helpers, and bridge helpers.

Use [TESTING.md](./TESTING.md) after changes to live CDP automation, browser UI,
CLI subprocess execution, Telegram, or WhatsApp.

## Caveats

- Web automation can break when ChatGPT or Claude changes its UI.
- CDP web sessions do not automatically ingest the full Markdown room.
- Slash command output is operational and is usually not appended to the room.
- WhatsApp automation is best treated as personal-volume, best-effort use.

## License

eGPT is released under the **MIT License**.

- Use it, fork it, modify it, ship it inside another product, or sell what you
  build with it.
- Keep the copyright + license notice when you redistribute the source or a
  substantial portion of it.
- **No warranty. No liability.** This is a personal, evolving project that
  drives a browser, a phone, and external accounts. Run it at your own risk —
  the author is not responsible for lost data, leaked messages, banned WhatsApp
  numbers, runaway brain bills, or anything else that goes sideways.

See [LICENSE](./LICENSE) for the full text.
