// shell-port.test.mjs — the operator-console LIMB, unit-tested with a FAKE `ws` SERVER and
// fake client sockets — no real socket, no real timers, no real port bind.
//
// DIRECTION (operator ruling 2026-08-26): the limb is now the WebSocket SERVER. It binds
// 127.0.0.1:23375 at boot and HOLDS it; the external editor is the CLIENT that dials in and
// proves it holds the node's shell token. An editor text frame becomes an inbound event on the
// `shell` surface handed to the SAME command dispatch the spine already runs, and the reply is
// pushed back over the same socket. Text in, text out.
//
// The reproduce-first gates for the inversion (these FAIL on the dial-out code):
//   1. start() BINDS a listener (and reaps the port first) instead of dialing a client socket.
//   2. a dropped editor does NOT arm a reconnect — the listener stays up and the next editor
//      to dial in takes the seat.
//   3. a second client CANNOT displace an authenticated seat, and is sent nothing at all.
import { describe, it, expect } from 'vitest';
import { createShellPort, SHELL_WS_PORT } from '../src/bridges/shell-port.mjs';
import { responseFrame, authMac } from '../src/shell/auth.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createCommands } from '../src/spine/commands.mjs';

// The node's shell token in these tests. EVERY started port needs one: with no token the
// limb fails closed and never binds at all (see the AUTHENTICATION block at the bottom).
const TOKEN = 'test-shell-token';

// A fake `ws` SERVER + client sockets: the injection seam the shell-port binds through. Each
// `new WebSocketServer(opts)` is captured so a test can drive its lifecycle (listening /
// connection / error / close), dial fake clients into it, and read what the limb pushed back —
// no real socket, ever.
//
// 'listening' (and, with `failBind`, 'error') fire SYNCHRONOUSLY at handler-registration time.
// The real `ws` emits them on a later tick, but bind() registers every handler in one straight
// line right after construction, so firing at registration is both faithful enough and keeps
// every assertion below free of awaits.
function makeFakeWss({ failBind = false } = {}) {
  const servers = [];
  class FakeSocket {
    constructor() { this.sent = []; this._h = {}; this.closed = false; this.readyState = 1; }
    on(ev, cb) { (this._h[ev] ||= []).push(cb); return this; }
    fire(ev, ...a) { for (const cb of (this._h[ev] || [])) cb(...a); }
    send(d) { if (this.closed) throw new Error('socket is closed'); this.sent.push(d); }
    close() { if (this.closed) return; this.closed = true; this.readyState = 3; this.fire('close'); }
  }
  class FakeWSS {
    constructor(opts) { this.opts = opts; this._h = {}; this.closed = false; this.listening = false; servers.push(this); }
    on(ev, cb) {
      (this._h[ev] ||= []).push(cb);
      if (ev === 'listening' && !failBind) { this.listening = true; cb(); }
      if (ev === 'error' && failBind) cb(new Error('EADDRINUSE'));
      return this;
    }
    fire(ev, ...a) { for (const cb of (this._h[ev] || [])) cb(...a); }
    close() { if (this.closed) return; this.closed = true; this.listening = false; this.fire('close'); }
    // An editor (or an impostor) dials in.
    dial() { const ws = new FakeSocket(); this.fire('connection', ws); return ws; }
  }
  return { WebSocketServer: FakeWSS, servers };
}

// A fake clock for the RE-LISTEN backoff (the server-role recovery: a bind that failed or a
// listener that died). Records armed timers so a test can assert one was scheduled and fire it
// deterministically — no real wait blocks the suite.
function makeFakeClock() {
  const timers = [];
  const cleared = [];
  const setTimeout = (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, ms }); return id; };
  const clearTimeout = (id) => { cleared.push(id); };
  return { timers, cleared, setTimeout, clearTimeout };
}

// Construct a limb with the real port-killer REPLACED — every test must inject it, or a
// default-port construction would netstat/taskkill for real.
function mk(opts = {}) {
  return createShellPort({ token: TOKEN, reapPort: () => 0, ...opts });
}

// Dial a fake editor in AND pass the auth handshake — the editor's half of src/shell/auth.mjs,
// which is exactly what src/shell/spine-link.mjs does for real. Returns { ws, challenge }. The
// challenge frame is SHIFTED off `ws.sent`, so every assertion about what the limb pushed keeps
// counting from the first real frame.
function dialAuthed(server, token = TOKEN) {
  const ws = server.dial();
  const challenge = JSON.parse(ws.sent.shift());
  ws.fire('message', Buffer.from(responseFrame(token, challenge.nonce)));
  return { ws, challenge };
}

