// THE RESTART DRAIN (operator 2026-09-28, verbatim: "yes, restart should wait for turns in progress").
//
// THE INCIDENT. kg, 16:10: a deploy (setup/upgrade.ps1 drops /upgrade into the ingest box) bounced
// the spine while being Ken had a live turn in chat delen4 — the operator's steered message had just
// been taken and Ken was running a WebSearch. /upgrade left the moment it was read; the turn died
// with the process and the question was never answered.
//
// So /restart (43) and /upgrade (42) now go through spine.drainForRestart: the spine KEEPS SERVING,
// and leaves at the first moment turns.mjs's `trains` is empty — or at the 30-minute cap. /rewind
// (44), STOP and the daemon's wedge-kill stay immediate; /standdown (45) keeps its own drain.
//
// Two halves. The SPINE half drives createSpine directly with an injected interval + clock, so the
// poll, the 30 s line and the cap are exercised without waiting. The BOOT half is the reproduction:
// the real boot(), a fake Beeper transport, a warm session whose turn is held open, and the typed
// command in Self — on the code before this change `/upgrade` exited 42 with the turn still open.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// A PRIVATE profile — boot writes state/spine.pid, the restart-announce sidecar and (now)
// state/draining.json under EGPT_HOME, which egpt-home.mjs freezes at module load.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-restart-drain-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createSpine } from '../src/spine/spine.mjs';

const DRAINING = join(_PRIVATE_HOME, 'state', 'draining.json');
const STOP_PATH = join(_PRIVATE_HOME, 'STOP');
const CAP_MS = 30 * 60_000;

const flush = () => new Promise((r) => setTimeout(r, 0));

