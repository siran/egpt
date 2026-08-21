// lasso.test.mjs — THE OUTBOUND CEILING (src/lasso.mjs), reproduce-first.
//
// THE LIVE FAILURE (2026-07-25): two nodes traded hundreds of messages ~0.7s apart until the
// service had to be killed. Nothing bounded what LEAVES the node.
//
// THE REVERSAL (operator 2026-07-26): "oh, by throttle i did actually mean stop. there is
// probably a bug if there is flooding" / "bridge stops looping until human intervention". So
// an over-ceiling emit no longer WAITS its turn — it STOPS THE NODE, through the same
// EGPT_HOME/STOP kill switch the STOP safe word pulls. These tests fail on the pre-reversal
// lasso, which queued instead: the 21st message came out late rather than writing STOP.
//
// TWO COUNTERS (operator: "only count outbound messages or edits"): committed MESSAGES are
// tight (a new line in someone's chat is the damage); EDITS are loose (they make ONE line
// flicker). Both trip the same way.
//
// The clock is injected everywhere — no test waits on real time.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createLasso } from '../src/lasso.mjs';
import { createShellPort } from '../src/bridges/shell-port.mjs';
import { responseFrame } from '../src/shell/auth.mjs';
// The shell token the fake editor below authenticates with — the limb refuses to dial without one.
const SHELL_TOKEN = 'test-shell-token';
// boot.mjs is imported DYNAMICALLY below (never statically): egpt-home.mjs reads EGPT_HOME
// once at module load, and a static import would bind the PRODUCTION profile before this file
// points it at a throwaway one.

// Let every pending microtask + already-resolved await chain run.
const flush = () => new Promise((r) => setImmediate(r));

// A driveable clock. There are no timers left in the lasso — nothing waits — so this is a
// clock and nothing more.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance(ms) { t += ms; } };
}

// A recording limb port with the shape the lasso wraps (beeper-port / shell-port).
function fakePort(clock) {
  const posts = [];
  return {
    posts,
    async send(chat, text) { posts.push({ at: clock.now(), kind: 'send', chat, text }); return { ok: true }; },
    async postStatus(chat, text) { posts.push({ at: clock.now(), kind: 'postStatus', chat, text }); return 'id-1'; },
    async sendMedia(chat, filePath) { posts.push({ at: clock.now(), kind: 'sendMedia', chat, filePath }); return true; },
    editStatus(chat, msgId, text) { posts.push({ at: clock.now(), kind: 'editStatus', chat, text }); return true; },
    editOwn(chat, msgId, text) { posts.push({ at: clock.now(), kind: 'editOwn', chat, text }); return true; },
    deleteStatus(chat, msgId) { posts.push({ at: clock.now(), kind: 'deleteStatus', chat }); return true; },
    deleteOwn(chat, msgId) { posts.push({ at: clock.now(), kind: 'deleteOwn', chat }); return true; },
    react(chat, msgId, emoji) { posts.push({ at: clock.now(), kind: 'react', chat, emoji }); return true; },
    startStream(chat, init) {
      const h = { delivered: false, lastError: null, frames: [] };
      posts.push({ at: clock.now(), kind: 'startStream', chat, text: init, handle: h });
      h.update = (t) => h.frames.push(t);
      h.finish = async (t) => { h.frames.push(t); h.delivered = true; };
      h.delete = async () => { h.frames.push('<deleted>'); };
      h.fail = (e) => h.frames.push(`❌ ${e}`);
      return h;
    },
    isAlive: () => true,
    stop() {},
  };
}

// The lasso under test, with the trip captured instead of taken.
function withTrips(over = {}) {
  const clock = fakeClock();
  const trips = [];
  const logs = [];
  const states = [];
  const port = fakePort(clock);
  const lasso = createLasso({
    messages: 20, windowMs: 5000, edits: 2000,
    now: clock.now, onTrip: (t) => trips.push(t),
    onLog: (m) => logs.push(m), writeState: (s) => states.push(s),
    ...over,
  });
  return { clock, trips, logs, states, port, lasso, bridge: lasso.wrap(port) };
}

