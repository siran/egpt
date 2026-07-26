// lasso.test.mjs — THE OUTBOUND RATE REGULATOR (src/lasso.mjs), reproduce-first.
//
// THE LIVE FAILURE (2026-07-25): two nodes traded hundreds of messages ~0.7s apart until the
// service had to be killed. The loop counter (src/stop-guard.mjs) counts INBOUND non-human
// turns at the PROMPT chokepoint and never moved — those replies never prompted a brain.
// Nothing bounded what LEAVES the node. Test 1 is that shape: a loop emitting as fast as it
// can. Before the lasso every message left instantly (the control below still proves it on an
// unwrapped port); after it, the node cannot exceed messages-per-window no matter what
// upstream asks of it.
//
// The clock and the timer are injected everywhere — no test waits on real time except the
// boot-level ones, which configure a 50ms window on purpose so a whole drain takes ~200ms.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createLasso } from '../src/lasso.mjs';
import { createShellPort } from '../src/bridges/shell-port.mjs';
// boot.mjs is imported DYNAMICALLY below (never statically): egpt-home.mjs reads EGPT_HOME
// once at module load, and a static import would bind the PRODUCTION profile before this file
// points it at a throwaway one.

// Let every pending microtask + already-resolved await chain run.
const flush = () => new Promise((r) => setImmediate(r));

// A driveable clock + timer pair: advance(ms) fires every timer due in that span, in order,
// letting the awaiting code run between firings.
function fakeClock(start = 1_000_000) {
  let t = start;
  let timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const timer = { at: t + Math.max(0, ms), fn }; timers.push(timer); return timer; },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

// A recording limb port with the shape the lasso wraps (beeper-port / shell-port).
function fakePort(clock) {
  const posts = [];
  return {
    posts,
    async send(chat, text) { posts.push({ at: clock.now(), kind: 'send', chat, text }); return { ok: true }; },
    async postStatus(chat, text) { posts.push({ at: clock.now(), kind: 'postStatus', chat, text }); return 'id-1'; },
    async sendMedia(chat, filePath) { posts.push({ at: clock.now(), kind: 'sendMedia', chat, filePath }); return true; },
    startStream(chat, init) {
      const h = { delivered: false, lastError: null, frames: [] };
      posts.push({ at: clock.now(), kind: 'startStream', chat, text: init, handle: h });
      h.update = (t) => h.frames.push(t);
      h.finish = async (t) => { h.frames.push(t); h.delivered = true; };
      h.delete = async () => { h.frames.push('<deleted>'); };
      return h;
    },
    isAlive: () => true,
    stop() {},
  };
}

