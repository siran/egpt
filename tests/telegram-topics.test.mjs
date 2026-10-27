// telegram-topics.test.mjs — /split on Telegram makes a forum TOPIC (operator 2026-10-25; /join is retired).
// A topic is a chat of its own, tg:<chat>/<thread>; the main chat (General) stays tg:<chat>. The limb
// runs over a fake Bot API (no network); the boot tests drive a whole node through it.
import { describe, it, expect, vi, afterAll } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-telegram-topics-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { join, basename } from 'node:path';
import { startTelegramBridge, TOPICS_NEEDED, topicGroupOf } from '../src/bridges/telegram.mjs';
import { boot, chatIdForEntity } from '../src/spine/boot.mjs';
import { emptyState, ensureContact, recordThread, aliasContact, patchContact, patchBeing, moveChatId, conversationPathOf } from '../src/conversations-state.mjs';
import { Room } from '../src/room-core.mjs';
import { sanitizeSlug } from '../src/sanitize.mjs';

afterAll(async () => { try { await fs.rm(HOME, { recursive: true, force: true }); } catch {} });

const TOKEN = '123456:FAKE-topics-token';
const ME = { id: 99, is_bot: true, username: 'edw_bot', can_read_all_group_messages: true };
const GROUP = -1001234;                       // a forum supergroup
const MAIN = `tg:${GROUP}`;
const TOPIC = `${MAIN}/77`;                   // the first topic the fake makes
const LINK = 'https://t.me/c/1234/77';

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
    sendDocument: (b) => ok({ message_id: nextId++, chat: { id: Number(b.chat_id) } }),
    createForumTopic: (b) => ok({ message_thread_id: nextThread++, name: b.name, icon_color: 7322096 }),
    closeForumTopic: () => ok(true),
  };
  // getFile names a path; the file URL answers with `files[path]`.
  const files = {};
  answers.getFile = (b) => ok({ file_id: b.file_id, file_path: Object.keys(files).find((p) => p.includes(b.file_id)) ?? `x/${b.file_id}` });
  const fetch = async (url, init) => {
    if (url.includes('/file/bot')) {
      const path = url.split(`/file/bot${TOKEN}/`)[1];
      if (!(path in files)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(files[path]).buffer };
    }
    const method = url.split('/').pop();
    const body = init.body instanceof FormData
      ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : { name: v.name }]))
      : JSON.parse(init.body);
    const call = { method, body };
    calls.push(call);
    if (method === 'getUpdates') {
      if (queue.length) return queue.shift();
      return new Promise((resolve, reject) => {
        parked = resolve;
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const res = answers[method](body);
    call.out = await res.json();
    return res;
  };
  const push = (r) => { if (parked) { const p = parked; parked = null; p(r); } else queue.push(r); };
  return {
    fetch, calls, answers, ok, err, files,
    updates: (...msgs) => push(ok(msgs.map((message) => ({ update_id: ++updateId, message })))),
    raw: (...ups) => push(ok(ups.map((u) => ({ update_id: ++updateId, ...u })))),
    of: (method) => calls.filter((c) => c.method === method),
  };
}

const now = () => Math.floor(Date.now() / 1000);
const CHAT = { id: GROUP, type: 'supergroup', title: 'EduWeb', is_forum: true };
const AN = { id: 42, is_bot: false, first_name: 'An', last_name: 'R' };
const DIEGO = { id: 77, is_bot: false, first_name: 'Diego' };
let mid = 300;
const inMain = (text, over = {}) => ({ message_id: ++mid, date: now(), chat: CHAT, from: AN, text, ...over });
// The topic's creation message: every message in a topic that quotes nothing else quotes it.
const root = (thread, name) => ({ message_id: thread, date: now(), chat: CHAT, from: ME, is_topic_message: true, message_thread_id: thread, forum_topic_created: { name, icon_color: 7322096 } });
const inTopic = (thread, text, over = {}, name = 'SI+EduWeb-mygroup') => ({ message_id: ++mid, date: now(), chat: CHAT, from: AN, text, is_topic_message: true, message_thread_id: thread, reply_to_message: root(thread, name), ...over });

const sends = (api) => api.of('sendMessage').map((c) => c.body);
const inGeneral = (b) => b.chat_id === String(GROUP) && b.message_thread_id == null;

function start(api, extra = {}) {
  const lines = [];
  const incoming = [];
  const bridge = startTelegramBridge({
    telegramToken: TOKEN, connection: 'main', fetch: api.fetch,
    isAllowedUser: (id, net) => net === 'telegram' && id === '42',
    wakeWords: ['ed'], nodeName: 'EDW',
    onIncoming: (body, from) => { incoming.push({ body, from }); },
    onLog: (m) => lines.push(m),
    ...extra,
  });
  return { bridge, lines, incoming };
}

describe('telegram limb — a side room is a forum topic', () => {
  it('createGroup makes a topic in the chat it is made from: tg:<chat>/<thread> and its link', async () => {
    const api = fakeApi();
    const { bridge } = start(api);
    await bridge.startupReady;
    const made = await bridge.createGroup({ title: 'SI+EduWeb-mygroup', participantIDs: [] }, { chatId: MAIN });
    expect(api.of('createForumTopic')[0].body).toEqual({ chat_id: String(GROUP), name: 'SI+EduWeb-mygroup' });
    expect(made).toEqual({ success: true, chatID: TOPIC, link: LINK });
    expect(bridge.getChatName(TOPIC)).toBe('SI+EduWeb-mygroup');
    // made from inside a topic: still a topic of the group
    expect((await bridge.createGroup({ title: 'otro' }, { chatId: TOPIC })).chatID).toBe(`${MAIN}/78`);
    expect(api.of('createForumTopic')[1].body.chat_id).toBe(String(GROUP));
    bridge.stop();
  });

  it('no Topics, or no right to make them: no room, and the reason says what is needed', async () => {
    const api = fakeApi();
    api.answers.createForumTopic = () => api.err(400, 'Bad Request: the chat is not a forum');
    const { bridge, lines } = start(api);
    await bridge.startupReady;
    expect(await bridge.createGroup({ title: 't' }, { chatId: MAIN })).toEqual({ success: false, reason: TOPICS_NEEDED });
    expect(TOPICS_NEEDED).toMatch(/Topics/);
    expect(TOPICS_NEEDED).toMatch(/Manage topics/);
    expect(lines.some((l) => /createForumTopic/.test(l) && /not a forum/.test(l))).toBe(true);
    bridge.stop();
  });

  it('a message in a topic is that topic\'s chat; quoting the topic\'s creation message is no reply', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    api.updates(inTopic(77, 'hola'));
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(incoming[0].from).toMatchObject({ chatId: TOPIC, chatName: 'SI+EduWeb-mygroup', chatType: 'group', replyToId: null, replyToBot: false });
    expect(topicGroupOf(TOPIC)).toBe(MAIN);
    bridge.stop();
  });

  it('a reply inside a topic is a reply; General stays the main chat', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    const quoted = { message_id: 400, date: now(), chat: CHAT, from: ME, text: 'dicho', is_topic_message: true, message_thread_id: 77 };
    api.updates(inTopic(77, 're', { reply_to_message: quoted }), inMain('general'));
    await vi.waitFor(() => expect(incoming).toHaveLength(2));
    const byBody = Object.fromEntries(incoming.map((i) => [i.body, i.from]));
    expect(byBody.re).toMatchObject({ chatId: TOPIC, replyToId: '400', replyToBot: true });
    expect(byBody.general).toMatchObject({ chatId: MAIN, chatName: 'EduWeb' });
    bridge.stop();
  });

  it('everything said into a topic carries its message_thread_id; the main chat carries none', async () => {
    const api = fakeApi();
    const { bridge } = start(api);
    await bridge.startupReady;
    await bridge.send('a', { chatId: TOPIC });
    await bridge.send('b', { chatId: MAIN });
    expect(sends(api).map((b) => [b.text, b.message_thread_id])).toEqual([['a', 77], ['b', undefined]]);
    const h = bridge.startStreamMessage('⏳', { chatId: TOPIC });
    h.update('x');
    await h.finish('listo');
    expect(sends(api)[2]).toMatchObject({ chat_id: String(GROUP), message_thread_id: 77 });
    expect(api.of('editMessageText').at(-1).body).toMatchObject({ chat_id: String(GROUP), text: 'listo' });
    const dir = join(HOME, 'media-out');
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, 'nota.txt');
    await fs.writeFile(file, 'x');
    expect((await bridge.sendMedia(TOPIC, file)).ok).toBe(true);
    expect(api.of('sendDocument')[0].body).toMatchObject({ chat_id: String(GROUP), message_thread_id: '77' });
    bridge.stop();
  });

  it('a reaction to a message in a topic is the topic\'s (a reaction names no topic)', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    const m = inTopic(77, 'hola');
    api.updates(m);
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    api.raw({ message_reaction: { chat: CHAT, message_id: m.message_id, user: DIEGO, date: now(), old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }] } });
    await vi.waitFor(() => expect(incoming).toHaveLength(2));
    expect(incoming[1].from).toMatchObject({ chatId: TOPIC, chatName: 'SI+EduWeb-mygroup', isReaction: true });
    bridge.stop();
  });

  it('/end: archiveChat closes the topic; a whole chat is never closed', async () => {
    const api = fakeApi();
    const { bridge } = start(api);
    await bridge.startupReady;
    expect(await bridge.archiveChat(TOPIC)).toBe(true);
    expect(api.of('closeForumTopic').map((c) => c.body)).toEqual([{ chat_id: String(GROUP), message_thread_id: 77 }]);
    expect(await bridge.archiveChat(MAIN)).toBe(false);
    expect(api.of('closeForumTopic')).toHaveLength(1);
    bridge.stop();
  });

  it('a plain (non-forum) group is unchanged: a reply thread id is not a topic', async () => {
    const api = fakeApi();
    const { bridge, incoming } = start(api);
    await bridge.startupReady;
    const PLAIN = { id: -1005555, type: 'supergroup', title: 'Plain' };
    api.updates({ message_id: 900, date: now(), chat: PLAIN, from: AN, text: 'r', message_thread_id: 850, reply_to_message: { message_id: 850, date: now(), chat: PLAIN, from: DIEGO, text: 'q' } });
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(incoming[0].from).toMatchObject({ chatId: 'tg:-1005555', chatName: 'Plain', replyToId: '850' });
    expect(topicGroupOf('tg:-1005555')).toBeNull();
    await bridge.send('x', { chatId: 'tg:-1005555', replyToMessageID: '850' });
    expect(sends(api)[0]).not.toHaveProperty('message_thread_id');
    bridge.stop();
  });
});

