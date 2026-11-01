// tests/split-tunnel.test.mjs — the split tunnel (operator 2026-10-31).
//
// 1. While chat X has an open /split, a being invoked in X answers on X's own thread (X's rules), but
//    its reply is posted in the split, through the split's mouth; nothing goes into X. Several open
//    splits → the most recent. /end on the split → replies come back to X.
// 2. That reply, coming back in the split, is recorded there as X's being's ("E from [X]"), so the
//    split's being reads it in its accum as the original E speaking, not as its own words.
// 3. In the split, anyone may call the being /split was typed to (allowed_users ['*'] on the split).
// 4. `/<handle> split invite [<name>]` also invites X's members; plain `/split` is unchanged.
// Never a real Beeper call: forkBridge and the bridge are fakes.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-split-tunnel-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { rmSync } from 'node:fs';
import { createCommands } from '../src/spine/commands.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender, THINKING } from '../src/spine/sender.mjs';
import { createReplyActions } from '../src/spine/reply-actions.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { ensureContact, recordThread, getContact, patchContact, forkContact, serialize, parse } from '../src/conversations-state.mjs';
import { shortChatId } from '../src/bridges/chat-id.mjs';
import { encodeNodeSignature, encodeChatCanary, decodeChatCanary } from '../src/node-signature.mjs';
import { makeWrapPersona } from '../src/bridges/persona-wrap.mjs';
import { replyLine } from '../src/transcript-log.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const ORIGIN = 'palma1';
const TITLE = '🌴FAMILIA PALMA🌴';
const SPLIT = shortChatId('!side1:beeper.local');
const SPLIT2 = shortChatId('!side2:beeper.local');
const SPLIT_TITLE = `SI+${TITLE}-viaje`;
const AN = '+16468217865';
const RODZ = '+13472576794';
const RODZ_DIGITS = '13472576794';
const RODZ_USER_ID = '@whatsapp_lid-69433129173200:beeper.local';
const AN_ID = '@anrodriguez:beeper.com';
const LULU = '@whatsapp_lid-lulu42:beeper.local';
const PEPE = '@whatsapp_lid-pepe7:beeper.local';
const FULVIO = '@whatsapp_lid-fulvio9:beeper.local';
const SPEAKER = `E from [${TITLE}]`;

const OPEN = { e: { handles: ['e'], conversation_defaults: { allowed_users: ['*'] } } };   // E answers anyone
const OWNERS = { e: { handles: ['e'] } };                                                   // E answers its owners only
// `tunnel`: config.yaml split.tunnel (on here unless a test says otherwise; null = unset).
const cfg = ({ agents = OPEN, mode = 'mention', tunnel = true } = {}) => ({
  beeper: { primary: { phone: AN }, secondary: { phone: RODZ } },
  node_name: 'kg', group_title: '{group}-{name}', agents, dispatch: { auto_default_mode: mode },
  ...(tunnel == null ? {} : { split: { tunnel } }),
});
const LIVE = { participants: { items: [{ id: AN_ID, phoneNumber: AN, isSelf: true }, { id: RODZ_USER_ID, phoneNumber: RODZ }, { id: LULU, phoneNumber: '+34600000000' }, { id: PEPE, phoneNumber: '+34611111111' }] } };

function seedState(entry = {}) {
  let st = ensureContact({ contacts: {} }, 'whatsapp', ORIGIN, { pushedName: TITLE }).state;
  st = recordThread(st, 'whatsapp', ORIGIN, 'palma-e-thread', '2026-10-01T00:00:00Z', 'e');
  return Object.keys(entry).length ? patchContact(st, 'whatsapp', ORIGIN, entry) : st;
}

