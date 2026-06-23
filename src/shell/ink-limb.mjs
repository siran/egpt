// src/shell/ink-limb.mjs -- the local terminal shell as a thin egpt limb.
//
// This module is intentionally presentation + attach transport only. It does
// not import the spine/engine, bridges, room routing, slash handlers, or brain
// dispatch. The shell limb renders frames from the running spine and forwards
// operator input back over the attach socket.

import React from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';

import { readNucleusInfo, loadOrCreateBusKey } from '../attach/discovery.mjs';
import { connectAttachClient } from '../attach/client.mjs';
import { N2C } from '../attach/protocol.mjs';

const { createElement: h, useEffect, useRef, useState } = React;

function nowId(prefix = 'local') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function hhmm(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function normalizeItem(raw = {}) {
  return {
    ...raw,
    id: raw.id ?? nowId('item'),
    author: raw.author ?? 'system',
    body: String(raw.body ?? ''),
    _receivedAt: raw._receivedAt ?? Date.now(),
  };
}

function upsertById(items, raw) {
  const item = normalizeItem(raw);
  const i = items.findIndex(x => x.id === item.id);
  if (i < 0) return [...items, item];
  const next = items.slice();
  next[i] = { ...next[i], ...item };
  return next;
}

function MultiLineInput({ disabled = false, onSubmit }) {
  const [lines, setLines] = useState(['']);
  const [row, setRow] = useState(0);
  const [col, setCol] = useState(0);

  const reset = () => { setLines(['']); setRow(0); setCol(0); };

  useInput((input, key) => {
    if (disabled) return;
    if (key.ctrl && input === 'd') {
      const text = lines.join('\n');
      if (text.trim()) onSubmit(text);
      reset();
      return;
    }
    if (key.return) {
      const next = lines.slice();
      const tail = next[row].slice(col);
      next[row] = next[row].slice(0, col);
      next.splice(row + 1, 0, tail);
      setLines(next); setRow(row + 1); setCol(0);
      return;
    }
    if (key.backspace || key.delete) {
      const next = lines.slice();
      if (col > 0) {
        next[row] = next[row].slice(0, col - 1) + next[row].slice(col);
        setLines(next); setCol(col - 1);
      } else if (row > 0) {
        const prevLen = next[row - 1].length;
        next[row - 1] += next[row];
        next.splice(row, 1);
        setLines(next); setRow(row - 1); setCol(prevLen);
      }
      return;
    }
    if (key.leftArrow) {
      if (col > 0) setCol(col - 1);
      else if (row > 0) { setRow(row - 1); setCol(lines[row - 1].length); }
      return;
    }
    if (key.rightArrow) {
      if (col < lines[row].length) setCol(col + 1);
      else if (row < lines.length - 1) { setRow(row + 1); setCol(0); }
      return;
    }
    if (key.upArrow) {
      if (row > 0) { const r = row - 1; setRow(r); setCol(Math.min(col, lines[r].length)); }
      return;
    }
    if (key.downArrow) {
      if (row < lines.length - 1) { const r = row + 1; setRow(r); setCol(Math.min(col, lines[r].length)); }
      return;
    }
    if (key.ctrl && input === 'a') { setCol(0); return; }
    if (key.ctrl && input === 'e') { setCol(lines[row].length); return; }
    if (!input || key.ctrl || key.meta) return;

    const chunks = input.replace(/\r\n?/g, '\n').split('\n');
    const next = lines.slice();
    const before = next[row].slice(0, col);
    const after = next[row].slice(col);
    next[row] = before + chunks[0];
    for (let i = 1; i < chunks.length; i++) next.splice(row + i, 0, chunks[i]);
    const last = row + chunks.length - 1;
    next[last] += after;
    setLines(next);
    setRow(last);
    // Cursor advance: single-line insert moves the column FORWARD by the typed
    // length (col + chunk) — not to the chunk length, which stranded the cursor
    // at position 1 and made typing run backwards ('hello' → 'holle'). A
    // multi-line paste lands on the last line at that chunk's length.
    setCol(chunks.length === 1 ? col + chunks[0].length : chunks[chunks.length - 1].length);
  });

  return h(Box, { flexDirection: 'column' },
    ...lines.map((line, i) => {
      const cursor = i === row ? col : -1;
      const before = cursor >= 0 ? line.slice(0, cursor) : line;
      const ch = cursor >= 0 ? (line[cursor] || ' ') : '';
      const after = cursor >= 0 ? line.slice(cursor + 1) : '';
      return h(Text, { key: i },
        i === 0 ? '> ' : '| ',
        before,
        cursor >= 0 ? h(Text, { inverse: true }, ch) : '',
        after);
    }));
}

function Message({ item }) {
  const author = String(item.author ?? 'system');
  const isSystem = author === 'system';
  const color = isSystem ? 'gray' : author === 'You' ? 'cyan' : 'green';
  const label = isSystem ? 'egpt' : author;
  const body = String(item.body ?? '');
  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Text, { color, bold: !isSystem },
      `${label} `,
      h(Text, { color: 'gray' }, `(${hhmm(item.id ?? item._receivedAt)})`)),
    ...body.split('\n').map((line, i) =>
      h(Text, { key: i, italic: isSystem, color: isSystem ? 'gray' : undefined }, line || ' ')));
}

