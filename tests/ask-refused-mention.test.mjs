// ask-refused-mention.test.mjs — a being's line that names a being its sender (the bot, on Telegram) may not
// wake is no longer dropped silently: the chat is asked "pass it on?", and only a member of that being's
// allowed_users may answer. A person off the list is ignored, as before. The question and its answer are the
// ingest box's own (ingest.mjs createIngestAsks / answerOf, boot's answerIngest); yes hands the line, as it
// arrived, to that being alone (spine.dispatchApproved).
//   1. the spine: which lines ask, and what approval runs (real spine + identity + router + gating)
//   2. a whole Telegram node: a being's post naming a being the bot may not wake (PR #12's echo) → question → yes
import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-ask-refused-mention-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { startTelegramBridge } from '../src/bridges/telegram.mjs';
import { boot } from '../src/spine/boot.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
import { mentionAsk } from '../src/spine/ingest.mjs';
import { emptyState, ensureContact, recordThread } from '../src/conversations-state.mjs';
import { Room } from '../src/room-core.mjs';

// each node boots on a clean profile: the ask store and the transcripts live under it
const clean = async () => { try { await fs.rm(HOME, { recursive: true, force: true }); } catch {} };
afterEach(clean);
afterAll(clean);

const settle = () => new Promise((r) => setTimeout(r, 30));

// ── 1. the spine ─────────────────────────────────────────────────────────────────────────────────────────
// finch and owl answer only user 42; lark and wren answer anyone (lark is the being "on" chats hand every line to).
const AGENTS = {
  lark: { handles: ['lark'], conversation_defaults: { allowed_users: ['*'] } },
  wren: { handles: ['wren'], conversation_defaults: { allowed_users: ['*'] } },
  finch: { handles: ['finch'], conversation_defaults: { allowed_users: ['42'] } },
  owl: { handles: ['owl'], conversation_defaults: { allowed_users: ['42'] } },
};
const fromThisNode = (ev) => ev?.fromNode != null && String(ev.fromNode).toLowerCase() === 'nodea';

function buildSpine({ mode = 'mention', guard = null, ask = true, ...extra } = {}) {
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, body: ev.body, senderId: ev.senderId, senderName: ev.senderName }); return { text: 'x' }; } };
  const config = { node_name: 'nodeA', dispatch: { auto_default_mode: mode } };
  const transcript = { logged: [], async log(ev, reply) { this.logged.push({ ev, reply }); } };
  const asks = [];
  const answers = [];
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
    brain, identity: createIdentity({ now: () => 1000 }),
    router: createRouter({ getAgents: () => AGENTS, getConfig: () => config }),
    gating: createGating({ getConfig: () => config, loadState: null }),
    sender: { open() { return { activate() {}, begin() {}, update() {}, async finish() {}, fail() {} }; } },
    transcript, heartbeats: { runDue() {} }, mesh: { isEnvelope: () => false, async handle() {} },
    fromThisNode, guard, isSelfChat: () => false, clock: { now: () => 1000 },
    ...(ask ? { ingestAsk: { isAnswer: () => false, answer: async (ev) => { answers.push(ev); }, ask: async (ev, asked) => { asks.push({ ev, asked }); } } } : {}),
    ...extra,
  });
  return { spine, brain, transcript, asks, answers, inbound: () => transcript.logged.filter((x) => x.reply == null) };
}
const person = (body, userId = '77', extra = {}) => ({ body, from: { chatId: 'tg:42', chatName: 'Plan', network: 'telegram', userId, senderName: userId === '42' ? 'Operator' : 'Maya', authorized: userId === '42', msgKey: '7', atEStart: true, atEAnywhere: true, ...extra } });
// A being's post as the Telegram limb hands it back (telegram.mjs echo): our own account, signed, on the record.
const echo = (body, fromBeing = 'lark', extra = {}) => ({ body, from: { chatId: 'tg:42', chatName: 'Plan', network: 'telegram', userId: '99', senderName: 'NodeA', isSender: true, authorized: true, msgKey: '500', msgTs: 1000, atEStart: false, atEAnywhere: true, fromNode: 'nodeA', fromBeing, recorded: true, ...extra } });
const ran = (brain) => brain.calls.map((c) => c.being);
const LINE = '🐦 Lark: @finch can you check the plan?';

