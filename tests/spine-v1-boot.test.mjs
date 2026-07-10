// boot() end-to-end: the REAL services + REAL warm pool assembled by boot(),
// with fakes ONLY at the transport (startBeeperBridge) + process (claude session)
// boundary. Drives an inbound through the fake bridge and asserts it round-trips
// to a streamed reply with the transcript written — the v1 pipe, exactly as
// production wires it, minus Beeper and minus claude. (plans/2606291226-SPINE-REWRITE-PLAN.md
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
import { isEchoWinner } from '../src/spine/echo-hrw.mjs';   // pure (no EGPT_HOME) → safe to static-import

const tmpHome = join(os.tmpdir(), `egpt-v1-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;

let boot, emptyState, ensureContact, shouldReapStrayWhisper, whisperPortOf;
beforeAll(async () => {
  ({ boot, shouldReapStrayWhisper, whisperPortOf } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch {}
});

// Pre-seed a conversation's persona mode in the shared state (modes live in
// conversations.yaml now, not config.auto_modes). The persona is a NESTED being keyed by its
// map key — 'egpt' in these configs (operator 2026-07-10) — so the mode goes under
// entry.egpt, where gating reads it via getBeing(defaultKey). No threadId → still "fresh".
function seedMode(state, mode, chatId = '!room:beeper.com', name = 'fam') {
  const ens = ensureContact(state, 'whatsapp', chatId, { pushedName: name, slugHint: name });
  const entry = ens.state.contacts.whatsapp[chatId];
  entry.egpt = { ...(entry.egpt ?? {}), mode };
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
    const config = { whatsapp: {}, agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } } };

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

    // the conversation's claude session was persisted onto the contact — NESTED under the
    // persona being 'egpt' now (operator 2026-07-10), not a flat threadId
    const c = state.contacts?.whatsapp ?? {};
    const entry = Object.values(c)[0];
    expect(entry.egpt.threadId).toBe('sess-1');

    app.stop();
  });

  it("respects gating: a 'mute' chat invokes no brain and sends nothing", async () => {
    const { start, spy } = fakeStart();
    let state = seedMode(emptyState(), 'mute');
    const config = { whatsapp: {}, agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } } };
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
    const config = { whatsapp: {}, agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } } };
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
    const config = { whatsapp: {}, agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } }, heartbeats: { alive: { frequency: '1s' } } };
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

  it('the readonly view has NO internal row; deleting the file and ticking hot-reloads it', async () => {
    const { start } = fakeStart();
    let state = seedMode(emptyState(), 'on');
    const config = { whatsapp: {}, agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } } };
    const fakeSpawn = () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } });

    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), ingest: false,
      now: () => Date.UTC(2026, 5, 29, 14, 5),
      tickMs: 0, aliveMs: 60_000, spawn: fakeSpawn,
      log: { line: () => {} },
    });

    const readonlyPath = join(tmpHome, 'state', 'heartbeats.readonly.yaml');
    const before = await fs.readFile(readonlyPath, 'utf8');
    // the reload trigger rides runDue now — there is no internal beat and no internal row
    expect(before).not.toContain('heartbeats-reload');
    expect(before).not.toContain('spine (internal)');
    expect(before).toContain('name: alive');

    // delete the file → the next tick notices its absence + hot-reloads (regenerates it)
    await fs.rm(readonlyPath);
    app.spine.tick();
    const exists = async () => { try { await fs.access(readonlyPath); return true; } catch { return false; } };
    let back = false;
    for (let i = 0; i < 100 && !back; i++) { back = await exists(); if (!back) await new Promise((r) => setTimeout(r, 10)); }
    expect(back).toBe(true);   // the fire-and-forget reload rewrote the file
    expect(await fs.readFile(readonlyPath, 'utf8')).toContain('name: alive');

    app.stop();
  });
});

// CONFIG-SHAPE MIGRATION (operator 2026-07-09): the new beeper:/networks:/account_peers shape
// (back-compat with the old flat shape) + the REMOVED wake-word injection (symmetric nodes wake on
// their OWN handles only). Assert boot RESOLVES each by capturing the opts it hands the bridge
// (token / wakeWords / echoDecider / echoMaxAgeMs / isAllowedUser) and app.accountPeers.
describe('boot() — config-shape migration', () => {
  const AG = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } };
  async function captureBoot(config) {
    let opts = null;
    const start = async (o) => {
      opts = o;
      return { async send() { return { ok: true }; }, startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; }, isAlive: () => true, stop() {} };
    };
    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => emptyState(), writeState: async () => {},
      io: memIo(), ingest: false, tickMs: 0, log: { line: () => {} },
    });
    return { opts, app };
  }

  it('beeper.use resolves the ACTIVE account token', async () => {
    const { opts, app } = await captureBoot({ agents: AG, beeper: { use: 'main', main: { account: 'a@b', token: 'TOK-main' }, alt: { account: 'c@d', token: 'TOK-alt' } } });
    expect(opts.beeperToken).toBe('TOK-main');
    app.stop();
  });

  it('back-compat: no beeper block → top-level beeper_token still resolves the token', async () => {
    const { opts, app } = await captureBoot({ agents: AG, beeper_token: 'TOK-legacy' });
    expect(opts.beeperToken).toBe('TOK-legacy');
    app.stop();
  });

  it('networks: wrapper — per-surface allowed_users; chat_ids is a LIST (self-DM = first)', async () => {
    const { opts, app } = await captureBoot({ agents: AG, networks: {
      whatsapp: { chat_ids: ['self-1', 'self-2'], allowed_users: ['op@wa'] },
      telegram: { chat_ids: [], allowed_users: ['op@tg'] },
    } });
    expect(opts.isAllowedUser('op@wa', 'whatsapp')).toBe(true);
    expect(opts.isAllowedUser('op@tg', 'telegram')).toBe(true);
    expect(opts.isAllowedUser('op@tg', 'whatsapp')).toBe(false);   // per-surface namespace, not shared
    app.stop();
  });

  it('back-compat: old top-level whatsapp block + SINGULAR chat_id — allowed_users still resolve', async () => {
    const { opts, app } = await captureBoot({ agents: AG, whatsapp: { chat_id: 'self-old', allowed_users: ['op@old'] } });
    expect(opts.isAllowedUser('op@old', 'whatsapp')).toBe(true);
    app.stop();
  });

  it('WAKE INJECTION GONE: handles [ed, egptd] → wakeWords excludes bare "e"; a default node keeps "e"', async () => {
    const dolly = await captureBoot({ agents: { egpt: { configuration: 'egpt', handles: ['ed', 'egptd'], default: true } } });
    expect(dolly.opts.wakeWords).not.toContain('e');   // pre-2026-07-09: injected → contained "e" → @e woke it
    expect(dolly.opts.wakeWords).toContain('ed');
    dolly.app.stop();
    const normal = await captureBoot({ agents: AG });
    expect(normal.opts.wakeWords).toContain('e');       // a node that configures e still wakes on @e
    normal.app.stop();
  });

  // 👂 ECHO — HRW PICK (operator 2026-07-10, Phase 3a): boot no longer hands the bridge a static
  // `echo` boolean — it hands an echoDecider(noteId) built from node_name + account_peers. A solo
  // node (no peers) always wins (echoes as before); cfg.echo:false folds into an always-false
  // decider (hard opt-out); echoMaxAgeMs is unchanged (orthogonal age bound).
  it('echoDecider: default solo node ALWAYS wins; cfg.echo:false NEVER; echoMaxAgeMs default 1h + override', async () => {
    const def = await captureBoot({ agents: AG });
    expect(typeof def.opts.echoDecider).toBe('function');
    expect(def.opts.echoDecider('any-note')).toBe(true);    // solo → always echo (lone-node behavior)
    expect(def.opts.echoMaxAgeMs).toBe(3_600_000);
    def.app.stop();
    const off = await captureBoot({ agents: AG, echo: false, echo_max_age_ms: 1000 });
    expect(off.opts.echoDecider('any-note')).toBe(false);    // hard opt-out — this node never posts the 👂
    expect(off.opts.echoMaxAgeMs).toBe(1000);
    off.app.stop();
  });

  it('echoDecider: co-account HRW pick — node_name + account_peers make EXACTLY ONE node echo each note', async () => {
    const kg = await captureBoot({ agents: AG, node_name: 'kg', account_peers: ['kg', 'do'] });
    const doNode = await captureBoot({ agents: AG, node_name: 'do', account_peers: ['kg', 'do'] });
    for (let i = 1; i <= 50; i++) {
      const id = String(i);
      expect(kg.opts.echoDecider(id)).toBe(isEchoWinner(id, 'kg', ['kg', 'do']));   // boot wired node_name + peers straight in
      expect(kg.opts.echoDecider(id)).toBe(!doNode.opts.echoDecider(id));           // exactly one of the two echoes the SAME note
    }
    kg.app.stop();
    doNode.app.stop();
  });

  it('account_peers parsed + exposed on the boot return', async () => {
    const { app } = await captureBoot({ agents: AG, account_peers: ['kg', 'do'] });
    expect(app.accountPeers).toEqual(['kg', 'do']);
    app.stop();
  });
});

// STRAY WHISPER-SERVER REAP (operator 2026-07-10): dropping `local` from a profile's
// fallback_order (→ [remote, cli]) orphans the resident whisper-server the old chain
// spawned — the pipeline only reaps on the NEXT local spawn (whisper-server.mjs), which now
// never comes. On boot we reap the stray, but ONLY when this node does not legitimately run
// a resident server (the transcriptor WORKER, or an ACTIVE whisper-server-local engine).
describe('boot() — stray whisper-server reap', () => {
  const AG = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } };
  const profile = (extra) => ({ agents: AG, transcription_service: { use_config: 'reve', reve: {
    remote: { type: 'whisper-server-remote', endpoint: 'http://worker:23390' },
    cli: { type: 'whisper-cli', model_path: '/m/large-v3.bin' },
    ...extra,
  } } });

  // DECISION helpers (pure) — the reproduce case: today the reap never fires for [remote, cli].
  it('decision: fallback_order [remote, cli] (no local, no worker) → REAP on the whisper default port', () => {
    const cfg = profile({ fallback_order: ['remote', 'cli'] });
    expect(shouldReapStrayWhisper(cfg)).toBe(true);
    expect(whisperPortOf(cfg)).toBe(8089);
  });

  it('decision: an ACTIVE whisper-server-local engine owns + supervises its server → NO reap (uses its port)', () => {
    const cfg = profile({
      fallback_order: ['remote', 'local', 'cli'],
      local: { type: 'whisper-server-local', command: 'ws', model: '/m', port: 8091 },
    });
    expect(shouldReapStrayWhisper(cfg)).toBe(false);
    expect(whisperPortOf(cfg)).toBe(8091);
  });

  it('decision: the transcriptor WORKER keeps its resident server → NO reap', () => {
    const cfg = { agents: AG, transcriptor: { enabled: true, server: { enabled: true, port: 8089 } } };
    expect(shouldReapStrayWhisper(cfg)).toBe(false);
    expect(whisperPortOf(cfg)).toBe(8089);   // resolved from transcriptor.server.port
  });

  // DOLLY's REAL live config (operator 2026-07-10): the GPU worker runs its resident server
  // under whatsapp.media.audio_transcribe.server + transcriptor.enabled, and NO
  // transcription_service. Reap must NOT fire, or boot taskkills DOLLY's own worker on :8089.
  it('decision: DOLLY-shaped worker (audio_transcribe.server + transcriptor.enabled, no transcription_service) → NO reap', () => {
    const cfg = { agents: AG,
      whatsapp: { media: { audio_transcribe: { enabled: true, server: { enabled: true, command: 'ws.exe', port: 8089 } } } },
      transcriptor: { enabled: true, bind: '0.0.0.0', port: 23390 },
      transcription_token: 'tok', transcription_endpoint: 'http://127.0.0.1:23390',
    };
    expect(shouldReapStrayWhisper(cfg)).toBe(false);   // REPRODUCE: pre-fix this returned true → boot reaped DOLLY's own server
    expect(whisperPortOf(cfg)).toBe(8089);             // resolved from audio_transcribe.server.port
  });

  it('decision: transcriptor.enabled worker role alone (no server block) → NO reap (conservative)', () => {
    const cfg = { agents: AG, transcriptor: { enabled: true, bind: '0.0.0.0', port: 23390 } };
    expect(shouldReapStrayWhisper(cfg)).toBe(false);
  });

  it('port: a whisper-server-local DEFINITION dropped from fallback_order still yields ITS port to reap', () => {
    // operator removed `local` from the order but left its definition → reap that exact port
    const cfg = profile({
      fallback_order: ['remote', 'cli'],
      local: { type: 'whisper-server-local', command: 'ws', model: '/m', port: 8090 },
    });
    expect(shouldReapStrayWhisper(cfg)).toBe(true);
    expect(whisperPortOf(cfg)).toBe(8090);
  });

  // WIRING: on a real-node boot the reap actually fires through the (faked) port-killer.
  it('wiring: a node with no resident whisper reaps the stray port ONCE on boot', async () => {
    const { start } = fakeStart();
    let state = seedMode(emptyState(), 'on');
    const config = { whatsapp: {}, ...profile({ fallback_order: ['remote', 'cli'] }) };
    const reaped = [];
    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), ingest: true,                                            // real-node flag → the reap side effect runs
      spawn: () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } }),
      reapPort: (port) => { reaped.push(port); return 1; },                 // fake killer — observe, never taskkill
      now: () => Date.UTC(2026, 5, 29, 14, 5), tickMs: 0, log: { line: () => {} },
    });
    expect(reaped).toEqual([8089]);   // REPRODUCE: without the boot reap this is [] (never called)
    app.stop();
  });

  it('wiring: a node that DOES run a resident local whisper never touches the port', async () => {
    const { start } = fakeStart();
    let state = seedMode(emptyState(), 'on');
    const config = { whatsapp: {}, ...profile({
      fallback_order: ['remote', 'local', 'cli'],
      local: { type: 'whisper-server-local', command: 'ws', model: '/m', port: 8089 },
    }) };
    const reaped = [];
    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), ingest: true,
      spawn: () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } }),
      reapPort: (port) => { reaped.push(port); return 1; },
      now: () => Date.UTC(2026, 5, 29, 14, 5), tickMs: 0, log: { line: () => {} },
    });
    expect(reaped).toEqual([]);   // the active local engine owns its server — never reaped
    app.stop();
  });
});

// TRANSCRIPTOR WORKER ROLE (operator 2026-06-10, ported v1 egpt-spine.mjs → v2 boot 2026-07-10):
// a node with `transcriptor.enabled: true` (DOLLY) must serve the signed :23390 endpoint (and,
// with a resident server configured, spawn a whisper-server). REPRODUCE: pre-port, v2 boot never
// started the worker — nothing bound :23390 and DOLLY's transcription failed. These assert boot
// (a) starts the worker with the RESOLVED config on a real node, (b) is INGEST-GATED so
// ingest:false never binds, and (c) tears BOTH down on stop() — all through fake spawn seams.
describe('boot() — transcriptor worker role', () => {
  const AG = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } };

  it('WIRING: transcriptor.enabled + real node → startTranscriptorServer bound with resolved {port,bind,keyB64} (whisper-cli per-note)', async () => {
    const { start } = fakeStart();
    const captured = [];
    const config = { whatsapp: {}, agents: AG, transcriptor: { enabled: true, bind: '0.0.0.0', port: 23390 }, transcription: { server: { token: 'BUSKEY' } } };
    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => emptyState(), writeState: async () => {},
      io: memIo(), ingest: true,                                            // real-node flag → the worker side effect runs
      spawn: () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } }),
      reapPort: () => 0,                                                    // transcriptor.enabled → no reap fires, but keep the killer faked
      startTranscriptorServer: async (opts) => { captured.push(opts); return { port: opts.port, close() {} }; },
      now: () => Date.UTC(2026, 5, 29, 14, 5), tickMs: 0, log: { line: () => {} },
    });
    // no resident server → startTranscriptorServer is the first await, called synchronously as
    // boot fires the (un-awaited) worker start → recorded by the time boot resolves.
    expect(captured).toHaveLength(1);                                       // REPRODUCE: pre-port this was [] (worker never started)
    expect(captured[0]).toMatchObject({ port: 23390, bind: '0.0.0.0', keyB64: 'BUSKEY' });
    expect(captured[0].transcribe).toBeUndefined();                        // whisper-cli per-note
    app.stop();
  });

  it('INGEST-GATED: ingest:false + transcriptor.enabled → the worker start seam is NEVER invoked (no real :23390 bind)', async () => {
    const { start } = fakeStart();
    const captured = [];
    const config = { whatsapp: {}, agents: AG, transcriptor: { enabled: true, port: 23390 }, transcription: { server: { token: 'K' } } };
    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => emptyState(), writeState: async () => {},
      io: memIo(), ingest: false, tickMs: 0, log: { line: () => {} },
      startWhisperServer: async () => { throw new Error('must not spawn under ingest:false'); },
      startTranscriptorServer: async (opts) => { captured.push(opts); return { port: opts.port, close() {} }; },
    });
    expect(captured).toHaveLength(0);   // gate holds: existing ingest:false boot tests never bind a real port
    app.stop();
  });

  it('TEARDOWN: boot.stop() stops BOTH the resident whisper-server and the :23390 endpoint', async () => {
    const { start } = fakeStart();
    const stops = { whisper: 0, server: 0 };
    const config = { whatsapp: {}, agents: AG, transcriptor: { enabled: true, port: 23390, server: { enabled: true, command: 'ws.exe', model: '/m/large-v3.bin', port: 8089 } }, transcription: { server: { token: 'K' } } };
    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => emptyState(), writeState: async () => {},
      io: memIo(), ingest: true,
      spawn: () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } }),
      reapPort: () => 0,
      startWhisperServer: async () => ({ url: 'http://127.0.0.1:8089', isAlive: () => true, stop: () => { stops.whisper++; } }),
      startTranscriptorServer: async (opts) => ({ port: opts.port, close: () => { stops.server++; } }),
      now: () => Date.UTC(2026, 5, 29, 14, 5), tickMs: 0, log: { line: () => {} },
    });
    // resident server enabled → whisper-server spawn is the first await; let the un-awaited chain settle.
    await new Promise((r) => setTimeout(r, 0));
    app.stop();
    expect(stops.whisper).toBe(1);
    expect(stops.server).toBe(1);
  });
});

// PERSONA = `default: true` (operator 2026-07-10, agent-identity refactor): the persona is
// the single default agent, resolved by the `default: true` marker — NOT hardcoded e/egpt.
// boot is FATAL on zero or more-than-one default agent, and the persona's KEY becomes the
// being-id (so a persona keyed `assistant` boots + wakes on its OWN handles, no e/egpt magic).
describe('boot() — persona default:true rule', () => {
  const bootWith = (agents) => {
    const { start } = fakeStart();
    return boot({
      readConfig: () => ({ whatsapp: {}, agents }),
      startBridge: start, makeSession: fakeSession,
      loadState: async () => emptyState(), writeState: async () => {},
      io: memIo(), ingest: false, tickMs: 0, log: { line: () => {} },
    });
  };

  it('FATAL when NO agent carries default:true (was: any e/egpt handle)', async () => {
    await expect(bootWith({ egpt: { configuration: 'egpt', handles: ['e', 'egpt'] } })).rejects.toThrow(/default: true/);
  });

  it('FATAL when MORE THAN ONE agent carries default:true', async () => {
    await expect(bootWith({
      egpt: { configuration: 'egpt', handles: ['e'], default: true },
      alt:  { configuration: 'egpt', handles: ['a'], default: true },
    })).rejects.toThrow(/exactly one/);
  });

  it('a persona keyed "assistant" (default:true, handles [a]) boots + wakes on its OWN handles, personaEmoji from IT (no e/egpt)', async () => {
    let opts = null;
    const start = async (o) => { opts = o; return { async send() { return { ok: true }; }, startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; }, isAlive: () => true, stop() {} }; };
    const app = await boot({
      readConfig: () => ({ whatsapp: {}, agents: { assistant: { configuration: 'egpt', handles: ['a'], body_emoji: '🤖', default: true } } }),
      startBridge: start, makeSession: fakeSession,
      loadState: async () => emptyState(), writeState: async () => {},
      io: memIo(), ingest: false, tickMs: 0, log: { line: () => {} },
    });
    expect(opts.wakeWords.sort()).toEqual(['a', 'assistant']);   // the default agent's key + handles — NOT e/egpt
    expect(opts.personaEmoji).toBe('🤖');                        // resolved from the default agent's body_emoji
    app.stop();
  });
});
