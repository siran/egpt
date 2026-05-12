# egpt

egpt is a local chat room for multiple AI sessions.

It stores the room in a plain Markdown file and routes messages to named
participants:

- ChatGPT and Claude web tabs through Chrome DevTools Protocol
- Codex and Claude Code CLIs as local subprocesses
- shell, browser extension, Telegram, and WhatsApp bridges

The web sessions use your existing browser login. The core flow does not need
OpenAI or Anthropic API keys.

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

Personal project. Not packaged for redistribution.
