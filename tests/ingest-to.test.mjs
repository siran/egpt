// ingest-to.test.mjs — `/to <chatId>` in the ingest box: the text enters that chat through the
// spine's handleInbound as the owner's line, marked `.ingest`; addressing and the chat's mode
// decide who answers; the answer goes to that chat. Lifecycle lines are unchanged. An unanswered question
// expires (ingest.ttl_ms): its post counts the minutes down, is edited as they pass, and says it expired.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const _HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-ingest-to-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { createIngest, createIngestAsks, toLine, answerOf, askTtlMs, minutesLeft, withCountdown, withDeadline, INGEST_ASK, INGEST_EXPIRED, mentionAsk, mentionExpired, ASK_TTL_MS } from '../src/spine/ingest.mjs';
import { stripNodeSignature } from '../src/node-signature.mjs';
import { reactionAction, editAction } from '../src/dispatch-line.mjs';

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
const SILENT = { ingest: { show: false, auto: true } };   // the box before ingest.show / ingest.auto
const BEEPER_ONLY = (ingest = SILENT.ingest) => ({ node_name: 'kg', user_name: 'An', limbs: { beeper: { main: { account: 'you@example.com', token: 'TOK-b' } } }, agents: AGENTS, ...(ingest ? { ingest } : {}) });
const TELEGRAM_ONLY = (ingest = SILENT.ingest) => ({ node_name: 'EDW', user_name: 'An', limbs: { telegram: { main: { account: 'edw_bot' } } }, networks: { telegram: { allowed_users: [42] } }, agents: AGENTS, ...(ingest ? { ingest } : {}) });

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
    copyFile: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); },
  };
}
function fakeSession(opts) {
  return { sessionId: opts.sessionId ?? 'sess-1', async turn(m, onUpdate) { onUpdate?.(`↩ ${m}`); return { text: `↩ ${m}`, sessionId: this.sessionId }; }, close() {} };
}
function fakeTransport(declared = {}) {
  const built = [];
  let n = 0;
  const start = async (opts) => {
    const spy = { opts, sent: [], streams: [], media: [], edits: [] };
    built.push(spy);
    return {
      async editMessage(chatId, id, text) { spy.edits.push({ chatId, id, text }); return true; },
      ...declared,
      async send(text, o) { const id = `m${++n}`; spy.sent.push({ text, chatId: o?.chatId, id }); return { ok: true, confirmedId: id }; },
      async sendMedia(chatId, path, o) { const id = `m${++n}`; spy.media.push({ chatId, path, caption: o?.caption ?? null, id }); return { ok: true, confirmedId: id }; },
      async sendReaction() { return true; },
      startStreamMessage(init, o) {
        const h = { init, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); } };
        spy.streams.push(h); return h;
      },
      wasSentByUs: (chatId, id) => spy.sent.some((m) => m.id === id) || spy.media.some((m) => m.id === id),
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

async function bootWith(config, { state, telegram = false, session = fakeSession, io = memIo(), now = () => Date.UTC(2026, 9, 26, 14, 5), declared = {} } = {}) {
  const beeper = fakeTransport(declared);
  const tg = fakeTransport({ visibleOnly: true });
  const lines = [];
  const exits = [];
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
    now,
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
    expect(toLine('/to tg:-1000000000101/55\ned, hola\nsegunda línea\n')).toEqual({ chatId: 'tg:-1000000000101/55', text: 'ed, hola\nsegunda línea', files: [] });
    expect(toLine('/to !abc:beeper.com\r\ne, hi\r\n')).toEqual({ chatId: '!abc:beeper.com', text: 'e, hi', files: [] });
    expect(toLine('/to lobby')).toEqual({ chatId: 'lobby', text: '', files: [] });
  });
  it('/file <path> lines (any number, anywhere below the head) are attachments, not text', () => {
    expect(toLine('/to !abc:beeper.com\n/file C:\\tmp\\a b.png\ne, mira\n/file /tmp/doc.pdf\n')).toEqual({ chatId: '!abc:beeper.com', text: 'e, mira', files: ['C:\\tmp\\a b.png', '/tmp/doc.pdf'] });
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
  const TOPIC = 'tg:-1000000000101/55';

  it('the topic id works: the line comes from the owner\'s Telegram id and the answer goes to that topic', async () => {
    await writeTgToken();
    const { app, tg, handled } = await bootWith(TELEGRAM_ONLY(), { telegram: true, state: seed('telegram', TOPIC, 'Contoso · Ventas') });
    await drop(app, `/to ${TOPIC}\ne, hola`);
    expect(handled).toHaveBeenCalledTimes(1);
    await settled(handled);
    expect(handled.mock.calls[0][0].from).toMatchObject({ chatId: TOPIC, network: 'telegram', userId: 42, via: 'ingest' });
    expect(tg[0].streams.map((s) => s.chatId)).toEqual([TOPIC]);
    expect(tg[0].streams[0].finals[0]).toContain('An@[Contoso · Ventas].ingest (');
    app.stop();
  });
});

