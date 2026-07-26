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
import { createMeshService } from '../src/spine/mesh.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';

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
      postStatus: (c, t) => { shellCalls.push({ m: 'postStatus', c, t }); return null; },   // shell has no editable msg id
    };
    const beeper = {
      onEdit() {},                                                        // unrelated method that must pass through
      postStatus: (c, t) => { beeperCalls.push({ m: 'postStatus', c, t }); return 'beeper-msg-id'; },
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
  });

  // postStatus is the MESH origin-placeholder seam (operator 2026-07-25): a shell-origin relay
  // (`@don` typed in the shell) posts its "🤔 thinking…" placeholder through bridge.postStatus.
  // Pre-fix the facade had NO postStatus override, so the spread's beeper.postStatus fired → the
  // placeholder streamed to Beeper and dropped. Now it routes to shellPort for shell-owned chats.
  it('REPRODUCE-FIRST: postStatus on a shell-owned chat goes to shellPort (returns null), NOT beeper', () => {
    const { shellPort, beeper, shellCalls, beeperCalls } = fakes();
    const b = makeShellAwareBridge(beeper, shellPort);
    const id = b.postStatus('main', '🤔 thinking…');
    expect(shellCalls.map((c) => c.m)).toEqual(['postStatus']);
    expect(beeperCalls).toHaveLength(0);
    expect(id).toBeNull();                       // no editable shell msg id → mesh's later edit/delete is a no-op
  });

  it('postStatus on a NON-shell chat goes to the beeper bridge (returns its msg id), NOT shellPort', () => {
    const { shellPort, beeper, shellCalls, beeperCalls } = fakes();
    const b = makeShellAwareBridge(beeper, shellPort);
    const id = b.postStatus('!room-9', '🤔 thinking…');
    expect(beeperCalls.map((c) => c.m)).toEqual(['postStatus']);
    expect(shellCalls).toHaveLength(0);
    expect(id).toBe('beeper-msg-id');
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

    // The relay's openStream shape (boot): open a member stream (posts the ⏳ placeholder as a
    // live frame), then finish it with the brain reply (the committed final).
    const stream = memberSender.open('main', { being: 'chatgpt', replyTo: null });
    await stream.finish({ text: 'Prueba 3 recibida.' });

    // The shell got the stream (placeholder + committed final); the beeper bridge got NOTHING.
    const frames = sock.sent.map((s) => JSON.parse(s));
    const committed = frames.filter((f) => f.streaming === false);
    expect(committed).toHaveLength(1);
    expect(committed[0].text).toContain('Prueba 3 recibida.');   // the committed reply reached the SHELL
    expect(beeper.sent).toHaveLength(0);                          // NOT the beeper send
    expect(beeper.streams).toBe(0);                              // NOT the beeper stream
  });
});