// ── a whole node: the shared /split + /send + /end path, through the limb ───────────────────────
const AGENTS = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'] } };
const TELEGRAM_ONLY = () => ({ node_name: 'EDW', user_name: 'John', limbs: { telegram: { main: { account: 'edw_bot' } } }, networks: { telegram: { allowed_users: [42] } }, agents: AGENTS });
const MIXED = () => ({ ...TELEGRAM_ONLY(), node_name: 'kg', limbs: { beeper: { main: { account: 'you@example.com', token: 'TOK-b' } }, telegram: { main: { account: 'edw_bot' } } } });

function seeded() {
  let s = ensureContact(emptyState(), 'telegram', MAIN, { pushedName: 'EduWeb', slugHint: 'EduWeb' }).state;
  s = recordThread(s, 'telegram', MAIN, 'eduweb-thread', '2026-10-01T00:00:00Z', 'egpt');
  s.contacts.telegram[MAIN].agents.egpt.mode = 'on';
  return s;
}
function fakeSession(opts) {
  return { sessionId: opts.sessionId ?? 'sess-1', async turn(m, onUpdate) { onUpdate?.(`↩ ${m}`); return { text: `↩ ${m}`, sessionId: this.sessionId }; }, close() {} };
}
// A Beeper transport with just what a WhatsApp /split asks of it.
function fakeBeeper() {
  const built = [];
  const start = async (opts) => {
    const spy = { opts, onIncoming: opts.onIncoming, sent: [], groups: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { messageId: 'b1', confirmedId: 'b1' }; },
      startStreamMessage() { return { delivered: true, update() {}, async finish() {}, confirmedId: null }; },
      async createGroup(o, where) { spy.groups.push({ opts: o, where }); return { success: true, chatID: '!wanew:beeper.local' }; },
      async chatRaw() { return { accountID: 'whatsapp', participants: { items: [] } }; },
      async editMessage() { return true; },
      wasSentByUs: () => false, isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

async function bootNode(config = TELEGRAM_ONLY(), { state = seeded(), beeper = null, makeSession = fakeSession } = {}) {
  await fs.mkdir(join(HOME, 'secrets'), { recursive: true });
  await fs.writeFile(join(HOME, 'secrets', 'telegram-main.token'), `${TOKEN}\n`);
  const api = fakeApi();
  let st = state;
  const lines = [];
  const app = await boot({
    readConfig: () => config,
    startTelegram: (opts) => startTelegramBridge({ ...opts, fetch: api.fetch }),
    ...(beeper ? { startBridge: beeper.start } : {}),
    makeSession,
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    ingest: false, tickMs: 0,
    log: { line: (s) => lines.push(s) },
  });
  await vi.waitFor(() => expect(api.of('getUpdates').length).toBeGreaterThan(0));
  return { app, api, lines, state: () => st };
}
// The node is done with a turn once the stream's last edit carries its text.
const answered = (api, text) => vi.waitFor(() => expect(api.of('editMessageText').some((c) => c.body.text.includes(text))).toBe(true));
const splitInto = async (n, name = 'mygroup') => {
  n.api.updates(inMain(`/e split ${name}`));
  await vi.waitFor(() => expect(n.state().contacts.telegram[TOPIC]?.parent_chat).toBe(MAIN));
};

describe('a Telegram node: /split makes a topic through the shared side-group path', () => {
  it('/e split mygroup: a topic forked from the chat (its own entry and thread, the chat\'s folder); the answer is its link; the opener goes into it', async () => {
    const n = await bootNode();
    await splitInto(n);
    expect(n.api.of('createForumTopic')[0].body).toEqual({ chat_id: String(GROUP), name: 'SI+EduWeb-mygroup' });
    const topic = n.state().contacts.telegram[TOPIC];
    expect(topic.aliasOf).toBeUndefined();
    expect(topic.slug).toBe(n.state().contacts.telegram[MAIN].slug);
    expect(topic.transcript).toBe('SI+EduWeb-mygroup');
    expect(topic.agents.egpt.threadId).toBeTruthy();
    expect(topic.agents.egpt.threadId).not.toBe('eduweb-thread');
    await vi.waitFor(() => expect(sends(n.api).some((b) => inGeneral(b) && b.text.includes(LINK))).toBe(true));
    await vi.waitFor(() => expect(sends(n.api).some((b) => b.message_thread_id === 77 && /Fork of EduWeb/.test(b.text))).toBe(true));
    n.app.stop();
  });

  it('a message in the topic is the fork\'s own conversation, and the reply goes back into the topic', async () => {
    const n = await bootNode();
    await splitInto(n);
    const forkThread = n.state().contacts.telegram[TOPIC].agents.egpt.threadId;
    n.api.updates(inTopic(77, '@e hola desde el tema'));
    await answered(n.api, 'hola desde el tema');
    const edit = n.api.of('editMessageText').find((c) => c.body.text.includes('hola desde el tema'));
    const placeholder = n.api.of('sendMessage').find((c) => c.out?.result?.message_id === edit.body.message_id);
    expect(placeholder.body).toMatchObject({ chat_id: String(GROUP), message_thread_id: 77 });
    expect(Object.keys(n.state().contacts.telegram).sort()).toEqual([MAIN, TOPIC]);
    expect(n.state().contacts.telegram[MAIN].agents.egpt.threadId).not.toBe(forkThread);
    n.app.stop();
  });

  // Live 2026-10-26 (EduWeb): the chat's allowed_users ['*'] did not reach its topics, so only the operator reached the being there.
  it('the topic inherits the chat\'s being settings (allowed_users, mode): a team member is answered there too', async () => {
    const state = seeded();
    state.contacts.telegram[MAIN].agents.egpt.allowed_users = ['*'];
    const n = await bootNode(TELEGRAM_ONLY(), { state });
    await splitInto(n);
    const egpt = n.state().contacts.telegram[TOPIC].agents.egpt;
    expect(egpt).toMatchObject({ mode: 'on', allowed_users: ['*'] });
    expect(egpt.threadId).not.toBe('eduweb-thread');
    n.api.updates(inTopic(77, '@e hola soy Diego', { from: DIEGO }));
    await answered(n.api, 'hola soy Diego');
    const room = Room.forChat('telegram', n.state().contacts.telegram[TOPIC].slug);
    await vi.waitFor(async () => expect(await fs.readFile(room.transcriptPathFor('SI+EduWeb-mygroup'), 'utf8')).toContain('hola soy Diego'));
    expect(await fs.readFile(room.transcriptPath, 'utf8').catch(() => '')).not.toContain('hola soy Diego');
    n.app.stop();
  });

  it('/e join is retired: it answers with /split and makes no topic', async () => {
    const n = await bootNode();
    n.api.updates(inMain('/e join mygroup'));
    await vi.waitFor(() => expect(sends(n.api).some((b) => inGeneral(b) && b.text.includes('/e split mygroup'))).toBe(true));
    expect(n.api.of('createForumTopic')).toHaveLength(0);
    expect(Object.keys(n.state().contacts.telegram)).toEqual([MAIN]);
    n.app.stop();
  });

  it('no Topics or no right: the user is told what is needed, and nothing is registered', async () => {
    const n = await bootNode();
    n.api.answers.createForumTopic = () => n.api.err(400, 'Bad Request: not enough rights to create a topic');
    n.api.updates(inMain('/e split mygroup'));
    await vi.waitFor(() => expect(sends(n.api).some((b) => inGeneral(b) && b.text.includes('Manage topics'))).toBe(true));
    expect(Object.keys(n.state().contacts.telegram)).toEqual([MAIN]);
    n.app.stop();
  });

  it('/e send, replying in the topic, lands in General', async () => {
    const n = await bootNode();
    await splitInto(n);
    const m = inTopic(77, '@e esto va al grupo');
    n.api.updates(m);
    await answered(n.api, 'esto va al grupo');
    n.api.updates(inTopic(77, '/e send', { reply_to_message: { ...m, reply_to_message: undefined } }));
    await vi.waitFor(() => expect(sends(n.api).some((b) => inGeneral(b) && b.text.includes('esto va al grupo'))).toBe(true));
    n.app.stop();
  });

  it('/e end in the topic closes it and drops its mapping', async () => {
    const n = await bootNode();
    await splitInto(n);
    n.api.updates(inTopic(77, '/e end'));
    await vi.waitFor(() => expect(n.api.of('closeForumTopic')).toHaveLength(1));
    expect(n.api.of('closeForumTopic')[0].body).toEqual({ chat_id: String(GROUP), message_thread_id: 77 });
    await vi.waitFor(() => expect(n.state().contacts.telegram[TOPIC]).toBeUndefined());
    n.app.stop();
  });
});

// ── a topic made outside /split (live 2026-10-27, EduWeb /585): topics always fork the chat ───────
const OUTSIDE = 'Agente de ventas · documentos';
const T585 = `${MAIN}/585`;
const tgDirOf = (slug) => join(HOME, 'conversations', 'telegram', slug);

describe('a Telegram node: a topic made outside /split is a fork of the chat', () => {
  it('its first message runs in the chat\'s folder, on its own transcript and a branched thread', async () => {
    const turns = [];
    const recording = (opts) => { turns.push({ cwd: opts.cwd, sessionId: opts.sessionId ?? null }); return fakeSession(opts); };
    const state = seeded();
    state.contacts.telegram[MAIN].agents.egpt.allowed_users = ['*'];
    const n = await bootNode(TELEGRAM_ONLY(), { state, makeSession: recording });
    n.api.updates(inTopic(585, '@e hola desde un tema nuevo', {}, OUTSIDE));
    await answered(n.api, 'hola desde un tema nuevo');
    const main = n.state().contacts.telegram[MAIN];
    const topic = n.state().contacts.telegram[T585];
    expect(topic).toMatchObject({ slug: main.slug, conversation_path: main.conversation_path, parent_chat: MAIN, transcript: sanitizeSlug(OUTSIDE), pushedName: OUTSIDE });
    expect(topic.agents.egpt).toMatchObject({ mode: 'on', allowed_users: ['*'] });
    expect(topic.agents.egpt.threadId).toBeTruthy();
    expect(topic.agents.egpt.threadId).not.toBe('eduweb-thread');
    expect(main.agents.egpt.threadId).toBe('eduweb-thread');
    expect(basename(turns[0].cwd)).toBe(main.slug);
    expect(turns[0].sessionId).toBe(topic.agents.egpt.threadId);
    const room = Room.forChat('telegram', main.slug);
    await vi.waitFor(async () => expect(await fs.readFile(room.transcriptPathFor(topic.transcript), 'utf8')).toContain('hola desde un tema nuevo'));
    expect(await fs.readFile(room.transcriptPath, 'utf8').catch(() => '')).not.toContain('hola desde un tema nuevo');
    expect(n.lines.some((l) => l.includes(`${T585} "${OUTSIDE}" -> fork of ${MAIN}`))).toBe(true);
    n.app.stop();
  });

  it('a first message that is a file lands in the chat\'s media/', async () => {
    const n = await bootNode();
    n.api.files['documents/doc585.pdf'] = 'pdf';
    n.api.updates(inTopic(585, undefined, { document: { file_id: 'doc585', file_unique_id: 'u585', file_name: 'precios.pdf', mime_type: 'application/pdf' }, caption: 'la lista de precios' }, OUTSIDE));
    await vi.waitFor(() => expect(n.state().contacts.telegram[T585]?.parent_chat).toBe(MAIN));
    const main = n.state().contacts.telegram[MAIN];
    expect(n.state().contacts.telegram[T585].slug).toBe(main.slug);
    await vi.waitFor(async () => expect(await fs.readFile(join(tgDirOf(main.slug), 'media', 'index.md'), 'utf8').catch(() => '')).toContain('la lista de precios'));
    n.app.stop();
  });

  it('a /split topic keeps the entry /split made: its first message registers nothing', async () => {
    const n = await bootNode();
    await splitInto(n);
    const made = structuredClone(n.state().contacts.telegram[TOPIC]);
    n.api.updates(inTopic(77, '@e en el tema del split'));
    await answered(n.api, 'en el tema del split');
    expect(n.state().contacts.telegram[TOPIC]).toMatchObject({ slug: made.slug, parent_chat: MAIN, transcript: made.transcript, agents: { egpt: { threadId: made.agents.egpt.threadId } } });
    expect(n.lines.some((l) => /-> fork of /.test(l))).toBe(false);
    n.app.stop();
  });

  it('a topic of a group whose General chat is no conversation here is a conversation of its own, as before', async () => {
    const n = await bootNode(TELEGRAM_ONLY(), { state: emptyState() });
    n.api.updates(inTopic(585, '@e hola', {}, OUTSIDE));
    await vi.waitFor(() => expect(n.state().contacts.telegram?.[T585]).toBeTruthy());
    const topic = n.state().contacts.telegram[T585];
    expect(topic.parent_chat).toBeUndefined();
    expect(topic.transcript).toBeUndefined();
    expect(topic.slug.startsWith(sanitizeSlug(OUTSIDE))).toBe(true);
    expect(n.state().contacts.telegram[MAIN]).toBeUndefined();
    n.app.stop();
  });
});

// ── Topics on turns a basic group into a supergroup under a NEW id (migrate_to/from_chat_id) ──────
const BASIC = 'tg:-5256478300';
const SUPER = 'tg:-1009999';
const basicChat = { id: -5256478300, type: 'group', title: 'EduWeb' };
const superChat = { id: -1009999, type: 'supergroup', title: 'EduWeb', is_forum: true };
const migrated = () => [
  { message_id: 50, date: now(), chat: basicChat, from: AN, migrate_to_chat_id: -1009999 },
  { message_id: 1, date: now(), chat: superChat, from: AN, migrate_from_chat_id: -5256478300 },
];
// What the Bot API answers anything sent to a group that became a supergroup.
const UPGRADED = () => ({ status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -1009999 } }) });
const mediaFile = async () => {
  const dir = join(HOME, 'media-out');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'nota.txt'), 'x');
  return join(dir, 'nota.txt');
};

