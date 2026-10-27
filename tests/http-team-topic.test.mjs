// http-team-topic.test.mjs — limbs.http.clients.<client>.team_group: each chatbox session opens a
// topic in a Telegram forum group, seated as a tg-group chat member of the conversation, so the
// room relay carries the visitor's lines to the team and the team's lines to the visitor
// (src/spine/room-relay.mjs). A real boot, a real loopback chatbox, the Telegram limb over a fake
// Bot API.
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';

const _HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-http-team-topic-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { freeSafeHttpPort } from './free-safe-http-port.mjs';
import { boot } from '../src/spine/boot.mjs';
import { startTelegramBridge } from '../src/bridges/telegram.mjs';
import { emptyState, getContact, ensureContact, recordThread } from '../src/conversations-state.mjs';
import { Room } from '../src/room-core.mjs';
import { ROOMS_FILE } from '../src/rooms-file.mjs';
import { HTTP_STRINGS } from '../src/bridges/http.mjs';

afterEach(async () => {
  await fs.rm(ROOMS_FILE, { force: true });
  await fs.rm(join(_HOME, 'state'), { recursive: true, force: true });
});
afterAll(async () => { try { await fs.rm(_HOME, { recursive: true, force: true }); } catch {} });

const TOKEN = '123456:FAKE-team-topic-token';
const ME = { id: 99, is_bot: true, username: 'edw_bot', can_read_all_group_messages: true };
const GROUP = -1001234;
const TOPIC = `tg:${GROUP}/77`;               // the first topic the fake makes
const CHAT = { id: GROUP, type: 'supergroup', title: 'EduWeb Chatbox', is_forum: true };
const ANA = { id: 55, is_bot: false, first_name: 'Ana' };