// ── THE SPINE HALF ──────────────────────────────────────────────────────────────────────────────
// Fakes in the shape tests/spine-standdown.test.mjs uses, except that EVERY turn is held open until
// the test releases it by body, so several conversations can be in flight at once.
function fakeBridge() {
  let cb = null;
  return { onMessage(fn) { cb = fn; }, emit(msg) { return cb(msg); }, send() {}, stop() {} };
}
function recordingSender() {
  const placeholders = [];
  return {
    placeholders,
    open(chatId, opts = {}) {
      const ph = { chatId, opts, finished: null };
      placeholders.push(ph);
      return { activate() {}, update() {}, async finish(reply) { ph.finished = typeof reply === 'string' ? reply : reply?.text; }, async fail() {} };
    },
  };
}
function heldBrain() {
  const calls = [];
  const gates = new Map();
  return {
    calls,
    release: (body) => gates.get(body)?.(),
    async turn(being, ev) {
      calls.push(ev.body);
      await new Promise((res) => gates.set(ev.body, res));
      return { text: `reply-${ev.body}`, sessionId: 's' };
    },
  };
}
// The drain's poll is the ONLY interval this spine arms (tickMs 0), so the test fires it by hand.
function fakeIntervals() {
  const live = new Map();
  let seq = 0;
  return {
    setInterval: (fn, ms) => { const h = ++seq; live.set(h, { fn, ms }); return h; },
    clearInterval: (h) => { live.delete(h); },
    fire: () => { for (const { fn } of [...live.values()]) fn(); },
    armed: () => [...live.values()].map((t) => t.ms),
  };
}
const fakeIdentity = { build: (m) => ({ ...m, mention: m.mention ?? { atEStart: true, atEAnywhere: true, replyToBot: false }, line: m.body }) };
const fakeRouter = { resolve: () => ({ being: 'e', mention: { atEStart: true, atEAnywhere: true, replyToBot: false } }) };
const fakeGating = { async decide() { return { mode: 'mention', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true };

function build() {
  const bridge = fakeBridge();
  const sender = recordingSender();
  const brain = heldBrain();
  const timers = fakeIntervals();
  const clock = { t: 1_000_000, now() { return this.t; } };
  const lines = [];
  const spine = createSpine({
    bridge, brain, identity: fakeIdentity, router: fakeRouter, gating: fakeGating,
    sender, transcript: { async log() {} }, heartbeats: { runDue() {} },
    clock, log: { line: (s) => lines.push(s) },
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
  });
  spine.start();
  return { spine, bridge, sender, brain, timers, clock, lines, drainLines: () => lines.filter((l) => l.startsWith('drain:')) };
}

const msg = (body, chatId, msgId) => ({ surface: 'wa', node: 'wa', chatId, chatName: chatId, senderId: 'u', senderName: 'An', msgId, ts: 1000, body, kind: 'text', raw: {} });
const A = 'chat-A@g.us';
const B = 'chat-B@g.us';
const KEY_A = `e:wa:${A}`;
const KEY_B = `e:wa:${B}`;

describe('spine.drainForRestart — /restart and /upgrade wait for the turns in flight', () => {
  it('a turn IN FLIGHT holds the restart until it lands, and the start line names its conversation', async () => {
    const { spine, bridge, brain, timers, drainLines } = build();
    const p1 = bridge.emit(msg('one', A, 'm1'));
    await flush();
    expect(brain.calls).toEqual(['one']);

    const exits = [];
    spine.drainForRestart(() => exits.push('exit'));
    expect(exits).toEqual([]);
    expect(timers.armed()).toEqual([1000]);                       // polled once a second
    expect(drainLines()).toEqual([`drain: waiting for 1 turn(s) before restarting — ${KEY_A} (cap 30 min; new messages are still answered)`]);

    timers.fire();
    expect(exits).toEqual([]);                                    // still writing, still here

    brain.release('one');
    await p1;
    timers.fire();
    expect(exits).toEqual(['exit']);                              // …and gone at the first idle poll
    expect(timers.armed()).toEqual([]);
    expect(drainLines().at(-1)).toBe('drain: nothing in flight after 0s — restarting');
  });

  it('nothing in flight: it leaves synchronously — no timer, no line, no added delay', () => {
    const { spine, timers, drainLines } = build();
    const exits = [];
    spine.drainForRestart(() => exits.push('exit'));
    expect(exits).toEqual(['exit']);
    expect(timers.armed()).toEqual([]);
    expect(drainLines()).toEqual([]);
  });

  it('keeps SERVING while it drains, and a turn that starts DURING the drain extends it to the first idle moment', async () => {
    const { spine, bridge, brain, sender, timers } = build();
    const p1 = bridge.emit(msg('one', A, 'm1'));
    await flush();
    const exits = [];
    spine.drainForRestart(() => exits.push('exit'));

    const p2 = bridge.emit(msg('two', B, 'm2'));                 // arrives mid-drain
    await flush();
    expect(brain.calls).toEqual(['one', 'two']);                  // admitted and running — not refused, not held
    expect(sender.placeholders.map((p) => p.chatId)).toEqual([A, B]);

    brain.release('one');
    await p1;
    timers.fire();
    expect(exits).toEqual([]);                                    // 'two' is still being written

    brain.release('two');
    await p2;
    expect(sender.placeholders.map((p) => p.finished)).toEqual(['reply-one', 'reply-two']);   // both answered
    timers.fire();
    expect(exits).toEqual(['exit']);
  });

  it('a QUEUED turn counts: the drain waits for the whole train on that conversation', async () => {
    const { spine, bridge, brain, timers, drainLines } = build();
    const p1 = bridge.emit(msg('one', A, 'm1'));
    const p2 = bridge.emit(msg('two', A, 'm2'));                 // same conversation → queued behind 'one'
    await flush();
    await flush();
    const exits = [];
    spine.drainForRestart(() => exits.push('exit'));
    expect(drainLines()[0]).toContain(`waiting for 2 turn(s) before restarting — ${KEY_A} ×2`);

    brain.release('one');
    await p1;
    await flush();
    timers.fire();
    expect(exits).toEqual([]);                                    // 'two' has only now started
    expect(brain.calls).toEqual(['one', 'two']);
    brain.release('two');
    await p2;
    timers.fire();
    expect(exits).toEqual(['exit']);
  });

  it('says every ~30 s who it is still waiting for, and publishes that each time', async () => {
    const { spine, bridge, timers, clock, drainLines } = build();
    bridge.emit(msg('one', A, 'm1'));
    await flush();
    const published = [];
    spine.drainForRestart(() => {}, { onWait: (rec) => published.push(rec) });
    await flush();
    const since = new Date(clock.t).toISOString();
    expect(published).toEqual([{ since, busy: [KEY_A], turns: 1, cap: CAP_MS }]);

    clock.t += 29_000; timers.fire();
    expect(drainLines()).toHaveLength(1);                         // not yet
    clock.t += 1_000; timers.fire();
    await flush();
    expect(drainLines()[1]).toBe(`drain: still waiting after 30s — 1 turn(s): ${KEY_A}`);
    expect(published).toHaveLength(2);
    clock.t += 1_000; timers.fire();
    expect(drainLines()).toHaveLength(2);                         // one line per ~30 s, not per poll
  });

  it('THE CAP: a turn that never finishes cannot hold the restart past 30 min — it says so loudly and leaves', async () => {
    const { spine, bridge, timers, clock, drainLines } = build();
    bridge.emit(msg('one', A, 'm1'));                             // never released
    await flush();
    const exits = [];
    spine.drainForRestart(() => exits.push('exit'));

    clock.t += CAP_MS - 1; timers.fire();
    expect(exits).toEqual([]);
    clock.t += 1; timers.fire();
    expect(exits).toEqual(['exit']);
    expect(timers.armed()).toEqual([]);
    expect(drainLines().at(-1)).toBe(`drain: CAP — 1 turn(s) STILL in flight after 30 min: ${KEY_A} — restarting ANYWAY; they die with this process`);
  });

  it('a second /restart or /upgrade during the drain starts NO second drain', async () => {
    const { spine, bridge, brain, timers, drainLines } = build();
    const p1 = bridge.emit(msg('one', A, 'm1'));
    await flush();
    const exits = [];
    spine.drainForRestart(() => exits.push('first'));
    spine.drainForRestart(() => exits.push('second'));
    expect(timers.armed()).toEqual([1000]);                       // one poll
    expect(drainLines()[1]).toBe('drain: already waiting for turns in flight — no second drain');

    brain.release('one');
    await p1;
    timers.fire();
    timers.fire();
    expect(exits).toEqual(['first']);
  });

  it('a /restart during a STAND-DOWN leaves at once — it is the way out of a wedged stand-down', async () => {
    const { spine, bridge, brain } = build();
    const p1 = bridge.emit(msg('one', A, 'm1'));
    await flush();
    const exits = [];
    spine.standdown(() => exits.push('standdown'));
    spine.drainForRestart(() => exits.push('restart'));
    expect(exits).toEqual(['restart']);
    brain.release('one');
    await p1;
  });

  it('a /standdown during a restart drain takes it over — one exit, the 45', async () => {
    const { spine, bridge, brain, timers } = build();
    const p1 = bridge.emit(msg('one', A, 'm1'));
    await flush();
    const exits = [];
    spine.drainForRestart(() => exits.push('restart'));
    spine.standdown(() => exits.push('standdown'));
    expect(timers.armed()).toEqual([]);                           // the restart's poll is gone

    brain.release('one');
    await p1;
    await flush();
    timers.fire();
    expect(exits).toEqual(['standdown']);
  });
});

// ── THE BOOT HALF — THE REPRODUCTION ───────────────────────────────────────────────────────────
let boot, emptyState;
beforeAll(async () => {
  await fs.mkdir(join(_PRIVATE_HOME, 'state'), { recursive: true });
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});
const live = [];
afterEach(async () => {
  while (live.length) { try { live.pop().stop(); } catch { /* already stopped */ } }
  await fs.rm(STOP_PATH, { force: true });
  await fs.rm(DRAINING, { force: true });
});

const SELF_DM = '!self-dm';
const CONFIG = () => ({
  node_name: 'kg',
  user_name: 'An',
  networks: { whatsapp: { chat_ids: [SELF_DM], allowed_users: ['u-1'] } },
  beeper: { primary: { account: 'an@example.com', token: 'TOK' } },
  agents: { egpt: { configuration: 'egpt', default: true, handles: ['e'], name: 'E' } },
});

function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { onIncoming: opts.onIncoming, sent: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) { return { chatId: o?.chatId, update() {}, async finish() {} }; },
      async chatHasParticipant() { return null; },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}
function memIo() {
  const files = new Map(); const dirs = new Set();
  const missing = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    appendFile: async (p, d) => files.set(p, `${files.get(p) ?? ''}${d}`),
    writeFile: async (p, d) => files.set(p, String(d)),
    readFile: async (p) => { if (!files.has(p)) throw missing(p); return files.get(p); },
    mkdir: async (p) => { dirs.add(p); },
    existsSync: (p) => files.has(p) || dirs.has(p),
    readdir: async (p) => [...files.keys()].filter((f) => dirname(f) === p).map((f) => f.slice(p.length + 1)),
    rename: async (p, to) => { if (!files.has(p)) throw missing(p); files.set(to, files.get(p)); files.delete(p); },
  };
}
// A warm session whose every turn is HELD until the test lets it go — Ken, mid-WebSearch.
function heldSessions() {
  const started = []; const gates = [];
  return {
    started,
    release: () => { while (gates.length) gates.shift()(); },
    makeSession: (opts) => ({
      sessionId: opts.sessionId ?? 'sess-1',
      async turn(m, onUpdate) { started.push(m); await new Promise((r) => gates.push(r)); onUpdate?.('ok'); return { text: 'ok', sessionId: this.sessionId }; },
      close() {},
    }),
  };
}

