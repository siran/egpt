#!/usr/bin/env node
// egpt.mjs — the operator SHELL EDITOR entry (egpt v2).
//
// A standalone Ink app that DIALS ws://127.0.0.1:23375, which the running spine's `shell-port`
// limb (src/bridges/shell-port.mjs) serves and holds from boot — the spine is the server, this
// editor is the client (operator ruling 2026-08-26, inverting the original plan §1; see the
// shell-port header for why). Composed lines forward to the spine as `{ text }`; the spine's
// replies arrive as `{ text, chatId }` and render in the transcript. Closing this editor NEVER
// touches the spine — the socket just closes and the spine keeps serving the console port.
//
// No build step: v1's Ink shell used React.createElement in plain .mjs, so this runs with
// `node egpt.mjs` — no bundler, no JSX.
//
//   Usage: node egpt.mjs [--port 23375] [--theme catppuccin]
import process from 'node:process';
import { createSpineLink, SHELL_WS_PORT } from './src/shell/spine-link.mjs';
import { shellTokenFrom } from './src/shell/auth.mjs';
import { readConfigSync } from './src/tools/config-io.mjs';
import { listThemes } from './src/tools/theme.mjs';
import { runApp } from './src/shell/app.mjs';

function parseArgs(argv) {
  const args = { port: SHELL_WS_PORT, theme: 'catppuccin' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]) || args.port;
    else if (argv[i] === '--theme') args.theme = argv[++i] ?? args.theme;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// Ink needs a TTY. In a pipe/redirect there is no terminal to draw to — say so and exit
// cleanly (exit 1), rather than letting Ink throw a raw-mode error.
if (!process.stdout.isTTY) {
  console.error('egpt-shell: no TTY — run this in a real terminal (Ink cannot render to a pipe).');
  process.exit(1);
}

// Do NOT swallow link/socket faults. Ink owns the screen, so a raw console.error would
// corrupt the TUI — instead forward only FAULT lines (announce/socket/dial/send failures;
// the plain connect/disconnect/announce info lines the app already tracks by polling stay
// quiet) to the app, which renders them as loud `error` transcript rows.
const errorListeners = [];
// THE SHARED SECRET the spine challenges this editor with (src/shell/auth.mjs). Read from the
// operator's own config — this process runs as the operator, so it can read the same
// ~/.egpt/config/config.yaml the spine reads; the sandboxed accounts that could otherwise
// impersonate this editor cannot. Read-only, and the ONE place the editor touches config.
// Missing → the handshake goes unanswered and the spine refuses this editor, loudly (fail closed).
const link = createSpineLink({
  port: args.port,
  token: shellTokenFrom(readConfigSync()),
  onLog: (m) => { if (/fail|error/i.test(m)) for (const fn of errorListeners) fn(m); },
});
link.start();

// listThemes reads config/themes (shipped) + ~/.egpt/themes (read-only); default catppuccin.
const themes = await listThemes();
const initialTheme = themes.includes(args.theme) ? args.theme : (themes.includes('catppuccin') ? 'catppuccin' : themes[0]);

runApp({ link, themes, initialTheme, port: args.port, onError: (fn) => errorListeners.push(fn) });
