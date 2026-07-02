// boot() end-to-end: the REAL services + REAL warm pool assembled by boot(),
// with fakes ONLY at the transport (startBeeperBridge) + process (claude session)
// boundary. Drives an inbound through the fake bridge and asserts it round-trips
// to a streamed reply with the transcript written — the v1 pipe, exactly as
// production wires it, minus Beeper and minus claude. (SPINE-REWRITE-PLAN.md
// Phase 3 verify gate, offline half.)
//
// Runs against an isolated EGPT_HOME so the spine's boot-time writes (the
// heartbeats.readonly.yaml snapshot, the announce sidecar) land in a throwaway
// profile, never the real ~/.egpt. The alive beat is a spawned command now, so
// the heartbeat tests observe it via an injected fake spawn (no real alive.txt).
// egpt-home.mjs reads EGPT_HOME once at module load, so it's set BEFORE boot
// (which imports it) is dynamically imported below.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const tmpHome = join(os.tmpdir(), `egpt-v1-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;

let boot, emptyState, ensureContact;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch {}
});

// Pre-seed a conversation's E mode in the shared state (modes live in
// conversations.yaml now, not config.auto_modes). No threadId → still "fresh".
function seedMode(state, mode, chatId = '!room:beeper.com', name = 'fam') {
  const ens = ensureContact(state, 'whatsapp', chatId, { pushedName: name, slugHint: name });
  ens.state.contacts.whatsapp[chatId].mode = mode;
  return ens.state;
}

// fake Beeper transport: captures the host onIncoming so the test can drive inbound.
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

// fake claude session: the warm pool calls makeSession(brainOptions) → { turn, close, sessionId }.
function fakeSession(opts) {
  return { sessionId: opts.sessionId ?? 'sess-1', async turn(message, onUpdate) { onUpdate?.(`↩ ${message}`); return { text: `↩ ${message}`, sessionId: this.sessionId }; }, close() {} };
}

// in-memory fs seam so the test NEVER writes into the real ~/.egpt profile.
const memIo = () => ({ appendFile: async () => {}, mkdir: async () => {}, existsSync: () => false });

