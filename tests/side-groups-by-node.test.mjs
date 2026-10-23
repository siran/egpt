// side-groups-by-node.test.mjs — which node makes a side group (operator 2026-10-19). The node that
// runs the command (the handle's) makes /join and /split; the node whose being is about to reply makes
// the automatic group; the other node links it from the opener, and linking an automatic group also
// switches reply_in_side_group on for its own origin entry. Both nodes making one at once is defined:
// two groups, each node maps both, each keeps replying in its own. Two real nodes: kg (E: e) and do
// (D: d, don), each a real spine + real gating + real commands over its own state.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-side-groups-by-node-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { rmSync } from 'node:fs';
import { createCommands } from '../src/spine/commands.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender } from '../src/spine/sender.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { ensureContact, recordThread, patchContact } from '../src/conversations-state.mjs';
import { shortChatId } from '../src/bridges/chat-id.mjs';
import { encodeNodeSignature, encodeChatCanary } from '../src/node-signature.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const ORIGIN = 'palma1';
const TITLE = 'PALMA';
const AN = '+16468217865';
const RODZ = '+13472576794';
const RODZ_USER_ID = '@whatsapp_lid-69433129173200:beeper.local';
const AN_ID = '@anrodriguez:beeper.com';
const LULU = '@whatsapp_lid-lulu42:beeper.local';
const LIVE = { participants: { items: [{ id: AN_ID, phoneNumber: AN, isSelf: true }, { id: RODZ_USER_ID, phoneNumber: RODZ }, { id: LULU, phoneNumber: '+34600000000' }] } };
const NODES = {
  kg: { role: 'primary', being: 'e', handles: ['e'] },
  do: { role: 'secondary', being: 'd', handles: ['d', 'don'] },
};

function streamingBridge() {
  const streams = [], sent = [];
  return {
    streams, sent,
    onMessage() {}, stop() {}, wasSentByUs: () => false,
    send(chat, text, opts) { sent.push({ chat, text, opts }); return { ok: true, confirmedId: `${chat}#s${sent.length}` }; },
    startStream(chat, init, opts) {
      const s = { chat, init, opts, update() {}, async finish() {}, delivered: true, confirmedId: `${chat}#${streams.length + 1}` };
      streams.push(s);
      return s;
    },
  };
}

