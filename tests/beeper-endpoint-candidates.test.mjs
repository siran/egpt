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
// The load-bearing constraint locked here is that this is STRICTLY ADDITIVE: a connection with
// a plain base_url/token and NO `endpoints:` makes ZERO probe calls at boot.
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
function fakeProbe(answers) {
  const calls = [];
  const probe = async (baseUrl, token, opts) => {
    calls.push({ baseUrl, token, timeoutMs: opts?.timeoutMs });
    return answers[`${baseUrl}|${token}`] ?? { ok: false, status: 0, error: 'nothing there' };
  };
  return { probe, calls };
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