// ── END-TO-END: a shell-origin mesh relay (`@don` typed in the shell on kg) streams its living-
//    mirror reply back INTO the shell, never to Beeper (operator 2026-07-25). The REAL mesh service
//    runs over the REAL shellPort + REAL shell-aware facade; a hand-rolled responder reply is fed
//    back through mesh.handle. The origin PLACEHOLDER (postStatus) and the mirror (startStream) both
//    route to the editor; only the outbound REQUEST envelope (a Beeper relay channel) hits Beeper. ──
describe('a shell-origin mesh relay reply streams back into the shell, not Beeper', () => {
  it('REPRODUCE-FIRST: @don from the shell → placeholder + reply land on the editor socket; only the request envelope hits Beeper', async () => {
    // REAL shell port with a fake editor socket; mark 'main' owned by an inbound frame.
    const { WebSocket, sockets } = makeFakeWs();
    const shellPort = createShellPort({ WebSocket });
    shellPort.onMessage(() => {});
    shellPort.start();
    const sock = sockets[0];
    sock.fire('open');
    sock.fire('message', Buffer.from(JSON.stringify({ text: '@don hola', chatId: 'main' })));
    expect(shellPort.owns('main')).toBe(true);

    // The REAL beeper bridge fake — the ORIGIN placeholder + mirror must NOT touch it; only the
    // outbound relay-channel envelope (a non-shell chat) may.
    const beeper = {
      sent: [], statusPosts: [], streams: 0,
      send(c, t) { this.sent.push({ c, t }); return { ok: true }; },
      async postStatus(c, t) { this.statusPosts.push({ c, t }); return 'beeper-post-id'; },
      startStream(c, i, o) { this.streams++; return { update() {}, async finish() {}, async delete() {}, delivered: false }; },
    };

    // The REAL mesh service over the REAL shell-aware facade, exactly as boot wires it.
    const shellAware = makeShellAwareBridge(beeper, shellPort);
    const mesh = createMeshService({
      bridge: shellAware,
      brain: { async turn() { return { text: '' }; } },          // origin never runs the being
      getConfig: () => ({ node_name: 'kg' }),
      bodyEmojiOf: () => '🤝',
    });

    // ORIGIN: the router-resolved route-direct target (a `surface: shell` relay agent → `to: don.do`).
    const shellEv = { surface: 'shell', chatId: 'main', chatName: 'shell', senderName: 'operator', body: '@don hola' };
    const ok = await mesh.forward(shellEv, { being: 'don', route: { room_id: 'egpt-mesh-do-kg' }, to: 'don.do' });
    expect(ok).toBe(true);

    // The outbound REQUEST envelope went to Beeper's relay channel (NOT shell-owned) …
    expect(beeper.sent).toHaveLength(1);
    expect(beeper.sent[0].c).toBe('egpt-mesh-do-kg');
    const req = parseMesh(beeper.sent[0].t);
    expect(req).toMatchObject({ to: 'don.do', from: 'shell', from_node: 'kg' });
    // … but the ORIGIN placeholder did NOT (it went to the editor via shellPort.postStatus).
    expect(beeper.statusPosts).toHaveLength(0);

    // RESPONDER reply (hand-rolled as `do` would send it): echoes the request's return-address +
    // placeholder id, stamped with don's body_emoji, done in one frame.
    const reply = encodeMesh({ by: 'don.do', body: '🤝 hey there', re: `${req.from}.${req.from_node}`, post_id: req.post_id, done: true });
    await mesh.handle({ surface: 'wa', chatId: 'egpt-mesh-do-kg', msgId: 'r1', body: reply });

    // The editor got the living-mirror reply; the beeper bridge never streamed it.
    const frames = sock.sent.map((s) => JSON.parse(s));
    const committed = frames.filter((f) => f.streaming === false);
    expect(committed.some((f) => f.text.includes('🤝 hey there'))).toBe(true);   // reply reached the SHELL
    expect(beeper.streams).toBe(0);                                              // NOT streamed to Beeper
    expect(beeper.sent).toHaveLength(1);                                         // still just the one request envelope
  });

  // THE LIVE DEFECT (operator, with a screenshot): relaying `@don` from the shell shows TWO
  // thinking indicators, and one NEVER goes away. CAUSE: postStatus posted its placeholder
  // committed (streaming:false) — a line the shell can never replace — then the reply's
  // openOriginStream posted a SECOND, live placeholder that streams into the actual reply. The
  // committed one is immortal. Model the exact live case: a mesh origin placeholder followed by
  // a streamed reply. On the pre-fix code this FAILS with two committed frames.
  it('REPRODUCE-FIRST: the origin placeholder is live, not committed — after the reply commits there is exactly ONE committed frame (no lingering "thinking" line)', async () => {
    const { WebSocket, sockets } = makeFakeWs();
    const shellPort = createShellPort({ WebSocket });
    shellPort.onMessage(() => {});
    shellPort.start();
    const sock = sockets[0];
    sock.fire('open');
    sock.fire('message', Buffer.from(JSON.stringify({ text: '@don hola', chatId: 'main' })));

    const beeper = {
      sent: [],
      send(c, t) { this.sent.push({ c, t }); return { ok: true }; },
      async postStatus(c, t) { return 'beeper-post-id'; },
      startStream(c, i, o) { return { update() {}, async finish() {}, async delete() {}, delivered: false }; },
    };

    const shellAware = makeShellAwareBridge(beeper, shellPort);
    const mesh = createMeshService({
      bridge: shellAware,
      brain: { async turn() { return { text: '' }; } },
      getConfig: () => ({ node_name: 'kg' }),
      bodyEmojiOf: () => '🤝',
    });

    const shellEv = { surface: 'shell', chatId: 'main', chatName: 'shell', senderName: 'operator', body: '@don hola' };
    await mesh.forward(shellEv, { being: 'don', route: { room_id: 'egpt-mesh-do-kg' }, to: 'don.do' });

    // Right after the placeholder posts (reply hasn't arrived yet): NOT committed — a live
    // frame only, so nothing is left behind if the reply were to never arrive.
    const preReply = sock.sent.map((s) => JSON.parse(s));
    expect(preReply.filter((f) => f.streaming === false)).toHaveLength(0);
    expect(preReply).toHaveLength(1);
    expect(preReply[0]).toMatchObject({ streaming: true, text: '🤔 thinking…' });

    const req = parseMesh(beeper.sent[0].t);
    const reply = encodeMesh({ by: 'don.do', body: '🤝 hey there', re: `${req.from}.${req.from_node}`, post_id: req.post_id, done: true });
    await mesh.handle({ surface: 'wa', chatId: 'egpt-mesh-do-kg', msgId: 'r1', body: reply });

    const frames = sock.sent.map((s) => JSON.parse(s));
    const committed = frames.filter((f) => f.streaming === false);
    expect(committed).toHaveLength(1);                          // no leftover committed "thinking" line
    expect(committed[0].text).toContain('hey there');           // the ONE committed frame is the reply
  });
});