async function bootHeld() {
  const { start, built } = fakeTransport();
  const sessions = heldSessions();
  const timers = fakeIntervals();
  const exits = [];
  const lines = [];
  let convState = emptyState();
  const app = await boot({
    readConfig: CONFIG,
    startBridge: start,
    makeSession: sessions.makeSession,
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io: memIo(),
    ingest: false,
    spawn: () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } }),
    reapPort: () => 0,
    exit: (code) => exits.push(code),
    now: () => Date.UTC(2026, 8, 28, 16, 10),
    tickMs: 0,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    log: { line: (s) => lines.push(s) },
  });
  live.push(app);
  const say = (body, { atE = false } = {}) => built[0].onIncoming(body, {
    chatId: SELF_DM, chatName: 'self-dm', network: 'whatsapp',
    userId: 'u-1', senderName: 'An', authorized: true, msgKey: `m-${body}-${Math.random()}`,
    atEStart: atE, atEAnywhere: atE,
  });
  return { app, sessions, timers, exits, lines, say };
}

async function waitFor(check, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return check();
}

describe('boot — a typed /upgrade with a turn in flight (the kg 16:10 incident)', () => {
  it('does NOT exit while the turn is being written; exits 42 once it lands — and says so in state/draining.json meanwhile', async () => {
    const { sessions, timers, exits, say } = await bootHeld();
    const turn = say('e busca esto', { atE: true });            // not awaited: it is held open
    expect(await waitFor(() => sessions.started.length === 1)).toBe(true);

    await say('/upgrade');
    await flush();
    expect(exits).toEqual([]);                                    // ← before this change: [42], the turn still open

    expect(await waitFor(() => existsSync(DRAINING))).toBe(true);
    const rec = JSON.parse(readFileSync(DRAINING, 'utf8'));
    expect(rec).toMatchObject({ turns: 1, cap: CAP_MS, since: '2026-09-28T16:10:00.000Z' });
    expect(rec.busy).toHaveLength(1);
    expect(rec.busy[0]).toContain(SELF_DM);

    sessions.release();
    await turn;
    timers.fire();
    expect(await waitFor(() => exits.length > 0)).toBe(true);
    expect(exits).toEqual([42]);
    expect(existsSync(DRAINING)).toBe(false);                     // removed on the way out
  });

  it('nothing in flight: /upgrade exits 42 as fast as before, and publishes no drain', async () => {
    const { exits, say } = await bootHeld();
    await say('/upgrade');
    expect(await waitFor(() => exits.length > 0)).toBe(true);
    expect(exits).toEqual([42]);
    expect(existsSync(DRAINING)).toBe(false);
  });

  it('an /upgrade arriving during a /restart\'s drain makes it leave as the /upgrade — one drain, exit 42', async () => {
    const { sessions, timers, exits, say, lines } = await bootHeld();
    const turn = say('e busca esto', { atE: true });
    await waitFor(() => sessions.started.length === 1);
    await say('/restart');
    await say('/upgrade');
    await flush();
    expect(exits).toEqual([]);
    expect(lines.filter((l) => l.includes('drain: waiting for'))).toHaveLength(1);

    sessions.release();
    await turn;
    timers.fire();
    expect(await waitFor(() => exits.length > 0)).toBe(true);
    expect(exits).toEqual([42]);
  });

  it('/rewind is NOT drained — it is the way back from bad code and leaves at once, turn or no turn', async () => {
    const { sessions, exits, say } = await bootHeld();
    const turn = say('e busca esto', { atE: true });
    await waitFor(() => sessions.started.length === 1);
    await say('/rewind abc1234');
    expect(await waitFor(() => exits.length > 0)).toBe(true);
    expect(exits).toEqual([44]);
    sessions.release();
    await turn;
  });

  it('STOP is NOT drained — the kill switch still stops point blank with a turn in flight', async () => {
    const { sessions, exits, say } = await bootHeld();
    const turn = say('e busca esto', { atE: true });
    await waitFor(() => sessions.started.length === 1);
    await say('stop');
    expect(await waitFor(() => exits.length > 0)).toBe(true);
    expect(exits).toEqual([0]);
    sessions.release();
    await turn;
  });

  it('a draining.json left behind by a spine that died mid-drain is cleared at boot', async () => {
    await fs.writeFile(DRAINING, JSON.stringify({ since: '2026-09-28T16:00:00.000Z', busy: ['e:whatsapp:!x'], turns: 1, cap: CAP_MS }));
    await bootHeld();
    expect(existsSync(DRAINING)).toBe(false);
  });
});
