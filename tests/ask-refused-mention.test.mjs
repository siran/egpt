// ask-refused-mention.test.mjs — a being's line that names a being its sender (the bot, on Telegram) may not
// wake is no longer dropped silently: the chat is asked "pass it on?", and only someone who may wake that being
// (the Operator, or a member of its allowed_users lists, which join) may answer. A person off them is ignored, as
// before. The question and its answer are the ingest box's own (ingest.mjs createIngestAsks / answerOf, boot's
// answerIngest); yes hands the line, as it arrived, to that being alone (spine.dispatchApproved). The question
// expires (ingest.ttl_ms): its post counts the minutes down, is edited as they pass, and says it expired; after
// that the yes is ordinary chat.
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
import { mentionAsk, mentionExpired, withCountdown } from '../src/spine/ingest.mjs';
import { editAction } from '../src/dispatch-line.mjs';
import { encodeNodeSignature } from '../src/node-signature.mjs';
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

function buildSpine({ mode = 'mention', guard = null, ask = true, ours = [], agents = AGENTS, config: configOver = {}, ...extra } = {}) {
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, body: ev.body, senderId: ev.senderId, senderName: ev.senderName }); return { text: 'x' }; } };
  const config = { node_name: 'nodeA', dispatch: { auto_default_mode: mode }, ...configOver };
  const transcript = { logged: [], async log(ev, reply) { this.logged.push({ ev, reply }); } };
  const asks = [];
  const answers = [];
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: (chatId, id) => ours.includes(String(id)) },
    brain, identity: createIdentity({ now: () => 1000 }),
    router: createRouter({ getAgents: () => agents, getConfig: () => config }),
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

  it('nor does the question as it is edited — the countdown, the clock form, the expired line — in an echo or as an edit stage-direction, even in an "on" chat', async () => {
    const { spine, brain, asks } = buildSpine({ mode: 'on', ours: ['500'] });   // the bridge knows message #500 is ours
    const first = withCountdown(mentionAsk('lark', 'finch'), 600_000);
    const texts = [first, withCountdown(mentionAsk('lark', 'finch'), 61_000), `${mentionAsk('lark', 'finch')} · ⏳ until 14:15`, mentionExpired('lark', 'finch')];
    for (const [i, t] of texts.entries()) await spine.handleInbound(echo(t, null, { msgKey: `6${i}`, recorded: false }));
    for (const [i, t] of texts.entries()) {
      // a Beeper edit event: our own account, a stage direction on our own message #500, naming nobody (beeper.mjs _maybeEmitEdits)
      await spine.handleInbound(echo(editAction({ targetId: '500', oldText: first, newText: t }), null, { msgKey: '500', recorded: false, isStageDirection: true, atEStart: false, atEAnywhere: false, fromNode: undefined }));
    }
    await settle();
    expect(brain.calls).toEqual([]);
    expect(asks).toEqual([]);
  });

  it('every question line opens on a glyph, never on a being\'s name', () => {
    for (const t of [mentionAsk('lark', 'finch'), withCountdown(mentionAsk('lark', 'finch'), 600_000), mentionExpired('lark', 'finch')]) expect(t).toMatch(/^[❓⌛]/u);
  });
});