// ── ingest.show / ingest.auto (2026-10-26): the line is shown in the chat, and an owner confirms it ──
const CHAT = '!fam:beeper.com';
const plain = (s) => stripNodeSignature(String(s ?? ''));
const posts = (spy, chatId = CHAT) => spy.sent.filter((s) => s.chatId === chatId).map((s) => ({ ...s, text: plain(s.text) }));
const ingestCalls = (handled) => handled.mock.calls.filter(([m]) => m.from?.via === 'ingest');
const onMode = (state, chatId = CHAT, surface = 'whatsapp') => { state.contacts[surface][chatId].agents = { egpt: { mode: 'on' } }; return state; };
let seq = 0;
// The owner's (or a stranger's) quote-reply, as a limb hands it to the spine.
const replyTo = (app, id, body, { owner = true, chatId = CHAT, network = 'whatsapp', userId = owner ? 'an' : 'pepe' } = {}) => app.spine.handleInbound({ body, from: {
  chatId, chatName: 'fam', network, userId, senderName: owner ? 'An' : 'Pepe', isSender: owner && network !== 'telegram', authorized: owner, msgKey: `in${++seq}`, replyToId: id,
} });
const reactTo = (app, id, emoji, { owner = true, chatId = CHAT, network = 'whatsapp' } = {}) => app.spine.handleInbound({ body: reactionAction({ emoji, targetId: id, snippet: '📥 An (ingest)' }), from: {
  chatId, chatName: 'fam', network, userId: owner ? 'an' : 'pepe', senderName: owner ? 'An' : 'Pepe', isSender: false, authorized: owner, isReaction: true, msgKey: id,
} });

describe('ingest.show / ingest.auto', () => {
  it('defaults (show, ask): the line is posted in the chat with the question, and nothing reaches the being yet', async () => {
    const { app, beeper, handled } = await bootWith(BEEPER_ONLY(null), { state: seed('whatsapp', CHAT, 'fam') });
    await drop(app, `/to ${CHAT}\ne, resume the thread`);
    const [post] = posts(beeper[0]);
    expect(post?.text).toContain('📥 An (ingest): e, resume the thread');
    expect(post?.text).toContain(INGEST_ASK);
    expect(post?.text).toMatch(/ · ⏳ 10 min$/);                   // the question's own line ends with the time left
    expect(ingestCalls(handled)).toEqual([]);
    expect(beeper[0].streams).toEqual([]);
    app.stop();
  });

  it('show:false + auto:false posts only the question', async () => {
    const { app, beeper, handled } = await bootWith(BEEPER_ONLY({ show: false }), { state: seed('whatsapp', CHAT, 'fam') });
    await drop(app, `/to ${CHAT}\ne, resume the thread`);
    expect(posts(beeper[0]).map((p) => p.text.trim())).toEqual([withCountdown(INGEST_ASK, ASK_TTL_MS)]);
    expect(ingestCalls(handled)).toEqual([]);
    app.stop();
  });

  it('show:true + auto:true posts the line (no question) and dispatches at once', async () => {
    const { app, beeper, handled } = await bootWith(BEEPER_ONLY({ auto: true }), { state: seed('whatsapp', CHAT, 'fam') });
    await drop(app, `/to ${CHAT}\ne, resume the thread`);
    const shown = posts(beeper[0]);
    expect(shown).toHaveLength(1);
    expect(shown[0].text).toContain('📥 An (ingest): e, resume the thread');
    expect(shown[0].text).not.toContain(INGEST_ASK);
    expect(ingestCalls(handled)).toHaveLength(1);
    await settled(handled);
    expect(beeper[0].streams.map((s) => s.chatId)).toEqual([CHAT]);
    app.stop();
  });

  it('show:false + auto:true is the silent box: nothing posted, dispatched at once', async () => {
    const { app, beeper, handled } = await bootWith(BEEPER_ONLY({ show: false, auto: true }), { state: seed('whatsapp', CHAT, 'fam') });
    await drop(app, `/to ${CHAT}\ne, resume the thread`);
    expect(posts(beeper[0])).toEqual([]);
    expect(ingestCalls(handled)).toHaveLength(1);
    app.stop();
  });

  it('ingest.ask is the question text', async () => {
    const { app, beeper } = await bootWith(BEEPER_ONLY({ ask: '¿lo mando? sí / no' }), { state: seed('whatsapp', CHAT, 'fam') });
    await drop(app, `/to ${CHAT}\ne, hola`);
    expect(posts(beeper[0])[0]?.text).toContain('¿lo mando? sí / no');
    expect(posts(beeper[0])[0]?.text).not.toContain(INGEST_ASK);
    app.stop();
  });
});

