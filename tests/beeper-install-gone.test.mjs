// A Beeper install that stays gone is said to log_to_group, once, and once more when it is back
// (operator 2026-10-21: "errors must bubble up" — a service that can no longer log on after a
// password change must not be discovered as silence). boot.mjs noteInstall, fed by discovery.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-beeper-install-gone-home`;
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

const ROOM = '!egpt-log-room';
const at = (port) => `http://127.0.0.1:${port}`;
const flush = () => new Promise((r) => setTimeout(r, 0));

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

async function bootGone() {
  const answers = { [`${at(23378)}|T`]: { ok: true, status: 200 } };
  const probe = async (baseUrl, token) => answers[`${baseUrl}|${token}`] ?? { ok: false, status: 0, error: 'nothing there' };
  const sent = [];
  let opts = null;
  let clock = 0;
  const start = async (o) => {
    opts = o;
    return {
      async send(text, so) { sent.push({ text, chatId: so?.chatId }); return { ok: true }; },
      async sendAndGetId(text, so) { sent.push({ text, chatId: so?.chatId }); return 'id-1'; },
      startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; },
      async resolveChatId(s) { return String(s); },
      async chatHasParticipant() { return null; },
      async chatRaw() { return null; },
      isAlive: () => true, stop() {},
    };
  };
  const app = await boot({
    readConfig: () => ({ node_name: 'kg', log_to_group: ROOM, agents: { egpt: { configuration: 'egpt', handles: ['e'], default: true } }, beeper: { use: 'main', main: { account: 'a@b', token: 'T' } } }),
    startBridge: start, makeSession: (o) => ({ sessionId: 's', async turn(m) { return { text: m, sessionId: 's' }; }, close() {} }),
    loadState: async () => emptyState(), writeState: async () => {},
    io: memIo(), ingest: false, tickMs: 0, now: () => clock,
    log: { line: () => {} }, probeEndpoint: probe,
  });
  const lines = () => sent.filter((s) => s.chatId === ROOM).map((s) => s.text);
  const rediscover = async (minute) => { clock = minute * 60_000; await opts.rediscover(); for (let i = 0; i < 5; i++) await flush(); };
  return { app, answers, lines, rediscover };
}

describe('a Beeper install that stays gone is said, not discovered as silence', () => {
  it('ONE line after 5 minutes on no port, none before, none repeated; one more when it answers again', async () => {
    const t = await bootGone();
    delete t.answers[`${at(23378)}|T`];               // its service stops and cannot start again
    await t.rediscover(0);
    await t.rediscover(4);
    expect(t.lines()).toEqual([]);                     // a handover or an update restart is shorter
    await t.rediscover(5);
    await t.rediscover(7);
    expect(t.lines()).toHaveLength(1);
    expect(t.lines()[0]).toContain("kg · ⚠ Beeper connection 'main' has answered on no port for 5 min — no install answers its token (Beeper not running, a service that can no longer log on, or a revoked token)");
    t.answers[`${at(23374)}|T`] = { ok: true, status: 200 };
    await t.rediscover(9);
    expect(t.lines()).toHaveLength(2);
    expect(t.lines()[1]).toContain(`kg · ✓ Beeper connection 'main' answers again (${at(23374)})`);
    t.app.stop();
  });

  it('a short gap that heals by itself says nothing, and starts the clock afresh next time', async () => {
    const t = await bootGone();
    delete t.answers[`${at(23378)}|T`];
    await t.rediscover(0);
    t.answers[`${at(23378)}|T`] = { ok: true, status: 200 };
    await t.rediscover(2);
    delete t.answers[`${at(23378)}|T`];
    await t.rediscover(6);                             // gone again, but only just
    expect(t.lines()).toEqual([]);
    t.app.stop();
  });
});
