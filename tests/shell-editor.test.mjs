// shell-editor.test.mjs — the operator SHELL EDITOR's testable logic layers (server /
// input / commands / history / delivery). The Ink view (src/shell/app.mjs) is TTY-bound and
// NOT unit-tested; these pure/near-pure modules carry all the logic it delegates to.
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
//   4. history buffer: ↑ walks back through submitted entries oldest-ward, ↓ walks forward
//      and restores the pre-navigation draft past the newest entry; both no-op (return null)
//      past their respective ends instead of wrapping or throwing.
//   5. delivery: notDeliveredMessage() renders a distinct, non-empty line for "never
//      connected" vs. "send failed while connected" so a dropped send is never silent.
import { describe, it, expect, afterEach } from 'vitest';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import { createShellServer } from '../src/shell/server.mjs';
import * as edit from '../src/shell/input.mjs';
import { routeCommand } from '../src/shell/commands.mjs';
import * as hist from '../src/shell/history.mjs';
import { notDeliveredMessage } from '../src/shell/delivery.mjs';

async function waitFor(pred, ms = 1000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 5));
  }
}

// A no-op fs seam for the ingest announce — keeps every test hermetic (no real ~/.egpt
// write), since createShellServer now drops a marker on 'listening' by default.
function fakeIo() { return { mkdir: async () => {}, writeFile: async () => {}, rename: async () => {} }; }

describe('shell editor — WS server (fake spine over a real socket)', () => {
  const cleanups = [];
  afterEach(() => { for (const c of cleanups.splice(0)) try { c(); } catch {} });

  it('a spine frame reaches onSpineMessage; send() pushes {text} back; send with no client drops', async () => {
    const server = createShellServer({ port: 0, io: fakeIo() });
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

    // spine → editor: `{ text, chatId, streaming }` (the outbound shape shell-port emits now —
    // `streaming` distinguishes a live ⏳ edit from a committed final; parse defaults it false).
    spine.send(JSON.stringify({ text: 'from-spine', chatId: 'main' }));
    await waitFor(() => inbound.length > 0);
    expect(inbound[0]).toEqual({ text: 'from-spine', chatId: 'main', streaming: false });

    // editor → spine: server.send('hi') pushes `{ text:'hi' }` (MVP single console).
    const framed = once(spine, 'message');
    expect(server.send('hi')).toBe(true);
    const [buf] = await framed;
    expect(JSON.parse(buf.toString())).toEqual({ text: 'hi' });
  });

  // THE GATE THIS LOCKS: `if (m.text || m.delete) onMsg?.(m)` used to DROP a header-only frame
  // (empty text, no delete) — exactly the shape shell-port's header push carries. Widened to
  // `if (m.text || m.delete || m.header != null)` — this is the single most likely way the
  // permanent-header feature silently does nothing, so it is verified explicitly here.
  it('a header-only spine frame ({ text: "", chatId, header }) reaches onSpineMessage — the widened gate, not dropped', async () => {
    const server = createShellServer({ port: 0, io: fakeIo() });
    const wss = server.start();
    cleanups.push(() => server.stop());
    await once(wss, 'listening');
    const { port } = wss.address();

    const spine = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => spine.close());
    const inbound = [];
    server.onSpineMessage(m => inbound.push(m));
    await once(spine, 'open');
    await waitFor(() => server.isConnected);

    spine.send(JSON.stringify({ text: '', chatId: 'main', header: 'test-header' }));
    await waitFor(() => inbound.length > 0);
    expect(inbound[0]).toEqual({ text: '', chatId: 'main', streaming: false, header: 'test-header' });
  });

  it('announces itself into the ingest box once listening — so the spine pokes in immediately (no real ~/.egpt write, io is faked)', async () => {
    const calls = { mkdir: [], writeFile: [], rename: [] };
    const io = {
      mkdir: async (dir) => { calls.mkdir.push(dir); },
      writeFile: async (path, data) => { calls.writeFile.push({ path, data }); },
      rename: async (from, to) => { calls.rename.push({ from, to }); },
    };
    const server = createShellServer({ port: 0, io });
    const wss = server.start();
    cleanups.push(() => server.stop());
    await once(wss, 'listening');
    await waitFor(() => calls.rename.length > 0);   // announce() is fire-and-forget on 'listening'

    expect(calls.writeFile).toHaveLength(1);
    expect(calls.writeFile[0].data).toBe('/shell-connect');
    expect(calls.writeFile[0].path.endsWith('.tmp')).toBe(true);   // temp name while writing
    const finalName = calls.rename[0].to.split(/[\\/]/).pop();
    expect(finalName.startsWith('.')).toBe(false);                // ingest sweep skips dotfiles
    expect(finalName.endsWith('.tmp')).toBe(false);                // ...and *.tmp
  });
});

