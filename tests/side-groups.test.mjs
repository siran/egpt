// tests/side-groups.test.mjs — side groups (operator 2026-10-18 ~17:10, rulings ~21:00).
//
// 1. No "SI chat …" trigger anywhere.
// 2. /join and /split from anyone in the group; /send and /end from anyone in the side group. The
//    PRIMARY ACCOUNT creates every side group: /join and /split with Rodz + the requester (the
//    operator's own: Rodz alone); no secondary → the requester alone. Since 2026-10-19 the node is
//    the handle's, whatever its node_role (tests/side-groups-by-node.test.mjs).
// 3. `reply_in_side_group` on the chat's own entry: a truthy word → "SI+<group>", any other string →
//    that title, a falsy word / empty / absent → in place. Every reply (any mode) goes to the group,
//    made on the primary with Rodz + every member of the chat. An addressed reply makes it at once; an
//    unaddressed one only once it has something to post, so a silence makes nothing. /end is off
//    there. The node whose being replies creates it; the other links it from the opener's canary frame.
// 4. Nothing finds a group by its title: the primary posts every opener, its canary names the group,
//    and Rodz's copy of it gives Rodz's own room (mouth_chat). Titles may repeat.
// Never a real Beeper call: forkBridge is a fake that records which account each op rode.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-side-groups-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { rmSync } from 'node:fs';
import * as commandsModule from '../src/spine/commands.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender, THINKING } from '../src/spine/sender.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { ensureContact, recordThread, patchContact, patchBeing, getContact, aliasContact } from '../src/conversations-state.mjs';
import { shortChatId } from '../src/bridges/chat-id.mjs';
import { encodeNodeSignature, encodeChatCanary, decodeChatCanary } from '../src/node-signature.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const ORIGIN = 'palma1';
const TITLE = '🌴FAMILIA PALMA🌴';
const SIDE_FULL = '!side1:beeper.local';
const SIDE = shortChatId(SIDE_FULL);
const SIDE2_FULL = '!side2:beeper.local';
const SEC = (id) => `!sec-${id}`;      // Rodz's own room for the group the primary made as `id`
const ADMIN = 'admin1';
const AN = '+16468217865';
const RODZ = '+13472576794';
const RODZ_DIGITS = '13472576794';
const RODZ_USER_ID = '@whatsapp_lid-69433129173200:beeper.local';
const AN_ID = '@anrodriguez:beeper.com';
const LULU = '@whatsapp_lid-lulu42:beeper.local';
const LULU_DIGITS = '34600000000';
const LULU_ON_SEC = '@whatsapp_34600000000:beeper.local';   // the secondary's own id for Lulu
const PEPE = '@whatsapp_lid-pepe7:beeper.local';

const cfg = ({ node_role = 'primary', secondary = true, extra = {} } = {}) => ({
  beeper: { primary: { phone: AN }, ...(secondary ? { secondary: { phone: RODZ } } : {}) },
  node_name: 'kg', node_role, group_title: '{group}-{name}', admin_channel: ADMIN, ...extra,
});

function seedState({ entry = {} } = {}) {
  let st = ensureContact({ contacts: {} }, 'whatsapp', ORIGIN, { pushedName: TITLE }).state;
  st = recordThread(st, 'whatsapp', ORIGIN, 'palma-e-thread', '2026-10-01T00:00:00Z', 'e');
  if (Object.keys(entry).length) st = patchContact(st, 'whatsapp', ORIGIN, entry);
  return ensureContact(st, 'whatsapp', ADMIN, { pushedName: 'eGPT Admin' }).state;
}
const AUTOMATIC = { reply_in_side_group: true };

// The chat as the primary sees it: the operator (self), Rodz, two members.
const LIVE = { participants: { items: [{ id: AN_ID, phoneNumber: AN, isSelf: true }, { id: RODZ_USER_ID, phoneNumber: RODZ }, { id: LULU, phoneNumber: `+${LULU_DIGITS}` }, { id: PEPE, phoneNumber: '+34611111111' }] } };