describe('shell-port limb', () => {
  it('exports the fixed console port (the spine SERVES it; the editor dials in)', () => {
    expect(SHELL_WS_PORT).toBe(23375);
  });

  // REPRODUCE-FIRST for the inversion: the limb must BIND, not dial. On the old dial-out code
  // there was no WebSocketServer seam at all and nothing was ever constructed here.
  it('start() reaps the port, then BINDS a listener on loopback — it never dials out', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const reapCalls = [];
    const port = createShellPort({ WebSocketServer, token: TOKEN, reapPort: (p) => { reapCalls.push(p); return 0; } });

    const wss = port.start();
    expect(servers).toHaveLength(1);
    expect(wss).toBe(servers[0]);
    expect(servers[0].opts).toMatchObject({ host: '127.0.0.1', port: SHELL_WS_PORT });
    expect(reapCalls).toEqual([SHELL_WS_PORT]);          // the squatter/stale holder is evicted FIRST
    expect(port.isConnected).toBe(false);                 // bound, but nobody is at the console yet
  });

  it('a `/status` frame from the editor reaches the REAL command dispatch → reply pushed back over the socket', async () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const port = mk({ WebSocketServer });

    // Wire the shell surface into the SAME dispatch the spine runs: identity builds the
    // event, commands intercepts the slash command, and its `send` is the limb's own
    // send-back (the reply rides the socket). git/fs probes are faked so /status is
    // hermetic (it degrades every unreachable probe to '?', never throws).
    const identity = createIdentity();
    const commands = createCommands({
      getConfig: () => ({}),
      send: (chatId, text) => port.send(chatId, text),
      gitOut: () => '',
      io: { stat: async () => { throw new Error('none'); }, readFile: async () => { throw new Error('none'); } },
    });
    let pending = Promise.resolve();
    port.onMessage(({ body, from }) => {
      pending = (async () => {
        const ev = identity.build({ body, from });
        if (commands.isCommand(ev)) await commands.run(ev);
      })();
      return pending;
    });

    port.start();
    const { ws } = dialAuthed(servers[0]);                        // editor connected + authenticated
    ws.fire('message', Buffer.from(JSON.stringify({ text: '/status' })));
    await pending;

    expect(ws.sent).toHaveLength(1);
    const frame = JSON.parse(ws.sent[0]);
    expect(frame.text).toContain('egpt:');                        // the /status yaml block
    expect(frame.text).toContain('pid:');
  });

  // REPRODUCE-FIRST: the dial-out limb answered a dropped editor by arming a reconnect timer.
  // A SERVER must arm nothing — it just keeps serving, and the next editor dials in.
  it('decouples from the editor: a dropped client does NOT throw, arms NO reconnect, and the listener keeps serving', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const clock = makeFakeClock();
    const port = mk({ WebSocketServer, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    // A message that would blow up if the limb ever routed a spine event on a dead editor —
    // proves the close path is inert toward the spine (no error propagated).
    port.onMessage(() => { throw new Error('spine must not be touched by a close'); });

    port.start();
    const { ws } = dialAuthed(servers[0]);
    expect(port.isConnected).toBe(true);

    expect(() => ws.close()).not.toThrow();               // editor quit → no crash
    expect(port.isConnected).toBe(false);                 // the seat is free again
    expect(clock.timers).toHaveLength(0);                 // …and NOTHING was armed: a server does not dial
    expect(servers).toHaveLength(1);                      // the SAME listener is still up
    expect(servers[0].closed).toBe(false);

    const next = dialAuthed(servers[0]);                  // a fresh editor takes the seat
    expect(port.isConnected).toBe(true);
    expect(port.send('main', 'hi')).toBe(true);
    expect(next.ws.sent).toHaveLength(1);
  });

  it('idle-when-absent: start() with no editor ever dialing in never crashes the boot path', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const clock = makeFakeClock();
    const port = mk({ WebSocketServer, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    expect(() => port.start()).not.toThrow();            // bound, nobody home
    expect(port.isConnected).toBe(false);
    expect(clock.timers).toHaveLength(0);                // a bound-and-quiet listener is the resting state
    expect(servers[0].listening).toBe(true);
  });

  describe('@e wakes E — the shell `from` carries the mention flags identity.build reads', () => {
    // THE BLOCKER: the shell built `from` WITHOUT atEStart/atEAnywhere, so a shell `@e` arrived
    // with the mention gate false → identity.build → E was never woken. The limb now runs the SAME
    // wake matcher (mentionStatus) the beeper bridge does, stamping the flags onto `from`. These
    // lock the `from` shape the shell hands the spine — the smallest surface that reproduces the bug.
    function fromFor(text, wakeWords, rest = {}) {
      const { WebSocketServer, servers } = makeFakeWss();
      const port = mk({ WebSocketServer, wakeWords, ...rest });
      let captured = null;
      port.onMessage(({ from }) => { captured = from; });
      port.start();
      const { ws } = dialAuthed(servers[0]);
      ws.fire('message', Buffer.from(text));
      return captured;
    }

    it('a bare-text "@e hi" frame → atEStart AND atEAnywhere true', () => {
      const from = fromFor('@e hi');
      expect(from.atEStart).toBe(true);
      expect(from.atEAnywhere).toBe(true);
    });

    it('"@e" mid-message → atEAnywhere true, atEStart false', () => {
      const from = fromFor('hey @e look');
      expect(from.atEAnywhere).toBe(true);
      expect(from.atEStart).toBe(false);
    });

    it('no wake word → both false (E stays gated out, as before — but now CORRECTLY, not by omission)', () => {
      const from = fromFor('hello');
      expect(from.atEAnywhere).toBe(false);
      expect(from.atEStart).toBe(false);
    });

    it('an @e inside a code fence does NOT wake — mentionStatus strips code, and it flows through the limb', () => {
      const from = fromFor('```\n@e in a fence\n```');
      expect(from.atEAnywhere).toBe(false);
      expect(from.atEStart).toBe(false);
    });

    it('a configured handle (@ed) wakes when passed in wakeWords; a bare @e does not (custom handles honored)', () => {
      expect(fromFor('@ed status', ['ed']).atEAnywhere).toBe(true);
      expect(fromFor('@e status', ['ed']).atEAnywhere).toBe(false);
    });

    // THE SWITCH reaches the persona gate the SAME way the wake list does: boot hands the limb
    // `addressWithoutAt` in the very options object that already carries `wakeWords`, and the limb
    // passes it straight into mentionStatus. (The beeper limb takes it identically — one option,
    // one forward, two limbs.) Default ON: a node that configures nothing keeps today's behaviour.
    it('REPRODUCE-FIRST: `addressWithoutAt: false` kills the bare handle at the limb; `@d` survives it', () => {
      const DOLLY = ['d', 'don'];
      expect(fromFor('d hola', DOLLY).atEStart).toBe(true);                        // default ON — live behaviour
      const off = fromFor('d hola', DOLLY, { addressWithoutAt: false });
      expect([off.atEStart, off.atEAnywhere]).toEqual([false, false]);
      const at = fromFor('@d hola', DOLLY, { addressWithoutAt: false });
      expect([at.atEStart, at.atEAnywhere]).toEqual([true, true]);
    });
  });

  describe('startStream — the reply STREAMS through the shell socket via the SAME wrap Beeper uses', () => {
    // ONE bridge path (operator 2026-07-25): the shell reply is no longer a degenerate
    // finish-only push. startStream mirrors beeper-port — it posts the ⏳ placeholder
    // immediately as a LIVE (streaming:true) frame, streams bare-stamped edits, and lands the
    // FULL concentric wrap (persona stamp + agent + bridge signatures) once, on the committed
    // final (streaming:false).
    function connected(opts = {}) {
      const { WebSocketServer, servers } = makeFakeWss();
      const port = mk({ WebSocketServer, ...opts });
      port.start();
      const { ws } = dialAuthed(servers[0]);
      return { port, sock: ws };
    }
    const frames = (sock) => sock.sent.map((s) => JSON.parse(s));

    it('startStream posts the ⏳ placeholder immediately as a LIVE (streaming:true) persona-stamped frame', () => {
      const { port, sock } = connected();
      port.startStream('main', '⏳ Thinking…', { bodyEmoji: '🐶', label: 'egpt', persona: 'e' });
      expect(sock.sent).toHaveLength(1);
      const f = frames(sock)[0];
      expect(f.streaming).toBe(true);
      expect(f.text).toBe('🐶 egpt ⏳ Thinking…');               // bare persona stamp on the placeholder
    });

    it('update() pushes live SIGNED frames; finish() commits ONE streaming:false frame carrying the same FULL wrap', () => {
      const { port, sock } = connected({ bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '💸' });
      const stream = port.startStream('main', '⏳ Thinking…', { bodyEmoji: '🐶', label: 'egpt', persona: 'e', agentSigOpen: '— e —', agentSigClose: '~ e' });
      stream.update('Hola ⏳');                                    // the sender supplies the ⏳ marker
      stream.finish('Hola mundo');
      const fs = frames(sock);
      // WAS: "live, bare stamp (NO sigs)". C13 (operator 2026-07-26) — a live frame is a message
      // on a surface, so it signs; the live/committed distinction is about REPLACEMENT, not signing.
      expect(fs[0]).toMatchObject({ streaming: true, text: '🌉kg — e — 🐶 egpt ⏳ Thinking… ~ e 💸' });
      expect(fs[1]).toMatchObject({ streaming: true, text: '🌉kg — e — 🐶 egpt Hola ⏳ ~ e 💸' });
      const final = fs[fs.length - 1];
      expect(final.streaming).toBe(false);
      // the ONE committed final: bridge_open, agent_open, CORE, agent_close, bridge_close
      expect(final.text).toBe('🌉kg — e — 🐶 egpt Hola mundo ~ e 💸');
      expect(fs.filter((f) => f.streaming === false)).toHaveLength(1);   // exactly one committed frame
      expect(stream.delivered).toBe(true);                       // → sender skips its §7 beeper fallback
    });

    // C13 (operator 2026-07-26): "bridge must sign. always. structurally." + "it should also sign
    // 'thinking... 💸|🌉'". The shell limb ran the SAME defect as the beeper limb (it runs the same
    // machinery): the ⏳ placeholder and every live edit went out bare-stamped, unsigned, and only
    // the committed final met the wrap. A live frame is still a frame a spine put on a surface.
    it('REPRODUCE-FIRST: placeholder → N updates → finish — EVERY frame signed, exactly once, final bytes unchanged', () => {
      const { port, sock } = connected({ bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '💸' });
      const stream = port.startStream('main', '⏳ Thinking…', { bodyEmoji: '🐶', label: 'egpt', persona: 'e', agentSigOpen: '— e —', agentSigClose: '~ e' });
      stream.update('Hola ⏳');
      stream.update('Hola mundo ⏳');
      stream.finish('Hola mundo');
      const fs = frames(sock);
      expect(fs[0]).toMatchObject({ streaming: true, text: '🌉kg — e — 🐶 egpt ⏳ Thinking… ~ e 💸' });
      expect(fs[1]).toMatchObject({ streaming: true, text: '🌉kg — e — 🐶 egpt Hola ⏳ ~ e 💸' });
      expect(fs[2]).toMatchObject({ streaming: true, text: '🌉kg — e — 🐶 egpt Hola mundo ⏳ ~ e 💸' });
      // settled bytes IDENTICAL to before the change
      expect(fs[3]).toMatchObject({ streaming: false, text: '🌉kg — e — 🐶 egpt Hola mundo ~ e 💸' });
      const count = (s, needle) => s.split(needle).length - 1;
      for (const f of fs) { expect(count(f.text, '🌉kg')).toBe(1); expect(count(f.text, '💸')).toBe(1); }
    });

    it('finish accepts a bare string too (the shape createSender actually calls it with)', () => {
      const { port, sock } = connected();
      port.startStream('main', '⏳', { bodyEmoji: '🐶', label: 'egpt' }).finish('done');
      const committed = frames(sock).filter((f) => f.streaming === false);
      expect(committed).toHaveLength(1);
      expect(committed[0].text).toBe('🐶 egpt done');
    });

    it('delete() clears the live line with a streaming:false delete frame — commits nothing', () => {
      const { port, sock } = connected();
      port.startStream('main', '⏳', { bodyEmoji: '🐶', label: 'egpt' }).delete();
      const del = frames(sock).find((f) => f.delete);
      expect(del).toBeTruthy();
      expect(del.streaming).toBe(false);
    });

    it('fail() surfaces an error line over the socket — NOT swallowed', () => {
      const { port, sock } = connected();
      const stream = port.startStream('main', '⏳', { bodyEmoji: '🐶', label: 'egpt' });
      stream.fail(new Error('boom'));
      const committed = frames(sock).filter((f) => f.streaming === false);
      expect(committed.some((f) => f.text.includes('boom'))).toBe(true);
      expect(stream.lastError).toContain('boom');
    });

    it('editor not connected: finish delivers nothing and delivered stays false (sender falls back), never throws', () => {
      const { WebSocketServer } = makeFakeWss();
      const port = mk({ WebSocketServer });
      port.start();                                               // bound, no editor dialed in
      const stream = port.startStream('main', '⏳', { bodyEmoji: '🐶', label: 'egpt' });
      expect(() => stream.finish('x')).not.toThrow();
      expect(stream.delivered).toBe(false);
    });

    // THE ECHO ASYMMETRY (operator 2026-07-25). A 👂 echo is a core with NO persona header, and the
    // shared wrap used to refuse those — so beeper.mjs carried its OWN copy of the layer stack
    // (`withEchoLayers`, deleted) to sign the beeper echo, and the shell, having no such copy, sent
    // an echo BARE. PRE-FIX, verbatim, with bridge BO/BC + transcription TO/TC configured:
    //     beeper (withEchoLayers): "BO\nTO\n👂 hola\nTC\nBC"
    //     shell   (shared wrap)  : "👂 hola"          ← unsigned
    // One path now: both render the SAME bytes (the beeper side is locked in
    // tests/beeper-bridge.test.mjs' 👂-echo wrap test, which did NOT change).
    it('a 👂 echo send is SIGNED on the shell too — byte-identical to the beeper echo render', () => {
      const { port, sock } = connected({ bridgeSignatureOpen: 'BO', bridgeSignatureClose: 'BC' });
      port.send('main', '👂 hola', { agentSigOpen: 'TO', agentSigClose: 'TC' });
      expect(frames(sock)[0].text).toBe('BO TO 👂 hola TC BC');
    });

    it('a plain system reply (/status) carries the node bridge layer too — signing is a property of the SEND', () => {
      const { port, sock } = connected({ bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '🌉' });
      port.send('main', 'node: kg\npeers: do');
      expect(frames(sock)[0].text).toBe('🌉kg node: kg\npeers: do 🌉');
    });
  });

  describe('postStatus — the mesh origin placeholder ("🤔 thinking…") must be a LIVE frame, not committed', () => {
    // THE BUG (operator, w/ screenshot): a shell-origin mesh relay (`@don`) shows TWO thinking
    // indicators, one of which never goes away. CAUSE: postStatus pushed its placeholder with
    // streaming:false — a COMMITTED line the shell can never replace (no editable msg id, unlike
    // Beeper) — then the reply's openOriginStream posted a SECOND, live placeholder that streams
    // into the real reply. The committed one is immortal. FIX: postStatus must push the SAME
    // primitive startStream already uses for its own placeholder — streaming:true — so the later
    // live frame REPLACES it in place instead of stacking a second one on top.
    it('REPRODUCE-FIRST: postStatus pushes a LIVE (streaming:true) frame and still returns null (no editable shell msg id)', () => {
      const { WebSocketServer, servers } = makeFakeWss();
      const port = mk({ WebSocketServer });
      port.start();
      const { ws: sock } = dialAuthed(servers[0]);

      const id = port.postStatus('main', '🤔 thinking…');

      expect(id).toBeNull();                              // unchanged: no addressable shell message id
      expect(sock.sent).toHaveLength(1);
      const frame = JSON.parse(sock.sent[0]);
      expect(frame.streaming).toBe(true);                 // LIVE — a later live frame replaces it in place
      expect(frame.text).toBe('🤔 thinking…');
    });

    // C13 (operator 2026-07-26). postStatus was the last unsigned text frame on this port, kept
    // that way because it is "an uncommitted live line on the operator's own console". That
    // argument died with the ruling that the ⏳ placeholder signs: the placeholder is the SAME
    // streaming:true primitive on the SAME surface. One rule for every frame.
    it('is SIGNED when the node configures a signature — the same live-frame rule as the ⏳ placeholder', () => {
      const { WebSocketServer, servers } = makeFakeWss();
      const port = mk({ WebSocketServer, bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '💸' });
      port.start();
      const { ws: sock } = dialAuthed(servers[0]);
      port.postStatus('main', '🤔 thinking…');
      const frame = JSON.parse(sock.sent[0]);
      expect(frame).toMatchObject({ streaming: true, text: '🌉kg 🤔 thinking… 💸' });
    });
  });

  describe('header — the PERMANENT status line (boot\'s computeShellHeader), pushed to every editor that takes the seat', () => {
    // THE REGRESSION THIS LOCKS: "a header that only ever sends once is blank forever after the
    // first reconnect". The header hooks the ONE place trust is granted, so the first editor, a
    // reconnecting editor, AND a replacement editor all get it — no separate "is this a
    // reconnect" tracking in boot.mjs.
    it('on a successful handshake, pushes a header-only frame (empty text, no delete) — a naive text/delete-only editor handler would not log it', () => {
      const { WebSocketServer, servers } = makeFakeWss();
      const port = mk({ WebSocketServer, header: 'test-header' });
      port.start();
      const { ws } = dialAuthed(servers[0]);

      expect(ws.sent).toHaveLength(1);
      const frame = JSON.parse(ws.sent[0]);
      expect(frame.header).toBe('test-header');
      expect(frame.text).toBe('');
      expect(frame.delete).toBeUndefined();
    });

    it('the NEXT editor to dial in (after the first drops) ALSO gets the header', () => {
      const { WebSocketServer, servers } = makeFakeWss();
      const port = mk({ WebSocketServer, header: 'test-header' });
      port.start();
      const first = dialAuthed(servers[0]);
      expect(JSON.parse(first.ws.sent[0]).header).toBe('test-header');

      first.ws.close();                          // editor drops → seat freed, listener untouched
      const second = dialAuthed(servers[0]);     // a fresh editor dials in
      expect(second.ws.sent).toHaveLength(1);
      expect(JSON.parse(second.ws.sent[0]).header).toBe('test-header');
    });

    it('no header option → no header frame ever sent on a handshake', () => {
      const { WebSocketServer, servers } = makeFakeWss();
      const port = mk({ WebSocketServer });
      port.start();
      const { ws } = dialAuthed(servers[0]);
      expect(ws.sent).toHaveLength(0);
    });
  });

  describe('setHeader() — live header update (operator 2026-08-16: /rooms join reflection)', () => {
    // REPRODUCE-FIRST: before setHeader existed, _header was a `const` captured once at
    // construction — there was no way for boot.mjs's onRoomChange to push an updated header
    // after boot, and no way for a LATER editor to carry anything but the original line.
    it('while connected: pushes a header-only frame immediately with the NEW header', () => {
      const { WebSocketServer, servers } = makeFakeWss();
      const port = mk({ WebSocketServer, header: 'lobby' });
      port.start();
      const { ws } = dialAuthed(servers[0]);
      expect(ws.sent).toHaveLength(1);   // the initial header, on the handshake

      port.setHeader('lobby → acim');
      expect(ws.sent).toHaveLength(2);
      const frame = JSON.parse(ws.sent[1]);
      expect(frame.header).toBe('lobby → acim');
      expect(frame.text).toBe('');
    });

    it('a LATER editor gets the UPDATED header, not the one captured at construction', () => {
      const { WebSocketServer, servers } = makeFakeWss();
      const port = mk({ WebSocketServer, header: 'lobby' });
      port.start();
      const first = dialAuthed(servers[0]);
      port.setHeader('lobby → acim');

      first.ws.close();
      const second = dialAuthed(servers[0]);
      expect(second.ws.sent).toHaveLength(1);
      expect(JSON.parse(second.ws.sent[0]).header).toBe('lobby → acim');   // NOT the original 'lobby'
    });

    it('while no editor holds the seat: drops (never throws), same as any other push', () => {
      const { WebSocketServer } = makeFakeWss();
      const port = mk({ WebSocketServer, header: 'lobby' });
      port.start();   // bound, nobody dialed in
      expect(() => port.setHeader('lobby → acim')).not.toThrow();
      expect(port.setHeader('lobby → acim')).toBe(false);
    });

    it('works even when no initial header option was given', () => {
      const { WebSocketServer, servers } = makeFakeWss();
      const port = mk({ WebSocketServer });
      port.start();
      const { ws } = dialAuthed(servers[0]);
      expect(ws.sent).toHaveLength(0);   // no initial header → nothing on the handshake

      port.setHeader('lobby → acim');
      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0]).header).toBe('lobby → acim');
    });
  });
});