describe('moveChatId — a conversation follows its chat to a new id', () => {
  const base = () => {
    let s = ensureContact(emptyState(), 'telegram', BASIC, { pushedName: 'EduWeb' }).state;
    s = recordThread(s, 'telegram', BASIC, 'eduweb-thread', '2026-10-01T00:00:00Z', 'egpt');
    s = patchBeing(s, 'telegram', BASIC, 'egpt', { mode: 'on', allowed_users: ['42'] });
    s = ensureContact(s, 'telegram', 'tg:-777', { pushedName: 'otro' }).state;
    s = aliasContact(s, 'telegram', 'tg:-888', BASIC, { transcript: 'side' });
    s = ensureContact(s, 'telegram', 'tg:-999', { pushedName: 'fork' }).state;
    return patchContact(s, 'telegram', 'tg:-999', { parent_chat: BASIC });
  };

  it('the entry moves whole (folder, threads, beings\' settings); side rooms naming it follow; the rest is untouched', () => {
    const s = base();
    const next = moveChatId(s, 'telegram', BASIC, SUPER);
    const b = next.contacts.telegram;
    expect(b[SUPER]).toEqual(s.contacts.telegram[BASIC]);
    expect(b[BASIC]).toBeUndefined();
    expect(b['tg:-888']).toEqual({ aliasOf: SUPER, transcript: 'side' });
    expect(b['tg:-999'].parent_chat).toBe(SUPER);
    expect(b['tg:-777']).toBe(s.contacts.telegram['tg:-777']);
    expect(chatIdForEntity(next, `telegram/${b[SUPER].slug}`)).toEqual({ surface: 'telegram', chatId: SUPER });   // heartbeats target the new id
  });

  it('unchanged when the old id has no entry, or the new one already has its own', () => {
    const s = base();
    expect(moveChatId(s, 'telegram', 'tg:-1', SUPER)).toBe(s);
    expect(moveChatId(s, 'telegram', BASIC, 'tg:-777')).toBe(s);
  });
});