// secIds: digits → the secondary's own id for that phone (its rosters); absent → no match there.
// copyArrives: Rodz's account receives its copy of what the primary posts, in its own room SEC(<id>).
// postResult: what the primary's send of the opener answers (the port's shape: a confirmed id, or null = refused).
function harness({ config = cfg(), state, chatRaw = async () => LIVE, created = [SIDE_FULL, SIDE2_FULL], secIds = {}, copyArrives = true, postResult = () => ({ ok: true, confirmedId: Promise.resolve('op-1') }) } = {}) {
  let st = state ?? seedState();
  const sent = [];
  const logs = [];
  const calls = { create: [], post: [], archive: [], edit: [], resolve: [], byTitle: [], awaitMouth: [], lost: [] };
  const mouthWaiters = [];
  const rodzSaw = [];
  const forkBridge = {
    editMessage: async (chatId, msgId, text) => { calls.edit.push({ chatId, msgId, text }); return true; },
    createGroup: async (opts, o = {}) => { calls.create.push({ ...opts, via: o.via ?? null }); return { success: true, chatID: created[calls.create.length - 1] }; },
    postReply: async (chatId, text, replyTo, opts = {}) => {
      calls.post.push({ chatId, text, via: opts.via ?? null, canary: opts.canary ?? null, unsigned: !!opts.unsigned });
      if (opts.via === 'primary' && copyArrives) {
        const copy = { chatID: SEC(chatId), text: `${text}${encodeChatCanary(opts.canary ?? '')}` };
        for (const w of [...mouthWaiters]) if (w.test(copy)) { mouthWaiters.splice(mouthWaiters.indexOf(w), 1); w.done(copy); }
      }
      return postResult(chatId, opts);
    },
    archiveChat: async (chatId, o = {}) => { calls.archive.push({ chatId, via: o.via ?? null }); return true; },
    chatAccountId: async () => 'whatsapp',
    chatRaw,
    chatTitle: async () => null,
    resolveUserIdByPhone: async (digits, o = {}) => {
      calls.resolve.push({ digits, via: o.via ?? null });
      return o.via === 'secondary' ? (secIds[digits] ?? null) : (digits === RODZ_DIGITS ? RODZ_USER_ID : null);
    },
    // Rodz's copy that already arrived (rodzGot) answers at once, as the bridge's recent arrivals do.
    // With none and copyArrives, the wait ends only with a primary post (no timer): a test that links must hand it one.
    awaitMouthMessage: (test, ms) => new Promise((done) => { calls.awaitMouth.push(ms); const seen = rodzSaw.find(test); if (seen) done(seen); else if (copyArrives) mouthWaiters.push({ test, done }); else done(null); }),
    // Nothing may look a group up by its title (operator 2026-10-18): these only record a call.
    resolveSecondaryChatIdByTitle: async (...a) => { calls.byTitle.push(a); return '!byTitle'; },
    resolvePrimaryChatIdByTitle: async (...a) => { calls.byTitle.push(a); return '!byTitle'; },
    listMessagesRaw: async () => [{ id: 'q1', text: 'la respuesta' }],
  };
  const cmds = createCommands({
    getConfig: () => config,
    send: async (chatId, text) => sent.push({ chatId, text }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    defaultKey: 'e',
    forkBridge,
    reportUndelivered: async (o) => { calls.lost.push(o); return true; },
    onLog: (m) => logs.push(m),
  });
  // rodzGot: Rodz's account received `text` in its own room for `chatId` (the other node's half).
  return { cmds, sent, logs, calls, config, getState: () => st, setState: (s) => { st = s; }, rodzGot: (chatId, text) => rodzSaw.push({ chatID: SEC(chatId), text }) };
}

// Lulu: a member of the group, not the operator, not on any allowed_users list.
const inOrigin = (body, extra = {}) => ({ chatId: ORIGIN, surface: 'whatsapp', chatName: TITLE, senderId: LULU, senderName: 'Lulu', msgId: 'm1', body, raw: { chatType: 'group' }, ...extra });
const asOperator = { senderId: AN_ID, senderName: 'An', isSender: true, authorized: true };
async function typed(h, ev) {
  const cmd = h.cmds.commandOf(ev) ?? ev;
  if (!(await h.cmds.isCommand(cmd))) return 'not a command';
  return h.cmds.run(cmd);
}

beforeEach(() => { rmSync(HOME, { recursive: true, force: true }); });

// ── 1. "SI chat …" is out ────────────────────────────────────────────────────────────────────────
describe('"SI chat …" opens nothing anywhere', () => {
  const STRAY = { superchats: { triggers: ['SI chat'], prefix: 'SI+' } };
  for (const body of ['SI chat', 'SI chat viaje', 'si chat viaje']) {
    it(`"${body}" in a chat whose entry still carries a superchats block is an ordinary message`, async () => {
      const h = harness({ state: seedState({ entry: STRAY }) });
      for (const ev of [inOrigin(body), inOrigin(body, asOperator)]) {
        expect(h.cmds.commandOf(ev)).toBe(null);
        expect(await h.cmds.isCommand(ev)).toBe(false);
      }
      expect(h.calls.create).toEqual([]);
    });
  }

  it('a leftover global super_chats block summons nothing either', async () => {
    const h = harness({ config: cfg({ extra: { super_chats: { triggers: ['SI chat'], automatic: true } } }) });
    expect(h.cmds.commandOf(inOrigin('SI chat'))).toBe(null);
    expect(await h.cmds.isCommand(inOrigin('SI chat'))).toBe(false);
    expect(h.calls.create).toEqual([]);
  });

  it('the SI chat machinery is gone from the module', () => {
    for (const k of ['superchatTrigger', 'SUPERCHAT_DIR', 'SUPERCHAT_PREFIX_DEFAULT', 'SUPERCHAT_INTRO', 'SUPERCHAT_HELP']) expect(commandsModule[k], k).toBeUndefined();
  });
});

// ── 2. /join and /split from any member ──────────────────────────────────────────────────────────
describe('who may run the side-group commands', () => {
  it('a member (not the operator) is admitted for /join /split /send /end, and still for nothing else', async () => {
    const h = harness();
    const admitted = (body) => h.cmds.isCommand(h.cmds.commandOf(inOrigin(body)) ?? inOrigin(body));
    for (const body of ['/e join viaje', '/e split viaje', '/e send', '/e end', '/e JOIN', '/e split']) expect(await admitted(body), body).toBe(true);
    for (const body of ['/e agents mode on e', '/e status', '/e config', '/e restart', '/e joinx', '/e recap', '/e agents']) expect(await admitted(body), body).toBe(false);
  });

  it('a node-signed line is never a command from a member (being output is never input)', async () => {
    const h = harness();
    for (const body of ['/e join viaje', '/e split viaje', '/e send', '/e end']) {
      const ev = inOrigin(`${body}${encodeNodeSignature('do', 'don')}`, { fromNode: 'do' });
      expect(await h.cmds.isCommand(h.cmds.commandOf(ev) ?? ev), body).toBe(false);
    }
  });

  it('a member the being would not answer (allowed_users) may still /join', async () => {
    let st = seedState();
    st = patchBeing(st, 'whatsapp', ORIGIN, 'e', { allowed_users: ['@someone-else:beeper.local'] });
    const h = harness({ state: st });
    await typed(h, inOrigin('/e join viaje'));
    expect(h.calls.create).toHaveLength(1);
  });

  it('a non-operator in a 1:1 creates nothing', async () => {
    const h = harness();
    await typed(h, inOrigin('/e join viaje', { raw: { chatType: 'single' } }));
    await typed(h, inOrigin('/e split viaje', { raw: { chatType: 'single' } }));
    expect(h.calls.create).toEqual([]);
  });

  it('node_role picks nothing: a node_role secondary whose being the handle names creates for a member too (2026-10-19)', async () => {
    const h = harness({ config: cfg({ node_role: 'secondary' }) });
    await typed(h, inOrigin('/e join viaje'));
    await typed(h, inOrigin('/e split viaje'));
    expect(h.calls.create.map((c) => [c.title, c.via])).toEqual([[`SI+${TITLE}-viaje`, 'primary'], [`SI+${TITLE}-viaje`, 'primary']]);
  });
});

describe('/join and /split: the primary creates "SI+<group>-<name>" with Rodz + the requester', () => {
  it('/join viaje by a member: made on the primary, members Rodz + Lulu, aliased', async () => {
    const h = harness();
    await typed(h, inOrigin('/e join viaje'));
    expect(h.calls.create).toEqual([{ accountID: 'whatsapp', participantIDs: [RODZ_USER_ID, LULU], type: 'group', title: `SI+${TITLE}-viaje`, via: 'primary' }]);
    expect(h.getState().contacts.whatsapp[SIDE]).toMatchObject({ aliasOf: ORIGIN, join_name: 'viaje', join_by_id: LULU });
  });

  it('its opener comes from the primary, its canary naming the group, its origin, its kind and transcript key; Rodz\'s copy of it gives the mouth room', async () => {
    const h = harness();
    await typed(h, inOrigin('/e join viaje'));
    expect(h.calls.post).toHaveLength(1);
    expect(h.calls.post[0]).toMatchObject({ chatId: SIDE, via: 'primary', canary: { group: SIDE, origin: ORIGIN, kind: 'join', transcript: h.getState().contacts.whatsapp[SIDE].transcript } });
    expect(h.getState().contacts.whatsapp[SIDE].mouth_chat).toBe(SEC(SIDE));
  });

  it('/split viaje by a member: made on the primary with Rodz + Lulu, a new conversation, its mouth room by id', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split viaje'));
    expect(h.calls.create).toEqual([{ accountID: 'whatsapp', participantIDs: [RODZ_USER_ID, LULU], type: 'group', title: `SI+${TITLE}-viaje`, via: 'primary' }]);
    const split = getContact(h.getState(), 'whatsapp', SIDE);
    expect(split.jid).toBe(SIDE);
    expect(split.entry.parent_chat).toBe(ORIGIN);
    expect(h.calls.post[0]).toMatchObject({ chatId: SIDE, via: 'primary', canary: { group: SIDE, origin: ORIGIN, kind: 'split', transcript: null } });
    expect(split.entry.mouth_chat).toBe(SEC(SIDE));
  });

  it('Rodz\'s copy never arrives: no mouth room is stored, one line says replies come from the primary', async () => {
    const h = harness({ copyArrives: false });
    await typed(h, inOrigin('/e join viaje'));
    expect(h.getState().contacts.whatsapp[SIDE].mouth_chat).toBeUndefined();
    expect(h.logs.filter((l) => l.includes('did not arrive'))).toHaveLength(1);
  });

  it('two side groups with the same title: no suffix, each gets its own mouth room by its own id', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split viaje'));
    await typed(h, inOrigin('/e split viaje', { msgId: 'm2' }));
    expect(h.calls.create.map((c) => c.title)).toEqual([`SI+${TITLE}-viaje`, `SI+${TITLE}-viaje`]);
    const side2 = shortChatId(SIDE2_FULL);
    expect([SIDE, side2].map((id) => h.getState().contacts.whatsapp[id].mouth_chat)).toEqual([SEC(SIDE), SEC(side2)]);
    expect(h.calls.byTitle).toEqual([]);
  });

  it('no group is ever looked up by its title: /join, /split, the automatic group, /send', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }), created: [SIDE_FULL, SIDE2_FULL, '!side3:beeper.local'] });
    await typed(h, inOrigin('/e join viaje'));
    await typed(h, inOrigin('/e split viaje'));
    expect(await h.cmds.autoSideGroup(inOrigin('e, hola'))).toBe(shortChatId('!side3:beeper.local'));
    await typed(h, { chatId: SIDE, surface: 'whatsapp', chatName: 'x', senderId: LULU, senderName: 'Lulu', msgId: 's1', body: '/e send', replyToId: 'q1', raw: { chatType: 'group' } });
    expect(h.calls.create).toHaveLength(3);
    expect(h.calls.post.map((p) => [p.chatId, p.via])).toEqual([[SIDE, 'primary'], [shortChatId(SIDE2_FULL), 'primary'], [shortChatId('!side3:beeper.local'), 'primary'], [ORIGIN, 'secondary']]);
    expect(h.calls.byTitle).toEqual([]);
  });

  // Live 2026-10-19: a /join in "SI+EduWeb" made "SI+SI+EduWeb-facturacion".
  for (const [origin, title] of [['SI+EduWeb', 'SI+EduWeb-x'], ['si+EduWeb', 'si+EduWeb-x'], ['Familia', 'SI+Familia-x']]) {
    it(`REPRODUCE: /join x in "${origin}" makes "${title}" — the SI+ prefix once`, async () => {
      const h = harness();
      await typed(h, inOrigin('/e join x', { chatName: origin }));
      expect(h.calls.create.map((c) => c.title)).toEqual([title]);
    });
  }

  it('no <name>: a random 5-character name, with the SI+<group>- prefix; the retired default_name is ignored', async () => {
    const h = harness({ config: cfg({ extra: { join: { default_name: 'charla' } } }) });
    await typed(h, inOrigin('/e join'));
    await typed(h, inOrigin('/e split'));
    const titles = h.calls.create.map((c) => c.title);
    expect(titles).toHaveLength(2);
    for (const title of titles) expect(title.startsWith(`SI+${TITLE}-`) && /^[a-z0-9]{5}$/.test(title.slice(`SI+${TITLE}-`.length)), title).toBe(true);
  });

  it('no secondary configured: the primary creates it with only the requester', async () => {
    const h = harness({ config: cfg({ secondary: false }) });
    await typed(h, inOrigin('/e join viaje'));
    await typed(h, inOrigin('/e split viaje'));
    expect(h.calls.create.map((c) => [c.via, c.participantIDs])).toEqual([['primary', [LULU]], ['primary', [LULU]]]);
    expect(h.calls.post.map((p) => p.via)).toEqual(['primary', 'primary']);
  });

  it('the operator runs it: made on the primary with Rodz alone (the operator is the creator)', async () => {
    const h = harness();
    await typed(h, inOrigin('/e join viaje', asOperator));
    await typed(h, inOrigin('/e split viaje', asOperator));
    expect(h.calls.create.map((c) => [c.via, c.participantIDs])).toEqual([['primary', [RODZ_USER_ID]], ['primary', [RODZ_USER_ID]]]);
    expect(h.calls.post[0]).toMatchObject({ chatId: SIDE, via: 'primary', canary: { group: SIDE, origin: ORIGIN, kind: 'join' } });   // the opener comes from the creator
  });

  it('the requester is invited as heard, whichever connection heard them: nothing is looked up on the secondary', async () => {
    for (const connection of ['primary', 'secondary']) {
      const h = harness({ secIds: { [LULU_DIGITS]: LULU_ON_SEC } });
      await typed(h, inOrigin('/e join viaje', { connection }));
      expect(h.calls.create[0].participantIDs).toEqual([RODZ_USER_ID, LULU]);
      expect(h.calls.resolve.filter((r) => r.via === 'secondary')).toEqual([]);
    }
  });

  it('a member whose id cannot be invited gets a one-line answer and nothing is created', async () => {
    const h = harness();
    await typed(h, inOrigin('/e split viaje', { senderId: '+34600000000' }));
    expect(h.calls.create).toEqual([]);
    expect(h.sent).toHaveLength(1);
  });
});