function ShellLimbApp({ version = null }) {
  const { exit } = useApp();
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('locating spine...');
  const [connected, setConnected] = useState(false);
  const [stream, setStream] = useState(null);
  const handleRef = useRef(null);

  const addSystem = (body) => {
    setItems(prev => [...prev, normalizeItem({ id: nowId('sys'), author: 'system', body, _localOnly: true })]);
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
  });

  useEffect(() => {
    let stopped = false;
    let retryTimer = null;
    let handle = null;

    const schedule = (fn, ms) => {
      retryTimer = setTimeout(fn, ms);
      retryTimer.unref?.();
    };

    const onFrame = (frame) => {
      if (frame.t === N2C.ITEM) {
        const { t, ...item } = frame;
        setItems(prev => upsertById(prev, item));
      } else if (frame.t === N2C.SYS) {
        addSystem(frame.body ?? '');
      } else if (frame.t === N2C.STREAM) {
        setStream(prev => {
          const id = frame.id ?? 'stream';
          const text = (prev?.id === id ? prev.text : '') + String(frame.chunk ?? '');
          return { id, text };
        });
      } else if (frame.t === N2C.STREAM_END) {
        const id = frame.id ?? nowId('stream');
        const text = String(frame.text ?? '');
        setStream(null);
        if (text) setItems(prev => upsertById(prev, { id, author: 'stream', body: text }));
      } else if (frame.t === N2C.BYE) {
        setConnected(false);
        setStatus(`spine going down (${frame.reason ?? 'bye'}); reattaching...`);
      }
    };

    const connect = async () => {
      if (stopped) return;
      let info = null;
      try { info = await readNucleusInfo(); } catch {}
      if (!info?.port) {
        setConnected(false);
        setStatus('no spine found; waiting for nucleus.json');
        schedule(connect, 2000);
        return;
      }

      try {
        const keyB64 = await loadOrCreateBusKey();
        handle = await connectAttachClient({
          host: info.host ?? '127.0.0.1',
          port: info.port,
          keyB64,
          kind: 'shell',
          cols: process.stdout?.columns ?? null,
          rows: process.stdout?.rows ?? null,
          version,
          onFrame,
          onClose: () => {
            handleRef.current = null;
            setConnected(false);
            if (!stopped) {
              setStatus('spine connection closed; reattaching...');
              schedule(connect, 1000);
            }
          },
        });
        handleRef.current = handle;
        setConnected(true);
        setStatus(`attached to ${info.host ?? '127.0.0.1'}:${info.port} (pid ${handle.welcome?.nucleusPid ?? '?'})`);
      } catch (e) {
        handleRef.current = null;
        setConnected(false);
        setStatus(`attach failed: ${e?.message ?? e}; retrying`);
        if (!stopped) schedule(connect, 1500);
      }
    };

    connect();

    const onResize = () => {
      try { handleRef.current?.resize?.(process.stdout?.columns ?? null, process.stdout?.rows ?? null); } catch {}
    };
    process.stdout?.on?.('resize', onResize);

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      process.stdout?.off?.('resize', onResize);
      try { handle?.close?.(); } catch {}
      handleRef.current = null;
    };
  }, [version]);

  const submit = (text) => {
    const hdl = handleRef.current;
    const wantsExit = /^\/exit\b/.test(String(text ?? '').trim());
    if (!hdl?.connected) {
      if (wantsExit) exit();
      else addSystem('not attached; input was not sent');
      return;
    }
    hdl.input(text);
    if (wantsExit) setTimeout(() => exit(), 200).unref?.();
  };

  const shown = items.slice(-160);
  const hidden = Math.max(0, items.length - shown.length);

  return h(Box, { flexDirection: 'column' },
    hidden > 0 ? h(Text, { color: 'gray' }, `... ${hidden} earlier item(s) hidden ...`) : null,
    ...shown.map(item => h(Message, { key: item.id, item })),
    stream ? h(Box, { flexDirection: 'column', marginBottom: 1 },
      h(Text, { color: 'green', bold: true }, 'stream ', h(Text, { color: 'gray' }, '(live)')),
      h(Text, null, stream.text + '|')) : null,
    h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Text, null,
        h(Text, { color: connected ? 'green' : 'yellow', bold: true }, 'egpt shell limb'),
        h(Text, { color: 'gray' }, `  ${status}`)),
      h(Text, { color: 'gray' }, 'Enter=newline - Ctrl+D=send - Ctrl+C=exit'),
      h(MultiLineInput, { disabled: false, onSubmit: submit })));
}

export async function runInkShellLimb({ version = null } = {}) {
  render(h(ShellLimbApp, { version }), { exitOnCtrlC: false });
}