describe('the spine asks when a being\'s own line names a being allowed_users turned away', () => {
  it('the chat is asked once about that being; nothing runs', async () => {
    const { spine, brain, asks } = buildSpine();
    await spine.handleInbound(echo(LINE));
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    expect(asks[0].asked.map((a) => a.being)).toEqual(['finch']);
    expect(asks[0].asked[0].target).toMatchObject({ being: 'finch', mention: { atEStart: true, atEAnywhere: true } });
    expect(asks[0].ev).toMatchObject({ chatId: 'tg:42', senderId: '99', fromBeing: 'lark', fromNode: 'nodeA', body: LINE });
    expect(brain.calls).toEqual([]);
  });

  it('a person NOT on the being\'s list who names it is ignored, as before: no question, no turn, the line recorded', async () => {
    const { spine, brain, asks, inbound } = buildSpine();
    await spine.handleInbound(person('@finch hola'));
    await spine.handleInbound(person('@finch @owl hola', '77', { msgKey: '8' }));
    await settle();
    expect(asks).toEqual([]);
    expect(brain.calls).toEqual([]);
    expect(inbound()).toHaveLength(2);
  });

  it('another node\'s signed line (a peer\'s being) is not asked about either', async () => {
    const { spine, brain, asks } = buildSpine();
    await spine.handleInbound(person('@finch hola', '77', { fromNode: 'nodeB', fromBeing: 'ren', isSender: true }));
    await spine.handleInbound(echo(LINE, null));   // this node's frame with no author wakes nobody
    await settle();
    expect(asks).toEqual([]);
    expect(brain.calls).toEqual([]);
  });

  it('one question per refused being per line; a being the sender may wake just runs', async () => {
    const { spine, brain, asks } = buildSpine();
    await spine.handleInbound(echo('🐦 Lark: @finch @owl @wren hola'));
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    expect(asks[0].asked.map((a) => a.being).sort()).toEqual(['finch', 'owl']);
    expect(ran(brain)).toEqual(['wren']);
  });

  it('LOCK: a being the bot may wake is never asked about — it runs as before; so does a permitted person', async () => {
    const { spine, brain, asks } = buildSpine();
    await spine.handleInbound(echo('🐦 Lark: @wren hola'));
    await spine.handleInbound(person('@finch hola', '42'));
    await settle();
    expect(ran(brain).sort()).toEqual(['finch', 'wren']);
    expect(asks).toEqual([]);
  });

  it('a quote of the being\'s post addresses it too', async () => {
    const { spine, asks } = buildSpine();
    await spine.handleInbound(echo('🐦 Lark: de acuerdo', 'lark', { replyToBot: true, replyToBeing: 'finch', replyToId: '55', atEAnywhere: false }));
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    expect(asks[0].asked.map((a) => a.being)).toEqual(['finch']);
  });

  it('never the author, never a being taken by its mode; the ask counts nothing toward the loop guard', async () => {
    const guard = createStopGuard({ turns: 6 });
    const { spine, brain, asks, inbound } = buildSpine({ mode: 'on', guard });
    await spine.handleInbound(echo('🐦 Lark: @finch @lark can you check the plan?'));
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    expect(asks[0].asked.map((a) => a.being)).toEqual(['finch']);
    expect(brain.calls).toEqual([]);
    expect(inbound()).toEqual([]);                              // an echo is already on the record
    expect(guard.countOf('telegram:tg:42')).toBe(0);
  });

  it('an echo that names nobody here, or no refused being, asks nothing — in an "on" chat too', async () => {
    const { spine, brain, asks } = buildSpine({ mode: 'on' });
    await spine.handleInbound(echo('🐦 Lark: @lark nota para mí'));
    await spine.handleInbound(echo('🐦 Lark: hola a todos'));
    await settle();
    expect(asks).toEqual([]);
    expect(brain.calls).toEqual([]);
  });

  it('a being whose gate would ignore the line is no question (mention-direct, named mid-sentence)', async () => {
    const { spine, brain, asks } = buildSpine({ mode: 'mention-direct' });
    await spine.handleInbound(echo('🐦 Lark: hola @finch'));
    await settle();
    expect(brain.calls).toEqual([]);
    expect(asks).toEqual([]);
  });

  it('lines dropped before routing stay dropped: a backlog replay, a chat every being has off, a transit channel', async () => {
    const a = buildSpine();
    await a.spine.handleInbound(echo(LINE, 'lark', { backlog: true }));
    const b = buildSpine({ mode: 'off' });
    await b.spine.handleInbound(echo(LINE));
    const c = buildSpine({ isTransit: () => true });
    await c.spine.handleInbound(echo(LINE));
    await settle();
    for (const n of [a, b, c]) { expect(n.asks).toEqual([]); expect(n.brain.calls).toEqual([]); }
  });

  it('a channel the loop guard stopped is not asked', async () => {
    const guard = createStopGuard({ turns: 6 });
    guard.stopChannel('telegram:tg:42');
    const { spine, asks } = buildSpine({ guard });
    await spine.handleInbound(echo(LINE));
    await settle();
    expect(asks).toEqual([]);
  });

  it('a spine with no ask seam (older callers) behaves as before: dropped silently', async () => {
    const { spine, brain } = buildSpine({ ask: false });
    await spine.handleInbound(echo(LINE));
    expect(brain.calls).toEqual([]);
  });

  it('the question itself, coming back on the ear (this node\'s frame, no author), wakes and asks nobody', async () => {
    const { spine, brain, asks } = buildSpine();
    await spine.handleInbound(echo(mentionAsk('lark', 'finch'), null, { msgKey: '501', recorded: false }));
    await spine.handleInbound(echo(mentionAsk('lark', 'wren'), null, { msgKey: '502', recorded: false }));
    await settle();
    expect(brain.calls).toEqual([]);
    expect(asks).toEqual([]);
  });
});