describe('/send and /end work for whoever is in the side group', () => {
  const inSide = (body, extra = {}) => ({ chatId: SIDE, surface: 'whatsapp', chatName: `SI+${TITLE}-viaje`, senderId: LULU, senderName: 'Lulu', msgId: 's1', body, raw: { chatType: 'group' }, connection: 'secondary', ...extra });

  it('/send from a member: handed to the mouth (via secondary) by the origin\'s own id, signed, never as the operator', async () => {
    const h = harness();
    await typed(h, inOrigin('/e join viaje'));
    h.calls.post.length = 0;
    await typed(h, inSide('/e send', { replyToId: 'q1' }));
    expect(h.calls.post).toHaveLength(1);
    expect(h.calls.post[0]).toMatchObject({ chatId: ORIGIN, via: 'secondary', unsigned: false });
    expect(h.calls.post[0].text).toContain('la respuesta');
  });

  it('/send from a member with no secondary: the primary posts it, signed', async () => {
    const h = harness({ config: cfg({ secondary: false }) });
    await typed(h, inOrigin('/e join viaje'));
    h.calls.post.length = 0;
    await typed(h, inSide('/e send', { replyToId: 'q1', connection: null }));
    expect(h.calls.post).toEqual([expect.objectContaining({ chatId: ORIGIN, via: 'primary', unsigned: false })]);
  });

  it('the operator\'s /send is unchanged: post_back_from (primary), unsigned, into the origin', async () => {
    const h = harness();
    await typed(h, inOrigin('/e join viaje'));
    h.calls.post.length = 0;
    await typed(h, inSide('/e send', { replyToId: 'q1', ...asOperator, connection: 'primary' }));
    expect(h.calls.post).toEqual([expect.objectContaining({ chatId: ORIGIN, via: 'primary', unsigned: true })]);
  });

  it('/end from a member in a /join group archives it on the account it was heard on and drops the alias', async () => {
    const h = harness();
    await typed(h, inOrigin('/e join viaje'));
    await typed(h, inSide('/e end'));
    expect(h.calls.archive).toEqual([{ chatId: SIDE, via: 'secondary' }]);
    expect(h.getState().contacts.whatsapp[SIDE]).toBeUndefined();
  });

  it('/end in the automatic group does nothing: nothing archived or posted, the alias kept, one log line', async () => {
    const st = aliasContact(seedState({ entry: AUTOMATIC }), 'whatsapp', SIDE, ORIGIN, { transcript: 'x', automatic: true });
    const h = harness({ state: st });
    const before = h.getState().contacts.whatsapp[SIDE];
    for (const ev of [inSide('/e end', { chatName: `SI+${TITLE}` }), inSide('/e end', { chatName: `SI+${TITLE}`, ...asOperator, connection: 'primary' })]) {
      h.logs.length = 0;
      await typed(h, ev);
      expect(h.logs.filter((l) => l.startsWith('/end'))).toHaveLength(1);
    }
    expect(h.calls.archive).toEqual([]);
    expect(h.calls.post).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.getState().contacts.whatsapp[SIDE]).toEqual(before);
  });

  it('/send still works in the automatic group', async () => {
    const st = aliasContact(seedState({ entry: AUTOMATIC }), 'whatsapp', SIDE, ORIGIN, { transcript: 'x', automatic: true });
    const h = harness({ state: st });
    await typed(h, inSide('/e send', { replyToId: 'q1', chatName: `SI+${TITLE}` }));
    expect(h.calls.post).toEqual([expect.objectContaining({ chatId: ORIGIN, via: 'secondary' })]);
  });

  it('outside a side group a member\'s /send and /end do nothing', async () => {
    const h = harness();
    await typed(h, inOrigin('/e send', { replyToId: 'q1' }));
    await typed(h, inOrigin('/e end'));
    expect(h.calls.post).toEqual([]);
    expect(h.calls.archive).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});

// ── 3. reply_in_side_group ───────────────────────────────────────────────────────────────────────
// The real spine, the real gating (its side-group seam wired to the real commands), the real sender
// over a fake streaming bridge.
const AGENTS = { e: { default: true, handles: ['e'] } };
const SIG = encodeNodeSignature('kg', 'e');
function streamingBridge() {
  const streams = [], sent = [];
  return {
    streams, sent,
    onMessage() {}, stop() {}, wasSentByUs: () => false,
    send(chat, text, opts) { sent.push({ chat, text, opts }); return { ok: true, confirmedId: `${chat}#s${sent.length}` }; },
    startStream(chat, init, opts) {
      const s = { chat, init, opts, frames: [], finals: [], delivered: false, confirmedId: `${chat}#${streams.length + 1}`, update(t) { s.frames.push(t); }, async finish(t) { s.finals.push(t); s.delivered = true; } };
      streams.push(s);
      return s;
    },
  };
}
const fakeTimers = () => {
  const pending = [];
  return { setTimeout: (fn) => { pending.push(fn); return { unref() {} }; }, clearTimeout() {}, flush() { pending.splice(0).forEach((fn) => fn()); }, size: () => pending.length };
};
const flush = () => new Promise((r) => setTimeout(r, 0));
function buildSpine(h, { mode = 'on', node = 'kg', actions = undefined, reply = 'ok', partials = [], timers = null } = {}) {
  const brain = { calls: [], async turn(being, ev, onPartial) { this.calls.push({ being, chatId: ev.chatId }); for (const p of partials) onPartial?.(...(Array.isArray(p) ? p : [p])); return { text: typeof reply === 'function' ? reply() : reply }; } };
  const bridge = streamingBridge();
  const notes = [];
  const config = { ...h.config, agents: AGENTS, dispatch: { auto_default_mode: mode } };
  const spine = createSpine({
    bridge, brain, identity: createIdentity({ now: () => 1000 }),
    router: createRouter({ getAgents: () => AGENTS, defaultBeing: 'e' }),
    gating: createGating({ getConfig: () => config, loadState: async () => h.getState(), defaultKey: 'e', sideGroupFor: (ev, o) => h.cmds.autoSideGroup(ev, o) }),
    commands: h.cmds, sender: createSender({ bridge, defaultKey: 'e', onLog: (m) => notes.push(m) }), actions, transcript: { async log() {} }, heartbeats: { runDue() {} },
    mesh: { isEnvelope: () => false, async handle() {} },
    fromThisNode: (ev) => ev?.fromNode != null && String(ev.fromNode).toLowerCase() === node,
    isSelfChat: () => false, clock: { now: () => 1000 }, defaultBeing: 'e', turnTimeoutMs: 0,
    ...(timers ? { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } : {}),
  });
  // Every message the being's replies opened, in order: the chat it went to and what it quotes.
  const opened = () => [...bridge.streams.map((s) => ({ chatId: s.chat, replyTo: s.opts?.replyTo ?? null })), ...bridge.sent.map((s) => ({ chatId: s.chat, replyTo: s.opts?.replyTo ?? null }))];
  return { spine, brain, bridge, opened, notes };
}
const from = (over = {}) => ({ network: 'whatsapp', chatId: ORIGIN, chatName: TITLE, userId: LULU, senderName: 'Lulu', isSender: false, ...over });
// The bridge stamps the mention (atEStart/atEAnywhere) on the arrival; so does this.
const say = (spine, body, over = {}) => { const { atEStart, atEAnywhere } = mentionStatus(body, ['e']); return spine.handleInbound({ body, from: from({ msgKey: `k-${body}`, atEStart, atEAnywhere, ...over }) }); };
const ASK = 'e, hola a todos';   // addressed
const chatsOf = (b) => b.opened().map((o) => o.chatId);

describe('reply_in_side_group: the switch on the chat\'s own entry', () => {
  for (const v of [true, 1, 'true', 'TRUE', 'yes', 'Yes', 'on', 'ON', '1', ' on ']) {
    it(`${JSON.stringify(v)} → the reply goes to "SI+<group>"`, async () => {
      const h = harness({ state: seedState({ entry: { reply_in_side_group: v } }) });
      const b = buildSpine(h);
      await say(b.spine, ASK);
      expect(h.calls.create.map((c) => c.title)).toEqual([`SI+${TITLE}`]);
      expect(chatsOf(b)).toEqual([SIDE]);
    });
  }

  for (const v of [false, 0, 'false', 'no', 'NO', 'off', 'Off', '0', '', '  ', null]) {
    it(`${JSON.stringify(v)} → off: the reply opens in the group itself`, async () => {
      const h = harness({ state: seedState({ entry: { reply_in_side_group: v } }) });
      const b = buildSpine(h);
      await say(b.spine, ASK);
      expect(h.calls.create).toEqual([]);
      expect(chatsOf(b)).toEqual([ORIGIN]);
    });
  }

  it('absent → off', async () => {
    const h = harness();
    const b = buildSpine(h);
    await say(b.spine, 'hola a todos');
    expect(h.calls.create).toEqual([]);
    expect(chatsOf(b)).toEqual([ORIGIN]);
  });

  it('the old `side_group: { automatic: true }` is not read', async () => {
    const h = harness({ state: seedState({ entry: { side_group: { automatic: true } } }) });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    expect(h.calls.create).toEqual([]);
    expect(chatsOf(b)).toEqual([ORIGIN]);
  });

  it('any other string is the side group\'s title, trimmed, used as is', async () => {
    for (const [v, title] of [['Charla de la familia', 'Charla de la familia'], ['  Viaje 2027 ', 'Viaje 2027']]) {
      const h = harness({ state: seedState({ entry: { reply_in_side_group: v } }) });
      const b = buildSpine(h);
      await say(b.spine, ASK);
      expect(h.calls.create.map((c) => c.title)).toEqual([title]);
      expect(chatsOf(b)).toEqual([SIDE]);
    }
  });

  it('REPRODUCE: the automatic group of "SI+EduWeb" is "SI+EduWeb", the same title as its origin (titles may repeat)', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    expect(await h.cmds.autoSideGroup(inOrigin('e, hola', { chatName: 'SI+EduWeb' }))).toBe(SIDE);
    expect(h.calls.create.map((c) => c.title)).toEqual(['SI+EduWeb']);
  });

  it('a title that already exists is used as is: no suffix, no lookup by title', async () => {
    const h = harness({ state: seedState({ entry: { reply_in_side_group: 'Charla' } }) });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    expect(h.calls.create.map((c) => c.title)).toEqual(['Charla']);
    expect(h.calls.byTitle).toEqual([]);
  });

  it('the key on an alias entry or in config.yaml is not read: only the chat\'s own entry', async () => {
    let st = seedState();
    st = aliasContact(st, 'whatsapp', 'joinroom', ORIGIN, { transcript: 'x', reply_in_side_group: true });
    const h = harness({ state: st, config: cfg({ extra: { reply_in_side_group: true } }) });
    const b = buildSpine(h);
    await say(b.spine, 'hola a todos');
    await say(b.spine, 'hola', { chatId: 'joinroom', chatName: 'x' });
    expect(h.calls.create).toEqual([]);
    expect(chatsOf(b)).toEqual([ORIGIN, 'joinroom']);
  });

  it('nothing reaches the admin channel, on or off', async () => {
    for (const entry of [{}, AUTOMATIC]) {
      const h = harness({ state: seedState({ entry }) });
      const b = buildSpine(h);
      await say(b.spine, 'hola a todos');
      expect(chatsOf(b)).not.toContain(ADMIN);
      expect(h.calls.post.some((p) => p.chatId === ADMIN)).toBe(false);
      expect(h.sent.some((s) => s.chatId === ADMIN)).toBe(false);
    }
  });
});