function harness({ config = cfg(), state = seedState(), chatRaw = async () => LIVE, created = ['!side1:beeper.local', '!side2:beeper.local'], topicParentOf = () => null } = {}) {
  let st = state;
  const logs = [];
  const calls = { create: [], post: [], archive: [] };
  const forkBridge = {
    editMessage: async () => true,
    createGroup: async (opts, o = {}) => { calls.create.push({ ...opts, via: o.via ?? null }); return { chatID: created[calls.create.length - 1] }; },
    postReply: async (chatId, text, replyTo, opts = {}) => { calls.post.push({ chatId, text, via: opts.via ?? null }); return { ok: true, confirmedId: Promise.resolve('op-1') }; },
    archiveChat: async (chatId) => { calls.archive.push(chatId); return true; },
    chatAccountId: async () => 'whatsapp',
    chatRaw,
    chatTitle: async () => null,
    resolveUserIdByPhone: async (digits) => (digits === RODZ_DIGITS ? RODZ_USER_ID : null),
    awaitMouthMessage: async () => null,
    topicParentOf,
    listMessagesRaw: async () => [{ id: 'q1', text: 'la respuesta' }],
  };
  const cmds = createCommands({
    getConfig: () => config, send: async () => {},
    loadState: async () => st, writeState: async (s) => { st = s; },
    forkBridge, reportUndelivered: async () => true, onLog: (m) => logs.push(m),
  });
  return { cmds, calls, logs, config, getState: () => st };
}
const inChat = (chatId, chatName, body, extra = {}) => ({ chatId, surface: 'whatsapp', chatName, senderId: LULU, senderName: 'Lulu', msgId: 'm1', body, raw: { chatType: 'group' }, ...extra });
const inOrigin = (body, extra) => inChat(ORIGIN, TITLE, body, extra);
const asOperator = { senderId: AN_ID, senderName: 'An', isSender: true, authorized: true };
async function typed(h, ev) {
  const cmd = h.cmds.commandOf(ev) ?? ev;
  if (!(await h.cmds.isCommand(cmd))) return 'not a command';
  return h.cmds.run(cmd);
}

function streamingBridge() {
  const streams = [], sent = [], reactions = [];
  return {
    streams, sent, reactions,
    onMessage() {}, stop() {}, wasSentByUs: () => false,
    send(chat, text, opts) { sent.push({ chat, text, opts }); return { ok: true, confirmedId: `${chat}#s${sent.length}` }; },
    react(chat, msgId, emoji) { reactions.push({ chat, msgId, emoji }); return true; },
    startStream(chat, init, opts) {
      const s = { chat, init, opts, finals: [], delivered: false, confirmedId: `${chat}#${streams.length + 1}`, update() {}, async finish(t) { s.finals.push(t); s.delivered = true; } };
      streams.push(s);
      return s;
    },
  };
}
const labelOf = (b) => (b === 'e' ? 'E' : String(b));
// The real spine, gating (its side-group seam on the real commands), router (reading the state),
// identity and sender; a transcript that keeps each chat's lines, read back for accum.
// `limbs`: wire the reply actions (a mouth that holds every chat, so a /react is placed).
function buildSpine(h, { replies = {}, timers = null, limbs = false } = {}) {
  const files = new Map();
  const add = (chatId, line) => files.set(chatId, [...(files.get(chatId) ?? []), line]);
  const transcript = {
    async log(ev, reply) {
      add(ev.chatId, reply == null ? (ev.line ?? ev.body) : replyLine({ being: labelOf(reply.being), body: reply.text, surfaced: reply.surfaced !== false, chatName: ev.chatName, node: ev.node, surface: ev.surface }));
    },
  };
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, chatId: ev.chatId, line: ev.line }); return { text: replies[ev.chatId] ?? 'ok', being }; } };
  const bridge = streamingBridge();
  const logs = [];
  const actions = limbs ? createReplyActions({ bridge, peerMouth: { route: async () => null, mouthIsElsewhere: () => false }, bodyEmojiOf: () => '🐶', labelOf, onLog: (m) => logs.push(m) }) : undefined;
  const spine = createSpine({
    bridge, brain, actions, identity: createIdentity({ now: () => 1000 }),
    router: createRouter({ getAgents: () => h.config.agents, getConfig: () => h.config, loadState: async () => h.getState() }),
    gating: createGating({ getConfig: () => h.config, loadState: async () => h.getState(), sideGroupFor: (ev, o) => h.cmds.autoSideGroup(ev, o) }),
    commands: h.cmds, sender: createSender({ bridge, labelOf }), transcript, heartbeats: { runDue() {} },
    readTranscript: async (chatId) => (files.get(chatId) ?? []).join('\n\n'),
    mesh: { isEnvelope: () => false, async handle() {} },
    fromThisNode: (ev) => ev?.fromNode != null && String(ev.fromNode).toLowerCase() === 'kg',
    isSelfChat: () => false, clock: { now: () => 1000 }, turnTimeoutMs: 0, labelOf,
    ...(timers ? { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } : {}),
  });
  const opened = () => [...bridge.streams.map((s) => ({ chatId: s.chat, replyTo: s.opts?.replyTo ?? null, canary: s.opts?.canary ?? null })), ...bridge.sent.map((s) => ({ chatId: s.chat, replyTo: s.opts?.replyTo ?? null, canary: s.opts?.canary ?? null }))];
  return { spine, brain, bridge, files, logs, opened, chats: () => opened().map((o) => o.chatId) };
}
const from = (over = {}) => ({ network: 'whatsapp', chatId: ORIGIN, chatName: TITLE, userId: LULU, senderName: 'Lulu', isSender: false, ...over });
let n = 0;
const say = (spine, body, over = {}) => { const { atEStart, atEAnywhere } = mentionStatus(body, ['e']); return spine.handleInbound({ body, from: from({ msgKey: `k${++n}`, atEStart, atEAnywhere, ...over }) }); };
const inSplit = (over = {}) => ({ chatId: SPLIT, chatName: SPLIT_TITLE, userId: PEPE, senderName: 'Pepe', ...over });
// What the split hears when Rodz posts the tunnelled reply there: the frame the sender's tag renders.
const wrap = makeWrapPersona({ nodeName: 'kg' });
const rodzPosts = (spine, stream, text) => spine.handleInbound({ body: wrap(stream.opts, text), from: from(inSplit({ userId: RODZ_USER_ID, senderName: 'Rodz', msgKey: `r${++n}` })) });

