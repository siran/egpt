// shell-editor.test.mjs — the operator SHELL EDITOR's testable logic layers (spine link /
// input / commands / history / delivery). The Ink view (src/shell/app.mjs) is TTY-bound and
// NOT unit-tested; these pure/near-pure modules carry all the logic it delegates to.
//
// DIRECTION (operator ruling 2026-08-26): the SPINE serves 23375 and holds it from boot; this
// EDITOR is the CLIENT that dials in and authenticates. So the transport tests use a REAL `ws`
// SERVER as the FAKE SPINE on an EPHEMERAL port — the most faithful check of the frame protocol
// (src/bridges/shell-port.mjs): editor→spine `{ text }`, spine→editor `{ text, chatId }`.
//
// Reproduce-first gates for the inversion (these FAIL on the serve-the-port code):
//   1. start() DIALS a spine — it binds nothing, and it announces itself over ingest so a spine
//      whose bind failed re-listens.
//   2. send() drops until the challenge has been ANSWERED — the spine discards a pre-auth
//      frame, so an "open but unauthenticated" socket must not look deliverable.
//   3. a spine that goes away arms a RECONNECT (the client-side backoff), not a re-listen.
// The other gates are unchanged:
//   4. input reducer: the d53a947 cursor-advance fix (insert advances col+chunk, not to
//      chunk length); multi-line paste splices + lands the cursor at the last line's end;
//      Ctrl+A/E move to line bounds; backspace joins lines.
//   5. commands router: /theme|/clear|/exit are editor-local actions; everything else forwards.
//   6. history buffer: ↑ walks back through submitted entries oldest-ward, ↓ walks forward
//      and restores the pre-navigation draft past the newest entry; both no-op (return null)
//      past their respective ends instead of wrapping or throwing.
//   7. delivery: notDeliveredMessage() renders a distinct, non-empty line for "never
//      connected" vs. "send failed while connected" so a dropped send is never silent.
import { describe, it, expect, afterEach } from 'vitest';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import { createSpineLink } from '../src/shell/spine-link.mjs';
import { challengeFrame, parseAuthFrame, authMac, newNonce } from '../src/shell/auth.mjs';
import { createShellPort } from '../src/bridges/shell-port.mjs';
import * as edit from '../src/shell/input.mjs';
import { routeCommand } from '../src/shell/commands.mjs';
import * as hist from '../src/shell/history.mjs';
import { notDeliveredMessage } from '../src/shell/delivery.mjs';

const TOKEN = 'test-shell-token';

async function waitFor(pred, ms = 1000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 5));
  }
}

// A no-op fs seam for the ingest announce — keeps every test hermetic (no real ~/.egpt
// write), since createSpineLink drops a marker on start() by default.
function fakeIo() { return { mkdir: async () => {}, writeFile: async () => {}, rename: async () => {} }; }

// A fake clock for the RECONNECT backoff — SAME recording-and-manually-firing idiom
// tests/shell-port.test.mjs's makeFakeClock() uses, so no test waits out a real 3s-60s delay.
function makeFakeClock() {
  const timers = [];
  const cleared = [];
  const setTimeout = (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, ms }); return id; };
  const clearTimeout = (id) => { cleared.push(id); };
  return { timers, cleared, setTimeout, clearTimeout };
}

// A REAL `ws` server standing in for the spine: it challenges every client exactly as
// src/bridges/shell-port.mjs does, and records what the editor pushed back. `challenge: false`
// models a spine that accepted the socket but has not (yet) challenged — the window in which
// the editor is open but NOT trusted, and everything it pushes would be discarded.
function fakeSpine({ challenge = true } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const state = { wss, sockets: [], received: [], nonces: [] };
  wss.on('connection', (ws) => {
    state.sockets.push(ws);
    ws.on('message', (b) => state.received.push(b.toString()));
    if (!challenge) return;
    const nonce = newNonce();
    state.nonces.push(nonce);
    ws.send(challengeFrame(nonce));
  });
  return state;
}

