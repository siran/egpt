// THE RESTART DRAIN (operator 2026-09-28, verbatim: "yes, restart should wait for turns in progress").
//
// THE INCIDENT. kg, 16:10: a deploy (setup/upgrade.ps1 drops /upgrade into the ingest box) bounced
// the spine while being Ken had a live turn in chat delen4 — the operator's steered message had just
// been taken and Ken was running a WebSearch. /upgrade left the moment it was read; the turn died
// with the process and the question was never answered.
//
// So /restart (43) and /upgrade (42) now go through spine.drainForRestart: the spine KEEPS SERVING,
// and leaves at the first moment turns.mjs's `trains` is empty — no cap (2026-10-26); `force` waits for
// nothing. /rewind (44), STOP and the daemon's wedge-kill stay immediate.
//
// Two halves. The SPINE half drives createSpine directly with an injected interval + clock, so the
// poll, the 30 s line and the 30-min notice are exercised without waiting. The BOOT half is the reproduction:
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
const NOTICE_MS = 30 * 60_000;

const flush = () => new Promise((r) => setTimeout(r, 0));

// ── THE SPINE HALF ──────────────────────────────────────────────────────────────────────────────
// Fakes where EVERY turn is held open until the test releases it by body, so several conversations
// can be in flight at once.
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

function build(extra = {}) {
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
    ...extra,
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
    expect(drainLines()).toEqual([`drain: waiting for 1 turn(s) before restarting — ${KEY_A} (no cap — /restart force skips the wait; new messages are still answered)`]);

    timers.fire();
    expect(exits).toEqual([]);                                    // still writing, still here

    brain.release('one');
    await p1;
    timers.fire();
    expect(exits).toEqual(['exit']);                              // …and gone at the first idle poll
    expect(timers.armed()).toEqual([]);
    expect(drainLines().at(-1)).toBe('drain: nothing in flight after 0s — restarting');
  });

  it('/update beeper drains the same way under its own name, and nothing exits', async () => {
    const { spine, bridge, brain, timers, drainLines } = build();
    const p1 = bridge.emit(msg('one', A, 'm1'));
    await flush();
    const ran = [];
    spine.drainForRestart(() => ran.push('update'), { purpose: 'restarting Beeper for the update' });
    expect(drainLines()).toEqual([`drain: waiting for 1 turn(s) before restarting Beeper for the update — ${KEY_A} (no cap — /restart force skips the wait; new messages are still answered)`]);
    brain.release('one');
    await p1;
    timers.fire();
    expect(ran).toEqual(['update']);
    expect(drainLines().at(-1)).toBe('drain: nothing in flight after 0s — restarting Beeper for the update');
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
    expect(published).toEqual([{ since, busy: [KEY_A], turns: 1, background: [] }]);

    clock.t += 29_000; timers.fire();
    expect(drainLines()).toHaveLength(1);                         // not yet
    clock.t += 1_000; timers.fire();
    await flush();
    expect(drainLines()[1]).toBe(`drain: still waiting after 30s — 1 turn(s): ${KEY_A}`);
    expect(published).toHaveLength(2);
    clock.t += 1_000; timers.fire();
    expect(drainLines()).toHaveLength(2);                         // one line per ~30 s, not per poll
  });

  it('NO CAP (2026-10-26): a turn past 30 min still holds the restart, the logging group is told, and it leaves when the turn lands', async () => {
    const posted = [];
    const { spine, bridge, brain, timers, clock, drainLines } = build({ logToGroup: async (t) => { posted.push(t); } });
    const p1 = bridge.emit(msg('one', A, 'm1'));
    await flush();
    const exits = [];
    spine.drainForRestart(() => exits.push('exit'));

    clock.t += NOTICE_MS; timers.fire();
    clock.t += 3 * NOTICE_MS; timers.fire();
    expect(exits).toEqual([]);
    expect(timers.armed()).toEqual([1000]);
    expect(posted).toEqual([`restart waiting 30m00s for 1 turn(s): ${KEY_A}. Send /restart force to proceed.`, `restart waiting 2h00m for 1 turn(s): ${KEY_A}. Send /restart force to proceed.`]);
    expect(drainLines().at(-1)).toBe(`drain: still waiting after 7200s — 1 turn(s): ${KEY_A}`);

    brain.release('one');
    await p1;
    timers.fire();
    expect(exits).toEqual(['exit']);
    expect(drainLines().at(-1)).toBe('drain: nothing in flight after 7200s — restarting');
  });

  it('force waits for no turn: it leaves at once and names what it leaves behind', async () => {
    const { spine, bridge, timers, drainLines } = build();
    bridge.emit(msg('one', A, 'm1'));                             // never released
    await flush();
    const exits = [];
    spine.drainForRestart(() => exits.push('exit'), { force: true });
    expect(exits).toEqual(['exit']);
    expect(timers.armed()).toEqual([]);
    expect(drainLines()).toEqual([`drain: force — not waiting for 1 turn(s): ${KEY_A}`]);
  });

  it('a force arriving while a turn holds the drain leaves at once — one exit, the pending one', async () => {
    const { spine, bridge, clock, timers, drainLines } = build();
    bridge.emit(msg('one', A, 'm1'));                             // never released
    await flush();
    const exits = [];
    spine.drainForRestart(() => exits.push('first'));
    clock.t += 45 * 60_000; timers.fire();
    spine.drainForRestart(() => exits.push('second'), { force: true });
    expect(exits).toEqual(['first']);
    expect(timers.armed()).toEqual([]);
    expect(drainLines().slice(-2)).toEqual([`drain: force — not waiting for 1 turn(s): ${KEY_A}`, 'drain: force — restarting after 2700s']);
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
});