describe('the automatic group: made on the primary with Rodz + every member of the chat', () => {
  it('created on the primary, inviting Rodz and everyone the primary sees in the chat, minus our own accounts', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    expect(h.calls.create).toEqual([{ accountID: 'whatsapp', participantIDs: [RODZ_USER_ID, LULU, PEPE], type: 'group', title: `SI+${TITLE}`, via: 'primary' }]);
    expect(h.getState().contacts.whatsapp[SIDE]).toMatchObject({ aliasOf: ORIGIN, automatic: true });
    expect(b.brain.calls).toEqual([{ being: 'e', chatId: ORIGIN }]);
    expect(b.opened()).toEqual([{ chatId: SIDE, replyTo: null }]);
  });

  it('the same members whoever asked: the operator, or a node-signed line on Rodz', async () => {
    for (const over of [{ userId: AN_ID, senderName: 'An', isSender: true, authorized: true }, { userId: RODZ_USER_ID, senderName: 'Rodz' }]) {
      const h = harness({ state: seedState({ entry: AUTOMATIC }) });
      const b = buildSpine(h);
      await say(b.spine, `e, estas?${over.isSender ? '' : encodeNodeSignature('do', 'don')}`, over);
      expect(h.calls.create.map((c) => [c.via, c.participantIDs])).toEqual([['primary', [RODZ_USER_ID, LULU, PEPE]]]);
      expect(chatsOf(b)).toEqual([SIDE]);
    }
  });

  it('no secondary: the primary creates it with the members alone', async () => {
    const roster = { participants: { items: [{ id: AN_ID, phoneNumber: AN, isSelf: true }, { id: LULU, phoneNumber: `+${LULU_DIGITS}` }, { id: PEPE, phoneNumber: '+34611111111' }] } };
    const h = harness({ config: cfg({ secondary: false }), state: seedState({ entry: AUTOMATIC }), chatRaw: async () => roster });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    expect(h.calls.create.map((c) => [c.via, c.participantIDs, c.title])).toEqual([['primary', [LULU, PEPE], `SI+${TITLE}`]]);
    expect(chatsOf(b)).toEqual([SIDE]);
  });

  it('the members cannot be read: nothing is created and nothing posted anywhere', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }), chatRaw: async () => null });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    expect(h.calls.create).toEqual([]);
    expect(b.opened()).toEqual([]);
    expect(h.calls.post).toEqual([]);
  });

  it('its opener comes from the primary, its canary naming the group and its origin, offers /send and never /end', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    expect(h.calls.post).toHaveLength(1);
    expect(h.calls.post[0]).toMatchObject({ chatId: SIDE, via: 'primary', canary: { group: SIDE, origin: ORIGIN, kind: 'automatic', transcript: h.getState().contacts.whatsapp[SIDE].transcript } });
    expect(h.getState().contacts.whatsapp[SIDE].mouth_chat).toBe(SEC(SIDE));
    expect(h.calls.post[0].text).toContain('/e send');
    expect(h.calls.post[0].text).not.toContain('/e end');
    expect(h.calls.post[0].text).toContain(TITLE);
  });

  it('its opener text: {group} the chat\'s name, {handle} the persona\'s', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    expect(h.calls.post[0].text).toBe(`🔗 Side-room of ${TITLE} — same agents, same conversation. Reply /e send to a message to copy it back to the original chat.`);
  });

  // Live 2026-10-19 09:10: the opener's send was DROPPED and the log still said "opener posted".
  it('REPRODUCE: an opener the primary\'s send refuses is logged as NOT posted and reported once — never "posted"', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }), postResult: () => null, copyArrives: false });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    expect(h.logs.some((m) => /opener posted/.test(m))).toBe(false);
    expect(h.logs.some((m) => /opener NOT posted into/.test(m) && m.includes(SIDE))).toBe(true);
    expect(h.calls.lost).toEqual([expect.objectContaining({ what: 'opener', chatId: SIDE })]);
  });

  it('an opener whose id never confirms is not "posted" either: reported once, and Rodz\'s copy is still awaited', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }), postResult: () => ({ ok: true, confirmedId: Promise.resolve(null) }) });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    expect(h.logs.some((m) => /opener posted/.test(m))).toBe(false);
    expect(h.calls.lost).toEqual([expect.objectContaining({ what: 'opener', chatId: SIDE, why: expect.stringMatching(/never confirmed/) })]);
    expect(h.getState().contacts.whatsapp[SIDE].mouth_chat).toBe(SEC(SIDE));
  });

  it('a confirmed opener is "posted" and reports nothing (regression lock)', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    expect(h.logs.some((m) => m.includes(`opener posted by the primary into ${SIDE}`))).toBe(true);
    expect(h.calls.lost).toEqual([]);
  });

  it('nothing is posted in the origin', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    await say(b.spine, 'y mañana?', { userId: PEPE, senderName: 'Pepe' });
    expect(chatsOf(b)).not.toContain(ORIGIN);
    expect(h.sent).toEqual([]);
    expect(h.calls.edit).toEqual([]);
  });

  it('later replies reuse the same group; no second one', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    await say(b.spine, 'e, y mañana?', { userId: PEPE, senderName: 'Pepe' });
    expect(h.calls.create).toHaveLength(1);
    expect(chatsOf(b)).toEqual([SIDE, SIDE]);
  });

  it('a message inside the SI+ group is answered there (it is the side group, not another origin)', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    await say(b.spine, 'sigo aquí', { chatId: SIDE, chatName: `SI+${TITLE}` });
    expect(h.calls.create).toHaveLength(1);
    expect(chatsOf(b)).toEqual([SIDE, SIDE]);
  });

  it('the reply\'s limbs act in the SI+ group too, never in the origin', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const limbs = [];
    const actions = {
      parse: () => ({ prose: 'ok', run: [{ type: 'reply', targetId: 'm1', text: 'x' }], stripped: [] }),
      execute: async (run, stripped, ev) => { limbs.push(ev.chatId); return { ran: [] }; },
    };
    const b = buildSpine(h, { actions });
    await say(b.spine, ASK);
    expect(limbs).toEqual([SIDE]);
  });

  it('a gone group is replaced on the next reply', async () => {
    let gone = false;
    const h = harness({ state: seedState({ entry: AUTOMATIC }), chatRaw: async (id) => (gone && id === SIDE ? false : LIVE) });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    gone = true;
    await say(b.spine, 'e, otra vez');
    expect(h.calls.create).toHaveLength(2);
    expect(chatsOf(b)).toEqual([SIDE, shortChatId(SIDE2_FULL)]);
  });

  it('a creation that fails posts nothing anywhere', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }), created: [] });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    expect(b.opened()).toEqual([]);
    expect(h.calls.post).toEqual([]);
  });
});