beforeEach(() => { rmSync(HOME, { recursive: true, force: true }); });

// ── 1. the tunnel ────────────────────────────────────────────────────────────────────────────────
describe('while X has an open split, its replies go to the split', () => {
  it('REPRODUCE: E invoked in X answers on X\'s thread, posted in the split, unquoted; nothing goes into X', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h, { replies: { [ORIGIN]: 'respuesta de X' } });
    await say(b.spine, 'e, hola');
    expect(b.brain.calls.map((c) => [c.being, c.chatId])).toEqual([['e', ORIGIN]]);
    expect(b.opened()).toEqual([{ chatId: SPLIT, replyTo: null, canary: { group: SPLIT, origin: ORIGIN, kind: 'tunnel', speaker: SPEAKER } }]);
    expect(b.chats()).not.toContain(ORIGIN);
    expect(b.files.get(ORIGIN).at(-1)).toMatch(/^E@\[.*\]\.wa \(\d\d:\d\d\): respuesta de X$/);   // X's own record
    expect(b.files.get(SPLIT)).toBeUndefined();
    expect(Object.keys(h.getState().contacts.whatsapp[SPLIT])).not.toContain('split');   // /split writes no mark
  });

  // Opt-in (operator 2026-11-01): the split entry's split.tunnel, else config.yaml split.tunnel, else no.
  const handMade = (split) => {
    const st = forkContact(seedState(), 'whatsapp', SPLIT, ORIGIN, { pushedName: SPLIT_TITLE, transcript: SPLIT_TITLE });
    return split ? patchContact(st, 'whatsapp', SPLIT, { split }) : st;
  };
  for (const [what, split, tunnel, to] of [
    ['REPRODUCE: nothing set → no tunnel', null, null, ORIGIN],
    ['the entry\'s split: {tunnel: true}, config unset → tunnels', { tunnel: true }, null, SPLIT],
    ['config split.tunnel: true, the entry says nothing → tunnels', null, true, SPLIT],
    ['REPRODUCE: the entry\'s split: {tunnel: false} wins over config true → no tunnel', { tunnel: false }, true, ORIGIN],
    ['the entry\'s split: {tunnel: true} wins over config false → tunnels', { tunnel: true }, false, SPLIT],
  ]) {
    it(what, async () => {
      const b = buildSpine(harness({ config: cfg({ tunnel }), state: handMade(split) }));
      await say(b.spine, 'e, hola');
      expect(b.chats()).toEqual([to]);
    });
  }

  it('the entry\'s split: block survives a rewrite of the entry and of the file', () => {
    const st = parse(serialize(patchContact(handMade({ tunnel: true }), 'whatsapp', SPLIT, { mouth_chat: 'sec-room' })));
    expect(st.contacts.whatsapp[SPLIT]).toMatchObject({ parent_chat: ORIGIN, transcript: SPLIT_TITLE, mouth_chat: 'sec-room', split: { tunnel: true } });
  });

  it('X\'s invocation rules hold: a line E is not asked for runs nothing, in X or in the split', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h);
    await say(b.spine, 'hola a todos');
    expect(b.brain.calls).toEqual([]);
    expect(b.opened()).toEqual([]);
  });

  it('several open splits: the most recent takes the replies; /end on it hands them to the one before', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split uno'));
    await typed(h, inOrigin('/e split dos', { msgId: 'm2' }));
    const b = buildSpine(h);
    await say(b.spine, 'e, hola');
    await typed(h, inChat(SPLIT2, `SI+${TITLE}-dos`, '/e end'));
    await say(b.spine, 'e, otra vez');
    expect(b.chats()).toEqual([SPLIT2, SPLIT]);
  });

  it('regression lock: after /end on the split, replies come back to X', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h);
    await say(b.spine, 'e, hola');
    await typed(h, inChat(SPLIT, SPLIT_TITLE, '/e end'));
    await say(b.spine, 'e, ¿sigues?');
    expect(b.opened()).toEqual([
      { chatId: SPLIT, replyTo: null, canary: expect.objectContaining({ kind: 'tunnel' }) },
      { chatId: ORIGIN, replyTo: expect.any(String), canary: null },
    ]);
  });

  it('regression lock: a chat with no split replies in place', async () => {
    const b = buildSpine(harness());
    await say(b.spine, 'e, hola');
    expect(b.opened()).toEqual([{ chatId: ORIGIN, replyTo: expect.any(String), canary: null }]);
  });

  it('regression lock: reply_in_side_group with no split still goes to its SI+ group, as an alias, unmarked', async () => {
    const h = harness({ state: seedState({ reply_in_side_group: true }) });
    const b = buildSpine(h);
    await say(b.spine, 'e, hola');
    expect(h.calls.create.map((c) => c.title)).toEqual([`SI+${TITLE}`]);
    expect(b.opened()).toEqual([{ chatId: SPLIT, replyTo: null, canary: null }]);
    expect(h.getState().contacts.whatsapp[SPLIT].aliasOf).toBe(ORIGIN);
  });

  it('the split\'s own being answers in the split, in place, unmarked', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h);
    await say(b.spine, 'e, hola', inSplit());
    expect(b.brain.calls.map((c) => c.chatId)).toEqual([SPLIT]);
    expect(b.opened()).toEqual([{ chatId: SPLIT, replyTo: expect.any(String), canary: null }]);
  });

  it('auto: the dwelled reply goes to the split, plain, carrying the same mark', async () => {
    const pending = [];
    const timers = { setTimeout: (fn) => { pending.push(fn); return { unref() {} }; }, clearTimeout() {} };
    const h = harness({ config: cfg({ mode: 'auto' }) });
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h, { timers, replies: { [ORIGIN]: 'claro' } });
    await say(b.spine, 'alguien viene mañana?');
    for (let i = 0; i < 20 && pending.length; i++) { pending.splice(0).forEach((fn) => fn()); await new Promise((r) => setTimeout(r, 0)); }
    expect(b.bridge.sent.map((s) => [s.chat, s.opts.canary])).toEqual([[SPLIT, { group: SPLIT, origin: ORIGIN, kind: 'tunnel', speaker: SPEAKER }]]);
  });

  it('a Telegram topic split takes nothing: everyone is already in it', async () => {
    const h = harness({ topicParentOf: (id) => (id === SPLIT ? ORIGIN : null) });
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h);
    await say(b.spine, 'e, hola');
    expect(b.chats()).toEqual([ORIGIN]);
  });

  it('a split that is gone takes nothing; the reply stays in X, logged', async () => {
    const h = harness({ chatRaw: async (id) => (id === SPLIT ? false : LIVE) });
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h);
    await say(b.spine, 'e, hola');
    expect(b.chats()).toEqual([ORIGIN]);
    expect(h.logs.some((l) => l.startsWith(`tunnel: ${SPLIT}`))).toBe(true);
  });

  it('regression lock: /send from the split still copies a message back to X', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h);
    await say(b.spine, 'e, hola');
    h.calls.post.length = 0;
    await typed(h, inChat(SPLIT, SPLIT_TITLE, '/e send', { replyToId: 'q1', senderId: PEPE, senderName: 'Pepe' }));
    expect(h.calls.post).toEqual([expect.objectContaining({ chatId: ORIGIN, via: 'secondary' })]);
    expect(h.calls.post[0].text).toContain('la respuesta');
  });
});

