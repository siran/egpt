// beeper-default-connection.test.mjs — WHICH CONNECTION AN AGENT SPEAKS ON WHEN IT NAMES NONE.
//
// Operator, 2026-09-10: *"we dropped the `use:`, defaulting to primary for ingest and secondary
// for output when available"* — which encodes his older standing rule, *"primary doesn't speak if
// secondary is present. simple rule."*
//
// Until now the ONLY thing that answered that question was `beeper.use`: boot's connectionOf
// returned `cfg.beeper?.use ?? null`, and a null fell through to the legacy top-level
// `beeper_token` / BEEPER_ACCESS_TOKEN. So a `beeper:` block that declares connections but names
// none of them with `use:` resolved to NOTHING — on a profile that sets no legacy token (both live
// ones do not) that is a bridge with no token at all: deaf and mute, the "half-alive is worse than
// down" failure INTENT.md names.
//
// THE CONNECTION NAMES NOW CARRY THE MEANING. The precedence, in boot's connectionOf:
//
//   1. the agent's own `beeper_connection`  — unchanged, wins over everything
//   2. an explicit `beeper.use`             — BACK-COMPAT (~/.egpt2 still ships it)
//   3. `secondary`, if declared             — "primary doesn't speak if secondary is present"
//   4. `primary`, if declared
//   5. the ONE connection, if exactly one is declared, whatever it is named
//   6. otherwise null → the legacy beeper_token / env path, unchanged
//
// (5) is the project baseline, not a convenience: INTENT.md requires a fresh clone to work with
// one account and no ceremony, so a single-connection block must need no naming convention and no
// selector key.
//
// WHAT THIS FILE DOES NOT DECIDE — read this before using it as evidence about ingest. Boot builds
// one bridge per connection an AGENT RIDES (`for (const being of Object.keys(agents()))
// await bridgeForEndpoint(endpointFor(connectionOf(being)))`), so the set of connections this node
// LISTENS on is derived from the very resolver above, and a declared connection nobody rides is
// never dialled — locked, deliberately, in tests/multi-connection-wake.test.mjs ("a declared
// connection NO agent rides is never opened"). Changing the default therefore MOVES THE EAR as
// well as the mouth. The cases at the foot of this file record that coupling exactly as it is, so
// the next reader does not have to rediscover it.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// A PRIVATE profile for this file — egpt-home.mjs freezes EGPT_HOME at module load, so it must be
// set BEFORE the imports below; vi.hoisted is what does that. Private (not the suite's shared
// throwaway) because boot writes state/spine.pid and heartbeats.readonly.yaml, and files running
// in parallel would race on them.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-beeper-default-connection-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

let boot, emptyState;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

// ── the live shape, with the tokens replaced ────────────────────────────────────────────────
// ~/.egpt/config/config.yaml as it stands today: three connections, no `use:`. primary and
// primary_gui are the same Beeper ACCOUNT on two different installs, so they carry two different
// tokens; secondary is the other account, the mouth.
const T_PRIMARY = 'TOK-primary';
const T_SECONDARY = 'TOK-secondary';
const T_GUI = 'TOK-primary-gui';
const NAME_OF = { [T_PRIMARY]: 'primary', [T_SECONDARY]: 'secondary', [T_GUI]: 'primary_gui' };

const LIVE_BEEPER = () => ({
  primary: { account: 'an@example.com', token: T_PRIMARY },
  secondary: { account: 'rodz@example.com', token: T_SECONDARY },
  primary_gui: { account: 'an@example.com', token: T_GUI },
});

const AG = () => ({ egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } });

// Complete in-memory fs seam — same shape as tests/single-account-node.test.mjs.
function memIo() {
  const files = new Map();
  const dirs = new Set();
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    files,
    appendFile: async (path, data) => files.set(path, `${files.get(path) ?? ''}${data}`),
    writeFile: async (path, data) => files.set(path, String(data)),
    readFile: async (path) => { if (!files.has(path)) throw missing(path); return files.get(path); },
    mkdir: async (path) => { dirs.add(path); },
    existsSync: (path) => files.has(path) || dirs.has(path),
    readdir: async (path) => [...files.keys()].filter((f) => dirname(f) === path).map((f) => f.slice(path.length + 1)),
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
  };
}

function fakeSession(opts) {
  return { sessionId: opts.sessionId ?? 'sess-1', async turn(m, onUpdate) { onUpdate?.(`↩ ${m}`); return { text: `↩ ${m}`, sessionId: this.sessionId }; }, close() {} };
}

// Nothing answers the port probe — a connection with a token and no base_url still runs discovery
// at boot, and no case here asserts on it. Injected so the sweep never touches the network.
const fakeProbe = async () => ({ ok: false, status: 0 });

