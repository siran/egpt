// reply-follows-the-arrival.test.mjs — A REPLY GOES OUT THE WAY IT CAME IN.
//
// THE OPERATOR'S RULE (2026-09-11): *"inter-spine messaging chat-group matching is first done by
// name and members. if rodz is not in, reply flows back from primary."*
//
// The peer mouth places a reply on the OTHER account by matching the chat across the two accounts
// (name + members — src/shell/peer-mouth.mjs crossAccountChatKey). When that match cannot be made
// — most sharply in the operator's own Self-DM, where the peer's identity is not a participant at
// all — the reply falls back to THIS node. The question this file answers is: on WHICH of this
// node's connections?
//
// IT MUST BE THE ONE THE MESSAGE ARRIVED ON, and that is not a preference about mouths. One real
// chat is a DIFFERENT Matrix room per Beeper account (src/bridges/beeper.mjs crossAccountChatKey's
// header, measured live 2026-09-05), so a chatId heard on `primary` names a room the `secondary`
// install is not in. Posting it there is not "the wrong voice", it is a room that does not exist.
//
// THE SHAPE MODELLED HERE IS THE LIVE kg NODE with its temporary crutch removed. Its
// ~/.egpt/config.yaml carries `beeper: { use: primary }` marked TEMPORARY whose only remaining job
// (since b4160e6 split the ear from the mouth) is to pin the MOUTH to the EAR, because removing it
// exposes exactly this defect: the connection names alone resolve OUTPUT to `secondary`
// (src/spine/boot.mjs nameDerivedConnection) while INGEST stays on `primary`, and every locally
// placed reply then goes out on a connection that has never seen the chat.
//
// …AND THE MIRROR QUESTION, on the same fixture (operator 2026-09-13): WHICH CONNECTION HEARS.
// *"secondary only hears if primary is not present."* That is the same two accounts, the same two
// installs and the same rosters, asked one step earlier — so the last block of this file lives
// here rather than building a second two-account world to ask it in.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// A PRIVATE profile for this file — egpt-home.mjs freezes EGPT_HOME at module load, so it must be
// set BEFORE the imports below; vi.hoisted is what does that. Private (not the suite's shared
// throwaway) because boot writes state/spine.pid and heartbeats.readonly.yaml, and files running
// in parallel would race on them.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-reply-follows-the-arrival-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { createSender } from '../src/spine/sender.mjs';
// Read back rather than re-derived: a test that computed its own key would pass while the two
// ends drifted. Used only to PROVE the 1:1 below really is a chat the participant key refuses.
import { crossAccountChatKey } from '../src/bridges/beeper.mjs';
import { encodeNodeSignature } from '../src/node-signature.mjs';

let boot, emptyState;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

// ── THE TWO CONNECTIONS, named the way the live node names them ─────────────────────────────
const PRIMARY = 'TOK-primary';       // anrodz42 — the EAR (boot's ear rule: 'primary' by name)
const SECONDARY = 'TOK-secondary';   // dolly.egpt — the MOUTH the names resolve output to
// The operator's own Beeper WINDOW: a SECOND INSTALL of the account `primary` already is, so it
// carries its own token and sees the SAME rooms under the SAME ids. It exists here only to be
// refused (INGEST_NEVER_BY_NAME) — waking on it answers every message twice.
const GUI = 'TOK-primary-gui';
const NAME_OF = { [PRIMARY]: 'primary', [SECONDARY]: 'secondary', [GUI]: 'primary_gui' };

const AN = '+16468217865';
const RODZ = '+13472576794';
const DANDO = '+34658515045';
const KEN = '+15551230000';

// An account's OWN entry: a matrix id and NO phoneNumber. A member's entry carries the number.
const self = (id) => ({ id });
const member = (id, phoneNumber) => ({ id, phoneNumber });

// THE SELF-DM — the operator's command channel, and the case the peer mouth can never rescue:
// Rodz is not a participant, so there is no cross-account match to be made and the reply has
// nowhere to go but back out of the ear it came in on.
const SELF_DM = '!self-dm-as-primary-sees-it';
// …and an ordinary group on the same account, for the same reason stated without the 1:1 quirk.
const AN_GROUP = '!an-group-as-primary-sees-it';

// ── ONE REAL CHAT BOTH ACCOUNTS ARE IN — the case this file had no fixture for ────────────────
// Beeper is Matrix: the same WhatsApp group is a DIFFERENT room per account, so it has TWO ids
// and the two payloads share nothing but the PEOPLE (beeper.crossAccountChatKey's header,
// measured live). Each account sees ITSELF as the phone-less self entry and the OTHER as an
// ordinary member WITH a phone number — which is why both identities must be excluded before the
// two views key alike.
const BOTH_AS_PRIMARY = '!both-accounts-as-primary-sees-it';
const BOTH_AS_SECONDARY = '!both-accounts-as-secondary-sees-it';
// …and a group Rodz IS in on primary that has NO counterpart on secondary's install: membership
// says "translate", the roster walk then finds nothing, and the ear must answer. The TRANSLATION
// FAILURE case, which is not the same as "the mouth is not a member".
const ORPHAN_GROUP = '!rodz-group-with-no-room-on-secondary';

// ── AND A CHAT THE EAR'S ACCOUNT IS NOT IN AT ALL ─────────────────────────────────────────────
// Someone DMs the SECONDARY account directly. There is no second arrival of this message anywhere
// — An's account is not a party to it — so if `secondary` does not wake on it, nothing does.
const SECONDARY_ONLY = '!dm-straight-to-secondary';
// …and a room the secondary's own install cannot produce a roster for (a failed GET →
// `participants: null` → UNKNOWN, beeper.mjs chatInfo). Membership is then unanswerable, which is
// NOT permission to wake.
const ROSTER_UNREADABLE = '!secondary-room-with-no-roster';
// A chat on the operator's own account, seen through the GUI install. Both installs are one
// account, so this is the SAME room the ear holds — and the ear's own phone is absent from it,
// because an account's own entry in its own roster carries no number.
const GUI_GROUP = '!an-group-as-the-gui-sees-it';

// ── THE 1:1 BETWEEN THE TWO ACCOUNTS (operator 2026-09-12) ────────────────────────────────────
// *"if there's Rodz, use it, always... primary is last and surest fallback"*. The mouth is
// obviously a member of its own 1:1, and the participant key refuses this chat ON PURPOSE
// (tests/cross-account-chat-key.test.mjs: a 1:1's title is the other party's display name and
// differs per account, so a title key cannot cross it, and its only phone-carrying member IS an
// account we hold). Under the rule above, refusing to key it is NOT permission to answer on the
// ear — it only means the room has to be found another way.
const DM_AS_PRIMARY = '!dm-with-rodz-as-primary-sees-it';
const DM_AS_SECONDARY = '!dm-with-an-as-secondary-sees-it';
// …and a DECOY on the mouth's account whose last message reads exactly like the 1:1's. Two rooms
// answering to one identification is an ambiguity, and an ambiguity must refuse, not pick.
const DECOY_ON_SECONDARY = '!decoy-that-said-the-same-thing';

// A chat's TYPE is the first field of the cross-account key and both accounts report it alike.
const TYPE_OF = {
  [SELF_DM]: 'single',
  [AN_GROUP]: 'group',
  [BOTH_AS_PRIMARY]: 'group',
  [BOTH_AS_SECONDARY]: 'group',
  [ORPHAN_GROUP]: 'group',
  [DM_AS_PRIMARY]: 'single',
  [DM_AS_SECONDARY]: 'single',
  [DECOY_ON_SECONDARY]: 'single',
  [SECONDARY_ONLY]: 'single',
  [GUI_GROUP]: 'group',
};