// ── 2. the split's record says whose reply it is ─────────────────────────────────────────────────
describe('the tunnelled reply is recorded in the split as X\'s E', () => {
  it('REPRODUCE: split-E\'s accum shows the reply as "E from [X]", past its own last line, never as its own', async () => {
    const h = harness({ config: cfg({ mode: 'accum' }) });
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h, { replies: { [ORIGIN]: 'el viaje es el sábado', [SPLIT]: 'aquí estoy' } });
    await say(b.spine, 'e, hola', inSplit());                     // split-E's own last turn: its boundary
    await say(b.spine, 'e, cuéntales');                           // the original E, in X
    const tunnelled = b.bridge.streams.find((s) => s.opts?.canary?.kind === 'tunnel');
    await rodzPosts(b.spine, tunnelled, 'el viaje es el sábado');
    await say(b.spine, 'e, ¿qué dijo?', inSplit());
    expect(b.brain.calls.map((c) => c.chatId)).toEqual([SPLIT, ORIGIN, SPLIT]);
    const prompt = b.brain.calls[2].line;
    expect(prompt).toContain('THE FOLLOWING IS ACCUMULATED CONTEXT');
    expect(prompt).toMatch(new RegExp(`^${SPEAKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@\\[${SPLIT_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\.wa \\(\\d\\d:\\d\\d\\) #r\\d+: el viaje es el sábado<kg>$`, 'm'));
    expect(prompt).not.toContain('Rodz@');
    expect(prompt).not.toContain('aquí estoy');                   // its own line is the boundary, not context
    expect(h.logs.filter((l) => l.includes('unknown kind'))).toEqual([]);
  });

  it('the line and its edits name the origin\'s being; an opener canary, or one naming another chat, changes nothing', () => {
    const identity = createIdentity({ now: () => 1000 });
    const sig = encodeNodeSignature('kg', 'e');
    const tunnel = encodeChatCanary({ group: SPLIT, origin: ORIGIN, kind: 'tunnel', speaker: SPEAKER });
    const build = (body, over = {}) => identity.build({ body, from: from(inSplit({ userId: RODZ_USER_ID, senderName: 'Rodz', msgKey: '7', ...over })) });
    expect(build(`hola${sig}${tunnel}`).line).toMatch(new RegExp(`^E from \\[.*\\]@\\[.*\\]\\.wa \\(\\d\\d:\\d\\d\\) #7: hola<kg>$`));
    expect(build(`edited #7\n    - a${sig}${tunnel}\n    + b${sig}${tunnel}`, { isStageDirection: true }).line.startsWith(`[ ${SPEAKER}@[`)).toBe(true);
    expect(build(`hola${sig}${encodeChatCanary({ group: SPLIT, origin: ORIGIN, kind: 'split' })}`).line.startsWith('Rodz@[')).toBe(true);
    expect(build(`hola${sig}${encodeChatCanary({ group: 'elsewhere', origin: ORIGIN, kind: 'tunnel', speaker: SPEAKER })}`).line.startsWith('Rodz@[')).toBe(true);
  });

  it('the canary round-trips the speaker; the older kinds read as before', () => {
    const c = { group: SPLIT, origin: ORIGIN, kind: 'tunnel', speaker: SPEAKER };
    expect(decodeChatCanary(`x${encodeNodeSignature('kg', 'e')}${encodeChatCanary(c)}`)).toEqual(c);
    expect(decodeChatCanary(`x${encodeChatCanary({ group: SPLIT, origin: ORIGIN, kind: 'split' })}`)).toEqual({ group: SPLIT, origin: ORIGIN, kind: 'split', transcript: null });
  });
});