describe('router.resolve reports the beings allowed_users turned away', () => {
  const ev = (body, senderId) => ({ surface: 'telegram', chatId: 'tg:42', senderId, body });
  const router = (agents = AGENTS, extra = {}) => createRouter({ getAgents: () => agents, getConfig: () => ({ dispatch: { auto_default_mode: 'on' } }), ...extra });

  it('the addressed ones, as targets would be; a being taken by its mode is never among them', async () => {
    const r = await router().resolve(ev('@finch @owl hola', '77'));
    expect(r.refused.map((t) => t.being)).toEqual(['finch', 'owl']);
    expect(r.refused[0]).toMatchObject({ mention: { atEStart: true, atEAnywhere: true }, address: 'finch' });
    expect(r.targets.map((t) => t.being).sort()).toEqual(['lark', 'wren']);        // both by mode, neither addressed
    expect(r.targets.every((t) => t.fallthrough)).toBe(true);
    expect((await router().resolve(ev('hola a todos', '77'))).refused).toBeUndefined();
  });

  it('nothing refused, no key: a permitted sender resolves exactly as before', async () => {
    const r = await router().resolve(ev('@finch hola', '42'));
    expect(r.targets[0]).toMatchObject({ being: 'finch' });
    expect('refused' in r).toBe(false);
  });

  it('a hit won by a fallback_handle token is dropped, with no membership lookup, not asked about', async () => {
    const agents = { egpt: { handles: ['ekg'], fallback_handle: { handle: 'e', unless_present: '+15550100002' }, conversation_defaults: { allowed_users: ['someone-else'] } } };
    const isPresent = vi.fn(async () => false);
    const r = await router(agents, { isPresent }).resolve(ev('@e hola', '77'));
    expect(r.targets).toEqual([]);
    expect(r.refused).toBeUndefined();
    expect(isPresent).not.toHaveBeenCalled();
  });
});

describe('dispatchApproved', () => {
  const kept = (ask) => JSON.parse(JSON.stringify({ ev: ask.ev, target: ask.asked[0].target }));   // what the store holds

  it('the stored line runs that being alone, from its original author, and counts toward the loop guard once', async () => {
    const guard = createStopGuard({ turns: 6 });
    const { spine, brain, asks, inbound } = buildSpine({ mode: 'on', guard });
    await spine.handleInbound(echo('🐦 Lark: @finch @lark can you check the plan?'));
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    const out = await spine.dispatchApproved(kept(asks[0]));
    await out.turn;
    expect(brain.calls).toEqual([{ being: 'finch', body: '🐦 Lark: @finch @lark can you check the plan?', senderId: '99', senderName: 'NodeA' }]);
    expect(guard.countOf('telegram:tg:42')).toBe(1);
    expect(inbound()).toEqual([]);                              // not recorded a second time
    expect(asks).toHaveLength(1);                               // and nothing asked again
  });

  it('a stopped channel does not run it', async () => {
    const guard = createStopGuard({ turns: 6 });
    const { spine, brain, asks } = buildSpine({ guard });
    await spine.handleInbound(echo(LINE));
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    guard.stopChannel('telegram:tg:42');
    expect(await spine.dispatchApproved(kept(asks[0]))).toBe(null);
    expect(brain.calls).toEqual([]);
  });
});

