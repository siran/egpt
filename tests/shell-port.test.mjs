// shell-port.test.mjs — the operator-console LIMB, unit-tested with a FAKE editor
// (a fake `ws` client) — no real socket, no real timers (plans/2607191835-SHELL-LIMB-S1-PLAN.md
// Phase 1). The shell-port is a STRIPPED-DOWN sibling of the beeper limb: it dials
// OUT to the editor's local port (127.0.0.1:23375), an editor text frame becomes an
// inbound event on the `shell` surface handed to the SAME command dispatch the spine
// already runs, and the reply is pushed back over the same socket. Text in, text out.
//
// The three reproduce-first gates (write-fail-first, then make pass):
//   1. round-trip: a fake editor pushes `/status` → the REAL command dispatch replies
//      → the reply frame lands back on the fake socket.
//   2. decoupling: the editor "quits" (socket close) → no throw, a reconnect is armed;
//      a later reconnect dials a fresh socket. The spine is unaffected.
//   3. idle-when-absent: start() against an editor that never answers never crashes.
import { describe, it, expect } from 'vitest';
import { createShellPort, SHELL_WS_PORT } from '../src/bridges/shell-port.mjs';
import { responseFrame, authMac } from '../src/shell/auth.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createCommands } from '../src/spine/commands.mjs';

// The node's shell token in these tests. EVERY started port needs one now: with no token the
// limb fails closed and never dials at all (see the AUTHENTICATION block at the bottom).
const TOKEN = 'test-shell-token';

// A fake `ws` client: the injection seam the shell-port dials out with. Each `new
// WebSocket(url)` is captured so a test can drive its lifecycle (open/message/close/
// error) and read what the limb pushed back — no real socket, ever.
function makeFakeWs() {
  const sockets = [];
  class FakeWS {
    constructor(url, opts) { this.url = url; this.opts = opts; this.sent = []; this._h = {}; this.closed = false; sockets.push(this); }
    on(ev, cb) { (this._h[ev] ||= []).push(cb); return this; }
    fire(ev, ...a) { for (const cb of (this._h[ev] || [])) cb(...a); }
    send(data) { this.sent.push(data); }
    close() { this.closed = true; this.fire('close'); }
  }
  return { WebSocket: FakeWS, sockets };
}

// Open a fake editor socket AND pass the auth handshake on it — the editor's half of
// src/shell/auth.mjs, which is exactly what src/shell/server.mjs does for real. Returns the
// challenge the limb issued. The challenge frame is SHIFTED off `sock.sent`, so every existing
// assertion about what the limb pushed keeps counting from the first real frame.
function openAuthed(sock, token = TOKEN) {
  sock.fire('open');
  const challenge = JSON.parse(sock.sent.shift());
  sock.fire('message', Buffer.from(responseFrame(token, challenge.nonce)));
  return challenge;
}

// A fake clock for the reconnect backoff — records armed timers so a test can assert
// one was scheduled and fire it deterministically (mirrors the fake-timer idiom the
// spine/beeper tests use — no real wait blocks the suite).
function makeFakeClock() {
  const timers = [];
  const cleared = [];
  const setTimeout = (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, ms }); return id; };
  const clearTimeout = (id) => { cleared.push(id); };
  return { timers, cleared, setTimeout, clearTimeout };
}