// ── 3. anyone in the split may call split-E ──────────────────────────────────────────────────────
describe('in the split, anyone may call the being /split was typed to', () => {
  it('REPRODUCE: a member E does not answer in X calls split-E in the split; X\'s rules are untouched', async () => {
    const h = harness({ config: cfg({ agents: OWNERS }) });
    await typed(h, inOrigin('/e split viaje'));
    expect(h.getState().contacts.whatsapp[SPLIT].agents.e.allowed_users).toEqual(['*']);
    expect(getContact(h.getState(), 'whatsapp', ORIGIN).entry.agents.e.allowed_users).toBeUndefined();
    const b = buildSpine(h);
    await say(b.spine, 'e, hola', from({ userId: PEPE, senderName: 'Pepe' }));
    await say(b.spine, 'e, hola', inSplit());
    expect(b.brain.calls.map((c) => c.chatId)).toEqual([SPLIT]);
  });

  it('only that being: another resident keeps the rules it had in X', async () => {
    let st = seedState();
    st = recordThread(st, 'whatsapp', ORIGIN, 'palma-ken-thread', '2026-10-01T00:00:00Z', 'ken');
    const h = harness({ config: cfg({ agents: { ...OWNERS, ken: { handles: ['ken'] } } }), state: st });
    await typed(h, inOrigin('/e split viaje'));
    expect(h.getState().contacts.whatsapp[SPLIT].agents.ken.allowed_users).toBeUndefined();
  });

  it('a being at access_level all is not opened: the split keeps its rules, logged', async () => {
    const h = harness({ config: cfg({ agents: { e: { handles: ['e'], conversation_defaults: { access_level: 'all' } } } }) });
    await typed(h, inOrigin('/e split viaje'));
    expect(h.getState().contacts.whatsapp[SPLIT].agents.e.allowed_users).toBeUndefined();
    expect(h.logs.some((l) => l.includes('access_level all'))).toBe(true);
  });
});