describe('answering the question', () => {
  it('answerOf: yes/y/si/sí/s/ok/👍 dispatch, no/n/non/👎 drop, anything else (any other emoji) is not an answer', () => {
    for (const s of ['yes', 'Yes', 'si', 'Sí', 'sí.', 'y', 's', 'S', 'OK', 'ok!', '👍', '👍🏽', ' yes ']) expect(answerOf(s), s).toBe(true);
    for (const s of ['no', 'No', 'n', 'non', 'Non.', 'NO.', '👎', '👎🏻']) expect(answerOf(s), s).toBe(false);
    for (const s of ['', 'yes please', 'maybe', 'nope', 'ya', 'nah', '❤️', '🙂', '👏', '🆗', null]) expect(answerOf(s), String(s)).toBe(null);
  });

  it('an owner\'s "yes" reply dispatches the line once; the yes itself wakes no being (on-mode chat)', async () => {
    const { app, beeper, handled, lines } = await bootWith(BEEPER_ONLY(null), { state: onMode(seed('whatsapp', CHAT, 'fam')) });
    await drop(app, `/to ${CHAT}\ne, resume the thread`);
    const ask = posts(beeper[0])[0];
    await replyTo(app, ask?.id, 'yes');
    await settled(handled);
    const sent = ingestCalls(handled);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toMatchObject({ body: 'e, resume the thread', from: { chatId: CHAT, via: 'ingest', authorized: true } });
    expect(beeper[0].streams).toHaveLength(1);                    // the ingested line's turn, none for "yes"
    expect(posts(beeper[0]).map((p) => p.text)).toContainEqual(expect.stringContaining('✅ dispatched'));
    expect(lines.some((l) => /\[ingest\] \/to !fam:beeper\.com: dispatched by An/.test(l))).toBe(true);
    await replyTo(app, ask.id, 'yes');                            // answered: a second yes is ordinary input
    await settled(handled);
    expect(ingestCalls(handled)).toHaveLength(1);
    app.stop();
  });

  it('"sí" works the same; "no" drops it with an outcome line and nothing reaches the being', async () => {
    const a = await bootWith(BEEPER_ONLY(null), { state: seed('whatsapp', CHAT, 'fam') });
    await drop(a.app, `/to ${CHAT}\ne, uno`);
    await replyTo(a.app, posts(a.beeper[0])[0]?.id, 'Sí');
    await settled(a.handled);
    expect(ingestCalls(a.handled)).toHaveLength(1);
    a.app.stop();

    const b = await bootWith(BEEPER_ONLY(null), { state: onMode(seed('whatsapp', CHAT, 'fam')) });
    await drop(b.app, `/to ${CHAT}\ne, dos`);
    await replyTo(b.app, posts(b.beeper[0])[0]?.id, 'no');
    await settled(b.handled);
    expect(ingestCalls(b.handled)).toEqual([]);
    expect(b.beeper[0].streams).toEqual([]);
    expect(posts(b.beeper[0]).map((p) => p.text)).toContainEqual(expect.stringContaining('🚫 dropped'));
    expect(b.lines.some((l) => /\[ingest\] \/to !fam:beeper\.com: dropped by An/.test(l))).toBe(true);
    b.app.stop();
  });

  it('a 👍 reaction on the post dispatches, a 👎 drops', async () => {
    const a = await bootWith(BEEPER_ONLY(null), { state: seed('whatsapp', CHAT, 'fam') });
    await drop(a.app, `/to ${CHAT}\ne, uno`);
    await reactTo(a.app, posts(a.beeper[0])[0]?.id, '👍');
    await settled(a.handled);
    expect(ingestCalls(a.handled)).toHaveLength(1);
    a.app.stop();

    const b = await bootWith(BEEPER_ONLY(null), { state: seed('whatsapp', CHAT, 'fam') });
    await drop(b.app, `/to ${CHAT}\ne, dos`);
    await reactTo(b.app, posts(b.beeper[0])[0]?.id, '👎');
    await settled(b.handled);
    expect(ingestCalls(b.handled)).toEqual([]);
    expect(posts(b.beeper[0]).map((p) => p.text)).toContainEqual(expect.stringContaining('🚫 dropped'));
    b.app.stop();
  });

  it('"s" and "non" answer too; another emoji on the post is not an answer', async () => {
    const a = await bootWith(BEEPER_ONLY(null), { state: seed('whatsapp', CHAT, 'fam') });
    await drop(a.app, `/to ${CHAT}\ne, uno`);
    const ask = posts(a.beeper[0])[0];
    await reactTo(a.app, ask?.id, '❤️');
    await replyTo(a.app, ask?.id, 'maybe');
    await settled(a.handled);
    expect(ingestCalls(a.handled)).toEqual([]);
    await replyTo(a.app, ask?.id, 's');
    await settled(a.handled);
    expect(ingestCalls(a.handled)).toHaveLength(1);
    a.app.stop();

    const b = await bootWith(BEEPER_ONLY(null), { state: seed('whatsapp', CHAT, 'fam') });
    await drop(b.app, `/to ${CHAT}\ne, dos`);
    await replyTo(b.app, posts(b.beeper[0])[0]?.id, 'non');
    await settled(b.handled);
    expect(ingestCalls(b.handled)).toEqual([]);
    expect(posts(b.beeper[0]).map((p) => p.text)).toContainEqual(expect.stringContaining('🚫 dropped'));
    b.app.stop();
  });

  it('a non-owner\'s "yes" is ordinary chat input: nothing dispatched, the question still open for the owner', async () => {
    const { app, beeper, handled } = await bootWith(BEEPER_ONLY(null), { state: seed('whatsapp', CHAT, 'fam') });
    await drop(app, `/to ${CHAT}\ne, resume`);
    const ask = posts(beeper[0])[0];
    await replyTo(app, ask?.id, 'yes', { owner: false });
    await reactTo(app, ask?.id, '👍', { owner: false });
    await settled(handled);
    expect(ingestCalls(handled)).toEqual([]);
    await replyTo(app, ask?.id, 'yes');
    await settled(handled);
    expect(ingestCalls(handled)).toHaveLength(1);
    app.stop();
  });

  it('the pending question survives a restart (state/ingest-asks.json)', async () => {
    const io = memIo();
    const state = seed('whatsapp', CHAT, 'fam');
    const first = await bootWith(BEEPER_ONLY(null), { state, io });
    await drop(first.app, `/to ${CHAT}\ne, resume the thread`);
    const ask = posts(first.beeper[0])[0];
    first.app.stop();
    expect(JSON.parse(io.files.get(join(_HOME, 'state', 'ingest-asks.json')) ?? 'null')).toEqual([{ chatId: CHAT, ids: [ask?.id], body: 'e, resume the thread', expiresAt: Date.UTC(2026, 9, 26, 14, 15), shown: 10, post: { id: ask?.id, text: expect.stringContaining(INGEST_ASK), expired: expect.stringContaining(INGEST_EXPIRED) } }]);

    const second = await bootWith(BEEPER_ONLY(null), { state, io });
    await replyTo(second.app, ask?.id, 'yes');
    await settled(second.handled);
    expect(ingestCalls(second.handled)).toHaveLength(1);
    expect(JSON.parse(io.files.get(join(_HOME, 'state', 'ingest-asks.json')))).toEqual([]);
    second.app.stop();
  });

  it('the shown post coming back on the ear (signed, from the account) wakes nobody in an on-mode chat', async () => {
    const echo = (app, p) => app.spine.handleInbound({ body: p.text, from: { chatId: CHAT, chatName: 'fam', network: 'whatsapp', userId: 'an', senderName: 'An', isSender: true, authorized: true, msgKey: `echo-${p.id}` } });
    const a = await bootWith(BEEPER_ONLY(null), { state: onMode(seed('whatsapp', CHAT, 'fam')) });
    await drop(a.app, `/to ${CHAT}\ne, resume the thread`);
    expect(a.beeper[0].sent).toHaveLength(1);
    await echo(a.app, a.beeper[0].sent[0]);
    await settled(a.handled);
    expect(a.beeper[0].streams).toEqual([]);
    expect(ingestCalls(a.handled)).toEqual([]);
    a.app.stop();

    const b = await bootWith(BEEPER_ONLY({ auto: true }), { state: onMode(seed('whatsapp', CHAT, 'fam')) });
    await drop(b.app, `/to ${CHAT}\ne, resume the thread`);
    await settled(b.handled);
    const shown = b.beeper[0].sent.filter((s) => s.text.startsWith('📥'));
    expect(shown).toHaveLength(1);
    expect(b.beeper[0].streams).toHaveLength(1);
    await echo(b.app, shown[0]);
    await settled(b.handled);
    expect(b.beeper[0].streams).toHaveLength(1);                  // the dispatched line's turn only
    b.app.stop();
  });
});