// ── SINGLE SEAT, INCUMBENT HOLDS (operator ruling 2026-08-26) ────────────────────────────────
// As the SERVER the limb now decides what a second connection means. The seat is freed only by
// its own socket closing — it is never TAKEN. So neither an unauthenticated client nor a second
// holder of the token can displace an operator already at the console, and a refused editor is
// not stranded: its own reconnect backoff (src/shell/spine-link.mjs) retries, so it takes over
// the moment the seat frees.
describe('shell-port SEAT — a second connection cannot displace an authenticated editor', () => {
  it('REPRODUCE-FIRST: while the seat is held, a second client is closed immediately and sent NOTHING — not even a challenge', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const seen = [];
    const port = mk({ WebSocketServer, header: 'test-header' });
    port.onMessage((m) => seen.push(m));
    port.start();

    const seated = dialAuthed(servers[0]);
    expect(port.isConnected).toBe(true);

    const intruder = servers[0].dial();
    expect(intruder.sent).toHaveLength(0);          // no challenge → no way in, and no header leaked
    expect(intruder.closed).toBe(true);

    // The intruder cannot even TRY: whatever it pushes after being closed reaches nobody, and
    // the seat is untouched.
    intruder.fire('message', Buffer.from(JSON.stringify({ text: '/upgrade', chatId: 'main' })));
    expect(seen).toHaveLength(0);
    expect(port.isConnected).toBe(true);

    // …and the seated editor still owns the console.
    expect(port.send('main', 'still mine')).toBe(true);
    expect(JSON.parse(seated.ws.sent.at(-1)).text).toBe('still mine');
  });

  it('the seat is FREED by its own close, and the waiting editor then gets it (a refused client is not stranded)', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const port = mk({ WebSocketServer });
    port.start();

    const seated = dialAuthed(servers[0]);
    servers[0].dial();                              // refused while the seat is held
    seated.ws.close();
    expect(port.isConnected).toBe(false);

    const next = dialAuthed(servers[0]);            // the retrying editor now gets in
    expect(port.isConnected).toBe(true);
    expect(port.send('main', 'hello')).toBe(true);
    expect(next.ws.sent).toHaveLength(1);
  });

  it('a stranger that dialed in FIRST but never authenticated is shut out the moment a real editor authenticates', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const seen = [];
    const port = mk({ WebSocketServer });
    port.onMessage((m) => seen.push(m));
    port.start();

    const stranger = servers[0].dial();             // challenged, never answers
    expect(JSON.parse(stranger.sent[0])).toMatchObject({ auth: 'challenge' });

    const real = dialAuthed(servers[0]);            // a second connection, this one with the token
    expect(port.isConnected).toBe(true);
    expect(stranger.closed).toBe(true);             // the door shut behind the winner

    // The stranger's late frames go nowhere; the real editor's flow normally.
    stranger.fire('message', Buffer.from(JSON.stringify({ text: '/upgrade', chatId: 'main' })));
    expect(seen).toHaveLength(0);
    real.ws.fire('message', Buffer.from(JSON.stringify({ text: 'hola', chatId: 'main' })));
    expect(seen.map((m) => m.body)).toEqual(['hola']);
  });
});