// ── 4. /split invite ─────────────────────────────────────────────────────────────────────────────
describe('/<handle> split invite [<name>] also invites the members of X', () => {
  it('REPRODUCE: a member\'s `/e split invite fulvio` invites Rodz + every member; the name is fulvio', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split invite fulvio'));
    expect(h.calls.create.map((c) => [c.title, c.participantIDs])).toEqual([[`SI+${TITLE}-fulvio`, [RODZ_USER_ID, LULU, PEPE]]]);
  });

  it('REPRODUCE: the operator\'s `/e split invite fulvio` in a 1:1 with Fulvio invites Rodz + Fulvio', async () => {
    const ONE = { participants: { items: [{ id: AN_ID, phoneNumber: AN, isSelf: true }, { id: FULVIO, phoneNumber: '+39300000000' }] } };
    let st = ensureContact({ contacts: {} }, 'whatsapp', 'fulvio1', { pushedName: 'Fulvio' }).state;
    st = recordThread(st, 'whatsapp', 'fulvio1', 'fulvio-e-thread', '2026-10-01T00:00:00Z', 'e');
    const h = harness({ state: st, chatRaw: async () => ONE });
    await typed(h, inChat('fulvio1', 'Fulvio', '/e split invite fulvio', { ...asOperator, raw: { chatType: 'single' } }));
    expect(h.calls.create.map((c) => [c.title, c.participantIDs])).toEqual([['SI+Fulvio-fulvio', [RODZ_USER_ID, FULVIO]]]);
  });

  it('`invite` alone: every member, a random name', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split INVITE'));
    const [c] = h.calls.create;
    expect(c.participantIDs).toEqual([RODZ_USER_ID, LULU, PEPE]);
    expect(/^[a-z0-9]{5}$/.test(c.title.slice(`SI+${TITLE}-`.length))).toBe(true);
  });

  it('regression lock: without `invite`, today\'s behaviour — the requester + Rodz (the operator: Rodz alone)', async () => {
    for (const [ev, ids, title] of [
      [inOrigin('/e split fulvio'), [RODZ_USER_ID, LULU], 'fulvio'],
      [inOrigin('/e split invited'), [RODZ_USER_ID, LULU], 'invited'],
      [inOrigin('/e split fulvio', asOperator), [RODZ_USER_ID], 'fulvio'],
    ]) {
      const h = harness();
      await typed(h, ev);
      expect(h.calls.create.map((c) => [c.title, c.participantIDs])).toEqual([[`SI+${TITLE}-${title}`, ids]]);
    }
  });
});