const DESKTOPS = {
  [PRIMARY]: {
    [SELF_DM]: [self('an@beeper.local')],
    [AN_GROUP]: [self('an@beeper.local'), member('dando@beeper.local', DANDO)],
    [BOTH_AS_PRIMARY]: [self('an@beeper.local'), member('rodz@beeper.local', RODZ), member('dando@beeper.local', DANDO)],
    // A DIFFERENT third member, deliberately: same membership would key the same, and two groups
    // with one membership are the documented limit of the key, not the case under test here.
    [ORPHAN_GROUP]: [self('an@beeper.local'), member('rodz@beeper.local', RODZ), member('ken@beeper.local', KEN)],
  },
  [SECONDARY]: {
    // dolly.egpt has neither the Self-DM nor AN_GROUP — that is the whole point of those cases —
    // and it has its OWN room for the one group both accounts really are in.
    [BOTH_AS_SECONDARY]: [self('rodz@dolly.local'), member('an@dolly.local', AN), member('dando@dolly.local', DANDO)],
    [DM_AS_SECONDARY]: [self('rodz@dolly.local'), member('an@dolly.local', AN)],
    [DECOY_ON_SECONDARY]: [self('rodz@dolly.local'), member('lulu@dolly.local', KEN)],
    // An is NOT here, under any of the three identifiers his install answers to.
    [SECONDARY_ONLY]: [self('rodz@dolly.local'), member('ken@dolly.local', KEN)],
  },
  // The GUI install's world is the EAR's world — same account, same rooms, same ids.
  [GUI]: {
    [GUI_GROUP]: [self('an@beeper.local'), member('dando@beeper.local', DANDO)],
  },
};
// The primary's half of the 1:1, added beside its own rosters rather than inside them so the
// three cases above read unchanged.
DESKTOPS[PRIMARY][DM_AS_PRIMARY] = [self('an@beeper.local'), member('rodz@beeper.local', RODZ)];

// ── WHAT EACH ACCOUNT HAS HEARD IN EACH ROOM ──────────────────────────────────────────────────
// The measured cross-account fact (beeper.crossAccountMsgKey, and re-measured 2026-09-12 against
// both live installs' views of the real "eGPT Admin" chat): ONE real message is two Matrix events
// sharing NO id, but the BODY is byte-identical and the timestamps agree to the second — each
// account keeps full precision on its own sends and truncates the ones it received, so
// 13:45:05.086Z on one side is 13:45:05.000Z on the other and never a different second.
const SAID = {
  [DM_AS_PRIMARY]: [{ id: 'p-1', text: 'buenas', timestamp: '2026-09-11T14:00:00.086Z' }],
  [DM_AS_SECONDARY]: [{ id: 's-1', text: 'buenas', timestamp: '2026-09-11T14:00:00.000Z' }],
  // the decoy really did say the same thing — but a second later, which is what tells them apart
  [DECOY_ON_SECONDARY]: [{ id: 'd-1', text: 'buenas', timestamp: '2026-09-11T14:00:01.000Z' }],
  [ORPHAN_GROUP]: [{ id: 'o-1', text: 'nobody else heard this', timestamp: '2026-09-11T13:00:00.000Z' }],
};

// ONE VOICE NOTE in the chat both accounts are in, as each account's /messages lists it (measured
// shape, 2026-09-15): no body, one attachment; the id and the mxc id are per account, the size,
// mimeType and timestamp are not. The 🎧 listening mark is placed on the MOUTH's copy of it.
const voiceNote = (id) => ({ id, timestamp: '2026-09-11T14:04:00.000Z', type: 'VOICE', text: null, attachments: [{ type: 'audio', mimeType: 'audio/ogg; codecs=opus', fileSize: 22740, isVoiceNote: true, id: `mxc://local.beeper.com/${id}` }] });
const LISTED = {
  [BOTH_AS_PRIMARY]: [voiceNote('ear-note')],
  [BOTH_AS_SECONDARY]: [voiceNote('mouth-note')],
};

// What each install reports as its OWN account's identities — `/v1/accounts`, every identifier on
// the `isSelf` user entries (measured live 2026-09-12 on both installs: the phone
// (+16468217865 / +13472576794), the Beeper user id (@anrodriguez / @dolly-egpt:beeper.com) and
// the email). This is where the exclusion identities come from: MEASURED per connection, never
// configured — and the mouth is looked for under every one of them, not the phone alone.
const SELF_IDENTITY = {
  [PRIMARY]: [AN, '@anrodriguez:beeper.com', 'anrodz42@example.com'],
  [SECONDARY]: [RODZ, '@dolly-egpt:beeper.com', 'dolly.egpt@example.com'],
  // The same account, measured through the other install — which is exactly why it must never
  // be an ear: it would answer as the connection this node already hears on.
  [GUI]: [AN, '@anrodriguez:beeper.com', 'anrodz42@example.com'],
};

const digits = (v) => String(v ?? '').replace(/\D/g, '');