// One node. `entry` patches its own origin entry (e.g. reply_in_side_group); `mode` is every being's
// reply mode here.
function node(name, { entry = {}, mode = 'mention' } = {}) {
  const { role, being, handles } = NODES[name];
  const agents = { [being]: { handles } };
  const config = {
    beeper: { primary: { phone: AN }, secondary: { phone: RODZ } },
    node_name: name, node_role: role, group_title: '{group}-{name}', agents, dispatch: { auto_default_mode: mode },
    networks: { whatsapp: { chat_ids: ['!self'] } },
  };
  let st = ensureContact({ contacts: {} }, 'whatsapp', ORIGIN, { pushedName: TITLE }).state;
  st = recordThread(st, 'whatsapp', ORIGIN, `${name}-thread`, '2026-10-01T00:00:00Z', being);
  if (Object.keys(entry).length) st = patchContact(st, 'whatsapp', ORIGIN, entry);
  const calls = { create: [], openers: [], logs: [], brain: [], writes: [] };
  let made = 0;
  const cmds = createCommands({
    getConfig: () => config,
    send: async () => {},
    loadState: async () => st,
    writeState: async (s) => { st = s; calls.writes.push(s); },
    forkBridge: {
      editMessage: async () => true,
      createGroup: async (opts, o = {}) => { calls.create.push({ title: opts.title, via: o.via ?? null }); return { success: true, chatID: `!${name}-side${++made}:beeper.local` }; },
      postReply: async (chatId, text, replyTo, opts = {}) => {
        if (opts.canary) calls.openers.push({ chatId, text, canary: opts.canary });
        return { ok: true, confirmedId: Promise.resolve('op-1') };
      },
      archiveChat: async () => true,
      chatAccountId: async () => 'whatsapp',
      chatRaw: async () => LIVE,
      chatTitle: async () => null,
      resolveUserIdByPhone: async (digits) => (digits === RODZ.slice(1) ? RODZ_USER_ID : null),
      awaitMouthMessage: async () => null,
    },
    onLog: (m) => calls.logs.push(m),
  });
  const bridge = streamingBridge();
  const spine = createSpine({
    bridge,
    brain: { async turn(b, ev) { calls.brain.push({ being: b, chatId: ev.chatId }); return { text: 'ok' }; } },
    identity: createIdentity({ now: () => 1000 }),
    router: createRouter({ getAgents: () => agents, getConfig: () => config }),
    gating: createGating({ getConfig: () => config, loadState: async () => st, sideGroupFor: (ev, o) => cmds.autoSideGroup(ev, o) }),
    commands: cmds, sender: createSender({ bridge }), transcript: { async log() {} }, heartbeats: { runDue() {} },
    mesh: { isEnvelope: () => false, async handle() {} },
    fromThisNode: (ev) => ev?.fromNode != null && String(ev.fromNode).toLowerCase() === name,
    isSelfChat: () => false, clock: { now: () => 1000 }, turnTimeoutMs: 0,
  });
  const say = (body, over = {}) => {
    const { atEStart, atEAnywhere } = mentionStatus(body, handles);
    return spine.handleInbound({ body, from: { network: 'whatsapp', chatId: ORIGIN, chatName: TITLE, userId: LULU, senderName: 'Lulu', isSender: false, msgKey: `k-${name}-${body}-${over.chatId ?? ''}`, atEStart, atEAnywhere, ...over } });
  };
  // Where this node's replies opened, in order.
  const repliedIn = () => [...bridge.streams.map((s) => s.chat), ...bridge.sent.map((s) => s.chat)];
  return { name, being, cmds, calls, say, repliedIn, getState: () => st, contacts: () => st.contacts.whatsapp };
}
// The opener `from` posted, as `to` hears it: on the primary account (ours on both nodes), signed by `from`.
const deliverOpener = (from, to, opener = from.calls.openers.at(-1)) => to.say(
  `${opener.text}${encodeNodeSignature(from.name, from.being)}${encodeChatCanary(opener.canary)}`,
  { chatId: opener.chatId, chatName: `SI+${TITLE}`, userId: AN_ID, senderName: 'An', isSender: true },
);
const operator = { userId: AN_ID, senderName: 'An', isSender: true, authorized: true };

beforeEach(() => { rmSync(HOME, { recursive: true, force: true }); });

describe('/join and /split: the handle\'s node creates', () => {
  it('/don join hi: dolly (node_role secondary) makes SI+PALMA-hi on its primary account; kg makes nothing', async () => {
    const kg = node('kg'), dolly = node('do');
    for (const n of [kg, dolly]) await n.say('/don join hi', operator);
    expect(dolly.calls.create).toEqual([{ title: `SI+${TITLE}-hi`, via: 'primary' }]);
    expect(dolly.contacts()[shortChatId('!do-side1:beeper.local')]).toMatchObject({ aliasOf: ORIGIN, join_name: 'hi' });
    expect(kg.calls.create).toEqual([]);
  });

  it('/d split x: dolly makes it; kg makes nothing', async () => {
    const kg = node('kg'), dolly = node('do');
    for (const n of [kg, dolly]) await n.say('/d split x', operator);
    expect(dolly.calls.create).toEqual([{ title: `SI+${TITLE}-x`, via: 'primary' }]);
    expect(kg.calls.create).toEqual([]);
  });

  it('kg links dolly\'s /join group from its opener (both directions)', async () => {
    const kg = node('kg'), dolly = node('do');
    for (const n of [kg, dolly]) await n.say('/don join hi', operator);
    await deliverOpener(dolly, kg);
    expect(kg.contacts()[shortChatId('!do-side1:beeper.local')]).toMatchObject({ aliasOf: ORIGIN });
    expect(kg.contacts()[ORIGIN].reply_in_side_group).toBeUndefined();   // only an automatic group switches it on
  });
});