// ── THE SANDBOX-ESCAPE HOLE THIS CLOSES (operator 2026-08-21, deepened 2026-08-26) ───────────
// The limb used to trust the LOOPBACK: whatever answered ws://127.0.0.1:23375 was handed to the
// spine as `authorized: true` operator input — `/upgrade` (git pull + npm install, in the
// UNSANDBOXED spine) included. Windows has no per-user loopback namespace and does not filter
// loopback, and 23375 was usually UNBOUND (the editor is normally closed), so a sandboxed CLI
// account (egpt-sbx-NN) could bind the port, wait for the spine to dial OUT to it, and speak as
// the operator. Since 2026-08-26 the spine HOLDS the port instead — so there is nothing to
// squat — and the handshake below is what a dialing client must still pass.
describe('shell-port AUTHENTICATION — a client must prove it holds shell.token before the spine trusts it', () => {
  const impostorFrame = JSON.stringify({ text: '/upgrade', chatId: 'main' });

  it('REPRODUCE-FIRST: an IMPOSTOR with the WRONG secret never reaches the spine — frames ignored, its socket dropped, the console stays SERVED', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const clock = makeFakeClock();
    const seen = [];
    const logs = [];
    const port = mk({ WebSocketServer, onLog: (m) => logs.push(m), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    port.onMessage((msg) => { seen.push(msg); });

    port.start();
    const ws = servers[0].dial();
    // THE LIVE ATTACK, in the order it would actually happen: the process that dialed the port
    // pushes a lifecycle command straight at the spine. Pre-handshake this line alone dispatched
    // `/upgrade` as the authorized operator — this assertion is the reproduction.
    ws.fire('message', Buffer.from(impostorFrame));
    expect(seen).toHaveLength(0);

    // It then tries the handshake with a secret it guessed, and keeps pushing.
    const challenge = JSON.parse(ws.sent[0]);
    ws.fire('message', Buffer.from(responseFrame('not-the-real-token', challenge.nonce)));
    ws.fire('message', Buffer.from(impostorFrame));

    expect(seen).toHaveLength(0);                                  // NOTHING reached the spine
    expect(port.isConnected).toBe(false);                          // never counted as a live console
    expect(ws.closed).toBe(true);                                  // that connection was dropped
    expect(logs.join('\n')).toMatch(/FAILED THE AUTH CHALLENGE/);  // named, and named the likely cause
    expect(logs.join('\n')).toMatch(/IMPOSTOR/i);

    // ONE BAD CLIENT MUST NOT TAKE THE LISTENER DOWN: still serving, still the same listener,
    // no recovery timer armed — and a genuine editor can walk straight in afterwards.
    expect(servers).toHaveLength(1);
    expect(servers[0].closed).toBe(false);
    expect(clock.timers).toHaveLength(0);
    const good = dialAuthed(servers[0]);
    expect(port.isConnected).toBe(true);
    good.ws.fire('message', Buffer.from(JSON.stringify({ text: 'hola', chatId: 'main' })));
    expect(seen.map((m) => m.body)).toEqual(['hola']);
  });

  it('an impostor that answers NOTHING gets its frames DISCARDED, never queued — a later genuine handshake does not replay them', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const seen = [];
    const port = mk({ WebSocketServer });
    port.onMessage((msg) => { seen.push(msg); });

    port.start();
    const ws = servers[0].dial();
    ws.fire('message', Buffer.from(impostorFrame));               // pre-auth → dropped on the floor
    ws.fire('message', Buffer.from('bare text line'));            // …whatever the shape
    expect(seen).toHaveLength(0);

    // It then produces a VALID answer (i.e. the genuine editor finally speaks on this socket).
    // The earlier frames must be gone, not replayed into the spine now that it is trusted.
    const challenge = JSON.parse(ws.sent[0]);
    ws.fire('message', Buffer.from(responseFrame(TOKEN, challenge.nonce)));
    expect(seen).toHaveLength(0);
    ws.fire('message', Buffer.from(JSON.stringify({ text: 'hola', chatId: 'main' })));
    expect(seen).toHaveLength(1);                                  // only what arrived AFTER the handshake
    expect(seen[0].body).toBe('hola');
  });

  it('sends NOTHING but the challenge before the peer authenticates — the header frame is deferred, and every push drops', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const port = mk({ WebSocketServer, header: 'test-header' });
    port.start();
    const ws = servers[0].dial();

    expect(ws.sent).toHaveLength(1);                               // exactly one frame: the challenge
    const challenge = JSON.parse(ws.sent[0]);
    expect(challenge).toMatchObject({ auth: 'challenge' });
    expect(challenge.nonce).toMatch(/^[0-9a-f]{64}$/);             // 32 random bytes, hex
    expect(challenge.header).toBeUndefined();                      // the header did NOT ride along

    // A reply routed here before the peer is trusted drops (never throws) — same as no editor.
    expect(port.send('main', 'secret reply')).toBe(false);
    expect(port.setHeader('lobby → acim')).toBe(false);
    expect(ws.sent).toHaveLength(1);                               // still just the challenge

    // Only once the handshake lands does the header (the limb's first real frame) go out.
    ws.fire('message', Buffer.from(responseFrame(TOKEN, challenge.nonce)));
    expect(ws.sent).toHaveLength(2);
    expect(JSON.parse(ws.sent[1])).toMatchObject({ header: 'lobby → acim', text: '' });
    expect(port.isConnected).toBe(true);
  });

  it('FAIL CLOSED with no token configured: start() BINDS NOTHING and logs the one line saying what to add', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const clock = makeFakeClock();
    const logs = [];
    const reapCalls = [];
    const port = createShellPort({
      WebSocketServer, onLog: (m) => logs.push(m), reapPort: (p) => { reapCalls.push(p); return 0; },
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });

    expect(() => port.start()).not.toThrow();
    expect(servers).toHaveLength(0);                               // no listener AT ALL — not even an unauthenticated one
    expect(reapCalls).toHaveLength(0);                             // and it never went near the real port
    expect(clock.timers).toHaveLength(0);                          // no re-listen loop spinning either
    expect(port.isConnected).toBe(false);
    const log = logs.join('\n');
    expect(log).toMatch(/DISABLED/);
    expect(log).toMatch(/shell:/);                                 // the config key…
    expect(log).toMatch(/token:/);                                 // …and the leaf, so the operator can paste it
    expect(log).toMatch(/config\.yaml/);

    // An editor announcing itself over ingest must NOT be able to switch the limb on either.
    port.poke();
    expect(servers).toHaveLength(0);
  });

  it('a CORRECT handshake delivers frames normally — the authorized operator event the spine already expects', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const seen = [];
    const port = mk({ WebSocketServer });
    port.onMessage((msg) => { seen.push(msg); });

    port.start();
    const { ws, challenge } = dialAuthed(servers[0]);
    expect(port.isConnected).toBe(true);

    ws.fire('message', Buffer.from(JSON.stringify({ text: '/status', chatId: 'main' })));
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toBe('/status');
    expect(seen[0].from).toMatchObject({ network: 'shell', userId: 'operator', authorized: true });
    expect(port.send('main', 'reply')).toBe(true);

    // The MAC is over the nonce under the shared secret — an answer computed the same way
    // matches, and the token itself never rode the wire.
    expect(ws.sent.every((f) => !String(f).includes(TOKEN))).toBe(true);
    expect(authMac(TOKEN, challenge.nonce)).toHaveLength(64);
  });

  it('a REPLAYED answer from an earlier connection does not authenticate the next one (fresh nonce per connection)', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const seen = [];
    const port = mk({ WebSocketServer });
    port.onMessage((msg) => { seen.push(msg); });

    port.start();
    const first = servers[0].dial();
    const firstChallenge = JSON.parse(first.sent[0]);              // the nonce an eavesdropper saw
    first.close();

    const ws = servers[0].dial();                                  // a FRESH connection, a FRESH nonce
    const second = JSON.parse(ws.sent[0]);
    expect(second.nonce).not.toBe(firstChallenge.nonce);

    ws.fire('message', Buffer.from(responseFrame(TOKEN, firstChallenge.nonce)));   // replay of the OLD answer
    ws.fire('message', Buffer.from(impostorFrame));
    expect(seen).toHaveLength(0);
    expect(port.isConnected).toBe(false);
    expect(ws.closed).toBe(true);
  });
});