describe('lasso — the outbound ceiling', () => {
  it('1. an over-ceiling MESSAGE stops the node — it is not queued, not sent late', async () => {
    const { trips, logs, port, lasso, bridge } = withTrips();

    // The ceiling is a HARD ceiling: 20 leave, the 21st does not.
    const ok = await Promise.all(Array.from({ length: 20 }, (_, i) => bridge.send('!room', `m ${i}`)));
    expect(ok.every((r) => r?.ok)).toBe(true);
    expect(port.posts).toHaveLength(20);
    expect(trips).toEqual([]);

    const over = await bridge.send('!room', 'the 21st');
    expect(over).toBe(null);                    // ← the pre-reversal lasso RESOLVED this, late
    expect(port.posts).toHaveLength(20);        // it never reached the limb at all

    // Tripped ONCE, and it says WHY: the kind, the count and the ceiling that was crossed.
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ kind: 'message', count: 21, limit: 20, window_ms: 5000 });
    expect(trips[0].reason).toBe('outbound message flood — 21 messages in 5000ms (ceiling 20)');
    expect(logs.some((m) => m.includes('TRIPPED') && m.includes('ceiling 20'))).toBe(true);

    // The node is going down: everything after is refused, and the trip does not fire again.
    expect(await bridge.send('!room', 'after')).toBe(null);
    expect(await bridge.postStatus('!room', '🤔')).toBe(null);
    expect(await bridge.sendMedia('!room', '/tmp/x.png')).toBe(false);
    expect(trips).toHaveLength(1);
    expect(lasso.stats()).toMatchObject({ messages: 20, tripped: { kind: 'message' } });
  });

  it('2. a burst UNDER the ceiling sends normally, and the window slides', async () => {
    const { clock, trips, port, bridge } = withTrips();

    await Promise.all(Array.from({ length: 19 }, (_, i) => bridge.send('!room', `m ${i}`)));
    expect(port.posts).toHaveLength(19);
    expect(trips).toEqual([]);

    // Past the window the old stamps are gone — a busy minute is not a flood.
    clock.advance(5000);
    await Promise.all(Array.from({ length: 20 }, (_, i) => bridge.send('!room', `n ${i}`)));
    expect(port.posts).toHaveLength(39);
    expect(trips).toEqual([]);
  });

  it('3. an ordinary streamed reply is ONE message — its frames are EDITS, never messages', async () => {
    const { trips, port, lasso, bridge } = withTrips();

    // Exactly what src/spine/sender.mjs does per reply.
    const stream = bridge.startStream('!room', '⏳ Thinking…', { bodyEmoji: '🐶' });
    stream.update('Hel');
    stream.update('Hello th');
    stream.update('Hello there');
    await stream.finish('Hello there!');
    await flush();

    expect(port.posts).toHaveLength(1);                       // ONE committed message
    expect(port.posts[0].handle.frames).toEqual(['Hel', 'Hello th', 'Hello there', 'Hello there!']);
    expect(stream.delivered).toBe(true);                      // the §7 fallback stays off
    // finish is an EDIT (it PUTs into the placeholder startStream already counted), so the
    // reply costs 1 message and 4 edits — never 2 messages.
    expect(lasso.stats()).toMatchObject({ messages: 1, edits: 4, tripped: null });

    // 20 consecutive ordinary replies still leave — 20 messages, 40 edits, no trip.
    for (let i = 0; i < 19; i++) {
      const s = bridge.startStream('!room', '⏳ Thinking…', {});
      s.update('x'); await s.finish('done');
    }
    await flush();
    expect(port.posts).toHaveLength(20);
    expect(lasso.stats()).toMatchObject({ messages: 20, edits: 42, tripped: null });
    expect(trips).toEqual([]);
  });

  it('4. EDITS have their OWN ceiling — an infinite-edit runaway stops the node too', async () => {
    const { trips, port, lasso, bridge } = withTrips({ edits: 10 });

    const s = bridge.startStream('!room', '⏳ Thinking…', {});   // 1 message, 0 edits
    for (let i = 0; i < 10; i++) s.update(`frame ${i}`);
    expect(port.posts[0].handle.frames).toHaveLength(10);
    expect(trips).toEqual([]);

    s.update('the 11th');                                        // ← over the EDIT ceiling
    expect(port.posts[0].handle.frames).toHaveLength(10);        // never reached the limb
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ kind: 'edit', count: 11, limit: 10 });
    expect(trips[0].reason).toBe('outbound edit flood — 11 edits in 5000ms (ceiling 10)');

    // The MESSAGE budget was never spent by those edits — the counters are separate.
    expect(lasso.stats()).toMatchObject({ messages: 1, edits: 10 });

    // editStatus / editOwn are edits too — the same ceiling, the same trip.
    expect(bridge.editOwn('!room', 'id', 'x')).toBe(null);
    expect(bridge.editStatus('!room', 'id', 'x')).toBe(null);
    expect(trips).toHaveLength(1);
  });

  it('5. NEVER the STOP path — bypassLasso still gets out AFTER a trip', async () => {
    const { trips, port, bridge } = withTrips({ messages: 3 });

    await Promise.all(Array.from({ length: 4 }, (_, i) => bridge.send('!room', `flood ${i}`)));
    expect(trips).toHaveLength(1);
    expect(port.posts).toHaveLength(3);

    // The worst possible moment for a kill switch — the lasso has already tripped.
    const stopped = await bridge.send('!room', '🛑 STOP received — egpt is stopping', { bypassLasso: true });
    expect(stopped).toEqual({ ok: true });
    expect(port.posts.at(-1).text).toContain('STOP received');   // out NOW, past the tripped gate
    expect(port.posts).toHaveLength(4);
  });

  it('6. reactions and deletes are NEITHER a message nor an edit', async () => {
    const { trips, port, lasso, bridge } = withTrips({ messages: 1, edits: 1 });

    // No text, so no counter: a reaction is not a line in a chat, a delete removes one.
    for (let i = 0; i < 50; i++) {
      bridge.react('!room', 'id', '👍');
      bridge.deleteStatus('!room', 'id');
      bridge.deleteOwn('!room', 'id');
    }
    expect(port.posts).toHaveLength(150);
    expect(lasso.stats()).toMatchObject({ messages: 0, edits: 0, tripped: null });
    expect(trips).toEqual([]);
  });

  it('7. is ONE budget across every limb — a shell send and a beeper send share it', async () => {
    const clock = fakeClock();
    const trips = [];
    const beeper = fakePort(clock);
    const lasso = createLasso({ messages: 3, windowMs: 5000, now: clock.now, onTrip: (t) => trips.push(t) });

    // The real shell port, over a fake editor socket. The fake editor also ANSWERS THE AUTH
    // CHALLENGE (src/shell/auth.mjs): the limb sends nothing and trusts nothing until the peer
    // proves it holds the shell token, so a fake that only opens would never go ready.
    const frames = [];
    class FakeWS {
      constructor() { this._h = {}; }
      on(ev, cb) { (this._h[ev] ||= []).push(cb); if (ev === 'open') queueMicrotask(cb); }
      send(f) {
        const j = JSON.parse(f);
        if (j.auth === 'challenge') { for (const cb of (this._h.message || [])) cb(Buffer.from(responseFrame(SHELL_TOKEN, j.nonce))); return; }
        frames.push(j);
      }
      close() {}
    }
    const shell = lasso.wrap(createShellPort({ WebSocket: FakeWS, token: SHELL_TOKEN }));
    shell.start();
    await flush();

    // The Proxy must not freeze a GETTER (a spread would have): isConnected is live.
    expect(shell.isConnected).toBe(true);

    const bridge = lasso.wrap(beeper);
    await Promise.all([bridge.send('!room', 'one'), bridge.send('!room', 'two')]);
    expect(beeper.posts).toHaveLength(2);

    // The third message of the window goes out; the fourth is over the ceiling even though it
    // is a DIFFERENT limb — the count is node-wide, exactly as the operator specified.
    expect(await shell.send('main', 'three')).toBe(true);
    expect(await shell.send('main', 'four')).toBe(null);
    expect(frames.map((f) => f.text)).toEqual(['three']);
    expect(trips).toHaveLength(1);
  });

  it('8. survives the shell-aware facade — the path the 2026-07-25 flood actually took', async () => {
    // createSender / the mesh service render through makeShellAwareBridge, which SPREADS the
    // bridge. A spread over a Proxy must still pick up the gated methods, or the ceiling would
    // be bypassed on exactly the path a persona reply and a mesh envelope take.
    const clock = fakeClock();
    const trips = [];
    const beeper = fakePort(clock);
    const lasso = createLasso({ messages: 3, windowMs: 5000, now: clock.now, onTrip: (t) => trips.push(t) });
    const shellOwned = new Set(['main']);
    const shell = { owns: (c) => shellOwned.has(c), send: async () => true, startStream: () => ({}), postStatus: async () => null };
    const wrapped = lasso.wrap(beeper);
    const facade = makeShellAwareBridge(wrapped, lasso.wrap(shell));

    await Promise.all(Array.from({ length: 9 }, (_, i) => facade.send('!room', `flood ${i}`)));
    expect(beeper.posts).toHaveLength(3);
    expect(trips).toHaveLength(1);
    // The methods the facade did NOT override came off the spread — and they are the GATED
    // ones, not the raw port's (identity, so this cannot pass by accident).
    expect(facade.sendMedia).toBe(wrapped.sendMedia);
    expect(facade.sendMedia).not.toBe(beeper.sendMedia);
  });

  it('9. is off entirely when the operator sets messages <= 0; edits: 0 disables only edits', async () => {
    const clock = fakeClock();
    const trips = [];
    const port = fakePort(clock);
    const bridge = createLasso({ messages: -1, now: clock.now, onTrip: (t) => trips.push(t) }).wrap(port);
    await Promise.all(Array.from({ length: 50 }, (_, i) => bridge.send('!room', `x${i}`)));
    const s = bridge.startStream('!room', '⏳', {});
    for (let i = 0; i < 50; i++) s.update(`f${i}`);
    expect(port.posts).toHaveLength(51);
    expect(trips).toEqual([]);

    const port2 = fakePort(clock);
    const b2 = createLasso({ messages: 20, edits: 0, now: clock.now, onTrip: (t) => trips.push(t) }).wrap(port2);
    const s2 = b2.startStream('!room', '⏳', {});
    for (let i = 0; i < 500; i++) s2.update(`f${i}`);
    expect(port2.posts[0].handle.frames).toHaveLength(500);   // edit counter off…
    await Promise.all(Array.from({ length: 20 }, () => b2.send('!room', 'x')));
    expect(trips).toHaveLength(1);                            // …the message ceiling still trips
    expect(trips[0].kind).toBe('message');
  });

  it('10. the SHIPPED defaults are 18 messages / 10000ms and 4000 edits (operator: raise the ceiling, not a classification branch)', async () => {
    const clock = fakeClock();
    const trips = [];
    const port = fakePort(clock);
    const bridge = createLasso({ now: clock.now, onTrip: (t) => trips.push(t) }).wrap(port);
    await Promise.all(Array.from({ length: 18 }, () => bridge.send('!room', 'x')));
    expect(trips).toEqual([]);
    await bridge.send('!room', 'the 19th');
    expect(trips[0]).toMatchObject({ limit: 18, window_ms: 10000, kind: 'message' });

    const port2 = fakePort(clock);
    const b2 = createLasso({ now: clock.now, onTrip: (t) => trips.push(t) }).wrap(port2);
    const s = b2.startStream('!room', '⏳', {});
    for (let i = 0; i < 4000; i++) s.update(`f${i}`);
    expect(trips).toHaveLength(1);
    s.update('the 4001st');
    expect(trips[1]).toMatchObject({ limit: 4000, kind: 'edit' });
  });
});