// STEP C (INFORME-reinicios-sin-matar-agentes, 2026-10-16): a restart kills each warm `claude` and
// its background agents with it, so the drain waits for them too. Never capped into a kill: past 30
// min the logging group is told and the wait goes on. `/restart force` skips it (turns too, 2026-10-26).
describe('spine.drainForRestart — background work holds the restart, and is never cut short', () => {
  const T0 = 1_000_000;   // build()'s clock
  const iso = (ms) => new Date(ms).toISOString();
  const task = (over = {}) => ({ being: 'e', chatId: A, description: 'indexing the archive', since: T0 - 5 * 60_000, ...over });
  const SETTLE_MS = 10_000;

  it('(a)(b) background work alone holds the restart; it leaves once the work is gone and the wake window is quiet', () => {
    let tasks = [task()];
    const { spine, timers, clock, drainLines } = build({ backgroundWork: () => tasks });
    const exits = [];
    spine.drainForRestart(() => exits.push('exit'));
    expect(exits).toEqual([]);
    expect(timers.armed()).toEqual([1000]);
    expect(drainLines()).toEqual([`drain: waiting for 1 background task(s) before restarting — e/${A}: indexing the archive (5m00s) (no cap — /restart force skips the wait; new messages are still answered)`]);

    timers.fire();
    expect(exits).toEqual([]);
    tasks = [];
    clock.t += 1_000; timers.fire();
    expect(exits).toEqual([]);                                    // a finished task's wake may be on its way
    clock.t += SETTLE_MS; timers.fire();
    expect(exits).toEqual(['exit']);
    expect(timers.armed()).toEqual([]);
  });

  it('(b) the wake turn of a finished task is not cut: it starts inside the quiet window and the drain waits for it', async () => {
    let tasks = [task()];
    const { spine, bridge, brain, timers, clock } = build({ backgroundWork: () => tasks });
    const exits = [];
    spine.drainForRestart(() => exits.push('exit'));
    tasks = [];                                                   // the task finished…
    clock.t += 1_000; timers.fire();
    const wake = bridge.emit(msg('report', A, 'm-wake'));         // …and its report turn starts ~5 s later
    await flush();
    clock.t += SETTLE_MS; timers.fire();
    expect(exits).toEqual([]);
    brain.release('report');
    await wake;
    timers.fire();
    expect(exits).toEqual(['exit']);
  });

  it('(c) past 30 min: ONE line to the logging group, still waiting — repeated at most every 30 min', () => {
    const posted = [];
    const { spine, timers, clock } = build({ backgroundWork: () => [task()], logToGroup: async (t) => { posted.push(t); } });
    const exits = [];
    spine.drainForRestart(() => exits.push('exit'));

    clock.t += NOTICE_MS - 1; timers.fire();
    expect(posted).toEqual([]);
    clock.t += 1; timers.fire();
    expect(exits).toEqual([]);
    expect(posted).toEqual([`restart waiting 30m00s for background work: e/${A}: indexing the archive (35m00s). Send /restart force to proceed.`]);

    clock.t += 60_000; timers.fire();
    expect(posted).toHaveLength(1);
    clock.t += NOTICE_MS - 60_000; timers.fire();
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatch(/^restart waiting 1h00m for background work: /);
    expect(exits).toEqual([]);
  });

  it('a turn and background work together: the notice names both, and the wait goes on after the work is gone', async () => {
    let tasks = [task()];
    const posted = [];
    const { spine, bridge, timers, clock } = build({ backgroundWork: () => tasks, logToGroup: async (t) => { posted.push(t); } });
    bridge.emit(msg('one', A, 'm1'));                             // never released
    await flush();
    const exits = [];
    spine.drainForRestart(() => exits.push('exit'));

    clock.t += NOTICE_MS; timers.fire();
    expect(posted).toEqual([`restart waiting 30m00s for 1 turn(s): ${KEY_A}; background work: e/${A}: indexing the archive (35m00s). Send /restart force to proceed.`]);
    tasks = [];
    clock.t += 2 * NOTICE_MS; timers.fire();
    expect(exits).toEqual([]);
  });

  it('(d) force skips the background wait and the turn in flight alike', async () => {
    const { spine, bridge, timers, drainLines } = build({ backgroundWork: () => [task()] });
    bridge.emit(msg('one', A, 'm1'));
    await flush();
    const exits = [];
    spine.drainForRestart(() => exits.push('exit'), { force: true });
    expect(exits).toEqual(['exit']);
    expect(timers.armed()).toEqual([]);
    expect(drainLines()).toEqual([`drain: force — not waiting for 1 turn(s) and 1 background task(s): ${KEY_A}; e/${A}: indexing the archive (5m00s)`]);
  });

  it('background: false (/standdown) waits for the turn in flight, not for background work', async () => {
    const { spine, bridge, brain, timers, drainLines } = build({ backgroundWork: () => [task()] });
    const p1 = bridge.emit(msg('one', A, 'm1'));
    await flush();
    const exits = [];
    spine.drainForRestart(() => exits.push('exit'), { background: false });
    expect(drainLines()).toEqual([`drain: waiting for 1 turn(s) before restarting — ${KEY_A} (no cap — /restart force skips the wait; new messages are still answered)`]);
    brain.release('one');
    await p1;
    timers.fire();
    expect(exits).toEqual(['exit']);
  });

  it('(d) force with only background work leaves at once', () => {
    const { spine, timers } = build({ backgroundWork: () => [task()] });
    const exits = [];
    spine.drainForRestart(() => exits.push('exit'), { force: true });
    expect(exits).toEqual(['exit']);
    expect(timers.armed()).toEqual([]);
  });

  it('(d) a force arriving during a pending drain releases it — one exit, the pending one', () => {
    const { spine, timers } = build({ backgroundWork: () => [task()] });
    const exits = [];
    spine.drainForRestart(() => exits.push('first'));
    spine.drainForRestart(() => exits.push('second'), { force: true });
    expect(exits).toEqual(['first']);
    expect(timers.armed()).toEqual([]);
  });

  it('(e) the published drain names each task — being, chat, description, running time — and marks work started during the drain', async () => {
    let tasks = [task()];
    const published = [];
    const { spine, timers, clock, drainLines } = build({ backgroundWork: () => tasks });
    spine.drainForRestart(() => {}, { onWait: (rec) => published.push(rec) });
    await flush();
    expect(published).toEqual([{ since: iso(T0), busy: [], turns: 0, background: [{ being: 'e', chatId: A, description: 'indexing the archive', since: iso(T0 - 5 * 60_000), running: '5m00s', duringDrain: false }] }]);

    tasks = [...tasks, task({ chatId: B, description: 'crawl', since: T0 + 10_000 })];   // a turn started new work mid-drain: not blocked, reported
    clock.t += 30_000; timers.fire();
    await flush();
    expect(published[1].background[1]).toEqual({ being: 'e', chatId: B, description: 'crawl', since: iso(T0 + 10_000), running: '20s', duringDrain: true });
    expect(drainLines().at(-1)).toBe(`drain: still waiting after 30s — 2 background task(s): e/${A}: indexing the archive (5m30s); e/${B}: crawl (20s, started during the drain)`);
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
  const started = []; const gates = []; const bg = [];   // bg: the CLI's live background tasks ({ description, since })
  return {
    started, bg,
    release: () => { while (gates.length) gates.shift()(); },
    makeSession: (opts) => ({
      sessionId: opts.sessionId ?? 'sess-1',
      async turn(m, onUpdate) { started.push(m); await new Promise((r) => gates.push(r)); onUpdate?.('ok'); return { text: 'ok', sessionId: this.sessionId }; },
      get background() { return bg.length; },
      get backgroundTasks() { return bg.map((t) => ({ ...t })); },
      close() {},
    }),
  };
}

async function bootHeld(extra = {}) {
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
    ...extra,
  });
  live.push(app);
  const say = (body, { atE = false } = {}) => built[0].onIncoming(body, {
    chatId: SELF_DM, chatName: 'self-dm', network: 'whatsapp',
    userId: 'u-1', senderName: 'An', authorized: true, msgKey: `m-${body}-${Math.random()}`,
    atEStart: atE, atEAnywhere: atE,
  });
  return { app, sessions, timers, exits, lines, say, sent: () => built[0].sent };
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

    await say('/e upgrade');
    await flush();
    expect(exits).toEqual([]);                                    // ← before this change: [42], the turn still open

    expect(await waitFor(() => existsSync(DRAINING))).toBe(true);
    const rec = JSON.parse(readFileSync(DRAINING, 'utf8'));
    expect(rec).toMatchObject({ turns: 1, since: '2026-09-28T16:10:00.000Z' });
    expect(rec).not.toHaveProperty('cap');
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
    await say('/e upgrade');
    expect(await waitFor(() => exits.length > 0)).toBe(true);
    expect(exits).toEqual([42]);
    expect(existsSync(DRAINING)).toBe(false);
  });

  it('an /upgrade arriving during a /restart\'s drain makes it leave as the /upgrade — one drain, exit 42', async () => {
    const { sessions, timers, exits, say, lines } = await bootHeld();
    const turn = say('e busca esto', { atE: true });
    await waitFor(() => sessions.started.length === 1);
    await say('/e restart');
    await say('/e upgrade');
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
    await say('/e rewind abc1234');
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
    await fs.writeFile(DRAINING, JSON.stringify({ since: '2026-09-28T16:00:00.000Z', busy: ['e:whatsapp:!x'], turns: 1, cap: 30 * 60_000 }));
    await bootHeld();
    expect(existsSync(DRAINING)).toBe(false);
  });
});

