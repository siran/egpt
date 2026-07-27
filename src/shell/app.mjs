// src/shell/app.mjs — the operator EDITOR's Ink VIEW. Thin on purpose: it holds NO logic
// of its own — server.mjs owns transport, input.mjs owns the compose reducer, commands.mjs
// owns local-vs-forward routing. This file only draws them. It is TTY-bound and therefore
// NOT unit-tested (rendering it with no TTY hangs the harness); keep it thin so there is
// little here to get wrong.
//
// No JSX / no build step — v1's Ink shell used React.createElement (`h`) in a plain .mjs,
// so `node egpt.mjs` runs with no bundler. We mirror that exactly.
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
import * as hist from './history.mjs';
import { routeCommand } from './commands.mjs';
import { notDeliveredMessage } from './delivery.mjs';

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
// reply pushed by the spine, `system` = the editor's own local notices (theme, drops),
// `error` = a delivery failure or other fault — kept loud on purpose, never swallowed.
//
// A spine reply (`egpt`) is rendered RAW — its body ALREADY carries the persona stamp
// (🐶 egpt\n…) from the shared wrap the spine ran, so we must NOT prepend the app's generic
// `🧠 egpt` author line (that would double-stamp). Just a timestamp meta + the wrapped body.
// you / system / error keep the author-line format.
function renderItem(T, it) {
  if (it._sep) return h(Box, { key: it.id, marginTop: 1 }, h(Text, { color: T.meta }, `── ${it.body} ──`));
  if (it.author === 'egpt') {
    return h(Box, { key: it.id, flexDirection: 'column', marginBottom: 1 },
      h(Text, { color: T.meta }, `(${hhmm(it.ts)})`),
      ...String(it.body).split('\n').map((line, i) => h(Text, { key: i, color: T.authorBrain }, line || ' ')));
  }
  const isSystem = it.author === 'system';
  const isYou = it.author === 'you';
  const isError = it.author === 'error';
  const emoji = isYou ? '🦅' : isError ? '⚠️' : '🧠';
  const label = isYou ? 'you' : isError ? 'error' : isSystem ? 'shell' : 'egpt';
  const color = isYou ? T.authorYou : isError ? T.error : isSystem ? T.authorSystem : T.authorBrain;
  return h(Box, { key: it.id, flexDirection: 'column', marginBottom: 1 },
    h(Text, { color, bold: true }, `${emoji} ${label} `, h(Text, { color: T.meta }, `(${hhmm(it.ts)})`)),
    ...String(it.body).split('\n').map((line, i) =>
      h(Text, { key: i, italic: isSystem, bold: isError, color: isSystem ? T.systemBody : isError ? T.error : undefined }, line || ' ')));
}

// The LIVE streaming line — the ⏳ thinking train + progressive edits, rendered BELOW the
// <Static> transcript / above the composer so it re-renders in place (never committed until
// finish). Its text is the already-persona-stamped streaming frame, so — like a committed
// reply — render it raw (no generic author line).
//
// NOT dimmed (operator 2026-07-25): dimColor read as in-progress, but this is the text you
// are actually trying to READ while it arrives, and legibility beats the status cue. The ⏳
// in the frame already says "still going", so the dim was carrying no information the line
// didn't already carry.
function renderLive(T, live) {
  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    ...String(live.text).split('\n').map((line, i) =>
      h(Text, { key: i, color: T.authorBrain }, line || ' ')));
}

// Rebuild a compose state from plain text (used when history recall drops a past line into
// the composer) — cursor lands at the end, mirroring a shell recalling a history entry.
function stateFromText(t) {
  const lines = String(t).split('\n');
  return { lines, row: lines.length - 1, col: lines[lines.length - 1].length };
}

