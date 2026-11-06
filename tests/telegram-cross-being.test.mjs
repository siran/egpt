// telegram-cross-being.test.mjs — on Telegram a being's post that addresses another local being wakes it,
// as Beeper's echo does. The Bot API never delivers a bot's own messages, so the limb hands the spine
// the echo itself (src/bridges/telegram.mjs echo): a being's settled line that names a handle, signed
// with the node and the being, already on the record. The spine's per-being echo gate decides who wakes
// (spine.mjs: only an addressed being, never the author, never a being on by mode; the wake counts toward
// the loop guard), and the ingestion point skips the record (ev.recorded).
import { describe, it, expect, vi, afterAll } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-telegram-cross-being-home`;
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
import { emptyState, ensureContact, recordThread } from '../src/conversations-state.mjs';
import { Room } from '../src/room-core.mjs';

afterAll(async () => { try { await fs.rm(HOME, { recursive: true, force: true }); } catch {} });

const TOKEN = '123456:FAKE-cross-being-token';
const ME = { id: 99, is_bot: true, first_name: 'NodeA', username: 'nodea_bot', can_read_all_group_messages: true };
const GROUP = -1001234;
const TOPIC = `tg:${GROUP}/77`;
const STAMPS = [{ being: 'lark', bodyEmoji: '🐦', label: 'Lark' }, { being: 'finch', bodyEmoji: '🐤', label: 'Finch' }];

function fakeApi() {
  const calls = [];
  const queue = [];
  let parked = null, nextId = 500, updateId = 1000;
  const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
  const err = (code, description) => ({ status: code, json: async () => ({ ok: false, error_code: code, description }) });
  const answers = {
    getMe: () => ok(ME),
    sendMessage: (b) => ok({ message_id: nextId++, chat: { id: Number(b.chat_id) }, text: b.text }),
    editMessageText: () => ok(true),
    setMessageReaction: () => ok(true),
  };
  const fetch = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    if (method === 'getUpdates') {
      if (queue.length) return queue.shift();
      return new Promise((resolve, reject) => {
        parked = resolve;
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return answers[method](body);
  };
  const push = (r) => { if (parked) { const p = parked; parked = null; p(r); } else queue.push(r); };
  return {
    fetch, calls, answers, ok, err,
    updates: (...msgs) => push(ok(msgs.map((message) => ({ update_id: ++updateId, message })))),
    of: (method) => calls.filter((c) => c.method === method),
  };
}

function startLimb(api, extra = {}) {
  const lines = [];
  const incoming = [];
  const bridge = startTelegramBridge({
    telegramToken: TOKEN, connection: 'main', fetch: api.fetch,
    isAllowedUser: (id, net) => net === 'telegram' && id === '42',
    wakeWords: ['lark', 'finch'], nodeName: 'nodeA', personaStamps: () => STAMPS,
    onIncoming: (body, from) => { incoming.push({ body, from }); },
    onLog: (m) => lines.push(m),
    ...extra,
  });
  return { bridge, lines, incoming };
}
// A being's reply as the port hands it to the limb: placeholder, a partial, the settled final.
async function streamed(bridge, chatId, final) {
  const h = bridge.startStreamMessage('🐦 Lark: ⏳ Thinking…', { chatId, replyToMessageID: '7' });
  h.update('🐦 Lark: @finch can');
  await h.finish(final);
  return h;
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('telegram limb — a being\'s settled line that names a handle comes back as the echo Beeper would deliver', () => {
  it('handed once, after the final edit: signed with the node and the being, on our own account, already on the record', async () => {
    const api = fakeApi();
    const { bridge, incoming } = startLimb(api);
    await bridge.startupReady;
    const h = bridge.startStreamMessage('🐦 Lark: ⏳ Thinking…', { chatId: 'tg:42', replyToMessageID: '7' });
    h.update('🐦 Lark: @finch can');
    await settle();
    expect(incoming).toEqual([]);                                  // no placeholder, no partial
    await h.finish('🐦 Lark: @finch can you check the plan?');
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(incoming[0].body).toBe('🐦 Lark: @finch can you check the plan?');
    expect(incoming[0].from).toMatchObject({
      chatId: 'tg:42', chatType: 'private', network: 'telegram', msgKey: h.confirmedId, userId: '99',
      isSender: true, authorized: true, atEStart: true, atEAnywhere: true,
      fromNode: 'nodeA', fromBeing: 'lark', recorded: true,
    });
    expect(bridge.wasSentByUs('tg:42', incoming[0].from.msgKey)).toBe(true);
    await settle();
    expect(incoming).toHaveLength(1);                              // once
    bridge.stop();
  });

  it('a bare handle opening the line past its stamp ("finch, …") is an address too', async () => {
    const api = fakeApi();
    const { bridge, incoming } = startLimb(api);
    await bridge.startupReady;
    await streamed(bridge, 'tg:42', '🐦 Lark: finch, can you check the plan?');
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(incoming[0].from.fromBeing).toBe('lark');
    bridge.stop();
  });

  it('in a forum topic it is the topic\'s', async () => {
    const api = fakeApi();
    const { bridge, incoming } = startLimb(api);
    await bridge.startupReady;
    await streamed(bridge, TOPIC, '🐦 Lark: @finch mira esto');
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    expect(api.of('sendMessage')[0].body).toMatchObject({ chat_id: String(GROUP), message_thread_id: 77 });
    expect(incoming[0].from).toMatchObject({ chatId: TOPIC, chatType: 'group', fromBeing: 'lark', recorded: true });
    bridge.stop();
  });

  it('a chat that renames a being\'s handles is read with its own handles', async () => {
    const api = fakeApi();
    const { bridge, incoming } = startLimb(api, { wakeWordsIn: async (net, chatId) => (net === 'telegram' && chatId === 'tg:42' ? { wakeWords: ['lark', 'finchy'] } : null) });
    await bridge.startupReady;
    await streamed(bridge, 'tg:42', '🐦 Lark: @finchy hola');
    await vi.waitFor(() => expect(incoming).toHaveLength(1));
    bridge.stop();
  });

  it('never handed: a line naming nobody, a status, a node/system line (🫀), a whole send, a relayed member\'s line, a final that did not land', async () => {
    const api = fakeApi();
    const { bridge, incoming, lines } = startLimb(api);
    await bridge.startupReady;
    await streamed(bridge, 'tg:42', '🐦 Lark: ya está, todo listo');           // a being's line naming nobody
    await streamed(bridge, 'tg:42', '🐦 Lark: ✓ 3m');                         // a status settling
    const beat = bridge.startStreamMessage('🫀 daily-check', { chatId: 'tg:42' });
    await beat.finish('🫀 daily-check @finch');                                  // the node's own line: no being's stamp
    await bridge.send('🫀 daily-check', { chatId: 'tg:42' });                 // the heartbeat announce
    await bridge.send('🐦 Lark: ⚙️ background work (1):\n• ask @finch for the totals · 3m', { chatId: 'tg:42' });   // a whole send (a status post)
    await streamed(bridge, 'tg:42', '🤖 Member: @finch hola');                    // a member's line the room relay says
    api.answers.editMessageText = () => api.err(400, 'Bad Request: message to edit not found');
    const failed = await streamed(bridge, 'tg:42', '🐦 Lark: @finch can you check?');
    expect(failed.delivered).toBe(false);
    await settle();
    expect(incoming).toEqual([]);
    expect(lines.some((l) => l.startsWith('echo '))).toBe(false);
    bridge.stop();
  });
});

// ── the spine's half: the real spine + identity + router + gating (clean-ingest.test.mjs's harness), fed
// the very payload the limb hands over ───────────────────────────────────────────────────────────────────
const ANYONE = { allowed_users: ['*'] };
const AGENTS = {
  lark: { handles: ['lark'] },
  finch: { handles: ['finch'] },
  owl: { handles: ['owl'], conversation_defaults: ANYONE },
};
const fromThisNode = (ev) => ev?.fromNode != null && String(ev.fromNode).toLowerCase() === 'nodea';

function buildSpine(limb, { mode = 'mention', guard = null } = {}) {
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, body: ev.body }); return { text: 'x' }; } };
  const config = { node_name: 'nodeA', dispatch: { auto_default_mode: mode } };
  const transcript = { logged: [], async log(ev, reply) { this.logged.push({ ev, reply }); } };
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: (c, id) => limb.wasSentByUs(c, id) },
    brain, identity: createIdentity({ now: () => 1000 }),
    router: createRouter({ getAgents: () => AGENTS, getConfig: () => config }),
    gating: createGating({ getConfig: () => config, loadState: null }),
    sender: { open() { return { activate() {}, begin() {}, update() {}, async finish() {}, fail() {} }; } },
    transcript, heartbeats: { runDue() {} }, mesh: { isEnvelope: () => false, async handle() {} },
    fromThisNode, guard, isSelfChat: () => false, clock: { now: () => 1000 },
  });
  return { spine, brain, transcript, inbound: () => transcript.logged.filter((x) => x.reply == null) };
}
// What the limb hands the spine for Lark's settled `final`.
async function echoOf(final, chatId = 'tg:42') {
  const api = fakeApi();
  const { bridge, incoming } = startLimb(api);
  await bridge.startupReady;
  await streamed(bridge, chatId, final);
  await vi.waitFor(() => expect(incoming).toHaveLength(1));
  return { limb: bridge, msg: incoming[0] };
}
const woke = (brain) => brain.calls.map((c) => c.being);

describe('the spine wakes the being Lark\'s Telegram line addresses, and records nothing twice', () => {
  it('@finch wakes Finch, and only Finch; the line is not recorded again; the wake counts toward the loop guard', async () => {
    const { limb, msg } = await echoOf('🐦 Lark: @finch can you check the plan?');
    const guard = createStopGuard({ turns: 6 });
    const { spine, brain, inbound } = buildSpine(limb, { guard });
    await spine.handleInbound(msg);
    expect(woke(brain)).toEqual(['finch']);
    expect(brain.calls[0].body).toBe('🐦 Lark: @finch can you check the plan?');
    expect(inbound()).toEqual([]);
    expect(guard.countOf('telegram:tg:42')).toBe(1);
    limb.stop();
  });

  it('the author is never woken by its own line, even naming itself', async () => {
    for (const final of ['🐦 Lark: @lark nota para mí', '🐦 Lark: @lark y @finch, ¿listos?']) {
      const { limb, msg } = await echoOf(final);
      const { spine, brain, inbound } = buildSpine(limb, { mode: 'on' });
      await spine.handleInbound(msg);
      expect(woke(brain)).toEqual(final.includes('@finch') ? ['finch'] : []);
      expect(inbound()).toEqual([]);
      limb.stop();
    }
  });

  it('a being on by mode is not woken: only the addressed one (owl is "on" here and stays quiet)', async () => {
    const { limb, msg } = await echoOf('🐦 Lark: @finch hola');
    const { spine, brain } = buildSpine(limb, { mode: 'on' });
    await spine.handleInbound(msg);
    expect(woke(brain)).toEqual(['finch']);
    limb.stop();
  });

  it('an echo that addresses nobody here prompts nobody and is not recorded', async () => {
    const { limb, msg } = await echoOf('🐦 Lark: @finch hola');
    const { spine, brain, inbound } = buildSpine(limb, { mode: 'on' });
    await spine.handleInbound({ ...msg, body: '🐦 Lark: hola a todos' });
    expect(woke(brain)).toEqual([]);
    expect(inbound()).toEqual([]);
    limb.stop();
  });

  it('LOCK: a person\'s line is still recorded once and still wakes', async () => {
    const { limb } = await echoOf('🐦 Lark: @finch hola');
    const { spine, brain, inbound } = buildSpine(limb);
    await spine.handleInbound({ body: '@finch hola', from: { chatId: 'tg:42', chatName: 'Operator', network: 'telegram', userId: '42', senderName: 'Operator', authorized: true, msgKey: '7' } });
    expect(woke(brain)).toEqual(['finch']);
    expect(inbound()).toHaveLength(1);
    limb.stop();
  });
});

// ── a whole Telegram node: limb → port → spine → brain, in a forum topic ─────────────────────────────────
const CHAT = { id: GROUP, type: 'supergroup', title: 'Contoso', is_forum: true };
const OPERATOR = { id: 42, is_bot: false, first_name: 'Operator' };
const now = () => Math.floor(Date.now() / 1000);
let mid = 300;
const root = { message_id: 77, date: now(), chat: CHAT, from: ME, is_topic_message: true, message_thread_id: 77, forum_topic_created: { name: 'Plan', icon_color: 7322096 } };
const inTopic = (text) => ({ message_id: ++mid, date: now(), chat: CHAT, from: OPERATOR, text, is_topic_message: true, message_thread_id: 77, reply_to_message: root });
const NODE = (extra = {}) => ({
  node_name: 'nodeA', user_name: 'Operator',
  limbs: { telegram: { main: { account: 'nodea_bot' } } },
  networks: { telegram: { allowed_users: [42] } },
  agents: {
    lark: { configuration: 'egpt', handles: ['lark'], name: 'Lark', body_emoji: '🐦' },
    finch: { configuration: 'egpt', handles: ['finch'], name: 'Finch', body_emoji: '🐤' },
  },
  ...extra,
});
function topicState() {
  let s = ensureContact(emptyState(), 'telegram', TOPIC, { pushedName: 'Plan', slugHint: 'Plan' }).state;
  for (const being of ['lark', 'finch']) {
    s = recordThread(s, 'telegram', TOPIC, `${being}-thread`, '2026-10-01T00:00:00Z', being);
    s.contacts.telegram[TOPIC].agents[being].mode = 'mention';
  }
  return s;
}
// Each being answers through its own session (its thread names it); `script[being](prompt)` is its reply.
async function bootNode(script, config = NODE()) {
  await fs.mkdir(join(HOME, 'secrets'), { recursive: true });
  await fs.writeFile(join(HOME, 'secrets', 'telegram-main.token'), `${TOKEN}\n`);
  const api = fakeApi();
  const turns = [];
  let st = topicState();
  const app = await boot({
    readConfig: () => config,
    startTelegram: (opts) => startTelegramBridge({ ...opts, fetch: api.fetch }),
    makeSession: (opts) => {
      const being = String(opts.sessionId ?? '').split('-')[0];
      return { sessionId: opts.sessionId, async turn(m) { turns.push({ being, prompt: m }); return { text: script[being](m), sessionId: this.sessionId }; }, close() {} };
    },
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    ingest: false, tickMs: 0,
    log: { line: () => {} },
  });
  await vi.waitFor(() => expect(api.of('getUpdates').length).toBeGreaterThan(0));
  const posted = () => [...api.of('sendMessage'), ...api.of('editMessageText')].map((c) => c.body.text);
  const transcript = () => fs.readFile(Room.forChat('telegram', st.contacts.telegram[TOPIC].slug).transcriptPath, 'utf8').catch(() => '');
  return { app, api, turns, posted, transcript, of: (being) => turns.filter((t) => t.being === being) };
}
const count = (s, part) => s.split(part).length - 1;

describe('a Telegram node: one being\'s post addressing another wakes it, in the same topic', () => {
  it('Lark\'s "@finch …" wakes Finch in the topic; Lark is not woken again; the transcript holds Lark\'s line once', async () => {
    const n = await bootNode({ lark: () => '@finch can you check the plan?', finch: () => 'checked: the plan is fine' });
    n.api.updates(inTopic('@lark ask finch about the plan'));
    await vi.waitFor(() => expect(n.posted().some((t) => t?.includes('🐤 Finch: checked: the plan is fine'))).toBe(true), { timeout: 10_000 });
    expect(n.of('finch')).toHaveLength(1);
    expect(n.of('finch')[0].prompt).toContain('can you check the plan?');
    expect(n.of('lark')).toHaveLength(1);
    const edReply = n.api.of('sendMessage').find((c) => c.body.text.includes('checked: the plan is fine'));
    expect(edReply.body).toMatchObject({ chat_id: String(GROUP), message_thread_id: 77 });
    await vi.waitFor(async () => expect(await n.transcript()).toContain('checked: the plan is fine'));
    expect(count(await n.transcript(), 'can you check the plan?')).toBe(1);
    n.app.stop();
  });

  it('a reply that addresses nobody wakes nobody', async () => {
    const n = await bootNode({ lark: () => 'hola, aquí estoy', finch: () => 'should not run' });
    n.api.updates(inTopic('@lark hola'));
    await vi.waitFor(() => expect(n.posted().some((t) => t?.includes('🐦 Lark: hola, aquí estoy'))).toBe(true), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(n.of('finch')).toEqual([]);
    expect(n.of('lark')).toHaveLength(1);
    n.app.stop();
  });

  it('two beings that keep naming each other are paused by the loop guard', async () => {
    let i = 0;
    const n = await bootNode(
      { lark: () => `@finch ping ${++i}`, finch: () => `@lark pong ${++i}` },
      NODE({ loop_guard: { inbound: { turns: 3, window: 2 } } }),
    );
    n.api.updates(inTopic('@lark empieza'));
    await vi.waitFor(() => expect(n.posted().some((t) => /paused/i.test(t ?? ''))).toBe(true), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    // the operator's line wakes Lark (a human turn, not counted); each echo that wakes the other counts,
    // the third trips the guard, its turn still runs, and the next echo is suppressed
    expect(n.turns).toHaveLength(4);
    n.app.stop();
  });
});