// ── HOLDING THE PORT IS THE POINT ─────────────────────────────────────────────────────────────
// The whole reason the spine serves is that an UNBOUND 23375 is squattable. So a bind that fails
// or a listener that dies is not "the console is quiet" — it is the exact state this design
// exists to prevent, and it must be logged loudly and retried. This is the SERVER-role recovery
// relocated from src/shell/server.mjs (where a listener died twice with zero logging and zero
// recovery), NOT the deleted dial-out reconnect.
describe('shell-port LISTENER recovery — a failed bind / dead listener is loud and retried', () => {
  it('a bind that never reaches listening (something holds the port) logs loudly and arms a re-listen at RECONNECT_MIN_MS', () => {
    const { WebSocketServer, servers } = makeFakeWss({ failBind: true });
    const clock = makeFakeClock();
    const logs = [];
    const port = mk({ WebSocketServer, onLog: (m) => logs.push(m), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    port.start();
    expect(servers).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/WS SERVER ERROR/);
    expect(clock.timers).toHaveLength(1);
    expect(clock.timers[0].ms).toBe(3_000);

    clock.timers[0].fn();                        // the retry fires → a fresh bind attempt
    expect(servers).toHaveLength(2);
  });

  it('repeated failures back off exponentially (3s → 6s), and the retry does NOT re-reap the port', () => {
    const { WebSocketServer } = makeFakeWss({ failBind: true });
    const clock = makeFakeClock();
    const reapCalls = [];
    const port = createShellPort({
      WebSocketServer, token: TOKEN, reapPort: (p) => { reapCalls.push(p); return 0; },
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });

    port.start();
    expect(reapCalls).toHaveLength(1);            // reaped once, ahead of the FIRST bind
    expect(clock.timers[0].ms).toBe(3_000);
    clock.timers[0].fn();
    expect(clock.timers[1].ms).toBe(6_000);       // doubled (caps at 60_000)
    expect(reapCalls).toHaveLength(1);            // …and the retry rebinds WITHOUT killing again
  });

  it('an UNEXPECTED listener close is logged as the console port going UNHELD, and re-listens', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const clock = makeFakeClock();
    const logs = [];
    const port = mk({ WebSocketServer, onLog: (m) => logs.push(m), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    port.start();
    dialAuthed(servers[0]);
    expect(port.isConnected).toBe(true);

    servers[0].close();                           // the listener dies out from under us — NOT stop()
    expect(port.isConnected).toBe(false);
    expect(logs.join('\n')).toMatch(/CLOSED UNEXPECTEDLY/);
    expect(logs.join('\n')).toMatch(/UNHELD/);
    expect(clock.timers).toHaveLength(1);
    clock.timers[0].fn();
    expect(servers).toHaveLength(2);              // a fresh listener bound
    expect(servers[1].listening).toBe(true);
  });

  it('stop() never triggers a re-listen: the pending timer is cancelled and no second listener is built', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const clock = makeFakeClock();
    const port = mk({ WebSocketServer, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    port.start();
    servers[0].close();                           // unexpected close → schedules a re-listen
    expect(clock.timers).toHaveLength(1);

    port.stop();
    expect(clock.cleared).toContain(clock.timers[0].id);
    expect(clock.timers).toHaveLength(1);         // stop() itself schedules nothing new
    expect(servers).toHaveLength(1);              // no re-listen attempt → no second listener
  });

  it('stop() closes the seated editor and the listener, and a later poke() does not resurrect them', () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const port = mk({ WebSocketServer });
    port.start();
    const { ws } = dialAuthed(servers[0]);

    port.stop();
    expect(ws.closed).toBe(true);
    expect(servers[0].closed).toBe(true);
    expect(port.isConnected).toBe(false);

    port.poke();
    expect(servers).toHaveLength(1);
  });

  describe('poke() — the editor announced itself via ingest', () => {
    it('while already serving: a no-op — no second listener bound', () => {
      const { WebSocketServer, servers } = makeFakeWss();
      const clock = makeFakeClock();
      const port = mk({ WebSocketServer, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

      port.start();
      port.poke();
      expect(servers).toHaveLength(1);            // the spine already holds the port — nothing to do
      expect(clock.timers).toHaveLength(0);
    });

    it('while a failed bind is backing off: cancels the pending timer, resets the backoff, and re-listens NOW', () => {
      const { WebSocketServer, servers } = makeFakeWss({ failBind: true });
      const clock = makeFakeClock();
      const port = mk({ WebSocketServer, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

      port.start();
      expect(clock.timers).toHaveLength(1);       // backing off after the failed bind

      port.poke();
      expect(clock.cleared).toContain(clock.timers[0].id);   // the pending retry was cancelled
      expect(servers).toHaveLength(2);                        // a bind attempted NOW, not after the delay
      expect(clock.timers[1].ms).toBe(3_000);                 // …and the backoff was RESET, not left grown
    });
  });
});
