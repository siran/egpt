// limbs.beeper.<account>.networks → that account's bridge `networks` option (src/bridges/beeper.mjs).
// The bridge already drops a message whose accountID starts with none of them; this locks that boot
// hands the value over, through the port (startBridge is the port's `start` seam), per account.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-beeper-networks-config-home`;
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

const fakeSession = (opts) => ({ sessionId: opts.sessionId ?? 'sess-1', async turn(m) { return { text: `↩ ${m}`, sessionId: this.sessionId }; }, close() {} });
const AG = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'] } };

async function bootWith(beeper) {
  const byToken = new Map();
  const lines = [];
  const start = async (o) => {
    byToken.set(o.beeperToken, o);
    return { async send() { return { ok: true }; }, startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; }, isAlive: () => true, stop() {} };
  };
  const app = await boot({
    readConfig: () => ({ node_name: 'kg', agents: AG, limbs: { beeper } }),
    startBridge: start, makeSession: fakeSession, probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => emptyState(), writeState: async () => {},
    io: memIo(), ingest: false, tickMs: 0,
    log: { line: (s) => lines.push(s) },
  });
  return { byToken, lines, app };
}

const BASE = (port) => `http://127.0.0.1:${port}`;

describe('limbs.beeper.<account>.networks reaches that account\'s bridge', () => {
  it('each account gets its own list; an account without one gets no networks option (every network)', async () => {
    const { byToken, lines, app } = await bootWith({
      primary: { account: 'an@example.com', token: 'T-P', base_url: BASE(23391), networks: ['whatsapp'] },
      secondary: { account: 'rodz@example.com', token: 'T-S', base_url: BASE(23392) },
    });
    try {
      expect(byToken.get('T-P')?.networks).toEqual(['whatsapp']);
      expect(byToken.has('T-S')).toBe(true);
      expect(byToken.get('T-S')).not.toHaveProperty('networks');
      expect(lines.some((l) => /'primary'.*whatsapp/.test(l))).toBe(true);
    } finally { app.stop(); }
  });

  it('absent everywhere → no bridge is handed a networks option', async () => {
    const { byToken, app } = await bootWith({ main: { account: 'an@example.com', token: 'T-M', base_url: BASE(23393) } });
    try {
      expect(byToken.get('T-M')).toBeDefined();
      expect(byToken.get('T-M')).not.toHaveProperty('networks');
    } finally { app.stop(); }
  });

  it('a single network may be written as a bare string', async () => {
    const { byToken, app } = await bootWith({ main: { account: 'an@example.com', token: 'T-M', base_url: BASE(23394), networks: 'whatsapp' } });
    try { expect(byToken.get('T-M')?.networks).toEqual(['whatsapp']); } finally { app.stop(); }
  });

  it('survives port discovery (no base_url): the connection keeps its networks', async () => {
    const { byToken, app } = await bootWith({ main: { account: 'an@example.com', token: 'T-D', networks: ['whatsapp', 'signal'] } });
    try { expect(byToken.get('T-D')?.networks).toEqual(['whatsapp', 'signal']); } finally { app.stop(); }
  });
});