// ── 5. a tunnelled turn is quiet, and all it says is X's E's (operator 2026-11-01) ────────────────
// Live, S 10:41–10:46: every E turn in X opened "🐶 E: ⏳ Thinking…" in S, ending "✓" or "…"; a /reply
// went to S recorded as Rodz (split-E took it as its own words); a /react aimed at X's message.
describe('a tunnelled turn is quiet: only real content reaches the split, and it is X\'s E\'s', () => {
  const onChat = () => harness({ config: cfg({ mode: 'on' }) });
  const said = (b) => b.bridge.streams.map((s) => [s.chat, s.init, s.finals]);
  const lastId = () => `k${n}`;   // the msgKey `say` just gave X's line

  it('REPRODUCE: a reply that is \'…\' posts nothing in S and never opens a ⏳', async () => {
    const h = onChat();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h, { replies: { [ORIGIN]: '…' } });
    await say(b.spine, 'jaja');
    expect(b.brain.calls.map((c) => c.chatId)).toEqual([ORIGIN]);
    expect(said(b)).toEqual([]);
    expect(b.bridge.sent).toEqual([]);
  });

  it('REPRODUCE: a turn that only reacts posts nothing in S, and no reaction is placed', async () => {
    const h = onChat();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h, { limbs: true });
    b.brain.turn = async (being, ev) => { b.brain.calls.push({ chatId: ev.chatId }); return { text: `/react #${ev.msgId} 👍`, being }; };
    await say(b.spine, 'e prueba');
    expect(said(b)).toEqual([]);
    expect(b.bridge.sent).toEqual([]);
    expect(b.bridge.reactions).toEqual([]);
    expect(b.logs.filter((l) => l.includes('tunnel'))).toHaveLength(1);
  });

  it('REPRODUCE: a /reply is recorded in S under "E from [X]"', async () => {
    const h = onChat();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h, { limbs: true });
    b.brain.turn = async (being, ev) => ({ text: `/reply #${ev.msgId} Sí, todavía me llegan`, being });
    await say(b.spine, 'e aún respondes?');
    expect(said(b)).toEqual([]);
    expect(b.bridge.sent.map((s) => [s.chat, s.text])).toEqual([[SPLIT, 'Sí, todavía me llegan']]);
    expect(b.bridge.sent[0].opts.canary).toEqual({ group: SPLIT, origin: ORIGIN, kind: 'tunnel', speaker: SPEAKER });
    await rodzPosts(b.spine, b.bridge.sent[0], 'Sí, todavía me llegan');
    expect(b.files.get(SPLIT).at(-1).startsWith(`${SPEAKER}@[${SPLIT_TITLE}]`)).toBe(true);
  });

  it('real content is posted once, whole, in S — no ⏳ first', async () => {
    const h = onChat();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h, { replies: { [ORIGIN]: 'el sábado' } });
    await say(b.spine, 'cuándo es el viaje?');
    expect(said(b)).toEqual([[SPLIT, 'el sábado', ['el sábado']]]);
  });

  it('a human\'s line steered into the live tunnelled turn opens no ⏳ in S and gets no ✍️ in X', async () => {
    const h = onChat();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h, { limbs: true });
    let open;
    const held = new Promise((r) => { open = r; });
    Object.assign(b.brain, { allowNewInput: async () => 'any', steer: async () => true, turn: async (being) => { await held; return { text: 'listo', being }; } });
    const first = say(b.spine, 'e revisa esto');
    await new Promise((r) => setTimeout(r, 0));
    await say(b.spine, 'e y esto también');
    expect(said(b)).toEqual([]);
    expect(b.bridge.reactions).toEqual([]);
    open();
    await first;
    expect(said(b)).toEqual([[SPLIT, 'listo', ['listo']]]);
  });

  it('regression lock: no split — a human\'s line in an \'on\' chat opens its ⏳ in X as today', async () => {
    const b = buildSpine(onChat(), { replies: { [ORIGIN]: '…' } });
    await say(b.spine, 'jaja');
    expect(said(b)).toEqual([[ORIGIN, THINKING, ['✓']]]);
  });

  it('regression lock: split-E\'s own turn in S opens its ⏳ there, unmarked, and its /react is placed', async () => {
    const h = onChat();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h, { replies: { [SPLIT]: '…' } });
    await say(b.spine, 'jaja', inSplit());
    expect(said(b)).toEqual([[SPLIT, THINKING, ['✓']]]);
    expect(b.opened().map((o) => o.canary)).toEqual([null]);
    const r = buildSpine(h, { limbs: true });
    r.brain.turn = async (being, ev) => ({ text: `/react #${ev.msgId} 👍`, being });
    await say(r.spine, 'e prueba', inSplit());
    expect(r.bridge.reactions).toEqual([{ chat: SPLIT, msgId: lastId(), emoji: '👍' }]);
  });
});
