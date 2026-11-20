// tests/split-own-thread.test.mjs — a /split is ANOTHER THREAD, and nothing tunnels into it.
//
// The split tunnel (operator 2026-10-31/11-01: while a chat had an open /split, a being called in the
// chat answered in the split, signed "E from [chat]") is GONE (2026-11-20, operator: "split is another
// thread in the same folder, another group; separate accum" — two threads in one group is against the
// model). What this locks:
// 1. A being called in X answers in X, whatever splits X has open; the split's own being answers in
//    the split. reply_in_side_group still sends X's replies to its SI+ group, a split in the way or not.
//    config.yaml split.tunnel and an entry's split: { tunnel } are ignored, and say so once.
// 2. In the split, anyone may call the being /split was typed to (allowed_users ['*'] on the split).
// 3. `/<handle> split invite [<name>]` also invites X's members; plain `/split` is unchanged.
// Never a real Beeper call: forkBridge and the bridge are fakes.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-split-own-thread-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { rmSync } from 'node:fs';
import { createCommands } from '../src/spine/commands.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender } from '../src/spine/sender.mjs';
import { createReplyActions } from '../src/spine/reply-actions.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { retiredSplitTunnelNote, assertConfig } from '../src/spine/boot.mjs';
import { ensureContact, recordThread, getContact, patchContact, forkContact, serialize, parse } from '../src/conversations-state.mjs';
import { shortChatId } from '../src/bridges/chat-id.mjs';
import { encodeNodeSignature, encodeChatCanary } from '../src/node-signature.mjs';
import { replyLine } from '../src/transcript-log.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const ORIGIN = 'muestra1';
const TITLE = '🌴FAMILIA MUESTRA🌴';
const SPLIT = shortChatId('!side1:beeper.local');
const SPLIT2 = shortChatId('!side2:beeper.local');
const SPLIT_TITLE = `SI+${TITLE}-viaje`;
const AN = '+15550100001';
const RODZ = '+15550100002';
const RODZ_DIGITS = '15550100002';
const RODZ_USER_ID = '@whatsapp_lid-10000000000015:beeper.local';
const AN_ID = '@anaprueba:beeper.com';
const LOLA = '@whatsapp_lid-lola42:beeper.local';
const PEPE = '@whatsapp_lid-pepe7:beeper.local';
const FABIO = '@whatsapp_lid-fulvio9:beeper.local';

const OPEN = { e: { handles: ['e'], conversation_defaults: { allowed_users: ['*'] } } };   // E answers anyone
const OWNERS = { e: { handles: ['e'] } };                                                   // E answers its owners only
// `tunnel`: the retired config.yaml split.tunnel, set on most tests to show it is read by nothing (null = unset).
const cfg = ({ agents = OPEN, mode = 'mention', tunnel = true } = {}) => ({
  beeper: { primary: { phone: AN }, secondary: { phone: RODZ } },
  node_name: 'kg', group_title: '{group}-{name}', agents, dispatch: { auto_default_mode: mode },
  ...(tunnel == null ? {} : { split: { tunnel } }),
});
const LIVE = { participants: { items: [{ id: AN_ID, phoneNumber: AN, isSelf: true }, { id: RODZ_USER_ID, phoneNumber: RODZ }, { id: LOLA, phoneNumber: '+34600000000' }, { id: PEPE, phoneNumber: '+34611111111' }] } };