// STEP C end to end: a warm session whose CLI still runs a background task (the pool's own
// backgroundTasks), and the restart typed in Self.
describe('boot — a /restart with background work live on a warm session (step C)', () => {
  async function bootWithBackground() {
    const h = await bootHeld();
    const turn = h.say('e lanza un agente', { atE: true });
    await waitFor(() => h.sessions.started.length === 1);
    h.sessions.release();
    await turn;
    h.sessions.bg.push({ description: 'indexing the archive', since: Date.UTC(2026, 8, 28, 16, 0) });
    return h;
  }

  it('(a)(e) waits, names the task in state/draining.json — and /restart force proceeds', async () => {
    const { timers, exits, say } = await bootWithBackground();
    await say('/e restart');
    await flush();
    expect(exits).toEqual([]);
    expect(await waitFor(() => existsSync(DRAINING))).toBe(true);
    const rec = JSON.parse(readFileSync(DRAINING, 'utf8'));
    expect(rec).toMatchObject({ turns: 0, busy: [] });
    expect(rec.background).toEqual([{ being: 'egpt', chatId: SELF_DM, description: 'indexing the archive', since: '2026-09-28T16:00:00.000Z', running: '10m00s', duringDrain: false }]);

    timers.fire();
    await flush();
    expect(exits).toEqual([]);
    await say('/e restart force');
    expect(await waitFor(() => exits.length > 0)).toBe(true);
    expect(exits).toEqual([43]);
  });

  it('(f) /rewind stays immediate with background work live', async () => {
    const { exits, say } = await bootWithBackground();
    await say('/e rewind abc1234');
    expect(await waitFor(() => exits.length > 0)).toBe(true);
    expect(exits).toEqual([44]);
  });

  it('(f) STOP stays immediate with background work live', async () => {
    const { exits, say } = await bootWithBackground();
    await say('stop');
    expect(await waitFor(() => exits.length > 0)).toBe(true);
    expect(exits).toEqual([0]);
  });

  it('(f) the daemon\'s wedge-restart is a SIGTERM the spine answers with stop + exit — never the drain (source lock)', () => {
    const SPINE_MAIN = readFileSync(new URL('../egpt-spine.mjs', import.meta.url), 'utf8');
    expect(SPINE_MAIN).toContain("process.on('SIGTERM', () => stop(0));");
    expect(SPINE_MAIN).not.toMatch(/drainForRestart|announceAndExit/);
  });

  it('the ingest box carries force too (source lock): boot hands lifecycleForce(line) to announceAndExit', () => {
    const BOOT_SRC = readFileSync(new URL('../src/spine/boot.mjs', import.meta.url), 'utf8');
    expect(BOOT_SRC).toContain('await announceAndExit(code, { force: lifecycleForce(line) })');
  });
});

