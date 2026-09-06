// THE SUCCESSOR'S ANNOUNCE (chunk 3 of plans/2609061200-SESSION-0-TO-1-HANDOVER-PLAN.md).
//
// setup/register-session1-autostart.ps1 starts a spine at LOGON with EGPT_SESSION1=1. That spine is
// the SUCCESSOR and the profile it wants is already held by the Session 0 spine: both share one
// EGPT_HOME, so exactly one may hold it, and two at once is the plan's only unrecoverable failure.
//
// THE ANNOUNCE DIALS THE CONSOLE PORT — it does NOT write into state/ingest (the reasoning is in
// src/spine/successor-announce.mjs's header; the short version is that the successor WATCHES that
// box too, so a token dropped there is a race the plan's own hazard table already calls out). Every
// case below runs against a REAL createShellPort on a REAL loopback port with the REAL nonce/HMAC
// handshake, because the property under test is "the incumbent actually receives an authorized
// /standdown", and a fake socket cannot show that.
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';

// A PRIVATE profile for this file — the two spines in the last describe SHARE it, which is the
// whole point ("two spines against one temp EGPT_HOME"). egpt-home.mjs freezes EGPT_HOME at module
// load, so this must run BEFORE boot.mjs is imported; vi.hoisted is what does that, and boot is
// therefore imported dynamically below (the same shape tests/spine-v1-boot.test.mjs uses).
const PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-successor-announce-home-${Date.now()}`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { mkdtemp, rm, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShellPort } from '../src/bridges/shell-port.mjs';
import { createIngest, lifecycleExit } from '../src/spine/ingest.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import {
  announceStanddown,
  isSession1Successor,
  standdownLine,
  SESSION1_ENV,
} from '../src/spine/successor-announce.mjs';

let boot;
beforeAll(async () => { ({ boot } = await import('../src/spine/boot.mjs')); });
afterAll(async () => { try { await fs.rm(PRIVATE_HOME, { recursive: true, force: true }); } catch {} });

const TOKEN = 'test-shell-token-for-the-handover';
const flush = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// Everything a case starts gets torn down here — a leaked listener would hold a real port.
const live = [];
afterEach(() => { for (const i of live.splice(0)) { try { i.stop(); } catch { /* already down */ } } });

// An INCUMBENT, at the limb level: a real console limb on an ephemeral port, wired to the SAME
// dispatch boot wires — shellPort.onMessage → lifecycleExit, which is what commands.mjs run() calls.
async function incumbent({ token = TOKEN } = {}) {
  const received = [], exits = [], ports = [], logs = [];
  const port = createShellPort({ port: 0, token, onLog: (m) => logs.push(m) });
  port.onMessage((msg) => {
    received.push(msg);
    const code = lifecycleExit(msg.body, { writeStanddownTarget: (p) => ports.push(p) });
    if (code != null) exits.push(code);
  });
  const wss = port.start();
  await new Promise((r) => (wss.address() ? r() : wss.once('listening', r)));
  const it = { port, wss, received, exits, ports, logs, bound: wss.address().port, stop: () => port.stop() };
  live.push(it);
  return it;
}

// A real port with NOTHING on it: bind an ephemeral listener, read its number, release it.
async function quietPort() {
  const { createServer } = await import('node:net');
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  await new Promise((r) => srv.close(r));
  return p;
}

describe('the successor flag (the ONE env read)', () => {
  // dcf302c MEASURED that `cmd /c set A=1 && …` yields "1 " — trailing space included. A spine
  // testing === '1' would have read '1 ', decided it was NOT the successor, and booted as a second
  // spine on a shared profile: a silent no-op with the fatal outcome. Hence trim, not equality.
  it('reads EGPT_SESSION1 defensively — a trailing space still means "successor"', () => {
    expect(isSession1Successor({ [SESSION1_ENV]: '1' })).toBe(true);
    expect(isSession1Successor({ [SESSION1_ENV]: '1 ' })).toBe(true);     // cmd's `set A=1 &&` form
    expect(isSession1Successor({ [SESSION1_ENV]: ' 1\r\n' })).toBe(true);
  });

  it('anything else is NOT the successor — absent, empty, 0, "true"', () => {
    for (const v of [undefined, '', '  ', '0', 'true', 'yes', '11']) {
      expect(isSession1Successor({ [SESSION1_ENV]: v }), JSON.stringify(v)).toBe(false);
    }
    expect(isSession1Successor({})).toBe(false);
  });
});

describe('the announce: successor set + an incumbent holding the port', () => {
  it('the incumbent receives an AUTHORIZED /standdown <port> and resolves it to exit 45', async () => {
    const inc = await incumbent();

    const r = await announceStanddown({ port: inc.bound, token: TOKEN });
    await flush();

    expect(r.outcome).toBe('announced');
    expect(inc.received).toHaveLength(1);
    expect(inc.received[0].body).toBe(standdownLine(inc.bound));
    // EARNED, not assumed from loopback: shell-port stamps this only after the HMAC handshake.
    expect(inc.received[0].from.authorized).toBe(true);
    expect(inc.received[0].from.network).toBe('shell');
    expect(inc.exits).toEqual([45]);
    expect(inc.ports).toEqual([String(inc.bound)]);   // the port argument survived the round trip
  });

  it('a WRONG token is refused by the incumbent — the announce is authenticated, not trusted', async () => {
    const inc = await incumbent();

    const r = await announceStanddown({ port: inc.bound, token: 'not-the-node-secret' });
    await flush();

    expect(r.outcome).toBe('refused');
    expect(inc.exits).toEqual([]);            // nothing was dispatched
    expect(inc.logs.join('')).toContain('FAILED THE AUTH CHALLENGE');
  });

  // THE WAIT IS shell-port's, NOT A SECOND ONE. While the incumbent holds the port the successor's
  // limb cannot bind it — and with the reap suppressed (boot's guard) it does not TAKE it either:
  // it backs off. When the incumbent leaves, the next retry binds.
  it('the successor does NOT serve while the incumbent holds the port, and DOES once it frees', async () => {
    const inc = await incumbent();
    const armed = [];
    const successor = createShellPort({
      port: inc.bound,
      token: TOKEN,
      reapPort: () => 0,                       // the guard boot installs for a successor
      onLog: () => {},
      setTimeout: (fn, ms) => { armed.push({ fn, ms }); return armed.length; },
      clearTimeout: () => {},
    });
    live.push({ stop: () => successor.stop() });

    successor.start();
    await flush();

    expect(armed).toHaveLength(1);             // the bind failed → a re-listen is backing off
    expect(armed[0].ms).toBe(3_000);
    expect(inc.wss.address()).not.toBeNull();  // …and the incumbent still holds the port

    inc.stop();                                // the drain finished; the departing spine left
    await flush();

    armed.pop().fn();                          // the successor's next retry
    await flush();
    const r = await announceStanddown({ port: inc.bound, token: TOKEN });
    expect(r.outcome).toBe('announced');       // something serves that port again: the successor
  });
});

describe('the announce: successor set + NO incumbent', () => {
  it('is an ordinary, quiet startup — nothing answers, nothing is written, nothing hangs', async () => {
    const port = await quietPort();
    const home = await mkdtemp(join(tmpdir(), 'egpt-announce-'));
    try {
      const ingestDir = join(home, 'state', 'ingest');
      await mkdir(ingestDir, { recursive: true });

      const r = await announceStanddown({ port, token: TOKEN, timeoutMs: 2_000 });

      expect(r.outcome).toBe('no-incumbent');
      // NOTHING TO CLEAN UP — the whole reason the announce is a dial and not a file. A token
      // written into the box with nobody listening would sit there and poison the next boot.
      expect(await readdir(ingestDir)).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('a node with no shell.token cannot announce at all, and says so instead of pretending', async () => {
    const said = [];
    const r = await announceStanddown({ port: await quietPort(), token: '', onLog: (m) => said.push(m) });
    expect(r.outcome).toBe('no-token');        // the console port IS the mutex; this node has none
    expect(said.join('')).toContain('no spine serves the console port');
  });
});

// ── THE SELF-CONSUMPTION TEST ────────────────────────────────────────────────────────────────────
// The trap this mechanism exists to avoid: the successor watches EGPT_HOME/state/ingest too, so a
// /standdown written there is consumed by whichever spine sweeps first — and if that is the
// successor, it stands ITSELF down. The dial makes that structurally impossible; this asserts the
// structure rather than trusting the description.
describe('a successor never stands ITSELF down on its own announce', () => {
  it('the announce writes NOTHING into the shared ingest box, so the successor\'s own watcher sees nothing', async () => {
    const inc = await incumbent();
    const home = await mkdtemp(join(tmpdir(), 'egpt-announce-self-'));
    try {
      const dir = join(home, 'state', 'ingest');
      await mkdir(dir, { recursive: true });

      // The SUCCESSOR's own ingest watcher, on the SAME shared box, wired as boot wires it.
      const seen = [];
      const watcher = createIngest({ dir, intervalMs: 5, handle: async (line) => { seen.push(line); } });
      await watcher.start();

      const r = await announceStanddown({ port: inc.bound, token: TOKEN });
      await flush();
      await watcher.sweep();
      watcher.stop();

      expect(r.outcome).toBe('announced');
      expect(inc.exits).toEqual([45]);   // the INCUMBENT got it…
      expect(seen).toEqual([]);          // …and the successor's own watcher never saw a thing
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  // The counter-example, so the assertion above is not vacuous: that same watcher DOES consume a
  // /standdown when one is in the box, and lifecycleExit DOES turn it into the exit that would have
  // killed the successor. That is the self-stand-down this design avoids by never writing one.
  it('(control) that same watcher WOULD have consumed one, and it WOULD have meant exit 45', async () => {
    const home = await mkdtemp(join(tmpdir(), 'egpt-announce-ctl-'));
    try {
      const dir = join(home, 'state', 'ingest');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'go'), '/standdown 23375', 'utf8');

      const seen = [];
      const watcher = createIngest({ dir, intervalMs: 5, handle: async (line) => { seen.push(line); } });
      await watcher.start();
      watcher.stop();

      expect(seen).toEqual(['/standdown 23375']);
      expect(lifecycleExit(seen[0])).toBe(45);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

// ── GAP: commands.mjs did not forward writeStanddownTarget ────────────────────────────
// `/standdown <port>` reaches a node by TWO doors — the ingest box (boot's own handle) and a line
// typed at the console or in Self (this one). Only the first passed the writer through, so a port
// argument on the typed path was parsed and then dropped: the exit code was right, the sidecar was
// never written, and daemon-runtime's standdownPort() fell back to this profile's own console port.
// Harmless while the two agree; wrong the moment they do not — and it is the door the successor's
// announce comes in through, which is why it is locked here.
describe('/standdown typed at the console carries its port to the daemon', () => {
  function harness() {
    const exits = [], rewinds = [], targets = [];
    const commands = createCommands({
      getConfig: () => ({}),
      send: () => {},
      exit: (code) => { exits.push(code); },
      writeRewindTarget: (ref) => rewinds.push(ref),
      writeStanddownTarget: (p) => targets.push(p),
      io: { stat: async () => { throw new Error('none'); }, readFile: async () => { throw new Error('none'); } },
    });
    const say = (body) => commands.run({ body, chatId: 'lobby', surface: 'shell', authorized: true });
    return { commands, say, exits, rewinds, targets };
  }

  it('writes the stand-down target the daemon consumes, and still exits 45', async () => {
    const h = harness();
    await h.say('/standdown 23999');
    expect(h.exits).toEqual([45]);
    expect(h.targets).toEqual(['23999']);   // was [] before this chunk: parsed, then dropped
    expect(h.rewinds).toEqual([]);
  });

  it('a bare /standdown writes nothing — absent means the console port this profile serves', async () => {
    const h = harness();
    await h.say('/standdown');
    expect(h.exits).toEqual([45]);
    expect(h.targets).toEqual([]);
  });

  it('regression: /rewind still writes only its own target, and 42/43 still write neither', async () => {
    const h = harness();
    await h.say('/rewind abc123');
    await h.say('/upgrade');
    await h.say('/restart');
    expect(h.exits).toEqual([44, 42, 43]);
    expect(h.rewinds).toEqual(['abc123']);
    expect(h.targets).toEqual([]);
  });
});

// ── boot() ──────────────────────────────────────────────────────────────────────────────────────
// The seams below are the ones boot already has; nothing was added for the test.
function fakeStart() {
  const spy = { onIncoming: null, sent: [], streams: [] };
  const start = async (opts) => {
    spy.onIncoming = opts.onIncoming;
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
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
const configFor = (port) => ({
  whatsapp: {},
  node_name: 'kg',
  shell: { token: TOKEN, port },
  agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, conversation_defaults: { access_level: 'regular' } } },
});

// ── REGRESSION LOCK: EGPT_SESSION1 ABSENT IS TODAY, UNCHANGED ───────────────────────────────────
// The common case — every Session 0 spine, every test, every other node. Asserted against boot's
// CURRENT behaviour, not a rewrite of it: the announce seam is never touched at all.
describe('regression: with EGPT_SESSION1 absent nothing announces', () => {
  it('an ordinary boot never calls the announce (the flag defaults off from the real environment)', async () => {
    const port = await quietPort();
    const { start } = fakeStart();
    const calls = [];
    let state = { contacts: {} };
    const app = await boot({
      readConfig: () => configFor(port),
      startBridge: start,
      makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      ingest: false, tickMs: 0, log: { line: () => {} },
      announceStanddown: async (o) => { calls.push(o); return { outcome: 'announced', detail: '' }; },
    });
    expect(calls).toEqual([]);      // process.env.EGPT_SESSION1 is unset in this suite
    app.stop();
  });

  it('even an explicit successor announces nothing when ingest is off — there is no port to contend for', async () => {
    const port = await quietPort();
    const { start } = fakeStart();
    const calls = [];
    let state = { contacts: {} };
    const app = await boot({
      readConfig: () => configFor(port),
      startBridge: start,
      makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      ingest: false, tickMs: 0, log: { line: () => {} },
      session1: true,
      announceStanddown: async (o) => { calls.push(o); return { outcome: 'announced', detail: '' }; },
    });
    expect(calls).toEqual([]);
    app.stop();
  });

  it('a successor announces ONCE, to its own profile\'s console port, with its own shell token', async () => {
    const port = await quietPort();
    const { start } = fakeStart();
    const calls = [];
    let state = { contacts: {} };
    const app = await boot({
      readConfig: () => configFor(port),
      startBridge: start,
      makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      ingest: true, tickMs: 0, log: { line: () => {} },
      reapPort: () => 0,
      session1: true,
      announceStanddown: async (o) => { calls.push(o); return { outcome: 'no-incumbent', detail: 'nothing answered' }; },
    });
    live.push({ stop: () => app.stop() });

    expect(calls).toHaveLength(1);
    expect(calls[0].port).toBe(port);
    expect(calls[0].token).toBe(TOKEN);
    app.stop();
  });
});

// ── THE ONE THAT MATTERS MOST ───────────────────────────────────────────────────────────────────
// Two real spines, one temp EGPT_HOME, one console port, the REAL announce over a REAL socket.
// Overlap is the only unrecoverable failure in this design, so the assertions are exactly the two
// the plan names: only ONE ever serves the port, and only ONE ever writes conversations.yaml.
describe('two spines, one EGPT_HOME: exactly one holds the profile at any moment', () => {
  it('the successor announces, the incumbent drains and leaves, and only then does the successor serve', async () => {
    const port = await quietPort();
    // conversations.yaml is written through the writeState seam — ONE shared sink, stamped with
    // which spine wrote, which is what makes "only one ever writes it" an assertion and not a hope.
    const writes = [];
    let state = { contacts: {} };
    const stateFor = (who) => ({
      loadState: async () => state,
      writeState: async (s) => { writes.push(who); state = s; },
    });

    // ── the INCUMBENT (Session 0): an ordinary spine. It binds the console port.
    const a = fakeStart();
    const aLog = [], aExits = [];
    const appA = await boot({
      readConfig: () => configFor(port),
      startBridge: a.start,
      makeSession: fakeSession,
      ...stateFor('incumbent'),
      ingest: true, tickMs: 0,
      reapPort: () => 0,                       // never let a test run netstat/taskkill for real
      log: { line: (m) => aLog.push(m) },
      exit: (code) => { aExits.push(code); },  // the daemon would see this; here the test does
    });
    live.push({ stop: () => appA.stop() });
    await flush(50);
    expect(aLog.some((l) => l.includes(`shell: serving ws://127.0.0.1:${port}`))).toBe(true);

    // A turn lands on the incumbent BEFORE the handover — it is the one holding the profile.
    await a.spy.onIncoming('hola E', {
      chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
      userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1',
    });
    expect(writes).toContain('incumbent');
    const writesBefore = writes.length;

    // ── the SUCCESSOR (Session 1): EGPT_SESSION1=1, same EGPT_HOME, same port, REAL announce.
    const b = fakeStart();
    const bLog = [];
    const appB = await boot({
      readConfig: () => configFor(port),
      startBridge: b.start,
      makeSession: fakeSession,
      ...stateFor('successor'),
      ingest: true, tickMs: 0,
      reapPort: () => 0,
      log: { line: (m) => bLog.push(m) },
      session1: true,                          // ← the whole feature, in one flag
    });
    live.push({ stop: () => appB.stop() });
    await flush(50);

    // 1. THE ANNOUNCE WAS MADE, over the real socket, and the incumbent heard it.
    expect(bLog.some((l) => l.includes('[standdown] successor (EGPT_SESSION1=1): announced'))).toBe(true);
    // 2. THE INCUMBENT IS LEAVING — 45, not 43: the daemon must NOT respawn it.
    expect(aExits).toEqual([45]);
    // 3. THE SUCCESSOR IS NOT SERVING. It never reaped, so the incumbent is alive and holding.
    expect(bLog.some((l) => l.includes(`shell: serving ws://127.0.0.1:${port}`))).toBe(false);
    expect(bLog.some((l) => l.includes('does NOT reap'))).toBe(true);
    expect(aLog.some((l) => l.includes('does NOT reap'))).toBe(false);   // and ONLY the successor: an ordinary spine still evicts

    // 4. AND IT HAS STOPPED ANSWERING. A turn arriving at the draining incumbent is RECORDED and
    //    REFUSED, never dispatched (chunk 1b's admission gate) — no reply is opened for it.
    //    MEASURED, not assumed: recording an arrival still touches conversations.yaml (the contact
    //    is ensured before the gate), so "the departing spine writes nothing more" is false and the
    //    honest property is the one asserted at the end — the writer changes hands ONCE and the two
    //    never interleave. What must stop is the ANSWER, and it does.
    const streamsBefore = a.spy.streams.length;
    await a.spy.onIncoming('hola again', {
      chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
      userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm2',
    });
    expect(a.spy.streams.length).toBe(streamsBefore);              // refused, not dispatched
    expect(writes.filter((w) => w === 'successor')).toEqual([]);   // and the successor wrote nothing

    // ── the incumbent's process ends (the daemon's exit 45 is what does this for real) …
    appA.stop();
    await flush(50);
    // … and the successor's own limb takes the port on its next attempt. poke() is the existing
    // re-listen-NOW path (boot wires it to the editor's /shell-connect marker); using it here
    // just spares the test shell-port's real 3s backoff.
    appB.shellPort.poke();
    await flush(50);
    expect(bLog.some((l) => l.includes(`shell: serving ws://127.0.0.1:${port}`))).toBe(true);

    // 5. ONLY ONE EVER SERVED: the port changed hands, it was never held twice.
    const servedA = aLog.filter((l) => l.includes('shell: serving ws://')).length;
    const servedB = bLog.filter((l) => l.includes('shell: serving ws://')).length;
    expect(servedA).toBe(1);
    expect(servedB).toBe(1);

    // 6. AND NOW THE SUCCESSOR IS THE ONE WRITING conversations.yaml — the profile moved whole.
    await b.spy.onIncoming('hola successor', {
      chatId: '!after:beeper.com', chatName: 'after', network: 'whatsapp',
      userId: 'u-2', senderName: 'An', authorized: true, msgKey: 'm3',
    });
    await flush(50);
    expect(writes.filter((w) => w === 'successor').length).toBeGreaterThan(0);
    // THE PROPERTY THAT MATTERS: the writer changed hands EXACTLY ONCE, incumbent → successor, and
    // the two never interleaved. Interleaving is what "both writing state, last-writer-wins" looks
    // like in the plan's hazard table, and it is what this whole chunk exists to make impossible.
    const handovers = writes.filter((w, i) => i > 0 && w !== writes[i - 1]);
    expect(handovers).toEqual(['successor']);
    expect(writes[0]).toBe('incumbent');
    expect(writesBefore).toBeGreaterThan(0);   // the incumbent really was the writer beforehand

    appB.stop();
    await flush(50);   // let the last fire-and-forget stats write land before the profile is torn down
  }, 20_000);
});