function seedState(entry = {}) {
  let st = ensureContact({ contacts: {} }, 'whatsapp', ORIGIN, { pushedName: TITLE }).state;
  st = recordThread(st, 'whatsapp', ORIGIN, 'muestra-e-thread', '2026-10-01T00:00:00Z', 'e');
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
const inChat = (chatId, chatName, body, extra = {}) => ({ chatId, surface: 'whatsapp', chatName, senderId: LOLA, senderName: 'Lola', msgId: 'm1', body, raw: { chatType: 'group' }, ...extra });
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
  const opened = () => [...bridge.streams.map((s) => ({ chatId: s.chat, replyTo: s.opts?.replyTo ?? null })), ...bridge.sent.map((s) => ({ chatId: s.chat, replyTo: s.opts?.replyTo ?? null }))];
  return { spine, brain, bridge, files, logs, opened, chats: () => opened().map((o) => o.chatId) };
}
const from = (over = {}) => ({ network: 'whatsapp', chatId: ORIGIN, chatName: TITLE, userId: LOLA, senderName: 'Lola', isSender: false, ...over });
let n = 0;
const say = (spine, body, over = {}) => { const { atEStart, atEAnywhere } = mentionStatus(body, ['e']); return spine.handleInbound({ body, from: from({ msgKey: `k${++n}`, atEStart, atEAnywhere, ...over }) }); };
const inSplit = (over = {}) => ({ chatId: SPLIT, chatName: SPLIT_TITLE, userId: PEPE, senderName: 'Pepe', ...over });

beforeEach(() => { rmSync(HOME, { recursive: true, force: true }); });

