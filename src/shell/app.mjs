// src/shell/app.mjs — the operator EDITOR's Ink VIEW. Thin on purpose: it holds NO logic
// of its own — server.mjs owns transport, input.mjs owns the compose reducer, commands.mjs
// owns local-vs-forward routing. This file only draws them. It is TTY-bound and therefore
// NOT unit-tested (rendering it with no TTY hangs the harness); keep it thin so there is
// little here to get wrong.
//
// No JSX / no build step — v1's Ink shell used React.createElement (`h`) in a plain .mjs,
// so `node egpt-shell.mjs` runs with no bundler. We mirror that exactly.
//
// Presentation ported from v1's Gen-A shell (deleted egpt.mjs, git 9de159a~1): the
// <Static> transcript with chat-style day separators, the author/time line, and the
// MultiLineInput cursor rendering. Transport-side machinery from v1 (attach sockets, the
// HELLO handshake, streaming telemetry) is NOT ported — this editor speaks only the
// shell-port frame protocol, whose replies arrive as whole `{ text }` lines (no chunked
// streaming), so the MVP commits each reply straight to the transcript.
//   Layer-2 (not built): streaming telemetry (N chars · elapsed · Ctrl+R abort), per-room
//   input history, /recap dashboard styling, autocomplete, multi-room targeting.
import React from 'react';
import { render, Box, Text, Static, useInput, useApp } from 'ink';
import { loadTheme } from '../tools/theme.mjs';
import * as edit from './input.mjs';
import { routeCommand } from './commands.mjs';

const { createElement: h, useState, useEffect, Fragment } = React;

let _idc = 0;
const nextId = () => `i${++_idc}`;
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