// ── THE TRANSPORT SEAM ──────────────────────────────────────────────────────────────────────
// One spy per startBridge CALL, carrying which connection it is and the onIncoming the port late-
// binds, so a case can drive a real inbound through either connection.
function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const token = opts.beeperToken;
    const world = DESKTOPS[token] ?? {};
    const spy = { connection: NAME_OF[token] ?? token, token, opts, onIncoming: opts.onIncoming, sent: [], streams: [], edits: [], reactions: [], unreactions: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      async editMessage(chatId, msgId, text) { spy.edits.push({ chatId, msgId, text }); return true; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      async chatHasParticipant(chat, identity) {
        const roster = world[chat];
        if (!roster) return null;                     // a chat this account does not have is UNKNOWN
        // The real reader keys a roster by BOTH phoneNumber AND id (beeper.participantKeys), which
        // is what lets an install be recognised by an identifier that is not a phone.
        return roster.some((p) => (p.phoneNumber && digits(p.phoneNumber) === digits(identity)) || p.id === identity);
      },
      // THE THREE READS THE MOUTH MAKES, all of them of this account's OWN copies. The last
      // message is not a fourth read: it rides `preview` on the chat list, both ways.
      async selfIdentities() { return SELF_IDENTITY[token] ?? []; },
      // THE 🎧 LISTENING MARK's reads and writes (2026-09-16): this account's own copies of a chat's
      // recent messages, and a reaction placed on / taken off one of them.
      async listMessagesRaw(chat) { return LISTED[chat] ?? []; },
      async sendReaction(chat, id, key) { spy.reactions.push({ chatId: chat, id, key }); return true; },
      async removeReaction(chat, id, key) { spy.unreactions.push({ chatId: chat, id, key }); return true; },
      async chatRaw(chat) { return world[chat] ? rawChat(chat, world[chat]) : null; },
      async listChatsRaw() { return Object.entries(world).map(([id, roster]) => rawChat(id, roster)); },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

// The raw /v1/chats payload shape crossAccountChatKey reads: the TYPE and the roster itself,
// never the normalized listChats() item. `preview` is the LAST MESSAGE, which the live payload
// carries on every chat in the page (measured 2026-09-12) — so identifying a room by what was
// said in it costs no extra request on the mouth's side.
const rawChat = (id, roster) => ({
  id, type: TYPE_OF[id] ?? 'single', participants: { items: roster },
  preview: (SAID[id] ?? []).at(-1) ?? null,
});

// Complete in-memory fs seam — same shape as tests/multi-connection-wake.test.mjs.
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

function fakeSession(opts) {
  return { sessionId: opts.sessionId ?? 'sess-1', async turn(m, onUpdate) { onUpdate?.(`↩ ${m}`); return { text: `↩ ${m}`, sessionId: this.sessionId }; }, close() {} };
}

const fakeProbe = async () => ({ ok: false, status: 0 });

// kg's live shape with the crutch removed: two connections, NO `beeper.use`, no `owner_node`.
// The names alone therefore decide both halves, and they decide them DIFFERENTLY —
// output → 'secondary' (nameDerivedConnection), ingest → 'primary' (the ear rule).
const KG = () => ({
  node_name: 'kg',
  user_name: 'An',
  beeper: {
    primary: { account: 'anrodz42@example.com', token: PRIMARY },
    secondary: { account: 'dolly.egpt@example.com', token: SECONDARY },
  },
  agents: {
    egpt: { configuration: 'egpt', default: true, handles: ['e'], name: 'E' },
  },
});

// The same node with a peer spine declared, so the mouth link is really in the path and really
// DECLINES: Rodz is not a participant of either room above, so route() answers null.
const KG_WITH_PEER = () => {
  const c = KG();
  c.peer_spine = { console_port: 23377, console_token: 'shared-secret', accounts: [AN, RODZ] };
  return c;
};

// The same node with a SECOND, NON-DEFAULT agent. It exists to reach the router's connection
// gate, which the persona never does: an unaddressed message falls through to the default being
// with the bridge's own atE (router.mjs, "Nobody addressed"), so a gate that DROPPED the persona's
// hit produces a reply anyway. Only a hit for another agent can show whether the gate let it
// through. `k` is not in the bridge's wake words for this arrival — atE stays false, exactly as it
// is live for a token the bridge does not know (multi-connection-wake's deliver models the same).
const KG_WITH_K = () => {
  const c = KG();
  c.agents.ken = { configuration: 'egpt', handles: ['k'], name: 'K' };
  return c;
};

// The operator's own machine: the ear, plus the SECOND INSTALL of that same account it keeps a
// window on. An agent rides the GUI install as its mouth, which is the only reason boot dials it
// at all (a connection nothing speaks on and nothing hears on is never opened).
const KG_WITH_GUI = () => ({
  node_name: 'kg',
  user_name: 'An',
  beeper: {
    primary: { account: 'anrodz42@example.com', token: PRIMARY },
    primary_gui: { account: 'anrodz42@example.com', token: GUI },
  },
  agents: {
    egpt: { configuration: 'egpt', default: true, handles: ['e'], name: 'E', use: 'primary_gui' },
  },
});

// A ONE-CONNECTION NODE — the INTENT.md baseline, and the lock that this change costs it nothing.
const SINGLE = () => ({
  node_name: 'kg',
  user_name: 'An',
  beeper: { primary: { account: 'anrodz42@example.com', token: PRIMARY } },
  agents: { egpt: { configuration: 'egpt', default: true, handles: ['e'], name: 'E' } },
});

async function bootWith(config, { state: seedState, ...extra } = {}) {
  const { start, built } = fakeTransport();
  const lines = [];
  const io = memIo();
  let convState = seedState ?? emptyState();
  const app = await boot({
    readConfig: () => config,
    startBridge: start,
    makeSession: fakeSession,
    probeEndpoint: fakeProbe,
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io, ingest: false, tickMs: 0,
    now: () => Date.UTC(2026, 8, 11, 14, 5),
    log: { line: (s) => lines.push(s) },
    ...extra,
  });
  const byConnection = Object.fromEntries(built.map((s) => [s.connection, s]));
  // EVERY reply that left the node, whichever connection it went out on — streams (the ⏳ train)
  // and fresh sends alike, because the defect can surface as either.
  const replies = () => built.flatMap((s) => [
    ...s.streams.map((h) => ({ connection: s.connection, chatId: h.chatId })),
    ...s.sent.map((m) => ({ connection: s.connection, chatId: m.chatId })),
  ]);
  return { app, built, byConnection, replies, lines, io, state: () => convState };
}

const deliver = (spy, chatId, body, { atE = true } = {}) => spy.onIncoming(body, {
  chatId, chatName: chatId.replace(/^!/, ''), network: 'whatsapp',
  userId: DANDO, senderName: 'Dando', authorized: true, msgKey: `m-${chatId}-${body.length}`,
  atEStart: atE, atEAnywhere: atE,
});

// A routed reply settles on an ASYNC resolution (the mouth's roster walk), so poll rather than
// guess a number of microtask ticks.
async function waitFor(check, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return check();
}

describe('a locally placed reply goes out on the connection the message ARRIVED on', () => {
  // THE REPRODUCTION. Two connections, the being's own output resolving to `secondary`, the
  // message heard on `primary`, and no peer mouth at all. Before the fix the reply left on
  // `secondary` carrying a chatId only `primary` has ever seen.
  it('THE SELF-DM: heard on primary, answered on primary — never on the being\'s own `secondary`', async () => {
    const { app, byConnection, replies } = await bootWith(KG());

    // The precondition: this really is the split shape. Both connections are held, and only
    // `primary` is an ear.
    expect(Object.keys(byConnection).sort()).toEqual(['primary', 'secondary']);

    await deliver(byConnection.primary, SELF_DM, 'e hola');

    expect(replies()).toEqual([{ connection: 'primary', chatId: SELF_DM }]);
    expect(byConnection.secondary.streams).toEqual([]);
    expect(byConnection.secondary.sent).toEqual([]);

    app.stop();
  });

  // …and it is not a property of 1:1 chats. Same rule in a group.
  it('a GROUP heard on primary is answered on primary', async () => {
    const { app, byConnection, replies } = await bootWith(KG());
    await deliver(byConnection.primary, AN_GROUP, 'e hola');
    expect(replies()).toEqual([{ connection: 'primary', chatId: AN_GROUP }]);
    app.stop();
  });

  // THE OPERATOR'S SENTENCE, with the mouth link actually in the path. `peer_spine` is declared,
  // so boot builds the mouth and the reply path really asks it — and it really declines, because
  // Rodz is not a participant of the Self-DM. "if rodz is not in, reply flows back from primary."
  it('WITH a peer spine that DECLINES (rodz is not in the chat), the reply still flows back from primary', async () => {
    const { app, byConnection, replies } = await bootWith(KG_WITH_PEER());

    await deliver(byConnection.primary, SELF_DM, 'e hola');

    expect(replies()).toEqual([{ connection: 'primary', chatId: SELF_DM }]);
    app.stop();
  });

  // …AND THE LOG SAYS WHICH FACT ANSWERED. The ear answering is now a REFUSAL by the mouth, not
  // a property of the chat id, so the line that explains it has to name the mouth and the reason.
  it('says the mouth is not in the chat, and that the ear is therefore answering', async () => {
    const { app, byConnection, lines } = await bootWith(KG());
    await deliver(byConnection.primary, SELF_DM, 'e hola');
    const said = lines.filter((l) => l.includes('[mouth]') && l.includes(SELF_DM.slice(1)));
    expect(said.join('\n')).toContain("'secondary' is not a member of");
    expect(said.join('\n')).toContain("'primary' says this reply");
    app.stop();
  });

  // THE LOCK ON THE BASELINE: one connection, one bridge, nothing to choose between. Unchanged.
  it('a ONE-connection node is untouched', async () => {
    const { app, built, byConnection, replies } = await bootWith(SINGLE());
    expect(built.map((s) => s.connection)).toEqual(['primary']);
    await deliver(byConnection.primary, AN_GROUP, 'e hola');
    expect(replies()).toEqual([{ connection: 'primary', chatId: AN_GROUP }]);
    app.stop();
  });
});

// ── …AND THE OTHER HALF: WHEN THE MOUTH *IS* IN THE CHAT, THE MOUTH SPEAKS ─────────────────────
// THE OPERATOR'S RULE (2026-09-12, verbatim): *"whatever it is, if secondary is present it should
// be used as mouth. all agents have different wake words, but they all use secondary to speak,
// when present."*
//
// THE REPRODUCTION (measured on dolly, node `do`, 2026-09-12). `primary` = anrodz42 is the ear,
// `secondary` = dolly.egpt is the mouth, a message arrived on the ear in a group BOTH accounts
// are in — and D answered from the operator's OWN number. The old test asked whether the mouth's
// declared `account:` STRING equalled the ear's, found it did not, and concluded "that chat id
// does not exist on secondary". Every clause of that was true and the conclusion was still wrong:
// secondary has its OWN id for the same real chat and is a member of it. The right question is
// not a string comparison, it is "does the mouth's account actually HAVE this chat?" — answered
// by resolving it, exactly as the peer mouth already resolves one across a socket.
describe('a chat the mouth\'s account is ALSO in is answered by the MOUTH, in the mouth\'s own room', () => {
  it('the reply goes out on secondary, carrying SECONDARY\'s chat id — not the ear\'s', async () => {
    const { app, byConnection, replies } = await bootWith(KG());
    expect(Object.keys(byConnection).sort()).toEqual(['primary', 'secondary']);

    await deliver(byConnection.primary, BOTH_AS_PRIMARY, 'e hola');
    await waitFor(() => replies().length > 0);

    expect(replies()).toEqual([{ connection: 'secondary', chatId: BOTH_AS_SECONDARY }]);
    // …and NOTHING on the ear: the whole reply lives on the other account.
    expect(byConnection.primary.streams).toEqual([]);
    expect(byConnection.primary.sent).toEqual([]);
    app.stop();
  });

  it('says so, naming both rooms and both connections', async () => {
    const { app, byConnection, replies, lines } = await bootWith(KG());
    await deliver(byConnection.primary, BOTH_AS_PRIMARY, 'e hola');
    await waitFor(() => replies().length > 0);

    const said = lines.filter((l) => l.includes('[mouth]') && l.includes('is'));
    expect(said.join('\n')).toContain(BOTH_AS_PRIMARY.slice(1));
    expect(said.join('\n')).toContain(BOTH_AS_SECONDARY.slice(1));
    expect(said.join('\n')).toContain("'secondary'");
    app.stop();
  });

  // A TRANSLATION THAT FAILS FALLS BACK TO THE EAR AND SAYS SO — never a post into a wrong room
  // and never a dropped reply. Membership says yes (Rodz is in the group as primary sees it) and
  // the roster walk then finds no room on secondary keyed alike.
  it('membership yes but NO room to translate to: the ear answers, loudly', async () => {
    const { app, byConnection, replies, lines } = await bootWith(KG());
    await deliver(byConnection.primary, ORPHAN_GROUP, 'e hola');
    await waitFor(() => replies().length > 0);

    expect(replies()).toEqual([{ connection: 'primary', chatId: ORPHAN_GROUP }]);
    expect(byConnection.secondary.streams).toEqual([]);
    expect(byConnection.secondary.sent).toEqual([]);
    const said = lines.filter((l) => l.includes('[mouth]')).join('\n');
    expect(said).toContain('no-match');
    expect(said).toContain("'primary' says this reply");
    app.stop();
  });

  // AN AGENT'S OWN `use:` STILL WINS. Pinned to the ear, the being speaks on the ear even in a
  // chat the mouth is in — the mouth is whichever connection outboundOf names, and nothing here
  // moves that.
  it('an agent pinned with `use: primary` still speaks on primary', async () => {
    const cfg = KG();
    cfg.agents.egpt.use = 'primary';
    const { app, byConnection, replies } = await bootWith(cfg);

    await deliver(byConnection.primary, BOTH_AS_PRIMARY, 'e hola');
    await waitFor(() => replies().length > 0);

    expect(replies()).toEqual([{ connection: 'primary', chatId: BOTH_AS_PRIMARY }]);
    app.stop();
  });

  // TWO CONNECTIONS ON ONE ACCOUNT are not a translation at all: the same rooms under the same
  // ids, so the mouth speaks with the id it was handed and nothing is resolved.
  it('two connections on the SAME account speak with the id they were handed', async () => {
    const cfg = KG();
    cfg.beeper.secondary.account = 'anrodz42@example.com';
    const { app, byConnection, replies } = await bootWith(cfg);

    await deliver(byConnection.primary, AN_GROUP, 'e hola');
    await waitFor(() => replies().length > 0);

    expect(replies()).toEqual([{ connection: 'secondary', chatId: AN_GROUP }]);
    app.stop();
  });
});

// ── THE MOUTH SPEAKS WHENEVER IT IS PRESENT, NOT ONLY WHEN THE CHAT CAN BE KEYED ──────────────
// *"dont over complicate, if there's Rodz, use it, always... primary is last and surest
// fallback"* (operator 2026-09-12). MEMBERSHIP and TRANSLATION are two different questions, and
// failing the second must not silently answer the first. The participant key refuses a 1:1
// between the two accounts on purpose, and until now that refusal ended the matter: the ear
// answered, in a chat the mouth is trivially a member of. The translation itself does NOT go away
// — Beeper exposes no shared id and to post AS Rodz you need Rodz's room id — so the fix is to
// stop giving up after one attempt.
describe('the mouth is present but the chat cannot be KEYED — the room is found another way', () => {
  // THE REPRODUCTION. A 1:1 between the two accounts: crossAccountChatKey returns null for it
  // (deliberately), so on HEAD the reply falls back to the ear. Both accounts hold the same last
  // message, which is what identifies the room instead.
  it('the 1:1 between the two accounts: the reply still goes out on SECONDARY, in its own room', async () => {
    const { app, byConnection, replies } = await bootWith(KG());

    await deliver(byConnection.primary, DM_AS_PRIMARY, 'e hola');
    await waitFor(() => replies().length > 0);

    expect(replies()).toEqual([{ connection: 'secondary', chatId: DM_AS_SECONDARY }]);
    expect(byConnection.primary.streams).toEqual([]);
    expect(byConnection.primary.sent).toEqual([]);
    app.stop();
  });

  // …and the participant key really is refusing it, so the case above is not passing by accident.
  it('the participant key really does refuse that chat — the other way is what answered', () => {
    const raw = { id: DM_AS_PRIMARY, type: 'single', participants: { items: DESKTOPS[PRIMARY][DM_AS_PRIMARY] } };
    expect(crossAccountChatKey(raw, [AN, RODZ])).toBeNull();
  });

  // TWO ROOMS THAT SAID THE SAME THING refuse rather than pick — the message-sized version of
  // findChatByKey's `ambiguous`. The decoy's copy is one second off, so it is normally told apart;
  // move it onto the same second and the identification stops being evidence.
  it('two of the mouth\'s rooms answering alike is an ambiguity — the ear answers, and says so', async () => {
    const restore = SAID[DECOY_ON_SECONDARY];
    SAID[DECOY_ON_SECONDARY] = [{ id: 'd-1', text: 'buenas', timestamp: '2026-09-11T14:00:00.000Z' }];
    try {
      const { app, byConnection, replies, lines } = await bootWith(KG());
      await deliver(byConnection.primary, DM_AS_PRIMARY, 'e hola');
      await waitFor(() => replies().length > 0);

      expect(replies()).toEqual([{ connection: 'primary', chatId: DM_AS_PRIMARY }]);
      expect(byConnection.secondary.streams).toEqual([]);
      expect(byConnection.secondary.sent).toEqual([]);
      expect(lines.filter((l) => l.includes('[mouth]')).join('\n')).toContain('ambiguous');
      app.stop();
    } finally { SAID[DECOY_ON_SECONDARY] = restore; }
  });

  // THE TIMESTAMP IS THE GUARD, and it is the measured one: two views of ONE message agree to the
  // SECOND (one side truncates the milliseconds the other kept). A body that matches at a
  // different second is a different message, and a different message is not an identification.
  it('the same words at a different second are not the same message — no match, the ear answers', async () => {
    const restore = SAID[DM_AS_SECONDARY];
    SAID[DM_AS_SECONDARY] = [{ id: 's-1', text: 'buenas', timestamp: '2026-09-11T14:00:09.000Z' }];
    try {
      const { app, byConnection, replies } = await bootWith(KG());
      await deliver(byConnection.primary, DM_AS_PRIMARY, 'e hola');
      await waitFor(() => replies().length > 0);
      expect(replies()).toEqual([{ connection: 'primary', chatId: DM_AS_PRIMARY }]);
      app.stop();
    } finally { SAID[DM_AS_SECONDARY] = restore; }
  });

  // AND WHEN EVERY WAY FAILS IT READS LIKE A FAILURE. Under the old rule the ear answering was
  // routine; under this one the mouth was PRESENT and could not be reached, which is notable —
  // the line has to say so, name both ways that were tried, and name who is speaking instead.
  it('every way exhausted: the log says the mouth WAS present, what was tried, and who spoke', async () => {
    const { app, byConnection, replies, lines } = await bootWith(KG());
    await deliver(byConnection.primary, ORPHAN_GROUP, 'e hola');
    await waitFor(() => replies().length > 0);

    expect(replies()).toEqual([{ connection: 'primary', chatId: ORPHAN_GROUP }]);
    const said = lines.filter((l) => l.includes('[mouth]')).join('\n');
    expect(said).toContain('MOUTH UNREACHABLE');
    expect(said).toContain("'secondary'");            // …was present
    expect(said).toContain('participants:');          // the key tier, tried
    expect(said).toContain('last message:');          // the message tier, tried
    expect(said).toContain("'primary' says this reply");
    app.stop();
  });

  // THE MOUTH THAT IS NOT A MEMBER IS STILL ROUTINE. The loud line above must not fire for the
  // Self-DM, which is the honest permanent case: Rodz is not in it and never will be.
  it('a chat the mouth is NOT in is not reported as unreachable — it is simply not its chat', async () => {
    const { app, byConnection, replies, lines } = await bootWith(KG());
    await deliver(byConnection.primary, SELF_DM, 'e hola');
    await waitFor(() => replies().length > 0);

    expect(replies()).toEqual([{ connection: 'primary', chatId: SELF_DM }]);
    expect(lines.join('\n')).not.toContain('MOUTH UNREACHABLE');
    app.stop();
  });
});

// ── THE OTHER DIRECTION: WHICH CONNECTION *HEARS* (operator 2026-09-13) ───────────────────────
// *"secondary only hears if primary is not present."*
//
// Everything above is about the MOUTH. This is the EAR, and the operator's sentence makes it a
// PER-CHAT question rather than a per-node one: in a chat the ear's account is a member of, the
// ear's own arrival is the one that dispatches and the other connection stays silent; in a chat
// the ear is NOT in — someone DMs the second account directly — that connection is the only ear
// there will ever be, and until now it was deaf (boot wrapped it outbound-only, so its onMessage
// was a no-op: the bridge received the DM, transcribed the voice note, and dropped it).
//
// EXACTLY ONE CONNECTION EVER WAKES for a given chat, which is why nothing here deduplicates:
// the two ears are made MUTUALLY EXCLUSIVE per chat, so the same human message is never
// dispatched twice and there is nothing to compare content hashes about.
describe('the ear is a PER-CHAT question — the second connection hears only what the ear is not in', () => {
  // ONE real message in a group BOTH accounts are in. Beeper is Matrix, so it arrives TWICE —
  // once per account, in each account's own room. Exactly one of those arrivals may dispatch.
  it('a chat BOTH accounts are in: exactly ONE dispatch, and it is the EAR\'s', async () => {
    const { app, byConnection, replies } = await bootWith(KG());

    await deliver(byConnection.primary, BOTH_AS_PRIMARY, 'e hola');
    await deliver(byConnection.secondary, BOTH_AS_SECONDARY, 'e hola');
    await waitFor(() => replies().length > 0);
    // …and give a SECOND dispatch every chance to show up before declaring there wasn't one.
    await waitFor(() => replies().length > 1, { timeoutMs: 200 });

    // One reply. It is the EAR's arrival, spoken by the mouth in the mouth's own room (the rule
    // the block above locks) — not two, which is what a second dispatch would look like here.
    expect(replies()).toEqual([{ connection: 'secondary', chatId: BOTH_AS_SECONDARY }]);
    app.stop();
  });

  // THE LIVE DEFECT. A DM straight to the second account: the ear is not a party to it, so no
  // other arrival of this message exists anywhere. Deaf here means the message is simply lost.
  it('a chat ONLY the second connection is in: it wakes, and answers there', async () => {
    const { app, byConnection, replies } = await bootWith(KG());

    await deliver(byConnection.secondary, SECONDARY_ONLY, 'e hola');
    await waitFor(() => replies().length > 0);

    expect(replies()).toEqual([{ connection: 'secondary', chatId: SECONDARY_ONLY }]);
    expect(byConnection.primary.streams).toEqual([]);
    expect(byConnection.primary.sent).toEqual([]);
    app.stop();
  });

  // AGENTS ARE PER SPINE, NOT PER CONNECTION. The persona hides this: an unaddressed message falls
  // through to the default being carrying the bridge's own atE, so it answers whatever connection
  // eared it. Any OTHER agent goes through the router's connection gate, which compares the
  // arrival's connection against the node's ear — and would silence every agent but the persona in
  // exactly the chats only this connection can hear. There is nothing for that gate to arbitrate
  // here: the arrival IS the only one, by construction.
  it('an addressed NON-persona agent wakes on it too — the ear is per chat, not per agent', async () => {
    const { app, byConnection, replies } = await bootWith(KG_WITH_K());

    await deliver(byConnection.secondary, SECONDARY_ONLY, 'k hola', { atE: false });
    await waitFor(() => replies().length > 0);

    expect(replies()).toEqual([{ connection: 'secondary', chatId: SECONDARY_ONLY }]);
    app.stop();
  });

  // …and the same agent, in the chat BOTH accounts are in, still answers ONCE — from the ear's
  // arrival. The gate that arbitrates two DECLARED ears is untouched; this connection simply never
  // produces a second arrival to arbitrate.
  it('that agent is not woken twice in a chat both accounts are in', async () => {
    const { app, byConnection, replies } = await bootWith(KG_WITH_K());

    await deliver(byConnection.primary, BOTH_AS_PRIMARY, 'k hola', { atE: false });
    await deliver(byConnection.secondary, BOTH_AS_SECONDARY, 'k hola', { atE: false });
    await waitFor(() => replies().length > 0);
    await waitFor(() => replies().length > 1, { timeoutMs: 200 });

    expect(replies()).toEqual([{ connection: 'secondary', chatId: BOTH_AS_SECONDARY }]);
    app.stop();
  });

  // UNKNOWN FAILS CLOSED, AND CLOSED HERE IS THE OPPOSITE OF THE MOUTH'S. For the mouth, an
  // unreadable roster reads as "not a member" so the ear speaks — safe, because the reply is
  // going out either way. Here it must read as "the ear IS present": waking on a guess risks the
  // same human message being dispatched twice, which is the one failure this rule prevents.
  it('UNKNOWN membership does NOT wake it — a guess here costs a double answer', async () => {
    const { app, byConnection, replies } = await bootWith(KG());

    await deliver(byConnection.secondary, ROSTER_UNREADABLE, 'e hola');
    await waitFor(() => replies().length > 0, { timeoutMs: 200 });

    expect(replies()).toEqual([]);
    app.stop();
  });

  // `primary_gui` IS NEVER AN EAR, and the membership question cannot see why: it is a second
  // install of the account the ear already is, so it holds the SAME room under the SAME id — and
  // an account's own entry in its own roster carries no phone number, so asking "is the ear in
  // this chat" of the GUI's own copy answers a definite NO. Waking on that answer would genuinely
  // double every message. The refusal has to be structural, and it is: by name, and by the
  // account it declares.
  it('a second install of the EAR\'s OWN account never wakes, however the roster reads', async () => {
    const { app, byConnection, replies } = await bootWith(KG_WITH_GUI());
    expect(Object.keys(byConnection).sort()).toEqual(['primary', 'primary_gui']);

    await deliver(byConnection.primary_gui, GUI_GROUP, 'e hola');
    await waitFor(() => replies().length > 0, { timeoutMs: 200 });

    expect(replies()).toEqual([]);
    app.stop();
  });

  // THE BOOT-TIME EAR IS UNTOUCHED — no gate, no membership question, no new latency: a chat the
  // ear hears is dispatched exactly as it was, including one the second account is not in at all.
  it('the ear itself is ungated — a chat only IT is in is answered as before', async () => {
    const { app, byConnection, replies } = await bootWith(KG());

    await deliver(byConnection.primary, AN_GROUP, 'e hola');
    await waitFor(() => replies().length > 0);

    expect(replies()).toEqual([{ connection: 'primary', chatId: AN_GROUP }]);
    app.stop();
  });

  // …AND THE BOOT LINE SAYS WHAT THE CONNECTION NOW IS. It used to say nothing arriving on it
  // could wake anything, which stopped being true.
  it('boot says the second connection is a mouth AND a conditional ear, not a deaf one', async () => {
    const { app, lines } = await bootWith(KG());
    const said = lines.filter((l) => l.includes("'secondary'")).join('\n');
    expect(said).not.toContain('nothing arriving on it can wake anything');
    expect(said).toContain("'primary'");
    app.stop();
  });
});

// ── …AND WHO THE NODE SPEAKS AS, handed to the connection that hears (operator 2026-09-16) ──────
// A picker @-mention of Rodz arrives on the EAR, which cannot know on its own that Rodz is this
// node's mouth (src/bridges/beeper.mjs mouthMentionsAsAddresses). Boot holds both connections, so
// boot hands every bridge the MEASURED identities of the accounts its beings post through.
describe('every bridge is told which accounts this node speaks through', () => {
  it('two connections: the EAR is handed the MOUTH\'s identities, never its own', async () => {
    const { app, byConnection } = await bootWith(KG());
    expect(await byConnection.primary.opts.speakingIdentities()).toEqual(SELF_IDENTITY[SECONDARY]);
    app.stop();
  });

  it('one connection: ear and mouth are one account, so it is handed its own', async () => {
    const { app, byConnection } = await bootWith(SINGLE());
    expect(await byConnection.primary.opts.speakingIdentities()).toEqual(SELF_IDENTITY[PRIMARY]);
    app.stop();
  });
});

// ── THE RESOLVER'S HALF OF IT ──────────────────────────────────────────────────────────────────
// boot answers "which bridge" and the sender asks; these lock the ASKING, which is the whole of
// src/spine/sender.mjs's diff — makeOutbound hands the chat to `bridgeOf` so an arrival-aware
// resolver can answer with it, and every other property of the reply path is unchanged.
function fakeBridge(tag) {
  const streams = [], sent = [];
  return {
    tag, streams, sent,
    renderFrame: (opts, text) => `«${text}»`,
    send(chat, text, opts) { sent.push({ chat, text, opts }); return { confirmedId: `${tag}-1` }; },
    startStream(chat, init, opts) {
      const h = { chat, init, opts, frames: [], finals: [], delivered: false, update(t) { h.frames.push(t); }, async finish(t) { h.finals.push(t); h.delivered = true; } };
      streams.push(h); return h;
    },
  };
}

describe('makeOutbound hands the CHAT to the bridge resolver', () => {
  it('the resolver may answer per-chat — the ear\'s bridge for a chat it heard', () => {
    const own = fakeBridge('own');
    const ear = fakeBridge('ear');
    const sender = createSender({ bridge: own, bridgeOf: (being, chatId) => (chatId === '!heard' ? ear : null) });

    sender.open('!heard', { being: 'e' });
    expect(ear.streams).toHaveLength(1);
    expect(own.streams).toHaveLength(0);
  });

  // THE UNKNOWN-ARRIVAL LOCK. A chat with no arrival connection — a synthesized turn, a heartbeat,
  // the shell surface — resolves to nothing, and the being's own connection answers exactly as it
  // did before this existed.
  it('a chat the resolver knows nothing about falls back to the being\'s own bridge', () => {
    const own = fakeBridge('own');
    const ear = fakeBridge('ear');
    const sender = createSender({ bridge: own, bridgeOf: (being, chatId) => (chatId === '!heard' ? ear : null) });

    sender.open('!never-heard', { being: 'e' });
    expect(own.streams).toHaveLength(1);
    expect(ear.streams).toHaveLength(0);
  });

  // A ONE-ARGUMENT RESOLVER — every existing caller and every existing test — is unaffected: the
  // extra argument is simply ignored, and the being's own connection answers as it always has.
  it('a resolver that only reads the being is byte-identical', () => {
    const own = fakeBridge('own');
    const being = fakeBridge('being');
    const sender = createSender({ bridge: own, bridgeOf: () => being });

    sender.open('!anything', { being: 'e' });
    expect(being.streams).toHaveLength(1);
    expect(own.streams).toHaveLength(0);
  });

  // THE PEER-TAKES-IT LOCK. When the mouth accepts the reply nothing about this changes: the peer
  // stream is the one that is minted, and no bridge on this node — arrival or otherwise — is asked
  // to post anything.
  it('when the PEER takes the reply, no local bridge posts at all', async () => {
    const own = fakeBridge('own');
    const ear = fakeBridge('ear');
    const peerStreams = [];
    const peerMouth = {
      async route() { return { id: '!peer-room' }; },
      startStream(chat, init, opts) {
        const h = { chat, init, opts, delivered: false, update() {}, async finish() { h.delivered = true; } };
        peerStreams.push(h); return h;
      },
    };
    const sender = createSender({ bridge: own, bridgeOf: (being, chatId) => (chatId === '!heard' ? ear : null), peerMouth });

    const out = sender.open('!heard', { being: 'e' });
    await out.finish({ text: 'hola' });

    expect(peerStreams).toHaveLength(1);
    expect(ear.streams).toEqual([]);
    expect(ear.sent).toEqual([]);
    expect(own.streams).toEqual([]);
    expect(own.sent).toEqual([]);
  });
});

// ── A HEARTBEAT'S `post:` IS SAID BY THE MOUTH TOO (2026-09-16) ─────────────────────────────────
// The prime-of-the-day: a command beat declared for a group both accounts are in posts its stdout
// into that group. It is the NODE speaking, not a being — so it is ONE send through the outbound
// resolver's `say` (boot.mjs dispatchHeartbeatPost → sender.mjs makeOutbound), never the reply
// train: no "⏳ Thinking…" placeholder that could bind to a being's message streaming in the same
// chat, and no edit. The mouth says it in ITS OWN room, the port signs it, nothing stamps it, and
// the transcript records it under 'system'. Same two-account world as above; the beat is declared
// where the resolver really reads it (config/rooms.yaml, keyed by the entity's namespace, with the
// entity folder on disk for the walk).
describe('a heartbeat `post:` in a chat both accounts are in is said ONCE by the MOUTH, unstamped and signed', () => {
  const TEXT = 'Hola muchachas y muchachos, el primo del día es 1637';

  // A command child that prints the prime and exits 0 — the runner's shape either way (win32 POSIX
  // bash: (bash, ['-c', cmd], opts); elsewhere (cmd, { shell: true })).
  const fakeSpawn = (calls) => (file, a, b) => {
    const [cmd, opts] = Array.isArray(a) ? [a[1], b] : [file, a];
    const on = {}, out = {};
    const child = { stdout: { setEncoding() {}, on(ev, cb) { out[ev] = cb; } }, on(ev, cb) { on[ev] = cb; return child; } };
    calls.push({ cmd, opts });
    setTimeout(() => { if (cmd.includes('nth_prime')) out.data?.('1637\n'); on.exit?.(0, null); on.close?.(0, null); }, 0);
    return child;
  };

  it('posted ONCE, by the mouth, in its own room — node signature, no stamp, no placeholder, no edit, recorded; the ear sends nothing', async () => {
    const calls = [];
    const { app, byConnection, io, state } = await bootWith(KG(), { spawn: fakeSpawn(calls) });

    // an ordinary, unaddressed line in the group: the chat becomes known (conversations.yaml) and
    // its arrival on the ear is on record — which is what the mouth translates from
    await deliver(byConnection.primary, BOTH_AS_PRIMARY, 'buenos días', { atE: false });
    const [, contact] = Object.entries(state().contacts.whatsapp ?? {}).find(([, c]) => c?.slug) ?? [];
    expect(contact?.slug, JSON.stringify(state())).toBeTruthy();
    const ns = `whatsapp/${contact.slug}`;

    await fs.mkdir(join(_PRIVATE_HOME, 'conversations', 'whatsapp', contact.slug), { recursive: true });
    await fs.mkdir(join(_PRIVATE_HOME, 'config'), { recursive: true });
    await fs.writeFile(join(_PRIVATE_HOME, 'config', 'rooms.yaml'), [
      'rooms:',
      `  "${ns}":`,
      '    heartbeats:',
      '      primo-del-dia:',
      '        frequency: 24h',
      `        command: '"$BASH" scripts/nth_prime.sh 259'`,
      '        post: "Hola muchachas y muchachos, el primo del día es {stdout}"',
      '',
    ].join('\n'));

    // the next arrival refreshes config (spine.mjs handleFast → the loader's reload), then a tick fires it
    await deliver(byConnection.primary, BOTH_AS_PRIMARY, 'qué tal', { atE: false });
    const before = { sent: byConnection.primary.sent.length, streams: byConnection.primary.streams.length };
    app.spine.tick();
    await waitFor(() => byConnection.secondary.sent.length > 0);
    await new Promise((r) => setTimeout(r, 20));   // room for a second send or an edit to show up, if there were one

    expect(calls.some((c) => c.cmd.includes('nth_prime.sh 259'))).toBe(true);
    expect(byConnection.secondary.sent).toEqual([{ chatId: BOTH_AS_SECONDARY, text: `${TEXT}${encodeNodeSignature('kg')}` }]);   // once, its OWN room; only the node signature
    expect(byConnection.secondary.streams).toEqual([]);                  // no ⏳ placeholder
    expect(byConnection.primary.streams.length).toBe(before.streams);
    expect(byConnection.secondary.edits).toEqual([]);                    // no edit on either bridge
    expect(byConnection.primary.edits).toEqual([]);
    expect(byConnection.primary.sent.length).toBe(before.sent);          // the ear says nothing

    const transcript = [...io.files.entries()].find(([p]) => p.endsWith('transcript.md') && p.includes(contact.slug))?.[1] ?? '';
    expect(transcript).toContain(TEXT);
    app.stop();
  });
});

// ── …AND WITH NO ARRIVAL AT ALL: THE CHAT IS PLACED WHEN THE BEAT IS REGISTERED (2026-09-16) ──────
// A scheduled send has no arrival to learn its chat's connection from: after a restart the chat is
// unknown, the mouth is chosen, and it would post on the mouth's account with the EAR's room id. So
// the loader has boot place every chat a beat sends into, once, at registration: each connection is
// asked for the chat (chatRaw, the read the mouth makes) and the holder goes into the record an
// arrival writes. NOT "a registered chat is the ear's": a per-chat ear registers chats with the
// SECOND account's ids (the SECONDARY_ONLY case above), so the holder is asked, never assumed.
// And an `agent:` beat's REPLY is posted — as that being, stamped, from the mouth, once.
describe('a scheduled send with NO arrival since boot: the chat is placed at registration', () => {
  const TEXT = 'Hola muchachas y muchachos, el primo del día es 1637';
  const SLUG = 'primos';

  // the chat is KNOWN (conversations.yaml) but nothing has arrived in it since this boot
  const known = (chatId, slug = SLUG) => ({ ...emptyState(), contacts: { whatsapp: { [chatId]: { slug } } } });
  async function declare(rows) {
    await fs.mkdir(join(_PRIVATE_HOME, 'config'), { recursive: true });
    const text = ['rooms:'];
    for (const [slug, beats] of Object.entries(rows)) {
      await fs.mkdir(join(_PRIVATE_HOME, 'conversations', 'whatsapp', slug), { recursive: true });
      text.push(`  "whatsapp/${slug}":`, '    heartbeats:', ...beats.map((l) => `      ${l}`));
    }
    await fs.writeFile(join(_PRIVATE_HOME, 'config', 'rooms.yaml'), `${text.join('\n')}\n`);
  }
  const printsPrime = (file, a, b) => {
    const [cmd] = Array.isArray(a) ? [a[1]] : [file];
    const on = {}, out = {};
    const child = { stdout: { setEncoding() {}, on(ev, cb) { out[ev] = cb; } }, on(ev, cb) { on[ev] = cb; return child; } };
    setTimeout(() => { if (cmd.includes('nth_prime')) out.data?.('1637\n'); on.exit?.(0, null); on.close?.(0, null); }, 0);
    return child;
  };
  // THE SEAL IS STRUCTURAL TO THE BRIDGE (operator 2026-09-16: "it can go out without body emoji, but
  // structurally it must be guaranteed that it is signed by the bridge"). The port brackets EVERY send
  // with the node's bridge layers (persona-wrap.mjs, applyLayers joins with ' ') and appends the
  // invisible node id; only the persona stamp is conditional. A visible close is configured here so
  // both halves are proven on the wire: signed with no stamp (post:) and signed with one (a being).
  const SEAL = '🏰';
  const sealed = (core) => `${core} ${SEAL}${encodeNodeSignature('kg')}`;
  const kgSealed = () => ({ ...KG(), bridge_signature_close: SEAL });
  // a fake GAUSS: its own stamp, no handles shared with anyone, speaking through the default mouth
  const withGauss = () => { const c = kgSealed(); c.agents.gauss = { configuration: 'egpt', handles: ['gauss'], name: 'Gauss', body_emoji: '📐' }; return c; };
  const scriptedSession = (script) => (opts) => ({
    sessionId: opts.sessionId ?? 'sess-g',
    async turn(m) { script.prompts.push(m); return script.reply(m); },
    close() {},
  });
  const quiet = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  it('post: — NO arrival since boot, and it still lands from the MOUTH in its own room', async () => {
    await declare({ [SLUG]: ['primo-del-dia:', '  frequency: 24h', `  command: '"$BASH" scripts/nth_prime.sh 259'`, '  post: "Hola muchachas y muchachos, el primo del día es {stdout}"'] });
    const { app, byConnection, lines } = await bootWith(kgSealed(), { state: known(BOTH_AS_PRIMARY), spawn: printsPrime });

    expect(lines.join('\n')).toContain(`[heartbeat] whatsapp/${SLUG}:primo-del-dia: ${BOTH_AS_PRIMARY} is a chat on 'primary'`);
    app.spine.tick();
    await waitFor(() => byConnection.secondary.sent.length > 0);
    await quiet();

    expect(byConnection.secondary.sent).toEqual([{ chatId: BOTH_AS_SECONDARY, text: sealed(TEXT) }]);   // no stamp, but the bridge's seal + node id
    expect(byConnection.primary.sent).toEqual([]);
    expect(byConnection.primary.streams).toEqual([]);
    expect(byConnection.secondary.streams).toEqual([]);
    app.stop();
  });

  it('a chat NO connection holds: said loudly at registration, and nothing is recorded as its holder', async () => {
    const NOWHERE = '!a-room-neither-account-has';
    await declare({ nadie: ['primo-del-dia:', '  frequency: 24h', `  command: '"$BASH" scripts/nth_prime.sh 259'`, '  post: "{stdout}"'] });
    const { app, lines } = await bootWith(KG(), { state: known(NOWHERE, 'nadie'), spawn: printsPrime });

    const loud = lines.filter((l) => l.includes('NO CONNECTION HOLDS'));
    expect(loud).toHaveLength(1);
    expect(loud[0]).toContain(NOWHERE);
    expect(loud[0]).toContain("'primary'");
    expect(loud[0]).toContain("'secondary'");
    expect(lines.some((l) => l.includes('is a chat on'))).toBe(false);
    app.stop();
  });

  it('prompt: — the turn gets the one-liner, and its reply is posted ONCE from the mouth, stamped as the being, with no placeholder', async () => {
    const LINE = 'Di en una frase por qué 1637 es primo.';
    const script = { prompts: [], reply: () => ({ text: 'Porque ningún primo hasta 40 lo divide.' }) };
    await declare({ [SLUG]: ['el-porque:', '  frequency: 24h', '  agent: gauss', `  prompt: "${LINE}"`] });
    const { app, byConnection, lines, io } = await bootWith(withGauss(), { state: known(BOTH_AS_PRIMARY), makeSession: scriptedSession(script) });

    expect(lines.join('\n')).toContain(`[heartbeat] whatsapp/${SLUG}:el-porque: ${BOTH_AS_PRIMARY} is a chat on 'primary'`);   // A applies to turn beats too
    app.spine.tick();
    await waitFor(() => byConnection.secondary.sent.length > 0);
    await quiet();

    expect(script.prompts).toHaveLength(1);
    expect(script.prompts[0]).toContain(LINE);
    expect(byConnection.secondary.sent).toEqual([{ chatId: BOTH_AS_SECONDARY, text: `📐 Gauss: Porque ningún primo hasta 40 lo divide. ${SEAL}${encodeNodeSignature('kg', 'gauss')}` }]);   // the being's stamp AND the bridge's seal + node id, naming the being (kg/gauss)
    expect(byConnection.secondary.streams).toEqual([]);
    expect(byConnection.secondary.edits).toEqual([]);
    expect(byConnection.primary.sent).toEqual([]);
    expect(byConnection.primary.streams).toEqual([]);
    const transcript = [...io.files.entries()].find(([p]) => p.endsWith('transcript.md') && p.includes(SLUG))?.[1] ?? '';
    expect(transcript).toContain('Porque ningún primo hasta 40 lo divide.');
    expect(lines.some((l) => l.includes('el-porque: ok in'))).toBe(true);
    app.stop();
  });

  it('prompt: — a silent reply ("…", "...", empty) posts NOTHING', async () => {
    for (const silence of ['…', '...', '']) {
      const script = { prompts: [], reply: () => ({ text: silence }) };
      await declare({ [SLUG]: ['el-porque:', '  frequency: 24h', '  agent: gauss', '  prompt: "Di algo solo si hace falta."'] });
      const { app, byConnection, lines } = await bootWith(withGauss(), { state: known(BOTH_AS_PRIMARY), makeSession: scriptedSession(script) });
      app.spine.tick();
      await waitFor(() => lines.some((l) => l.includes('el-porque: ok in')));
      await quiet();
      expect(script.prompts, JSON.stringify(silence)).toHaveLength(1);
      expect(byConnection.secondary.sent, JSON.stringify(silence)).toEqual([]);
      expect(byConnection.primary.sent).toEqual([]);
      expect(byConnection.secondary.streams).toEqual([]);
      app.stop();
    }
  });

  it('prompt: — a FAILED turn posts nothing and the beat logs FAILED', async () => {
    for (const reply of [() => { throw new Error('model unavailable'); }, () => ({ text: '!! claude exit 1: rate limit' })]) {
      const script = { prompts: [], reply };
      await declare({ [SLUG]: ['el-porque:', '  frequency: 24h', '  agent: gauss', '  prompt: "Di en una frase por qué 1637 es primo."'] });
      const { app, byConnection, lines } = await bootWith(withGauss(), { state: known(BOTH_AS_PRIMARY), makeSession: scriptedSession(script) });
      app.spine.tick();
      await waitFor(() => lines.some((l) => l.includes('el-porque: FAILED in')));
      await quiet();
      expect(lines.some((l) => l.includes('el-porque: FAILED in'))).toBe(true);
      expect(byConnection.secondary.sent).toEqual([]);
      expect(byConnection.primary.sent).toEqual([]);
      expect(byConnection.secondary.streams).toEqual([]);
      expect(byConnection.primary.streams).toEqual([]);
      app.stop();
    }
  });
});

// ── THE NODE'S OWN LINES OBEY THE MOUTH TOO (operator 2026-09-16) ────────────────────────────────
// *"every output of the spine comes through the mouth."* A command reply and the lifecycle lines
// carry no being, and rode `rawBridgeOf(null, chat)` — the connection HOLDING the chat, which is the
// ear for every chat the ear heard. In the Self-DM that is the rule (the mouth is not in it); in a
// chat the mouth IS in — a group, or a Self chat that is the operator's admin group with the mouth
// in it — the operator's own account answered its own command. They now go through the placement
// every other line takes (sender.mjs makeOutbound `say`), with `null` for the being.
describe('a node-level line in a chat the mouth is in is said by the MOUTH, in its own room', () => {
  // The Self chat is the group both accounts are in — the admin-group shape.
  const ADMIN_SELF = () => { const c = KG(); c.networks = { whatsapp: { chat_ids: [BOTH_AS_PRIMARY] } }; return c; };
  const SELF_IS_DM = () => { const c = KG(); c.networks = { whatsapp: { chat_ids: [SELF_DM] } }; return c; };

  it('a COMMAND reply typed in a chat both accounts are in goes out on secondary, in secondary\'s room', async () => {
    const { app, byConnection } = await bootWith(KG());
    await deliver(byConnection.primary, BOTH_AS_PRIMARY, '/status');
    await waitFor(() => byConnection.secondary.sent.length > 0);

    expect(byConnection.secondary.sent.length).toBeGreaterThan(0);
    expect(new Set(byConnection.secondary.sent.map((m) => m.chatId))).toEqual(new Set([BOTH_AS_SECONDARY]));
    expect(byConnection.primary.sent).toEqual([]);
    app.stop();
  });

  it('the going-down "↻ /restart…" line, in a Self chat the mouth is in, goes out on secondary', async () => {
    const exits = [];
    const { app, byConnection } = await bootWith(ADMIN_SELF(), { exit: (code) => exits.push(code) });
    await deliver(byConnection.primary, BOTH_AS_PRIMARY, '/restart');
    await waitFor(() => exits.length > 0);

    const going = byConnection.secondary.sent.filter((m) => m.text.includes('↻'));
    expect(going.map((m) => m.chatId)).toEqual([BOTH_AS_SECONDARY]);
    expect(byConnection.primary.sent.filter((m) => m.text.includes('↻'))).toEqual([]);
    expect(exits).toEqual([43]);
    app.stop();
  });

  // THE LOCK: the Self-DM, which only the operator's account has. Membership is measured and says
  // no, so the ear speaks — the rule itself, not a special case for Self.
  it('in the Self-DM (the mouth is not in it) the command reply and the going-down line stay on primary', async () => {
    const exits = [];
    const { app, byConnection } = await bootWith(SELF_IS_DM(), { exit: (code) => exits.push(code) });
    await deliver(byConnection.primary, SELF_DM, '/status');
    await waitFor(() => byConnection.primary.sent.length > 0);
    await deliver(byConnection.primary, SELF_DM, '/restart');
    await waitFor(() => exits.length > 0);

    expect(new Set(byConnection.primary.sent.map((m) => m.chatId))).toEqual(new Set([SELF_DM]));
    expect(byConnection.primary.sent.some((m) => m.text.includes('↻'))).toBe(true);
    expect(byConnection.secondary.sent).toEqual([]);
    expect(exits).toEqual([43]);
    app.stop();
  });
});

// ── THE 🎧 LISTENING MARK IS PLACED THROUGH THE ONE PLACEMENT (2026-09-16) ─────────────────────────
// kg, live: `reaction 🎧 by An → #7780` — the mark came from the operator's own account, because the
// bridge reacted on the connection that received the note. boot now hands every connection the one
// placement boot's own lines use (`outboundFor`, makeOutbound with the mouth, being null), and the
// bridge places and removes the mark through it while the note is being DECODED — which is BEFORE the
// note's arrival is stamped. So a note that is the first thing heard in a chat since boot must still
// reach the mouth's own room: the connection that received it is recorded as the chat's holder first.
describe('the 🎧 listening mark: boot hands each connection the one placement', () => {
  const place = async (spy, chatId, msgId) => {
    const out = spy.opts.outboundFor(chatId);
    const keyOf = out.keyOf(msgId, 'listening');
    const up = await out.react(msgId, '🎧', keyOf, 'listening', { temporary: true });
    const down = up ? await out.react(msgId, '🎧', keyOf, 'listening', { remove: true }) : false;
    return { up, down };
  };

  it('NO arrival since boot, a chat both accounts are in: the MOUTH places and removes it on its own copy; the ear does neither', async () => {
    const { app, byConnection } = await bootWith(KG());
    expect(await place(byConnection.primary, BOTH_AS_PRIMARY, 'ear-note')).toEqual({ up: true, down: true });
    expect(byConnection.secondary.reactions).toEqual([{ chatId: BOTH_AS_SECONDARY, id: 'mouth-note', key: '🎧' }]);
    expect(byConnection.secondary.unreactions).toEqual([{ chatId: BOTH_AS_SECONDARY, id: 'mouth-note', key: '🎧' }]);
    expect(byConnection.primary.reactions).toEqual([]);
    expect(byConnection.primary.unreactions).toEqual([]);
    app.stop();
  });

  // do, live 2026-09-17: `reaction 🎧 by An → #2838 [Maria (Mom) Palma]` — a 1:1 chat the mouth is not
  // in. The Self-DM is the same shape: the mouth is a different account and has no room there, so the
  // mark is not placed from the operator's account instead.
  it('the Self-DM (the mouth is not in it): no 🎧 from either account', async () => {
    const { app, byConnection } = await bootWith(KG());
    expect(await place(byConnection.primary, SELF_DM, 'self-note')).toEqual({ up: false, down: false });
    expect(byConnection.primary.reactions).toEqual([]);
    expect(byConnection.secondary.reactions).toEqual([]);
    app.stop();
  });

  it('the note delivered on the MOUTH\'s own connection: the mouth places it with its own id', async () => {
    const { app, byConnection } = await bootWith(KG());
    expect(await place(byConnection.secondary, BOTH_AS_SECONDARY, 'mouth-note')).toEqual({ up: true, down: true });
    expect(byConnection.secondary.reactions).toEqual([{ chatId: BOTH_AS_SECONDARY, id: 'mouth-note', key: '🎧' }]);
    expect(byConnection.primary.reactions).toEqual([]);
    app.stop();
  });

  it('a ONE-connection node: its own bridge places and removes it', async () => {
    const { app, byConnection } = await bootWith(SINGLE());
    expect(await place(byConnection.primary, AN_GROUP, 'solo-note')).toEqual({ up: true, down: true });
    expect(byConnection.primary.reactions).toEqual([{ chatId: AN_GROUP, id: 'solo-note', key: '🎧' }]);
    expect(byConnection.primary.unreactions).toEqual([{ chatId: AN_GROUP, id: 'solo-note', key: '🎧' }]);
    app.stop();
  });
});