// The bot's echo arrives isSender + authorized (it is this node's own account), but a being's line is never the
// Operator (2026-11-07): the flags speak for a person only, so a being→being wake is always the question.
describe('a being\'s own line is never the Operator: it asks, a person does not', () => {
  const agents = { lark: { handles: ['lark'], conversation_defaults: { allowed_users: ['*'] } }, ghost: { handles: ['ghost'] }, finch: { handles: ['finch'], conversation_defaults: { allowed_users: ['42'] } } };
  const root = { conversation_defaults: { allowed_users: ['42'] } };   // the Operator, at the root

  it('an echo naming a being with NO list asks (it used to pass by isSender); nothing runs', async () => {
    const { spine, brain, asks } = buildSpine({ agents, config: root });
    await spine.handleInbound(echo('🐦 Lark: @ghost can you check the plan?'));
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    expect(asks[0].asked.map((a) => a.being)).toEqual(['ghost']);
    expect(brain.calls).toEqual([]);
  });

  it('an echo naming a being with an id list asks too, whoever the root names', async () => {
    const { spine, brain, asks } = buildSpine({ agents, config: root });
    await spine.handleInbound(echo(LINE));
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    expect(asks[0].asked.map((a) => a.being)).toEqual(['finch']);
    expect(brain.calls).toEqual([]);
  });

  it('LOCK: the Operator by id, and a person typing on the account, wake a being with no list — no question', async () => {
    const { spine, brain, asks } = buildSpine({ agents, config: root });
    await spine.handleInbound(person('@ghost hola', '42'));
    await spine.handleInbound(person('@ghost hola otra vez', '77', { isSender: true, authorized: true, msgKey: '8' }));
    await settle();
    expect(ran(brain)).toEqual(['ghost', 'ghost']);
    expect(asks).toEqual([]);
  });

  // BEEPER (operator 2026-11-07): every being posts through the operator's OWN account, so its post arrives
  // isSender + authorized with the account's id as sender, and its being only in the invisible frame. Ids name
  // people: a being's line (fromBeing, read off that frame) is admitted by a '*' alone, whoever's id it carries.
  describe('on Beeper, where a being posts as the account', () => {
    const ACCT = '@acct:example.com';
    const beeper = (over = {}) => ({ chatId: '!room', chatName: 'Plan', network: 'whatsapp', userId: ACCT, senderName: 'Account', isSender: true, authorized: true, msgKey: '500', msgTs: 1000, atEStart: false, atEAnywhere: true, ...over });
    const beingPost = (text, being = 'lark', node = 'nodeA') => ({ body: `${text}${encodeNodeSignature(node, being)}`, from: beeper() });
    const typed = (text, over = {}) => ({ body: text, from: beeper({ atEStart: true, ...over }) });
    const world = (finch) => ({ agents: { lark: { handles: ['lark'], conversation_defaults: { allowed_users: ['*'] } }, finch: { handles: ['finch'], conversation_defaults: { allowed_users: finch } } }, config: { conversation_defaults: { allowed_users: [ACCT] } } });

    it('a being\'s post naming a being whose list holds the account id wakes nobody, and the chat is asked', async () => {
      const { spine, brain, asks } = buildSpine(world([ACCT]));
      await spine.handleInbound(beingPost('🐦 Lark: @finch can you check the plan?'));
      await vi.waitFor(() => expect(asks).toHaveLength(1));
      expect(asks[0].asked.map((a) => a.being)).toEqual(['finch']);
      expect(asks[0].ev).toMatchObject({ senderId: ACCT, fromBeing: 'lark', fromNode: 'nodeA' });
      expect(brain.calls).toEqual([]);
    });

    it('the same post with "*" on that being wakes it, no question', async () => {
      const { spine, brain, asks } = buildSpine(world(['*']));
      await spine.handleInbound(beingPost('🐦 Lark: @finch can you check the plan?'));
      await settle();
      expect(ran(brain)).toEqual(['finch']);
      expect(asks).toEqual([]);
    });

    it('LOCK: the account owner typing the same line (no being in it) is still the Operator', async () => {
      const { spine, brain, asks } = buildSpine(world([ACCT]));
      await spine.handleInbound(typed('@finch hola'));
      await spine.handleInbound(typed('@finch hola otra vez', { msgKey: '501' }));
      await settle();
      expect(ran(brain)).toEqual(['finch', 'finch']);
      expect(asks).toEqual([]);
    });

    it('LOCK: another node\'s relayed frame (a node, no being) keeps its id behaviour: an id on the list wakes', async () => {
      const { spine, brain, asks } = buildSpine(world([ACCT]));
      await spine.handleInbound({ body: `@finch hola${encodeNodeSignature('nodeB')}`, from: beeper({ atEStart: true }) });
      await settle();
      expect(ran(brain)).toEqual(['finch']);
      expect(asks).toEqual([]);
    });
  });

  it('LOCK: the Operator wakes a being whose list does not name it, no question', async () => {
    const { spine, brain, asks } = buildSpine({ agents: { ...agents, finch: { handles: ['finch'], conversation_defaults: { allowed_users: ['88'] } } }, config: root });
    await spine.handleInbound(person('@finch hola', '42'));
    await settle();
    expect(ran(brain)).toEqual(['finch']);
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
    editMessageText: () => (api.editsRefused ? { status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }) } : ok(true)),
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
  const api = {
    fetch, calls, editsRefused: false,
    updates: (...msgs) => push(ok(msgs.map((message) => ({ update_id: ++updateId, message })))),
    of: (method) => calls.filter((c) => c.method === method),
  };
  return api;
}

const now = () => Math.floor(Date.now() / 1000);
let mid = 300;
const root = { message_id: 77, date: now(), chat: CHAT, from: ME, is_topic_message: true, message_thread_id: 77, forum_topic_created: { name: 'Plan', icon_color: 7322096 } };
const inTopic = (text, from = OPERATOR, quoted = root) => ({ message_id: ++mid, date: now(), chat: CHAT, from, text, is_topic_message: true, message_thread_id: 77, reply_to_message: quoted });
// finchList: who Finch's own list adds (Sam, by default: an owner is not on it, and wakes Finch all the same); ingest: the `ingest:` block.
const NODE = ({ finchList = [88], ingest = null } = {}) => ({
  node_name: 'nodeA', user_name: 'Operator',
  limbs: { telegram: { main: { account: 'nodea_bot' } } },
  networks: { telegram: { allowed_users: [42] } },
  ...(ingest ? { ingest } : {}),
  agents: {
    lark: { configuration: 'egpt', handles: ['lark'], name: 'Lark', body_emoji: '🐦' },
    finch: { configuration: 'egpt', handles: ['finch'], name: 'Finch', body_emoji: '🐤', conversation_defaults: { allowed_users: finchList } },
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
async function bootNode(script, { io = null, now = null, finchList, ingest } = {}) {
  await fs.mkdir(join(HOME, 'secrets'), { recursive: true });
  await fs.writeFile(join(HOME, 'secrets', 'telegram-main.token'), `${TOKEN}\n`);
  const api = fakeApi();
  const turns = [];
  const lines = [];
  let st = topicState();
  const app = await boot({
    readConfig: () => NODE({ finchList, ingest }),
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
    ...(now ? { now } : {}),
    log: { line: (l) => lines.push(l) },
  });
  await vi.waitFor(() => expect(api.of('getUpdates').length).toBeGreaterThan(0));
  const posted = () => [...api.of('sendMessage'), ...api.of('editMessageText')].map((c) => c.body.text);
  const questions = () => api.of('sendMessage').filter((c) => c.body.text?.includes('pass it on?'));
  const answerTo = (q, text, from = MEMBER) => api.updates(inTopic(text, from, { message_id: q.id, chat: CHAT, from: ME, text: q.body.text, is_topic_message: true, message_thread_id: 77 }));
  const transcript = () => fs.readFile(Room.forChat('telegram', st.contacts.telegram[TOPIC].slug).transcriptPath, 'utf8').catch(() => '');
  // the edits of one post (a streamed reply is edited too: only the question's are counted)
  const edits = (q) => api.of('editMessageText').filter((c) => c.body.message_id === (q?.id ?? 501)).map((c) => c.body.text);
  // the spine's own pulse, awaited (the tick starts the pass over the open questions and does not wait for it): wait out
  // any pass already running, tick, wait for the one that tick started. Every edit and write it made has landed on return.
  const pulse = async () => { await app.asksIdle(); app.spine.tick(); await app.asksIdle(); };
  return { app, api, turns, lines, posted, questions, answerTo, transcript, edits, pulse, of: (being) => turns.filter((t) => t.being === being) };
}
const SCRIPT = { lark: () => '@finch can you check the plan?', finch: () => 'checked: the plan is fine' };
const count = (s, part) => s.split(part).length - 1;
// Lark answers the operator naming Finch; the bot is not on Finch's list, so the chat is asked.
async function larkNamesFinch(n) {
  n.api.updates(inTopic('@lark ask finch about the plan'));
  await vi.waitFor(() => expect(n.questions()).toHaveLength(1), { timeout: 10_000 });
  // the question is on the store only once boot logs "asked" (after the post's id came back and the entry was written)
  await vi.waitFor(() => expect(n.lines.some((l) => /\[ingest\] @finch .*: asked \(#/.test(l))).toBe(true), { timeout: 10_000 });
  return n.questions()[0];
}

describe('a Telegram node: Lark\'s post names Finch, whose list the bot is not on', () => {
  it('the topic is asked, nobody runs; the question names who said it and to whom, and is not itself echoed', async () => {
    const n = await bootNode(SCRIPT);
    const q = await larkNamesFinch(n);
    expect(q.body).toMatchObject({ chat_id: String(GROUP), message_thread_id: 77, text: withCountdown(mentionAsk('lark', 'finch'), 600_000) });
    expect(q.body.text).toBe('❓ lark → finch: pass it on? reply yes / no · ⏳ 10 min');
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

  it('a "yes" from a stranger is ordinary chat: ignored, the question stays open for whoever may wake Finch', async () => {
    const n = await bootNode(SCRIPT);
    const q = await larkNamesFinch(n);
    n.answerTo(q, 'yes', STRANGER);
    n.answerTo(q, 'no', STRANGER);
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    expect(n.of('finch')).toEqual([]);
    expect(n.posted().some((t) => t?.includes('dispatched') || t?.includes('dropped'))).toBe(false);
    n.answerTo(q, 's');                                         // Sam, on Finch's list
    await vi.waitFor(() => expect(n.of('finch')).toHaveLength(1), { timeout: 10_000 });
    expect(n.lines.some((l) => /\[ingest\] @finch .*: dispatched by Sam/.test(l))).toBe(true);
    expect(n.lines.some((l) => /dispatched by Maya/.test(l))).toBe(false);
    n.app.stop();
  });

  it('the node\'s owner may answer too, on Finch\'s list or not: the Operator is always allowed (2026-11-07)', async () => {
    const n = await bootNode(SCRIPT);
    const q = await larkNamesFinch(n);
    n.answerTo(q, 'yes', OPERATOR);
    await vi.waitFor(() => expect(n.of('finch')).toHaveLength(1), { timeout: 10_000 });
    expect(n.lines.some((l) => /\[ingest\] @finch .*: dispatched by Operator/.test(l))).toBe(true);
    n.app.stop();
  });

  it('the node\'s owner may always answer: Finch\'s list holds only Sam, and the owner\'s yes still wakes Finch alone', async () => {
    const n = await bootNode(SCRIPT);
    const q = await larkNamesFinch(n);
    n.answerTo(q, 'yes', OPERATOR);
    await vi.waitFor(() => expect(n.of('finch')).toHaveLength(1), { timeout: 10_000 });
    expect(n.of('finch')[0].prompt).toContain('can you check the plan?');
    expect(n.lines.some((l) => /\[ingest\] @finch tg:-1001234\/77: dispatched by Operator/.test(l))).toBe(true);
    expect(n.of('lark')).toHaveLength(1);                       // the owner's yes woke nobody else
    n.app.stop();
  });

  it('the owner\'s "no" drops it too; the list\'s member may still answer a question the owner left open', async () => {
    const a = await bootNode(SCRIPT);
    await larkNamesFinch(a).then((q) => a.answerTo(q, 'no', OPERATOR));
    await vi.waitFor(() => expect(a.posted().some((t) => t?.includes('🚫 dropped'))).toBe(true), { timeout: 10_000 });
    expect(a.of('finch')).toEqual([]);
    a.app.stop();
  });

  it('an empty list (allowed_users: []) adds nobody, yet the owner answers; a stranger and Sam still cannot', async () => {
    const n = await bootNode(SCRIPT, { finchList: [] });
    const q = await larkNamesFinch(n);
    n.answerTo(q, 'yes', STRANGER);
    n.answerTo(q, 'yes', MEMBER);
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    expect(n.of('finch')).toEqual([]);
    n.answerTo(q, 'yes', OPERATOR);
    await vi.waitFor(() => expect(n.of('finch')).toHaveLength(1), { timeout: 10_000 });
    n.app.stop();
  });

  it('a list that excludes the owner does not shut the owner out — of the answer, nor of waking Finch directly (the lists join, 2026-11-07); a stranger still wakes nothing', async () => {
    const n = await bootNode(SCRIPT, { finchList: [88] });
    const q = await larkNamesFinch(n);
    n.answerTo(q, 'yes', OPERATOR);
    await vi.waitFor(() => expect(n.of('finch')).toHaveLength(1), { timeout: 10_000 });
    n.api.updates(inTopic('@finch hola', STRANGER));             // Finch\'s lists still decide for anyone who is not the Operator
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    expect(n.of('finch')).toHaveLength(1);                      // answering the question made nobody a waker of Finch
    n.api.updates(inTopic('@finch hola, again', OPERATOR));
    await vi.waitFor(() => expect(n.of('finch')).toHaveLength(2), { timeout: 10_000 });   // the Operator is on none of Finch\'s lists and wakes it all the same
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

  it('the ingest box\'s question beside it: an owner answers that one, a member of Finch\'s list only this one (the owner may answer this one too)', async () => {
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
    n.answerTo(q, 'yes');                                       // Sam, on Finch's list: answers Finch's question
    await vi.waitFor(() => expect(n.of('finch')).toHaveLength(1), { timeout: 10_000 });
    n.app.stop();
  });
});

// ── the question runs out (ingest.ttl_ms, default 10 minutes) ────────────────────────────────────────────
describe('a Telegram node: the open question expires', () => {
  const T0 = Date.now();
  const MIN = 60_000;
  const fakeClock = () => { let t = T0; return { now: () => t, advance: (ms) => { t += ms; } }; };
  const asksPath = join(HOME, 'state', 'ingest-asks.json');
  const memIo = (initial = null) => {
    const files = new Map(initial ? [[asksPath, JSON.stringify(initial)]] : []);
    return { files, readFile: async (p) => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p); }, writeFile: async (p, d) => { files.set(p, String(d)); }, rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); }, mkdir: async () => {} };
  };
  const stored = (io) => JSON.parse(io.files.get(asksPath) ?? 'null');
  const ASK = mentionAsk('lark', 'finch');

  it('the post counts down once a minute, edited in place: an edit only when the shown value changes', async () => {
    const clock = fakeClock();
    const n = await bootNode(SCRIPT, { now: clock.now });
    const q = await larkNamesFinch(n);
    expect(q.body.text).toBe(`${ASK} · ⏳ 10 min`);
    clock.advance(25_000); await n.pulse();
    expect(n.edits(q)).toEqual([]);                             // 9:35 left still reads 10 min
    clock.advance(40_000); await n.pulse();                    // 8:55
    expect(n.edits(q)).toEqual([`${ASK} · ⏳ 9 min`]);
    expect(n.api.of('editMessageText').find((c) => c.body.message_id === q.id).body).toMatchObject({ chat_id: String(GROUP), message_id: q.id });
    await n.pulse(); await n.pulse();
    clock.advance(5_000); await n.pulse();
    expect(n.edits(q)).toHaveLength(1);                         // the same minute: nothing more
    clock.advance(MIN); await n.pulse();
    expect(n.edits(q)).toEqual([`${ASK} · ⏳ 9 min`, `${ASK} · ⏳ 8 min`]);
    expect(n.questions()).toHaveLength(1);                      // edits are not new questions
    expect(n.turns.filter((t) => t.being === 'finch')).toEqual([]);
    n.app.stop();
  });

  it('at the deadline the question is edited to say it expired, the entry leaves the store and a line is logged; a later yes is ordinary chat', async () => {
    const clock = fakeClock();
    const io = memIo();
    const n = await bootNode(SCRIPT, { now: clock.now, io });
    const q = await larkNamesFinch(n);
    expect(stored(io)).toHaveLength(1);
    clock.advance(10 * MIN); await n.pulse();
    expect(n.edits(q).at(-1)).toBe('⌛ lark → finch: expired, not passed on');
    expect(n.edits(q).at(-1)).toBe(mentionExpired('lark', 'finch'));
    expect(n.api.of('editMessageText').at(-1).body).toMatchObject({ message_id: q.id });
    expect(stored(io)).toEqual([]);
    expect(n.lines.some((l) => /\[ingest\] @finch tg:-1001234\/77: expired \(#501\) — lark's line not passed on$/.test(l))).toBe(true);
    n.answerTo(q, 'yes');                                       // Sam, on the list: too late
    n.answerTo(q, 'yes', OPERATOR);                             // the owner: too late
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    expect(n.of('finch')).toEqual([]);
    expect(n.posted().some((t) => t?.includes('dispatched'))).toBe(false);
    expect(n.edits(q).filter((t) => t.includes('expired'))).toHaveLength(1);
    n.app.stop();
  });

  it('a yes at the deadline, before the pulse took the entry out, is already not an answer', async () => {
    const clock = fakeClock();
    const n = await bootNode(SCRIPT, { now: clock.now });
    const q = await larkNamesFinch(n);
    clock.advance(10 * MIN);
    n.answerTo(q, 'yes');
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    expect(n.of('finch')).toEqual([]);
    await n.pulse();
    expect(n.edits(q).at(-1)).toBe(mentionExpired('lark', 'finch'));
    n.app.stop();
  });

  it('a restart keeps the deadline: the next boot counts down from it and expires on it, not from its own clock', async () => {
    const clock = fakeClock();
    const io = memIo();
    const first = await bootNode(SCRIPT, { now: clock.now, io });
    const q = await larkNamesFinch(first);
    first.app.stop();
    expect(stored(io)[0]).toMatchObject({ expiresAt: T0 + 10 * MIN, shown: 10, post: { id: String(q.id), text: ASK, expired: mentionExpired('lark', 'finch') } });

    clock.advance(7 * MIN);
    const second = await bootNode(SCRIPT, { now: clock.now, io });
    expect(stored(io)[0].expiresAt).toBe(T0 + 10 * MIN);
    await second.pulse();
    expect(second.edits(q)).toEqual([`${ASK} · ⏳ 3 min`]);
    expect(second.api.of('editMessageText')[0].body).toMatchObject({ message_id: q.id });   // the post the first boot made
    clock.advance(3 * MIN); await second.pulse();
    expect(second.edits(q).at(-1)).toBe(mentionExpired('lark', 'finch'));
    expect(stored(io)).toEqual([]);
    second.app.stop();
  });

  // The store as the code before expiry wrote it: no deadline, no post.
  async function legacyStore(clock) {
    const io = memIo();
    const first = await bootNode(SCRIPT, { now: clock.now, io });
    const q = await larkNamesFinch(first);
    first.app.stop();
    io.files.set(asksPath, JSON.stringify(stored(io).map(({ expiresAt, shown, post, ...old }) => old)));
    expect(Object.keys(stored(io)[0]).sort()).toEqual(['being', 'chatId', 'ev', 'ids', 'target']);
    return { io, q };
  }

  it('a question stored before expiry existed gets a fresh deadline at load (not expired at once) and is answerable until then', async () => {
    const clock = fakeClock();
    const { io, q } = await legacyStore(clock);
    clock.advance(30 * MIN);                                    // however long the old question has been open
    const n = await bootNode(SCRIPT, { now: clock.now, io });
    expect(stored(io)[0]).toMatchObject({ ids: [String(q.id)], expiresAt: clock.now() + 10 * MIN });
    expect(n.lines.some((l) => /1 open question\(s\) from before expiry now close in 10 min/.test(l))).toBe(true);
    await n.pulse();
    expect(stored(io)).toHaveLength(1);
    expect(n.edits(q)).toEqual([]);                             // no post of its own is known: nothing to count down
    clock.advance(9 * MIN);
    n.answerTo(q, 'yes');
    await vi.waitFor(() => expect(n.of('finch')).toHaveLength(1), { timeout: 10_000 });
    n.app.stop();
  });

  it('a legacy question that then runs out expires silently: logged, no edit and nothing said in the chat, and a yes after it is ordinary chat', async () => {
    const clock = fakeClock();
    const { io, q } = await legacyStore(clock);
    const n = await bootNode(SCRIPT, { now: clock.now, io });
    const said = n.api.of('sendMessage').length;
    clock.advance(10 * MIN); await n.pulse();
    expect(stored(io)).toEqual([]);
    expect(n.edits(q)).toEqual([]);
    expect(n.api.of('sendMessage')).toHaveLength(said);          // no line, however many were open
    expect(n.lines.some((l) => /@finch .* expired \(#501\) — lark's line not passed on \(asked before expiry existed: nothing said in the chat\)$/.test(l))).toBe(true);
    n.answerTo(q, 'yes');                                       // Sam, on the list: too late
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    expect(n.of('finch')).toEqual([]);
    expect(n.posted().some((t) => t?.includes('dispatched'))).toBe(false);
    n.app.stop();
  });

  it('ingest.ttl_ms sets the length, and 0 means never: no countdown, no deadline', async () => {
    const clock = fakeClock();
    const a = await bootNode(SCRIPT, { now: clock.now, ingest: { ttl_ms: 3 * MIN } });
    const q = await larkNamesFinch(a);
    expect(q.body.text).toBe(`${ASK} · ⏳ 3 min`);
    clock.advance(3 * MIN); await a.pulse();
    expect(a.edits(q).at(-1)).toBe(mentionExpired('lark', 'finch'));
    a.app.stop();

    const io = memIo();
    const b = await bootNode(SCRIPT, { now: clock.now, io, ingest: { ttl_ms: 0 } });
    const qb = await larkNamesFinch(b);
    expect(qb.body.text).toBe(ASK);
    expect(stored(io)[0]).not.toHaveProperty('expiresAt');
    clock.advance(72 * 60 * MIN); await b.pulse();
    expect(b.edits(qb)).toEqual([]);
    b.answerTo(qb, 'yes');
    await vi.waitFor(() => expect(b.of('finch')).toHaveLength(1), { timeout: 10_000 });
    b.app.stop();
  });

  it('a post Telegram will not edit: tried once, left as posted, a new line says the end; nothing throws', async () => {
    const clock = fakeClock();
    const n = await bootNode(SCRIPT, { now: clock.now });
    const q = await larkNamesFinch(n);
    n.api.editsRefused = true;
    clock.advance(61_000); await n.pulse();
    clock.advance(MIN); await n.pulse();
    clock.advance(MIN); await n.pulse();
    expect(n.edits(q)).toHaveLength(1);                         // tried once; no hammering a post that refuses
    expect(n.lines.some((l) => /the post #501 would not take an edit/.test(l))).toBe(true);
    clock.advance(10 * MIN); await n.pulse();
    expect(n.edits(q)).toHaveLength(1);
    expect(n.api.of('sendMessage').at(-1).body.text).toBe(mentionExpired('lark', 'finch'));
    n.app.stop();
  });
});