describe('boot()', () => {
  it("assembles the v1 pipe and round-trips an 'on'-mode message bridge→brain→bridge", async () => {
    const { start, spy } = fakeStart();
    let state = seedMode(emptyState(), 'on');
    const config = { whatsapp: {}, default_brain: { type: 'ccode' } };

    const app = await boot({
      readConfig: () => config,
      startBridge: start,
      makeSession: fakeSession,
      loadState: async () => state,
      writeState: async (s) => { state = s; },
      io: memIo(), ingest: false,
      now: () => Date.UTC(2026, 5, 29, 14, 5),
      tickMs: 0,
      log: { line: () => {} },
    });

    expect(spy.onIncoming).toBeTypeOf('function');

    // a whatsapp message arrives in an on-mode chat
    await spy.onIncoming('hola E', {
      chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
      userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1',
    });

    // delivered as a stream-edit carrying the brain's reply. This is a FRESH
    // contact, so the brain's first turn is identity-wrapped (the beta-1 kickoff,
    // via the real readIdentityFeed / e_identity.md) — proven by the live-message
    // envelope + the dispatch line both reaching the (echoing fake) brain.
    expect(spy.streams).toHaveLength(1);
    const delivered = spy.streams[0].finals[0];
    expect(delivered).toContain('Live message from the chat (envelope');   // identity kickoff wrap
    expect(delivered).toContain('An@[fam].wa (14:05) #m1: hola E');        // the dispatch line
    expect(spy.streams[0].chatId).toBe('!room:beeper.com');
    expect(spy.sent).toHaveLength(0);   // stream delivered → no fallback send

    // the conversation's claude session was persisted onto the contact
    const c = state.contacts?.whatsapp ?? {};
    const entry = Object.values(c)[0];
    expect(entry.threadId).toBe('sess-1');

    app.stop();
  });

  it("respects gating: a 'mute' chat invokes no brain and sends nothing", async () => {
    const { start, spy } = fakeStart();
    let state = seedMode(emptyState(), 'mute');
    const config = { whatsapp: {} };
    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), ingest: false, tickMs: 0, log: { line: () => {} },
    });
    await spy.onIncoming('hola', { chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp', userId: 'u-1', senderName: 'An', msgKey: 'm1' });
    expect(spy.streams).toHaveLength(0);
    expect(spy.sent).toHaveLength(0);
    app.stop();
  });

  it('registers the alive beat as a spawned command: spine.pid written, immediate first beat on tick, cadence honored, env carries EGPT_HOME + pump stats', async () => {
    const { start } = fakeStart();
    let state = seedMode(emptyState(), 'on');
    const config = { whatsapp: {}, default_brain: { type: 'ccode' } };
    let clock = Date.UTC(2026, 5, 29, 14, 5);   // June 29 14:05 UTC

    // Observe the beat as a SPAWN, not a written alive.txt — the alive beat is a
    // command now (echo beat > state/alive.txt). The fake child completes each spawn
    // (exit 0) so the overlap guard clears and the cadence can advance.
    const spawnCalls = [];
    const fakeSpawn = (cmd, opts) => { spawnCalls.push({ cmd, opts }); return { on(ev, cb) { if (ev === 'exit') cb(0); return this; } }; };

    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), ingest: false,
      now: () => clock,
      tickMs: 0,          // no auto-timer; we drive tick() by hand
      aliveMs: 60_000,    // register the alive one-liner as a 60s command heartbeat
      spawn: fakeSpawn,   // observe the beat command without running a real shell
      log: { line: () => {} },
    });

    // spine.pid is written once at boot with the long-lived spine pid (the
    // second-daemon guard reads it; identity ≠ liveness)
    expect(await fs.readFile(join(tmpHome, 'state', 'spine.pid'), 'utf8')).toBe(String(process.pid));

    // boot fired one immediate beat (spine.tick() right after start) → one spawn
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe('echo beat > state/alive.txt');   // the default one-liner
    expect(spawnCalls[0].opts).toMatchObject({ shell: true, cwd: tmpHome });   // cwd = the profile, so state/ resolves there
    expect(spawnCalls[0].opts.env.EGPT_HOME).toBe(tmpHome);
    expect(spawnCalls[0].opts.env.EGPT_SPINE_PID).toBeUndefined();   // pid moved to state/spine.pid — no longer an env var
    expect(spawnCalls[0].opts.env.EGPT_QUEUE_DEPTH).toBe('0');

    // a second tick INSIDE the 60s window → still not due → no new spawn
    app.spine.tick();
    expect(spawnCalls).toHaveLength(1);   // cadence honored

    // advance past the cadence → next tick beats again
    clock += 60_000;
    app.spine.tick();
    expect(spawnCalls).toHaveLength(2);

    app.stop();
  });

  it('a declared heartbeats.alive frequency tightens the effective tick below the default; the alive command still spawns and the readonly shows the REAL command', async () => {
    const { start } = fakeStart();
    let state = seedMode(emptyState(), 'on');
    // config declares alive at 1s — finer than boot's default 30s tick. The loader
    // must size the tick DOWN to the finest cadence. An explicit config alive loads
    // even though aliveMs is unset (0). Observe the effective tick via a fake
    // setInterval (only the spine's tick timer flows through this seam).
    const config = { whatsapp: {}, default_brain: { type: 'ccode' }, heartbeats: { alive: { frequency: '1s' } } };
    const intervals = [];
    const spawnCalls = [];
    const fakeSpawn = (cmd, opts) => { spawnCalls.push({ cmd, opts }); return { on(ev, cb) { if (ev === 'exit') cb(0); return this; } }; };

    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), ingest: false,
      now: () => Date.UTC(2026, 5, 29, 14, 5),
      spawn: fakeSpawn,
      setInterval: (fn, ms) => { intervals.push(ms); return 0; },
      clearInterval: () => {},
      log: { line: () => {} },
    });

    // tightened to the 1s cadence, not the 30s default
    expect(intervals.length).toBeGreaterThan(0);
    expect(Math.min(...intervals)).toBeLessThanOrEqual(1000);

    // the immediate boot tick spawned the alive command (config alive → default one-liner)
    expect(spawnCalls.some((c) => c.cmd.includes('alive.txt'))).toBe(true);

    // the spine materialized the readonly view — the alive row shows the REAL
    // command, nothing hidden behind a builtin label
    const readonly = await fs.readFile(join(tmpHome, 'state', 'heartbeats.readonly.yaml'), 'utf8');
    expect(readonly).toContain('DO NOT EDIT');
    expect(readonly).toContain('name: alive');
    expect(readonly).toContain('command: echo beat > state/alive.txt');
    expect(readonly).not.toContain('builtin');

    app.stop();
  });

  it('registers the internal heartbeats-reload entry (shown in the readonly view for transparency)', async () => {
    const { start } = fakeStart();
    let state = seedMode(emptyState(), 'on');
    const config = { whatsapp: {}, default_brain: { type: 'ccode' } };
    const fakeSpawn = () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } });

    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), ingest: false,
      now: () => Date.UTC(2026, 5, 29, 14, 5),
      tickMs: 0, aliveMs: 60_000, spawn: fakeSpawn,
      log: { line: () => {} },
    });

    const readonly = await fs.readFile(join(tmpHome, 'state', 'heartbeats.readonly.yaml'), 'utf8');
    expect(readonly).toContain('name: heartbeats-reload');
    expect(readonly).toContain('source: spine (internal)');
    expect(readonly).toContain('reload heartbeats when this file is deleted');

    app.stop();
  });
});