// /STANDDOWN (operator 2026-10-22, GENOME 6): the Session 1 daemon is waiting for this profile
// (state/s1.claim, injected here as successorWaiting). Turns in flight finish — the same drain, and
// new messages are still answered; background work is NOT waited for: it ends with the Session 0
// daemon, and each being whose work ends says so once where it ran. Then exit 45.
describe('boot — /standdown hands the profile to Session 1', () => {
  async function bootWithBackground(extra) {
    const h = await bootHeld(extra);
    const turn = h.say('e lanza un agente', { atE: true });
    await waitFor(() => h.sessions.started.length === 1);
    h.sessions.release();
    await turn;
    h.sessions.bg.push({ description: 'indexing the archive', since: Date.UTC(2026, 8, 28, 16, 0) });
    return h;
  }
  const stopped = (sent) => sent.filter((m) => m.text.startsWith('⏹'));

  it('nobody waiting for the profile: ignored — no drain, no exit, and it says why', async () => {
    const { exits, say, lines } = await bootHeld({ successorWaiting: () => false });
    await say('/e standdown');
    await flush();
    expect(exits).toEqual([]);
    expect(lines.some((l) => /standdown.*s1\.claim/.test(l))).toBe(true);
  });

  // contract 14.4
  it('a turn in flight finishes first; background work is not waited for; then exit 45', async () => {
    const h = await bootWithBackground({ successorWaiting: () => true });
    const turn = h.say('e otra cosa', { atE: true });
    await waitFor(() => h.sessions.started.length === 2);
    await h.say('/e standdown');
    await flush();
    expect(h.exits).toEqual([]);                         // the turn is still being written
    h.sessions.release();
    await turn;
    h.timers.fire();
    expect(await waitFor(() => h.exits.length > 0)).toBe(true);
    expect(h.exits).toEqual([45]);                        // the indexing task did not hold it
  });

  it('each being whose background work ends says so ONCE where it ran, naming the work', async () => {
    const h = await bootWithBackground({ successorWaiting: () => true });
    await h.say('/e standdown');
    expect(await waitFor(() => h.exits.length > 0)).toBe(true);
    expect(h.exits).toEqual([45]);
    const lines = stopped(h.sent());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ chatId: SELF_DM });
    expect(lines[0].text).toContain('indexing the archive');
    expect(lines[0].text).toMatch(/ask again/i);
  });

  it('no background work: no such line', async () => {
    const h = await bootHeld({ successorWaiting: () => true });
    await h.say('/e standdown');
    expect(await waitFor(() => h.exits.length > 0)).toBe(true);
    expect(h.exits).toEqual([45]);
    expect(stopped(h.sent())).toEqual([]);
  });

  it('Session 1 lets go while the turn drains: it stays — no exit, no line', async () => {
    let waiting = true;
    const h = await bootWithBackground({ successorWaiting: () => waiting });
    const turn = h.say('e otra cosa', { atE: true });
    await waitFor(() => h.sessions.started.length === 2);
    await h.say('/e standdown');
    waiting = false;                                      // a quick logoff
    h.sessions.release();
    await turn;
    h.timers.fire();
    await flush(); await flush();
    expect(h.exits).toEqual([]);
    expect(stopped(h.sent())).toEqual([]);
  });

  it('/standdown force leaves without waiting for the turn in flight', async () => {
    const h = await bootHeld({ successorWaiting: () => true });
    const turn = h.say('e busca esto', { atE: true });
    await waitFor(() => h.sessions.started.length === 1);
    await h.say('/e standdown force');
    expect(await waitFor(() => h.exits.length > 0)).toBe(true);
    expect(h.exits).toEqual([45]);
    h.sessions.release();
    await turn;
  });

  it('a Session 1 spine refuses it: nothing to hand over to', async () => {
    const { exits, say, lines } = await bootHeld({ session1: true, successorWaiting: () => true });
    await say('/e standdown');
    await flush();
    expect(exits).toEqual([]);
    expect(lines.some((l) => /standdown.*Session 1/.test(l))).toBe(true);
  });

  it('an /upgrade pending when it arrives still leaves as the /upgrade (42 outranks 45: the pull must happen)', async () => {
    const h = await bootHeld({ successorWaiting: () => true });
    const turn = h.say('e busca esto', { atE: true });
    await waitFor(() => h.sessions.started.length === 1);
    await h.say('/e upgrade');
    await h.say('/e standdown');
    h.sessions.release();
    await turn;
    h.timers.fire();
    expect(await waitFor(() => h.exits.length > 0)).toBe(true);
    expect(h.exits).toEqual([42]);
  });
});
