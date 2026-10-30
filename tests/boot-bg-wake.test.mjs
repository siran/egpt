// boot-bg-wake.test.mjs — the background wake, wired end to end through boot (2026-10-15).
//
// The warm session reports a finished background task (onBackgroundDone); boot resolves the warm
// key to the being + conversation it last ran for (brain.convOfKey) and the spine wakes it there.
// Locked here through the real boot so the glue — not only each piece — is proven.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-boot-bg-wake-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

let boot, emptyState, ensureContact;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const CHAT = '!room:beeper.com';
const CONFIG = () => ({
  node_name: 'kg',
  user_name: 'John',
  beeper: { use: 'main', main: { account: 'you@example.com', token: 'TOK' } },
  agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } },
});

function memIo() {
  const files = new Map();
  const dirs = new Set();
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    appendFile: async (path, data) => files.set(path, `${files.get(path) ?? ''}${data}`),
    writeFile: async (path, data) => files.set(path, String(data)),
    readFile: async (path) => { if (!files.has(path)) throw missing(path); return files.get(path); },
    mkdir: async (path) => { dirs.add(path); },
    existsSync: (path) => files.has(path) || dirs.has(path),
    readdir: async (path) => [...files.keys()].filter((f) => dirname(f) === path).map((f) => f.slice(path.length + 1)),
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
  };
}

function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { opts, onIncoming: opts.onIncoming, streams: [] };
    built.push(spy);
    return {
      async send() { return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { init, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); } };
        spy.streams.push(h); return h;
      },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

function seedOn() {
  const ens = ensureContact(emptyState(), 'whatsapp', CHAT, { pushedName: 'fam', slugHint: 'fam' });
  const entry = ens.state.contacts.whatsapp[CHAT];
  entry.agents = { ...(entry.agents ?? {}), egpt: { ...(entry.agents?.egpt ?? {}), mode: 'on' } };
  return ens.state;
}

describe('boot — a background task\'s completion wakes the being where it last ran', () => {
  it('the session\'s onBackgroundDone reaches the chat as a wake turn through the reply path', async () => {
    const { start, built } = fakeTransport();
    const sessions = [];
    let convState = seedOn();
    const app = await boot({
      readConfig: CONFIG,
      startBridge: start,
      makeSession: (opts) => {
        const s = { opts, sessionId: opts.sessionId ?? 'sess-1', async turn(m, onUpdate) { onUpdate?.(`↩ ${m}`); return { text: `↩ ${m}`, sessionId: this.sessionId }; }, close() {} };
        sessions.push(s);
        return s;
      },
      probeEndpoint: async () => ({ ok: false, status: 0 }),
      loadState: async () => convState,
      writeState: async (s) => { convState = s; },
      io: memIo(), ingest: false, tickMs: 0,
      now: () => Date.UTC(2026, 9, 15, 14, 5),
      log: { line: () => {} },
    });
    const spy = built[0];
    await spy.onIncoming('hola E, run the audit in the background', {
      chatId: CHAT, chatName: 'fam', network: 'whatsapp', userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1',
    });
    expect(spy.streams).toHaveLength(1);
    expect(sessions).toHaveLength(1);

    sessions[0].opts.onBackgroundDone?.({ summaries: ['Run the audit — completed'] });
    await vi.waitFor(() => expect(spy.streams[1]?.finals).toHaveLength(1), { timeout: 5000 });

    expect(spy.streams).toHaveLength(2);
    expect(spy.streams[1].chatId).toBe(CHAT);
    expect(spy.streams[1].finals[0]).toContain('A background task you started has finished: Run the audit — completed');
    app.stop();
  });

  // Liveness (operator 2026-10-15): the turn that left background work running opens ONE status
  // message in the chat (spine allBackground → boot liveBackground → the session's task list); the
  // wake answers in its own fresh placeholder at the bottom of the chat and leaves the status to the
  // tick (operator 2026-10-30: one status per chat, kept across wakes).
  it('the dispatching turn leaves ONE status message; the wake posts its own placeholder and does not end it', async () => {
    const { start, built } = fakeTransport();
    const sessions = [];
    let convState = seedOn();
    const app = await boot({
      readConfig: CONFIG,
      startBridge: start,
      makeSession: (opts) => {
        const s = {
          opts, sessionId: opts.sessionId ?? 'sess-1', backgroundTasks: [],
          async turn(m) { if (/in the background/.test(m)) this.backgroundTasks = [{ description: 'Run the audit', since: Date.now() }]; return { text: `↩ ${m}`, sessionId: this.sessionId }; },
          close() {},
        };
        sessions.push(s);
        return s;
      },
      probeEndpoint: async () => ({ ok: false, status: 0 }),
      loadState: async () => convState,
      writeState: async (s) => { convState = s; },
      io: memIo(), ingest: false, tickMs: 0,
      now: () => Date.UTC(2026, 9, 15, 14, 5),
      log: { line: () => {} },
    });
    const spy = built[0];
    await spy.onIncoming('hola E, run the audit in the background', {
      chatId: CHAT, chatName: 'fam', network: 'whatsapp', userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1',
    });
    expect(spy.streams).toHaveLength(2);
    expect(spy.streams[1].chatId).toBe(CHAT);
    expect(spy.streams[1].init).toContain('⚙️ working in background: ⏳\n• Run the audit');

    sessions[0].backgroundTasks = [];
    sessions[0].opts.onBackgroundDone?.({ summaries: ['Run the audit — completed'] });
    await vi.waitFor(() => expect(spy.streams[2]?.finals).toHaveLength(1), { timeout: 5000 });
    expect(spy.streams).toHaveLength(3);
    expect(spy.streams[1].finals).toEqual([]);
    expect(spy.streams[2].chatId).toBe(CHAT);
    expect(spy.streams[2].finals[0]).toContain('A background task you started has finished: Run the audit — completed');
    app.stop();
  });
});
