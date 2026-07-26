// stop-file.test.mjs — THE SAFE WORD IS A FILE (operator 2026-07-25, verbatim: "we must
// enforce a safe word in this lasso, if i write 'stop' all activity, whatever it is, must
// stop" / "better than only stopping service, is that if a file named STOP exists in .egpt
// it *also* stops... STOP in a chat writes this file that inoculates service").
//
// The contract, in three sentences:
//   EGPT_HOME/STOP exists  ->  the node does not run: boot refuses, and a RUNNING spine halts.
//   "stop" in a chat       ->  WRITES EGPT_HOME/STOP (with its provenance), then stops the service.
//   rm EGPT_HOME/STOP      ->  the node may start again. Nothing else persists a stopped state.
//
// "Stops the service" is not a new lifecycle code: the spine leaves through boot's `exit`
// seam with CLEAN_EXIT_CODE (0), which src/daemon-runtime.mjs already reads as "clean exit
// — egpt-daemon stopping (user wanted out)" and does NOT respawn (unlike 43/42/44). So the
// daemon needs no STOP check of its own — the switch lives in exactly one place.
//
// Runs against an isolated EGPT_HOME (a temp profile) so the STOP file, spine.pid and the
// heartbeat snapshot NEVER land in the live ~/.egpt — which is the very profile this feature
// is about. egpt-home.mjs freezes EGPT_HOME at module load, so it is set BEFORE the dynamic
// imports below.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';