describe('/file attachments', () => {
  const withFiles = (io) => { io.files.set('/in/foto.png', 'PNG'); io.files.set('/in/factura.pdf', 'PDF'); return io; };
  const tail = (p) => p.replace(/\\/g, '/').split('/').slice(-2).join('/');

  it('an image and a PDF are saved to media/, shown in the chat, and reach the being as media lines', async () => {
    const io = withFiles(memIo());
    const { app, beeper, handled } = await bootWith(BEEPER_ONLY({ auto: true }), { state: seed('whatsapp', CHAT, 'fam'), io });
    await drop(app, `/to ${CHAT}\n/file /in/foto.png\n/file /in/factura.pdf\ne, mira esto`);
    const media = beeper[0].media;
    expect(media.map((m) => tail(m.path))).toEqual(['media/20261026-140500-an-image-ingest1.png', 'media/20261026-140500-an-document-ingest2.pdf']);
    expect(media.every((m) => io.files.has(m.path))).toBe(true);
    expect(ingestCalls(handled)[0]?.[0].body).toBe('e, mira esto\n(image foto.png) [saved: media/20261026-140500-an-image-ingest1.png]\n(document factura.pdf) [saved: media/20261026-140500-an-document-ingest2.pdf]');
    app.stop();
  });

  it('with the question, a reply to the attachment answers it too, and yes delivers the media lines', async () => {
    const io = withFiles(memIo());
    const { app, beeper, handled } = await bootWith(BEEPER_ONLY(null), { state: seed('whatsapp', CHAT, 'fam'), io });
    await drop(app, `/to ${CHAT}\n/file /in/foto.png\ne, mira`);
    await replyTo(app, beeper[0].media[0]?.id, 'ok');
    await settled(handled);
    expect(ingestCalls(handled)[0]?.[0].body).toBe('e, mira\n(image foto.png) [saved: media/20261026-140500-an-image-ingest1.png]');
    app.stop();
  });

  it('a missing path is logged and reported in the post; the text still goes through', async () => {
    const { app, beeper, handled, lines } = await bootWith(BEEPER_ONLY({ auto: true }), { state: seed('whatsapp', CHAT, 'fam') });
    await drop(app, `/to ${CHAT}\n/file /in/nope.png\ne, hola`);
    expect(beeper[0].media).toEqual([]);
    expect(posts(beeper[0])[0]?.text).toContain('/in/nope.png');
    expect(lines.some((l) => l.startsWith('[ingest]') && l.includes('/in/nope.png'))).toBe(true);
    expect(ingestCalls(handled)[0]?.[0].body).toBe('e, hola');
    app.stop();
  });
});