// The multi-line compose input — structure ported from v1's MultiLineInput, but every key
// delegates to the pure reducer in input.mjs. Ctrl+D submits, Enter is a newline. ↑/↓ move
// the cursor within a multi-line draft as before; only at the top/bottom row boundary —
// where edit.up/edit.down are a no-op (same object back, checked by reference) — do they
// fall through to history.mjs's ↑/↓ recall.
function MultiLineInput({ onSubmit }) {
  const [st, setSt] = useState(edit.empty());
  const [hbuf, setHbuf] = useState(hist.empty());
  useInput((input, key) => {
    if (key.ctrl && input === 'd') {
      const t = edit.text(st);
      if (t.trim()) { onSubmit(t); setHbuf(hist.push(hbuf, t)); }
      setSt(edit.empty());
      return;
    }
    if (key.return) return setSt(edit.newline(st));
    if (key.backspace || key.delete) return setSt(edit.backspace(st));
    if (key.leftArrow) return setSt(edit.left(st));
    if (key.rightArrow) return setSt(edit.right(st));
    if (key.upArrow) {
      const moved = edit.up(st);
      if (moved !== st) return setSt(moved);
      const r = hist.up(hbuf, edit.text(st));
      if (!r) return;
      setHbuf(r.state);
      return setSt(stateFromText(r.text));
    }
    if (key.downArrow) {
      const moved = edit.down(st);
      if (moved !== st) return setSt(moved);
      const r = hist.down(hbuf);
      if (!r) return;
      setHbuf(r.state);
      return setSt(stateFromText(r.text));
    }
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
      return h(Text, { key: i }, i === 0 ? '> ' : '  ', before,
        cursor >= 0 ? h(Text, { inverse: true }, ch) : '', after);
    }));
}

function App({ server, themes, initialTheme, onError }) {
  const { exit } = useApp();
  const [items, setItems] = useState([]);
  const [live, setLive] = useState(null);   // the in-progress streaming line: { text } or null
  const [header, setHeader] = useState('');  // the PERMANENT header line (boot's computeShellHeader), spine-sent
  const [themeName, setThemeName] = useState(initialTheme);
  const [T, setT] = useState(loadTheme(initialTheme));

  const add = (author, body) => setItems(prev => [...prev, { id: nextId(), ts: Date.now(), author, body: String(body) }]);

  useEffect(() => {
    // A spine frame is either a LIVE streaming edit (the ⏳ thinking train — replace the live
    // line in place) or a COMMITTED final (streaming:false — clear the live line and append the
    // wrapped reply to the transcript). A `delete` final clears the live line, commits nothing.
    // `header` (the PERMANENT status line, boot's computeShellHeader) may ride ANY frame,
    // including a header-only frame with neither text nor streaming nor delete — that shape
    // must update the header and fall through WITHOUT touching the transcript/live state below.
    server.onSpineMessage(m => {
      if (m.header != null) setHeader(m.header);
      if (!m.text && !m.streaming && !m.delete) return;
      if (m.streaming) { setLive({ text: m.text }); return; }
      setLive(null);
      if (m.delete) return;
      add('egpt', m.text);
    });
    // Server/socket faults (from egpt.mjs's onLog sink) surface as loud error rows, never swallowed.
    onError?.(m => add('error', m));
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
    const wasConnected = server.isConnected;
    if (!server.send(r.text)) add('error', notDeliveredMessage(wasConnected));
  };

  // No status/connection chrome at all beyond the permanent header — the editor opens
  // straight to the composer and is usable immediately. We ASSUME the spine is connected; if
  // a send actually can't be delivered, submit() surfaces a loud not-delivered error at that
  // moment (see below).
  return h(Fragment, null,
    h(Box, { flexDirection: 'column' }, h(Text, { color: T.statusBrand }, header)),
    h(Static, { items: withDaySeparators(items) }, (it) => renderItem(T, it)),
    h(Box, { flexDirection: 'column', marginTop: 1 },
      live ? renderLive(T, live) : null,
      h(MultiLineInput, { onSubmit: submit })));
}

// v1 rendered Ink with NO JSX and exitOnCtrlC:false so its own Ctrl+C handler ran; we mirror
// both. Returns the Ink instance (has .waitUntilExit()).
export function runApp({ server, themes, initialTheme = 'catppuccin', onError }) {
  return render(h(App, { server, themes, initialTheme, onError }), { exitOnCtrlC: false });
}
