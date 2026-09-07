// CANDIDATE ENDPOINTS for one Beeper connection (operator 2026-09-03).
//
// The Session 0 Desktop FLIPS IDENTITY at logon: before the operator logs in it runs HIS
// account; after he logs in it is restarted as a different one while his GUI in Session 1
// carries his. So the connection named `main` must address a DIFFERENT INSTALL depending on
// that state — and not merely a different PORT: a Beeper token is minted by, and belongs to,
// ONE install, so each state needs its own (base_url, token) PAIR. Rewriting the operator's
// hand-commented config.yaml and bouncing the spine at every logon and logoff is not an option.
//
// So a connection may list its candidates and the spine OBSERVES which one is alive at boot,
// through the SAME probe the whoami tool uses (GET /v1/accounts with that candidate's own
// token). 200 = this is the install. 401 = a POSITIVE result: a different install is serving
// that port. Anything else = nothing there.
//
// The load-bearing constraint locked here is that this is STRICTLY ADDITIVE: a connection that
// PINS `base_url` makes ZERO probe calls at boot.
//
// SUPERSEDED 2026-09-07 by the second describe at the foot of this file: a connection needs no
// port at all now, because the token identifies the install and the port is discovered. The
// `endpoints:` shape below is deprecated and still read — both live profiles carry it — and its
// cases stay exactly as they were until those two files are migrated.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Private profile, frozen before the imports (egpt-home.mjs reads EGPT_HOME once at load).
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-beeper-endpoint-candidates-home`;
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

// The injected probe: a scripted (base_url|token) → answer table, plus the call log that proves
// what was asked and — for the plain shape — that nothing was asked at all.
// `answers` is read at CALL time, not captured — a test mutates it to model an install that
// moved between the boot sweep and a later re-discovery.
function fakeProbe(answers) {
  const calls = [];
  const stats = { maxInFlight: 0 };
  let inFlight = 0;
  const probe = async (baseUrl, token, opts) => {
    calls.push({ baseUrl, token, timeoutMs: opts?.timeoutMs });
    inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    // One microtask, so the counter can tell the two shapes apart: a CONCURRENT sweep has all
    // its calls in flight at once, a serial loop never has more than one.
    await Promise.resolve();
    inFlight -= 1;
    return answers[`${baseUrl}|${token}`] ?? { ok: false, status: 0, error: 'nothing there' };
  };
  return { probe, calls, stats };
}

const AG = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } };

async function bootWith(config, { probe } = {}) {
  const optsList = [];
  const lines = [];
  const start = async (o) => {
    optsList.push(o);
    return { async send() { return { ok: true }; }, startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; }, isAlive: () => true, stop() {} };
  };
  const app = await boot({
    readConfig: () => ({ node_name: 'kg', ...config }),
    startBridge: start, makeSession: fakeSession,
    loadState: async () => emptyState(), writeState: async () => {},
    io: memIo(), ingest: false, tickMs: 0,
    log: { line: (s) => lines.push(s) },
    ...(probe ? { probeEndpoint: probe } : {}),
  });
  return { opts: optsList[optsList.length - 1], optsList, lines, app };
}

describe('beeper connection endpoints: — candidate resolution by observation', () => {
  // THE most important one. Every node today, and every other test in the suite, uses the plain
  // shape; it must not acquire a network call at boot.
  it('a plain base_url/token connection (no endpoints:) resolves with ZERO probe calls', async () => {
    const { probe, calls } = fakeProbe({});
    const { opts, app } = await bootWith(
      { agents: AG, beeper: { use: 'main', main: { account: 'a@b', token: 'T', base_url: 'http://127.0.0.1:23374' } } },
      { probe },
    );
    expect(calls).toEqual([]);
    expect(opts.beeperToken).toBe('T');
    expect(opts.baseUrl).toBe('http://127.0.0.1:23374');
    expect(opts.wsUrl).toBe('ws://127.0.0.1:23374/v1/ws');
    app.stop();
  });

  it('no beeper block at all: still ZERO probe calls, and the top-level token still resolves', async () => {
    const { probe, calls } = fakeProbe({});
    const { opts, app } = await bootWith({ agents: AG, beeper_token: 'LEGACY' }, { probe });
    expect(calls).toEqual([]);
    expect(opts.beeperToken).toBe('LEGACY');
    expect('baseUrl' in opts).toBe(false);
    app.stop();
  });

  it('the FIRST candidate answering 200 wins, and the second is never probed', async () => {
    const { probe, calls } = fakeProbe({ 'http://127.0.0.1:23373|S0': { ok: true, status: 200, loginID: '@an' } });
    const { optsList, opts, lines, app } = await bootWith({
      agents: AG,
      beeper: {
        use: 'main',
        main: {
          account: 'a@b',
          endpoints: [
            { base_url: 'http://127.0.0.1:23373', token: 'S0' },
            { base_url: 'http://127.0.0.1:23374', token: 'S1' },
          ],
        },
      },
    }, { probe });
    expect(calls.map((c) => c.baseUrl)).toEqual(['http://127.0.0.1:23373']);
    expect(optsList).toHaveLength(1);
    expect(opts.beeperToken).toBe('S0');
    expect(opts.baseUrl).toBe('http://127.0.0.1:23373');
    expect(lines).toContain("[bridge] connection 'main' → http://127.0.0.1:23373 — 200, this install answers to this candidate's token");
    app.stop();
  });

  // THE LIVE FLIP. The operator has logged in, so :23373 now serves the OTHER account and 401s
  // the `main` token; his GUI on :23374 is the one that answers.
  it('first candidate 401 → the SECOND candidate wins, and the 401 is logged as proof', async () => {
    const { probe, calls } = fakeProbe({
      'http://127.0.0.1:23373|S0': { ok: false, status: 401 },
      'http://127.0.0.1:23374|S1': { ok: true, status: 200, loginID: '@an' },
    });
    const { opts, lines, app } = await bootWith({
      agents: AG,
      beeper: {
        use: 'main',
        main: {
          account: 'a@b',
          endpoints: [
            { base_url: 'http://127.0.0.1:23373', token: 'S0' },
            { base_url: 'http://127.0.0.1:23374', token: 'S1' },
          ],
        },
      },
    }, { probe });
    expect(calls.map((c) => `${c.baseUrl}|${c.token}`)).toEqual(['http://127.0.0.1:23373|S0', 'http://127.0.0.1:23374|S1']);
    expect(opts.beeperToken).toBe('S1');
    expect(opts.baseUrl).toBe('http://127.0.0.1:23374');
    expect(lines).toContain("[bridge] connection 'main': http://127.0.0.1:23373 answered 401 — a DIFFERENT install is serving that port, trying the next candidate");
    app.stop();
  });

  // Booting endpoint-less would take the node down because Beeper was merely slow to start.
  it('NO candidate answers → the FIRST is used and the loud line fires', async () => {
    const { probe, calls } = fakeProbe({});
    const { opts, lines, app } = await bootWith({
      agents: AG,
      beeper: {
        use: 'main',
        main: {
          account: 'a@b',
          endpoints: [
            { base_url: 'http://127.0.0.1:23373', token: 'S0' },
            { base_url: 'http://127.0.0.1:23374', token: 'S1' },
          ],
        },
      },
    }, { probe });
    expect(calls).toHaveLength(2);
    expect(opts.beeperToken).toBe('S0');
    expect(opts.baseUrl).toBe('http://127.0.0.1:23373');
    expect(lines).toContain("[bridge] no live endpoint for connection 'main' — falling back to http://127.0.0.1:23373");
    app.stop();
  });

  // BOUNDED: a black-holed port must not hang boot.
  it('every candidate is probed with a 2s timeout', async () => {
    const { probe, calls } = fakeProbe({});
    const { app } = await bootWith({
      agents: AG,
      beeper: { use: 'main', main: { endpoints: [{ base_url: 'http://127.0.0.1:23373', token: 'S0' }, { base_url: 'http://127.0.0.1:23374', token: 'S1' }] } },
    }, { probe });
    expect(calls.map((c) => c.timeoutMs)).toEqual([2000, 2000]);
    app.stop();
  });

  it('ws_url derives from the WINNING candidate, not the first', async () => {
    const { probe } = fakeProbe({ 'http://127.0.0.1:23374|S1': { ok: true, status: 200 } });
    const { opts, app } = await bootWith({
      agents: AG,
      beeper: {
        use: 'main',
        main: {
          endpoints: [
            { base_url: 'http://127.0.0.1:23373', token: 'S0' },
            { base_url: 'http://127.0.0.1:23374', token: 'S1' },
          ],
        },
      },
    }, { probe });
    expect(opts.wsUrl).toBe('ws://127.0.0.1:23374/v1/ws');
    app.stop();
  });

  it('a candidate carrying its OWN ws_url keeps it', async () => {
    const { probe } = fakeProbe({ 'http://127.0.0.1:23374|S1': { ok: true, status: 200 } });
    const { opts, app } = await bootWith({
      agents: AG,
      beeper: {
        use: 'main',
        main: {
          endpoints: [
            { base_url: 'http://127.0.0.1:23373', token: 'S0' },
            { base_url: 'http://127.0.0.1:23374', token: 'S1', ws_url: 'ws://127.0.0.1:9999/custom' },
          ],
        },
      },
    }, { probe });
    expect(opts.wsUrl).toBe('ws://127.0.0.1:9999/custom');
    app.stop();
  });

  // owner_node is NOT per-candidate: a connection has ONE owner regardless of which install
  // answers. It must survive resolution into wakesOn — which is exactly what this log proves.
  it("owner_node stays on the CONNECTION and survives resolution (the connection is still another node's)", async () => {
    const { probe } = fakeProbe({ 'http://127.0.0.1:23374|S1': { ok: true, status: 200 } });
    const { opts, lines, app } = await bootWith({
      agents: AG,
      beeper: {
        use: 'main',
        main: {
          account: 'a@b',
          owner_node: 'do',
          endpoints: [
            { base_url: 'http://127.0.0.1:23373', token: 'S0' },
            { base_url: 'http://127.0.0.1:23374', token: 'S1' },
          ],
        },
      },
    }, { probe });
    expect(opts.baseUrl).toBe('http://127.0.0.1:23374');
    expect(lines).toContain("[bridge] connection is owned by node 'do' — this node sends on it, never wakes on it");
    app.stop();
  });

  // The bridge identity must be computed on the RESOLVED endpoint. Two connections whose FIRST
  // candidates differ but whose WINNERS are the same install are ONE bridge, not two.
  it('two connections resolving to the SAME winning (base_url, token) collapse to ONE bridge', async () => {
    const { probe } = fakeProbe({
      'http://127.0.0.1:23373|S0': { ok: false, status: 401 },
      'http://127.0.0.1:23374|S1': { ok: true, status: 200 },
    });
    const { optsList, app } = await bootWith({
      agents: {
        egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true },
        rodz: { configuration: 'egpt', handles: ['rodz'], beeper_connection: 'rodz' },
      },
      beeper: {
        use: 'main',
        main: { endpoints: [{ base_url: 'http://127.0.0.1:23373', token: 'S0' }, { base_url: 'http://127.0.0.1:23374', token: 'S1' }] },
        rodz: { endpoints: [{ base_url: 'http://127.0.0.1:23374', token: 'S1' }] },
      },
    }, { probe });
    expect(optsList).toHaveLength(1);
    expect(optsList[0].baseUrl).toBe('http://127.0.0.1:23374');
    expect(optsList[0].beeperToken).toBe('S1');
    app.stop();
  });

  // Mixed node: only the connection that DECLARES endpoints is probed. The plain one beside it
  // is untouched, which is what makes this additive on a node that adopts it for one connection.
  it('a plain connection beside a candidate connection is never probed', async () => {
    const { probe, calls } = fakeProbe({ 'http://127.0.0.1:23374|S1': { ok: true, status: 200 } });
    const { optsList, app } = await bootWith({
      agents: {
        egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true },
        rodz: { configuration: 'egpt', handles: ['rodz'], beeper_connection: 'rodz' },
      },
      beeper: {
        use: 'main',
        main: { endpoints: [{ base_url: 'http://127.0.0.1:23373', token: 'S0' }, { base_url: 'http://127.0.0.1:23374', token: 'S1' }] },
        rodz: { account: 'c@d', token: 'PLAIN', base_url: 'http://127.0.0.1:23380' },
      },
    }, { probe });
    expect(calls.map((c) => c.token)).toEqual(['S0', 'S1']);
    expect(optsList.map((o) => o.beeperToken).sort()).toEqual(['PLAIN', 'S1']);
    app.stop();
  });
});

// ── THE PORT IS NOT AN IDENTITY (operator 2026-09-07) ────────────────────────────────────────
//
// Beeper Desktop's local API binds the FIRST FREE PORT starting at 23373, so which install holds
// which port follows START ORDER, not identity. With several installs on one machine the mapping
// RESHUFFLES whenever they restart in a different order — measured three times in one evening,
// 23373 moving from one install to another inside the hour. On 2026-09-06 a pinned base_url
// therefore named the wrong install, every request 401'd, the bridge redialled every 60s, and the
// node was DEAF FOR ~90 MINUTES with nothing in the log naming the cause.
//
// The fix is not a longer candidate list — that is the same guess, four times. It is that A TOKEN
// BELONGS TO AN INSTALL, NOT TO AN ACCOUNT: only the install a token was minted on answers 200,
// every other install answers 401. So the token IS the address, the port is a lookup, and a
// connection is complete with nothing but `account` + `token`. The 401s do the work.
describe('beeper connection port DISCOVERY — account + token, and no port anywhere', () => {
  const at = (port) => `http://127.0.0.1:${port}`;
  const RANGE = [...Array(10)].map((_, i) => at(23373 + i));
  const CONN = (extra = {}) => ({ agents: AG, beeper: { use: 'main', main: { account: 'a@b', token: 'T', ...extra } } });

  it('REPRODUCE-FIRST: a connection carrying ONLY account+token finds the install that answers 200 — on 23378, not the default', async () => {
    const { probe, calls } = fakeProbe({ [`${at(23378)}|T`]: { ok: true, status: 200, loginID: '@an' } });
    const { opts, lines, app } = await bootWith(CONN(), { probe });
    expect(calls.map((c) => c.baseUrl)).toEqual(RANGE);
    expect(calls.every((c) => c.token === 'T')).toBe(true);
    expect(opts.baseUrl).toBe(at(23378));
    expect(opts.wsUrl).toBe('ws://127.0.0.1:23378/v1/ws');   // …and the socket follows the same answer
    expect(lines).toContain(`[bridge] connection 'main' → ${at(23378)} — 200, this install answers to this connection's token`);
    app.stop();
  });

  // BOOT MUST NOT STALL. Ten loopback calls at once cost ONE timeout, not ten.
  it('the sweep is CONCURRENT and every port carries the same short timeout', async () => {
    const { probe, calls, stats } = fakeProbe({ [`${at(23374)}|T`]: { ok: true, status: 200 } });
    const { app } = await bootWith(CONN(), { probe });
    expect(calls).toHaveLength(10);
    expect(stats.maxInFlight).toBe(10);
    expect([...new Set(calls.map((c) => c.timeoutMs))]).toEqual([750]);
    app.stop();
  });

  // 23375 and 23377 are the egpt shell/console on this machine (node.exe, HTTP 426), and the
  // unused ports refuse outright. Neither is a fault — they are simply not this token's install.
  it('a non-Beeper listener inside the range is not an error, just not a match', async () => {
    const { probe } = fakeProbe({
      [`${at(23375)}|T`]: { ok: false, status: 426 },
      [`${at(23377)}|T`]: { ok: false, status: 426 },
      [`${at(23378)}|T`]: { ok: true, status: 200 },
    });
    const { opts, lines, app } = await bootWith(CONN(), { probe });
    expect(opts.baseUrl).toBe(at(23378));
    expect(lines.filter((l) => /426|refused|error|fail/i.test(l))).toEqual([]);
    app.stop();
  });

  it('a probe that THROWS is just another port that did not answer', async () => {
    const { probe: inner } = fakeProbe({ [`${at(23376)}|T`]: { ok: true, status: 200 } });
    const probe = async (baseUrl, token, o) => {
      if (baseUrl === at(23373)) throw new Error('socket hang up');
      return inner(baseUrl, token, o);
    };
    const { opts, app } = await bootWith(CONN(), { probe });
    expect(opts.baseUrl).toBe(at(23376));
    app.stop();
  });

  // Refusing to boot would take the node down because Beeper was merely slow to start. It falls
  // back to the bridge's own default and says, in one line, what an operator at 2am needs.
  it('NOTHING answers anywhere: it says so and boots on the bridge default, never hanging', async () => {
    const { probe, calls } = fakeProbe({});
    const { opts, lines, app } = await bootWith(CONN(), { probe });
    expect(calls).toHaveLength(10);
    expect('baseUrl' in opts).toBe(false);           // absent, so startBeeperBridge's own default stands
    expect(lines.some((l) => l.includes("connection 'main': NO install on 127.0.0.1:23373-23382 answers this connection's token"))).toBe(true);
    app.stop();
  });

  it('never logs a token VALUE — length only', async () => {
    const SECRET = 'bdapi_never-print-this';
    const { probe } = fakeProbe({});
    const { lines, app } = await bootWith({ agents: AG, beeper: { use: 'main', main: { account: 'a@b', token: SECRET } } }, { probe });
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.some((l) => l.includes(`(${SECRET.length} chars)`))).toBe(true);
    app.stop();
  });

  // Cannot happen while a token belongs to exactly one install — so if it does, the assumption
  // the whole mechanism rests on is wrong and the operator must SEE that, not catch an exception.
  it('MORE THAN ONE port answering 200: takes the lowest and says out loud that it happened', async () => {
    const { probe } = fakeProbe({
      [`${at(23374)}|T`]: { ok: true, status: 200 },
      [`${at(23379)}|T`]: { ok: true, status: 200 },
    });
    const { opts, lines, app } = await bootWith(CONN(), { probe });
    expect(opts.baseUrl).toBe(at(23374));
    expect(lines.some((l) => l.includes('2 installs answered 200 to the SAME token'))).toBe(true);
    app.stop();
  });

  // THE REGRESSION LOCK. A node that pins base_url — a Desktop on a non-default host or port —
  // must behave exactly as it did before discovery existed: no probe, and no re-discovery on
  // reconnect either, since the operator named the address on purpose.
  it('an explicit base_url bypasses discovery entirely: zero probes, and NO rediscover reaches the bridge', async () => {
    const { probe, calls } = fakeProbe({ [`${at(23374)}|T`]: { ok: true, status: 200 } });
    const { opts, app } = await bootWith(CONN({ base_url: at(23380) }), { probe });
    expect(calls).toEqual([]);
    expect(opts.baseUrl).toBe(at(23380));
    expect(opts.wsUrl).toBe('ws://127.0.0.1:23380/v1/ws');
    expect('rediscover' in opts).toBe(false);
    app.stop();
  });

  // RECONNECT IS WHERE THIS EARNS ITS KEEP: the install can move while the node is running, and
  // the moment it moves is the moment the socket drops. boot hands the bridge the SAME lookup, so
  // the existing redial asks again before it dials. The socket-level half of this — the WS 'close'
  // handler actually calling it and following the answer — is in tests/beeper-bridge.test.mjs.
  it('hands the bridge a rediscover that ASKS AGAIN, so a moved install is found on the next redial', async () => {
    const answers = { [`${at(23378)}|T`]: { ok: true, status: 200 } };
    const { probe, calls } = fakeProbe(answers);
    const { opts, app } = await bootWith(CONN(), { probe });
    expect(opts.baseUrl).toBe(at(23378));
    expect(typeof opts.rediscover).toBe('function');

    // The Desktop restarts and comes back lower in the range.
    delete answers[`${at(23378)}|T`];
    answers[`${at(23374)}|T`] = { ok: true, status: 200 };
    const before = calls.length;
    await expect(opts.rediscover()).resolves.toEqual({ baseUrl: at(23374), wsUrl: 'ws://127.0.0.1:23374/v1/ws' });
    expect(calls.length - before).toBe(10);   // it re-probed; it did not replay the boot answer
    app.stop();
  });

  it('rediscover answers null when nothing answers, so the redial keeps the address it has', async () => {
    const answers = { [`${at(23378)}|T`]: { ok: true, status: 200 } };
    const { probe } = fakeProbe(answers);
    const { opts, app } = await bootWith(CONN(), { probe });
    delete answers[`${at(23378)}|T`];
    await expect(opts.rediscover()).resolves.toBeNull();
    app.stop();
  });

  // The deprecated shape still resolves exactly as it did — both live profiles carry it today —
  // but boot names it, because the whole list repeats one token and collapses to account+token.
  it('a connection still declaring endpoints: resolves as before, and is told to collapse', async () => {
    const { probe } = fakeProbe({ [`${at(23374)}|S1`]: { ok: true, status: 200 } });
    const { opts, lines, app } = await bootWith({
      agents: AG,
      beeper: { use: 'main', main: { account: 'a@b', endpoints: [{ base_url: at(23373), token: 'S0' }, { base_url: at(23374), token: 'S1' }] } },
    }, { probe });
    expect(opts.baseUrl).toBe(at(23374));
    expect(lines.some((l) => l.includes("connection 'main' declares endpoints: — DEPRECATED"))).toBe(true);
    app.stop();
  });
});