describe('the question on a Telegram topic', () => {
  const TOPIC = 'tg:-1000000000101/55';

  it('a reply in the topic, or a 👍 that names no topic (after a restart), answers it', async () => {
    await writeTgToken();
    const a = await bootWith(TELEGRAM_ONLY(null), { telegram: true, state: seed('telegram', TOPIC, 'Contoso · Ventas') });
    await drop(a.app, `/to ${TOPIC}\ne, hola`);
    const ask = posts(a.tg[0], TOPIC)[0];
    expect(ask?.text).toContain('📥 An (ingest): e, hola');
    await replyTo(a.app, ask?.id, 'sí', { chatId: TOPIC, network: 'telegram', userId: 42 });
    await settled(a.handled);
    expect(ingestCalls(a.handled)[0]?.[0].from).toMatchObject({ chatId: TOPIC, network: 'telegram', userId: 42 });
    a.app.stop();

    const b = await bootWith(TELEGRAM_ONLY(null), { telegram: true, state: seed('telegram', TOPIC, 'Contoso · Ventas') });
    await drop(b.app, `/to ${TOPIC}\ne, hola`);
    await reactTo(b.app, posts(b.tg[0], TOPIC)[0]?.id, '👍', { chatId: 'tg:-1000000000101', network: 'telegram' });
    await settled(b.handled);
    expect(ingestCalls(b.handled)).toHaveLength(1);
    b.app.stop();
  });
});

