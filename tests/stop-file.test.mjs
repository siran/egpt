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
// `onSend` snapshots the world AT THE MOMENT of a send (has the STOP file been written? has
// the node exited?) — that is how the ORDER of warn→write→exit is asserted without a clock.
// `hangSend` makes the POST never resolve: the wedged-bridge case the 3s cap exists for.
function fakeStart({ onSend = null, hangSend = false } = {}) {
  const spy = { started: false, onIncoming: null, sent: [], streams: [] };
  const start = async (opts) => {
    spy.started = true;                       // ← the "did the bridge dial Beeper" assertion
    spy.onIncoming = opts.onIncoming;
    return {
      async send(text, o) {
        spy.sent.push({ text, chatId: o?.chatId, ...(onSend ? onSend() : {}) });
        if (hangSend) return new Promise(() => {});     // a POST that never comes back
        return { ok: true };
      },
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

// THE SELF CHAT — `networks.whatsapp.chat_ids[0]`, the same one entry the live config
// annotates "Self-DM = operator command channel" and the same one announceAndExit posts
// the restart line to. Since 2026-07-26 it is ALSO the only chat the safe word works in.
const SELF_CHAT = '!self:beeper.com';
const CONFIG = {
  node_name: 'kg',   // MANDATORY since 2026-07-26 — it IS the structural node signature (boot throws without one)
  networks: { whatsapp: { chat_ids: [SELF_CHAT], allowed_users: ['u-1'] } },
  agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } },
};
const AT = Date.UTC(2026, 6, 25, 21, 40);

async function bootNode({ hangSend = false, setTimeoutFn = globalThis.setTimeout, config = CONFIG } = {}) {
  const exits = []; const logs = [];
  const { start, spy } = fakeStart({
    hangSend,
    onSend: () => ({ fileAtSend: existsSync(STOP_PATH), exitsAtSend: exits.length }),
  });
  let state = emptyState();
  const app = await boot({
    readConfig: () => config,
    startBridge: start,
    makeSession: fakeSession,
    loadState: async () => state,
    writeState: async (s) => { state = s; },
    io: memIo(),
    ingest: false,
    now: () => AT,
    tickMs: 0,
    exit: (code) => exits.push(code),
    setTimeout: setTimeoutFn,
    log: { line: (s) => logs.push(s) },
  });
  return { app, spy, exits, logs };
}

// A beeper-surface inbound from the ONE allowed_user (CONFIG above), as beeper.mjs builds it.
// This one lands in an ORDINARY chat — authorized, but NOT the Self chat.
const BEEPER_FROM = {
  chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
  userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1',
};
// …and this one lands in SELF — the operator's own command channel, the only chat the
// safe word is honoured in.
const SELF_FROM = { ...BEEPER_FROM, chatId: SELF_CHAT, chatName: 'Self' };

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
  it('"stop" in the SELF chat: file written with reason + provenance, service stops', async () => {
    const { app, spy, exits } = await bootNode();
    await spy.onIncoming('stop', { ...SELF_FROM });

    expect(existsSync(STOP_PATH)).toBe(true);
    const body = await fs.readFile(STOP_PATH, 'utf8');
    expect(body).toContain('stop');                                  // the reason: the safe word itself
    expect(body).toContain('An');                                    // who
    expect(body).toContain('whatsapp');                              // which surface
    expect(body).toContain(SELF_CHAT);                               // which chat
    expect(body).toContain(new Date(AT).toISOString());              // when
    expect(body.toLowerCase()).toContain('delete');                  // the file explains how to undo itself
    expect(exits).toEqual([0]);
    app.stop();
  });

  it('a FULL-form config chat_id still matches the SHORT id the bridge delivers', async () => {
    const config = { ...CONFIG, networks: { whatsapp: { chat_ids: ['!yz3kJjWXsQJofK9naaVb:beeper.local'], allowed_users: ['u-1'] } } };
    const { app, spy, exits } = await bootNode({ config });
    await spy.onIncoming('stop', { ...SELF_FROM, chatId: 'yz3kJjWXsQJofK9naaVb' });
    expect(existsSync(STOP_PATH)).toBe(true);
    expect(exits).toEqual([0]);
    app.stop();
  });

  it('an UNAUTHORIZED sender\'s "stop" IN SELF does NOTHING — no file, no warning, no stop', async () => {
    const { app, spy, exits } = await bootNode();
    // the Self chat, but the sender is NOT in allowed_users and is not the account owner
    await spy.onIncoming('STOP', { ...SELF_FROM, userId: 'stranger', senderName: 'Mallory', authorized: false, msgKey: 'm9' });

    expect(existsSync(STOP_PATH)).toBe(false);
    expect(exits).toEqual([]);
    expect(spy.sent.filter((s) => s.text.includes('STOP'))).toHaveLength(0);   // and nothing was announced
    app.stop();
  });
});