describe('every mode replies in the side group; a turn that stays silent makes nothing', () => {
  it('on, a human, not addressed, silent: the turn runs, no group is made, nothing is posted anywhere', async () => {
    for (const partials of [[], ['.', '..', '…']]) {
      const h = harness({ state: seedState({ entry: AUTOMATIC }) });
      const b = buildSpine(h, { reply: '…', partials });
      await say(b.spine, 'hola a todos');
      expect(b.brain.calls).toEqual([{ being: 'e', chatId: ORIGIN }]);
      expect(h.calls.create).toEqual([]);
      expect(h.calls.post).toEqual([]);
      expect(b.opened()).toEqual([]);
      expect(b.notes.some((n) => n.includes('nothing posted'))).toBe(true);
    }
  });

  it('on, a human, not addressed, it speaks: the group is made then, its ⏳ opens there with the first text, nothing in the origin', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h, { reply: 'Hola a todos', partials: ['…', 'Hola', 'Hola a todos'] });
    await say(b.spine, 'hola a todos');
    expect(h.calls.create.map((c) => [c.via, c.participantIDs])).toEqual([['primary', [RODZ_USER_ID, LULU, PEPE]]]);
    expect(b.bridge.streams.map((s) => [s.chat, s.init, s.frames, s.finals])).toEqual([[SIDE, THINKING, ['Hola ⏳', 'Hola a todos ⏳'], ['Hola a todos']]]);
    expect(b.bridge.sent).toEqual([]);
  });

  // A human's turn arms no 10 s timer (its ⏳ is not deferred); a non-human's does. Neither makes the group.
  for (const [who, over, armed, init] of [['a human', {}, 0, THINKING], ['another being', { fromMember: { id: 'claude', kind: 'brain' } }, 1, 'Listo']]) {
    it(`on, ${who}, not addressed, it works first (a tool use, the 10 s): nothing is made or posted until its first text`, async () => {
      const h = harness({ state: seedState({ entry: AUTOMATIC }) });
      const timers = fakeTimers();
      const before = {};
      const b = buildSpine(h, { timers, partials: [['', { tool: true }]], reply: () => {
        before.armed = timers.size();
        timers.flush();
        Object.assign(before, { made: h.calls.create.length, opened: b.opened().length });
        return 'Listo';
      } });
      await say(b.spine, 'hola a todos', over);
      expect(before).toEqual({ armed, made: 0, opened: 0 });
      expect(h.calls.create).toHaveLength(1);
      expect(b.bridge.streams.map((s) => [s.chat, s.init, s.finals])).toEqual([[SIDE, init, ['Listo']]]);
      expect(b.bridge.sent).toEqual([]);
    });
  }

  it('on, a human, not addressed, a reply with no stream: the group is made at its finish and its ⏳ opens there', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h, { reply: 'Buenas' });
    await say(b.spine, 'hola a todos');
    expect(h.calls.create).toHaveLength(1);
    expect(b.bridge.streams.map((s) => [s.chat, s.init, s.finals])).toEqual([[SIDE, THINKING, ['Buenas']]]);
  });

  it('on: once the group exists, a human line opens its ⏳ there on arrival, addressed or not', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const atTurn = [];
    const b = buildSpine(h, { reply: () => { atTurn.push(b.bridge.streams.length); return 'ok'; } });
    await say(b.spine, 'hola a todos');
    await say(b.spine, 'que bien', { userId: PEPE, senderName: 'Pepe' });
    await say(b.spine, ASK);
    expect(h.calls.create).toHaveLength(1);
    expect(chatsOf(b)).toEqual([SIDE, SIDE, SIDE]);
    expect(atTurn).toEqual([0, 2, 3]);   // the first made the group at its reply; after that the ⏳ was up before the turn ran
    expect(b.bridge.streams.map((s) => s.init)).toEqual([THINKING, THINKING, THINKING]);
  });

  it('on, addressed: the ⏳ opens in the group up front', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    expect(b.bridge.streams.map((s) => [s.chat, s.init])).toEqual([[SIDE, THINKING]]);
  });

  it('mention: an addressed reply goes to the group; an unaddressed line runs nothing', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h, { mode: 'mention' });
    await say(b.spine, 'hola a todos');
    expect(b.brain.calls).toEqual([]);
    expect(h.calls.create).toEqual([]);
    await say(b.spine, ASK);
    expect(chatsOf(b)).toEqual([SIDE]);
  });

  it('auto: the dwelled reply goes to the group, made when it is posted; a silent one makes nothing', async () => {
    for (const [reply, made] of [['claro que sí', 1], ['…', 0]]) {
      const timers = fakeTimers();
      const h = harness({ state: seedState({ entry: AUTOMATIC }) });
      const b = buildSpine(h, { mode: 'auto', reply, timers });
      await say(b.spine, 'alguien viene mañana?');
      for (let i = 0; i < 20 && timers.size(); i++) { timers.flush(); await flush(); }
      await flush();
      expect(b.brain.calls).toHaveLength(1);
      expect(h.calls.create).toHaveLength(made);
      expect(chatsOf(b)).toEqual(made ? [SIDE] : []);
    }
  });
});

