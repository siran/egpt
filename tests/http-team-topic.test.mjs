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

import { promises as fs, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { dirname, join } from 'node:path';
import { freeSafeHttpPort } from './free-safe-http-port.mjs';
import { boot } from '../src/spine/boot.mjs';
import { startTelegramBridge } from '../src/bridges/telegram.mjs';
import { emptyState, getContact, ensureContact, recordThread } from '../src/conversations-state.mjs';
import { Room } from '../src/room-core.mjs';
import { ROOMS_FILE } from '../src/rooms-file.mjs';
import { HTTP_STRINGS } from '../src/bridges/http.mjs';

// A test ends on its last reply; the chatbox limb's stop then settles once that is in state/http-messages.
let stopHttp = null;
afterEach(async () => {
  await stopHttp?.();
  stopHttp = null;
  await fs.rm(ROOMS_FILE, { force: true });
  await fs.rm(join(_HOME, 'state'), { recursive: true, force: true });
  await fs.rm(join(_HOME, 'conversations'), { recursive: true, force: true });   // a surviving folder is never re-written: each test starts on none
});
afterAll(async () => { try { await fs.rm(_HOME, { recursive: true, force: true }); } catch {} });

const TOKEN = '123456:FAKE-team-topic-token';
const ME = { id: 99, is_bot: true, username: 'edw_bot', can_read_all_group_messages: true };
const GROUP = -1001234;
const TOPIC = `tg:${GROUP}/77`;               // the first topic the fake makes
const CHAT = { id: GROUP, type: 'supergroup', title: 'Contoso Chatbox', is_forum: true };
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
    const res = await answers[method](call.body);
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
const hold = { p: null };   // a test's gate: a line with ESPERA waits on it
function brain(turns) {
  let minted = 0;
  return (opts) => {
    const id = opts.sessionId ?? `sess-${++minted}`;
    return {
      sessionId: id,
      async turn(m) {
        turns.push({ cwd: opts.cwd, m, session: id, resumed: opts.sessionId ?? null });
        if (m.includes('ESPERA') && hold.p) await hold.p;
        return { text: `respuesta a ${m.split('\n').at(-1)}`, sessionId: id };
      },
      close() {},
    };
  };
}

const ID_KEY = 'dummy-chatbox-key-not-a-secret';
const signed = (who, s = 3600) => {
  const body = Buffer.from(JSON.stringify({ ...who, exp: Math.floor(Date.now() / 1000) + s })).toString('base64url');
  return `${body}.${createHmac('sha256', ID_KEY).update(body).digest('base64url')}`;
};
const JP = { abrin: 'IEV', user_type: 'P', short_name: 'Juan Pérez', username: 'jperez' };
const ML = { abrin: 'IEV', user_type: 'R', short_name: 'María López', username: 'mlopez' };
const CONTOSO_TITLE = '{abrin} {user_type} {short_name} ({username})';

const AGENTS = { ed: { configuration: 'egpt', handles: ['ed'], body_emoji: '🦉' } };
// realFs: transcripts on disk (under _HOME), where /agents rethread's roll reads them.
// block: the client as a top-level block named by limbs.http.chatboxes, not under clients:.
async function bootTeam(client = { team_group: GROUP, team_name: 'Equipo Contoso' }, { state = emptyState(), realFs = false, now, block = false } = {}) {
  await fs.mkdir(join(_HOME, 'secrets'), { recursive: true });
  await fs.writeFile(join(_HOME, 'secrets', 'telegram-main.token'), `${TOKEN}\n`);
  await fs.writeFile(join(_HOME, 'secrets', 'chatbox-contoso.key'), `${ID_KEY}\n`);
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
      ...(block
        ? { limbs: { telegram: { main: { account: 'edw_bot' } }, http: { port, chatboxes: ['contoso_marketer'] } }, contoso_marketer: { client_name: 'contoso', being: 'ed', title: 'Contoso', ...client } }
        : { limbs: { telegram: { main: { account: 'edw_bot' } }, http: { port, clients: { contoso: { being: 'ed', title: 'Contoso', ...client } } } } }),
      agents: AGENTS,
    }),
    startTelegram: (opts) => startTelegramBridge({ ...opts, fetch: api.fetch }),
    makeSession: brain(turns),
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    ...(realFs ? {} : { io }), ...(now ? { now } : {}), ingest: false, tickMs: 0,
    log: { line: (s) => lines.push(s) },
  });
  stopHttp = () => app.httpPort.stop();
  await vi.waitFor(() => expect(api.of('getUpdates').length).toBeGreaterThan(0));
  const url = `http://127.0.0.1:${port}/chat/contoso/`;
  const post = (body) => fetch(`${url}messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const messages = async (session, identity) => (await fetch(`${url}messages?session=${encodeURIComponent(session)}${identity ? `&identity=${encodeURIComponent(identity)}` : ''}`).then((r) => r.json())).messages;
  const slugOf = (turn) => turn.cwd.split(/[\\/]/).at(-1);
  const transcript = (slug) => io.files.get(join(_HOME, 'conversations', 'http', slug, 'transcript.md')) ?? '';
  // Each message posted in the topic, as its last edit left it: { id, text }.
  const inThread = () => api.of('sendMessage').filter((c) => c.body.chat_id === String(GROUP) && c.body.message_thread_id === 77).map((c) => {
    const id = c.out.result.message_id;
    return { id, text: api.of('editMessageText').filter((e) => e.body.message_id === id).at(-1)?.body.text ?? c.body.text };
  });
  return { app, api, io, turns, lines, url, post, messages, slugOf, transcript, inThread, state: () => st };
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
    expect(made[0].body).toEqual({ chat_id: String(GROUP), name: `Contoso · ${slug.slice('contoso-'.length, 'contoso-'.length + 6)}` });
    await vi.waitFor(async () => expect(await Room.forChat('http', slug).members()).toEqual([{ kind: 'tg-group', id: TOPIC, state: 'active', replies: true, title: 'Equipo Contoso' }]), { timeout: 5000 });
    // the session's being answers its visitor in mode mention; the topic is only a view: no entry, no folder
    expect(getContact(n.state(), 'http', `http:${slug}`).entry.agents.ed).toMatchObject({ default: true, mode: 'mention', allowed_users: ['*'] });
    expect(getContact(n.state(), 'telegram', TOPIC)).toBeNull();
    expect([...n.io.files.keys()].filter((k) => k.includes(join('conversations', 'telegram')))).toEqual([]);
    // another visitor, another topic
    const b = await n.post({ text: 'otra visita' });
    await vi.waitFor(() => expect(n.api.of('createForumTopic')).toHaveLength(2), { timeout: 5000 });
    await vi.waitFor(async () => expect(answered(await n.messages(b.session))).toBe(true), { timeout: 5000 });
    n.app.stop();
  });

  it('a top-level chatbox block (limbs.http.chatboxes) opens and seats its topic as a clients entry does', async () => {
    const n = await bootTeam(undefined, { block: true });
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    const slug = n.slugOf(n.turns[0]);
    await vi.waitFor(() => expect(n.api.of('createForumTopic').map((c) => c.body)).toEqual([{ chat_id: String(GROUP), name: `Contoso · ${slug.slice('contoso-'.length, 'contoso-'.length + 6)}` }]), { timeout: 5000 });
    await vi.waitFor(async () => expect(await Room.forChat('http', slug).members()).toEqual([{ kind: 'tg-group', id: TOPIC, state: 'active', replies: true, title: 'Equipo Contoso' }]), { timeout: 5000 });
    expect(getContact(n.state(), 'http', `http:${slug}`).entry.agents.ed).toMatchObject({ default: true, mode: 'mention', allowed_users: ['*'] });
    n.app.stop();
  });

  it("a new session's topic opens with its first line (no header); later lines and replies appear live, the reply in the being's own stamp", async () => {
    const n = await bootTeam();
    const a = await n.post({ text: 'hola, quiero una demo' });
    await vi.waitFor(() => expect(n.inThread()[0]?.text.split('\n')[0]).toBe('visitor: hola, quiero una demo'), { timeout: 5000 });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    await n.post({ session: a.session, text: 'somos un colegio' });
    await vi.waitFor(() => expect(n.inThread().map((m) => m.text).slice(-2)).toEqual([
      expect.stringMatching(/visitor: somos un colegio$/),
      expect.stringMatching(/^🦉 respuesta a .*somos un colegio$/),
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
    const team = (m) => m.from === 'being' && /Equipo Contoso: Hola, soy Ana del equipo$/.test(m.text);
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

  it("our own copies in the topic (the recap, the visitor's line, the being's reply), handed back by Telegram, re-enter nowhere (a view tunnels no echo)", async () => {
    const n = await bootTeam();
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(n.inThread().length).toBeGreaterThan(0), { timeout: 5000 });
    await n.post({ session: a.session, text: 'otra' });
    await vi.waitFor(() => expect(n.inThread().map((m) => m.text).slice(-2)).toEqual([expect.stringMatching(/visitor: otra$/), expect.stringMatching(/^🦉 respuesta a .*otra$/)]), { timeout: 5000 });
    await settle();
    const slug = n.slugOf(n.turns[0]);
    const before = n.transcript(slug);
    const copies = n.inThread();
    n.api.updates(...copies.map((copy) => inTopic(copy.text, { message_id: copy.id, from: ME })));
    await vi.waitFor(() => expect(n.lines.filter((l) => /view: .*team topic; not tunnelled/.test(l))).toHaveLength(copies.length), { timeout: 5000 });
    await settle();
    expect(n.transcript(slug)).toBe(before);
    expect(n.turns).toHaveLength(2);
    expect((await n.messages(a.session)).filter((m) => m.from === 'being')).toHaveLength(2);
    n.app.stop();
  });

  it('the team group\'s General chat being a conversation changes nothing: the topic stays the chatbox\'s, not a fork', async () => {
    let state = ensureContact(emptyState(), 'telegram', `tg:${GROUP}`, { pushedName: 'Contoso Chatbox' }).state;
    state = recordThread(state, 'telegram', `tg:${GROUP}`, 'general-thread', '2026-10-01T00:00:00Z', 'ed');
    const n = await bootTeam(undefined, { state });
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    const slug = n.slugOf(n.turns[0]);
    n.api.updates(inTopic('Hola, soy Ana del equipo'));
    await vi.waitFor(() => expect(n.transcript(slug)).toContain('Hola, soy Ana del equipo'), { timeout: 5000 });
    expect(getContact(n.state(), 'telegram', TOPIC)).toBeNull();   // a view: not a fork, not an entry
    expect(n.turns).toHaveLength(1);
    n.app.stop();
  });

  it('a team topic is a view: a line in it is logged once in the visitor\'s transcript, shown in the widget, wakes the being in the visitor\'s folder, and makes no telegram entry or folder', async () => {
    const n = await bootTeam();
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    const slug = n.slugOf(n.turns[0]);
    await vi.waitFor(async () => expect(await Room.forChat('http', slug).members()).toHaveLength(1), { timeout: 5000 });
    n.api.updates(inTopic('@ed manda el enlace'));
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session), 2)).toBe(true), { timeout: 5000 });
    await settle();
    expect(n.turns[1].cwd).toBe(n.turns[0].cwd);
    expect(n.turns[1].m).toContain('manda el enlace');
    expect(n.transcript(slug).split('\nAna@').length - 1).toBe(1);   // one record of the inbound line
    expect((await n.messages(a.session)).some((m) => /Equipo Contoso: @ed manda el enlace$/.test(m.text))).toBe(true);
    expect(getContact(n.state(), 'telegram', TOPIC)).toBeNull();
    expect(Object.keys(n.state().contacts?.telegram ?? {})).toEqual([]);
    expect([...n.io.files.keys()].filter((k) => k.includes(join('conversations', 'telegram')))).toEqual([]);
    // the reply reaches the topic too
    expect(n.inThread().map((m) => m.text)).toContainEqual(expect.stringMatching(/^🦉 respuesta a .*manda el enlace$/));
    n.app.stop();
  });

  it('two visitors, two topics: a line in topic B reaches only conversation B', async () => {
    const n = await bootTeam();
    const a = await n.post({ text: 'visita A' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    const b = await n.post({ text: 'visita B' });
    await vi.waitFor(async () => expect(answered(await n.messages(b.session))).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(n.api.of('createForumTopic')).toHaveLength(2), { timeout: 5000 });
    const slugA = n.slugOf(n.turns.find((t) => t.m.includes('visita A')));
    const slugB = n.slugOf(n.turns.find((t) => t.m.includes('visita B')));
    await vi.waitFor(async () => expect(await Room.forChat('http', slugB).members()).toHaveLength(1), { timeout: 5000 });
    const before = n.transcript(slugA);
    n.api.updates(inTopic('@ed solo para B', { message_thread_id: 78 }));
    await vi.waitFor(() => expect(n.turns).toHaveLength(3), { timeout: 5000 });
    await settle();
    expect(n.turns[2].cwd.split(/[\\/]/).at(-1)).toBe(slugB);
    expect(n.transcript(slugB)).toContain('solo para B');
    expect(n.transcript(slugA)).toBe(before);
    expect((await n.messages(a.session)).some((m) => /solo para B/.test(m.text))).toBe(false);
    expect(Object.keys(n.state().contacts?.telegram ?? {})).toEqual([]);
    n.app.stop();
  });

  it('an old topic entry still in conversations.yaml: the line routes to the visitor anyway and the old entry is not written to', async () => {
    const old = ensureContact(emptyState(), 'telegram', TOPIC, { pushedName: 'Contoso · old' });
    const n = await bootTeam(undefined, { state: old.state });
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    const slug = n.slugOf(n.turns[0]);
    await vi.waitFor(async () => expect(await Room.forChat('http', slug).members()).toHaveLength(1), { timeout: 5000 });
    const entryBefore = JSON.stringify(getContact(n.state(), 'telegram', TOPIC).entry);
    n.api.updates(inTopic('@ed desde el tema viejo'));
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    await settle();
    expect(n.turns[1].cwd).toBe(n.turns[0].cwd);
    expect(n.transcript(slug)).toContain('desde el tema viejo');
    expect(JSON.stringify(getContact(n.state(), 'telegram', TOPIC).entry)).toBe(entryBefore);
    expect([...n.io.files.keys()].filter((k) => k.includes(join('conversations', 'telegram')))).toEqual([]);
    n.app.stop();
  });

  it('a topic that is NOT a room member behaves as before: its own conversation, registered by its first line, its own transcript', async () => {
    const n = await bootTeam();
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    const slug = n.slugOf(n.turns[0]);
    const before = n.transcript(slug);
    n.api.updates(inTopic('una linea suelta', { message_thread_id: 90 }));
    await vi.waitFor(() => expect(getContact(n.state(), 'telegram', `tg:${GROUP}/90`)).not.toBeNull(), { timeout: 5000 });
    await settle();
    expect(n.transcript(slug)).toBe(before);
    expect(n.turns).toHaveLength(1);
    n.app.stop();
  });

  it('the topic is made in the background: lines reach the being while createForumTopic hangs, one attempt, and the topic gets their recap', async () => {
    const n = await bootTeam();
    let release;
    n.api.answers.createForumTopic = (b) => new Promise((r) => { release = () => r({ status: 200, json: async () => ({ ok: true, result: { message_thread_id: 77, name: b.name } }) }); });
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    await n.post({ session: a.session, text: 'somos un colegio' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session), 2)).toBe(true), { timeout: 5000 });
    expect(n.api.of('createForumTopic')).toHaveLength(1);
    expect(n.inThread()).toEqual([]);
    release();
    await vi.waitFor(() => expect(n.inThread()[0]?.text.split('\n')).toEqual([
      'visitor: hola', expect.stringMatching(/^ed: 🦉 respuesta a .*: hola$/),
      'visitor: somos un colegio', expect.stringMatching(/^ed: 🦉 respuesta a .*: somos un colegio$/),
    ]), { timeout: 5000 });
    await n.post({ session: a.session, text: 'tercera' });
    await vi.waitFor(() => expect(n.inThread().map((m) => m.text).slice(1)).toEqual([
      expect.stringMatching(/visitor: tercera$/),
      expect.stringMatching(/^🦉 respuesta a .*tercera$/),
    ]), { timeout: 5000 });
    expect(n.api.of('createForumTopic')).toHaveLength(1);
    n.app.stop();
  });

  it('a failed topic is tried again by the first line after a 2-minute cooldown, not before; the topic then gets the recap', async () => {
    let skew = 0;
    const n = await bootTeam(undefined, { now: () => Date.now() + skew });
    n.api.answers.createForumTopic = () => n.api.err(502, 'Bad Gateway');
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(n.lines.filter((l) => /^\[http\] http:contoso-[0-9a-f]{16}: no team topic — Telegram did not make the topic \(Bad Gateway\)$/.test(l))).toHaveLength(1), { timeout: 5000 });
    n.api.answers.createForumTopic = (b) => ({ status: 200, json: async () => ({ ok: true, result: { message_thread_id: 77, name: b.name } }) });
    skew = 110_000;
    await n.post({ session: a.session, text: 'dos' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session), 2)).toBe(true), { timeout: 5000 });
    await settle();
    expect(n.api.of('createForumTopic')).toHaveLength(1);
    skew = 125_000;
    await n.post({ session: a.session, text: 'tres' });
    await vi.waitFor(() => expect(n.api.of('createForumTopic')).toHaveLength(2), { timeout: 5000 });
    const slug = n.slugOf(n.turns[0]);
    expect(n.lines.filter((l) => l.endsWith(`http:${slug}: no team topic yet — trying again`))).toHaveLength(1);
    await vi.waitFor(async () => expect(await Room.forChat('http', slug).members()).toEqual([{ kind: 'tg-group', id: TOPIC, state: 'active', replies: true, title: 'Equipo Contoso' }]), { timeout: 5000 });
    await vi.waitFor(() => {
      const recap = n.inThread()[0]?.text.split('\n') ?? [];
      expect(recap[0]).toMatch(/^\(conversación iniciada antes: [56] mensajes\)$/);
      expect(recap).toContain('visitor: dos');
      expect(recap).toContain('visitor: tres');
    }, { timeout: 5000 });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session), 3)).toBe(true), { timeout: 5000 });
    n.app.stop();
  });

  it('a group without Topics: no topic, the reason logged, the visitor still answered', async () => {
    const n = await bootTeam();
    n.api.answers.createForumTopic = () => n.api.err(400, 'Bad Request: the chat is not a forum');
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    expect(n.lines.some((l) => /^\[http\] http:contoso-[0-9a-f]{16}: no team topic — .*Topics/.test(l))).toBe(true);
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

describe('a signed visitor (identity)', () => {
  const client = (identity = 'required') => ({ team_group: GROUP, team_name: 'Equipo Contoso', identity, topic_title: CONTOSO_TITLE });

  // The folder of a signed visitor is its rendered chat_title (no client prefix), through contacts.resolve like any limb's chat name.
  const JD = { abrin: 'abc', user_type: 'P', short_name: 'Jane Doe', username: 'jdoe' };
  const TITLE = '{abrin}-{user_type}-{username}-{short_name}';
  const dirOf = (cwd) => cwd.split(/[\\/]/).at(-1);

  it('folder: a signed visitor\'s folder is its rendered chat_title; the user card and the team topic land in that folder', async () => {
    const n = await bootTeam({ ...client(), chat_title: TITLE });
    const identity = signed(JD);
    const a = await n.post({ text: 'hola', identity });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, identity))).toBe(true), { timeout: 5000 });
    expect(dirOf(n.turns[0].cwd)).toBe('abc-P-jdoe-Jane Doe');
    const card = JSON.parse(await fs.readFile(join(n.turns[0].cwd, 'desktop', 'user.json'), 'utf8'));
    expect(card).toMatchObject({ abrin: 'abc', username: 'jdoe', title: 'abc-P-jdoe-Jane Doe' });
    await vi.waitFor(() => expect(n.api.of('createForumTopic')).toHaveLength(1), { timeout: 5000 });
    await vi.waitFor(async () => expect(await fs.readFile(ROOMS_FILE, 'utf8')).toContain('abc-P-jdoe-Jane Doe'), { timeout: 5000 });
    expect(Object.values(n.state().contacts.http).map((e) => e.slug)).toEqual(['abc-P-jdoe-Jane Doe']);
    expect(Object.keys(n.state().contacts.http)[0]).toMatch(/^http:contoso-[0-9a-f]{16}$/);   // the chat id is unchanged
    n.app.stop();
  });

  it('folder: an unsigned visitor keeps <client>-<key>', async () => {
    const n = await bootTeam({ ...client('optional'), chat_title: TITLE });
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    expect(dirOf(n.turns[0].cwd)).toMatch(/^contoso-[0-9a-f]{16}$/);
    n.app.stop();
  });

  it('folder: a changed claim renames the folder and keeps the thread', async () => {
    const n = await bootTeam({ ...client(), chat_title: TITLE }, { realFs: true });
    const a = await n.post({ text: 'uno', identity: signed(JD) });
    await vi.waitFor(() => expect(n.turns).toHaveLength(1), { timeout: 5000 });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, signed(JD)))).toBe(true), { timeout: 5000 });
    const b = await n.post({ session: a.session, text: 'dos', identity: signed({ ...JD, short_name: 'Jane Roe' }) });
    expect(b.session).toBe(a.session);
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    expect(dirOf(n.turns[0].cwd)).toBe('abc-P-jdoe-Jane Doe');
    expect(dirOf(n.turns[1].cwd)).toBe('abc-P-jdoe-Jane Roe');
    expect(n.turns[1].session).toBe(n.turns[0].session);
    await expect(fs.access(n.turns[0].cwd)).rejects.toThrow();
    await fs.access(join(n.turns[1].cwd, 'desktop', 'user.json'));
    n.app.stop();
  });

  // The card's files belong to the folder: a fresh line writes them only where missing; a later claim change refreshes only card_claims keys.
  const cardOf = (cwd) => ({ json: join(cwd, 'desktop', 'user.json'), md: join(cwd, 'desktop', 'user.md') });
  const firstLine = async (n, claims = JD) => {
    const a = await n.post({ text: 'uno', identity: signed(claims) });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, signed(claims)))).toBe(true), { timeout: 5000 });
    return a;
  };
  const chatIdOf = (n, cwd) => Object.keys(n.state().contacts.http).find((k) => n.state().contacts.http[k].slug === dirOf(cwd));

  it('card: entry present, folder deleted: the user card is written again', async () => {
    const n = await bootTeam({ ...client(), chat_title: TITLE }, { realFs: true });
    const a = await firstLine(n);
    const cwd = n.turns[0].cwd;
    await fs.rm(cwd, { recursive: true, force: true });
    await n.post({ session: a.session, text: 'dos', identity: signed(JD) });
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    expect(JSON.parse(await fs.readFile(cardOf(cwd).json, 'utf8'))).toMatchObject({ username: 'jdoe' });
    expect(await fs.readFile(cardOf(cwd).md, 'utf8')).toMatch(/^Verified by the site: Jane Doe/);
    n.app.stop();
  });

  it('card: a surviving folder whose entry is gone keeps an operator-edited user.json and user.md', async () => {
    const n = await bootTeam({ ...client(), chat_title: TITLE }, { realFs: true });
    const a = await firstLine(n);
    const cwd = n.turns[0].cwd, { json, md } = cardOf(cwd);
    await fs.writeFile(json, '{"abrin":"abc","nota":"del operador"}\n');
    await fs.writeFile(md, 'nota del operador\n');
    delete n.state().contacts.http[chatIdOf(n, cwd)];
    await n.post({ session: a.session, text: 'dos', identity: signed(JD) });
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    expect(await fs.readFile(json, 'utf8')).toBe('{"abrin":"abc","nota":"del operador"}\n');
    expect(await fs.readFile(md, 'utf8')).toBe('nota del operador\n');
    n.app.stop();
  });

  it('card: a claim change refreshes only the card_claims keys; operator fields and user.md stay', async () => {
    const n = await bootTeam({ ...client(), chat_title: TITLE, card_claims: ['cuentas'] }, { realFs: true });
    const a = await firstLine(n, { ...JD, cuentas: [1] });
    const { json, md } = cardOf(n.turns[0].cwd);
    const card = JSON.parse(await fs.readFile(json, 'utf8'));
    await fs.writeFile(json, JSON.stringify({ ...card, nota: 'del operador' }));
    await fs.writeFile(md, 'nota del operador\n');
    await n.post({ session: a.session, text: 'dos', identity: signed({ ...JD, cuentas: [1, 2] }) });
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    expect(JSON.parse(await fs.readFile(json, 'utf8'))).toMatchObject({ nota: 'del operador', cuentas: [1, 2], username: 'jdoe' });
    expect(await fs.readFile(md, 'utf8')).toBe('nota del operador\n');
    n.app.stop();
  });

  it('seed: a rename keeps the entry and the folder, so it is not seeded again', async () => {
    const seed = join(_HOME, 'seeds', 'contoso');
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(join(seed, 'notas.md'), 'n');
    try {
      const n = await bootTeam({ ...client(), chat_title: TITLE, seed: 'seeds/contoso' }, { realFs: true });
      const a = await firstLine(n);
      await fs.rm(join(n.turns[0].cwd, 'notas.md'));
      n.lines.length = 0;
      await n.post({ session: a.session, text: 'dos', identity: signed({ ...JD, short_name: 'Jane Roe' }) });
      await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
      expect(dirOf(n.turns[1].cwd)).toBe('abc-P-jdoe-Jane Roe');
      expect(existsSync(join(n.turns[1].cwd, 'notas.md'))).toBe(false);
      expect(n.lines.some((l) => /its desk is seeded/.test(l))).toBe(false);
      n.app.stop();
    } finally { await fs.rm(join(_HOME, 'seeds'), { recursive: true, force: true }); }
  });

  const who2 = { ...JD, username: 'jroe', short_name: 'Jim Roe' };
  const raw = (n, body) => fetch(`${n.url}messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('folder: by default (unique_title off) two chats with one title never share a folder: the second takes its chat id tail', async () => {
    const n = await bootTeam({ ...client(), chat_title: '{abrin}' });
    const a = await n.post({ text: 'uno', identity: signed(JD) });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, signed(JD)))).toBe(true), { timeout: 5000 });
    const b = await n.post({ text: 'dos', identity: signed(who2) });
    await vi.waitFor(async () => expect(answered(await n.messages(b.session, signed(who2)))).toBe(true), { timeout: 5000 });
    expect(a.session).not.toBe(b.session);
    const [d1, d2] = n.turns.map((t) => dirOf(t.cwd));
    expect(d1).toBe('abc');
    expect(d2).toMatch(/^abc-[0-9a-f]{6}$/);
    expect(n.lines.some((l) => l.includes('is refused'))).toBe(false);
    n.app.stop();
  });

  it('folder: unique_title refuses the second visitor with 409 title_taken (no holder in the body, holder in the log, nothing made); the first returns freely; other titles are fine', async () => {
    const n = await bootTeam({ ...client(), chat_title: '{abrin}', unique_title: true });
    const a = await n.post({ text: 'uno', identity: signed(JD) });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, signed(JD)))).toBe(true), { timeout: 5000 });
    const r = await raw(n, { text: 'dos', identity: signed(who2) });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'title_taken', message: 'this name is already in use here' });
    await settle();
    expect(n.lines.some((l) => l.includes('chatbox: chat_title "abc" is already http:contoso-') && l.includes("'s folder — the template must name a unique claim (e.g. {username}); this visitor is refused"))).toBe(true);
    expect(n.turns).toHaveLength(1);
    expect(Object.values(n.state().contacts.http).map((e) => e.slug)).toEqual(['abc']);
    const again = await n.post({ session: a.session, text: 'tres', identity: signed(JD) });   // the holder itself is never refused
    expect(again.session).toBe(a.session);
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    const c = await n.post({ text: 'cuatro', identity: signed({ ...JD, abrin: 'xyz' }) });
    await vi.waitFor(async () => expect(answered(await n.messages(c.session, signed({ ...JD, abrin: 'xyz' })))).toBe(true), { timeout: 5000 });
    expect(Object.values(n.state().contacts.http).map((e) => e.slug).sort()).toEqual(['abc', 'xyz']);
    n.app.stop();
  });

  it('folder: a long chat_title is cut at 255 characters', async () => {
    const n = await bootTeam({ ...client(), chat_title: '{short_name} {short_name} {short_name} {short_name}' });   // each claim is cut at 80 first
    const who = { ...JD, short_name: 'N'.repeat(400) };
    const a = await n.post({ text: 'uno', identity: signed(who) });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, signed(who)))).toBe(true), { timeout: 5000 });
    expect(dirOf(n.turns[0].cwd).length).toBeLessThanOrEqual(255);
    expect(dirOf(n.turns[0].cwd).length).toBeGreaterThan(200);
    n.app.stop();
  });

  it('a valid token: the topic is "<abrin> <user_type> <short_name> (<username>)", and the user is on the desk (desktop/user.json, desktop/user.md), never the token', async () => {
    const n = await bootTeam(client());
    const identity = signed({ ...JP, user_id: 4711 });
    const a = await n.post({ text: 'hola', identity });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, identity))).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(n.api.of('createForumTopic').map((c) => c.body.name)).toEqual(['IEV P Juan Pérez (jperez)']), { timeout: 5000 });
    const dir = n.turns[0].cwd;
    const usuario = JSON.parse(await fs.readFile(join(dir, 'desktop', 'user.json'), 'utf8'));
    expect(usuario).toMatchObject({ abrin: 'IEV', user_type: 'P', short_name: 'Juan Pérez', username: 'jperez', user_id: '4711' });
    expect(Object.keys(usuario)).toEqual(['abrin', 'user_type', 'short_name', 'username', 'user_id', 'title', 'subtitle', 'verified_at']);
    expect(usuario).toMatchObject({ title: 'IEV · Juan Pérez · jperez', subtitle: 'P' });
    const md = await fs.readFile(join(dir, 'desktop', 'user.md'), 'utf8');
    expect(md.trim().split('\n')).toHaveLength(1);
    expect(md).toBe('Verified by the site: Juan Pérez (jperez), type P, school IEV, id 4711.\n');
    for (const text of [JSON.stringify(usuario), md]) expect(text).not.toContain(identity.split('.')[1]);
    n.app.stop();
  });

  it('a signed conversation with a seed: the seed lands at the folder root as before, the user files under desktop/', async () => {
    const seedDir = join(_HOME, 'seeds', 'contoso');
    await fs.mkdir(seedDir, { recursive: true });
    await fs.writeFile(join(seedDir, 'identidad.md'), 'v1');
    try {
      const n = await bootTeam({ ...client(), seed: 'seeds/contoso' });
      await n.post({ text: 'hola', identity: signed(JP) });
      await vi.waitFor(() => expect(n.turns).toHaveLength(1), { timeout: 5000 });
      const dir = n.turns[0].cwd;
      expect(await fs.readFile(join(dir, 'identidad.md'), 'utf8')).toBe('v1');
      expect(existsSync(join(dir, 'desktop', 'user.json'))).toBe(true);
      expect(existsSync(join(dir, 'desktop', 'user.md'))).toBe(true);
      n.app.stop();
    } finally { await fs.rm(join(_HOME, 'seeds'), { recursive: true, force: true }); }
  });

  it('card_claims: the named claims ride on the card (user.json, a line each in user.md); other claims and exp stay off', async () => {
    const n = await bootTeam({ ...client(), card_claims: ['cuentas', 'exp'] });
    const cuentas = [{ abrin: 'IEV', usuario: 'jperez', tipo: 'P' }, { abrin: 'IEV', usuario: 'jperezr', tipo: 'R' }];
    await n.post({ text: 'hola', identity: signed({ ...JP, cuentas, otra: 'x' }) });
    await vi.waitFor(() => expect(n.turns).toHaveLength(1), { timeout: 5000 });
    const dir = n.turns[0].cwd;
    const card = JSON.parse(await fs.readFile(join(dir, 'desktop', 'user.json'), 'utf8'));
    expect(card.cuentas).toEqual(cuentas);
    expect(card).not.toHaveProperty('otra');
    expect(card).not.toHaveProperty('exp');
    expect(await fs.readFile(join(dir, 'desktop', 'user.md'), 'utf8')).toBe(`Verified by the site: Juan Pérez (jperez), type P, school IEV.\ncuentas: ${JSON.stringify(cuentas)}\n`);
    n.app.stop();
  });

  it('card_claims: a later line bringing other values rewrites the card in the same conversation; the same values leave it alone', async () => {
    const n = await bootTeam({ ...client(), card_claims: ['cuentas'] });
    const uno = [{ abrin: 'IEV', usuario: 'jperez', tipo: 'P' }], dos = [...uno, { abrin: 'IEV', usuario: 'jperezr', tipo: 'R' }];
    const a = await n.post({ text: 'hola', identity: signed({ ...JP, cuentas: uno }) });
    await vi.waitFor(() => expect(n.turns).toHaveLength(1), { timeout: 5000 });
    const file = join(n.turns[0].cwd, 'desktop', 'user.json');
    const b = await n.post({ session: a.session, text: 'agregué otra cuenta', identity: signed({ ...JP, cuentas: dos }) });
    expect(b.session).toBe(a.session);
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    expect(n.turns[1].cwd).toBe(n.turns[0].cwd);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).cuentas).toEqual(dos);
    const antes = await fs.readFile(file, 'utf8');
    await n.post({ session: a.session, text: 'sigo', identity: signed({ ...JP, cuentas: dos }) });
    await vi.waitFor(() => expect(n.turns).toHaveLength(3), { timeout: 5000 });
    expect(await fs.readFile(file, 'utf8')).toBe(antes);
    n.app.stop();
  });

  it('no card_claims: a later line with new claims leaves the card as it was', async () => {
    const n = await bootTeam(client());
    const a = await n.post({ text: 'hola', identity: signed({ ...JP, cuentas: [1] }) });
    await vi.waitFor(() => expect(n.turns).toHaveLength(1), { timeout: 5000 });
    const file = join(n.turns[0].cwd, 'desktop', 'user.json');
    const antes = await fs.readFile(file, 'utf8');
    expect(JSON.parse(antes)).not.toHaveProperty('cuentas');
    await n.post({ session: a.session, text: 'otra', identity: signed({ ...JP, cuentas: [1, 2] }) });
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    expect(await fs.readFile(file, 'utf8')).toBe(antes);
    n.app.stop();
  });

  it("another user's token on the same session: a new session, folder and topic; the first user keeps theirs", async () => {
    const n = await bootTeam(client());
    const a = await n.post({ text: 'hola', identity: signed(JP) });
    await vi.waitFor(() => expect(n.turns).toHaveLength(1), { timeout: 5000 });
    const b = await n.post({ session: a.session, text: 'soy otra', identity: signed(ML) });
    expect(b.session).not.toBe(a.session);
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    expect(n.turns[1].cwd).not.toBe(n.turns[0].cwd);
    expect(JSON.parse(await fs.readFile(join(n.turns[1].cwd, 'desktop', 'user.json'), 'utf8')).username).toBe('mlopez');
    await vi.waitFor(() => expect(n.api.of('createForumTopic').map((c) => c.body.name)).toEqual(['IEV P Juan Pérez (jperez)', 'IEV R María López (mlopez)']), { timeout: 5000 });
    const a2 = await n.post({ session: a.session, text: 'sigo', identity: signed(JP) });
    expect(a2.session).toBe(a.session);
    await vi.waitFor(() => expect(n.turns).toHaveLength(3), { timeout: 5000 });
    expect(n.turns[2].cwd).toBe(n.turns[0].cwd);
    expect(n.api.of('createForumTopic')).toHaveLength(2);
    await vi.waitFor(async () => expect(answered(await n.messages(b.session, signed(ML)))).toBe(true), { timeout: 5000 });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, signed(JP)), 2)).toBe(true), { timeout: 5000 });
    n.app.stop();
  });

  it('optional, unsigned: the visitor is answered, the topic has the default title, no user files', async () => {
    const n = await bootTeam(client('optional'));
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    const slug = n.slugOf(n.turns[0]);
    await vi.waitFor(() => expect(n.api.of('createForumTopic').map((c) => c.body.name)).toEqual([`Contoso · ${slug.slice('contoso-'.length, 'contoso-'.length + 6)}`]), { timeout: 5000 });
    await expect(fs.access(join(n.turns[0].cwd, 'desktop', 'user.json'))).rejects.toThrow();
    await expect(fs.access(join(n.turns[0].cwd, 'desktop', 'user.md'))).rejects.toThrow();
    n.app.stop();
  });

  it('required, unsigned: 401 with the Spanish line, no turn, no topic', async () => {
    const n = await bootTeam(client());
    const r = await fetch(`${n.url}messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hola' }) });
    expect(r.status).toBe(401);
    expect((await r.json()).message).toBe(HTTP_STRINGS.identity);
    await settle();
    expect(n.turns).toEqual([]);
    expect(n.api.of('createForumTopic')).toEqual([]);
    n.app.stop();
  });

  it('generic claims: topic_title names any claim; the key (user_id) binds the session', async () => {
    const n = await bootTeam({ ...client({ mode: 'required', required: ['user_id'], key: ['user_id'] }), topic_title: '{org} #{user_id}' });
    const identity = signed({ user_id: 7, org: 'Acme' });
    const a = await n.post({ text: 'hola', identity });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, identity))).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(n.api.of('createForumTopic').map((c) => c.body.name)).toEqual(['Acme #7']), { timeout: 5000 });
    n.app.stop();
  });

  it('conversation_by: identity — two sessions of one user are one folder, one thread and one topic', async () => {
    const n = await bootTeam({ ...client(), conversation_by: 'identity' });
    const a = await n.post({ text: 'desde el portátil', identity: signed(JP) });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, signed(JP)))).toBe(true), { timeout: 5000 });
    const b = await n.post({ text: 'desde el móvil', identity: signed(JP) });
    expect(b.session).not.toBe(a.session);
    await vi.waitFor(() => expect(n.turns).toHaveLength(2), { timeout: 5000 });
    expect(n.turns[1].cwd).toBe(n.turns[0].cwd);
    expect(n.turns[1].session).toBe(n.turns[0].session);
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, signed(JP)), 2)).toBe(true), { timeout: 5000 });
    await settle();
    expect(n.api.of('createForumTopic')).toHaveLength(1);
    n.app.stop();
  });

  // init: prime — the opening phrase (the widget's prime_text) is the visitor's first line, in mention mode (a team_group)
  // and in mode on (none): one turn, answered and posted like any line. No phrase: nothing is sent.
  for (const [label, team] of [['mention (team_group)', { team_group: GROUP, team_name: 'Equipo Contoso' }], ['on (no team_group)', {}]]) {
    it(`init: prime, ${label}: the opening phrase is ONE turn, the visitor's line on the panel and its answer posts; no notice; a reload adds no turn`, async () => {
      const n = await bootTeam({ ...team, identity: 'required', init: 'prime' });
      const identity = signed(JP);
      const i = await n.post({ kind: 'init', identity, prime_text: 'revisa mis notas' });
      await vi.waitFor(() => expect(n.turns).toHaveLength(1), { timeout: 5000 });
      expect(n.turns[0].cwd).toMatch(/conversations[\\/]http[\\/]IEV · Juan Pérez · jperez$/);   // the folder: the visitor's chat_title
      expect(n.turns[0].m).toContain('revisa mis notas');
      expect(n.turns[0].m).not.toMatch(/opened the chatbox|nothing to answer yet/);
      await vi.waitFor(async () => expect((await n.messages(i.session, identity)).filter((m) => m.from === 'being' && m.done)).toHaveLength(1), { timeout: 5000 });
      const all = await n.messages(i.session, identity);
      expect(all.find((m) => m.from === 'visitor')).toMatchObject({ text: 'revisa mis notas' });
      expect(all.find((m) => m.from === 'being').text).toContain('revisa mis notas');
      expect((await n.post({ kind: 'init', session: i.session, identity, prime_text: 'revisa mis notas' })).session).toBe(i.session);
      await settle();
      await settle();
      expect(n.turns).toHaveLength(1);
      expect(n.api.of('createForumTopic')).toHaveLength(team.team_group ? 1 : 0);   // a line seats the topic, as any line
      n.app.stop();
    });

    it(`init: prime, ${label}: no phrase, no turn: nothing reaches the being, the panel or the team topic`, async () => {
      const n = await bootTeam({ ...team, identity: 'required', init: 'prime' });
      const identity = signed(JP);
      const i = await n.post({ kind: 'init', identity });
      await settle();
      await settle();
      expect(n.turns).toEqual([]);
      expect(await n.messages(i.session, identity)).toEqual([]);
      expect(n.api.of('createForumTopic')).toEqual([]);
      expect(n.inThread()).toEqual([]);
      n.app.stop();
    });

    it(`regression, ${label}: a visitor's real line still opens its ⏳ bubble while the being works, and the answer posts`, async () => {
      const n = await bootTeam({ ...team, identity: 'required', init: 'prime' });
      const identity = signed(JP);
      const i = await n.post({ kind: 'init', identity });
      let release;
      hold.p = new Promise((r) => { release = r; });
      try {
        await n.post({ session: i.session, text: 'ESPERA hola', identity });
        await vi.waitFor(async () => expect((await n.messages(i.session, identity)).filter((m) => m.from === 'being' && !m.done)).toHaveLength(1), { timeout: 5000 });
      } finally { release(); hold.p = null; }
      await vi.waitFor(async () => expect(answered(await n.messages(i.session, identity))).toBe(true), { timeout: 5000 });
      n.app.stop();
    });
  }

  it('init: one transcript line with the claims, no turn and no topic; a repeated init adds nothing; the first line is answered in that conversation and seats the topic', async () => {
    const n = await bootTeam({ ...client(), init: true });
    const identity = signed({ ...JP, user_id: 4711 });
    const i = await n.post({ kind: 'init', identity });
    expect(i.session).toEqual(expect.any(String));
    const folders = () => [...n.io.files.keys()].filter((f) => /[\\/]conversations[\\/]http[\\/][^\\/]+[\\/]transcript\.md$/.test(f));
    await vi.waitFor(() => expect(folders()).toHaveLength(1), { timeout: 5000 });
    const slug = folders()[0].split(/[\\/]/).at(-2);
    await vi.waitFor(() => expect(n.transcript(slug)).toContain('(opened the chatbox, signed in as {"abrin":"IEV","user_type":"P","short_name":"Juan Pérez","username":"jperez","user_id":4711})'), { timeout: 5000 });
    expect((await n.post({ kind: 'init', session: i.session, identity })).session).toBe(i.session);
    await settle();
    expect(n.turns).toEqual([]);
    expect(n.api.of('createForumTopic')).toEqual([]);
    expect(folders()).toHaveLength(1);
    expect(n.transcript(slug).split('opened the chatbox')).toHaveLength(2);
    const a = await n.post({ session: i.session, text: 'hola', identity });
    expect(a.session).toBe(i.session);
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, identity))).toBe(true), { timeout: 5000 });
    expect(n.turns).toHaveLength(1);
    expect(n.slugOf(n.turns[0])).toBe(slug);
    await vi.waitFor(() => expect(n.api.of('createForumTopic').map((c) => c.body.name)).toEqual(['IEV P Juan Pérez (jperez)']), { timeout: 5000 });
    n.app.stop();
  });

  it("a long name: the topic's title is cut at Telegram's 128", async () => {
    const n = await bootTeam(client());
    const identity = signed({ ...JP, short_name: 'Nombre '.repeat(30), username: 'u'.repeat(100) });
    const a = await n.post({ text: 'hola', identity });
    await vi.waitFor(() => expect(n.api.of('createForumTopic')).toHaveLength(1), { timeout: 5000 });
    const name = n.api.of('createForumTopic')[0].body.name;
    expect(name).toHaveLength(128);
    expect(name).toMatch(/^IEV P Nombre Nombre .*…$/);
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, identity))).toBe(true), { timeout: 5000 });
    n.app.stop();
  });
});