// ── 2. a whole Telegram node ─────────────────────────────────────────────────────────────────────────────
const TOKEN = '123456:FAKE-ask-refused-token';
const ME = { id: 99, is_bot: true, first_name: 'NodeA', username: 'nodea_bot', can_read_all_group_messages: true };
const GROUP = -1001234;
const TOPIC = `tg:${GROUP}/77`;
const CHAT = { id: GROUP, type: 'supergroup', title: 'Contoso', is_forum: true };
const OPERATOR = { id: 42, is_bot: false, first_name: 'Operator' };
const STRANGER = { id: 77, is_bot: false, first_name: 'Maya' };
const MEMBER = { id: 88, is_bot: false, first_name: 'Sam' };   // on Finch's list, not an owner of the node

function fakeApi() {
  const calls = [];
  const queue = [];
  let parked = null, nextId = 500, updateId = 1000;
  const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
  const answers = {
    getMe: () => ok(ME),
    sendMessage: (b) => ok({ message_id: nextId++, chat: { id: Number(b.chat_id) }, text: b.text }),
    editMessageText: () => ok(true),
    setMessageReaction: () => ok(true),
  };
  const fetch = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body);
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
    if (method === 'sendMessage') call.id = nextId - 1;
    return res;
  };
  const push = (r) => { if (parked) { const p = parked; parked = null; p(r); } else queue.push(r); };
  return {
    fetch, calls,
    updates: (...msgs) => push(ok(msgs.map((message) => ({ update_id: ++updateId, message })))),
    of: (method) => calls.filter((c) => c.method === method),
  };
}

const now = () => Math.floor(Date.now() / 1000);
let mid = 300;
const root = { message_id: 77, date: now(), chat: CHAT, from: ME, is_topic_message: true, message_thread_id: 77, forum_topic_created: { name: 'Plan', icon_color: 7322096 } };
const inTopic = (text, from = OPERATOR, quoted = root) => ({ message_id: ++mid, date: now(), chat: CHAT, from, text, is_topic_message: true, message_thread_id: 77, reply_to_message: quoted });
const NODE = () => ({
  node_name: 'nodeA', user_name: 'Operator',
  limbs: { telegram: { main: { account: 'nodea_bot' } } },
  networks: { telegram: { allowed_users: [42] } },
  agents: {
    lark: { configuration: 'egpt', handles: ['lark'], name: 'Lark', body_emoji: '🐦' },
    finch: { configuration: 'egpt', handles: ['finch'], name: 'Finch', body_emoji: '🐤', conversation_defaults: { allowed_users: [88] } },
  },
});
function topicState() {
  let s = ensureContact(emptyState(), 'telegram', TOPIC, { pushedName: 'Plan', slugHint: 'Plan' }).state;
  for (const being of ['lark', 'finch']) {
    s = recordThread(s, 'telegram', TOPIC, `${being}-thread`, '2026-10-01T00:00:00Z', being);
    s.contacts.telegram[TOPIC].agents[being].mode = 'mention';
  }
  return s;
}
// A memory io over the real fs for everything but the ask store, so a second boot can read it back.
async function bootNode(script, { io = null } = {}) {
  await fs.mkdir(join(HOME, 'secrets'), { recursive: true });
  await fs.writeFile(join(HOME, 'secrets', 'telegram-main.token'), `${TOKEN}\n`);
  const api = fakeApi();
  const turns = [];
  const lines = [];
  let st = topicState();
  const app = await boot({
    readConfig: () => NODE(),
    startTelegram: (opts) => startTelegramBridge({ ...opts, fetch: api.fetch }),
    makeSession: (opts) => {
      const being = String(opts.sessionId ?? '').split('-')[0];
      return { sessionId: opts.sessionId, async turn(m) { turns.push({ being, prompt: m }); return { text: script[being](m), sessionId: this.sessionId }; }, close() {} };
    },
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    ingest: false, tickMs: 0,
    ...(io ? { io } : {}),
    log: { line: (l) => lines.push(l) },
  });
  await vi.waitFor(() => expect(api.of('getUpdates').length).toBeGreaterThan(0));
  const posted = () => [...api.of('sendMessage'), ...api.of('editMessageText')].map((c) => c.body.text);
  const questions = () => api.of('sendMessage').filter((c) => c.body.text?.includes('pass it on?'));
  const answerTo = (q, text, from = MEMBER) => api.updates(inTopic(text, from, { message_id: q.id, chat: CHAT, from: ME, text: q.body.text, is_topic_message: true, message_thread_id: 77 }));
  const transcript = () => fs.readFile(Room.forChat('telegram', st.contacts.telegram[TOPIC].slug).transcriptPath, 'utf8').catch(() => '');
  return { app, api, turns, lines, posted, questions, answerTo, transcript, of: (being) => turns.filter((t) => t.being === being) };
}
const SCRIPT = { lark: () => '@finch can you check the plan?', finch: () => 'checked: the plan is fine' };
const count = (s, part) => s.split(part).length - 1;
// Lark answers the operator naming Finch; the bot is not on Finch's list, so the chat is asked.
async function larkNamesFinch(n) {
  n.api.updates(inTopic('@lark ask finch about the plan'));
  await vi.waitFor(() => expect(n.questions()).toHaveLength(1), { timeout: 10_000 });
  return n.questions()[0];
}