describe('shell editor — WS client link to the spine (fake spine over a real socket)', () => {
  const cleanups = [];
  afterEach(() => { for (const c of cleanups.splice(0)) try { c(); } catch {} });

  async function linked(opts = {}, spineOpts = {}) {
    const spine = fakeSpine(spineOpts);
    cleanups.push(() => spine.wss.close());
    await once(spine.wss, 'listening');
    const logs = [];
    const link = createSpineLink({
      url: `ws://127.0.0.1:${spine.wss.address().port}`, token: TOKEN, io: fakeIo(),
      onLog: (m) => logs.push(m), ...opts,
    });
    cleanups.push(() => link.stop());
    const inbound = [];
    link.onSpineMessage((m) => inbound.push(m));
    link.start();
    return { spine, link, inbound, logs };
  }

  it('a spine frame reaches onSpineMessage; send() pushes {text} back; send with no spine drops', async () => {
    const { spine, link, inbound } = await linked();

    // Not connected yet → send drops without throwing.
    expect(() => link.send('nobody-here')).not.toThrow();
    expect(link.send('nobody-here')).toBe(false);

    await waitFor(() => link.isConnected);            // ← the challenge has been ANSWERED

    // spine → editor: `{ text, chatId, streaming }` (the outbound shape shell-port emits —
    // `streaming` distinguishes a live ⏳ edit from a committed final; parse defaults it false).
    spine.sockets[0].send(JSON.stringify({ text: 'from-spine', chatId: 'main' }));
    await waitFor(() => inbound.length > 0);
    expect(inbound[0]).toEqual({ text: 'from-spine', chatId: 'main', streaming: false });

    // editor → spine: link.send('hi') pushes `{ text:'hi' }` (MVP single console).
    expect(link.send('hi')).toBe(true);
    await waitFor(() => spine.received.some((r) => r.includes('"hi"')));
    expect(JSON.parse(spine.received.at(-1))).toEqual({ text: 'hi' });
  });

  // REPRODUCE-FIRST for the inversion: an OPEN-but-unauthenticated socket is not deliverable.
  // The spine discards every pre-auth frame, so reporting "connected" there would turn a
  // dropped operator line into a silent loss instead of a loud not-delivered row.
  it('send() drops while the socket is open but the challenge has NOT been answered', async () => {
    const { spine, link } = await linked({}, { challenge: false });   // the spine never challenges
    await waitFor(() => spine.sockets.length > 0);    // the socket IS open…

    expect(link.isConnected).toBe(false);             // …but the link honestly reports itself down
    expect(link.send('into the void')).toBe(false);
    await new Promise((r) => setTimeout(r, 25));
    expect(spine.received).toHaveLength(0);           // and nothing was pushed at all
  });

  // THE GATE THIS LOCKS: `if (m.text || m.delete) onMsg?.(m)` used to DROP a header-only frame
  // (empty text, no delete) — exactly the shape shell-port's header push carries. Widened to
  // `if (m.text || m.delete || m.header != null)` — this is the single most likely way the
  // permanent-header feature silently does nothing, so it is verified explicitly here.
  it('a header-only spine frame ({ text: "", chatId, header }) reaches onSpineMessage — the widened gate, not dropped', async () => {
    const { spine, link, inbound } = await linked();
    await waitFor(() => link.isConnected);

    spine.sockets[0].send(JSON.stringify({ text: '', chatId: 'main', header: 'test-header' }));
    await waitFor(() => inbound.length > 0);
    expect(inbound[0]).toEqual({ text: '', chatId: 'main', streaming: false, header: 'test-header' });
  });

  it('announces itself into the ingest box on start — so a spine whose BIND failed re-listens (no real ~/.egpt write, io is faked)', async () => {
    const calls = { mkdir: [], writeFile: [], rename: [] };
    const io = {
      mkdir: async (dir) => { calls.mkdir.push(dir); },
      writeFile: async (path, data) => { calls.writeFile.push({ path, data }); },
      rename: async (from, to) => { calls.rename.push({ from, to }); },
    };
    await linked({ io });
    await waitFor(() => calls.rename.length > 0);   // announce() is fire-and-forget on start()

    expect(calls.writeFile).toHaveLength(1);
    expect(calls.writeFile[0].data).toBe('/shell-connect');
    expect(calls.writeFile[0].path.endsWith('.tmp')).toBe(true);   // temp name while writing
    const finalName = calls.rename[0].to.split(/[\\/]/).pop();
    expect(finalName.startsWith('.')).toBe(false);                // ingest sweep skips dotfiles
    expect(finalName.endsWith('.tmp')).toBe(false);                // ...and *.tmp
  });

  // REPRODUCE-FIRST: as the SERVER this end used to answer a dead listener with a re-listen.
  // As the CLIENT it must DIAL again instead — and back off, so a down spine cannot spin the
  // dial (or the log) every few ms.
  it('a spine that goes away arms a RECONNECT that dials again, backing off 3s → 6s', async () => {
    const clock = makeFakeClock();
    const { spine, link } = await linked({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    await waitFor(() => link.isConnected);

    spine.sockets[0].close();                                     // the spine drops this console
    await waitFor(() => clock.timers.length > 0);
    expect(clock.timers[0].ms).toBe(3_000);
    expect(link.isConnected).toBe(false);

    clock.timers[0].fn();                                         // the reconnect fires → dials again
    await waitFor(() => spine.sockets.length === 2);
    await waitFor(() => link.isConnected);                        // …and re-authenticates on the fresh socket

    spine.sockets[1].close();
    await waitFor(() => clock.timers.length === 2);
    expect(clock.timers[1].ms).toBe(3_000);                       // reset by the successful open in between
  });

  it('stop() never triggers a reconnect: the pending timer is cancelled and no further dial happens', async () => {
    const clock = makeFakeClock();
    const { spine, link } = await linked({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    await waitFor(() => link.isConnected);

    spine.sockets[0].close();
    await waitFor(() => clock.timers.length > 0);

    link.stop();
    expect(clock.cleared).toContain(clock.timers[0].id);          // the pending reconnect was cancelled
    expect(clock.timers).toHaveLength(1);                          // stop() itself schedules nothing new
    expect(link.isConnected).toBe(false);
  });
});

// ── THE PRE-MOUNT RACE (operator 2026-08-28) ────────────────────────────────────────────────
// MEASURED against the live spine: dial→open 8ms, open→challenge 1ms, answer→HEADER 1ms — the
// spine pushes its header-only frame ~10ms after the dial. egpt.mjs dials FIRST (deliberately,
// so the link starts as early as possible), THEN awaits listThemes() and mounts Ink, and
// app.mjs registers onSpineMessage from a useEffect — >100ms later. The frame therefore lands
// while `onMsg` is still null, and `onMsg?.(m)` made it vanish silently. The header is
// useState('') fed ONLY by a spine frame, so a dropped one left the shell header line BLANK
// until something called setHeader() again or the link reconnected — the "shell lags when
// connecting to spine" the operator reported. These tests model that order exactly: the frame
// arrives FIRST, the handler registers AFTER.
describe('shell editor — frames that land before the app registers a handler', () => {
  const cleanups = [];
  afterEach(() => { for (const c of cleanups.splice(0)) try { c(); } catch {} });

  // A spine that pushes the instant the editor's auth answer lands — shell-port.mjs's real
  // timing (its header push rides straight off the handshake). `framesFor(i)` supplies what the
  // i-th connection pushes, so the reconnect test can give the second socket different content.
  function eagerSpine(framesFor) {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const state = { wss, sockets: [], received: [] };
    wss.on('connection', (ws) => {
      const i = state.sockets.length;
      state.sockets.push(ws);
      let armed = true;
      ws.on('message', (b) => {
        state.received.push(b.toString());
        if (!armed) return;
        armed = false;                                    // push once, off the auth answer only
        for (const f of framesFor(i)) ws.send(JSON.stringify(f));
      });
      ws.send(challengeFrame(newNonce()));
    });
    return state;
  }

  // The WebSocket injection seam, wrapped to record every frame that reached the CLIENT socket.
  // Without it a pre-registration drop is invisible: there is no handler to observe, so a test
  // could not tell "not delivered yet" from "already dropped". Its listener is attached in the
  // constructor, i.e. BEFORE connect() attaches the link's own — so once `seen` has the frame,
  // the link has already had its chance at it.
  function spyWS(seen) {
    return class SpyWS extends WebSocket {
      constructor(...args) { super(...args); this.on('message', (b) => seen.push(b.toString())); }
    };
  }

  // Dial with NO handler registered — the state egpt.mjs is in between link.start() and Ink's
  // first useEffect.
  async function dialedButUnmounted(framesFor, opts = {}) {
    const seen = [];
    const spine = eagerSpine(framesFor);
    cleanups.push(() => spine.wss.close());
    await once(spine.wss, 'listening');
    const link = createSpineLink({
      url: `ws://127.0.0.1:${spine.wss.address().port}`, token: TOKEN, io: fakeIo(),
      WebSocket: spyWS(seen), ...opts,
    });
    cleanups.push(() => link.stop());
    link.start();
    return { spine, link, seen };
  }

  it('REPRODUCE-FIRST: a header-only frame that lands BEFORE onSpineMessage registers still reaches the handler', async () => {
    const { seen, link } = await dialedButUnmounted(() => [{ text: '', chatId: 'main', header: 'boot-header' }]);
    await waitFor(() => seen.some((s) => s.includes('boot-header')));   // it ARRIVED (pre-fix: dropped here)

    const inbound = [];
    link.onSpineMessage((m) => inbound.push(m));                        // …and only NOW does Ink mount
    expect(inbound).toEqual([{ text: '', chatId: 'main', streaming: false, header: 'boot-header' }]);
  });

  it('several early frames flush IN ORDER, oldest first', async () => {
    const { seen, link } = await dialedButUnmounted(() => [
      { text: 'one', chatId: 'main' },
      { text: 'two', chatId: 'main' },
      { text: '', chatId: 'main', header: 'boot-header' },
    ]);
    await waitFor(() => seen.some((s) => s.includes('boot-header')));

    const inbound = [];
    link.onSpineMessage((m) => inbound.push(m));
    expect(inbound.map((m) => m.text)).toEqual(['one', 'two', '']);
    expect(inbound.at(-1).header).toBe('boot-header');
  });

  // The bound: an editor that never mounts (or a spine that floods first) must not grow the
  // queue without limit. Past the cap the OLDEST goes, so the most RECENT state — the header,
  // the latest streaming line — is what survives to be flushed.
  it('past the cap the OLDEST frames are dropped, never the newest', async () => {
    const frames = Array.from({ length: 40 }, (_, i) => ({ text: `m${i + 1}`, chatId: 'main' }));
    const { seen, link } = await dialedButUnmounted(() => frames);
    await waitFor(() => seen.some((s) => s.includes('"m40"')));

    const inbound = [];
    link.onSpineMessage((m) => inbound.push(m));
    expect(inbound).toHaveLength(32);                                   // PENDING_MAX in spine-link.mjs
    expect(inbound[0].text).toBe('m9');                                 // m1..m8 evicted, oldest first
    expect(inbound.at(-1).text).toBe('m40');
  });

  // Across a RECONNECT the queue is DROPPED: what the previous socket pushed describes a spine
  // session that is over (its process may have restarted, wiping the state that frame reported),
  // and the fresh connection pushes its own header off its own handshake. Delivering the old one
  // would show the operator a stale header as if it were current.
  it('a RECONNECT drops what the PREVIOUS socket queued — only the fresh header is delivered', async () => {
    const clock = makeFakeClock();
    const { spine, link, seen } = await dialedButUnmounted(
      (i) => [{ text: '', chatId: 'main', header: i === 0 ? 'stale-header' : 'fresh-header' }],
      { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    );
    await waitFor(() => seen.some((s) => s.includes('stale-header')));

    spine.sockets[0].close();                                           // the spine goes away…
    await waitFor(() => clock.timers.length > 0);
    clock.timers[0].fn();                                               // …and the backoff dials again
    await waitFor(() => seen.some((s) => s.includes('fresh-header')));

    const inbound = [];
    link.onSpineMessage((m) => inbound.push(m));
    expect(inbound.map((m) => m.header)).toEqual(['fresh-header']);
  });
});

// ── THE EDITOR'S HALF OF THE HANDSHAKE (operator 2026-08-21) ────────────────────────────────
// The spine does not trust whatever dials 127.0.0.1:23375 — loopback is dialable by the
// sandboxed CLI accounts. So the editor must PROVE it holds the node's shell token: the spine
// sends a nonce, this client answers HMAC-SHA256(token, nonce) (src/shell/auth.mjs, the same
// module the limb runs).
describe('shell editor — the client answers the spine auth challenge', () => {
  const cleanups = [];
  afterEach(() => { for (const c of cleanups.splice(0)) try { c(); } catch {} });

  async function linked(opts = {}) {
    const spine = fakeSpine();
    cleanups.push(() => spine.wss.close());
    await once(spine.wss, 'listening');
    const logs = [];
    const link = createSpineLink({
      url: `ws://127.0.0.1:${spine.wss.address().port}`, io: fakeIo(), onLog: (m) => logs.push(m), ...opts,
    });
    cleanups.push(() => link.stop());
    const inbound = [];
    link.onSpineMessage((m) => inbound.push(m));
    link.start();
    await waitFor(() => spine.sockets.length > 0);
    return { spine, link, inbound, logs };
  }

  it('REPRODUCE-FIRST: the challenge is answered with the right MAC — and is NEVER surfaced as a transcript line', async () => {
    const { spine, inbound } = await linked({ token: TOKEN });
    await waitFor(() => spine.received.length > 0);

    // The proof, computed independently here — and the token itself never rode the wire.
    expect(parseAuthFrame(spine.received[0])).toEqual({ auth: 'response', nonce: '', mac: authMac(TOKEN, spine.nonces[0]) });
    expect(spine.received[0]).not.toContain(TOKEN);

    // Pre-fix, the challenge fell through parse() and reached the app as a bare text row —
    // the operator would have seen raw handshake JSON printed in the transcript.
    expect(inbound).toHaveLength(0);

    // …and ordinary traffic still flows exactly as before.
    spine.sockets[0].send(JSON.stringify({ text: 'from-spine', chatId: 'main' }));
    await waitFor(() => inbound.length > 0);
    expect(inbound[0]).toEqual({ text: 'from-spine', chatId: 'main', streaming: false });
  });

  it('FAIL CLOSED with no token: the challenge goes unanswered and the log says exactly what to add', async () => {
    const { spine, link, logs, inbound } = await linked();       // no token configured
    await waitFor(() => logs.some((m) => /FAIL/.test(m)));
    await new Promise((r) => setTimeout(r, 25));                  // give any (wrong) answer time to land

    expect(spine.received).toHaveLength(0);                       // nothing to authenticate with → nothing sent
    expect(link.isConnected).toBe(false);                         // …and the link knows it is not usable
    expect(inbound).toHaveLength(0);                              // and still never a transcript row
    const log = logs.join('\n');
    expect(log).toMatch(/FAIL/);                                  // worded so egpt.mjs's fault filter surfaces it
    expect(log).toMatch(/shell:/);
    expect(log).toMatch(/token:/);
    expect(log).toMatch(/config\.yaml/);
  });
});

// END TO END over a REAL loopback socket: the real spine limb (SERVER) and the real editor link
// (CLIENT), the pair that actually runs in production. The unit tests either fake the limb's
// listener or use a raw server as the fake spine; only this one proves the two halves agree on
// the wire, in the new direction.
describe('spine limb ↔ shell editor — the real pair over a real socket', () => {
  const cleanups = [];
  afterEach(() => { for (const c of cleanups.splice(0)) try { c(); } catch {} });

  // The limb binds an EPHEMERAL port here (reapPort's own port===0 guard makes the port-kill a
  // no-op), and the editor is pointed at whatever it got.
  async function realPair(linkOpts = {}) {
    const port = createShellPort({ port: 0, token: TOKEN, header: 'test-header' });
    cleanups.push(() => port.stop());
    const wss = port.start();
    await once(wss, 'listening');
    const inbound = [];
    port.onMessage((msg) => inbound.push(msg));
    const logs = [];
    const link = createSpineLink({
      url: `ws://127.0.0.1:${wss.address().port}`, token: TOKEN, io: fakeIo(),
      onLog: (m) => logs.push(m), setTimeout: () => 0, clearTimeout: () => {},   // no real reconnect wait
      ...linkOpts,
    });
    cleanups.push(() => link.stop());
    link.onSpineMessage((m) => inbound.push(m));
    link.start();
    return { port, link, inbound, logs };
  }

  it('matching tokens: the editor authenticates, then frames flow both ways', async () => {
    const { port, link, inbound } = await realPair();

    await waitFor(() => port.isConnected);                        // ← the handshake completed, spine side
    await waitFor(() => link.isConnected);                        // ← …and the editor knows it answered
    await waitFor(() => inbound.some((m) => m.header === 'test-header'));   // the deferred header landed
    expect(link.send('hola')).toBe(true);
    await waitFor(() => inbound.some((m) => m.body === 'hola'));   // editor → spine
    expect(port.send('main', 'reply')).toBe(true);                 // spine → editor
    await waitFor(() => inbound.some((m) => m.text === 'reply'));
  });

  // Exactly the impostor shape, now from the other side: a process that is not the editor dials
  // the spine's console port and pushes a lifecycle command at it. It cannot answer the
  // challenge, so nothing it says is ever dispatched and it is dropped — while the spine keeps
  // serving and the REAL editor still gets in afterwards.
  it('REPRODUCE-FIRST: an IMPOSTOR client with the wrong token gets NOTHING through, and the console stays served', async () => {
    const logs = [];
    const port = createShellPort({ port: 0, token: TOKEN, onLog: (m) => logs.push(m) });
    cleanups.push(() => port.stop());
    const wss = port.start();
    await once(wss, 'listening');
    const delivered = [];
    port.onMessage((msg) => delivered.push(msg));

    // A RAW client, not the editor module: it pushes a lifecycle command unsolicited (pre-auth)
    // and then a guessed answer — the exact order a squatter would try.
    const impostor = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
    cleanups.push(() => impostor.close());
    const seenByImpostor = [];
    impostor.on('message', (b) => seenByImpostor.push(b.toString()));
    await once(impostor, 'open');
    impostor.send(JSON.stringify({ text: '/upgrade', chatId: 'main' }));
    impostor.send(JSON.stringify({ auth: 'response', mac: 'f'.repeat(64) }));

    await waitFor(() => logs.some((m) => /FAILED THE AUTH CHALLENGE/.test(m)));
    // It only ever saw the challenge — no header, no reply, no token.
    expect(seenByImpostor.every((a) => JSON.parse(a).auth === 'challenge')).toBe(true);
    expect(seenByImpostor.join('')).not.toContain(TOKEN);
    expect(delivered).toHaveLength(0);            // `/upgrade` never reached the spine
    expect(port.isConnected).toBe(false);         // it never counted as a console seat

    // …and the listener survived it: the real editor walks straight in.
    const real = createSpineLink({
      url: `ws://127.0.0.1:${wss.address().port}`, token: TOKEN, io: fakeIo(),
      setTimeout: () => 0, clearTimeout: () => {},
    });
    cleanups.push(() => real.stop());
    real.start();
    await waitFor(() => port.isConnected);
    real.send('hola');
    await waitFor(() => delivered.some((m) => m.body === 'hola'));
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