describe('telegram limb — a group turned supergroup', () => {
  it('hands over the move (old id, new id) once, before anything later, and dispatches nothing', async () => {
    const api = fakeApi();
    const moves = [];
    const { bridge, incoming } = start(api, { onChatMoved: (from, to) => { moves.push([from, to, incoming.length]); } });
    await bridge.startupReady;
    api.updates(...migrated(), { message_id: 2, date: now(), chat: superChat, from: AN, text: 'hola' });
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(moves).toEqual([[BASIC, SUPER, 0]]);   // said on both sides, handed over once
    expect(incoming[0].from.chatId).toBe(SUPER);
    bridge.stop();
  });

  it('the new side alone is enough', async () => {
    const api = fakeApi();
    const moves = [];
    const { bridge } = start(api, { onChatMoved: (from, to) => { moves.push([from, to]); } });
    await bridge.startupReady;
    api.updates(migrated()[1]);
    await vi.waitFor(() => expect(moves).toEqual([[BASIC, SUPER]]));
    bridge.stop();
  });

  it('after the move, everything said to the old id goes to the new one', async () => {
    const api = fakeApi();
    const moves = [];
    const { bridge } = start(api, { onChatMoved: (from, to) => { moves.push([from, to]); } });
    await bridge.startupReady;
    api.updates(...migrated());
    await vi.waitFor(() => expect(moves).toHaveLength(1));
    const { messageId } = await bridge.send('hola', { chatId: BASIC });
    await bridge.editMessage(BASIC, messageId, 'hola!');
    await bridge.sendReaction(BASIC, messageId, '👍');
    await bridge.deleteMessage(BASIC, messageId);
    expect((await bridge.sendMedia(BASIC, await mediaFile())).ok).toBe(true);
    const chats = ['sendMessage', 'editMessageText', 'setMessageReaction', 'deleteMessage', 'sendDocument'].map((m) => api.of(m).map((c) => c.body.chat_id));
    expect(chats).toEqual([['-1009999'], ['-1009999'], ['-1009999'], ['-1009999'], ['-1009999']]);
    expect(bridge.wasSentByUs(BASIC, messageId)).toBe(true);
    bridge.stop();
  });

  it('a send refused because the group moved goes once more to the new id and hands the move over (a move missed across a restart)', async () => {
    const api = fakeApi();
    const sendDocument = api.answers.sendDocument;
    api.answers.sendDocument = (b) => (b.chat_id === '-5256478300' ? UPGRADED() : sendDocument(b));
    const moves = [];
    const { bridge } = start(api, { onChatMoved: (from, to) => { moves.push([from, to]); } });
    await bridge.startupReady;
    expect((await bridge.sendMedia(BASIC, await mediaFile())).ok).toBe(true);
    expect(api.of('sendDocument').map((c) => c.body.chat_id)).toEqual(['-5256478300', '-1009999']);
    expect(moves).toEqual([[BASIC, SUPER]]);
    await bridge.send('hola', { chatId: BASIC });   // known now: straight to the new id
    expect(api.of('sendMessage').map((c) => c.body.chat_id)).toEqual(['-1009999']);
    bridge.stop();
  });
});

