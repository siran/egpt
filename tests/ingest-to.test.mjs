// ingest-to.test.mjs — `/to <chatId>` in the ingest box: the text enters that chat through the
// spine's handleInbound as the owner's line, marked `.ingest`; addressing and the chat's mode
// decide who answers; the answer goes to that chat. Lifecycle lines are unchanged.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const _HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-ingest-to-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { createIngest, toLine } from '../src/spine/ingest.mjs';

let boot, emptyState, ensureContact;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_HOME, { recursive: true, force: true }); } catch {}
});

let envToken;
beforeEach(() => { envToken = process.env.BEEPER_ACCESS_TOKEN; delete process.env.BEEPER_ACCESS_TOKEN; });
afterEach(async () => {
  if (envToken !== undefined) process.env.BEEPER_ACCESS_TOKEN = envToken;
  await fs.rm(join(_HOME, 'secrets'), { recursive: true, force: true });
});

const writeTgToken = async () => {
  await fs.mkdir(join(_HOME, 'secrets'), { recursive: true });
  await fs.writeFile(join(_HOME, 'secrets', 'telegram-main.token'), '123456:FAKE-telegram-token\n');
};

const AGENTS = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'] } };
const BEEPER_ONLY = () => ({ node_name: 'kg', user_name: 'An', limbs: { beeper: { main: { account: 'you@example.com', token: 'TOK-b' } } }, agents: AGENTS });
const TELEGRAM_ONLY = () => ({ node_name: 'EDW', user_name: 'An', limbs: { telegram: { main: { account: 'edw_bot' } } }, networks: { telegram: { allowed_users: [42] } }, agents: AGENTS });

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
function fakeTransport(declared = {}) {
  const built = [];
  const start = async (opts) => {
    const spy = { opts, sent: [], streams: [] };
    built.push(spy);
    return {
      ...declared,
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      async sendReaction() { return true; },
      startStreamMessage(init, o) {
        const h = { init, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); } };
        spy.streams.push(h); return h;
      },
      wasSentByUs: () => false,
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

async function bootWith(config, { state, telegram = false, session = fakeSession } = {}) {
  const beeper = fakeTransport();
  const tg = fakeTransport({ visibleOnly: true });
  const lines = [];
  const exits = [];
  const io = memIo();
  let convState = state ?? emptyState();
  const app = await boot({
    readConfig: () => config,
    startBridge: beeper.start,
    ...(telegram ? { startTelegram: tg.start } : {}),
    makeSession: session,
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io, ingest: false, tickMs: 0,
    exit: (c) => exits.push(c),
    now: () => Date.UTC(2026, 9, 26, 14, 5),
    log: { line: (s) => lines.push(s) },
  });
  const handled = vi.spyOn(app.spine, 'handleInbound');
  return { app, beeper: beeper.built, tg: tg.built, lines, exits, io, handled };
}

const seed = (surface, chatId, name, state = emptyState()) => ensureContact(state, surface, chatId, { pushedName: name, slugHint: name }).state;

// The box's own sweep, against an in-memory dir, handing each file to boot's handler.
async function drop(app, content) {
  const store = new Map([['to.cmd', content]]);
  const io = { readdir: async () => [...store.keys()], readFile: async () => store.get('to.cmd'), unlink: async () => { store.clear(); }, mkdir: async () => {} };
  await createIngest({ dir: '/ingest', io, handle: app.ingestLine }).sweep();
  expect(store.size).toBe(0);
}
// The turn the box handed off (the box itself does not wait for it).
const settled = (handled) => Promise.all(handled.mock.results.map((r) => r.value));

const transcriptOf = (io) => [...io.files].filter(([p]) => /transcript\.md$/.test(p)).map(([, v]) => v).join('\n');

describe('toLine', () => {
  it('first line /to <chatId>, the rest (trimmed, multi-line, CRLF ok) is the text', () => {
    expect(toLine('/to tg:-1004408163350/55\ned, hola\nsegunda línea\n')).toEqual({ chatId: 'tg:-1004408163350/55', text: 'ed, hola\nsegunda línea' });
    expect(toLine('/to !abc:beeper.com\r\ne, hi\r\n')).toEqual({ chatId: '!abc:beeper.com', text: 'e, hi' });
    expect(toLine('/to lobby')).toEqual({ chatId: 'lobby', text: '' });
  });
  it('anything else is not a /to file', () => {
    for (const s of ['/restart', '/to', '/to a b\nhi', '/tox abc\nhi', 'hola', '', null]) expect(toLine(s)).toBe(null);
  });
});

describe('/to <chatId> on a Beeper node', () => {
  const CHAT = '!fam:beeper.com';

  it('a dropped file enters handleInbound once as the owner\'s line; the addressed being answers in that chat', async () => {
    const { app, beeper, handled, io } = await bootWith(BEEPER_ONLY(), { state: seed('whatsapp', CHAT, 'fam') });
    await drop(app, `/to ${CHAT}\ne, resume the thread\nplease`);
    expect(handled).toHaveBeenCalledTimes(1);
    await settled(handled);
    const { body, from } = handled.mock.calls[0][0];
    expect(body).toBe('e, resume the thread\nplease');
    expect(from).toMatchObject({ chatId: CHAT, chatName: 'fam', network: 'whatsapp', senderName: 'An', authorized: true, via: 'ingest', atEStart: true });
    expect(beeper[0].streams.map((s) => s.chatId)).toEqual([CHAT]);
    expect(beeper[0].streams[0].finals[0]).toContain('An@[fam].ingest (');
    expect(transcriptOf(io)).toContain('An@[fam].ingest (');
    expect(transcriptOf(io)).toContain('e, resume the thread');
    app.stop();
  });

  it('gating still decides: an unaddressed line is recorded and wakes nobody', async () => {
    const { app, beeper, handled, io } = await bootWith(BEEPER_ONLY(), { state: seed('whatsapp', CHAT, 'fam') });
    await app.ingestLine(`/to ${CHAT}\nhola a todos`);
    expect(handled).toHaveBeenCalledTimes(1);
    await settled(handled);
    expect(beeper[0].streams).toEqual([]);
    expect(transcriptOf(io)).toContain('An@[fam].ingest (14:05): hola a todos');
    app.stop();
  });

  it('an id with no conversations.yaml entry is logged and ignored — no conversation is created', async () => {
    const { app, beeper, handled, lines } = await bootWith(BEEPER_ONLY(), { state: seed('whatsapp', CHAT, 'fam') });
    await app.ingestLine('/to !nobody:beeper.com\ne, hola');
    expect(handled).not.toHaveBeenCalled();
    expect(beeper[0].streams).toEqual([]);
    expect(lines).toContain('[ingest] /to !nobody:beeper.com ignored: no conversation with that id');
    app.stop();
  });

  it('a /to with no text is logged and ignored', async () => {
    const { app, handled, lines } = await bootWith(BEEPER_ONLY(), { state: seed('whatsapp', CHAT, 'fam') });
    await app.ingestLine(`/to ${CHAT}\n   \n`.trim());
    expect(handled).not.toHaveBeenCalled();
    expect(lines).toContain(`[ingest] /to ${CHAT} ignored: no text`);
    app.stop();
  });

  it('the box does not wait for the turn: a hanging turn leaves the next file free', async () => {
    let release;
    const hanging = (opts) => ({ ...fakeSession(opts), turn: () => new Promise((r) => { release = () => r({ text: 'done', sessionId: 'sess-1' }); }) });
    const { app, handled } = await bootWith(BEEPER_ONLY(), { state: seed('whatsapp', CHAT, 'fam'), session: hanging });
    await app.ingestLine(`/to ${CHAT}\ne, a long job`);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await app.ingestLine(`/to ${CHAT}\ne, and one more`);
    expect(handled).toHaveBeenCalledTimes(2);
    release();
    app.stop();
  });

  it('lifecycle lines are unchanged: /restart still exits 43 and enters no chat', async () => {
    const { app, handled, exits } = await bootWith(BEEPER_ONLY(), { state: seed('whatsapp', CHAT, 'fam') });
    await app.ingestLine('/restart');
    await vi.waitFor(() => expect(exits).toEqual([43]));
    expect(handled).not.toHaveBeenCalled();
    app.stop();
  });
});

describe('/to a Telegram topic', () => {
  const TOPIC = 'tg:-1004408163350/55';

  it('the topic id works: the line comes from the owner\'s Telegram id and the answer goes to that topic', async () => {
    await writeTgToken();
    const { app, tg, handled } = await bootWith(TELEGRAM_ONLY(), { telegram: true, state: seed('telegram', TOPIC, 'EduWeb · Ventas') });
    await drop(app, `/to ${TOPIC}\ne, hola`);
    expect(handled).toHaveBeenCalledTimes(1);
    await settled(handled);
    expect(handled.mock.calls[0][0].from).toMatchObject({ chatId: TOPIC, network: 'telegram', userId: 42, via: 'ingest' });
    expect(tg[0].streams.map((s) => s.chatId)).toEqual([TOPIC]);
    expect(tg[0].streams[0].finals[0]).toContain('An@[EduWeb · Ventas].ingest (');
    app.stop();
  });
});
