// fast-intake-bench.test.mjs — incoming → placeholder on a REAL boot against a realistic profile
// (operator 2026-10-18: "'e test' took like 5s between hitting enter in beeper itself and seeing
// the thinking train"). ~120 conversations (~1600-line conversations.yaml), rooms.yaml rows, a
// folder + transcript per conversation, a few being-written heartbeats/. Only the transport, the
// claude session and spawn are faked. Prints per-stage timings (the lag probe's step names; `act` is
// dispatch up to the placeholder) and holds the idle target: placeholder requested < 1 s after the
// bridge's incoming. BENCH_OUT=<file> appends the numbers there.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import * as YAML from 'yaml';

const HOME = join(os.tmpdir(), `egpt-fast-intake-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = HOME;

const N = 120;
const chatId = (i) => `chat-${i}`;
const slugOf = (i) => `Group ${i}`;   // sanitizeSlug keeps case and spaces
const nameOf = (i) => `Group ${i}`;

function conversationsYaml({ conversationPathOf, homeDirMsys }) {   // the paths ensureContact would backfill: a settled registry
  const out = ['contacts:', '  whatsapp:'];
  for (let i = 0; i < N; i++) {
    out.push(
      `    "${chatId(i)}": # ${nameOf(i)}`,
      `      conversation_path: ${conversationPathOf('whatsapp', slugOf(i))}`,
      `      home_dir: ${homeDirMsys()}`,
      '      loop_guard: { inbound: { turns: 6, window: 2 } }',
      '      agents:',
      '        egpt:',
      '          mode: on',
      `          threadId: thread-${i}`,
      '          threadCreatedAt: 2026-07-03T00:00:00.000Z',
      '          identityInjectedAt: 2026-07-03T00:00:00.000Z',
      '          access_level: regular',
      '          allow_new_input: none',
      '          allowed_users:',
      '            - u-1',
      '            - u-2',
    );
  }
  return `${out.join('\n')}\n`;
}

function roomsYaml() {
  const rooms = {};
  for (let i = 0; i < 12; i++) rooms[`whatsapp/${slugOf(i)}`] = { transcription_service: { posts_back: i % 2 === 0 }, heartbeats: { [`check-${i}`]: { frequency: '1h', command: 'echo ok' } } };
  for (let i = 0; i < 4; i++) rooms[`room/room-${i}`] = { agents: { egpt: { access_level: 'regular', threadId: `room-thread-${i}` } } };
  return YAML.stringify({ rooms });
}

const stamps = new Map();   // chatId -> { incoming, placeholder }
const steps = [];           // { name, chatId, start, end }
const probe = {
  time(name, ev, fn) {
    const s = { name, chatId: ev?.chatId ?? null, start: performance.now(), end: 0 };
    steps.push(s);
    const end = () => { s.end = performance.now(); };
    let r;
    try { r = fn(); } catch (e) { end(); throw e; }
    if (typeof r?.then !== 'function') { end(); return r; }
    return Promise.resolve(r).finally(end);
  },
  start() {}, stop() {}, slowest: () => [],
};

let app, onIncoming;
function fakeStart() {
  return async (opts) => {
    onIncoming = opts.onIncoming;
    return {
      async send() { return { ok: true }; },
      startStreamMessage(_init, o) {
        const s = stamps.get(o?.chatId);
        if (s && s.placeholder == null) s.placeholder = performance.now();
        return { delivered: false, update() {}, async finish() { this.delivered = true; } };
      },
      listMessagesRaw: async () => [],
      isAlive: () => true, stop() {},
    };
  };
}
const fakeSession = (opts) => ({
  sessionId: opts.sessionId ?? 'fresh',
  async turn(message) { await new Promise((r) => setTimeout(r, 20)); return { text: `ok ${String(message).slice(-12)}`, sessionId: this.sessionId }; },
  close() {},
});
const fakeSpawn = () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; }, unref() {} });

let seq = 0;
function send(i, body) {
  const at = performance.now();
  stamps.set(chatId(i), { incoming: at, placeholder: null });
  return onIncoming(body, { chatId: chatId(i), chatName: nameOf(i), network: 'whatsapp', userId: 'u-1', senderName: 'An', authorized: true, msgKey: `m${++seq}` });
}
const ms = (x) => Math.round(x);
const report = (text) => { console.log(text); if (process.env.BENCH_OUT) return fs.appendFile(process.env.BENCH_OUT, `${text}\n`, 'utf8'); };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