describe('the automatic group: the node whose being replies makes it', () => {
  it('dolly makes it for don\'s reply (node_role secondary), and replies there', async () => {
    const dolly = node('do', { entry: { reply_in_side_group: true } });
    await dolly.say('don, hola');
    expect(dolly.calls.create).toEqual([{ title: `SI+${TITLE}`, via: 'primary' }]);
    const g = shortChatId('!do-side1:beeper.local');
    expect(dolly.contacts()[g]).toMatchObject({ aliasOf: ORIGIN, automatic: true });
    expect(dolly.repliedIn()).toEqual([g]);
  });

  it('dolly linking kg\'s automatic group from its opener sets reply_in_side_group on its own origin entry, in the same write, with one log line', async () => {
    const kg = node('kg', { entry: { reply_in_side_group: true } });
    const dolly = node('do');
    await kg.say('e, hola');
    const g = shortChatId('!kg-side1:beeper.local');
    await deliverOpener(kg, dolly);
    expect(dolly.contacts()[g]).toMatchObject({ aliasOf: ORIGIN, automatic: true });
    expect(dolly.contacts()[ORIGIN].reply_in_side_group).toBe('on');
    const linked = dolly.calls.writes.find((s) => s.contacts.whatsapp[g]);
    expect(linked.contacts.whatsapp[ORIGIN].reply_in_side_group).toBe('on');   // the same write
    expect(dolly.calls.logs.filter((l) => /reply_in_side_group/.test(l))).toHaveLength(1);
    // From then on don's replies go to that group; dolly makes none of its own.
    await dolly.say('don, hola');
    expect(dolly.calls.create).toEqual([]);
    expect(dolly.repliedIn()).toEqual([g]);
  });

  it('an origin entry that already says reply_in_side_group (a title, or off) is left as it is', async () => {
    for (const v of ['Viaje', 'off']) {
      const kg = node('kg', { entry: { reply_in_side_group: true } });
      const dolly = node('do', { entry: { reply_in_side_group: v } });
      await kg.say('e, hola');
      await deliverOpener(kg, dolly);
      expect(dolly.contacts()[ORIGIN].reply_in_side_group, v).toBe(v);
    }
  });
});

describe('both nodes make an automatic group at once: two groups, both mapped, each node keeps its own', () => {
  it('each node creates its own, links the other\'s, and keeps replying in its own; a line in the other\'s group still reaches it', async () => {
    const kg = node('kg', { entry: { reply_in_side_group: true }, mode: 'on' });
    const dolly = node('do', { entry: { reply_in_side_group: true }, mode: 'on' });
    await kg.say('hola a todos');
    await dolly.say('hola a todos');
    const KG = shortChatId('!kg-side1:beeper.local'), DO = shortChatId('!do-side1:beeper.local');
    expect(kg.calls.create).toHaveLength(1);
    expect(dolly.calls.create).toHaveLength(1);
    await deliverOpener(kg, dolly);
    await deliverOpener(dolly, kg);
    for (const n of [kg, dolly]) {
      for (const g of [KG, DO]) expect(n.contacts()[g], `${n.name} maps ${g}`).toMatchObject({ aliasOf: ORIGIN, automatic: true });
    }
    await kg.say('otra cosa');
    await dolly.say('otra cosa');
    expect(kg.repliedIn()).toEqual([KG, KG]);
    expect(dolly.repliedIn()).toEqual([DO, DO]);
    expect(kg.calls.create).toHaveLength(1);
    expect(dolly.calls.create).toHaveLength(1);
    // A line in dolly's group is kg's conversation too (an alias): kg's E answers it there.
    await kg.say('en el grupo de do', { chatId: DO, chatName: `SI+${TITLE}` });
    expect(kg.calls.brain.at(-1)).toEqual({ being: 'e', chatId: DO });
    for (const n of [kg, dolly]) expect(n.calls.logs.filter((l) => /not linked|failed|error/i.test(l)), n.name).toEqual([]);
  });
});