// before_line (per chatbox): a command run before each visitor line, awaited; nonzero, a spawn error or the timeout
// blocks the line (recorded only), and the being says fail_text. A tiny node script stands in for the command.
describe('a chatbox with before_line', () => {
  const FAIL = 'Sorry, I cannot read right now.';
  const dirs = [];
  afterAll(async () => { for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); });
  // mode: the script's behaviour — ok | fail (stderr + exit 1) | sleep (never finishes by itself)
  async function hooked(mode, over = {}) {
    const dir = await fs.mkdtemp(join(process.env.TMPDIR || '/tmp', 'egpt-before-line-'));
    dirs.push(dir);
    const out = join(dir, 'seen.json');
    const script = join(dir, 'hook.mjs');
    await fs.writeFile(script, `import { writeFileSync, readFileSync } from 'node:fs';
const [out, mode, folder] = process.argv.slice(2);
const seen = (() => { try { return JSON.parse(readFileSync(out, 'utf8')); } catch { return []; } })();
seen.push({ pid: process.pid, folder, stdin: readFileSync(0, 'utf8') });
writeFileSync(out, JSON.stringify(seen));
if (mode === 'fail') { console.error('no access: ' + 'x'.repeat(300)); process.exit(1); }
if (mode === 'sleep') setInterval(() => {}, 1000);
`);
    const n = await bootTeam({ identity: 'required', init: 'prime', team_group: GROUP, team_name: 'Equipo Contoso', before_line: { command: [process.execPath, script, out, mode, '{folder}'], fail_text: FAIL, ...over } });
    const seen = async () => { try { return JSON.parse(await fs.readFile(out, 'utf8')); } catch { return []; } };
    return { n, seen };
  }
  const folderOf = (n) => n.turns[0]?.cwd;

  it('exit 0: the line is dispatched as today; the command got {folder} filled and stdin with folder, chat_id, client and claims', async () => {
    const { n, seen } = await hooked('ok');
    const identity = signed(JP);
    const a = await n.post({ text: 'hola', identity });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session, identity))).toBe(true), { timeout: 5000 });
    const [one] = await seen();
    expect(one.folder).toBe(folderOf(n));
    const stdin = JSON.parse(one.stdin);
    expect(stdin).toMatchObject({ folder: folderOf(n), client: 'contoso', claims: expect.objectContaining(JP) });
    expect(stdin.chat_id).toMatch(/^http:contoso-/);
    expect(Object.keys(stdin).sort()).toEqual(['chat_id', 'claims', 'client', 'folder']);
    expect(n.lines.join('\n')).not.toMatch(/before_line/);
    n.app.stop();
  });

  it('an unsigned visitor: claims is null on stdin', async () => {
    const n = await bootTeam({ identity: 'optional', before_line: { command: [process.execPath, '-e', "process.stdin.pipe(require('fs').createWriteStream(process.argv[1]))", join(_HOME, 'seen-unsigned.json')] } });
    await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(join(_HOME, 'seen-unsigned.json'), 'utf8'))).toMatchObject({ claims: null, client: 'contoso' }), { timeout: 5000 });
    n.app.stop();
  });

  it('exit 1: no dispatch; the visitor line is recorded (transcript, panel, topic); then fail_text is said as the being; one log line, no claims', async () => {
    const { n } = await hooked('fail');
    const identity = signed(JP);
    const a = await n.post({ text: 'abre mis notas', identity });
    expect(a.message).toMatchObject({ from: 'visitor', text: 'abre mis notas' });
    await vi.waitFor(async () => expect((await n.messages(a.session, identity)).filter((m) => m.from === 'being' && m.text.includes(FAIL))).toHaveLength(1), { timeout: 5000 });
    await settle();
    expect(n.turns).toEqual([]);
    const all = await n.messages(a.session, identity);
    expect(all.map((m) => m.from)).toEqual(['visitor', 'being']);
    const slug = [...n.io.files.keys()].find((f) => /transcript\.md$/.test(f)).split(/[\\/]/).at(-2);
    const t = n.transcript(slug);
    expect(t.indexOf('abre mis notas')).toBeGreaterThan(-1);
    expect(t.indexOf(FAIL)).toBeGreaterThan(t.indexOf('abre mis notas'));
    await vi.waitFor(() => expect(n.inThread().map((m) => m.text).slice(-2)).toEqual([expect.stringMatching(/visitor: abre mis notas$/), expect.stringContaining(FAIL)]), { timeout: 5000 });
    const mine = n.lines.filter((l) => /before the line — before_line: /.test(l));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('before_line: exit 1: no access: ');
    expect(mine[0].split('no access: ')[1].length).toBeLessThanOrEqual(200);
    expect(n.lines.join('\n')).not.toContain('jperez');
    n.app.stop();
  });

  it('timeout: the same as exit 1, and the process is killed', async () => {
    const { n, seen } = await hooked('sleep', { timeout_ms: 400 });
    const identity = signed(JP);
    const a = await n.post({ text: 'hola', identity });
    expect(a.message).toMatchObject({ from: 'visitor' });
    await vi.waitFor(async () => expect((await n.messages(a.session, identity)).filter((m) => m.text?.includes(FAIL))).toHaveLength(1), { timeout: 5000 });
    expect(n.turns).toEqual([]);
    expect(n.lines.join('\n')).toMatch(/before the line — before_line: timeout/);
    const [one] = await seen();
    expect(() => process.kill(one.pid, 0)).toThrow();
    n.app.stop();
  });

  it('a command that cannot start: the same as exit 1', async () => {
    const n = await bootTeam({ identity: 'required', team_group: GROUP, before_line: { command: '/nonexistent/acme-refresh', fail_text: FAIL } });
    const identity = signed(JP);
    const a = await n.post({ text: 'hola', identity });
    await vi.waitFor(async () => expect((await n.messages(a.session, identity)).filter((m) => m.text?.includes(FAIL))).toHaveLength(1), { timeout: 5000 });
    expect(n.turns).toEqual([]);
    n.app.stop();
  });

  it('init: prime: the opening phrase runs the command; a bare init (init: true, or no phrase) does not', async () => {
    const { n, seen } = await hooked('ok');
    const identity = signed(JP);
    const bare = await n.post({ kind: 'init', identity });
    await settle();
    expect(await seen()).toEqual([]);
    expect(n.turns).toEqual([]);
    await n.post({ kind: 'init', session: bare.session, identity, prime_text: 'revisa mis notas' });
    await vi.waitFor(() => expect(n.turns).toHaveLength(1), { timeout: 5000 });
    expect(await seen()).toHaveLength(1);
    n.app.stop();
    const t = await bootTeam({ identity: 'required', init: true, before_line: { command: '/nonexistent/acme-refresh' } });
    await t.post({ kind: 'init', identity });
    await settle();
    expect(t.lines.join('\n')).not.toMatch(/before_line/);
    t.app.stop();
  });

  it('the opening phrase blocked: recorded, not dispatched, fail_text said', async () => {
    const { n } = await hooked('fail');
    const identity = signed(JP);
    const i = await n.post({ kind: 'init', identity, prime_text: 'revisa mis notas' });
    await vi.waitFor(async () => expect((await n.messages(i.session, identity)).map((m) => m.text.replace(/^🦉 /, ''))).toEqual(['revisa mis notas', FAIL]), { timeout: 5000 });
    expect(n.turns).toEqual([]);
    n.app.stop();
  });

  it('unset: a line is dispatched as today and nothing about before_line is logged', async () => {
    const n = await bootTeam();
    const a = await n.post({ text: 'hola' });
    await vi.waitFor(async () => expect(answered(await n.messages(a.session))).toBe(true), { timeout: 5000 });
    expect(n.lines.join('\n')).not.toMatch(/before_line/);
    n.app.stop();
  });
});