describe('two nodes on the shared accounts: one creates, the other links', () => {
  it('a node_role secondary holding no group makes its own for its being\'s reply (2026-10-19)', async () => {
    for (const body of [ASK, 'hola a todos']) {
      const h = harness({ config: cfg({ node_role: 'secondary' }), state: seedState({ entry: AUTOMATIC }) });
      const b = buildSpine(h, { node: 'do' });
      await say(b.spine, body);
      expect(h.calls.create.map((c) => c.via), body).toEqual(['primary']);
      expect(chatsOf(b), body).toEqual([SIDE]);
    }
  });

  // The automatic group's opener, as the other node hears it: posted by the primary account (its own
  // account on this node too, so isSender), signed by kg, its canary naming the group and its origin.
  const OPENER = (canary = `${SIDE} ${ORIGIN}`) => [`🔗 Side-room of ${TITLE}${SIG}${encodeChatCanary(canary)}`, { chatId: SIDE, chatName: `SI+${TITLE}`, userId: AN_ID, senderName: 'An', isSender: true }];

  it('the opener (canary + kg\'s frame) arriving in an unknown chat links it to this node\'s conversation', async () => {
    const h = harness({ config: cfg({ node_role: 'secondary' }), state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h, { node: 'do' });
    h.rodzGot(SIDE, OPENER()[0]);
    await say(b.spine, ...OPENER());
    expect(h.getState().contacts.whatsapp[SIDE]).toMatchObject({ aliasOf: ORIGIN, automatic: true, mouth_chat: SEC(SIDE) });
    expect(b.brain.calls).toEqual([]);                          // the opener itself wakes nobody
    await say(b.spine, 'hola a todos');
    expect(h.calls.create).toEqual([]);
    expect(chatsOf(b)).toEqual([SIDE]);                         // the peer replies in the linked group
  });

  it('a /join or /split opener posted before 2026-10-19 (its canary names the group alone) links nothing on the other node', async () => {
    const h = harness({ config: cfg({ node_role: 'secondary' }), state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h, { node: 'do' });
    await say(b.spine, ...OPENER(SIDE));
    expect(h.getState().contacts.whatsapp[SIDE]?.aliasOf).toBeUndefined();
  });

  it('a canary naming another group links nothing (it names the group, not just the origin)', async () => {
    const h = harness({ config: cfg({ node_role: 'secondary' }), state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h, { node: 'do' });
    await say(b.spine, ...OPENER(`!otherGroup ${ORIGIN}`));
    expect(h.getState().contacts.whatsapp[SIDE]?.aliasOf).toBeUndefined();
  });

  it('the canary never re-links a chat with a conversation of its own (the creator\'s own opener coming back)', async () => {
    const h = harness({ state: recordThread(seedState({ entry: AUTOMATIC }), 'whatsapp', ADMIN, 'admin-e-thread', '2026-10-01T00:00:00Z', 'e') });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    const before = h.getState().contacts.whatsapp[SIDE];
    await say(b.spine, ...OPENER());
    await say(b.spine, `intro${SIG}${encodeChatCanary(`${ADMIN} ${ORIGIN}`)}`, { chatId: ADMIN, chatName: 'eGPT Admin', userId: RODZ_USER_ID });
    expect(h.getState().contacts.whatsapp[SIDE]).toEqual(before);
    expect(h.getState().contacts.whatsapp[ADMIN].aliasOf).toBeUndefined();
  });

  it('a chat this node has only seen (no alias, no parent, no thread) is linked by the opener', async () => {
    const st = ensureContact(seedState({ entry: AUTOMATIC }), 'whatsapp', SIDE, { pushedName: `SI+${TITLE}` }).state;
    const h = harness({ config: cfg({ node_role: 'secondary' }), state: st, copyArrives: false });
    const b = buildSpine(h, { node: 'do' });
    await say(b.spine, ...OPENER());
    expect(h.getState().contacts.whatsapp[SIDE]).toMatchObject({ aliasOf: ORIGIN, automatic: true });
    expect(h.getState().contacts.whatsapp[SIDE].mouth_chat).toBeUndefined();   // Rodz's copy never came: linked all the same
    expect(h.logs.filter((l) => l.includes('did not arrive'))).toHaveLength(1);
  });

  it('a canary for a conversation this node does not have links nothing', async () => {
    const h = harness({ config: cfg({ node_role: 'secondary' }) });
    const b = buildSpine(h, { node: 'do' });
    await say(b.spine, ...OPENER(`${SIDE} unknown9`));
    expect(h.getState().contacts.whatsapp[SIDE]?.aliasOf).toBeUndefined();
  });
});

describe('the canary frame', () => {
  it('round-trips beside the node frame and leaves the node and being readings alone', async () => {
    const { decodeNodeSignature, decodeBeingSignature, renderNodeSignature, stripNodeSignature } = await import('../src/node-signature.mjs');
    const canary = { group: SIDE, origin: ORIGIN, kind: 'join', transcript: `SI+${TITLE}-viaje` };
    const text = `hola${SIG}${encodeChatCanary(canary)}`;
    expect(decodeChatCanary(text)).toEqual(canary);   // the non-ASCII transcript key survives (URI-encoded on the wire)
    expect(decodeNodeSignature(text)).toBe('kg');
    expect(decodeBeingSignature(text)).toBe('e');
    expect(renderNodeSignature(text)).toBe('hola<kg>');
    expect(stripNodeSignature(text)).toBe('hola');
    expect(decodeChatCanary(`hola${SIG}`)).toBe(null);
    expect(encodeChatCanary('')).toBe('');
    expect(encodeChatCanary({ group: '' })).toBe('');
  });

  it('reads the openers posted before 2026-10-19: group alone (a /join or /split), group + origin (automatic)', () => {
    expect(decodeChatCanary(`x${SIG}${encodeChatCanary(SIDE)}`)).toEqual({ group: SIDE, origin: null, kind: null, transcript: null });
    expect(decodeChatCanary(`x${SIG}${encodeChatCanary(`${SIDE} ${ORIGIN}`)}`)).toEqual({ group: SIDE, origin: ORIGIN, kind: 'automatic', transcript: null });
    expect(encodeChatCanary({ group: SIDE, origin: ORIGIN })).toBe(encodeChatCanary(`${SIDE} ${ORIGIN} automatic`));
  });
});

// ── 4. loop safety in the side groups ────────────────────────────────────────────────────────────
describe('no loop: the side group\'s own output wakes nobody', () => {
  it('the opener and E\'s signed reply coming back in the SI+ group wake nobody, even in mode on', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const b = buildSpine(h);
    await say(b.spine, ASK);
    b.brain.calls.length = 0;
    const before = b.opened().length;
    await say(b.spine, `🔗 intro${SIG}${encodeChatCanary(`${SIDE} ${ORIGIN}`)}`, { chatId: SIDE, chatName: `SI+${TITLE}`, userId: AN_ID, isSender: true });
    await say(b.spine, `🐶 E: aquí estoy${SIG}`, { chatId: SIDE, chatName: `SI+${TITLE}`, userId: RODZ_USER_ID, isSender: true });
    expect(b.brain.calls).toEqual([]);
    expect(b.opened()).toHaveLength(before);
  });
});