describe('shell-port limb', () => {
  it('exports the fixed editor port (spine dials out to it)', () => {
    expect(SHELL_WS_PORT).toBe(23375);
  });

  it('a `/status` frame from the editor reaches the REAL command dispatch → reply pushed back over the socket', async () => {
    const { WebSocket, sockets } = makeFakeWs();
    const port = createShellPort({ WebSocket, token: TOKEN });

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
    const sock = sockets[0];
    openAuthed(sock);                                             // editor connected
    sock.fire('message', Buffer.from(JSON.stringify({ text: '/status' })));
    await pending;

    expect(sock.sent).toHaveLength(1);
    const frame = JSON.parse(sock.sent[0]);
    expect(frame.text).toContain('egpt:');                        // the /status yaml block
    expect(frame.text).toContain('pid:');
  });

  it('decouples from the editor: a socket close does NOT throw and arms a reconnect that dials a fresh socket', () => {
    const { WebSocket, sockets } = makeFakeWs();
    const clock = makeFakeClock();
    const port = createShellPort({ WebSocket, token: TOKEN, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    // A message that would blow up if the limb ever routed a spine event on a dead editor —
    // proves the close path is inert toward the spine (no error propagated).
    port.onMessage(() => { throw new Error('spine must not be touched by a close'); });

    port.start();
    openAuthed(sockets[0]);
    expect(() => sockets[0].fire('close')).not.toThrow();         // editor quit → no crash
    expect(clock.timers).toHaveLength(1);                         // a reconnect was armed
    expect(clock.timers[0].ms).toBeGreaterThan(0);

    clock.timers[0].fn();                                          // the reconnect fires
    expect(sockets).toHaveLength(2);                              // a fresh socket dialed out
  });

  it('idle-when-absent: start() against an editor that never answers never crashes the boot path', () => {
    const { WebSocket, sockets } = makeFakeWs();
    const clock = makeFakeClock();
    const port = createShellPort({ WebSocket, token: TOKEN, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    expect(() => port.start()).not.toThrow();                    // dialed out, editor silent
    // The editor refuses the connection (never opens): error then close must stay inert
    // and simply re-arm a reconnect — the spine sits idle, never crashes.
    expect(() => sockets[0].fire('error', new Error('ECONNREFUSED'))).not.toThrow();
    expect(() => sockets[0].fire('close')).not.toThrow();
    expect(clock.timers).toHaveLength(1);                         // still just backing off
  });

  describe('@e wakes E — the shell `from` carries the mention flags identity.build reads', () => {
    // THE BLOCKER: the shell built `from` WITHOUT atEStart/atEAnywhere, so a shell `@e` arrived
    // with the mention gate false → identity.build → E was never woken. The limb now runs the SAME
    // wake matcher (mentionStatus) the beeper bridge does, stamping the flags onto `from`. These
    // lock the `from` shape the shell hands the spine — the smallest surface that reproduces the bug.
    function fromFor(text, wakeWords, rest = {}) {
      const { WebSocket, sockets } = makeFakeWs();
      const port = createShellPort({ WebSocket, token: TOKEN, wakeWords, ...rest });
      let captured = null;
      port.onMessage(({ from }) => { captured = from; });
      port.start();
      openAuthed(sockets[0]);
      sockets[0].fire('message', Buffer.from(text));
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
    // finish-only push. startStream now mirrors beeper-port — it posts the ⏳ placeholder
    // immediately as a LIVE (streaming:true) frame, streams bare-stamped edits, and lands the
    // FULL concentric wrap (persona stamp + agent + bridge signatures) once, on the committed
    // final (streaming:false). On the OLD no-op update/finish-only code these assertions FAIL.
    function connected(opts = {}) {
      const { WebSocket, sockets } = makeFakeWs();
      const port = createShellPort({ WebSocket, token: TOKEN, ...opts });
      port.start();
      openAuthed(sockets[0]);
      return { port, sock: sockets[0] };
    }
    const frames = (sock) => sock.sent.map((s) => JSON.parse(s));

    it('startStream posts the ⏳ placeholder immediately as a LIVE (streaming:true) persona-stamped frame', () => {
      const { port, sock } = connected();
      port.startStream('main', '⏳ Thinking…', { bodyEmoji: '🐶', label: 'egpt', persona: 'e' });
      expect(sock.sent).toHaveLength(1);
      const f = frames(sock)[0];
      expect(f.streaming).toBe(true);
      expect(f.text).toBe('🐶 egpt\n⏳ Thinking…');               // bare persona stamp on the placeholder
    });

    it('update() pushes live SIGNED frames; finish() commits ONE streaming:false frame carrying the same FULL wrap', () => {
      const { port, sock } = connected({ bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '💸' });
      const stream = port.startStream('main', '⏳ Thinking…', { bodyEmoji: '🐶', label: 'egpt', persona: 'e', agentSigOpen: '— e —', agentSigClose: '~ e' });
      stream.update('Hola ⏳');                                    // the sender supplies the ⏳ marker
      stream.finish('Hola mundo');
      const fs = frames(sock);
      // WAS: "live, bare stamp (NO sigs)". C13 (operator 2026-07-26) — a live frame is a message
      // on a surface, so it signs; the live/committed distinction is about REPLACEMENT, not signing.
      expect(fs[0]).toMatchObject({ streaming: true, text: '🌉kg\n— e —\n🐶 egpt\n⏳ Thinking…\n~ e\n💸' });
      expect(fs[1]).toMatchObject({ streaming: true, text: '🌉kg\n— e —\n🐶 egpt\nHola ⏳\n~ e\n💸' });
      const final = fs[fs.length - 1];
      expect(final.streaming).toBe(false);
      // the ONE committed final: bridge_open, agent_open, CORE, agent_close, bridge_close
      expect(final.text).toBe('🌉kg\n— e —\n🐶 egpt\nHola mundo\n~ e\n💸');
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
      expect(fs[0]).toMatchObject({ streaming: true, text: '🌉kg\n— e —\n🐶 egpt\n⏳ Thinking…\n~ e\n💸' });
      expect(fs[1]).toMatchObject({ streaming: true, text: '🌉kg\n— e —\n🐶 egpt\nHola ⏳\n~ e\n💸' });
      expect(fs[2]).toMatchObject({ streaming: true, text: '🌉kg\n— e —\n🐶 egpt\nHola mundo ⏳\n~ e\n💸' });
      // settled bytes IDENTICAL to before the change
      expect(fs[3]).toMatchObject({ streaming: false, text: '🌉kg\n— e —\n🐶 egpt\nHola mundo\n~ e\n💸' });
      const count = (s, needle) => s.split(needle).length - 1;
      for (const f of fs) { expect(count(f.text, '🌉kg')).toBe(1); expect(count(f.text, '💸')).toBe(1); }
    });

    it('finish accepts a bare string too (the shape createSender actually calls it with)', () => {
      const { port, sock } = connected();
      port.startStream('main', '⏳', { bodyEmoji: '🐶', label: 'egpt' }).finish('done');
      const committed = frames(sock).filter((f) => f.streaming === false);
      expect(committed).toHaveLength(1);
      expect(committed[0].text).toBe('🐶 egpt\ndone');
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
      const { WebSocket, sockets } = makeFakeWs();
      const port = createShellPort({ WebSocket, token: TOKEN });
      port.start();                                               // dialed, never opened
      const stream = port.startStream('main', '⏳', { bodyEmoji: '🐶', label: 'egpt' });
      expect(() => stream.finish('x')).not.toThrow();
      expect(sockets[0].sent).toHaveLength(0);
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
      expect(frames(sock)[0].text).toBe('BO\nTO\n👂 hola\nTC\nBC');
    });

    it('a plain system reply (/status) carries the node bridge layer too — signing is a property of the SEND', () => {
      const { port, sock } = connected({ bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '🌉' });
      port.send('main', 'node: kg\npeers: do');
      expect(frames(sock)[0].text).toBe('🌉kg\nnode: kg\npeers: do\n🌉');
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
      const { WebSocket, sockets } = makeFakeWs();
      const port = createShellPort({ WebSocket, token: TOKEN });
      port.start();
      openAuthed(sockets[0]);
      const sock = sockets[0];

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
      const { WebSocket, sockets } = makeFakeWs();
      const port = createShellPort({ WebSocket, token: TOKEN, bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '💸' });
      port.start();
      openAuthed(sockets[0]);
      port.postStatus('main', '🤔 thinking…');
      const frame = JSON.parse(sockets[0].sent[0]);
      expect(frame).toMatchObject({ streaming: true, text: '🌉kg\n🤔 thinking…\n💸' });
    });
  });

  describe('header — the PERMANENT status line (boot\'s computeShellHeader), pushed on every (re)connect', () => {
    // THE REGRESSION THIS LOCKS: "a header that only ever sends once is blank forever after
    // the first reconnect". The header hooks the SAME ws.on('open') handler every connect()
    // call goes through, so first-connect, a reconnect, AND poke() all resend it — no separate
    // "is this a reconnect" tracking in boot.mjs.
    it('on open, pushes a header-only frame (empty text, no delete) — a naive text/delete-only editor handler would not log it', () => {
      const { WebSocket, sockets } = makeFakeWs();
      const port = createShellPort({ WebSocket, token: TOKEN, header: 'test-header' });
      port.start();
      openAuthed(sockets[0]);

      expect(sockets[0].sent).toHaveLength(1);
      const frame = JSON.parse(sockets[0].sent[0]);
      expect(frame.header).toBe('test-header');
      expect(frame.text).toBe('');
      expect(frame.delete).toBeUndefined();
    });

    it('a reconnect (close → the queued reconnect timer fires → fresh socket) ALSO resends the header', () => {
      const { WebSocket, sockets } = makeFakeWs();
      const clock = makeFakeClock();
      const port = createShellPort({ WebSocket, token: TOKEN, header: 'test-header', setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

      port.start();
      openAuthed(sockets[0]);
      expect(JSON.parse(sockets[0].sent[0]).header).toBe('test-header');

      sockets[0].fire('close');                 // editor drops → reconnect armed
      expect(clock.timers).toHaveLength(1);
      clock.timers[0].fn();                     // the reconnect fires → fresh socket dialed
      expect(sockets).toHaveLength(2);

      openAuthed(sockets[1]);                  // the FRESH socket opens
      expect(sockets[1].sent).toHaveLength(1);
      expect(JSON.parse(sockets[1].sent[0]).header).toBe('test-header');
    });

    it('no header option → no header frame ever sent on open', () => {
      const { WebSocket, sockets } = makeFakeWs();
      const port = createShellPort({ WebSocket, token: TOKEN });
      port.start();
      openAuthed(sockets[0]);
      expect(sockets[0].sent).toHaveLength(0);
    });
  });

  describe('setHeader() — live header update (operator 2026-08-16: /room join reflection)', () => {
    // REPRODUCE-FIRST: before setHeader existed, _header was a `const` captured once at
    // construction — there was no way for boot.mjs's onRoomChange to push an updated header
    // after boot, and no way for a LATER reconnect to carry anything but the original line.
    it('while connected: pushes a header-only frame immediately with the NEW header', () => {
      const { WebSocket, sockets } = makeFakeWs();
      const port = createShellPort({ WebSocket, token: TOKEN, header: 'lobby' });
      port.start();
      openAuthed(sockets[0]);
      expect(sockets[0].sent).toHaveLength(1);   // the initial header, on open

      port.setHeader('lobby → acim');
      expect(sockets[0].sent).toHaveLength(2);
      const frame = JSON.parse(sockets[0].sent[1]);
      expect(frame.header).toBe('lobby → acim');
      expect(frame.text).toBe('');
    });

    it('a LATER reconnect resends the UPDATED header, not the one captured at construction', () => {
      const { WebSocket, sockets } = makeFakeWs();
      const clock = makeFakeClock();
      const port = createShellPort({ WebSocket, token: TOKEN, header: 'lobby', setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
      port.start();
      openAuthed(sockets[0]);
      port.setHeader('lobby → acim');

      sockets[0].fire('close');                 // editor drops → reconnect armed
      clock.timers[0].fn();                     // reconnect fires → fresh socket
      openAuthed(sockets[1]);

      expect(sockets[1].sent).toHaveLength(1);
      expect(JSON.parse(sockets[1].sent[0]).header).toBe('lobby → acim');   // NOT the original 'lobby'
    });

    it('while disconnected: drops (never throws), same as any other push — the editor just missed a frame', () => {
      const { WebSocket, sockets } = makeFakeWs();
      const port = createShellPort({ WebSocket, token: TOKEN, header: 'lobby' });
      port.start();   // dialed, never opened
      expect(() => port.setHeader('lobby → acim')).not.toThrow();
      expect(sockets[0].sent).toHaveLength(0);
    });

    it('works even when no initial header option was given', () => {
      const { WebSocket, sockets } = makeFakeWs();
      const port = createShellPort({ WebSocket, token: TOKEN });
      port.start();
      openAuthed(sockets[0]);
      expect(sockets[0].sent).toHaveLength(0);   // no initial header → nothing on open

      port.setHeader('lobby → acim');
      expect(sockets[0].sent).toHaveLength(1);
      expect(JSON.parse(sockets[0].sent[0]).header).toBe('lobby → acim');
    });
  });

  describe('poke() — the editor announced itself via ingest, connect NOW', () => {
    it('while disconnected with a pending reconnect timer: cancels the timer, resets the backoff, and dials a fresh socket immediately', () => {
      const { WebSocket, sockets } = makeFakeWs();
      const clock = makeFakeClock();
      const port = createShellPort({ WebSocket, token: TOKEN, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

      port.start();
      openAuthed(sockets[0]);
      sockets[0].fire('close');                                   // editor drops → reconnect armed
      expect(clock.timers).toHaveLength(1);
      expect(clock.timers[0].ms).toBe(3_000);                     // RECONNECT_MIN_MS

      port.poke();
      expect(clock.cleared).toContain(clock.timers[0].id);        // the pending backoff timer was cancelled
      expect(sockets).toHaveLength(2);                            // a fresh socket dialed NOW, not after the delay

      // Confirm the backoff was reset (not left at whatever it had grown to): a close on
      // the poked socket (never opened) re-arms at RECONNECT_MIN_MS again, not a grown value.
      sockets[1].fire('close');
      expect(clock.timers).toHaveLength(2);
      expect(clock.timers[1].ms).toBe(3_000);
    });

    it('while already connected: a no-op — no second socket dialed', () => {
      const { WebSocket, sockets } = makeFakeWs();
      const clock = makeFakeClock();
      const port = createShellPort({ WebSocket, token: TOKEN, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

      port.start();
      openAuthed(sockets[0]);                                    // now connected
      port.poke();
      expect(sockets).toHaveLength(1);                            // no second socket
      expect(clock.timers).toHaveLength(0);                       // no reconnect ever touched
    });

    it('after stop(): a no-op — the limb stays stopped, never reopens', () => {
      const { WebSocket, sockets } = makeFakeWs();
      const clock = makeFakeClock();
      const port = createShellPort({ WebSocket, token: TOKEN, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

      port.start();
      openAuthed(sockets[0]);
      port.stop();
      port.poke();
      expect(sockets).toHaveLength(1);                            // stop() closed it; poke must not reopen
    });
  });
});

// ── THE SANDBOX-ESCAPE HOLE THIS CLOSES (operator 2026-08-21) ────────────────────────────────
// The limb used to trust the LOOPBACK: whatever answered ws://127.0.0.1:23375 was handed to the
// spine as `authorized: true` operator input — `/upgrade` (git pull + npm install, in the
// UNSANDBOXED spine) included. Windows has no per-user loopback namespace and does not filter
// loopback, and 23375 is usually UNBOUND (the editor is normally closed — that is the
// ECONNREFUSED reconnect loop in the daemon log), so a sandboxed CLI account (egpt-sbx-NN) could
// bind the port, wait for the spine to dial OUT to it, and speak as the operator.
//
// These are the reproduce-first gates. On the pre-fix code the first one FAILS: the impostor's
// frame reached onMsg with authorized:true, because there was no handshake at all.
describe('shell-port AUTHENTICATION — the peer must prove it holds shell.token before the spine trusts it', () => {
  const impostorFrame = JSON.stringify({ text: '/upgrade', chatId: 'main' });

  it('REPRODUCE-FIRST: an IMPOSTOR holding :23375 with the WRONG secret never reaches the spine — frames ignored, socket dropped, existing backoff re-armed', () => {
    const { WebSocket, sockets } = makeFakeWs();
    const clock = makeFakeClock();
    const seen = [];
    const logs = [];
    const port = createShellPort({ WebSocket, token: TOKEN, onLog: (m) => logs.push(m), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    port.onMessage((msg) => { seen.push(msg); });

    port.start();
    const sock = sockets[0];
    sock.fire('open');
    // THE LIVE ATTACK, in the order it would actually happen: the process squatting the port
    // pushes a lifecycle command straight at the spine. Pre-fix this line alone dispatched
    // `/upgrade` as the authorized operator — this assertion is the reproduction.
    sock.fire('message', Buffer.from(impostorFrame));
    expect(seen).toHaveLength(0);

    // It then tries the handshake with a secret it guessed, and keeps pushing.
    const challenge = JSON.parse(sock.sent[0]);
    sock.fire('message', Buffer.from(responseFrame('not-the-real-token', challenge.nonce)));
    sock.fire('message', Buffer.from(impostorFrame));

    expect(seen).toHaveLength(0);                                  // NOTHING reached the spine
    expect(port.isConnected).toBe(false);                          // never counted as a live console
    expect(sock.closed).toBe(true);                                // the socket was dropped
    expect(logs.join('\n')).toMatch(/FAILED THE AUTH CHALLENGE/);  // named, and named the likely cause
    expect(logs.join('\n')).toMatch(/IMPOSTOR/i);
    expect(clock.timers).toHaveLength(1);                          // fell into the EXISTING reconnect backoff
    expect(clock.timers[0].ms).toBe(3_000);                        // …at its normal first step, not a new mechanism
  });

  it('an impostor that answers NOTHING gets its frames DISCARDED, never queued — a later genuine handshake does not replay them', () => {
    const { WebSocket, sockets } = makeFakeWs();
    const seen = [];
    const port = createShellPort({ WebSocket, token: TOKEN });
    port.onMessage((msg) => { seen.push(msg); });

    port.start();
    const sock = sockets[0];
    sock.fire('open');
    sock.fire('message', Buffer.from(impostorFrame));               // pre-auth → dropped on the floor
    sock.fire('message', Buffer.from('bare text line'));            // …whatever the shape
    expect(seen).toHaveLength(0);

    // It then produces a VALID answer (i.e. the genuine editor finally speaks). The earlier
    // frames must be gone, not replayed into the spine now that the socket is trusted.
    const challenge = JSON.parse(sock.sent[0]);
    sock.fire('message', Buffer.from(responseFrame(TOKEN, challenge.nonce)));
    expect(seen).toHaveLength(0);
    sock.fire('message', Buffer.from(JSON.stringify({ text: 'hola', chatId: 'main' })));
    expect(seen).toHaveLength(1);                                  // only what arrived AFTER the handshake
    expect(seen[0].body).toBe('hola');
  });

  it('sends NOTHING but the challenge before the peer authenticates — the header frame is deferred, and every push drops', () => {
    const { WebSocket, sockets } = makeFakeWs();
    const port = createShellPort({ WebSocket, token: TOKEN, header: 'test-header' });
    port.start();
    const sock = sockets[0];
    sock.fire('open');

    expect(sock.sent).toHaveLength(1);                             // exactly one frame: the challenge
    const challenge = JSON.parse(sock.sent[0]);
    expect(challenge).toMatchObject({ auth: 'challenge' });
    expect(challenge.nonce).toMatch(/^[0-9a-f]{64}$/);             // 32 random bytes, hex
    expect(challenge.header).toBeUndefined();                      // the header did NOT ride along

    // A reply routed here before the peer is trusted drops (never throws) — same as a down editor.
    expect(port.send('main', 'secret reply')).toBe(false);
    expect(port.setHeader('lobby → acim')).toBe(false);
    expect(sock.sent).toHaveLength(1);                             // still just the challenge

    // Only once the handshake lands does the header (the limb's first real frame) go out.
    sock.fire('message', Buffer.from(responseFrame(TOKEN, challenge.nonce)));
    expect(sock.sent).toHaveLength(2);
    expect(JSON.parse(sock.sent[1])).toMatchObject({ header: 'lobby → acim', text: '' });
    expect(port.isConnected).toBe(true);
  });

  it('FAIL CLOSED with no token configured: start() dials NOTHING and logs the one line saying what to add', () => {
    const { WebSocket, sockets } = makeFakeWs();
    const clock = makeFakeClock();
    const logs = [];
    const port = createShellPort({ WebSocket, onLog: (m) => logs.push(m), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    expect(() => port.start()).not.toThrow();
    expect(sockets).toHaveLength(0);                               // no socket AT ALL — not even an unauthenticated one
    expect(clock.timers).toHaveLength(0);                          // and no reconnect loop spinning either
    expect(port.isConnected).toBe(false);
    const log = logs.join('\n');
    expect(log).toMatch(/DISABLED/);
    expect(log).toMatch(/shell:/);                                 // the config key…
    expect(log).toMatch(/token:/);                                 // …and the leaf, so the operator can paste it
    expect(log).toMatch(/config\.yaml/);

    // An editor announcing itself over ingest must NOT be able to switch the limb on either.
    port.poke();
    expect(sockets).toHaveLength(0);
  });

  it('a CORRECT handshake delivers frames normally — the authorized operator event the spine already expects', () => {
    const { WebSocket, sockets } = makeFakeWs();
    const seen = [];
    const port = createShellPort({ WebSocket, token: TOKEN });
    port.onMessage((msg) => { seen.push(msg); });

    port.start();
    const sock = sockets[0];
    const challenge = openAuthed(sock);
    expect(port.isConnected).toBe(true);

    sock.fire('message', Buffer.from(JSON.stringify({ text: '/status', chatId: 'main' })));
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toBe('/status');
    expect(seen[0].from).toMatchObject({ network: 'shell', userId: 'operator', authorized: true });
    expect(port.send('main', 'reply')).toBe(true);

    // The MAC is over the nonce under the shared secret — an answer computed the same way
    // matches, and the token itself never rode the wire.
    expect(sock.sent.every((f) => !String(f).includes(TOKEN))).toBe(true);
    expect(authMac(TOKEN, challenge.nonce)).toHaveLength(64);
  });

  it('a REPLAYED answer from an earlier connection does not authenticate the next one (fresh nonce per socket)', () => {
    const { WebSocket, sockets } = makeFakeWs();
    const clock = makeFakeClock();
    const seen = [];
    const port = createShellPort({ WebSocket, token: TOKEN, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    port.onMessage((msg) => { seen.push(msg); });

    port.start();
    sockets[0].fire('open');
    const first = JSON.parse(sockets[0].sent[0]);                  // the nonce an eavesdropper saw
    sockets[0].fire('close');
    clock.timers[0].fn();                                          // reconnect → a FRESH socket, a FRESH nonce
    const sock = sockets[1];
    sock.fire('open');
    const second = JSON.parse(sock.sent[0]);
    expect(second.nonce).not.toBe(first.nonce);

    sock.fire('message', Buffer.from(responseFrame(TOKEN, first.nonce)));      // replay of the OLD answer
    sock.fire('message', Buffer.from(impostorFrame));
    expect(seen).toHaveLength(0);
    expect(port.isConnected).toBe(false);
    expect(sock.closed).toBe(true);
  });
});