describe('a Telegram node: the conversation follows the chat to its new id', () => {
  const basicSeed = () => {
    let s = ensureContact(emptyState(), 'telegram', BASIC, { pushedName: 'EduWeb', slugHint: 'EduWeb' }).state;
    s = recordThread(s, 'telegram', BASIC, 'eduweb-thread', '2026-10-01T00:00:00Z', 'egpt');
    return patchBeing(s, 'telegram', BASIC, 'egpt', { mode: 'on', allowed_users: ['42'] });
  };

  const tgDir = join(HOME, 'conversations', 'telegram');
  const dirs = async () => { try { return (await fs.readdir(tgDir)).sort(); } catch { return []; } };

  it('folder, thread and beings\' settings move to the new id, and the next message there is answered in that conversation', async () => {
    const n = await bootNode(TELEGRAM_ONLY(), { state: basicSeed() });
    const before = n.state().contacts.telegram[BASIC];
    const dirsBefore = await dirs();
    n.api.updates(...migrated());
    await vi.waitFor(() => expect(n.state().contacts.telegram[SUPER]).toBeTruthy());
    expect(n.state().contacts.telegram[SUPER]).toEqual(before);
    expect(n.state().contacts.telegram[BASIC]).toBeUndefined();
    n.api.updates({ message_id: 2, date: now(), chat: superChat, from: AN, text: 'seguimos aquí' });
    await answered(n.api, 'seguimos aquí');
    const edit = n.api.of('editMessageText').find((c) => c.body.text.includes('seguimos aquí'));
    expect(edit.body.chat_id).toBe('-1009999');
    expect(Object.keys(n.state().contacts.telegram)).toEqual([SUPER]);
    expect(n.state().contacts.telegram[SUPER].slug).toBe(before.slug);
    // the migrate pair made no folder; the lines after the move carry the group's title
    expect((await dirs()).filter((d) => !dirsBefore.includes(d) && d !== before.slug)).toEqual([]);
    await vi.waitFor(async () => expect(await fs.readFile(join(tgDir, before.slug, 'transcript.md'), 'utf8')).toMatch(/@\[EduWeb\]\.tg \(\d\d:\d\d\): ↩ /));
    const tx = await fs.readFile(join(tgDir, before.slug, 'transcript.md'), 'utf8');
    expect(tx).toMatch(/An R@\[EduWeb\]\.tg \(\d\d:\d\d\) #2: seguimos aquí/);
    expect(tx).toMatch(/@\[EduWeb\]\.tg \(\d\d:\d\d\): ↩ /);
    expect(tx).not.toMatch(/@\[telegram\]/);
    n.app.stop();
  });

  it('a turn still running in the old group when it moves files its reply in the moved conversation: nothing is registered for the old id', async () => {
    const SLUG = 'EduWeb-2610240312';   // made days before the move, as live
    const state = patchContact(basicSeed(), 'telegram', BASIC, { slug: SLUG, conversation_path: conversationPathOf('telegram', SLUG) });
    let release, started;
    const gate = new Promise((r) => { release = r; });
    const running = new Promise((r) => { started = r; });
    const slow = (opts) => ({ sessionId: opts.sessionId ?? 'sess-1', async turn(m, onUpdate) { started(); await gate; onUpdate?.(`↩ ${m}`); return { text: `↩ ${m}`, sessionId: 'sess-2' }; }, close() {} });
    const n = await bootNode(TELEGRAM_ONLY(), { state, makeSession: slow });
    n.api.updates({ message_id: 49, date: now(), chat: basicChat, from: AN, text: 'hola antes' });
    await running;
    const dirsBefore = await dirs();
    n.api.updates(...migrated());
    await vi.waitFor(() => expect(n.state().contacts.telegram[SUPER]).toBeTruthy());
    release();
    await answered(n.api, 'hola antes');
    await vi.waitFor(async () => expect(await fs.readFile(join(tgDir, SLUG, 'transcript.md'), 'utf8')).toMatch(/@\[EduWeb\]\.tg \(\d\d:\d\d\): ↩ .*#49: hola antes/));
    expect(Object.keys(n.state().contacts.telegram)).toEqual([SUPER]);
    expect(await dirs()).toEqual(dirsBefore);
    n.app.stop();
  });

  it('a move the node missed heals on the first refused send: the reply reaches the new chat and the conversation moves', async () => {
    const n = await bootNode(TELEGRAM_ONLY(), { state: basicSeed() });
    const before = n.state().contacts.telegram[BASIC];
    const sendMessage = n.api.answers.sendMessage;
    n.api.answers.sendMessage = (b) => (b.chat_id === '-5256478300' ? UPGRADED() : sendMessage(b));
    n.api.updates({ message_id: 60, date: now(), chat: basicChat, from: AN, text: 'última en el grupo viejo' });
    await answered(n.api, 'última en el grupo viejo');
    expect(n.api.of('editMessageText').find((c) => c.body.text.includes('última en el grupo viejo')).body.chat_id).toBe('-1009999');
    await vi.waitFor(() => expect(Object.keys(n.state().contacts.telegram)).toEqual([SUPER]));
    expect(n.state().contacts.telegram[SUPER].slug).toBe(before.slug);
    n.app.stop();
  });

  it('a closed_chats rule naming the old id is renamed to the new one in config.yaml, nothing else in the file changes', async () => {
    const cfgPath = join(HOME, 'config', 'config.yaml');
    await fs.mkdir(join(HOME, 'config'), { recursive: true });
    const text = '# the node\nclosed_chats:\n  telegram:\n    "tg:-5256478300": { message: "cerrado" }   # EduWeb\n  whatsapp:\n    abc: {}\n';
    await fs.writeFile(cfgPath, text);
    try {
      const n = await bootNode({ ...TELEGRAM_ONLY(), closed_chats: { telegram: { [BASIC]: { message: 'cerrado' } }, whatsapp: { abc: {} } } }, { state: basicSeed() });
      n.api.updates(...migrated());
      await vi.waitFor(async () => expect(await fs.readFile(cfgPath, 'utf8')).toBe(text.replace(BASIC, SUPER)));
      n.app.stop();
    } finally { await fs.rm(cfgPath, { force: true }); }
  });
});

describe('a Telegram node: a turn the spine starts names its chat like any other line', () => {
  const slug = (n) => n.state().contacts.telegram[MAIN].slug;
  const tx = (n) => fs.readFile(join(HOME, 'conversations', 'telegram', slug(n), 'transcript.md'), 'utf8');

  it('a heartbeat turn', async () => {
    const n = await bootNode();
    const ns = `telegram/${slug(n)}`;
    await n.app.dispatchHeartbeatTurn({ being: 'egpt', ns, prompt: 'latido de prueba', name: `${ns}:latido` });
    expect(await tx(n)).toMatch(/@\[EduWeb\]\.tg \(\d\d:\d\d\): .*latido de prueba/);
    n.app.stop();
  });

  it('a heartbeat post', async () => {
    const n = await bootNode();
    await n.app.dispatchHeartbeatPost({ ns: `telegram/${slug(n)}`, text: 'el primo es 1637' });
    expect(await tx(n)).toMatch(/@\[EduWeb\]\.tg \(\d\d:\d\d\): el primo es 1637/);
    n.app.stop();
  });

  it('a background wake', async () => {
    const n = await bootNode();
    await n.app.spine.wakeOnBackground({ being: 'egpt', surface: 'telegram', chatId: MAIN, summaries: ['benchmark — completed'] });
    expect(await tx(n)).toMatch(/@\[EduWeb\]\.tg \(\d\d:\d\d\): .*finished: benchmark — completed/);
    expect(await tx(n)).not.toMatch(/@\[telegram\]/);
    n.app.stop();
  });
});

describe('a node with Beeper and Telegram: each /split makes its room on the chat\'s own limb', () => {
  it('a WhatsApp /split still makes a Beeper group of its own (no topic); a Telegram /split makes a topic (no Beeper group)', async () => {
    const beeper = fakeBeeper();
    let state = ensureContact(seeded(), 'whatsapp', 'wachat', { pushedName: 'fam', slugHint: 'fam' }).state;
    state = recordThread(state, 'whatsapp', 'wachat', 'fam-thread', '2026-10-01T00:00:00Z', 'egpt');
    const n = await bootNode(MIXED(), { state, beeper });
    const LULU = '@whatsapp_lid-1:beeper.local';
    await beeper.built[0].onIncoming('/e split viaje', { chatId: 'wachat', chatName: 'fam', chatType: 'group', network: 'whatsapp', userId: LULU, senderName: 'Lulu', authorized: false, isSender: false, msgKey: 'w1' });
    await vi.waitFor(() => expect(beeper.built[0].groups).toHaveLength(1));
    expect(beeper.built[0].groups[0].opts).toEqual({ accountID: 'whatsapp', participantIDs: [LULU], type: 'group', title: 'SI+fam-viaje' });
    await vi.waitFor(() => expect(n.state().contacts.whatsapp.wanew?.parent_chat).toBe('wachat'));
    expect(n.state().contacts.whatsapp.wanew).not.toHaveProperty('link');
    await vi.waitFor(() => expect(beeper.built[0].sent.some((s) => s.chatId === 'wanew' && /Fork of fam/.test(s.text))).toBe(true));
    expect(beeper.built[0].sent.filter((s) => s.chatId === 'wachat')).toEqual([]);   // a member's split: nothing said in the chat
    expect(n.api.of('createForumTopic')).toHaveLength(0);
    await splitInto(n);
    expect(n.api.of('createForumTopic')).toHaveLength(1);
    expect(beeper.built[0].groups).toHaveLength(1);
    n.app.stop();
  });
});