// Day-separator helpers — ported verbatim from v1 (_dayLabel / withDaySeparators). Stable
// on the item list so Ink's <Static> only ever emits the new tail.
function dayLabel(d) {
  const key = d.toDateString();
  if (key === new Date().toDateString()) return 'Today';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (key === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}
function withDaySeparators(items) {
  const out = []; let last = null;
  for (const it of items) {
    const key = new Date(it.ts).toDateString();
    if (key !== last) { out.push({ id: `day-${key}`, _sep: true, body: dayLabel(new Date(it.ts)) }); last = key; }
    out.push(it);
  }
  return out;
}

// One transcript row (or a day separator). `you` = the operator's own line, `egpt` = a
// reply pushed by the spine, `system` = the editor's own local notices (theme, drops).
function renderItem(T, it) {
  if (it._sep) return h(Box, { key: it.id, marginTop: 1 }, h(Text, { color: T.meta }, `── ${it.body} ──`));
  const isSystem = it.author === 'system';
  const isYou = it.author === 'you';
  const emoji = isYou ? '🦅' : '🧠';
  const label = isYou ? 'you' : isSystem ? 'shell' : 'egpt';
  const color = isYou ? T.authorYou : isSystem ? T.authorSystem : T.authorBrain;
  return h(Box, { key: it.id, flexDirection: 'column', marginBottom: 1 },
    h(Text, { color, bold: true }, `${emoji} ${label} `, h(Text, { color: T.meta }, `(${hhmm(it.ts)})`)),
    ...String(it.body).split('\n').map((line, i) =>
      h(Text, { key: i, italic: isSystem, color: isSystem ? T.systemBody : undefined }, line || ' ')));
}

// The multi-line compose input — structure ported from v1's MultiLineInput, but every key
// delegates to the pure reducer in input.mjs. Ctrl+D submits, Enter is a newline.
function MultiLineInput({ onSubmit }) {
  const [st, setSt] = useState(edit.empty());
  useInput((input, key) => {
    if (key.ctrl && input === 'd') {
      const t = edit.text(st);
      if (t.trim()) onSubmit(t);
      setSt(edit.empty());
      return;
    }
    if (key.return) return setSt(edit.newline(st));
    if (key.backspace || key.delete) return setSt(edit.backspace(st));
    if (key.leftArrow) return setSt(edit.left(st));
    if (key.rightArrow) return setSt(edit.right(st));
    if (key.upArrow) return setSt(edit.up(st));
    if (key.downArrow) return setSt(edit.down(st));
    if (key.ctrl && input === 'a') return setSt(edit.home(st));
    if (key.ctrl && input === 'e') return setSt(edit.end(st));
    if (!input || key.ctrl || key.meta) return;
    setSt(edit.insert(st, input));
  });
  return h(Box, { flexDirection: 'column' },
    ...st.lines.map((line, i) => {
      const cursor = i === st.row ? st.col : -1;
      const before = cursor >= 0 ? line.slice(0, cursor) : line;
      const ch = cursor >= 0 ? (line[cursor] || ' ') : '';
      const after = cursor >= 0 ? line.slice(cursor + 1) : '';
      return h(Text, { key: i }, i === 0 ? '> ' : '| ', before,
        cursor >= 0 ? h(Text, { inverse: true }, ch) : '', after);
    }));
}

function App({ server, themes, initialTheme, port }) {
  const { exit } = useApp();
  const [items, setItems] = useState([]);
  const [themeName, setThemeName] = useState(initialTheme);
  const [T, setT] = useState(loadTheme(initialTheme));
  const [connected, setConnected] = useState(server.isConnected);

  const add = (author, body) => setItems(prev => [...prev, { id: nextId(), ts: Date.now(), author, body: String(body) }]);

  useEffect(() => {
    server.onSpineMessage(m => add('egpt', m.text));
    // Poll the connection so the status line reflects the spine dialing in/out. shell-port's
    // backoff can take up to ~60s to connect on a fresh start (known MVP limitation).
    const iv = setInterval(() => setConnected(server.isConnected), 1000);
    iv.unref?.();
    return () => clearInterval(iv);
  }, []);

  // Ctrl+C quits the EDITOR only — the spine is a separate process and lives on.
  useInput((input, key) => { if (key.ctrl && input === 'c') { try { server.stop(); } catch {} exit(); } });

  const applyTheme = (arg) => {
    const idx = themes.indexOf(themeName);
    let name = themeName;
    if (arg === '' || arg === 'next') name = themes[(idx + 1) % themes.length];
    else if (arg === 'prev') name = themes[(idx - 1 + themes.length) % themes.length];
    else if (themes.includes(arg)) name = arg;
    else { add('system', `unknown theme '${arg}'. available: ${themes.join(', ')}`); return; }
    setThemeName(name); setT(loadTheme(name)); add('system', `theme → ${name}`);
  };

  const submit = (line) => {
    const r = routeCommand(line);
    if (r.action === 'exit') { try { server.stop(); } catch {} exit(); return; }
    if (r.action === 'clear') { setItems([]); return; }
    if (r.action === 'theme') { applyTheme(r.arg); return; }
    add('you', r.text);
    if (!server.send(r.text)) add('system', 'not connected — the spine has not dialed in yet; message not sent (up to ~60s after a fresh start)');
  };

  return h(Fragment, null,
    h(Static, { items: withDaySeparators(items) }, (it) => renderItem(T, it)),
    h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Text, null,
        h(Text, { color: T.statusBrand, bold: true }, '🧠 egpt shell'),
        h(Text, { color: connected ? T.authorBrain : T.error }, connected ? '  ● spine connected' : '  ○ waiting for spine'),
        h(Text, { color: T.statusSessions }, `  theme:${themeName}  :${port}`)),
      h(Text, { color: T.hint }, 'Enter=newline · Ctrl+D=send · Ctrl+C=exit · /theme /clear /exit are local · all else → spine'),
      h(MultiLineInput, { onSubmit: submit })));
}

// v1 rendered Ink with NO JSX and exitOnCtrlC:false so its own Ctrl+C handler ran; we mirror
// both. Returns the Ink instance (has .waitUntilExit()).
export function runApp({ server, themes, initialTheme = 'catppuccin', port }) {
  return render(h(App, { server, themes, initialTheme, port }), { exitOnCtrlC: false });
}