describe('lasso — the outbound rate regulator', () => {
  it('1. holds a flood (a loop emitting as fast as it can) to the configured rate', async () => {
    const clock = fakeClock();

    // CONTROL — the shape of the live incident: an UNREGULATED port lets the whole loop out
    // at once. This is what the node did on 2026-07-25.
    const raw = fakePort(clock);
    await Promise.all(Array.from({ length: 30 }, (_, i) => raw.send('!room', `flood ${i}`)));
    expect(raw.posts).toHaveLength(30);
    expect(new Set(raw.posts.map((p) => p.at)).size).toBe(1);   // all in the same instant

    // REGULATED — the same loop, through the lasso.
    const port = fakePort(clock);
    const lasso = createLasso({ messages: 3, windowMs: 5000, maxQueue: 100, now: clock.now, setTimeout: clock.setTimeout });
    const bridge = lasso.wrap(port);

    const all = Promise.all(Array.from({ length: 30 }, (_, i) => bridge.send('!room', `flood ${i}`)));
    await flush();
    expect(port.posts).toHaveLength(3);                       // ← the whole point: 3, not 30

    await clock.advance(5000);
    expect(port.posts).toHaveLength(6);
    await clock.advance(5000);
    expect(port.posts).toHaveLength(9);

    await clock.advance(60_000);
    await all;
    expect(port.posts).toHaveLength(30);                      // nothing is LOST — it is PACED
    expect(port.posts.map((p) => p.text)).toEqual(Array.from({ length: 30 }, (_, i) => `flood ${i}`));  // and in order

    // No 5s window anywhere in the run ever held more than 3 messages.
    for (const p of port.posts) {
      const inWindow = port.posts.filter((q) => q.at >= p.at && q.at < p.at + 5000);
      expect(inWindow.length).toBeLessThanOrEqual(3);
    }
  });

  it('2. does NOT slow an ordinary streamed reply — placeholder + edits + final is ONE message', async () => {
    const clock = fakeClock();
    const port = fakePort(clock);
    const lasso = createLasso({ messages: 3, windowMs: 5000, now: clock.now, setTimeout: clock.setTimeout });
    const bridge = lasso.wrap(port);

    // Exactly what src/spine/sender.mjs does per reply.
    const stream = bridge.startStream('!room', '⏳ Thinking…', { bodyEmoji: '🐶' });
    stream.update('Hel');
    stream.update('Hello th');
    stream.update('Hello there');
    await stream.finish('Hello there!');
    await flush();

    expect(port.posts).toHaveLength(1);                       // ONE committed message
    expect(lasso.stats()).toMatchObject({ inWindow: 1, delayed: 0, dropped: 0 });
    expect(port.posts[0].handle.frames).toEqual(['Hel', 'Hello th', 'Hello there', 'Hello there!']);
    expect(stream.delivered).toBe(true);                      // the §7 fallback stays off

    // Three consecutive ordinary replies still leave instantly — nothing is throttled.
    for (let i = 0; i < 2; i++) {
      const s = bridge.startStream('!room', '⏳ Thinking…', {});
      s.update('x'); await s.finish('done');
    }
    await flush();
    expect(port.posts).toHaveLength(3);
    expect(lasso.stats().delayed).toBe(0);
  });

  it('3. does not throttle a fan-out — two agents answering one message', async () => {
    const clock = fakeClock();
    const port = fakePort(clock);
    const lasso = createLasso({ messages: 3, windowMs: 5000, now: clock.now, setTimeout: clock.setTimeout });
    const bridge = lasso.wrap(port);

    const a = bridge.startStream('!room', '⏳ Thinking…', {});
    const b = bridge.startStream('!room', '⏳ Thinking…', {});
    await Promise.all([a.finish('answer A'), b.finish('answer B')]);
    await flush();

    expect(port.posts).toHaveLength(2);
    expect(lasso.stats().delayed).toBe(0);
    expect(a.delivered && b.delivered).toBe(true);

    // …and a mesh request + placeholder + reply mirror (3 in a blink) still fits the window.
    const clock2 = fakeClock();
    const port2 = fakePort(clock2);
    const mesh = createLasso({ messages: 3, windowMs: 5000, now: clock2.now, setTimeout: clock2.setTimeout }).wrap(port2);
    await Promise.all([
      mesh.postStatus('!room', '🤔 thinking…'),
      mesh.send('!relay', '<envelope>'),
      mesh.send('!room', 'the answer'),
    ]);
    expect(port2.posts).toHaveLength(3);
  });

  it('4. bounds the queue — past the bound the excess is DROPPED, loudly and visibly', async () => {
    const clock = fakeClock();
    const port = fakePort(clock);
    const states = [];
    const logs = [];
    const lasso = createLasso({
      messages: 3, windowMs: 5000, maxQueue: 5,
      now: clock.now, setTimeout: clock.setTimeout,
      onLog: (m) => logs.push(m), writeState: (s) => states.push(s),
    });
    const bridge = lasso.wrap(port);

    const first3 = Array.from({ length: 3 }, (_, i) => bridge.send('!room', `now ${i}`));
    const queued5 = Array.from({ length: 5 }, (_, i) => bridge.send('!room', `queued ${i}`));
    await flush();
    expect(port.posts).toHaveLength(3);
    expect(lasso.stats().queued).toBe(5);

    // AT THE BOUND: the next sends are refused rather than queued — no unbounded backlog, no
    // minutes-late delivery. The caller gets the same falsy answer an unresolvable send gives.
    const refused = await Promise.all([bridge.send('!room', 'over 1'), bridge.send('!room', 'over 2')]);
    expect(refused).toEqual([null, null]);
    expect(lasso.stats().dropped).toBe(2);
    expect(logs.some((m) => m.includes('QUEUE FULL'))).toBe(true);
    expect(states.at(-1)).toMatchObject({ state: 'dropping', dropped_total: 1, limit: { max_queue: 5 } });

    // A dropped media send / status answers falsy in ITS OWN shape, never throws.
    expect(await bridge.sendMedia('!room', '/tmp/x.png')).toBe(false);
    expect(await bridge.postStatus('!room', '🤔')).toBe(null);

    // A dropped stream reports undelivered so the sender's §7 fallback can decide.
    const s = bridge.startStream('!room', '⏳ Thinking…', {});
    await s.finish('never');
    expect(s.delivered).toBe(false);
    expect(s.lastError).toContain('queue full');

    // The queued ones still drain, in order, and the file says so when it is over.
    await clock.advance(60_000);
    await Promise.all([...first3, ...queued5]);
    expect(port.posts.map((p) => p.text)).toEqual(['now 0', 'now 1', 'now 2', 'queued 0', 'queued 1', 'queued 2', 'queued 3', 'queued 4']);
    expect(states.at(-1)).toMatchObject({ state: 'idle', queued: 0 });
  });

  it('5. NEVER throttles the STOP path — the kill switch always gets out', async () => {
    const clock = fakeClock();
    const port = fakePort(clock);
    const lasso = createLasso({ messages: 3, windowMs: 5000, maxQueue: 5, now: clock.now, setTimeout: clock.setTimeout });
    const bridge = lasso.wrap(port);

    // Saturate the window AND fill the queue to the bound — the worst moment for a kill switch.
    const flood = Array.from({ length: 8 }, (_, i) => bridge.send('!room', `flood ${i}`));
    await flush();
    expect(lasso.stats().queued).toBe(5);

    const stopped = await bridge.send('!room', '🛑 STOP received — egpt is stopping', { bypassLasso: true });
    expect(stopped).toEqual({ ok: true });
    expect(port.posts.at(-1).text).toContain('STOP received');   // out NOW, not queued behind the flood
    expect(port.posts).toHaveLength(4);                          // it does not consume a slot either

    await clock.advance(60_000);
    await Promise.all(flood);
  });

  it('6. is ONE budget across every limb — a shell send and a beeper send share it', async () => {
    const clock = fakeClock();
    const beeper = fakePort(clock);
    const lasso = createLasso({ messages: 3, windowMs: 5000, now: clock.now, setTimeout: clock.setTimeout });

    // The real shell port, over a fake editor socket.
    const frames = [];
    let onOpen = null;
    class FakeWS {
      constructor() { onOpen = null; }
      on(ev, cb) { if (ev === 'open') { onOpen = cb; queueMicrotask(cb); } }
      send(f) { frames.push(JSON.parse(f)); }
      close() {}
    }
    const shell = lasso.wrap(createShellPort({ WebSocket: FakeWS, setTimeout: clock.setTimeout }));
    shell.start();
    await flush();

    // The Proxy must not freeze a GETTER (a spread would have): isConnected is live.
    expect(shell.isConnected).toBe(true);

    const bridge = lasso.wrap(beeper);
    await Promise.all([bridge.send('!room', 'one'), bridge.send('!room', 'two')]);
    expect(beeper.posts).toHaveLength(2);

    // The third message of the window goes out; the fourth WAITS even though it is a
    // different limb — the count is node-wide, exactly as the operator specified.
    const third = shell.send('main', 'three');
    const fourth = shell.send('main', 'four');
    await flush();
    expect(frames.map((f) => f.text)).toEqual(['three']);

    await clock.advance(5000);
    await Promise.all([third, fourth]);
    expect(frames.map((f) => f.text)).toEqual(['three', 'four']);
  });

  it('7. survives the shell-aware facade — the path the 2026-07-25 flood actually took', async () => {
    // createSender / the mesh service render through makeShellAwareBridge, which SPREADS the
    // bridge. A spread over a Proxy must still pick up the gated methods, or the regulator
    // would be bypassed on exactly the path a persona reply and a mesh envelope take.
    const clock = fakeClock();
    const beeper = fakePort(clock);
    const lasso = createLasso({ messages: 3, windowMs: 5000, now: clock.now, setTimeout: clock.setTimeout });
    const shellOwned = new Set(['main']);
    const shell = { owns: (c) => shellOwned.has(c), send: async () => true, startStream: () => ({}), postStatus: async () => null };
    const wrapped = lasso.wrap(beeper);
    const facade = makeShellAwareBridge(wrapped, lasso.wrap(shell));

    const all = Promise.all(Array.from({ length: 9 }, (_, i) => facade.send('!room', `flood ${i}`)));
    await flush();
    expect(beeper.posts).toHaveLength(3);
    await clock.advance(60_000);
    await all;
    expect(beeper.posts).toHaveLength(9);
    // The methods the facade did NOT override came off the spread — and they are the GATED
    // ones, not the raw port's (identity, so this cannot pass by accident).
    expect(facade.sendMedia).toBe(wrapped.sendMedia);
    expect(facade.sendMedia).not.toBe(beeper.sendMedia);
  });

  it('8. is off entirely when the operator sets messages <= 0', async () => {
    const clock = fakeClock();
    const port = fakePort(clock);
    const bridge = createLasso({ messages: -1, now: clock.now, setTimeout: clock.setTimeout }).wrap(port);
    await Promise.all(Array.from({ length: 50 }, (_, i) => bridge.send('!room', `x${i}`)));
    expect(port.posts).toHaveLength(50);
  });
});

