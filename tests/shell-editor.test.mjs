// shell-editor.test.mjs — the operator SHELL EDITOR's testable logic layers (server /
// input / commands). The Ink view (src/shell/app.mjs) is TTY-bound and NOT unit-tested;
// these three pure/near-pure modules carry all the logic it delegates to.
//
// The editor is the WS SERVER on 23375; the spine's shell-port limb dials INTO it as a
// client. So the server test uses a REAL `ws` client as the FAKE SPINE against a REAL
// server on an EPHEMERAL port — the most faithful check of the frame protocol
// (src/bridges/shell-port.mjs): editor→spine `{ text }`, spine→editor `{ text, chatId }`.
//
// Reproduce-first gates (written to FAIL before the modules exist, then pass):
//   1. server: a fake spine connects → onSpineMessage fires with parsed {text, chatId};
//      send('hi') pushes {text:'hi'} to the client; send with no client drops (false, no throw).
//   2. input reducer: the d53a947 cursor-advance fix (insert advances col+chunk, not to
//      chunk length); multi-line paste splices + lands the cursor at the last line's end;
//      Ctrl+A/E move to line bounds; backspace joins lines.
//   3. commands router: /theme|/clear|/exit are editor-local actions; everything else forwards.
import { describe, it, expect, afterEach } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createShellServer } from '../src/shell/server.mjs';
import * as edit from '../src/shell/input.mjs';
import { routeCommand } from '../src/shell/commands.mjs';

async function waitFor(pred, ms = 1000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('shell editor — WS server (fake spine over a real socket)', () => {
  const cleanups = [];
  afterEach(() => { for (const c of cleanups.splice(0)) try { c(); } catch {} });

  it('a spine frame reaches onSpineMessage; send() pushes {text} back; send with no client drops', async () => {
    const server = createShellServer({ port: 0 });
    const wss = server.start();
    cleanups.push(() => server.stop());
    await once(wss, 'listening');
    const { port } = wss.address();

    // No client connected yet → send drops without throwing.
    expect(() => server.send('nobody-here')).not.toThrow();
    expect(server.send('nobody-here')).toBe(false);

    // The fake spine dials in (mirrors shell-port dialing OUT to the editor).
    const spine = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => spine.close());
    const inbound = [];
    server.onSpineMessage(m => inbound.push(m));
    await once(spine, 'open');
    await waitFor(() => server.isConnected);

    // spine → editor: `{ text, chatId }` (the outbound shape shell-port.send emits).
    spine.send(JSON.stringify({ text: 'from-spine', chatId: 'main' }));
    await waitFor(() => inbound.length > 0);
    expect(inbound[0]).toEqual({ text: 'from-spine', chatId: 'main' });

    // editor → spine: server.send('hi') pushes `{ text:'hi' }` (MVP single console).
    const framed = once(spine, 'message');
    expect(server.send('hi')).toBe(true);
    const [buf] = await framed;
    expect(JSON.parse(buf.toString())).toEqual({ text: 'hi' });
  });
});

describe('shell editor — input reducer (multi-line compose)', () => {
  it('single-char inserts advance the cursor forward (d53a947: "hello" not "holle")', () => {
    let s = edit.empty();
    for (const ch of 'hello') s = edit.insert(s, ch);
    expect(edit.text(s)).toBe('hello');
    expect(s.col).toBe(5);
  });

  it('mid-line insert splices at the cursor and advances col (not to chunk length)', () => {
    let s = { lines: ['hlo'], row: 0, col: 1 };   // cursor after 'h'
    s = edit.insert(s, 'e');                        // 'helo', col 2
    s = edit.insert(s, 'l');                        // 'hello', col 3
    expect(s.lines[0]).toBe('hello');
    expect(s.col).toBe(3);
  });

  it('multi-line paste splices and lands the cursor at the end of the last pasted line', () => {
    const s = edit.insert(edit.empty(), 'foo\nbar\nbaz');
    expect(s.lines).toEqual(['foo', 'bar', 'baz']);
    expect(s.row).toBe(2);
    expect(s.col).toBe(3);
  });

  it('Ctrl+A / Ctrl+E move to line bounds', () => {
    const base = { lines: ['abcd'], row: 0, col: 2 };
    expect(edit.home(base).col).toBe(0);
    expect(edit.end(base).col).toBe(4);
  });

  it('backspace at col 0 joins the line into the previous one', () => {
    const s = edit.backspace({ lines: ['ab', 'cd'], row: 1, col: 0 });
    expect(s.lines).toEqual(['abcd']);
    expect(s.row).toBe(0);
    expect(s.col).toBe(2);
  });
});

describe('shell editor — commands router', () => {
  it('/theme next → local theme action (no forward)', () => {
    expect(routeCommand('/theme next')).toEqual({ action: 'theme', arg: 'next' });
  });
  it('/clear → local clear action', () => {
    expect(routeCommand('/clear')).toEqual({ action: 'clear' });
  });
  it('/exit → local exit action', () => {
    expect(routeCommand('/exit')).toEqual({ action: 'exit' });
  });
  it('/status and plain text forward to the spine', () => {
    expect(routeCommand('/status')).toEqual({ action: 'forward', text: '/status' });
    expect(routeCommand('hello')).toEqual({ action: 'forward', text: 'hello' });
  });
});