// ── an open question runs out (ingest.ttl_ms, default 10 min) ─────────────────────────────────────────────
describe('the question store: deadlines', () => {
  const memStore = (initial, { now, ttlMs } = {}) => {
    const files = new Map(initial ? [['/s/asks.json', JSON.stringify(initial)]] : []);
    const io = { readFile: async (p) => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p); }, writeFile: async (p, d) => { files.set(p, String(d)); }, rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); }, mkdir: async () => {} };
    return { files, store: createIngestAsks({ path: '/s/asks.json', io, now, ttlMs }) };
  };

  it('askTtlMs: 10 minutes unless ingest.ttl_ms says otherwise; minutesLeft rounds up and never shows 0', () => {
    expect(askTtlMs({})).toBe(600_000);
    expect(askTtlMs({ ingest: { ttl_ms: 120_000 } })).toBe(120_000);
    expect(askTtlMs({ ingest: { ttl_ms: 0 } })).toBe(0);
    expect(askTtlMs({ ingest: { ttl_ms: 'soon' } })).toBe(600_000);
    expect([600_000, 599_999, 540_001, 540_000, 61_000, 60_000, 1].map(minutesLeft)).toEqual([10, 10, 10, 9, 2, 1, 1]);
    expect(withCountdown('❓ q', 540_000)).toBe('❓ q · ⏳ 9 min');
    expect(withDeadline('❓ q', Date.UTC(2026, 9, 26, 14, 15), null)).toBe('❓ q · ⏳ until 14:15');
  });

  it('find skips a question past its deadline, before anything takes it out; deadline() is null with a ttl of 0', async () => {
    let t = 1_000;
    const { store } = memStore(null, { now: () => t, ttlMs: () => 5_000 });
    const ask = { chatId: 'c', ids: ['1'], body: 'b', expiresAt: store.deadline() };
    expect(ask.expiresAt).toBe(6_000);
    await store.add(ask);
    expect(store.find('c', '1')).toBe(ask);
    t = 5_999; expect(store.find('c', '1')).toBe(ask);
    t = 6_000; expect(store.find('c', '1')).toBe(null);
    expect(store.has(ask)).toBe(true);                            // still held: boot's tick is what takes it out
    expect(memStore(null, { ttlMs: () => 0 }).store.deadline()).toBe(null);
  });

  it('load gives an entry with no deadline a fresh one (now + ttl) and keeps the file honest; a stored deadline is kept', async () => {
    const { files, store } = memStore([{ chatId: 'c', ids: ['1'], body: 'old' }, { chatId: 'c', ids: ['2'], body: 'new', expiresAt: 42_000 }], { now: () => 1_000_000, ttlMs: () => 600_000 });
    await store.load();
    await store.mark(store.list()[0], {});                        // the chain: wait for the write
    expect(store.list().map((a) => a.expiresAt)).toEqual([1_600_000, 42_000]);
    expect(JSON.parse(files.get('/s/asks.json')).map((a) => a.expiresAt)).toEqual([1_600_000, 42_000]);
    expect(store.find('c', '1')?.body).toBe('old');               // not expired at load
  });

  it('with a ttl of 0 a legacy entry stays without a deadline (it never expires)', async () => {
    const { store } = memStore([{ chatId: 'c', ids: ['1'], body: 'old' }], { now: () => 1_000_000, ttlMs: () => 0 });
    await store.load();
    expect(store.list()[0].expiresAt).toBeUndefined();
    expect(store.find('c', '1')?.body).toBe('old');
  });
});