// --- the LIVE seam: the bridge boot actually assembles -------------------------------
// The unit tests above prove the ceiling; these prove it is IN the path, that the trip pulls
// the SAME kill switch the STOP safe word pulls, and that the two known gaps stay closed:
// the shell limb (shell-owned chats route to shellPort, bypassing the beeper port) and the
// 👂 echo (posted from inside the beeper limb, BELOW the port).
const tmpHome = join(os.tmpdir(), `egpt-lasso-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;
const STOP_PATH = join(tmpHome, 'STOP');
const LASSO_JSON = join(tmpHome, 'state', 'lasso.json');

// Both come from the same dynamic import — makeShellAwareBridge is used by test 8 above, and a
// top-level beforeAll runs before every test in the file whatever the declaration order.
let boot, makeShellAwareBridge;
beforeAll(async () => { ({ boot, makeShellAwareBridge } = await import('../src/spine/boot.mjs')); });
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch {}
});
// writeStopFile NEVER clobbers, and boot REFUSES to start while the file exists — so every
// case starts from a node that may run.
beforeEach(async () => { await fs.rm(STOP_PATH, { force: true }); await fs.rm(LASSO_JSON, { force: true }); });

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

async function bootNode(lasso = { messages: 3, window_ms: 5000 }) {
  const { start, spy } = fakeStart();
  const exits = [];
  const logs = [];
  const app = await boot({
    readConfig: () => ({ whatsapp: {}, node_name: 'kg', lasso, agents: { egpt: { configuration: 'egpt', handles: ['e'], default: true } } }),   // node_name is MANDATORY since 2026-07-26 (the structural node signature)
    startBridge: start,
    makeSession: () => ({ sessionId: 's', async turn() { return { text: 'ok' }; }, close() {} }),
    loadState: async () => (await import('../src/conversations-state.mjs')).emptyState(),
    writeState: async () => {},
    ingest: false, tickMs: 0, exit: (c) => exits.push(c), log: { line: (s) => logs.push(s) },
  });
  return { app, spy, exits, logs };
}

// The publisher is DELIBERATELY fire-and-forget and non-atomic (boot.mjs:
// `writeFile(…).catch(() => {})`), so the test waits for the file instead of assuming it.
// Missing / never-parseable both FAIL.
async function waitForLassoState(boundMs = 5000) {
  const deadline = Date.now() + boundMs;
  let why = 'never appeared';
  for (;;) {
    try { return JSON.parse(await fs.readFile(LASSO_JSON, 'utf8')); }
    catch (e) { why = e?.message ?? String(e); }
    if (Date.now() >= deadline) throw new Error(`state/lasso.json after ${boundMs}ms: ${why}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('boot() — an over-ceiling emit pulls the SAME kill switch the safe word pulls', () => {
  it('writes EGPT_HOME/STOP naming the flood and the rate, and exits CLEAN', async () => {
    const { app, spy, exits, logs } = await bootNode();
    try {
      const out = await Promise.all(Array.from({ length: 4 }, (_, i) => app.bridge.send('!room:beeper.com', `flood ${i}`)));
      await flush();

      expect(spy.sent).toHaveLength(3);              // ← the pre-reversal lasso sent all 4, late
      expect(out.at(-1)).toBe(null);

      // THE SAME PRIMITIVE, not a second one: the STOP file (src/stop-guard.mjs writeStopFile)
      // and CLEAN_EXIT_CODE, so the daemon does not respawn and only a human restart clears it.
      expect(existsSync(STOP_PATH)).toBe(true);
      expect(exits).toEqual([0]);

      // …and it says WHY, so a flood-stop is not mistaken for a safe-word stop.
      const stopFile = await fs.readFile(STOP_PATH, 'utf8');
      expect(stopFile).toContain('reason: lasso: outbound message flood — 4 messages in 5000ms (ceiling 3)');
      expect(stopFile).toContain('who:    lasso');
      expect(stopFile).toContain(`rm ${STOP_PATH}`);        // the human act that clears it
      expect(logs.join('\n')).toContain('TRIPPED');
    } finally { app.stop(); }
  });

  it('publishes the trip to EGPT_HOME/state/lasso.json', async () => {
    const { app } = await bootNode();
    try {
      await Promise.all(Array.from({ length: 4 }, (_, i) => app.bridge.send('!room:beeper.com', `x${i}`)));
      const state = await waitForLassoState();
      expect(state).toMatchObject({
        state: 'tripped',
        limit: { messages: 3, edits: 4000, window_ms: 5000 },
        tripped: { kind: 'message', count: 4, limit: 3 },
      });
    } finally { app.stop(); }
  });

  it('ships 18 messages / 10000ms and 4000 edits when the config carries no lasso: block at all', async () => {
    const { app } = await bootNode({});   // {} → boot.mjs's OWN fallback literals, not a test override
    try {
      const out = await Promise.all(Array.from({ length: 19 }, (_, i) => app.bridge.send('!room:beeper.com', `x${i}`)));
      expect(out.filter((r) => r != null)).toHaveLength(18);   // the 19th is refused
      const state = await waitForLassoState();
      expect(state.limit).toMatchObject({ messages: 18, edits: 4000, window_ms: 10000 });
      expect(state.tripped).toMatchObject({ kind: 'message', count: 19, limit: 18 });
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
      expect(existsSync(STOP_PATH)).toBe(false);
      expect(await app.shellPort.send('main', 'shell line')).toBe(null);   // ← was unregulated pre-lasso
      expect(existsSync(STOP_PATH)).toBe(true);                            // the shell limb trips it too
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
      expect(await spy.echoGate(() => { echoed = true; return 'posted'; })).toBe(null);
      expect(echoed).toBe(false);               // ← FAILS on the pre-lasso boot: no gate existed at all
      expect(existsSync(STOP_PATH)).toBe(true); // the echo spends the SAME budget, and trips it
    } finally { app.stop(); }
  });
});
