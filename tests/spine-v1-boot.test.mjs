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
import { describe, it, expect, beforeAll, afterAll , vi } from 'vitest';
// A PRIVATE profile for this file. The ROOM RUNG is now ONE shared file
// (config/rooms.yaml), so files running in parallel against the suite's shared
// throwaway profile would race on it. egpt-home.mjs freezes EGPT_HOME at module
// load, so this must run BEFORE the imports — vi.hoisted is what does that.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-spine-v1-boot-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { echoRank } from '../src/spine/echo-priority.mjs';   // pure (no EGPT_HOME) → safe to static-import

const tmpHome = join(os.tmpdir(), `egpt-v1-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = tmpHome;

let boot, emptyState, ensureContact, shouldReapStrayWhisper, whisperPortOf, computeShellHeader, chatIdForEntity;
beforeAll(async () => {
  ({ boot, shouldReapStrayWhisper, whisperPortOf, computeShellHeader, chatIdForEntity } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch {}
});

// Pre-seed a conversation's persona mode in the shared state (modes live in
// conversations.yaml now, not config.auto_modes). The persona is a being keyed by its map
// key — 'egpt' in these configs (operator 2026-07-10) — so the mode goes under
// entry.agents.egpt (phase 1, 2026-08-14), where gating reads it via getBeing(defaultKey).
// No threadId → still "fresh".
function seedMode(state, mode, chatId = '!room:beeper.com', name = 'fam') {
  const ens = ensureContact(state, 'whatsapp', chatId, { pushedName: name, slugHint: name });
  const entry = ens.state.contacts.whatsapp[chatId];
  entry.agents = { ...(entry.agents ?? {}), egpt: { ...(entry.agents?.egpt ?? {}), mode } };
  return ens.state;
}

// fake Beeper transport: captures the host onIncoming so the test can drive inbound.
// Also captures readTranscript — the seam boot wires so the bare-@e-reply-to-voice-note
// shortcut can reuse a note's arrival transcription from transcript.md (never re-transcribe).
function fakeStart() {
  const spy = { onIncoming: null, readTranscript: null, sent: [], streams: [] };
  const start = async (opts) => {
    spy.onIncoming = opts.onIncoming;
    spy.readTranscript = opts.readTranscript;
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

// MULTI-CONNECTION fake transport (operator 2026-08-30): boot() now calls startBridge once per
// DISTINCT resolved token (src/spine/boot.mjs bridgeForToken), so this variant of fakeStart
// keys a SEPARATE spy per opts.beeperToken — proving, in an end-to-end boot()+spine drive, that
// each token got its OWN bridge instance (not just its own `beeperToken` field on a shared one).
function fakeMultiStart() {
  const byToken = new Map();   // beeperToken -> { onIncoming, sent, streams }
  const start = async (opts) => {
    const spy = { onIncoming: opts.onIncoming, sent: [], streams: [] };
    byToken.set(opts.beeperToken, spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true, confirmedId: `id-${spy.sent.length}` }; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      isAlive: () => true, stop() {},
    };
  };
  return { start, byToken };
}

// fake claude session: the warm pool calls makeSession(brainOptions) → { turn, close, sessionId }.
function fakeSession(opts) {
  return { sessionId: opts.sessionId ?? 'sess-1', async turn(message, onUpdate) { onUpdate?.(`↩ ${message}`); return { text: `↩ ${message}`, sessionId: this.sessionId }; }, close() {} };
}

// Complete in-memory fs seam: transcript and stats exercise their real read/merge/write
// paths without falling through to the host filesystem.
function memIo() {
  const files = new Map();
  const dirs = new Set();
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    files,
    appendFile: async (path, data) => files.set(path, `${files.get(path) ?? ''}${data}`),
    writeFile: async (path, data) => files.set(path, String(data)),
    readFile: async (path) => {
      if (!files.has(path)) throw missing(path);
      return files.get(path);
    },
    mkdir: async (path) => { dirs.add(path); },
    existsSync: (path) => files.has(path) || dirs.has(path),
    readdir: async (path) => [...files.keys()]
      .filter((file) => dirname(file) === path)
      .map((file) => file.slice(path.length + 1)),
    rename: async (from, to) => {
      if (!files.has(from)) throw missing(from);
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

describe('boot()', () => {
  it("assembles the v1 pipe and round-trips an 'on'-mode message bridge→brain→bridge", async () => {
    const { start, spy } = fakeStart();
    let state = seedMode(emptyState(), 'on');
    // access_level: 'regular' (operator 2026-08-16 structural gate) — brainpool.turn() now
    // refuses to run any being with no accessLevel at either tier; this test drives a real
    // reply turn through the real spine, so it needs one, same as a real config.yaml would.
    const config = { whatsapp: {}, node_name: 'kg', agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, conversation_defaults: { access_level: 'regular' } } } };

    const io = memIo();
    const app = await boot({
      readConfig: () => config,
      startBridge: start,
      makeSession: fakeSession,
      loadState: async () => state,
      writeState: async (s) => { state = s; },
      io, ingest: false,
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

    // the conversation's claude session was persisted onto the contact — under
    // agents.egpt now (phase 1, 2026-08-14), not a flat threadId
    const c = state.contacts?.whatsapp ?? {};
    const entry = Object.values(c)[0];
    expect(entry.agents.egpt.threadId).toBe('sess-1');

    const stats = [...io.files.entries()].find(([path]) => path.endsWith(join('whatsapp', 'fam.yaml')))?.[1];
    expect(stats).toContain('chat_id: "!room:beeper.com"');
    expect(stats).toContain('u-1:');
    expect(stats).toContain('id: sess-1');

    app.stop();
  });

  // TRANSCRIPT-REUSE SEAM WIRING (operator 2026-07-20): boot must hand the beeper bridge a
  // NON-inert readTranscript — the bridge's own default is `async () => null` (inert), so the
  // @e-reply-to-voice-note shortcut can only fire once the HOST resolves chatID → transcript.md.
  // This locks that boot wires it AND that it reads the SAME file the transcript service writes
  // (via the reused resolveConvDir: contacts.resolve → slugDir), never a duplicated/guessed path.
  it('wires a NON-inert readTranscript that reads the chat transcript.md via the pipeline resolution', async () => {
    const { start, spy } = fakeStart();
    let state = seedMode(emptyState(), 'on');
    const config = { whatsapp: {}, node_name: 'kg', agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } } };
    const io = memIo();
    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io, ingest: false, now: () => Date.UTC(2026, 5, 29, 14, 5), tickMs: 0, log: { line: () => {} },
    });

    // boot handed the bridge a real reader, not the inert `async () => null` default
    expect(spy.readTranscript).toBeTypeOf('function');

    // Drive one inbound so the transcript service writes transcript.md into memIo, keyed by the
    // chat's resolved slugDir — the SAME path readTranscript resolves to.
    await spy.onIncoming('hola E', {
      chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
      userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1',
    });

    // readTranscript resolves surface/slug via the reused resolveConvDir and returns THAT file.
    const doc = await spy.readTranscript('!room:beeper.com', { chatName: 'fam', network: 'whatsapp' });
    expect(doc).toContain('An@[fam].wa (14:05) #m1: hola E');   // the dispatch line the writer logged

    // A chat with no transcript resolves cleanly to null (fail-safe, no throw).
    expect(await spy.readTranscript('!ghost:beeper.com', { chatName: 'ghost', network: 'whatsapp' })).toBe(null);

    app.stop();
  });

  it("respects gating: a 'mute' chat invokes no brain and sends nothing", async () => {
    const { start, spy } = fakeStart();
    let state = seedMode(emptyState(), 'mute');
    const config = { whatsapp: {}, node_name: 'kg', agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } } };
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
    const config = { whatsapp: {}, node_name: 'kg', agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } } };
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
    const config = { whatsapp: {}, node_name: 'kg', agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } }, heartbeats: { alive: { frequency: '1s' } } };
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
    const readonly = await fs.readFile(join(tmpHome, 'heartbeats.readonly.yaml'), 'utf8');
    expect(readonly).toContain('DO NOT EDIT');
    expect(readonly).toContain('name: alive');
    expect(readonly).toContain('command: echo beat > state/alive.txt');
    expect(readonly).not.toContain('builtin');

    app.stop();
  });

  it('the readonly view has NO internal row; a NEW entity heartbeat is picked up on the VERY NEXT inbound message — no tick, no timer', async () => {
    const { start, spy } = fakeStart();
    let state = seedMode(emptyState(), 'on');
    const config = { whatsapp: {}, node_name: 'kg', agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } } };
    const fakeSpawn = () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } });

    const app = await boot({
      readConfig: () => config, startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), ingest: false,
      now: () => Date.UTC(2026, 5, 29, 14, 5),
      tickMs: 0, aliveMs: 60_000, spawn: fakeSpawn,
      log: { line: () => {} },
    });

    const readonlyPath = join(tmpHome, 'heartbeats.readonly.yaml');
    const before = await fs.readFile(readonlyPath, 'utf8');
    // config refresh rides handleFast now (spine.mjs, on message arrival) — there is still no
    // internal beat and no internal row
    expect(before).not.toContain('heartbeats-reload');
    expect(before).not.toContain('spine (internal)');
    expect(before).toContain('name: alive');
    expect(before).not.toContain('whatsapp/new-chat:ping');

    // a NEW conversation folder with its own heartbeat appears on disk after boot — nothing
    // deleted, no tick fired
    const newDir = join(tmpHome, 'conversations', 'whatsapp', 'new-chat');
    await fs.mkdir(newDir, { recursive: true });
    // Its heartbeat lives in the ROOM RUNG (config/rooms.yaml, keyed by ns), not
    // in the folder — the folder appearing is what makes it a new entity.
    await fs.mkdir(join(tmpHome, 'config'), { recursive: true });
    await fs.writeFile(join(tmpHome, 'config', 'rooms.yaml'),
      ['rooms:', '  whatsapp/new-chat:', '    heartbeats:', '      ping:',
       '        frequency: 30s', '        command: node ping.js', ''].join(String.fromCharCode(10)), 'utf8');

    // ONE inbound message picks it up — the refresh is awaited inside handleFast, before this
    // resolves, so by the time onIncoming settles the readonly view is already rewritten
    await spy.onIncoming('hola', { chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp', userId: 'u-1', senderName: 'An', msgKey: 'm2' });

    expect(await fs.readFile(readonlyPath, 'utf8')).toContain('whatsapp/new-chat:ping');

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
    // optsList: EVERY startBridge call, in order (operator 2026-08-30, multi-connection Beeper —
    // boot now calls startBridge once per DISTINCT resolved token, not always once). `opts`
    // stays the LAST call's, unchanged for every single-connection caller below.
    const optsList = [];
    const start = async (o) => {
      opts = o;
      optsList.push(o);
      return { async send() { return { ok: true }; }, startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; }, isAlive: () => true, stop() {} };
    };
    const app = await boot({
      // node_name is MANDATORY since 2026-07-26 (it IS the structural node signature — boot
      // refuses to start without one), so the helper supplies a default; a case that cares about
      // the node name still sets its own, which the spread keeps.
      readConfig: () => ({ node_name: 'kg', ...config }), startBridge: start, makeSession: fakeSession,
      loadState: async () => emptyState(), writeState: async () => {},
      io: memIo(), ingest: false, tickMs: 0, log: { line: () => {} },
    });
    return { opts, optsList, app };
  }

  it('beeper.use resolves the ACTIVE account token', async () => {
    const { opts, optsList, app } = await captureBoot({ agents: AG, beeper: { use: 'main', main: { account: 'a@b', token: 'TOK-main' }, alt: { account: 'c@d', token: 'TOK-alt' } } });
    expect(opts.beeperToken).toBe('TOK-main');
    expect(optsList).toHaveLength(1);   // no agent names `alt` → exactly ONE bridge instance, never one per declared account
    app.stop();
  });

  it('back-compat: no beeper block → top-level beeper_token still resolves the token', async () => {
    const { opts, optsList, app } = await captureBoot({ agents: AG, beeper_token: 'TOK-legacy' });
    expect(opts.beeperToken).toBe('TOK-legacy');
    expect(optsList).toHaveLength(1);
    app.stop();
  });

  // MULTI-CONNECTION (operator 2026-08-30): more than one Beeper account wired into ONE node —
  // agents.<name>.beeper_connection names which `beeper:` block an agent's own outbound rides.
  // Dedup is by RESOLVED TOKEN, not connection name, so a node where nobody sets the field still
  // collapses to exactly one bridge — proven directly by this back-compat variant.
  it('back-compat: MULTIPLE agents, none set beeper_connection → still exactly ONE startBridge call', async () => {
    const { opts, optsList, app } = await captureBoot({
      agents: {
        egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true },
        wren: { configuration: 'egpt', handles: ['wren'] },
      },
      beeper_token: 'TOK-legacy',
    });
    expect(optsList).toHaveLength(1);
    expect(opts.beeperToken).toBe('TOK-legacy');
    app.stop();
  });

  // END-TO-END: two agents, two beeper: connections, one names `beeper_connection` — drives a
  // REAL reply from each through boot()/spine (fakeMultiStart, above) and asserts (a) exactly
  // TWO startBridge calls (one per distinct token) and (b)/(c) each being's OUTBOUND reply lands
  // on ITS OWN bridge spy, never the other's. Both inbound messages arrive over the SAME (only-
  // wired) default connection — inbound dispatch (bridge.onMessage) still rides ONE connection
  // (this task's scope is OUTBOUND routing only, a documented gap for a follow-up); it's the
  // reply that must split by being, which is exactly what sender.mjs's per-being bridgeOf proves.
  //
  // egpt's chat is seeded mode:'on' (seedMode, top of file) — same reason the top-level 'boot()'
  // test does: the PERSONA's mention gate reads ev.mention, which is the BRIDGE's own wake-word
  // computation (identity.mjs), and this fake bridge is a bare stub that never computes it —
  // mode 'on' replies regardless. rodz needs no such seeding: a NON-default agent's mention is
  // the ROUTER's own text scan (router.mjs targetFor), so its default 'mention' mode gates
  // correctly off the literal "@rodz" in the message body alone.
  it('per-agent beeper_connection routes each being\'s OUTBOUND reply to its OWN bridge — no cross-talk', async () => {
    const { start, byToken } = fakeMultiStart();
    const config = {
      node_name: 'kg',
      whatsapp: {},
      beeper: {
        use: 'main',
        main: { account: 'a@b', token: 'fake-token-1' },
        rodz: { account: 'c@d', token: 'fake-token-2' },
      },
      agents: {
        egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, conversation_defaults: { access_level: 'regular' } },
        rodz: { configuration: 'egpt', handles: ['rodz'], beeper_connection: 'rodz', conversation_defaults: { access_level: 'regular' } },
      },
    };
    let state = seedMode(emptyState(), 'on', '!room1:beeper.com', 'fam1');
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

    expect(byToken.size).toBe(2);   // exactly one startBridge call per distinct token
    const mainSpy = byToken.get('fake-token-1');
    const rodzSpy = byToken.get('fake-token-2');
    expect(mainSpy.onIncoming).toBeTypeOf('function');

    // egpt (no beeper_connection → falls to beeper.use → main), mode 'on' → replies unconditionally
    await mainSpy.onIncoming('hola egpt', {
      chatId: '!room1:beeper.com', chatName: 'fam1', network: 'whatsapp',
      userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1',
    });
    // rodz (beeper_connection: 'rodz') answers an @rodz-addressed message — delivered over the
    // SAME inbound socket (mainSpy), since only the default connection's onMessage is wired.
    await mainSpy.onIncoming('@rodz hola rodz', {
      chatId: '!room2:beeper.com', chatName: 'fam2', network: 'whatsapp',
      userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm2',
    });

    expect(mainSpy.streams).toHaveLength(1);
    expect(mainSpy.streams[0].finals[0]).toContain('hola egpt');
    expect(mainSpy.streams[0].chatId).toBe('!room1:beeper.com');
    expect(rodzSpy.streams).toHaveLength(1);
    expect(rodzSpy.streams[0].finals[0]).toContain('hola rodz');
    expect(rodzSpy.streams[0].chatId).toBe('!room2:beeper.com');
    // no cross-talk: neither connection carries the other being's reply
    expect(mainSpy.sent).toHaveLength(0);
    expect(rodzSpy.sent).toHaveLength(0);

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

  // SURFACES ARE OPEN (operator ruling): a network with no `networks.<surface>` block — e.g. a
  // brand-new Google Voice surface arriving via Beeper — has no allowed_users to borrow, and
  // must NOT fall back to whatsapp's list. surfaceCfg resolves an absent block to {} →
  // allowed_users [] → isAllowedUser denies EVERYONE, fail-closed by default (this is intended,
  // not a bug: authorizing a new surface is an explicit config step).
  it('a brand-new surface with no networks.<surface> block denies everyone by default (fail-closed)', async () => {
    const { opts, app } = await captureBoot({ agents: AG, networks: {
      whatsapp: { chat_ids: ['self-1'], allowed_users: ['op@wa'] },
    } });
    expect(opts.isAllowedUser('op@wa', 'googlevoice')).toBe(false);   // no borrowing whatsapp's list
    expect(opts.isAllowedUser('anyone', 'googlevoice')).toBe(false);
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

  // THE REPLY GATE'S OWN LIST (operator 2026-09-01). The beeper limb's bare-reply gate — reply
  // with nothing but a wake token to read that message back — is a DIFFERENT consumer from the
  // mention gate, so it gets its own list: the persona's wake tokens ∪ the persona's OWN
  // fallback_handle tokens. `wakeWords` is deliberately NOT widened: it feeds atE, computed
  // BEFORE any membership guard exists to say otherwise, which is the two-spines-answer-one-
  // mention bug the fallback exists to prevent (src/spine/router.mjs).
  it('replyWakeWords = the persona\'s handles ∪ its fallback tokens; wakeWords stays the DECLARED handles alone', async () => {
    const kg = await captureBoot({ agents: { egpt: { configuration: 'egpt', handles: ['ekg', 'egptkg'], fallback_handle: { handle: ['e', 'egpt'], unless_present: '+13472576794' }, default: true } } });
    expect([...kg.opts.wakeWords].sort()).toEqual(['egptkg', 'ekg']);                       // the MENTION path — untouched
    expect([...kg.opts.replyWakeWords].sort()).toEqual(['e', 'egpt', 'egptkg', 'ekg']);     // the REPLY gate — wider
    kg.app.stop();
    // A HALF-WRITTEN fallback is ignored here exactly as the router ignores it (fallbackWake).
    const half = await captureBoot({ agents: { egpt: { configuration: 'egpt', handles: ['ekg'], fallback_handle: { handle: ['e'] }, default: true } } });
    expect(half.opts.replyWakeWords).toEqual(['ekg']);
    half.app.stop();
    // …and a persona with NO fallback hands the two lists identical — byte-identical to before.
    const plain = await captureBoot({ agents: AG });
    expect([...plain.opts.replyWakeWords].sort()).toEqual([...plain.opts.wakeWords].sort());
    plain.app.stop();
  });

  // 👂 ECHO — REAL HRW ON A NODE-STABLE AUDIO HASH + ORDERED FAILOVER (operator 2026-07-24; revives HRW
  // over the static-priority stopgap): boot hands the bridge an echoPlan(noteKey) → { rank, winner } that
  // rendezvous-hashes the resolved peer set (transcription_service.echo.peer_priority, else legacy
  // echo_priority, else account_peers, else [self]) for the note's key PLUS the per-rank promotion step
  // echoTimeoutMs (transcription_service.echo.timeout_ms, else legacy echo_timeout_ms). The rank is
  // PER-NOTE (the bridge feeds the note's audio-byte sha256, node-stable), so the echoer ROTATES per
  // note yet the two co-account nodes AGREE (same key → same ordering). A solo node is always rank 1;
  // cfg.echo:false folds into rank 0 (hard opt-out — never post/promote); echoMaxAgeMs is unchanged
  // (orthogonal age bound). echoTimeoutMs defaults GENEROUS (20s, the double-👂 hazard).
  it('echoPlan: default solo node is rank 1 (winner); cfg.echo:false → rank 0 (never); echoTimeoutMs default 20s + override; echoMaxAgeMs default 1h + override', async () => {
    const def = await captureBoot({ agents: AG });
    expect(typeof def.opts.echoPlan).toBe('function');
    expect(def.opts.echoPlan('any-note')).toEqual({ rank: 1, winner: true });   // solo → rank 1 (lone-node echo behavior)
    expect(def.opts.echoTimeoutMs).toBe(20_000);                                // generous default (double-👂 hazard)
    expect(def.opts.echoMaxAgeMs).toBe(3_600_000);
    def.app.stop();
    const off = await captureBoot({ agents: AG, echo: false, echo_max_age_ms: 1000, echo_timeout_ms: 5000 });
    expect(off.opts.echoPlan('any-note')).toEqual({ rank: 0, winner: false });  // hard opt-out — never post/promote
    expect(off.opts.echoTimeoutMs).toBe(5000);                                  // tunable
    expect(off.opts.echoMaxAgeMs).toBe(1000);
    off.app.stop();
  });

  it('echoPlan: co-account HRW rank — matches echoRank over the peer set, one rank-1 per note, reshuffles per note', async () => {
    const kg = await captureBoot({ agents: AG, node_name: 'kg', account_peers: ['kg', 'do'] });
    const doNode = await captureBoot({ agents: AG, node_name: 'do', account_peers: ['kg', 'do'] });
    // boot's echoPlan is per-note HRW over the resolved peer set, keyed on the note key (the bridge feeds
    // the audio hash). It matches the pure echoRank for the same key, and the two nodes are a
    // permutation of 1..2 for EVERY note (exactly one winner).
    for (const k of ['audio-a', 'audio-b', 'audio-c', 'audio-d']) {
      expect(kg.opts.echoPlan(k).rank).toBe(echoRank('kg', ['kg', 'do'], k));
      expect(new Set([kg.opts.echoPlan(k).rank, doNode.opts.echoPlan(k).rank])).toEqual(new Set([1, 2]));
      expect(kg.opts.echoPlan(k).winner).toBe(!doNode.opts.echoPlan(k).winner);
    }
    // PER-NOTE (not the old static rank): different note keys reshuffle who is rank 1 — kg sees BOTH
    // ranks across notes (the old static impl gave a single fixed value).
    const kgRanks = new Set(Array.from({ length: 64 }, (_, i) => kg.opts.echoPlan(`audio-sha-${i}`).rank));
    expect(kgRanks).toEqual(new Set([1, 2]));
    kg.app.stop();
    doNode.app.stop();
  });

  it('echoPlan: transcription_service.echo.peer_priority is READ and WINS over legacy echo_priority / account_peers; timeout_ms too', async () => {
    // Give the three sources DIFFERENT sets so precedence is observable: if the legacy echo_priority
    // [kg] (a solo set) had won, kg would be rank 1 for EVERY note; the new peer_priority [do, kg]
    // instead reshuffles kg across both ranks.
    const node = await captureBoot({ agents: AG, node_name: 'kg',
      transcription_service: { echo: { method: 'hrw', participants: 'group-members', peer_priority: ['do', 'kg'], timeout_ms: 7000 } },
      echo_priority: ['kg'],                // legacy — would make kg solo (rank 1 always) if used → IGNORED
      account_peers: ['kg', 'do', 'zz'],    // also IGNORED (new home wins)
    });
    for (const k of ['a', 'b', 'c', 'd']) {
      expect(node.opts.echoPlan(k).rank).toBe(echoRank('kg', ['do', 'kg'], k));   // resolved set is the new peer_priority
    }
    const ranks = new Set(Array.from({ length: 64 }, (_, i) => node.opts.echoPlan(`k${i}`).rank));
    expect(ranks).toEqual(new Set([1, 2]));   // reshuffles → the legacy solo [kg] was NOT used
    expect(node.opts.echoTimeoutMs).toBe(7000);   // new transcription_service.echo.timeout_ms read
    node.app.stop();
  });

  it('back-compat: legacy echo_priority / echo_timeout_ms are still READ when transcription_service.echo is absent', async () => {
    // A not-yet-migrated config keeps booting: the peer set comes from the legacy top-level echo_priority
    // and the failover step from the legacy echo_timeout_ms.
    const kg = await captureBoot({ agents: AG, node_name: 'kg', echo_priority: ['do', 'kg'], echo_timeout_ms: 9000 });
    for (const k of ['a', 'b', 'c', 'd']) {
      expect(kg.opts.echoPlan(k).rank).toBe(echoRank('kg', ['do', 'kg'], k));   // resolved from legacy echo_priority
    }
    expect(kg.opts.echoTimeoutMs).toBe(9000);   // resolved from legacy echo_timeout_ms
    kg.app.stop();
  });

  it('boot ASSERTION: an echoing node NOT in its own echo peer set is FATAL (kills the silent-divergence class)', async () => {
    // node_name 'zz' isn't in the peer set → rank-0 never-post sentinel → it would SILENTLY never echo.
    // Fatal at boot so the operator fixes the config (echo:false is the sanctioned opt-out). Fires via
    // the NEW home AND the legacy fallback.
    await expect(captureBoot({ agents: AG, node_name: 'zz', transcription_service: { echo: { peer_priority: ['do', 'kg'] } } }))
      .rejects.toThrow(/not in the 👂 echo peer set/);
    await expect(captureBoot({ agents: AG, node_name: 'zz', echo_priority: ['do', 'kg'] }))
      .rejects.toThrow(/not in the 👂 echo peer set/);
  });

  it('account_peers parsed + exposed on the boot return', async () => {
    const { app } = await captureBoot({ agents: AG, node_name: 'kg', account_peers: ['kg', 'do'] });   // node_name in peers → valid echo config (boot asserts membership)
    expect(app.accountPeers).toEqual(['kg', 'do']);
    app.stop();
  });
});

// THE PERMANENT SHELL HEADER (operator 2026-07-27): computeShellHeader is the pure derivation
// boot hands the shell limb — the room/help portion always renders; a trailing groups segment
// is built from THIS node's own `agents:` map, grouped by where each entry routes. Tested
// directly here (mirrors shouldReapStrayWhisper / whisperPortOf) against directly
// constructed fixtures — never the live config.yaml.
describe('computeShellHeader — the permanent shell status line', () => {
  it('short-handle pick: the SHORTEST string in `handles:` wins (e.g. [e, egpt] → @e)', () => {
    const s = computeShellHeader({
      nodeName: 'kg',
      agents: { egpt: { handles: ['e', 'egpt'], default: true } },
    });
    expect(s).toBe('🟢 room: lobby — ? for help · ctrl-d = send — kg: @e');
  });

  it('no `to:` → grouped under nodeName (LOCAL); a top-level `to: x.node` → grouped under the part after the last dot', () => {
    const s = computeShellHeader({
      nodeName: 'kg',
      agents: {
        egpt: { handles: ['e', 'egpt'], default: true },       // no `to:` → local, keyed by nodeName
        don: { handles: ['d', 'don'], to: 'don.do' },          // top-level `to:` → group 'do'
      },
    });
    expect(s).toBe('🟢 room: lobby — ? for help · ctrl-d = send — kg: @e · do: @d');
  });

  it('carol-shaped `paths:` list groups by the FIRST entry\'s `to:` node segment', () => {
    const s = computeShellHeader({
      nodeName: 'kg',
      agents: {
        egpt: { handles: ['e', 'egpt'], default: true },
        carol: {
          handles: ['carol'],
          paths: [
            { path1: { relay_channel: 'x', network: 'y', to: 'don.do' } },
            { path2: { relay_channel: 'x', network: 'y', to: 'someone.other' } },   // first entry wins, not this one
          ],
        },
      },
    });
    expect(s).toBe('🟢 room: lobby — ? for help · ctrl-d = send — kg: @e · do: @carol');
  });

  it('an agent with no `handles:` at all falls back to its map key as the handle', () => {
    const s = computeShellHeader({
      nodeName: 'kg',
      agents: { egpt: { handles: ['e', 'egpt'], default: true }, wren: { to: 'ed.do' } },
    });
    expect(s).toBe('🟢 room: lobby — ? for help · ctrl-d = send — kg: @e · do: @wren');
  });

  it('multiple agents routing to the SAME node segment combine into ONE group, in agent-declaration order (the brief\'s own example shape)', () => {
    const s = computeShellHeader({
      nodeName: 'kg',
      agents: {
        egpt: { handles: ['e', 'egpt'], default: true },
        carol: { handles: ['carol'], paths: [{ path1: { to: 'don.do' } }] },
        wren: { handles: ['wren'], to: 'ed.do' },
        cara: { handles: ['cara'], to: 'ed.do' },
        don: { handles: ['don'], to: 'don.do' },
      },
    });
    expect(s).toBe('🟢 room: lobby — ? for help · ctrl-d = send — kg: @e · do: @carol @wren @cara @don');
  });

  it('an empty/absent `agents:` map does not throw — still returns the persona/help portion, no groups segment', () => {
    expect(computeShellHeader({ nodeName: 'kg', agents: {} })).toBe('🟢 room: lobby — ? for help · ctrl-d = send');
    expect(computeShellHeader({ nodeName: 'kg' })).toBe('🟢 room: lobby — ? for help · ctrl-d = send');
    expect(() => computeShellHeader({})).not.toThrow();
  });

  it('`defaultNode` set to a DIFFERENT node than `nodeName` inserts a " → <default_node>" segment right after the room segment\'s value', () => {
    const s = computeShellHeader({ nodeName: 'kg', defaultNode: 'do' });
    expect(s).toBe('🟢 room: lobby → do — ? for help · ctrl-d = send');
  });

  it('`defaultNode` naming THIS node itself (case-insensitive) renders with NO arrow — identical to the unset case', () => {
    expect(computeShellHeader({ nodeName: 'kg', defaultNode: 'kg' }))
      .toBe('🟢 room: lobby — ? for help · ctrl-d = send');
    expect(computeShellHeader({ nodeName: 'kg', defaultNode: 'KG' }))
      .toBe('🟢 room: lobby — ? for help · ctrl-d = send');
  });

  it('`defaultNode` absent or empty string renders with NO arrow', () => {
    expect(computeShellHeader({ nodeName: 'kg' }))
      .toBe('🟢 room: lobby — ? for help · ctrl-d = send');
    expect(computeShellHeader({ nodeName: 'kg', defaultNode: '' }))
      .toBe('🟢 room: lobby — ? for help · ctrl-d = send');
  });

  // Live status-line room reflection (operator 2026-08-16, reworded 2026-08-17): /rooms join
  // <slug> should show up in the SAME header string boot pushes to the shell — currentRoom is
  // the seam. Rendered as `room: <slug>`, never a `lobby → X` arrow (that read like cross-node
  // routing, a different concept — see the defaultNode arrow below).
  describe('`currentRoom` — the /rooms join reflection', () => {
    it('a joined room renders as "room: <currentRoom>"', () => {
      expect(computeShellHeader({ nodeName: 'kg', currentRoom: 'acim' }))
        .toBe('🟢 room: acim — ? for help · ctrl-d = send');
    });

    it('currentRoom absent, empty, or null renders "room: lobby" (baseline unchanged)', () => {
      expect(computeShellHeader({ nodeName: 'kg' }))
        .toBe('🟢 room: lobby — ? for help · ctrl-d = send');
      expect(computeShellHeader({ nodeName: 'kg', currentRoom: '' }))
        .toBe('🟢 room: lobby — ? for help · ctrl-d = send');
      expect(computeShellHeader({ nodeName: 'kg', currentRoom: null }))
        .toBe('🟢 room: lobby — ? for help · ctrl-d = send');
    });

    it("currentRoom === 'lobby' renders \"room: lobby\" — 'lobby' means no room joined, never a real room/lobby folder (same rule as redirectShellToRoom)", () => {
      expect(computeShellHeader({ nodeName: 'kg', currentRoom: 'lobby' }))
        .toBe('🟢 room: lobby — ? for help · ctrl-d = send');
    });

    it('a joined room AND a routed defaultNode: the defaultNode arrow chains after the room value ("room: acim → do")', () => {
      expect(computeShellHeader({ nodeName: 'kg', currentRoom: 'acim', defaultNode: 'do' }))
        .toBe('🟢 room: acim → do — ? for help · ctrl-d = send');
    });

    it('a joined room still combines with the agents/groups trailing segment', () => {
      const s = computeShellHeader({
        nodeName: 'kg', currentRoom: 'acim',
        agents: { egpt: { handles: ['e', 'egpt'], default: true } },
      });
      expect(s).toBe('🟢 room: acim — ? for help · ctrl-d = send — kg: @e');
    });
  });
});

// AN `agent:` HEARTBEAT'S ENTITY (operator 2026-08-22): the heartbeat loader knows an entity
// by the walk's namespace (`<surface>/<slug>`); brainpool.turn is keyed by (surface, chatId).
// chatIdForEntity is the pure reverse lookup boot injects between them — tested directly here
// (mirrors whisperPortOf / computeShellHeader), never against the live conversations.yaml.
describe('chatIdForEntity — a heartbeat entity namespace → the conversation a turn runs in', () => {
  const state = { contacts: {
    whatsapp: {
      '!fam:beeper.com': { slug: 'fam-2607201416' },
      '!alias:beeper.com': { aliasOf: '!fam:beeper.com', slug: 'fam-2607201416' },   // aliases never win
    },
    shell: { main: { slug: 'lobby' } },
  } };

  it('a registered conversation resolves to its JID', () => {
    expect(chatIdForEntity(state, 'whatsapp/fam-2607201416')).toEqual({ surface: 'whatsapp', chatId: '!fam:beeper.com' });
    expect(chatIdForEntity(state, 'shell/lobby')).toEqual({ surface: 'shell', chatId: 'main' });
  });

  it("a room needs no registry entry at all — a room's chatId IS its name (fixedSlugFor)", () => {
    expect(chatIdForEntity(state, 'room/dj-son')).toEqual({ surface: 'room', chatId: 'dj-son' });
    expect(chatIdForEntity({}, 'room/dj-son')).toEqual({ surface: 'room', chatId: 'dj-son' });
  });

  it('an unknown conversation, a malformed ns, or an empty half → null (the beat logs and fires nothing)', () => {
    expect(chatIdForEntity(state, 'whatsapp/never-seen')).toBeNull();
    expect(chatIdForEntity(state, 'no-slash')).toBeNull();
    expect(chatIdForEntity(state, '/lobby')).toBeNull();
    expect(chatIdForEntity(state, 'shell/')).toBeNull();
    expect(chatIdForEntity(state, null)).toBeNull();
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
    const config = { whatsapp: {}, node_name: 'kg', ...profile({ fallback_order: ['remote', 'cli'] }) };
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
    const config = { whatsapp: {}, node_name: 'kg', ...profile({
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
    const config = { whatsapp: {}, node_name: 'kg', agents: AG, transcriptor: { enabled: true, bind: '0.0.0.0', port: 23390 }, transcription: { server: { token: 'BUSKEY' } } };
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
    const config = { whatsapp: {}, node_name: 'kg', agents: AG, transcriptor: { enabled: true, port: 23390 }, transcription: { server: { token: 'K' } } };
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
    const config = { whatsapp: {}, node_name: 'kg', agents: AG, transcriptor: { enabled: true, port: 23390, server: { enabled: true, command: 'ws.exe', model: '/m/large-v3.bin', port: 8089 } }, transcription: { server: { token: 'K' } } };
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
      readConfig: () => ({ whatsapp: {}, node_name: 'kg', agents }),
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
      readConfig: () => ({ whatsapp: {}, node_name: 'kg', agents: { assistant: { configuration: 'egpt', handles: ['a'], body_emoji: '🤖', default: true } } }),
      startBridge: start, makeSession: fakeSession,
      loadState: async () => emptyState(), writeState: async () => {},
      io: memIo(), ingest: false, tickMs: 0, log: { line: () => {} },
    });
    expect(opts.wakeWords.sort()).toEqual(['a']);                // the default agent's DECLARED handles — not its key, not e/egpt
    expect(opts.personaEmoji).toBe('🤖');                        // resolved from the default agent's body_emoji
    app.stop();
  });
});

// THE STRUCTURAL NODE SIGNATURE (operator 2026-07-26: "spine doesn't boot without the invisible
// ones. the visible one are prescindable, there are only for human purviews"). The invisible layer
// every outbound frame carries is `node_name` TAG-encoded, so requiring the marker and requiring
// node_name are ONE requirement — there is no second `node_signature:` key to forget. Fatal in the
// same shape as the persona-agent rule above; the VISIBLE bridge_signature_* stay optional.
describe('boot() — the structural node signature is mandatory', () => {
  const AG = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } };
  const bootWith = (extra) => {
    const { start } = fakeStart();
    return boot({
      readConfig: () => ({ whatsapp: {}, agents: AG, ...extra }),
      startBridge: start, makeSession: fakeSession,
      loadState: async () => emptyState(), writeState: async () => {},
      io: memIo(), ingest: false, tickMs: 0, log: { line: () => {} },
    });
  };

  it('FATAL when node_name is absent — the spine refuses to start', async () => {
    await expect(bootWith({})).rejects.toThrow(/node_name/);
  });

  it('FATAL when node_name is blank/whitespace (an empty id signs nothing)', async () => {
    await expect(bootWith({ node_name: '' })).rejects.toThrow(/node_name/);
    await expect(bootWith({ node_name: '   ' })).rejects.toThrow(/node_name/);
  });

  it('the error names the config key AND how to set it', async () => {
    await expect(bootWith({})).rejects.toThrow(/config\/config\.yaml/);
    await expect(bootWith({})).rejects.toThrow(/node_name: kg/);
  });

  it('the VISIBLE layers stay OPTIONAL — empty bridge_signature_* must NOT block boot', async () => {
    const app = await bootWith({ node_name: 'kg', bridge_signature_open: '', bridge_signature_close: '' });
    expect(app).toBeTruthy();
    app.stop();
  });

  it('boot hands BOTH limbs the node name, so every surface signs structurally', async () => {
    let opts = null;
    const start = async (o) => { opts = o; return { async send() { return { ok: true }; }, startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; }, isAlive: () => true, stop() {} }; };
    const app = await boot({
      readConfig: () => ({ whatsapp: {}, agents: AG, node_name: 'kg' }),
      startBridge: start, makeSession: fakeSession,
      loadState: async () => emptyState(), writeState: async () => {},
      io: memIo(), ingest: false, tickMs: 0, log: { line: () => {} },
    });
    expect(opts.nodeName).toBe('kg');   // forwarded to the beeper limb (and through it to the 👂 echo wrap)
    app.stop();
  });
});

// ── WAKE VOCABULARY (operator 2026-07-26: "don must not wake or respond with 'egpt'" … "the yaml
//    key can be discarded, an agent reacts if its handle is invoked"). Declared `handles:` are the
//    COMPLETE wake list and the map KEY is NOT one of them; absent handles ⇒ the key IS the handle.
//    The key stays the BEING-ID (warm sessions, entry[<being>] thread blocks) — this is the wake
//    set boot hands the bridge/shell ports, nothing else.
//
//    THE LIVE BUG: one `@egpt` in a WhatsApp group produced TWO replies — kg stamped `egpt`, DOLLY
//    stamped `don` — because DOLLY's persona DISPLAYS as "don" but is still KEYED `egpt`, and the
//    key was a wake token alongside [d, don]. ──
describe('boot() — the persona wake set is its handles, not its key (operator 2026-07-26)', () => {
  const captureWake = async (agents) => {
    let opts = null;
    const start = async (o) => { opts = o; return { async send() { return { ok: true }; }, startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; }, isAlive: () => true, stop() {} }; };
    const app = await boot({
      readConfig: () => ({ whatsapp: {}, node_name: 'kg', agents }),
      startBridge: start, makeSession: fakeSession,
      loadState: async () => emptyState(), writeState: async () => {},
      io: memIo(), ingest: false, tickMs: 0, log: { line: () => {} },
    });
    app.stop();
    return opts.wakeWords;
  };

  it('REPRODUCE-FIRST: DOLLY (key `egpt`, handles [d, don], name "don") does NOT wake on @egpt', async () => {
    const wake = await captureWake({ egpt: { configuration: 'egpt', handles: ['d', 'don'], default: true, name: 'don' } });
    expect(wake).not.toContain('egpt');           // the map key is NOT a wake token
    expect([...wake].sort()).toEqual(['d', 'don']);
  });

  it('kg (key `egpt`, handles [e, egpt]) is unchanged — its key IS one of its handles', async () => {
    const wake = await captureWake({ egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, name: 'egpt' } });
    expect([...wake].sort()).toEqual(['e', 'egpt']);
  });

  it('a persona with NO handles wakes on its KEY (the fallback)', async () => {
    expect(await captureWake({ assistant: { configuration: 'egpt', default: true } })).toEqual(['assistant']);
  });

  it('`handles: []` (explicitly empty) is a COMPLETE, empty wake list — no @token wakes the persona', async () => {
    expect(await captureWake({ egpt: { configuration: 'egpt', handles: [], default: true } })).toEqual([]);
  });
});

// ── PER-CONNECTION ENDPOINT + OWNERSHIP (operator 2026-09-02) ─────────────────
// Two Beeper Desktops now run on ONE node: the agent's in Session 0 under its own
// Windows account, the operator's in Session 1. The second one to start takes the NEXT
// free port (23374 while the first holds 23373 — measured, not assumed), so a connection
// carrying only a token can address exactly ONE of them. Hence base_url, and hence a
// bridge keyed by (base_url, token) rather than by the token alone.
//
// owner_node is the WAKE half. With the SAME account live in Session 0 on BOTH nodes,
// fallback_handle's `unless_present` stops separating them — it asks whether the account
// is IN the chat, which was decisive only while one node held that account, and is now
// true for both. So both would answer. A connection names its owner; every other node
// still SENDS on it and never WAKES on it.
describe('boot() — beeper connection ENDPOINT and ownership', () => {
  const AG = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } };
  async function bootWith(config) {
    const optsList = [];
    const start = async (o) => {
      optsList.push(o);
      return { async send() { return { ok: true }; }, startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; }, isAlive: () => true, stop() {} };
    };
    const app = await boot({
      readConfig: () => ({ node_name: 'kg', ...config }), startBridge: start, makeSession: fakeSession,
      loadState: async () => emptyState(), writeState: async () => {},
      io: memIo(), ingest: false, tickMs: 0, log: { line: () => {} },
    });
    return { opts: optsList[optsList.length - 1], optsList, app };
  }

  it('base_url reaches the bridge, and ws_url is DERIVED from it', async () => {
    const { opts, app } = await bootWith({ agents: AG, beeper: { use: 'main', main: { account: 'a@b', token: 'T', base_url: 'http://127.0.0.1:23374' } } });
    expect(opts.baseUrl).toBe('http://127.0.0.1:23374');
    expect(opts.wsUrl).toBe('ws://127.0.0.1:23374/v1/ws');
    app.stop();
  });

  it('an explicit ws_url WINS over the derivation', async () => {
    const { opts, app } = await bootWith({ agents: AG, beeper: { use: 'main', main: { token: 'T', base_url: 'http://127.0.0.1:23374', ws_url: 'ws://127.0.0.1:9999/custom' } } });
    expect(opts.wsUrl).toBe('ws://127.0.0.1:9999/custom');
    app.stop();
  });

  // BACK-COMPAT, and the reason baseUrl/wsUrl are spread in ONLY when set: an explicit
  // undefined would OVERRIDE startBeeperBridge's own defaults instead of leaving them.
  it('no base_url means the keys are ABSENT, so the bridge keeps its own defaults', async () => {
    const { opts, app } = await bootWith({ agents: AG, beeper: { use: 'main', main: { account: 'a@b', token: 'T' } } });
    expect('baseUrl' in opts).toBe(false);
    expect('wsUrl' in opts).toBe(false);
    app.stop();
  });

  // THE CRUX. Same token, two Desktops. Keyed by token alone this collapsed to ONE bridge
  // pointed at whichever was built first, and the second Desktop was simply unreachable.
  it('SAME token, DIFFERENT base_url gives TWO bridges, one per Desktop', async () => {
    const { optsList, app } = await bootWith({
      agents: {
        egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true },
        rodz: { configuration: 'egpt', handles: ['rodz'], beeper_connection: 'rodz' },
      },
      beeper: {
        use: 'main',
        main: { account: 'a@b', token: 'SAME', base_url: 'http://127.0.0.1:23373' },
        rodz: { account: 'a@b', token: 'SAME', base_url: 'http://127.0.0.1:23374' },
      },
    });
    expect(optsList).toHaveLength(2);
    expect(optsList.map((o) => o.baseUrl).sort()).toEqual(['http://127.0.0.1:23373', 'http://127.0.0.1:23374']);
    app.stop();
  });

  it('same token AND same base_url still collapses to ONE bridge', async () => {
    const { optsList, app } = await bootWith({
      agents: {
        egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true },
        rodz: { configuration: 'egpt', handles: ['rodz'], beeper_connection: 'rodz' },
      },
      beeper: { use: 'main', main: { token: 'SAME', base_url: 'http://127.0.0.1:23373' }, rodz: { token: 'SAME', base_url: 'http://127.0.0.1:23373' } },
    });
    expect(optsList).toHaveLength(1);
    app.stop();
  });

  // OWNERSHIP, end to end: a connection owned by ANOTHER node must not wake this one.
  it('owner_node naming ANOTHER node means inbound never wakes this node', async () => {
    const { start, byToken } = fakeMultiStart();
    let state = seedMode(emptyState(), 'on', '!room1:beeper.com', 'fam1');
    const app = await boot({
      readConfig: () => ({
        node_name: 'kg', whatsapp: {},
        agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, conversation_defaults: { access_level: 'regular' } } },
        beeper: { use: 'rodz', rodz: { account: 'c@d', token: 'tok-rodz', owner_node: 'do' } },
      }),
      startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), ingest: false, now: () => Date.UTC(2026, 5, 29, 14, 5), tickMs: 0, log: { line: () => {} },
    });
    const spy = byToken.get('tok-rodz');
    await spy.onIncoming('hola egpt', { chatId: '!room1:beeper.com', chatName: 'fam1', network: 'whatsapp', userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1' });
    expect(spy.streams).toHaveLength(0);
    expect(spy.sent).toHaveLength(0);
    app.stop();
  });

  it('owner_node naming THIS node means inbound wakes normally', async () => {
    const { start, byToken } = fakeMultiStart();
    let state = seedMode(emptyState(), 'on', '!room1:beeper.com', 'fam1');
    const app = await boot({
      readConfig: () => ({
        node_name: 'kg', whatsapp: {},
        agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, conversation_defaults: { access_level: 'regular' } } },
        beeper: { use: 'rodz', rodz: { account: 'c@d', token: 'tok-rodz', owner_node: 'kg' } },
      }),
      startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), ingest: false, now: () => Date.UTC(2026, 5, 29, 14, 5), tickMs: 0, log: { line: () => {} },
    });
    const spy = byToken.get('tok-rodz');
    await spy.onIncoming('hola egpt', { chatId: '!room1:beeper.com', chatName: 'fam1', network: 'whatsapp', userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1' });
    expect(spy.streams).toHaveLength(1);
    expect(spy.streams[0].finals[0]).toContain('hola egpt');
    app.stop();
  });

  // A non-owned connection is OUTBOUND-ONLY, not skipped: the bridge is still built so
  // this node can send on it. Only the three inbound registrations are muted.
  it('a non-owned connection is still BUILT, so outbound still rides it', async () => {
    const { optsList, app } = await bootWith({ agents: AG, beeper: { use: 'main', main: { token: 'T', owner_node: 'do' } } });
    expect(optsList).toHaveLength(1);
    app.stop();
  });

  // The node match is case- and whitespace-tolerant, like every other node-name test.
  it('owner_node matching is case-insensitive and trimmed', async () => {
    const { start, byToken } = fakeMultiStart();
    let state = seedMode(emptyState(), 'on', '!room1:beeper.com', 'fam1');
    const app = await boot({
      readConfig: () => ({
        node_name: 'kg', whatsapp: {},
        agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, conversation_defaults: { access_level: 'regular' } } },
        beeper: { use: 'rodz', rodz: { token: 'tok-rodz', owner_node: '  KG  ' } },
      }),
      startBridge: start, makeSession: fakeSession,
      loadState: async () => state, writeState: async (s) => { state = s; },
      io: memIo(), ingest: false, now: () => Date.UTC(2026, 5, 29, 14, 5), tickMs: 0, log: { line: () => {} },
    });
    const spy = byToken.get('tok-rodz');
    await spy.onIncoming('hola egpt', { chatId: '!room1:beeper.com', chatName: 'fam1', network: 'whatsapp', userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1' });
    expect(spy.streams).toHaveLength(1);
    app.stop();
  });
});