// === (D) THE SAFE WORD IS SELF-ONLY (operator 2026-07-26, verbatim: "the 'stop' safeword is
//     super fragile. i don't really like it. is must be a single word message in Self, 'stop',
//     case insensitive"). Until today an authorized "stop" ANYWHERE — any Beeper chat, any
//     group, the operator console — took the whole service down. The word is now scoped to ONE
//     chat: networks.whatsapp.chat_ids[0], the Self-DM the restart announce already posts to.
//     Everywhere else "stop" is ORDINARY TEXT. ================================================
describe('(D) "stop" is honoured ONLY in the Self chat, and only as the bare word', () => {
  it('case-insensitive in Self: "STOP" and "Stop" both pull it', async () => {
    for (const word of ['STOP', 'Stop']) {
      await fs.rm(STOP_PATH, { force: true });
      const { app, spy, exits } = await bootNode();
      await spy.onIncoming(word, { ...SELF_FROM });
      expect(existsSync(STOP_PATH), word).toBe(true);
      expect(exits, word).toEqual([0]);
      app.stop();
    }
  });

  it('"stop" in ANOTHER beeper chat from an AUTHORIZED sender does NOTHING', async () => {
    const { app, spy, exits } = await bootNode();
    await spy.onIncoming('stop', { ...BEEPER_FROM });                 // authorized, but not Self
    await spy.onIncoming('STOP', { ...BEEPER_FROM, chatName: 'a group', msgKey: 'm2' });

    expect(existsSync(STOP_PATH)).toBe(false);
    expect(exits).toEqual([]);
    expect(spy.sent.filter((s) => s.text.includes('egpt is stopping'))).toHaveLength(0);
    app.stop();
  });

  it('"stop" on the SHELL surface does NOTHING — the console is not Self', async () => {
    // The shell port hardcodes authorized:true on every frame (src/bridges/shell-port.mjs),
    // so "authorized" alone never gated the console. Scoping to Self closes that as a
    // side effect: the shell's chat id ('main') is not the Self chat.
    const { app, spy, exits } = await bootNode();
    await app.spine.handleInbound(shellMsg('stop'));
    await app.spine.handleInbound(shellMsg('STOP'));

    expect(existsSync(STOP_PATH)).toBe(false);
    expect(exits).toEqual([]);
    expect(spy.sent.filter((s) => s.text.includes('egpt is stopping'))).toHaveLength(0);
    app.stop();
  });

  it('a shell frame that SPOOFS the Self chat id still does nothing (surface is checked too)', async () => {
    const { app, spy, exits } = await bootNode();
    await app.spine.handleInbound(shellMsg('stop', { chatId: SELF_CHAT }));
    expect(existsSync(STOP_PATH)).toBe(false);
    expect(exits).toEqual([]);
    expect(spy.sent.filter((s) => s.text.includes('egpt is stopping'))).toHaveLength(0);
    app.stop();
  });

  it('"stop it" / "please stop" / "stopping" in Self are ordinary text', async () => {
    const { app, spy, exits } = await bootNode();
    for (const [i, word] of ['stop it', 'please stop', 'stopping', 'stop?'].entries()) {
      await spy.onIncoming(word, { ...SELF_FROM, msgKey: `mw${i}` });
    }
    expect(existsSync(STOP_PATH)).toBe(false);
    expect(exits).toEqual([]);
    app.stop();
  });

  it('the humanTurn requirement still holds IN Self — a backlog replay never pulls it', async () => {
    const { app, spy, exits } = await bootNode();
    await spy.onIncoming('stop', { ...SELF_FROM, backlog: true });
    expect(existsSync(STOP_PATH)).toBe(false);
    expect(exits).toEqual([]);
    app.stop();
  });

  it('NO Self chat configured → the chat safe word is unavailable (fail-closed)', async () => {
    const config = { ...CONFIG, networks: { whatsapp: { chat_ids: [], allowed_users: ['u-1'] } } };
    const { app, spy, exits } = await bootNode({ config });
    await spy.onIncoming('stop', { ...SELF_FROM });
    expect(existsSync(STOP_PATH)).toBe(false);      // `touch EGPT_HOME/STOP` is still the way out
    expect(exits).toEqual([]);
    app.stop();
  });
});