describe('an open /to question expires', () => {
  const T0 = Date.UTC(2026, 9, 26, 14, 5);
  const MIN = 60_000;
  const fakeClock = () => { let t = T0; return { now: () => t, advance: (ms) => { t += ms; } }; };
  const asksFile = (io) => JSON.parse(io.files.get(join(_HOME, 'state', 'ingest-asks.json')) ?? 'null');
  const edited = (spy) => spy.edits.map((e) => ({ ...e, text: plain(e.text) }));
  const HEAD = '📥 An (ingest): e, resume the thread';
  // The spine's own pulse, between two waits long enough for a sweep (in-memory fakes) to finish: a pulse that finds the
  // last sweep still running leaves the question alone, as it does in production.
  const flush = () => new Promise((r) => setTimeout(r, 15));
  const pulse = async (app) => { await flush(); app.spine.tick(); await flush(); };
  const minutesShown = (spy) => edited(spy).map((e) => /⏳ (\d+) min$/.exec(e.text)?.[1]);
  const askedFor = async (config, opts = {}) => {
    const clock = opts.clock ?? fakeClock();
    const n = await bootWith(config, { state: seed('whatsapp', CHAT, 'fam'), now: clock.now, ...opts });
    await drop(n.app, `/to ${CHAT}\ne, resume the thread`);
    return { ...n, clock, ask: posts(n.beeper[0])[0] };
  };

  it('the post counts down once a minute: an edit only when the shown value changes', async () => {
    const { app, beeper, clock, ask } = await askedFor(BEEPER_ONLY(null));
    expect(ask.text).toBe(`${HEAD}\n\n${INGEST_ASK} · ⏳ 10 min`);
    clock.advance(20_000); await pulse(app);
    expect(edited(beeper[0])).toEqual([]);                          // 9:40 left still reads 10 min
    clock.advance(41_000); await pulse(app);                       // 8:59
    expect(edited(beeper[0])).toEqual([{ chatId: CHAT, id: ask.id, text: `${HEAD}\n\n${INGEST_ASK} · ⏳ 9 min` }]);
    clock.advance(10_000); await pulse(app);
    await pulse(app);
    expect(edited(beeper[0])).toHaveLength(1);                      // the same minute: nothing more, however often it pulses
    clock.advance(MIN); await pulse(app);                          // 7:49
    expect(minutesShown(beeper[0])).toEqual(['9', '8']);
    app.stop();
  });

  it('at the deadline the post is edited to say it expired (the line stays), the entry leaves the store, a line is logged', async () => {
    const io = memIo();
    const { app, beeper, clock, ask, lines } = await askedFor(BEEPER_ONLY(null), { io });
    expect(asksFile(io)).toHaveLength(1);
    clock.advance(10 * MIN); await pulse(app);
    expect(edited(beeper[0]).at(-1)).toEqual({ chatId: CHAT, id: ask.id, text: `${HEAD}\n\n${INGEST_EXPIRED}` });
    expect(INGEST_EXPIRED).toBe('⌛ expired, not dispatched');
    expect(asksFile(io)).toEqual([]);
    expect(lines.some((l) => /\[ingest\] \/to !fam:beeper\.com: expired \(#m1\) — the line not dispatched$/.test(l))).toBe(true);
    clock.advance(10 * MIN); await pulse(app);
    expect(edited(beeper[0]).filter((e) => e.text.includes('expired'))).toHaveLength(1);   // once
    app.stop();
  });

  it('an answer after the deadline is not an answer: the yes is ordinary chat (it wakes the on-mode being), even before the tick took the entry out', async () => {
    const { app, beeper, handled, clock, ask } = await askedFor(BEEPER_ONLY(null));
    await pulse(app);
    clock.advance(9 * MIN + 59_000);
    await replyTo(app, ask?.id, 'ok');                               // one second early: an answer
    await settled(handled);
    expect(ingestCalls(handled)).toHaveLength(1);
    app.stop();

    const late = await askedFor(BEEPER_ONLY(null));
    late.clock.advance(10 * MIN);                                    // the deadline, no pulse yet
    await replyTo(late.app, late.ask?.id, 'yes');
    await settled(late.handled);
    expect(ingestCalls(late.handled)).toEqual([]);
    expect(posts(late.beeper[0]).map((p) => p.text)).not.toContainEqual(expect.stringContaining('✅ dispatched'));
    await pulse(late.app);
    expect(edited(late.beeper[0]).at(-1).text).toContain(INGEST_EXPIRED);
    await replyTo(late.app, late.ask.id, 'yes');
    await settled(late.handled);
    expect(ingestCalls(late.handled)).toEqual([]);
    late.app.stop();
  });

  it('show:false posts only the question: it is what expires, and only the expired line remains', async () => {
    const { app, beeper, clock, ask } = await askedFor(BEEPER_ONLY({ show: false }));
    expect(ask.text).toBe(`${INGEST_ASK} · ⏳ 10 min`);
    clock.advance(10 * MIN); await pulse(app);
    expect(edited(beeper[0]).at(-1).text).toBe(INGEST_EXPIRED);
    app.stop();
  });

  it('ingest.ttl_ms sets the length: the countdown starts at its whole minutes, rounded up', async () => {
    const { app, beeper, clock, ask } = await askedFor(BEEPER_ONLY({ ttl_ms: 90_000 }));
    expect(ask.text).toMatch(/ · ⏳ 2 min$/);
    clock.advance(31_000); await pulse(app);
    expect(minutesShown(beeper[0])).toEqual(['1']);
    clock.advance(60_000); await pulse(app);
    expect(edited(beeper[0]).at(-1).text).toContain(INGEST_EXPIRED);
    app.stop();
  });

  it('ttl_ms 0: no countdown, no deadline, and nothing ever expires', async () => {
    const io = memIo();
    const { app, beeper, handled, clock, ask } = await askedFor(BEEPER_ONLY({ ttl_ms: 0 }), { io });
    expect(ask.text).toBe(`${HEAD}\n\n${INGEST_ASK}`);
    expect(asksFile(io)[0]).not.toHaveProperty('expiresAt');
    clock.advance(48 * 60 * MIN); await pulse(app);
    expect(edited(beeper[0])).toEqual([]);
    await replyTo(app, ask.id, 'yes');
    await settled(handled);
    expect(ingestCalls(handled)).toHaveLength(1);
    app.stop();
  });

  it('a restart keeps the deadline: the second boot counts down from the first one\'s, and expires on it', async () => {
    const io = memIo();
    const clock = fakeClock();
    const first = await askedFor(BEEPER_ONLY(null), { io, clock });
    const { ask } = first;
    first.app.stop();
    expect(asksFile(io)[0]).toMatchObject({ expiresAt: T0 + 10 * MIN, shown: 10 });

    clock.advance(6 * MIN);
    const second = await bootWith(BEEPER_ONLY(null), { state: seed('whatsapp', CHAT, 'fam'), io, now: clock.now });
    expect(asksFile(io)[0]).toMatchObject({ expiresAt: T0 + 10 * MIN });          // not restarted from the boot's clock
    await pulse(second.app);
    expect(edited(second.beeper[0])).toEqual([{ chatId: CHAT, id: ask.id, text: `${HEAD}\n\n${INGEST_ASK} · ⏳ 4 min` }]);
    clock.advance(4 * MIN); await pulse(second.app);
    expect(edited(second.beeper[0]).at(-1).text).toBe(`${HEAD}\n\n${INGEST_EXPIRED}`);
    expect(asksFile(io)).toEqual([]);
    second.app.stop();
  });

  it('a question stored before expiry existed gets a fresh deadline at load (not expired at once), and is answerable until it', async () => {
    const io = memIo();
    io.files.set(join(_HOME, 'state', 'ingest-asks.json'), JSON.stringify([{ chatId: CHAT, ids: ['m7'], body: 'e, hola' }]));
    const clock = fakeClock();
    const { app, beeper, handled, lines } = await bootWith(BEEPER_ONLY(null), { state: seed('whatsapp', CHAT, 'fam'), io, now: clock.now });
    expect(asksFile(io)).toEqual([{ chatId: CHAT, ids: ['m7'], body: 'e, hola', expiresAt: T0 + 10 * MIN }]);
    expect(lines.some((l) => /1 open question\(s\) from before expiry now close in 10 min/.test(l))).toBe(true);
    await pulse(app);
    expect(asksFile(io)).toHaveLength(1);
    expect(edited(beeper[0])).toEqual([]);                          // no post of its own is known: nothing to count down
    clock.advance(9 * MIN);
    await replyTo(app, 'm7', 'yes');
    await settled(handled);
    expect(ingestCalls(handled)[0]?.[0].body).toBe('e, hola');
    app.stop();
  });

  it('a legacy question that then runs out has no post to edit: a new line says so', async () => {
    const io = memIo();
    io.files.set(join(_HOME, 'state', 'ingest-asks.json'), JSON.stringify([{ chatId: CHAT, ids: ['m7'], body: 'e, hola' }]));
    const clock = fakeClock();
    const { app, beeper, lines } = await bootWith(BEEPER_ONLY(null), { state: seed('whatsapp', CHAT, 'fam'), io, now: clock.now });
    clock.advance(10 * MIN); await pulse(app);
    expect(edited(beeper[0])).toEqual([]);
    expect(posts(beeper[0]).map((p) => p.text)).toEqual([INGEST_EXPIRED]);
    expect(asksFile(io)).toEqual([]);
    expect(lines.some((l) => /expired \(#m7\) — the line not dispatched \(said as a new line/.test(l))).toBe(true);
    app.stop();
  });

  it('a post that will not take an edit: tried once, left as posted, and a new line says the end; nothing throws', async () => {
    let tries = 0;
    const declared = { editMessage: async () => { tries += 1; throw new Error('message can no longer be edited'); } };
    const { app, beeper, clock, lines } = await askedFor(BEEPER_ONLY(null), { declared });
    clock.advance(61_000); await pulse(app);
    clock.advance(MIN); await pulse(app);
    clock.advance(MIN); await pulse(app);
    expect(tries).toBe(1);                                          // no hammering a post that refuses
    expect(lines.some((l) => /the post #m1 would not take an edit/.test(l))).toBe(true);
    clock.advance(10 * MIN); await pulse(app);
    expect(tries).toBe(1);
    expect(posts(beeper[0]).map((p) => p.text).at(-1)).toBe(`${HEAD}\n\n${INGEST_EXPIRED}`);   // the line again, with its end
    expect(lines.some((l) => /expired .* \(said as a new line/.test(l))).toBe(true);
    app.stop();
  });

  it('the expiry edit coming back on the ear (an edit of our own post, as the Beeper bridge hands it over) wakes nobody, even in an on-mode chat', async () => {
    const state = onMode(seed('whatsapp', CHAT, 'fam'));
    const { app, beeper, handled, clock, ask } = await askedFor(BEEPER_ONLY(null), { state });
    clock.advance(10 * MIN); await pulse(app);
    const done = edited(beeper[0]).at(-1);
    expect(done.text).toContain(INGEST_EXPIRED);
    await app.spine.handleInbound({ body: editAction({ targetId: ask.id, oldText: ask.text, newText: done.text }), from: {
      chatId: CHAT, chatName: 'fam', network: 'whatsapp', userId: 'an', senderName: 'An', isSender: true, authorized: true,
      isStageDirection: true, atEStart: false, atEAnywhere: false, msgKey: ask.id,
    } });
    await settled(handled);
    expect(beeper[0].streams).toEqual([]);
    expect(ingestCalls(handled)).toEqual([]);
    app.stop();
  });

  it('a chat the console owns has no edit verb: the question says the clock time it closes at instead', async () => {
    const clock = fakeClock();
    const { app } = await bootWith(BEEPER_ONLY(null), { state: seed('whatsapp', CHAT, 'fam'), now: clock.now });
    app.shellPort.claim(CHAT);
    const said = [];
    app.shellPort.send = async (chatId, text) => { said.push(String(text)); return { ok: true }; };
    await app.ingestLine(`/to ${CHAT}\ne, resume the thread`);
    expect(said).toHaveLength(1);
    expect(plain(said[0])).toBe(`${HEAD}\n\n${INGEST_ASK} · ⏳ until 14:15`);
    app.stop();
  });
});