// ── THE ORIGIN NODE SIGNS WHAT IT POSTS (operator 2026-07-25) ────────────────────────────
// LIVE DEFECT, in the operator's shell on kg:
//     @e  you there?  ->  🐶 egpt / Still here. / 🌉     (persona reply: stamped AND signed)
//     @don ya there?  ->  🤝 Yep, still here 🤝           (relayed reply: NO 🌉)
// kg posted that second line and signed nothing: the 🤝s are entirely DOLLY's (do's body-emoji
// stamp + do's own bridge_signature_close, transported inside the envelope body); kg's own
// bridge_signature_close never appeared. CAUSE: mesh.openOriginStream / mesh.surface opened
// the origin's stream / send with a tag carrying NO wrap intent, and BOTH surface ports gate
// their concentric wrap on a full persona header (makeWrapPersona: bodyEmoji && label) — so a
// relayed reply, which has no persona header (the body is a REMOTE being's), got no layers.
// A relayed reply must render through the SAME machinery a local reply does; the bridge
// signature says WHICH SPINE POSTED, and two spines handled the message, so two signatures
// (do's inner, in the transported body; kg's outer) is the honest outcome.
describe('the ORIGIN node signs the relayed reply it posts home (shell surface)', () => {
  // bodyEmojiOf is '' here on purpose: the ORIGIN is not the being's host, so the assertions
  // stay on the bridge layer alone (the responder already stamped the body it sent).
  async function shellOriginRelay() {
    const { WebSocket, sockets } = makeFakeWs();
    const shellPort = createShellPort({ WebSocket, bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '🌉' });
    shellPort.onMessage(() => {});
    shellPort.start();
    const sock = sockets[0];
    sock.fire('open');
    sock.fire('message', Buffer.from(JSON.stringify({ text: '@don ya there?', chatId: 'main' })));

    const beeper = {
      sent: [],
      send(c, t) { this.sent.push({ c, t }); return { ok: true }; },
      async postStatus() { return 'beeper-post-id'; },
      startStream() { return { update() {}, async finish() {}, async delete() {}, delivered: false }; },
    };
    const mesh = createMeshService({
      bridge: makeShellAwareBridge(beeper, shellPort),
      brain: { async turn() { return { text: '' }; } },
      getConfig: () => ({ node_name: 'kg' }),
      bodyEmojiOf: () => '',
    });
    const ev = { surface: 'shell', chatId: 'main', chatName: 'shell', senderName: 'operator', body: '@don ya there?' };
    await mesh.forward(ev, { being: 'don', route: { room_id: 'egpt-mesh-do-kg' }, to: 'don.do' });
    const req = parseMesh(beeper.sent[0].t);
    // do's reply exactly as it rides the wire: its own body-emoji stamp + its own bridge close.
    const body = '🤝 Yep, still here\n🤝';
    const re = `${req.from}.${req.from_node}`;
    const committed = () => sock.sent.map((s) => JSON.parse(s)).filter((f) => f.streaming === false);
    return { mesh, sock, committed, body, re, post_id: req.post_id };
  }

  it('REPRODUCE-FIRST: the living-mirror committed final carries kg\'s bridge signature around do\'s intact body', async () => {
    const { mesh, committed, body, re, post_id } = await shellOriginRelay();
    await mesh.handle({ surface: 'wa', chatId: 'egpt-mesh-do-kg', msgId: 'r1', body: encodeMesh({ by: 'don.do', body, re, post_id, done: true }) });

    const final = committed().at(-1);
    // outer = kg's bridge layer; inner = do's body, transported verbatim (its own 🤝 stamp + close)
    expect(final.text).toBe('🌉kg\n🤝 Yep, still here\n🤝\n🌉');
  });

  // WAS "the 🤔 placeholder is NOT signed — only the reply the node actually posts is". C13
  // (operator 2026-07-26): "bridge must sign. always. structurally." / "it should also sign
  // 'thinking... 💸|🌉'". A live frame is a message a spine put on a surface for the whole
  // duration of the turn; being transient is not an exemption.
  it('the 🤔 placeholder IS signed — every frame the node posts carries its bridge layer', async () => {
    // The placeholder is a LIVE frame (postStatus fix, operator: "double-thinking, one
    // lingers"), not a committed one — check the raw frame, not committed().
    const { sock } = await shellOriginRelay();
    const live = sock.sent.map((s) => JSON.parse(s)).find((f) => f.streaming === true);
    expect(live.text).toBe('🌉kg\n🤔 thinking…\n🌉');
  });

  it('the ONE-SHOT surface path (no stream primitive / no msgId) is signed identically', async () => {
    const { mesh, committed, body, re, post_id } = await shellOriginRelay();
    // msgId null → no mirror stage can be keyed → the engine surfaces the reply home once.
    await mesh.handle({ surface: 'wa', chatId: 'egpt-mesh-do-kg', msgId: null, body: encodeMesh({ by: 'don.do', body, re, post_id, done: true }) });

    expect(committed().at(-1).text).toBe('🌉kg\n🤝 Yep, still here\n🤝\n🌉');
  });

  // TWO signatures are correct (do's inside the transported body, kg's around the delivery).
  // WAS "kg signs ONCE, at the end — the live mirror frames carry NO signature". C13 (operator
  // 2026-07-26) reversed the once-at-the-end convention: kg signs EVERY mirror frame. What must
  // still hold is that the signature never ACCUMULATES as the frames replace one another — each
  // frame is rendered from the raw core, so exactly one open + one close on every one of them,
  // and the settled bytes are unchanged.
  it('kg signs EVERY mirror frame — exactly one signature each, never stacking', async () => {
    const { mesh, sock, body, re, post_id } = await shellOriginRelay();
    const frame = (b, done) => ({ surface: 'wa', chatId: 'egpt-mesh-do-kg', msgId: 'r1', body: encodeMesh({ by: 'don.do', body: b, re, post_id, done }) });
    await mesh.handle(frame('🤝 Yep,', false));            // live: opens the mirror + updates it
    await mesh.handle(frame('🤝 Yep, still', false));      // live: another update
    await mesh.handle(frame(body, true));                  // the committed final

    const all = sock.sent.map((s) => JSON.parse(s)).filter((f) => !f.delete && String(f.text).trim());
    expect(all.length).toBeGreaterThan(1);
    for (const f of all) {
      expect(f.text.split('🌉kg').length - 1).toBe(1);     // one open, never "🌉kg 🌉kg 🌉kg"
      expect(f.text.endsWith('\n🌉')).toBe(true);          // one close, at the bottom
    }
    expect(all.filter((f) => f.streaming === false)).toHaveLength(1);      // still exactly one COMMITTED frame
    expect(all.at(-1).text).toBe('🌉kg\n🤝 Yep, still here\n🤝\n🌉');       // settled bytes unchanged
  });
});