// === (A) "STOP ALL" IS UNWIRED (operator 2026-07-26: "unwire 'STOP ALL' i didn't even know
//     it existed") — not an alias, not a hidden synonym for the kill switch: it stops being a
//     recognised phrase at all and reads as ordinary text. =====================================
describe('(A) "STOP ALL" is not a safe word', () => {
  it('an AUTHORIZED "STOP ALL" writes no file, posts no warning and does not stop the node', async () => {
    const { app, spy, exits } = await bootNode();
    await spy.onIncoming('STOP ALL', { ...SELF_FROM, msgKey: 'm2' });   // in Self, where a bare STOP WOULD land
    expect(existsSync(STOP_PATH)).toBe(false);
    expect(exits).toEqual([]);
    expect(spy.sent.filter((s) => s.text.includes('egpt is stopping'))).toHaveLength(0);
    app.stop();
  });

  it('…and neither does "stopall"', async () => {
    const { app, spy, exits } = await bootNode();
    await spy.onIncoming('stopall', { ...SELF_FROM, msgKey: 'm3' });
    expect(existsSync(STOP_PATH)).toBe(false);
    expect(exits).toEqual([]);
    app.stop();
  });
});

// === (B) THE WARNING IN THE CHAT (operator 2026-07-26: "STOP on any chat created the file and
//     emits warning in the chat that action was taken"). The operator must SEE that it landed —
//     but the stop must never be hangable by that post, so the send is capped exactly like
//     boot's announceAndExit going-down line (Promise.race against a 3s timer). Since the
//     narrowing the "chat it came from" is NECESSARILY Self — there is nowhere else to warn. ==
describe('(B) STOP warns in the chat it came from, and the post can never wedge the stop', () => {
  it('warns in THAT chat, then writes the file, then exits — in that order', async () => {
    const { app, spy, exits } = await bootNode();
    await spy.onIncoming('STOP', { ...SELF_FROM });

    const warn = spy.sent.find((s) => s.text.includes('egpt is stopping'));
    expect(warn, JSON.stringify(spy.sent)).toBeTruthy();
    expect(warn.chatId).toBe(SELF_CHAT);                    // the chat the STOP came from = Self
    expect(warn.text).toContain('STOP');                    // …what happened
    expect(warn.text).toContain(`rm ${STOP_PATH}`);         // …and how to undo it
    // ORDER — the snapshot taken INSIDE the send: nothing had been written, nothing had exited
    expect(warn.fileAtSend).toBe(false);
    expect(warn.exitsAtSend).toBe(0);
    expect(existsSync(STOP_PATH)).toBe(true);               // …and both happened after it
    expect(exits).toEqual([0]);
    app.stop();
  });

  it('a WEDGED post does not hold the node up: the 3s cap fires and it stops anyway', async () => {
    const timers = [];
    const { app, spy, exits } = await bootNode({
      hangSend: true,
      setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    });
    let settled = false;
    const p = spy.onIncoming('STOP', { ...SELF_FROM }).then(() => { settled = true; });
    // The warn-send is now preceded by a config refresh at the top of handleFast
    // (refreshConfig, wired from boot.mjs's heartbeatLoader.reload — real disk I/O: readdir +
    // readFile/writeFile, not pure microtasks), so a single microtask/immediate flush is no
    // longer guaranteed to reach it. Poll on the REAL clock (not the injected fake, which never
    // auto-fires) until the warn attempt lands — well under the 3s cap this test is about.
    for (let i = 0; i < 50 && spy.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

    expect(spy.sent).toHaveLength(1);                       // the warning WAS attempted…
    expect(settled).toBe(false);                            // …and its POST never came back
    expect(existsSync(STOP_PATH)).toBe(false);
    expect(exits).toEqual([]);
    expect(timers.map((t) => t.ms)).toEqual([3000]);        // the stop is riding the CAP, not the send

    timers[0].fn();                                         // drive the injected clock past it
    await p;
    expect(settled).toBe(true);
    expect(existsSync(STOP_PATH)).toBe(true);               // the durable record is still written
    expect(exits).toEqual([0]);                             // and the service still goes down
    app.stop();
  });
});

// --- the wiring, in isolation: a fake switch proves the two spine call sites -------------
// `isSelfChat` defaults to TRUE here so each case below isolates the ONE gate it is about
// (provenance, authorization, vocabulary); the Self gate itself is locked explicitly.
function buildSpine({ guard = null, stopSwitch = null, wasSentByUs = () => false, mesh = null, isSelfChat = () => true } = {}) {
  const bridge = { onMessage() {}, send() {}, stop() {}, wasSentByUs };
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
    mesh, guard, stopSwitch, isSelfChat, clock: { now: () => 1000 },
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

  it('the WHOLE recognised vocabulary: STOP pulls it, STOP ALL is ordinary text', async () => {
    for (const word of ['stop', 'STOP', 'Stop.']) {
      const sw = fakeSwitch();
      const { spine, brain } = buildSpine({ guard: createStopGuard(), stopSwitch: sw });
      await spine.handleInbound({ surface: 'wa', chatId: 'c', chatName: 'fam', senderName: 'An', authorized: true, msgId: 'm', body: word, kind: 'text', raw: {} });
      expect(sw.pulls, word).toHaveLength(1);
      expect(brain.calls, word).toHaveLength(0);   // never routed to a brain
    }
    for (const word of ['STOP ALL', 'stop all', 'stopall']) {
      const sw = fakeSwitch();
      const { spine } = buildSpine({ guard: createStopGuard(), stopSwitch: sw });
      await spine.handleInbound({ surface: 'wa', chatId: 'c', chatName: 'fam', senderName: 'An', authorized: true, msgId: 'm', body: word, kind: 'text', raw: {} });
      expect(sw.pulls, word).toHaveLength(0);      // unwired — not an alias, not a synonym
    }
  });

  it('the chat the STOP came from rides along, so boot can warn there', async () => {
    const sw = fakeSwitch();
    const { spine } = buildSpine({ guard: createStopGuard(), stopSwitch: sw });
    await spine.handleInbound({ surface: 'wa', chatId: 'c', chatName: 'fam', senderName: 'An', authorized: true, msgId: 'm', body: 'stop', kind: 'text', raw: {} });
    expect(sw.pulls[0]).toMatchObject({ surface: 'wa', chatId: 'c' });
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

  it('a STOP OUTSIDE the Self chat never reaches the switch — it is recorded as ordinary text', async () => {
    const sw = fakeSwitch();
    const { spine, transcript } = buildSpine({ guard: createStopGuard(), stopSwitch: sw, isSelfChat: () => false });
    await spine.handleInbound({ surface: 'wa', chatId: 'elsewhere', chatName: 'fam', senderName: 'An', authorized: true, msgId: 'm', body: 'stop', kind: 'text', raw: {} });
    expect(sw.pulls).toHaveLength(0);
    expect(transcript.logged).toHaveLength(1);          // not swallowed — it flowed on like any message
    expect(transcript.logged[0].body).toBe('stop');
  });

  it('the Self predicate is asked about THIS message (surface + chatId)', async () => {
    const sw = fakeSwitch();
    const seen = [];
    const { spine } = buildSpine({ guard: createStopGuard(), stopSwitch: sw, isSelfChat: (ev) => { seen.push({ surface: ev.surface, chatId: ev.chatId }); return true; } });
    await spine.handleInbound({ surface: 'wa', chatId: 'c', chatName: 'fam', senderName: 'An', authorized: true, msgId: 'm', body: 'stop', kind: 'text', raw: {} });
    expect(seen).toContainEqual({ surface: 'wa', chatId: 'c' });
    expect(sw.pulls).toHaveLength(1);
  });
});

// === (C) NO AGENT MAY PULL THE KILL SWITCH ==================================================
// On a SHARED Beeper account every send from the account — the operator's own, a PEER node's,
// and this node's — arrives with isSender:true, and beeper.mjs:1356 reads that as AUTHORIZED.
// So "authorized" alone is not enough to arm a kill switch: the safe word must ALSO be a
// genuine HUMAN turn by PROVENANCE (isHumanTurn), the same predicate the loop counter uses.
// Its four signals, each locked below. (What isHumanTurn CANNOT see — a peer node's plain
// post on the shared account, indistinguishable from the owner typing, beeper.mjs:533-534 —
// is reported, not faked here.)
describe('(C) provenance gates the kill switch: only a human turn may pull it', () => {
  const stopMsg = (over = {}) => ({
    surface: 'wa', chatId: 'c', chatName: 'fam', senderName: 'An', isSender: true,
    authorized: true, msgId: 'm7', body: 'stop', kind: 'text', raw: {}, ...over,
  });

  it('a genuine human STOP still pulls it (the positive lock)', async () => {
    const sw = fakeSwitch();
    const { spine } = buildSpine({ guard: createStopGuard(), stopSwitch: sw });
    await spine.handleInbound(stopMsg());
    expect(sw.pulls).toHaveLength(1);
  });

  it('OUR OWN send re-entering (wasSentByUs) never pulls it', async () => {
    const sw = fakeSwitch();
    const { spine } = buildSpine({ guard: createStopGuard(), stopSwitch: sw, wasSentByUs: () => true });
    await spine.handleInbound(stopMsg());
    expect(sw.pulls).toHaveLength(0);
  });

  it('a BRAIN MEMBER\'s reply re-entering the room (fromMember) never pulls it', async () => {
    const sw = fakeSwitch();
    const { spine } = buildSpine({ guard: createStopGuard(), stopSwitch: sw });
    await spine.handleInbound(stopMsg({ fromMember: { id: 'chatgpt', kind: 'brain' } }));
    expect(sw.pulls).toHaveLength(0);
  });

  it('relay/mesh traffic never pulls it', async () => {
    const sw = fakeSwitch();
    const mesh = { isEnvelope: () => true, async handle() {} };
    const { spine } = buildSpine({ guard: createStopGuard(), stopSwitch: sw, mesh });
    await spine.handleInbound(stopMsg());
    expect(sw.pulls).toHaveLength(0);
  });

  it('a woken node\'s BACKLOG replay never pulls it', async () => {
    const sw = fakeSwitch();
    const { spine } = buildSpine({ guard: createStopGuard(), stopSwitch: sw });
    await spine.handleInbound(stopMsg({ backlog: true }));
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

// === (E) THE CLICKABLE STOP ICON (operator 2026-07-26: "probably we can prepare a clickable
//     script to just stop the egpt-service. an autoelevating clickable icon"). setup/stop-egpt.cmd
//     self-elevates and runs setup/stop-egpt.ps1, which writes THIS SAME FILE and then stops the
//     service. Two writers of one format is a drift hazard — the node must be able to read a file
//     the script wrote — so the shared skeleton is asserted against BOTH sides here. ============
describe('(E) setup/stop-egpt.ps1 writes the same STOP file the spine does', () => {
  const readSetup = (name) => fs.readFile(new URL(`../setup/${name}`, import.meta.url), 'utf8');

  it('the file skeleton is identical on both sides (writeStopFile <-> the .ps1 template)', async () => {
    const f = join(tmpHome, 'STOP-fmt');
    await fs.rm(f, { force: true });
    writeStopFile({ reason: 'R', who: 'W', where: 'X', at: 'T' }, f);
    const body = await fs.readFile(f, 'utf8');
    await fs.rm(f, { force: true });
    const ps1 = await readSetup('stop-egpt.ps1');

    // Every fixed part of the format, checked against BOTH writers: change either one
    // without the other and this fails.
    for (const part of [
      'egpt is STOPPED.',
      'reason: ',
      'who:    ',
      'where:  ',
      'when:   ',
      'This node refuses to start while this file exists, and a running node halts on its',
      'next tick. Delete this file to let egpt start again:  rm ',
    ]) {
      expect(body, `writeStopFile: ${part}`).toContain(part);
      expect(ps1, `stop-egpt.ps1: ${part}`).toContain(part);
    }
  });

  it('it derives the service name exactly as the installer does, and never clobbers an existing file', async () => {
    const [ps1, installer] = await Promise.all([readSetup('stop-egpt.ps1'), readSetup('install-nssm-service.ps1')]);
    for (const line of ["(Split-Path $EgptHome -Leaf) -replace '^\\.', ''", '$ServiceName = "$base-daemon"']) {
      expect(installer, line).toContain(line);
      expect(ps1, line).toContain(line);
    }
    expect(ps1).toContain('if (Test-Path $stopFile)');          // idempotent: an existing STOP file is left alone
    expect(ps1).toContain('IsInRole');                          // …and it refuses to run un-elevated
  });

  it('the .cmd auto-elevates and there is a documented way back', async () => {
    const [cmd, startCmd, startPs1] = await Promise.all([readSetup('stop-egpt.cmd'), readSetup('start-egpt.cmd'), readSetup('start-egpt.ps1')]);
    expect(cmd).toContain('-Verb RunAs');                       // the UAC self-elevation the installers use
    expect(cmd).toContain('stop-egpt.ps1');
    expect(cmd).toContain('start-egpt.cmd');                    // the way back is named in the way off
    expect(startCmd).toContain('-Verb RunAs');
    expect(startPs1).toContain('Remove-Item $stopFile -Force'); // …and the way back actually clears the switch
    expect(startPs1).toContain('Start-Service -Name $ServiceName');
  });
});