beforeAll(async () => {
  await fs.mkdir(join(HOME, 'config', 'agents', 'identities'), { recursive: true });
  await fs.mkdir(join(HOME, 'state', 'ingest'), { recursive: true });
  await fs.writeFile(join(HOME, 'config', 'config.yaml'), YAML.stringify({
    beeper_token: 'fixture-token-unused',
    node_name: 'kg',
    whatsapp: { chat_id: 'self@fixture', allowed_users: ['u-1'], auto_e_default: 'mute' },
    agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, conversation_defaults: { access_level: 'regular' } } },
    loop_guard: { outbound: { messages: 500 } },   // the burst opens 30 placeholders in seconds — above the node's 18/10s ceiling by design
    heartbeats: { nightly: { daily: '03:00', command: 'echo nightly' }, hourly: { frequency: '1h', command: 'echo hourly' } },
  }), 'utf8');
  await fs.writeFile(join(HOME, 'config', 'agents', 'egpt.yaml'), 'type: ccode\nmodel: sonnet\neffort: high\n', 'utf8');
  await fs.writeFile(join(HOME, 'config', 'agents', 'identities', 'egpt.md'), '# I am eGPT\n', 'utf8');
  await fs.writeFile(join(HOME, 'config', 'conversations.yaml'), conversationsYaml(await import('../src/conversations-state.mjs')), 'utf8');
  await fs.writeFile(join(HOME, 'config', 'rooms.yaml'), roomsYaml(), 'utf8');
  const lines = Array.from({ length: 60 }, (_, k) => `An@[x].wa (10:${String(k % 60).padStart(2, '0')}) #${k}: line ${k}\n`).join('\n');
  for (let i = 0; i < N; i++) {
    const dir = join(HOME, 'conversations', 'whatsapp', slugOf(i));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'transcript.md'), `---\nname: ${nameOf(i)}\n---\n\n${lines}`, 'utf8');
    if (i % 10 === 0) {
      await fs.mkdir(join(dir, 'heartbeats'), { recursive: true });
      await fs.writeFile(join(dir, 'heartbeats', 'own.yaml'), 'frequency: 6h\ncommand: echo own\n', 'utf8');
    }
  }
  const { boot } = await import('../src/spine/boot.mjs');
  app = await boot({
    startBridge: fakeStart(), makeSession: fakeSession, spawn: fakeSpawn, reapPort: () => 0,
    ingest: false, exit: () => {}, tickMs: 0, lagProbe: probe, log: { line: () => {} },
  });
}, 120_000);

afterAll(async () => {
  try { app?.stop(); } catch {}
  delete process.env.EGPT_HOME;
  try { await fs.rm(HOME, { recursive: true, force: true }); } catch {}
});

function stagesOf(id) {
  const { incoming, placeholder } = stamps.get(id);
  const by = {};
  for (const s of steps) {
    if (s.start < incoming || s.start > placeholder) continue;
    if (s.chatId != null && s.chatId !== id) continue;
    by[s.name] = (by[s.name] ?? 0) + (s.end - s.start);
  }
  return { total: placeholder - incoming, by };
}

describe('fast intake — incoming → placeholder on a realistic profile', () => {
  it('idle: one message at a time, every stage timed', async () => {
    await send(0, 'e warm up');                      // first sight of the process: not measured
    const rows = [];
    for (let i = 1; i <= 6; i++) {
      steps.length = 0;
      await send(i, `e test ${i}`);
      rows.push(stagesOf(chatId(i)));
    }
    const names = ['config', 'refresh', 'classify', 'transcript', 'act'];
    const line = (r) => `${String(ms(r.total)).padStart(5)}ms  ${names.map((n) => `${n} ${ms(r.by[n] ?? 0)}`).join(' · ')}`;
    await report(`[bench] idle incoming→placeholder (median ${ms(median(rows.map((r) => r.total)))}ms):\n${rows.map(line).join('\n')}`);
    expect(median(rows.map((r) => r.total))).toBeLessThan(1000);
  }, 120_000);

  it('burst: 30 chats at once — each chat\'s placeholder latency', async () => {
    const ids = Array.from({ length: 30 }, (_, k) => 40 + k);
    const done = ids.map((i) => send(i, `e burst ${i}`));
    await Promise.all(done);
    const lat = ids.map((i) => { const s = stamps.get(chatId(i)); return s.placeholder - s.incoming; });
    await report(`[bench] burst of 30 chats: placeholder median ${ms(median(lat))}ms, max ${ms(Math.max(...lat))}ms`);
    expect(ids.filter((i) => stamps.get(chatId(i)).placeholder == null)).toEqual([]);
    expect(Math.max(...lat)).toBeLessThan(5000);
  }, 120_000);

  it('an operator edit of conversations.yaml is picked up by the next message', async () => {
    const path = join(HOME, 'config', 'conversations.yaml');
    await fs.writeFile(path, (await fs.readFile(path, 'utf8')).replace(/("chat-7":[\s\S]*?mode: )on/, '$1off'), 'utf8');
    await send(7, 'e are you there');
    expect(stamps.get(chatId(7)).placeholder).toBe(null);     // off: not received
    await send(8, 'e and here');
    expect(stamps.get(chatId(8)).placeholder).not.toBe(null);
  }, 120_000);
});
