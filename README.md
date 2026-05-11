# egpt

egpt is a local multi-brain chat room. It keeps the conversation in a plain
Markdown file while routing messages to named AI participants:

- ChatGPT.com and Claude.ai tabs driven through Chrome DevTools Protocol
- Claude Code and Codex CLIs run as local subprocess brains
- shell, browser-extension, Telegram, and WhatsApp surfaces sharing one room

The web brains use the accounts and browser sessions you already have. There
are no OpenAI/Anthropic API keys in the core flow; the trade-off is that a
Chrome profile must stay logged in and reachable over CDP.

For daily usage details, read [MANUAL.md](./MANUAL.md). For manual feature
checks, read [TESTING.md](./TESTING.md).

## Quick Start

Requirements: Node 18+, npm, Chrome for CDP brains, and optional `claude` /
`codex` CLIs on PATH for local brains.

```bash
cd ~/src/egpt
npm install
npm run build:ext
node egpt.mjs                  # uses ./conversation.md
node egpt.mjs ~/notes/room.md  # explicit conversation file
```

On Windows PowerShell, if script execution blocks `npm`, use `npm.cmd`:

```powershell
npm.cmd install
npm.cmd run build:ext
npm.cmd test
```

Inside egpt:

```text
/help                         show commands
/chrome                       launch the persistent brain Chrome
/open codex codex1            register a local Codex participant
/open ccode ccode1            register a Claude Code participant
/open chatgpt-cdp cgpt1       open/register a ChatGPT tab
/open claude-cdp claude1      open/register a Claude tab
/sessions                     list local and peer sessions
@codex1 exec: pwd             run a shell command in codex1's cwd
@cgpt1 summarize this thread  send one turn to cgpt1
/use cgpt1                    route later plain text to cgpt1
/use cgpt1,claude1            route later plain text to both
/use clear                    stop plain-text routing
```

Plain text does not automatically fan out to every brain. Use an `@session`
mention for a single turn, or set active recipients with `/use`.

## Core Model

The Markdown conversation file is the canonical room log. egpt appends human
turns and brain replies, and you can edit, grep, version, or copy that file like
any other note.

A session is a named participant such as `codex1`, `ccode1`, `cgpt1`, or
`claude1`. Routing is explicit:

- `@name message` sends one turn to that session.
- `@codex exec: <command>` runs a local shell command through Codex's operator
  path.
- `/use name` makes unaddressed messages route to one active session.
- `/use a,b` enables deliberate multi-brain broadcast for plain text.
- `/sessions` shows local sessions and peer-owned sessions seen over the bus.

Brain profiles are YAML presets loaded from `./.egpt/brains/`,
`~/.egpt/brains/`, or `brains/type/`. A profile can pin a brain type, model,
reasoning effort, cwd, summary injection, and an existing web conversation URL.

## Browser Brains

`/chrome` starts a detached Chrome profile at
`~/.egpt/chrome/profiles/brain`, with the extension loaded and remote debugging
on the private Chrome port. egpt then attaches through its token-authenticated
CDP proxy.

For ChatGPT and Claude:

1. Run `/chrome`.
2. Log into `chatgpt.com` and/or `claude.ai` once in that Chrome profile.
3. Use `/open chatgpt-cdp`, `/open claude-cdp`, or `/attach` to bind tabs as
   room sessions.

The tab's native web history remains separate from the Markdown room log. Use
summaries, file pastes, or manual context injection when a tab needs broader
room history.

## Extension And Bridges

`extension/` builds a Chrome MV3 extension that can join the same room through
the CDP bus. It shares the parser and command registry with the shell, but owns
browser-side UI and Chrome-debugger integration.

The shell also includes:

- Telegram bridge in `bridges/telegram.mjs`
- WhatsApp bridge in `bridges/whatsapp.mjs`
- LAN coordination through `tools/bus.html`, `tools/bus.mjs`, and
  `tools/cdp-proxy.mjs`

Bridge setup and permission details are in [MANUAL.md](./MANUAL.md).

## Common Commands

```text
/file                         show the current conversation file
/conversation <name|path>     switch conversation files
/open <brain> [name]          create/register a participant
/attach [brain|profile] ...   attach CDP tabs or start a profile
/detach <name>                remove a session
/tabs [all]                   list Chrome pages
/refresh [@name]              re-read the latest CDP assistant message
/send-file ... @name "ask"    prepare and send a file excerpt
/paste-file <name> <path>     paste a deterministic file excerpt
/summarize ... <name>         save a reusable summary
/inject <name> [session]      inject a saved summary
/config [key [value]]         read or write config
/theme <name|next|prev>       switch terminal theme
```

Run `/help` for the current generated registry. `interpreter.mjs` is the source
of truth for commands shared by the shell and extension.

## Tests

```bash
npm test
npm run test:watch
npm test -- --coverage
```

Current local coverage run (`npm.cmd test -- --coverage`, 2026-05-11):

- 18 test files passed
- 391 tests passed
- whole-project line coverage: 10.92%

The tests do exercise real behavior in extracted modules:

- input parsing, command registry, help rendering
- routing decisions in `room.mjs`, including `/use`, peer mentions, and CDP
  mirror planning
- profile/persona state transitions
- bus signing, replay, flood detection, key loading, and CDP proxy behavior
- extension command helpers, WhatsApp classification/routing/echo helpers, and
  extension build integrity

The suite does not meaningfully test the largest side-effecting surfaces:
`egpt.mjs`, React extension UI state, live CDP automation against ChatGPT or
Claude, real Telegram/WhatsApp network behavior, or local CLI brain execution.
Use [TESTING.md](./TESTING.md) after non-trivial changes in those areas.

## Layout

```text
egpt/
  egpt.mjs                 shell app, room state, command side effects
  interpreter.mjs          shared parser and command registry
  room.mjs                 pure routing decisions
  persona-state.mjs        @egpt persona history/state helpers
  brains/                  ccode, codex, ChatGPT CDP, Claude CDP
  bridges/                 Telegram and WhatsApp bridges
  extension/               Chrome/Firefox extension sources and build
  tools/                   CDP, proxy, bus, browser tools, themes
  commands/                operator prompt templates
  tests/                   Vitest suite
  MANUAL.md                operating manual
  TESTING.md               manual end-to-end checklist
```

Runtime state is stored under `~/.egpt/`: config, Chrome profiles, CDP token,
brain profile state, prepared files, summaries, and Codex mirrors.

## Caveats

- Web UI automation is selector-sensitive. ChatGPT or Claude redesigns can
  break CDP injection or polling.
- CDP brains keep native tab memory; they do not automatically ingest the whole
  Markdown room.
- Slash command output is operational and is not generally appended to the
  conversation file.
- The WhatsApp bridge uses a personal-account Web protocol path and should be
  treated as personal-volume, best-effort automation.

## License

Personal project. Not packaged for redistribution yet.