// One spy per startBridge CALL, carrying the token it was dialled with (hence which connection),
// the onIncoming the port late-binds, and everything that left through it.
function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { connection: NAME_OF[opts.beeperToken] ?? opts.beeperToken ?? '(none)', token: opts.beeperToken, opts, onIncoming: opts.onIncoming, sent: [], streams: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      async chatHasParticipant() { return null; },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

async function bootWith(config) {
  const { start, built } = fakeTransport();
  const lines = [];
  let convState = emptyState();
  const app = await boot({
    readConfig: () => ({ node_name: 'kg', user_name: 'An', ...config }),
    startBridge: start,
    makeSession: fakeSession,
    probeEndpoint: fakeProbe,
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0,
    log: { line: (s) => lines.push(s) },
  });
  const byConnection = Object.fromEntries(built.map((s) => [s.connection, s]));
  // EVERY reply that left the node, tagged with the connection it went out on.
  const replies = () => built.flatMap((s) => s.streams.map((h) => ({ connection: s.connection, text: h.finals[0] })));
  return { app, built, byConnection, replies, lines };
}

// One arrival, shaped the way the real bridge shapes it. atEStart/atEAnywhere is the BRIDGE's own
// mention finding (this stub never computes it), so it is stated here.
const deliver = (spy, body, chatId = '!room') => spy.onIncoming(body, {
  chatId, chatName: 'room', network: 'whatsapp',
  userId: '+34658515045', senderName: 'Dando', authorized: true, msgKey: `m-${chatId}-${body.length}`,
  atEStart: true, atEAnywhere: true,
});

describe('the DEFAULT outbound connection — the names carry the meaning (operator 2026-09-10)', () => {
  // ── THE REPRODUCTION ──────────────────────────────────────────────────────────────────────
  // This is the operator's LIVE ~/.egpt/config/config.yaml. Before the fix connectionOf returned
  // `cfg.beeper?.use ?? null` → null → the legacy beeper_token/env path, which this profile does
  // not set: `opts.beeperToken` came back UNDEFINED and the node had no outbound at all.
  it('primary + secondary + primary_gui and NO use: → the default is SECONDARY', async () => {
    const { built, app } = await bootWith({ agents: AG(), beeper: LIVE_BEEPER() });
    expect(built).toHaveLength(1);                 // nobody names a beeper_connection ⇒ one bridge
    expect(built[0].token).toBe(T_SECONDARY);
    expect(built[0].connection).toBe('secondary');
    app.stop();
  });

  // …and it is the connection the reply actually LEAVES ON, not merely the one that got dialled.
  it('the persona\'s reply goes out on secondary', async () => {
    const { built, replies, app } = await bootWith({ agents: AG(), beeper: LIVE_BEEPER() });
    await deliver(built[0], '@e hola');
    expect(replies().map((r) => r.connection)).toEqual(['secondary']);
    app.stop();
  });

  // ── BACK-COMPAT: `use:` still wins ────────────────────────────────────────────────────────
  // MANDATORY. ~/.egpt2 (node kg2, the second spine on this machine) still ships
  // `beeper: { use: main, main: {...} }` and gets the same deploy. An explicit operator
  // statement also has to beat an inferred default, or the inference could not be overridden.
  it('an explicit use: wins over secondary', async () => {
    const { built, app } = await bootWith({ agents: AG(), beeper: { use: 'primary', ...LIVE_BEEPER() } });
    expect(built.map((s) => s.connection)).toEqual(['primary']);
    app.stop();
  });

  it('~/.egpt2\'s exact shape — use: main over a single `main` block — is untouched', async () => {
    const { built, app } = await bootWith({
      node_name: 'kg2',
      agents: AG(),
      beeper: { use: 'main', main: { account: 'rodz@example.com', token: T_SECONDARY } },
    });
    expect(built).toHaveLength(1);
    expect(built[0].token).toBe(T_SECONDARY);
    app.stop();
  });

  // ── primary ALONE ─────────────────────────────────────────────────────────────────────────
  // "primary doesn't speak if secondary is present" — so with no secondary present, it speaks.
  it('primary with NO secondary declared → the default is primary', async () => {
    const b = LIVE_BEEPER();
    delete b.secondary;
    const { built, app } = await bootWith({ agents: AG(), beeper: b });
    expect(built.map((s) => s.connection)).toEqual(['primary']);
    app.stop();
  });

  // ── ONE CONNECTION, ANY NAME ──────────────────────────────────────────────────────────────
  // The INTENT.md baseline: a fresh clone, one Beeper account, no ceremony. A lone connection is
  // unambiguous, so it needs neither a `use:` selector nor a blessed name.
  it('a single oddly-named connection needs no use: and no naming convention', async () => {
    const { built, app } = await bootWith({ agents: AG(), beeper: { whatever_i_called_it: { account: 'a@b', token: 'TOK-odd' } } });
    expect(built).toHaveLength(1);
    expect(built[0].token).toBe('TOK-odd');
    app.stop();
  });

  // ── THE AGENT'S OWN PIN STILL BEATS EVERYTHING ────────────────────────────────────────────
  it('an agent\'s beeper_connection overrides the default, and the default still holds for everyone else', async () => {
    const { built, byConnection, replies, app } = await bootWith({
      agents: {
        egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true },
        gui: { configuration: 'egpt', handles: ['gui'], beeper_connection: 'primary_gui', conversation_defaults: { access_level: 'regular' } },
      },
      beeper: LIVE_BEEPER(),
    });
    // TWO bridges: the pinned one and the default one. primary is declared and ridden by nobody.
    expect(built.map((s) => s.connection).sort()).toEqual(['primary_gui', 'secondary']);

    await deliver(byConnection.secondary, '@e hola');
    expect(replies().map((r) => r.connection)).toEqual(['secondary']);
    app.stop();
  });

  // ── BACK-COMPAT: no beeper: block at all ──────────────────────────────────────────────────
  it('no beeper: block → the legacy top-level beeper_token still resolves, and nothing is logged about it', async () => {
    const { built, lines, app } = await bootWith({ agents: AG(), beeper_token: 'TOK-legacy' });
    expect(built).toHaveLength(1);
    expect(built[0].token).toBe('TOK-legacy');
    expect(lines.filter((l) => l.includes('NO connection resolved'))).toEqual([]);
    app.stop();
  });

  // ── NOTHING RESOLVES ⇒ LOUD ───────────────────────────────────────────────────────────────
  // The one shape the precedence CANNOT answer: several connections, none of them named primary
  // or secondary, and no `use:` to break the tie. That is a node with no outbound, and it must
  // never be discovered in a live chat.
  it('several connections, none primary/secondary, no use: → boots, but says so out loud', async () => {
    const { built, lines, app } = await bootWith({
      agents: AG(),
      beeper: { alpha: { account: 'a@b', token: 'TOK-a' }, beta: { account: 'c@d', token: 'TOK-b' } },
    });
    expect(built[0].token).toBeUndefined();        // the legacy path, and this profile sets none
    const loud = lines.filter((l) => l.includes('NO connection resolved'));
    expect(loud).toHaveLength(1);
    expect(loud[0]).toContain("'alpha'");
    expect(loud[0]).toContain("'beta'");
    app.stop();
  });

  it('use: naming a connection that does not exist → boots, but says so out loud', async () => {
    const { lines, app } = await bootWith({ agents: AG(), beeper: { use: 'typo', main: { account: 'a@b', token: 'TOK-main' } } });
    const loud = lines.filter((l) => l.includes('NO connection resolved'));
    expect(loud).toHaveLength(1);
    expect(loud[0]).toContain("'typo'");
    app.stop();
  });

  // ── INGEST: STILL ONE BRIDGE PER CONNECTION AN AGENT RIDES ────────────────────────────────
  // NOT "per DECLARED connection" — that is the thing this file exists to state plainly. The rule
  // is unchanged by the precedence above (it is the same resolver feeding the same loop), but the
  // ANSWER moves with the default, so on the live profile the ear moves from the legacy path to
  // `secondary`, and `primary` — the operator's own account — is not dialled by anything.
  it('a declared connection no agent rides is STILL never opened, default or not', async () => {
    const { built, app } = await bootWith({ agents: AG(), beeper: LIVE_BEEPER() });
    expect(built.map((s) => s.connection)).toEqual(['secondary']);   // not primary, not primary_gui
    app.stop();
  });

  it('every connection an agent DOES ride is opened, and each is a separate ear', async () => {
    const { built, byConnection, replies, app } = await bootWith({
      agents: {
        egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true },
        ear: { configuration: 'egpt', handles: ['ear'], beeper_connection: 'primary', conversation_defaults: { access_level: 'regular' } },
      },
      beeper: LIVE_BEEPER(),
    });
    expect(built.map((s) => s.connection).sort()).toEqual(['primary', 'secondary']);
    // …and an arrival on the NON-default connection reaches the spine (bridge-fanout registers
    // inbound on every bridge), which is what makes a second connection an ear and not just a mouth.
    await deliver(byConnection.primary, '@e hola', '!room-on-primary');
    expect(replies().map((r) => r.connection)).toEqual(['secondary']);
    app.stop();
  });
});
