// shell-aware-bridge.test.mjs — the FIX for streamed replies vanishing into Beeper.
//
// THE BUG: createSender (E's persona sender + the brain-member relay sender) renders through
// its injected `bridge`. boot handed it the raw beeper bridge, so a STREAMED @e / @member
// reply on a shell-owned chat streamed to Beeper and never reached the editor — only the
// command `send` closure was shell-aware, which is why /status showed in the shell but a
// streamed reply did not. boot now wraps the bridge in makeShellAwareBridge before handing it
// to BOTH senders. Two reproduce-first gates:
//   1. routing (unit): makeShellAwareBridge sends/streams to shellPort for shell-owned chats,
//      to the real beeper bridge otherwise — asserted with a fake shellPort + fake bridge.
//   2. relay integration: the REAL member sender (createSender) over the REAL facade + REAL
//      shellPort renders a relay reply through the shell socket, NOT the beeper bridge.
import { describe, it, expect } from 'vitest';
import { makeShellAwareBridge } from '../src/spine/boot.mjs';
import { createShellPort } from '../src/bridges/shell-port.mjs';
import { createSender } from '../src/spine/sender.mjs';

// The same fake `ws` seam the shell-port tests use — no real socket, ever.
function makeFakeWs() {
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this._h = {}; sockets.push(this); }
    on(ev, cb) { (this._h[ev] ||= []).push(cb); return this; }
    fire(ev, ...a) { for (const cb of (this._h[ev] || [])) cb(...a); }
    send(data) { this.sent.push(data); }
    close() { this.fire('close'); }
  }
  return { WebSocket: FakeWS, sockets };
}

describe('makeShellAwareBridge — streaming sends route to the shell for shell-owned chats, to beeper otherwise', () => {
  function fakes() {
    const shellCalls = [];
    const beeperCalls = [];
    const shellPort = {
      owns: (c) => c === 'main',
      send: (c, t) => { shellCalls.push({ m: 'send', c, t }); return true; },
      startStream: (c, i, tag) => { shellCalls.push({ m: 'startStream', c, i, tag }); return { finish() {}, get delivered() { return true; } }; },
    };
    const beeper = {
      onEdit() {}, postStatus() {},                                       // unrelated methods that must pass through
      send: (c, t, o) => { beeperCalls.push({ m: 'send', c, t, o }); },
      startStream: (c, i, tag) => { beeperCalls.push({ m: 'startStream', c, i, tag }); return { finish() {} }; },
    };
    return { shellPort, beeper, shellCalls, beeperCalls };
  }

  it('send + startStream on a shell-owned chat go to shellPort, NOT the beeper bridge', () => {
    const { shellPort, beeper, shellCalls, beeperCalls } = fakes();
    const b = makeShellAwareBridge(beeper, shellPort);
    b.send('main', 'hi', { replyTo: 'x' });
    b.startStream('main', '⏳', { persona: 'e' });
    expect(shellCalls.map((c) => c.m)).toEqual(['send', 'startStream']);
    expect(beeperCalls).toHaveLength(0);
  });

  it('send + startStream on a NON-shell chat go to the real beeper bridge, NOT shellPort', () => {
    const { shellPort, beeper, shellCalls, beeperCalls } = fakes();
    const b = makeShellAwareBridge(beeper, shellPort);
    b.send('!room-9', 'hi', { replyTo: 'x' });
    b.startStream('!room-9', '⏳', { persona: 'e' });
    expect(beeperCalls.map((c) => c.m)).toEqual(['send', 'startStream']);
    expect(shellCalls).toHaveLength(0);
  });

  it('unrelated bridge methods pass through unchanged (bridge spread first)', () => {
    const { shellPort, beeper } = fakes();
    const b = makeShellAwareBridge(beeper, shellPort);
    expect(typeof b.onEdit).toBe('function');
    expect(typeof b.postStatus).toBe('function');
  });
});

describe('a brain-member relay reply on a shell-owned chat renders through the shell socket, not Beeper', () => {
  it('memberSender.open(...).finish(reply) over the shell-aware bridge pushes the reply to the editor socket', async () => {
    // A REAL shell port with a fake editor socket; mark 'main' owned by delivering an inbound frame
    // (owns() reads the chat ids it saw inbound — exactly boot's outbound-routing signal).
    const { WebSocket, sockets } = makeFakeWs();
    const shellPort = createShellPort({ WebSocket });
    shellPort.onMessage(() => {});
    shellPort.start();
    const sock = sockets[0];
    sock.fire('open');
    sock.fire('message', Buffer.from(JSON.stringify({ text: '@chatgpt run it', chatId: 'main' })));
    expect(shellPort.owns('main')).toBe(true);

    // The real beeper bridge fake — it must receive NOTHING for a shell-owned chat.
    const beeper = {
      sent: [], streams: 0,
      send(c, t) { this.sent.push({ c, t }); },
      startStream() { this.streams++; return { update() {}, finish() {}, delete() {}, fail() {}, get delivered() { return true; }, get lastError() { return null; } }; },
    };

    // The REAL member sender, wired exactly as boot wires it, over the REAL facade.
    const memberSender = createSender({ bridge: makeShellAwareBridge(beeper, shellPort), bodyEmojiOf: () => '🤖', labelOf: (id) => id, defaultKey: 'e' });

    // The relay's openStream shape (boot): open a member stream, then finish it with the brain reply.
    const stream = memberSender.open('main', { being: 'chatgpt', replyTo: null });
    await stream.finish({ text: 'Prueba 3 recibida.' });

    expect(sock.sent).toHaveLength(1);
    expect(JSON.parse(sock.sent[0]).text).toContain('Prueba 3 recibida.');   // reached the SHELL
    expect(beeper.sent).toHaveLength(0);                                       // NOT the beeper send
    expect(beeper.streams).toBe(0);                                            // NOT the beeper stream
  });
});