describe('a Telegram node: Lark\'s post names Finch, whose list the bot is not on', () => {
  it('the topic is asked, nobody runs; the question names who said it and to whom, and is not itself echoed', async () => {
    const n = await bootNode(SCRIPT);
    const q = await larkNamesFinch(n);
    expect(q.body).toMatchObject({ chat_id: String(GROUP), message_thread_id: 77, text: mentionAsk('lark', 'finch') });
    expect(q.body.text).toBe('❓ lark → finch: pass it on? reply yes / no');
    await settle();
    expect(n.of('finch')).toEqual([]);
    expect(n.of('lark')).toHaveLength(1);
    expect(n.questions()).toHaveLength(1);                      // the question woke nobody and raised no question of its own
    n.app.stop();
  });

  it('a person off Finch\'s list who names it is not asked about: ignored, as before', async () => {
    const n = await bootNode(SCRIPT);
    n.api.updates(inTopic('@finch hola', STRANGER));
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    expect(n.questions()).toEqual([]);
    expect(n.turns).toEqual([]);
    n.app.stop();
  });

  it('the question, sent whole by the limb, is never handed back as an echo (it is not a being\'s stamped line)', async () => {
    const api = fakeApi();
    const incoming = [];
    const bridge = startTelegramBridge({
      telegramToken: TOKEN, connection: 'main', fetch: api.fetch, isAllowedUser: () => false, wakeWords: ['lark', 'finch'], nodeName: 'nodeA',
      personaStamps: () => [{ being: 'lark', bodyEmoji: '🐦', label: 'Lark' }, { being: 'finch', bodyEmoji: '🐤', label: 'Finch' }],
      onIncoming: (body, from) => { incoming.push({ body, from }); }, onLog: () => {},
    });
    await bridge.startupReady;
    await bridge.send(mentionAsk('lark', 'finch'), { chatId: 'tg:42' });
    await settle();
    expect(api.of('sendMessage')).toHaveLength(1);
    expect(incoming).toEqual([]);
    bridge.stop();
  });

  it('a "yes" from a member of Finch\'s list (the owner is not on it) wakes Finch alone with Lark\'s line; Lark is not woken again; the line is recorded once', async () => {
    const n = await bootNode(SCRIPT);
    const q = await larkNamesFinch(n);
    n.answerTo(q, 'yes');
    await vi.waitFor(() => expect(n.posted().some((t) => t?.includes('🐤 Finch: checked: the plan is fine'))).toBe(true), { timeout: 10_000 });
    expect(n.of('finch')).toHaveLength(1);
    expect(n.of('finch')[0].prompt).toContain('can you check the plan?');
    expect(n.of('lark')).toHaveLength(1);
    expect(n.posted()).toContainEqual(expect.stringContaining('✅ dispatched'));
    expect(n.lines.some((l) => /\[ingest\] @finch tg:-1001234\/77: dispatched by Sam/.test(l))).toBe(true);
    await vi.waitFor(async () => expect(await n.transcript()).toContain('checked: the plan is fine'));
    expect(count(await n.transcript(), 'can you check the plan?')).toBe(1);
    expect(n.questions()).toHaveLength(1);
    n.app.stop();
  });

  it('a "yes" from anyone else, the node\'s owner included, is ordinary chat: ignored, the question stays open for the list', async () => {
    const n = await bootNode(SCRIPT);
    const q = await larkNamesFinch(n);
    n.answerTo(q, 'yes', STRANGER);
    n.answerTo(q, 'yes', OPERATOR);
    await settle();
    expect(n.of('finch')).toEqual([]);
    expect(n.posted().some((t) => t?.includes('dispatched'))).toBe(false);
    n.answerTo(q, 's');
    await vi.waitFor(() => expect(n.of('finch')).toHaveLength(1), { timeout: 10_000 });
    n.app.stop();
  });

  it('"no" drops it: the short system line, no turn, and a later yes is ordinary chat', async () => {
    const n = await bootNode(SCRIPT);
    const q = await larkNamesFinch(n);
    n.answerTo(q, 'non');
    await vi.waitFor(() => expect(n.posted().some((t) => t?.includes('🚫 dropped'))).toBe(true), { timeout: 10_000 });
    n.answerTo(q, 'yes');
    await settle();
    expect(n.of('finch')).toEqual([]);
    n.app.stop();
  });

  it('the open question survives a restart', async () => {
    const files = new Map();
    const io = { readFile: async (p) => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p); }, writeFile: async (p, d) => { files.set(p, String(d)); }, rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); }, mkdir: async () => {} };
    const first = await bootNode(SCRIPT, { io });
    const q = await larkNamesFinch(first);
    first.app.stop();
    const stored = JSON.parse(files.get(join(HOME, 'state', 'ingest-asks.json')));
    expect(stored).toEqual([expect.objectContaining({ chatId: TOPIC, ids: [String(q.id)], being: 'finch', target: expect.objectContaining({ being: 'finch' }), ev: expect.objectContaining({ fromBeing: 'lark', senderId: '99' }) })]);

    const second = await bootNode(SCRIPT, { io });
    second.answerTo(q, 'yes');
    await vi.waitFor(() => expect(second.of('finch')).toHaveLength(1), { timeout: 10_000 });
    expect(JSON.parse(files.get(join(HOME, 'state', 'ingest-asks.json')))).toEqual([]);
    second.app.stop();
  });

  it('the ingest box\'s question beside it: an owner answers that one, a member of Finch\'s list only this one', async () => {
    const n = await bootNode(SCRIPT);
    const q = await larkNamesFinch(n);
    await n.app.ingestLine(`/to ${TOPIC}\nlark, resume the thread`);
    await vi.waitFor(() => expect(n.api.of('sendMessage').some((c) => c.body.text?.includes('received message, dispatch?'))).toBe(true), { timeout: 10_000 });
    const ingestQ = n.api.of('sendMessage').find((c) => c.body.text?.includes('received message, dispatch?'));
    n.answerTo(ingestQ, 'yes', MEMBER);                         // not an owner: ordinary chat
    await settle();
    expect(n.of('lark')).toHaveLength(1);
    n.answerTo(ingestQ, 'yes', OPERATOR);
    await vi.waitFor(() => expect(n.of('lark')).toHaveLength(2), { timeout: 10_000 });
    expect(n.of('finch')).toEqual([]);                         // the owner's yes was for the ingest line, not for Finch
    n.answerTo(q, 'yes', OPERATOR);                             // an owner, but not on Finch's list
    await settle();
    expect(n.of('finch')).toEqual([]);
    n.answerTo(q, 'yes');
    await vi.waitFor(() => expect(n.of('finch')).toHaveLength(1), { timeout: 10_000 });
    n.app.stop();
  });
});