// ── 1. X and its split are two threads: each answers where it was called ─────────────────────────
describe('a being answers in the chat it was called in, whatever splits that chat has', () => {
  it('REPRODUCE: E called in X, with a split open, answers in X on X\'s thread, quoted; nothing goes into the split', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h, { replies: { [ORIGIN]: 'respuesta de X' } });
    await say(b.spine, 'e, hola');
    expect(b.brain.calls.map((c) => [c.being, c.chatId])).toEqual([['e', ORIGIN]]);
    expect(b.opened()).toEqual([{ chatId: ORIGIN, replyTo: expect.any(String) }]);
    expect(b.files.get(ORIGIN).at(-1)).toMatch(/^E@\[.*\]\.wa \(\d\d:\d\d\): respuesta de X$/);
    expect(b.files.get(SPLIT)).toBeUndefined();
    expect(Object.keys(h.getState().contacts.whatsapp[SPLIT])).not.toContain('split');   // /split writes no mark
  });

  // split.tunnel (2026-11-01) and an entry's split: { tunnel } are read by nothing now: the replies stay put.
  const handMade = (split) => {
    const st = forkContact(seedState(), 'whatsapp', SPLIT, ORIGIN, { pushedName: SPLIT_TITLE, transcript: SPLIT_TITLE });
    return split ? patchContact(st, 'whatsapp', SPLIT, { split }) : st;
  };
  for (const [what, split, tunnel] of [
    ['nothing set', null, null],
    ['the entry\'s split: {tunnel: true}', { tunnel: true }, null],
    ['config split.tunnel: true', null, true],
    ['the entry\'s split: {tunnel: true} over config false', { tunnel: true }, false],
    ['the entry\'s split: {tunnel: false} over config true', { tunnel: false }, true],
  ]) {
    it(`REPRODUCE: ${what} → X's reply stays in X`, async () => {
      const b = buildSpine(harness({ config: cfg({ tunnel }), state: handMade(split) }));
      await say(b.spine, 'e, hola');
      expect(b.chats()).toEqual([ORIGIN]);
    });
  }

  it('the old keys load: boot\'s config assertions pass on a config.yaml that carries split.tunnel, and the entry\'s split: block survives a rewrite of the entry and of the file, read by nothing', () => {
    for (const tunnel of [true, false]) expect(() => assertConfig(cfg({ tunnel }))).not.toThrow();
    const st = parse(serialize(patchContact(handMade({ tunnel: true }), 'whatsapp', SPLIT, { mouth_chat: 'sec-room' })));
    expect(st.contacts.whatsapp[SPLIT]).toMatchObject({ parent_chat: ORIGIN, transcript: SPLIT_TITLE, mouth_chat: 'sec-room', split: { tunnel: true } });
  });

  it('the boot says it once: split.tunnel is gone, naming what still carries it; nothing else says anything', () => {
    const st = patchContact(handMade({ tunnel: false }), 'whatsapp', ORIGIN, { split: { tunnel: true } });
    expect(retiredSplitTunnelNote(cfg({ tunnel: true }), st)).toMatch(/^split\.tunnel is gone \(2026-11-20\): .*config\.yaml split\.tunnel.* 2 conversations\.yaml entries/);
    expect(retiredSplitTunnelNote(cfg({ tunnel: null }), st)).toMatch(/^split\.tunnel is gone \(2026-11-20\): .* 2 conversations\.yaml entries/);
    expect(retiredSplitTunnelNote(cfg({ tunnel: null }), st)).not.toContain('config.yaml split.tunnel');
    expect(retiredSplitTunnelNote(cfg({ tunnel: false }), handMade(null))).toMatch(/config\.yaml split\.tunnel/);
    expect(retiredSplitTunnelNote(cfg({ tunnel: null }), handMade(null))).toBeNull();
    expect(retiredSplitTunnelNote({ split: { placeholder: 'x' } }, null)).toBeNull();
  });

  it('X\'s invocation rules hold: a line E is not asked for runs nothing, in X or in the split', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h);
    await say(b.spine, 'hola a todos');
    expect(b.brain.calls).toEqual([]);
    expect(b.opened()).toEqual([]);
  });

  it('several open splits: every reply in X stays in X', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split uno'));
    await typed(h, inOrigin('/e split dos', { msgId: 'm2' }));
    const b = buildSpine(h);
    await say(b.spine, 'e, hola');
    await say(b.spine, 'e, otra vez');
    expect(b.chats()).toEqual([ORIGIN, ORIGIN]);
  });

  it('REPRODUCE: a limb of X\'s turn acts in X too: its /react is placed on X\'s message', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h, { limbs: true });
    b.brain.turn = async (being, ev) => ({ text: `/react #${ev.msgId} 👍`, being });
    await say(b.spine, 'e prueba');
    expect(b.bridge.reactions).toEqual([{ chat: ORIGIN, msgId: `k${n}`, emoji: '👍' }]);
  });

  it('regression lock: a chat with no split replies in place', async () => {
    const b = buildSpine(harness());
    await say(b.spine, 'e, hola');
    expect(b.opened()).toEqual([{ chatId: ORIGIN, replyTo: expect.any(String) }]);
  });

  it('regression lock: reply_in_side_group with no split still goes to its SI+ group, as an alias', async () => {
    const h = harness({ state: seedState({ reply_in_side_group: true }) });
    const b = buildSpine(h);
    await say(b.spine, 'e, hola');
    expect(h.calls.create.map((c) => c.title)).toEqual([`SI+${TITLE}`]);
    expect(b.opened()).toEqual([{ chatId: SPLIT, replyTo: null }]);
    expect(h.getState().contacts.whatsapp[SPLIT].aliasOf).toBe(ORIGIN);
  });

  it('REPRODUCE: reply_in_side_group with a split open: the reply goes to the SI+ group, never the split', async () => {
    const h = harness({ state: seedState({ reply_in_side_group: true }) });
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h);
    await say(b.spine, 'e, hola');
    expect(h.calls.create.map((c) => c.title)).toEqual([`SI+${TITLE}-viaje`, `SI+${TITLE}`]);
    expect(b.chats()).toEqual([SPLIT2]);
    expect(h.getState().contacts.whatsapp[SPLIT2]).toMatchObject({ aliasOf: ORIGIN, automatic: true });
  });

  it('the split\'s own being answers in the split, in place', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h);
    await say(b.spine, 'e, hola', inSplit());
    expect(b.brain.calls.map((c) => c.chatId)).toEqual([SPLIT]);
    expect(b.opened()).toEqual([{ chatId: SPLIT, replyTo: expect.any(String) }]);
  });

  it('auto: the dwelled reply to X is posted in X, plain', async () => {
    const pending = [];
    const timers = { setTimeout: (fn) => { pending.push(fn); return { unref() {} }; }, clearTimeout() {} };
    const h = harness({ config: cfg({ mode: 'auto' }) });
    await typed(h, inOrigin('/e split viaje'));
    const b = buildSpine(h, { timers, replies: { [ORIGIN]: 'claro' } });
    await say(b.spine, 'alguien viene mañana?');
    for (let i = 0; i < 20 && pending.length; i++) { pending.splice(0).forEach((fn) => fn()); await new Promise((r) => setTimeout(r, 0)); }
    expect(b.bridge.sent.map((s) => s.chat)).toEqual([ORIGIN]);
  });

  it('an older node\'s tunnelled reply (a canary of kind tunnel) is just a line from whoever posted it', () => {
    const identity = createIdentity({ now: () => 1000 });
    const sig = encodeNodeSignature('kg', 'e');
    const old = encodeChatCanary({ group: SPLIT, origin: ORIGIN, kind: 'tunnel', speaker: `E from [${TITLE}]` });
    const line = identity.build({ body: `hola${sig}${old}`, from: from(inSplit({ userId: RODZ_USER_ID, senderName: 'Rodz', msgKey: '7' })) }).line;
    expect(line).toMatch(/^Rodz@\[.*\]\.wa \(\d\d:\d\d\) #7: hola<kg>$/);
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

// ── 2. anyone in the split may call split-E ──────────────────────────────────────────────────────
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
    st = recordThread(st, 'whatsapp', ORIGIN, 'muestra-ken-thread', '2026-10-01T00:00:00Z', 'ken');
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

// ── 3. /split invite ─────────────────────────────────────────────────────────────────────────────
describe('/<handle> split invite [<name>] also invites the members of X', () => {
  it('REPRODUCE: a member\'s `/e split invite fabio` invites Rodz + every member; the name is fabio', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split invite fabio'));
    expect(h.calls.create.map((c) => [c.title, c.participantIDs])).toEqual([[`SI+${TITLE}-fabio`, [RODZ_USER_ID, LOLA, PEPE]]]);
  });

  it('REPRODUCE: the operator\'s `/e split invite fabio` in a 1:1 with Fabio invites Rodz + Fabio', async () => {
    const ONE = { participants: { items: [{ id: AN_ID, phoneNumber: AN, isSelf: true }, { id: FABIO, phoneNumber: '+39300000000' }] } };
    let st = ensureContact({ contacts: {} }, 'whatsapp', 'fulvio1', { pushedName: 'Fabio' }).state;
    st = recordThread(st, 'whatsapp', 'fulvio1', 'fabio-e-thread', '2026-10-01T00:00:00Z', 'e');
    const h = harness({ state: st, chatRaw: async () => ONE });
    await typed(h, inChat('fulvio1', 'Fabio', '/e split invite fabio', { ...asOperator, raw: { chatType: 'single' } }));
    expect(h.calls.create.map((c) => [c.title, c.participantIDs])).toEqual([['SI+Fabio-fabio', [RODZ_USER_ID, FABIO]]]);
  });

  it('`invite` alone: every member, a random name', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split INVITE'));
    const [c] = h.calls.create;
    expect(c.participantIDs).toEqual([RODZ_USER_ID, LOLA, PEPE]);
    expect(/^[a-z0-9]{5}$/.test(c.title.slice(`SI+${TITLE}-`.length))).toBe(true);
  });

  it('regression lock: without `invite`, today\'s behaviour — the requester + Rodz (the operator: Rodz alone)', async () => {
    for (const [ev, ids, title] of [
      [inOrigin('/e split fabio'), [RODZ_USER_ID, LOLA], 'fabio'],
      [inOrigin('/e split invited'), [RODZ_USER_ID, LOLA], 'invited'],
      [inOrigin('/e split fabio', asOperator), [RODZ_USER_ID], 'fabio'],
    ]) {
      const h = harness();
      await typed(h, ev);
      expect(h.calls.create.map((c) => [c.title, c.participantIDs])).toEqual([[`SI+${TITLE}-${title}`, ids]]);
    }
  });
});