// A fake clock for the re-listen backoff — SAME recording-and-manually-firing idiom
// tests/shell-port.test.mjs's makeFakeClock() uses for its reconnect backoff, so no test
// waits out a real 3s-60s delay.
function makeFakeClock() {
  const timers = [];
  const cleared = [];
  const setTimeout = (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, ms }); return id; };
  const clearTimeout = (id) => { cleared.push(id); };
  return { timers, cleared, setTimeout, clearTimeout };
}

// THE BUG THIS LOCKS (operator, tonight): the wss listener died twice with zero logging and
// zero recovery — server.mjs registered 'listening'/'connection'/'error' on wss but never
// 'close', so an unexpectedly-closed listener just sat dead until the process was restarted.
// These close the underlying wss DIRECTLY (not via server.stop()) to simulate that unexpected
// death, on a REAL `ws` server/client pair (same style as the describe block above) with an
// INJECTED fake clock so no test waits out the real 3s-60s backoff.
describe('shell editor — WS server: unexpected wss close is logged and recovered (not via stop())', () => {
  const cleanups = [];
  afterEach(() => { for (const c of cleanups.splice(0)) try { c(); } catch {} });

  it('an unexpected close is logged loudly, then the server re-listens (backoff fired manually) and accepts a fresh connection', async () => {
    const clock = makeFakeClock();
    const logs = [];
    const server = createShellServer({
      port: 0, io: fakeIo(), onLog: (m) => logs.push(m),
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    const wss1 = server.start();
    cleanups.push(() => server.stop());
    await once(wss1, 'listening');

    wss1.close();   // simulate the unexpected death — NOT server.stop()
    await waitFor(() => clock.timers.length > 0);
    expect(logs.some((m) => /closed/i.test(m))).toBe(true);        // logged loudly, unambiguous wording
    expect(clock.timers[0].ms).toBe(3_000);                        // RECONNECT_MIN_MS

    clock.timers[0].fn();                                          // fire the fake timer — re-listen attempt
    const wss2 = server.wss;
    expect(wss2).not.toBe(wss1);                                   // a fresh WebSocketServer was bound
    await once(wss2, 'listening');
    const { port } = wss2.address();

    const spine = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => spine.close());
    await once(spine, 'open');
    await waitFor(() => server.isConnected);
    expect(server.isConnected).toBe(true);                          // a fresh connection succeeds post-recovery
  });

  it('server.stop() never triggers a re-listen: the pending timer is cancelled and no second WebSocketServer is built', async () => {
    let constructCount = 0;
    class CountingWSS extends WebSocketServer {
      constructor(opts) { super(opts); constructCount++; }
    }
    const clock = makeFakeClock();
    const server = createShellServer({
      port: 0, io: fakeIo(), WebSocketServer: CountingWSS,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    const wss1 = server.start();
    cleanups.push(() => server.stop());
    await once(wss1, 'listening');
    expect(constructCount).toBe(1);

    wss1.close();                                                  // unexpected close → schedules a re-listen
    await waitFor(() => clock.timers.length > 0);
    expect(clock.timers).toHaveLength(1);

    server.stop();                                                 // deliberate shutdown
    expect(clock.cleared).toContain(clock.timers[0].id);           // the pending re-listen timer was cancelled
    expect(clock.timers).toHaveLength(1);                          // stop() itself schedules nothing new
    expect(constructCount).toBe(1);                                // no re-listen attempt → no second wss built
  });

  it('repeated unexpected closes back off exponentially: first retry at RECONNECT_MIN_MS, second retry doubles', async () => {
    const clock = makeFakeClock();
    const server = createShellServer({
      port: 0, io: fakeIo(),
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    const wss1 = server.start();
    cleanups.push(() => server.stop());
    await once(wss1, 'listening');

    wss1.close();
    await waitFor(() => clock.timers.length === 1);
    expect(clock.timers[0].ms).toBe(3_000);                        // RECONNECT_MIN_MS

    clock.timers[0].fn();                                          // fires the re-listen attempt synchronously
    const wss2 = server.wss;
    expect(wss2).not.toBe(wss1);
    wss2.close();                                                  // the re-listened server ALSO closes, before
                                                                    // ever reaching 'listening' (backoff must NOT
                                                                    // have been reset by this attempt)
    await waitFor(() => clock.timers.length === 2);
    expect(clock.timers[1].ms).toBe(6_000);                        // doubled (caps at RECONNECT_MAX_MS = 60_000)
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

  // Bare help — WHOLE-LINE only. Loose/prefix matching would swallow bare-handle-addressed
  // messages like "help me write this email" as a help request instead of forwarding them.
  it('bare h / help / ? (the ENTIRE trimmed line, nothing else) forward as /help', () => {
    expect(routeCommand('h')).toEqual({ action: 'forward', text: '/help' });
    expect(routeCommand('help')).toEqual({ action: 'forward', text: '/help' });
    expect(routeCommand('?')).toEqual({ action: 'forward', text: '/help' });
    expect(routeCommand('  help  ')).toEqual({ action: 'forward', text: '/help' });   // trims first
  });

  it('help as anything other than the whole line forwards VERBATIM, not as /help', () => {
    expect(routeCommand('help me write this email')).toEqual({ action: 'forward', text: 'help me write this email' });
    expect(routeCommand('h everyone')).toEqual({ action: 'forward', text: 'h everyone' });
    expect(routeCommand('??')).toEqual({ action: 'forward', text: '??' });
  });
});

describe('shell editor — composer gutter (source guard; app.mjs is TTY-bound, not renderable in vitest)', () => {
  it('continuation lines carry a two-space pad, never a "| " gutter', () => {
    const src = readFileSync(new URL('../src/shell/app.mjs', import.meta.url), 'utf8');
    const line = src.split('\n').find((l) => l.includes("i === 0 ? '> '"));
    expect(line).toBeTruthy();
    expect(line).toContain("i === 0 ? '> ' : '  '");
    expect(line).not.toContain("'| '");
  });
});

// THE PERMANENT SHELL HEADER (operator 2026-07-27; source guard, same rationale as the gutter
// guard above — app.mjs is TTY-bound and not renderable in vitest). Two things locked:
//   (a) the old scroll-away greeting line is GONE — the permanent header replaces it.
//   (b) a Box rendering the header exists ABOVE <Static> in the returned Fragment, so it
//       never scrolls with the transcript.
describe('shell editor — permanent header (source guard)', () => {
  const src = readFileSync(new URL('../src/shell/app.mjs', import.meta.url), 'utf8');

  it('the old scroll-away greeting ("egpt shell ready…") is gone', () => {
    expect(src).not.toContain('egpt shell ready');
  });

  it('a header Box renders ABOVE <Static> in the returned Fragment', () => {
    const returnBlock = src.slice(src.indexOf('return h(Fragment, null,'));
    const headerIdx = returnBlock.indexOf('T.statusBrand');
    const staticIdx = returnBlock.indexOf('h(Static,');
    expect(headerIdx).toBeGreaterThan(-1);
    expect(staticIdx).toBeGreaterThan(-1);
    expect(headerIdx).toBeLessThan(staticIdx);
  });
});

// A STUCK LIVE LINE after a spine restart (operator 2026-07-28; source guard, same rationale
// as the guards above). A header-only frame rides on EVERY (re)connect and is the one signal
// guaranteed to fire when the spine's in-memory `awaiting` map is wiped by a restart, so the
// live-clearing must live INSIDE (or unconditionally reachable from) the `m.header != null`
// branch, and BEFORE the early return that a header-only frame (no text/streaming/delete)
// otherwise trips — else a live line left over from before the restart is never cleared.
describe('shell editor — reconnect clears a stuck live line (source guard)', () => {
  const src = readFileSync(new URL('../src/shell/app.mjs', import.meta.url), 'utf8');

  it('the header branch itself calls setLive, clearing any stuck live line', () => {
    const headerIdx = src.indexOf('if (m.header != null) {');
    expect(headerIdx).toBeGreaterThan(-1);
    const earlyReturnIdx = src.indexOf('if (!m.text && !m.streaming && !m.delete) return;');
    expect(earlyReturnIdx).toBeGreaterThan(-1);
    const headerBlock = src.slice(headerIdx, earlyReturnIdx);
    expect(headerBlock).toContain('setLive(prev =>');
    // the header branch (and its setLive call) must appear BEFORE the early return, since a
    // header-only frame trips that early return and must not skip the live-clearing above it.
    expect(headerIdx).toBeLessThan(earlyReturnIdx);
  });

  it('the dropped-reply system row is gated on a truthy previous live line, not unconditional', () => {
    const rowIdx = src.indexOf("add('system', 'spine reconnected — a pending reply was dropped')");
    expect(rowIdx).toBeGreaterThan(-1);
    const guardIdx = src.lastIndexOf('if (prev)', rowIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    // the guard must sit directly before the add() call, not somewhere unrelated earlier in the file.
    expect(rowIdx - guardIdx).toBeLessThan(40);
  });
});

describe('shell editor — history buffer (↑/↓ recall)', () => {
  it('up() with no entries is a no-op (null)', () => {
    expect(hist.up(hist.empty(), 'draft')).toBeNull();
  });

  it('down() when not navigating is a no-op (null)', () => {
    expect(hist.down(hist.empty())).toBeNull();
  });

  it('↑ walks back oldest-ward through submitted entries, newest first', () => {
    let h = hist.empty();
    h = hist.push(h, 'first');
    h = hist.push(h, 'second');

    const r1 = hist.up(h, 'unsent draft');
    expect(r1.text).toBe('second');       // most recent entry first
    const r2 = hist.up(r1.state, 'unsent draft');
    expect(r2.text).toBe('first');         // then the older one
    expect(hist.up(r2.state, 'unsent draft')).toBeNull();   // nothing older than the oldest
  });

  it('↓ walks forward and restores the pre-navigation draft past the newest entry', () => {
    let h = hist.empty();
    h = hist.push(h, 'first');
    h = hist.push(h, 'second');

    const up1 = hist.up(h, 'my draft');   // → 'second', captures 'my draft'
    const down1 = hist.down(up1.state);
    expect(down1.text).toBe('my draft');   // walked past the newest entry → draft restored
    expect(down1.state.cursor).toBeNull();
  });

  it('push() ends navigation and starts a fresh round', () => {
    let h = hist.empty();
    h = hist.push(h, 'a');
    const up1 = hist.up(h, 'b-in-progress');
    h = hist.push(up1.state, 'b');   // submitting while mid-navigation
    expect(h.entries).toEqual(['a', 'b']);
    expect(h.cursor).toBeNull();
  });
});

describe('shell editor — delivery-failure notice', () => {
  it('renders a distinct, non-empty line for each cause and never silently drops', () => {
    const neverConnected = notDeliveredMessage(false);
    const failedWhileConnected = notDeliveredMessage(true);
    expect(neverConnected).toMatch(/not delivered/i);
    expect(failedWhileConnected).toMatch(/not delivered/i);
    expect(neverConnected).not.toBe(failedWhileConnected);
  });
});
