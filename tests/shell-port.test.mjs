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
import { createIdentity } from '../src/spine/identity.mjs';
import { createCommands } from '../src/spine/commands.mjs';

// A fake `ws` client: the injection seam the shell-port dials out with. Each `new
// WebSocket(url)` is captured so a test can drive its lifecycle (open/message/close/
// error) and read what the limb pushed back — no real socket, ever.
function makeFakeWs() {
  const sockets = [];
  class FakeWS {
    constructor(url, opts) { this.url = url; this.opts = opts; this.sent = []; this._h = {}; sockets.push(this); }
    on(ev, cb) { (this._h[ev] ||= []).push(cb); return this; }
    fire(ev, ...a) { for (const cb of (this._h[ev] || [])) cb(...a); }
    send(data) { this.sent.push(data); }
    close() { this.fire('close'); }
  }
  return { WebSocket: FakeWS, sockets };
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
    const port = createShellPort({ WebSocket });

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
    sock.fire('open');                                             // editor connected
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
    const port = createShellPort({ WebSocket, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    // A message that would blow up if the limb ever routed a spine event on a dead editor —
    // proves the close path is inert toward the spine (no error propagated).
    port.onMessage(() => { throw new Error('spine must not be touched by a close'); });

    port.start();
    sockets[0].fire('open');
    expect(() => sockets[0].fire('close')).not.toThrow();         // editor quit → no crash
    expect(clock.timers).toHaveLength(1);                         // a reconnect was armed
    expect(clock.timers[0].ms).toBeGreaterThan(0);

    clock.timers[0].fn();                                          // the reconnect fires
    expect(sockets).toHaveLength(2);                              // a fresh socket dialed out
  });

  it('idle-when-absent: start() against an editor that never answers never crashes the boot path', () => {
    const { WebSocket, sockets } = makeFakeWs();
    const clock = makeFakeClock();
    const port = createShellPort({ WebSocket, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

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
    function fromFor(text, wakeWords) {
      const { WebSocket, sockets } = makeFakeWs();
      const port = createShellPort({ WebSocket, wakeWords });
      let captured = null;
      port.onMessage(({ from }) => { captured = from; });
      port.start();
      sockets[0].fire('open');
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
  });

  describe('startStream — a STREAMED reply renders through the shell socket (THE BUG: it went to Beeper)', () => {
    // A streamed @e / brain-member reply was rendered by createSender through its injected
    // bridge — the raw beeper bridge — so it streamed to Beeper and never reached the editor
    // (only the command `send` closure was shell-aware, why /status showed but a reply didn't).
    // The limb now exposes the stream shape createSender consumes; these lock its finish/fail.
    function connected() {
      const { WebSocket, sockets } = makeFakeWs();
      const port = createShellPort({ WebSocket });
      port.start();
      sockets[0].fire('open');
      return { port, sock: sockets[0] };
    }

    it('finish({ text }) pushes the final text as ONE frame over the socket; update() renders nothing before finish', () => {
      const { port, sock } = connected();
      const stream = port.startStream('main', '⏳ Thinking…', { persona: 'e' });
      stream.update('partial');                                   // no in-place edit surface — nothing yet
      expect(sock.sent).toHaveLength(0);
      stream.finish({ text: 'Prueba 3 recibida.' });
      expect(sock.sent).toHaveLength(1);
      expect(JSON.parse(sock.sent[0]).text).toBe('Prueba 3 recibida.');
      expect(stream.delivered).toBe(true);                       // → sender skips its §7 beeper fallback
    });

    it('finish accepts a bare string too (the shape createSender actually calls it with)', () => {
      const { port, sock } = connected();
      port.startStream('main').finish('done');
      expect(JSON.parse(sock.sent[0]).text).toBe('done');
    });

    it('fail() surfaces an error line over the socket — NOT swallowed', () => {
      const { port, sock } = connected();
      const stream = port.startStream('main');
      stream.fail(new Error('boom'));
      expect(sock.sent).toHaveLength(1);
      expect(JSON.parse(sock.sent[0]).text).toContain('boom');
      expect(stream.lastError).toContain('boom');
    });

    it('editor not connected: finish delivers nothing and delivered stays false (sender falls back), never throws', () => {
      const { WebSocket, sockets } = makeFakeWs();
      const port = createShellPort({ WebSocket });
      port.start();                                               // dialed, never opened
      const stream = port.startStream('main');
      expect(() => stream.finish('x')).not.toThrow();
      expect(sockets[0].sent).toHaveLength(0);
      expect(stream.delivered).toBe(false);
    });
  });

  describe('poke() — the editor announced itself via ingest, connect NOW', () => {
    it('while disconnected with a pending reconnect timer: cancels the timer, resets the backoff, and dials a fresh socket immediately', () => {
      const { WebSocket, sockets } = makeFakeWs();
      const clock = makeFakeClock();
      const port = createShellPort({ WebSocket, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

      port.start();
      sockets[0].fire('open');
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
      const port = createShellPort({ WebSocket, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

      port.start();
      sockets[0].fire('open');                                    // now connected
      port.poke();
      expect(sockets).toHaveLength(1);                            // no second socket
      expect(clock.timers).toHaveLength(0);                       // no reconnect ever touched
    });

    it('after stop(): a no-op — the limb stays stopped, never reopens', () => {
      const { WebSocket, sockets } = makeFakeWs();
      const clock = makeFakeClock();
      const port = createShellPort({ WebSocket, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

      port.start();
      sockets[0].fire('open');
      port.stop();
      port.poke();
      expect(sockets).toHaveLength(1);                            // stop() closed it; poke must not reopen
    });
  });
});