function fakeApi() {
  const calls = [];
  const queue = [];
  let parked = null, nextId = 500, updateId = 1000, nextThread = 77;
  const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
  const err = (code, description) => ({ status: code, json: async () => ({ ok: false, error_code: code, description }) });
  const answers = {
    getMe: () => ok(ME),
    sendMessage: (b) => ok({ message_id: nextId++, chat: { id: Number(b.chat_id) }, text: b.text }),
    editMessageText: () => ok(true),
    deleteMessage: () => ok(true),
    setMessageReaction: () => ok(true),
    createForumTopic: (b) => ok({ message_thread_id: nextThread++, name: b.name, icon_color: 7322096 }),
  };
  const fetch = async (url, init) => {
    const method = url.split('/').pop();
    const call = { method, body: JSON.parse(init.body) };
    calls.push(call);
    if (method === 'getUpdates') {
      if (queue.length) return queue.shift();
      return new Promise((resolve, reject) => {
        parked = resolve;
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const res = answers[method](call.body);
    call.out = await res.json();
    return res;
  };
  const push = (r) => { if (parked) { const p = parked; parked = null; p(r); } else queue.push(r); };
  return {
    fetch, calls, answers, err,
    updates: (...msgs) => push(ok(msgs.map((message) => ({ update_id: ++updateId, message })))),
    of: (method) => calls.filter((c) => c.method === method),
  };
}
let mid = 300;
const now = () => Math.floor(Date.now() / 1000);
const inTopic = (text, over = {}) => ({ message_id: ++mid, date: now(), chat: CHAT, from: ANA, text, is_topic_message: true, message_thread_id: 77, ...over });

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
// A resumed session keeps its id; a fresh one mints the next (sess-1, sess-2, …).
function brain(turns) {
  let minted = 0;
  return (opts) => {
    const id = opts.sessionId ?? `sess-${++minted}`;
    return {
      sessionId: id,
      async turn(m) { turns.push({ cwd: opts.cwd, m, session: id, resumed: opts.sessionId ?? null }); return { text: `respuesta a ${m.split('\n').at(-1)}`, sessionId: id }; },
      close() {},
    };
  };
}

const AGENTS = { ed: { configuration: 'egpt', handles: ['ed'], body_emoji: '🦉' } };
// realFs: transcripts on disk (under _HOME), where /agents rethread's roll reads them.
async function bootTeam(client = { team_group: GROUP, team_name: 'Equipo EduWeb' }, { state = emptyState(), realFs = false } = {}) {
  await fs.mkdir(join(_HOME, 'secrets'), { recursive: true });
  await fs.writeFile(join(_HOME, 'secrets', 'telegram-main.token'), `${TOKEN}\n`);
  const port = await freeSafeHttpPort();
  const api = fakeApi();
  const io = memIo();
  const turns = [];
  const lines = [];
  let st = state;
  const app = await boot({
    readConfig: () => ({
      node_name: 'EDW', user_name: 'John',
      conversation_defaults: { allowed_users: ['owner-1'] },
      limbs: { telegram: { main: { account: 'edw_bot' } }, http: { port, clients: { eduweb: { being: 'ed', title: 'EduWeb', ...client } } } },
      agents: AGENTS,
    }),
    startTelegram: (opts) => startTelegramBridge({ ...opts, fetch: api.fetch }),
    makeSession: brain(turns),
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    ...(realFs ? {} : { io }), ingest: false, tickMs: 0,
    log: { line: (s) => lines.push(s) },
  });
  await vi.waitFor(() => expect(api.of('getUpdates').length).toBeGreaterThan(0));
  const url = `http://127.0.0.1:${port}/chat/eduweb/`;
  const post = (body) => fetch(`${url}messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const messages = async (session) => (await fetch(`${url}messages?session=${encodeURIComponent(session)}`).then((r) => r.json())).messages;
  const slugOf = (turn) => turn.cwd.split(/[\\/]/).at(-1);
  const transcript = (slug) => io.files.get(join(_HOME, 'conversations', 'http', slug, 'transcript.md')) ?? '';
  // Each message posted in the topic, as its last edit left it: { id, text }.
  const inThread = () => api.of('sendMessage').filter((c) => c.body.chat_id === String(GROUP) && c.body.message_thread_id === 77).map((c) => {
    const id = c.out.result.message_id;
    return { id, text: api.of('editMessageText').filter((e) => e.body.message_id === id).at(-1)?.body.text ?? c.body.text };
  });
  return { app, api, turns, lines, url, post, messages, slugOf, transcript, inThread, state: () => st };
}
const answered = (msgs, n = 1) => msgs.filter((m) => m.from === 'being' && m.done && /respuesta a/.test(m.text)).length >= n;
const settle = () => new Promise((r) => setTimeout(r, 300));

// Every `data:` event of an SSE response, as it arrives.
function sse(href) {
  const ac = new AbortController();
  const events = [];
  const done = (async () => {
    const res = await fetch(href, { signal: ac.signal });
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        buf = buf.slice(i + 2);
        if (data) events.push(JSON.parse(data));
      }
    }
  })().catch(() => {});
  return { events, close: () => { ac.abort(); return done; } };
}

describe('a chatbox client with a team_group', () => {
  it('a new session opens exactly one topic, named from the title and the session, seated as a chat member', async () => {
    const n = await bootTeam();
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    await n.post({ session: a.session, text: 'somos un colegio' });
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    const made = n.api.of('createForumTopic');
    expect(made).toHaveLength(1);
    const slug = n.slugOf(n.turns[0]);
    expect(made[0].body).toEqual({ chat_id: String(GROUP), name: `EduWeb · ${slug.slice('eduweb-'.length, 'eduweb-'.length + 6)}` });
    expect(await Room.forChat('http', slug).members()).toEqual([{ kind: 'tg-group', id: TOPIC, state: 'active', replies: true, title: 'Equipo EduWeb' }]);
    // the session's being answers its visitor in mode mention; the topic holds it mute
    expect(getContact(n.state(), 'http', `http:${slug}`).entry.agents.ed).toMatchObject({ default: true, mode: 'mention', allowed_users: ['*'] });
    expect(getContact(n.state(), 'telegram', TOPIC).entry.agents.ed.mode).toBe('mute');
    // another visitor, another topic
    await n.post({ text: 'otra visita' });
    await vi.waitFor(() => expect(n.api.of('createForumTopic')).toHaveLength(2), { timeout: 5000 });
    n.app.stop();
  });

  it("the visitor's line and the being's reply both appear in the topic, the reply in the being's own stamp", async () => {
    const n = await bootTeam();
    await n.post({ text: 'hola, quiero una demo' });
    await vi.waitFor(() => expect(n.inThread().map((m) => m.text)).toEqual([
      expect.stringMatching(/visitor: hola, quiero una demo$/),
      expect.stringMatching(/^🦉 respuesta a .*hola, quiero una demo$/),
    ]), { timeout: 5000 });
    n.app.stop();
  });

  it("a team line in the topic shows in the widget as the team and lands in the transcript, without a being turn", async () => {
    const n = await bootTeam();
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    const slug = n.slugOf(n.turns[0]);
    const stream = sse(`${n.url}events?session=${encodeURIComponent(a.session)}`);
    n.api.updates(inTopic('Hola, soy Ana del equipo'));
    const team = (m) => m.from === 'being' && /Equipo EduWeb: Hola, soy Ana del equipo$/.test(m.text);
    await vi.waitFor(async () => expect((await n.messages(a.session)).some(team)).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(stream.events.some(team)).toBe(true), { timeout: 5000 });
    await stream.close();
    await vi.waitFor(() => expect(n.transcript(slug)).toContain('Hola, soy Ana del equipo'), { timeout: 5000 });
    await settle();
    expect(n.turns).toHaveLength(1);
    expect((await n.messages(a.session)).filter((m) => m.from === 'being')).toHaveLength(2);   // the first answer, the team's line
    n.app.stop();
  });

  it('a team line that names the being wakes it in the chatbox, and the answer reaches the visitor', async () => {
    const n = await bootTeam();
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    n.api.updates(inTopic('@ed envíale el enlace de la demo'));
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    expect(n.turns[1].cwd).toBe(n.turns[0].cwd);
    expect(n.turns[1].m).toContain('envíale el enlace de la demo');
    await vi.waitFor(async () => expect(answered(await n.messages(a.session), 2)).toBe(true), { timeout: 5000 });
    // …and the team sees that answer in the topic too
    await vi.waitFor(() => expect(n.inThread().map((m) => m.text)).toContainEqual(expect.stringMatching(/^🦉 respuesta a .*envíale el enlace de la demo$/)), { timeout: 5000 });
    n.app.stop();
  });

  it("our own copies in the topic (the visitor's line, the being's reply), handed back by Telegram, re-enter nowhere", async () => {
    const n = await bootTeam();
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(n.inThread().map((m) => m.text)).toEqual([expect.stringMatching(/visitor: hola$/), expect.stringMatching(/^🦉 respuesta a /)]), { timeout: 5000 });
    const slug = n.slugOf(n.turns[0]);
    const before = n.transcript(slug);
    n.api.updates(...n.inThread().map((copy) => inTopic(copy.text, { message_id: copy.id, from: ME })));
    await vi.waitFor(() => expect(n.lines.filter((l) => /echo: .*own output re-entered/.test(l))).toHaveLength(2), { timeout: 5000 });
    await settle();
    expect(n.transcript(slug)).toBe(before);
    expect(n.turns).toHaveLength(1);
    expect((await n.messages(a.session)).filter((m) => m.from === 'being')).toHaveLength(1);
    n.app.stop();
  });

  it('the team group\'s General chat being a conversation changes nothing: the topic stays the chatbox\'s, not a fork', async () => {
    let state = ensureContact(emptyState(), 'telegram', `tg:${GROUP}`, { pushedName: 'EduWeb Chatbox' }).state;
    state = recordThread(state, 'telegram', `tg:${GROUP}`, 'general-thread', '2026-10-01T00:00:00Z', 'ed');
    const n = await bootTeam(undefined, { state });
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    const slug = n.slugOf(n.turns[0]);
    n.api.updates(inTopic('Hola, soy Ana del equipo'));
    await vi.waitFor(() => expect(n.transcript(slug)).toContain('Hola, soy Ana del equipo'), { timeout: 5000 });
    const topic = getContact(n.state(), 'telegram', TOPIC).entry;
    expect(topic.parent_chat).toBeUndefined();
    expect(topic.transcript).toBeUndefined();
    expect(topic.slug).not.toBe(getContact(n.state(), 'telegram', `tg:${GROUP}`).entry.slug);
    expect(topic.agents.ed).toEqual({ mode: 'mute' });
    expect(n.turns).toHaveLength(1);
    n.app.stop();
  });

  it('a group without Topics: no topic, the reason logged, the visitor still answered', async () => {
    const n = await bootTeam();
    n.api.answers.createForumTopic = () => n.api.err(400, 'Bad Request: the chat is not a forum');
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    expect(n.lines.some((l) => /^\[http\] http:eduweb-[0-9a-f]{16}: no team topic — .*Topics/.test(l))).toBe(true);
    expect(await Room.forChat('http', n.slugOf(n.turns[0])).members()).toEqual([]);
    n.app.stop();
  });
});

describe('the visitor ends the conversation (POST end)', () => {
  it('a fresh thread in the same conversation: thread cleared, transcript rolled under the boundary, history empty, the team told; the same token keeps its folder and topic', async () => {
    const n = await bootTeam(undefined, { realFs: true });
    const a = await n.post({ text: 'hola, quiero una demo' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    const slug = n.slugOf(n.turns[0]);
    const chatId = `http:${slug}`;
    const dir = join(_HOME, 'conversations', 'http', slug);
    await vi.waitFor(() => expect(getContact(n.state(), 'http', chatId).entry.agents.ed.threadId).toBe('sess-1'), { timeout: 5000 });
    await vi.waitFor(async () => expect(await fs.readFile(join(dir, 'transcript.md'), 'utf8')).toMatch(/thread_id: sess-1[\s\S]*respuesta a/), { timeout: 5000 });

    const r = await fetch(`${n.url}end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: a.session }) });
    expect(r.status).toBe(200);
    expect(getContact(n.state(), 'http', chatId).entry.agents.ed).toMatchObject({ threadId: null, mode: 'mention', allowed_users: ['*'] });
    expect(await fs.readFile(join(dir, 'transcripts', 'sess-1.md'), 'utf8')).toContain('hola, quiero una demo');
    const fresh = await fs.readFile(join(dir, 'transcript.md'), 'utf8');
    expect(fresh).toContain('rethreaded — fresh session from here; nothing above this line is in context');
    expect(fresh).not.toContain('quiero una demo');
    expect(await n.messages(a.session)).toEqual([]);
    await vi.waitFor(() => expect(n.inThread().map((m) => m.text).at(-1)).toBe(HTTP_STRINGS.ended), { timeout: 5000 });

    const b = await n.post({ session: a.session, text: 'otra pregunta' });
    expect(b.session).toBe(a.session);
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    expect(n.turns[1]).toMatchObject({ cwd: n.turns[0].cwd, session: 'sess-2', resumed: null });
    expect(n.turns[1].m).not.toContain('quiero una demo');
    await vi.waitFor(() => expect(n.inThread().map((m) => m.text).slice(-2)).toEqual([
      expect.stringMatching(/visitor: otra pregunta$/),
      expect.stringMatching(/^🦉 respuesta a .*otra pregunta$/),
    ]), { timeout: 5000 });
    expect(n.api.of('createForumTopic')).toHaveLength(1);
    expect((await n.messages(a.session)).map((m) => m.from)).toEqual(['visitor', 'being']);
    n.app.stop();
  });
});

describe('a chatbox client with no team_group', () => {
  it('nothing changes: no topic, nothing sent to Telegram, the session seeded mode on', async () => {
    const n = await bootTeam({});
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    const slug = n.slugOf(n.turns[0]);
    expect(n.api.of('createForumTopic')).toEqual([]);
    expect(n.api.of('sendMessage')).toEqual([]);
    expect(await Room.forChat('http', slug).members()).toEqual([]);
    expect(getContact(n.state(), 'http', `http:${slug}`).entry.agents.ed).toMatchObject({ default: true, mode: 'on', allowed_users: ['*'] });
    n.app.stop();
  });
});