// --- the LIVE seam: the bridge boot actually assembles -------------------------------
// Test 1 proves the regulator; these prove it is IN the path — and specifically that the two
// gaps are closed: the shell limb (shell-owned chats route to shellPort, bypassing the beeper
// port) and the 👂 echo (posted from inside the beeper limb, BELOW the port).
const tmpHome = join(os.tmpdir(), `egpt-lasso-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;

// Both come from the same dynamic import — makeShellAwareBridge is used by test 7 above, and a
// top-level beforeAll runs before every test in the file whatever the declaration order.
let boot, makeShellAwareBridge;
beforeAll(async () => { ({ boot, makeShellAwareBridge } = await import('../src/spine/boot.mjs')); });
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch {}
});

function fakeStart() {
  const spy = { onIncoming: null, echoGate: null, sent: [] };
  const start = async (opts) => {
    spy.onIncoming = opts.onIncoming;
    spy.echoGate = opts.echoGate;
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; },
      isAlive: () => true, stop() {},
    };
  };
  return { start, spy };
}

// A 50ms window keeps the real-timer drain to ~200ms while still proving the config plumbing.
async function bootNode(lasso = { messages: 3, window_ms: 50, max_queue: 50 }) {
  const { start, spy } = fakeStart();
  const app = await boot({
    readConfig: () => ({ whatsapp: {}, lasso, agents: { egpt: { configuration: 'egpt', handles: ['e'], default: true } } }),
    startBridge: start,
    makeSession: () => ({ sessionId: 's', async turn() { return { text: 'ok' }; }, close() {} }),
    loadState: async () => (await import('../src/conversations-state.mjs')).emptyState(),
    writeState: async () => {},
    ingest: false, tickMs: 0, log: { line: () => {} },
  });
  return { app, spy };
}

describe('boot() — the lasso is IN the assembled path, with no holes', () => {
  it('paces a flood through the bridge boot hands the spine', async () => {
    const { app, spy } = await bootNode();
    try {
      const t0 = Date.now();
      const all = Promise.all(Array.from({ length: 12 }, (_, i) => app.bridge.send('!room:beeper.com', `flood ${i}`)));
      await flush();
      expect(spy.sent).toHaveLength(3);          // ← FAILS on the pre-lasso boot: all 12 land at once
      await all;
      expect(spy.sent).toHaveLength(12);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(100);   // 12 at 3-per-50ms ⇒ at least 3 windows
    } finally { app.stop(); }
  });

  it('closes the SHELL gap — the shell limb shares the same budget', async () => {
    const { app } = await bootNode();
    try {
      await Promise.all([                       // saturate the window on the beeper limb
        app.bridge.send('!room:beeper.com', 'a'),
        app.bridge.send('!room:beeper.com', 'b'),
        app.bridge.send('!room:beeper.com', 'c'),
      ]);
      let out = false;
      const p = app.shellPort.send('main', 'shell line').then(() => { out = true; });
      await flush();
      expect(out).toBe(false);                  // ← FAILS on the pre-lasso boot: shellPort was unregulated
      await p;
      expect(out).toBe(true);
    } finally { app.stop(); }
  });

  it('closes the 👂 ECHO gap — the in-limb echo is gated by the same lasso', async () => {
    const { app, spy } = await bootNode();
    try {
      expect(spy.echoGate).toBeTypeOf('function');
      await Promise.all([
        app.bridge.send('!room:beeper.com', 'a'),
        app.bridge.send('!room:beeper.com', 'b'),
        app.bridge.send('!room:beeper.com', 'c'),
      ]);
      let echoed = false;
      const p = spy.echoGate(() => { echoed = true; return 'posted'; });
      await flush();
      expect(echoed).toBe(false);               // ← FAILS on the pre-lasso boot: no gate existed at all
      expect(await p).toBe('posted');
      expect(echoed).toBe(true);
    } finally { app.stop(); }
  });

  it('publishes its state to EGPT_HOME/state/lasso.json when it engages', async () => {
    const { app } = await bootNode();
    try {
      await Promise.all(Array.from({ length: 6 }, (_, i) => app.bridge.send('!room:beeper.com', `x${i}`)));
      await flush();
      const raw = await fs.readFile(join(tmpHome, 'state', 'lasso.json'), 'utf8');
      const state = JSON.parse(raw);
      expect(state.limit).toEqual({ messages: 3, window_ms: 50, max_queue: 50 });
      expect(['throttling', 'idle']).toContain(state.state);
      expect(state.delayed_total).toBeGreaterThan(0);
    } finally { app.stop(); }
  });
});