const tmpHome = join(os.tmpdir(), `egpt-stop-file-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;
const STOP_PATH = join(tmpHome, 'STOP');

let boot, createSpine, createStopGuard, STOP_FILE, stopFilePresent, writeStopFile, emptyState;

beforeAll(async () => {
  await fs.mkdir(join(tmpHome, 'state'), { recursive: true });
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ createSpine } = await import('../src/spine/spine.mjs'));
  ({ createStopGuard, STOP_FILE, stopFilePresent, writeStopFile } = await import('../src/stop-guard.mjs'));
  ({ emptyState } = await import('../src/conversations-state.mjs'));
});

afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch {}
});

// Every case starts from a node that MAY run — the STOP file is the only state, so clearing
// it is the whole reset (contract (d): removing the file is sufficient).
beforeEach(async () => { await fs.rm(STOP_PATH, { force: true }); });

// --- boot harness: real services, fakes ONLY at the transport + process boundary ---------
function fakeStart() {
  const spy = { started: false, onIncoming: null, sent: [], streams: [] };
  const start = async (opts) => {
    spy.started = true;                       // ← the "did the bridge dial Beeper" assertion
    spy.onIncoming = opts.onIncoming;
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); } };
        spy.streams.push(h); return h;
      },
      isAlive: () => true, stop() {},
    };
  };
  return { start, spy };
}
const fakeSession = (opts) => ({
  sessionId: opts.sessionId ?? 'sess-1',
  async turn(message, onUpdate) { onUpdate?.(`↩ ${message}`); return { text: `↩ ${message}`, sessionId: this.sessionId }; },
  close() {},
});
function memIo() {
  const files = new Map(); const dirs = new Set();
  const missing = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    files,
    appendFile: async (p, d) => files.set(p, `${files.get(p) ?? ''}${d}`),
    writeFile: async (p, d) => files.set(p, String(d)),
    readFile: async (p) => { if (!files.has(p)) throw missing(p); return files.get(p); },
    mkdir: async (p) => { dirs.add(p); },
    existsSync: (p) => files.has(p) || dirs.has(p),
    readdir: async (p) => [...files.keys()].filter((f) => dirname(f) === p).map((f) => f.slice(p.length + 1)),
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
  };
}

const CONFIG = {
  whatsapp: { allowed_users: ['u-1'] },
  agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } },
};
const AT = Date.UTC(2026, 6, 25, 21, 40);

async function bootNode() {
  const { start, spy } = fakeStart();
  const exits = []; const logs = [];
  let state = emptyState();
  const app = await boot({
    readConfig: () => CONFIG,
    startBridge: start,
    makeSession: fakeSession,
    loadState: async () => state,
    writeState: async (s) => { state = s; },
    io: memIo(),
    ingest: false,
    now: () => AT,
    tickMs: 0,
    exit: (code) => exits.push(code),
    log: { line: (s) => logs.push(s) },
  });
  return { app, spy, exits, logs };
}

// A shell-surface inbound, byte-identical to what src/bridges/shell-port.mjs emits into
// spine.handleInbound (the documented direct-caller seam) — same `from` shape, same fields.
const shellMsg = (text, over = {}) => ({
  body: text,
  from: {
    chatId: 'main', chatName: 'shell', network: 'shell',
    userId: 'operator', senderName: 'operator', authorized: true, msgKey: null, ...over,
  },
});

describe('(a) boot refuses to start while EGPT_HOME/STOP exists', () => {
  it('exits through the injected seam and NEVER dials the bridge', async () => {
    await fs.writeFile(STOP_PATH, 'stopped by hand\n', 'utf8');
    const { app, spy, exits, logs } = await bootNode();
    expect(spy.started).toBe(false);              // the bridge start seam was NOT called
    expect(exits).toEqual([0]);                   // CLEAN_EXIT_CODE — the daemon stops, no respawn
    expect(app).toBeNull();                       // nothing was assembled
    const said = logs.join('\n');
    expect(said).toContain(STOP_PATH);            // names the file…
    expect(said.toLowerCase()).toContain('delete');   // …and how to clear it
  });

  it('(d)/(7) removing the file is sufficient — boot proceeds normally again', async () => {
    await fs.writeFile(STOP_PATH, 'stopped by hand\n', 'utf8');
    const first = await bootNode();
    expect(first.spy.started).toBe(false);

    await fs.rm(STOP_PATH, { force: true });      // the ONLY reset there is
    const { app, spy, exits } = await bootNode();
    expect(spy.started).toBe(true);               // dialed out as usual
    expect(exits).toEqual([]);                    // never left
    app.stop();
  });

  it('STOP_FILE is EGPT_HOME/STOP — profile root, beside config/ and state/', () => {
    expect(STOP_FILE).toBe(join(tmpHome, 'STOP'));
    expect(stopFilePresent(STOP_FILE)).toBe(false);
  });
});

describe('(b) a RUNNING spine halts when the file appears', () => {
  it('the operator touches EGPT_HOME/STOP from a terminal — the next tick stops the node', async () => {
    const { app, spy, exits } = await bootNode();
    expect(spy.started).toBe(true);
    expect(exits).toEqual([]);                    // running

    app.spine.tick();                             // a tick with no STOP file changes nothing
    expect(exits).toEqual([]);

    await fs.writeFile(STOP_PATH, 'touched\n', 'utf8');
    app.spine.tick();                             // the pulse that already exists — no watcher
    expect(exits).toEqual([0]);
    // the hand-written file is NOT clobbered — whatever the operator wrote survives
    expect(await fs.readFile(STOP_PATH, 'utf8')).toBe('touched\n');
    app.stop();
  });
});

describe('(c) the chat safe word writes the file, then stops the service', () => {
  it('"stop" on the SHELL surface: file written with reason + provenance, service stops', async () => {
    const { app, exits } = await bootNode();
    await app.spine.handleInbound(shellMsg('stop'));

    expect(existsSync(STOP_PATH)).toBe(true);
    const body = await fs.readFile(STOP_PATH, 'utf8');
    expect(body).toContain('stop');                                  // the reason: the safe word itself
    expect(body).toContain('operator');                              // who
    expect(body).toContain('shell');                                 // which surface
    expect(body).toContain('main');                                  // which chat
    expect(body).toContain(new Date(AT).toISOString());              // when
    expect(body.toLowerCase()).toContain('delete');                  // the file explains how to undo itself
    expect(exits).toEqual([0]);
    app.stop();
  });

  it('"STOP" on a BEEPER surface: identical', async () => {
    const { app, spy, exits } = await bootNode();
    await spy.onIncoming('STOP', {
      chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
      userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1',
    });

    expect(existsSync(STOP_PATH)).toBe(true);
    const body = await fs.readFile(STOP_PATH, 'utf8');
    expect(body).toContain('An');                                    // who
    expect(body).toContain('whatsapp');                              // which surface
    expect(body).toContain('!room:beeper.com');                      // which chat
    expect(exits).toEqual([0]);
    app.stop();
  });

  it('an UNAUTHORIZED sender\'s "stop" does NOTHING — no file, no stop', async () => {
    const { app, spy, exits } = await bootNode();
    // shell surface, but the frame is not the trusted console
    await app.spine.handleInbound(shellMsg('stop', { authorized: false, senderName: 'stranger' }));
    // beeper surface, a stranger in the chat
    await spy.onIncoming('STOP', {
      chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
      userId: 'stranger', senderName: 'Mallory', authorized: false, msgKey: 'm9',
    });
    // and the loud variants, which are the same switch
    await app.spine.handleInbound(shellMsg('STOP ALL', { authorized: false, senderName: 'stranger' }));

    expect(existsSync(STOP_PATH)).toBe(false);
    expect(exits).toEqual([]);
    app.stop();
  });
});

// --- the wiring, in isolation: a fake switch proves the two spine call sites -------------
function buildSpine({ guard = null, stopSwitch = null } = {}) {
  const bridge = { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false };
  const brain = { calls: [], async turn(b, ev) { this.calls.push({ b, ev }); return { text: 'x' }; } };
  const identity = { build: (msg) => ({ ...msg }) };
  const router = { resolve: () => 'e' };
  const gating = {
    async decide() { return { mode: 'on', receives: true, mayReply: false, sendToEgpt: 'mode' }; },
    surfaces: () => false,
  };
  const transcript = { logged: [], async log(ev) { this.logged.push(ev); } };
  const heartbeats = { beats: 0, runDue() { this.beats += 1; } };
  const sender = { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
  const spine = createSpine({
    bridge, brain, identity, router, gating, sender, transcript, heartbeats,
    guard, stopSwitch, clock: { now: () => 1000 },
  });
  return { spine, heartbeats, brain, transcript };
}
function fakeSwitch({ present = false } = {}) {
  const pulls = [];
  return { pulls, present: () => present, pull: (why) => pulls.push(why), set(v) { present = v; } };
}

describe('spine wiring — one switch, two call sites', () => {
  it('tick() checks the switch FIRST and skips the heartbeats once it is pulled', () => {
    const sw = fakeSwitch();
    const { spine, heartbeats } = buildSpine({ stopSwitch: sw });
    spine.tick();
    expect(heartbeats.beats).toBe(1);          // ordinary pulse
    sw.set(true);
    spine.tick();
    expect(sw.pulls).toHaveLength(1);
    expect(heartbeats.beats).toBe(1);          // a stopping node fires no further beats
  });

  it('STOP and STOP ALL are the SAME switch (bare STOP is never the weaker word)', async () => {
    for (const word of ['stop', 'STOP ALL', 'stopall', 'Stop.']) {
      const sw = fakeSwitch();
      const { spine, brain } = buildSpine({ guard: createStopGuard(), stopSwitch: sw });
      await spine.handleInbound({ surface: 'wa', chatId: 'c', chatName: 'fam', senderName: 'An', authorized: true, msgId: 'm', body: word, kind: 'text', raw: {} });
      expect(sw.pulls, word).toHaveLength(1);
      expect(brain.calls, word).toHaveLength(0);   // never routed to a brain
    }
  });

  it('the safe word is recorded like any inbound before the node stops', async () => {
    const sw = fakeSwitch();
    const { spine, transcript } = buildSpine({ guard: createStopGuard(), stopSwitch: sw });
    await spine.handleInbound({ surface: 'wa', chatId: 'c', chatName: 'fam', senderName: 'An', authorized: true, msgId: 'm', body: 'stop', kind: 'text', raw: {} });
    expect(transcript.logged).toHaveLength(1);
    expect(transcript.logged[0].body).toBe('stop');
  });

  it('RESUME still clears a channel the LOOP COUNTER auto-stopped (the only per-channel pause left)', async () => {
    const sw = fakeSwitch();
    const guard = createStopGuard({ turns: 6 });
    const { spine } = buildSpine({ guard, stopSwitch: sw });
    guard.stopChannel('wa:c');                                       // as guardCountNonHuman does at the cap
    expect(guard.blocked('wa:c')).toBe(true);
    await spine.handleInbound({ surface: 'wa', chatId: 'c', chatName: 'fam', senderName: 'An', authorized: true, msgId: 'm', body: 'RESUME', kind: 'text', raw: {} });
    expect(guard.blocked('wa:c')).toBe(false);
    expect(sw.pulls).toHaveLength(0);                                // RESUME never touches the kill switch
  });

  it('an unauthorized STOP never reaches the switch', async () => {
    const sw = fakeSwitch();
    const { spine } = buildSpine({ guard: createStopGuard(), stopSwitch: sw });
    await spine.handleInbound({ surface: 'wa', chatId: 'c', chatName: 'fam', senderName: 'Mallory', authorized: false, msgId: 'm', body: 'stop', kind: 'text', raw: {} });
    expect(sw.pulls).toHaveLength(0);
  });
});

describe('writeStopFile — the file explains itself, and never clobbers an existing reason', () => {
  it('records reason, who, where, when + how to clear it', async () => {
    const f = join(tmpHome, 'STOP-unit');
    await fs.rm(f, { force: true });
    expect(writeStopFile({ reason: 'chat safe word "stop"', who: 'An <u-1>', where: 'whatsapp / fam (!room)', at: '2026-07-25T21:40:00.000Z' }, f)).toBe(true);
    const body = await fs.readFile(f, 'utf8');
    expect(body).toContain('chat safe word "stop"');
    expect(body).toContain('An <u-1>');
    expect(body).toContain('whatsapp / fam (!room)');
    expect(body).toContain('2026-07-25T21:40:00.000Z');
    expect(body.toLowerCase()).toContain('delete');
    await fs.rm(f, { force: true });
  });

  it('an existing STOP file is left exactly as the operator wrote it', async () => {
    const f = join(tmpHome, 'STOP-unit2');
    await fs.writeFile(f, 'mine\n', 'utf8');
    expect(writeStopFile({ reason: 'later' }, f)).toBe(false);
    expect(await fs.readFile(f, 'utf8')).toBe('mine\n');
    await fs.rm(f, { force: true });
  });
});
