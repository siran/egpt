#!/usr/bin/env node
// egpt.mjs — the operator SHELL EDITOR entry (egpt v2).
//
// A standalone Ink app that SERVES ws://127.0.0.1:23375. The running spine's `shell-port`
// limb (src/bridges/shell-port.mjs) dials INTO this server as a client — the editor is the
// server, the spine is the client (plan §1: the spine is a CLIENT of its surface apps).
// Composed lines forward to the spine as `{ text }`; the spine's replies arrive as
// `{ text, chatId }` and render in the transcript. Closing this editor NEVER touches the
// spine — the socket just closes and the limb idles + reconnects.
//
// No build step: v1's Ink shell used React.createElement in plain .mjs, so this runs with
// `node egpt.mjs` — no bundler, no JSX.
//
//   Usage: node egpt.mjs [--port 23375] [--theme catppuccin]
import process from 'node:process';
import { createShellServer, SHELL_WS_PORT } from './src/shell/server.mjs';
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

const server = createShellServer({ port: args.port, onLog: () => {} });
server.start();

// listThemes reads config/themes (shipped) + ~/.egpt/themes (read-only); default catppuccin.
const themes = await listThemes();
const initialTheme = themes.includes(args.theme) ? args.theme : (themes.includes('catppuccin') ? 'catppuccin' : themes[0]);

runApp({ server, themes, initialTheme, port: args.port });
