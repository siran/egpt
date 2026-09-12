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
import { dirname } from 'node:path';
import { createSender } from '../src/spine/sender.mjs';

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
const NAME_OF = { [PRIMARY]: 'primary', [SECONDARY]: 'secondary' };

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

// A chat's TYPE is the first field of the cross-account key and both accounts report it alike.
const TYPE_OF = {
  [SELF_DM]: 'single',
  [AN_GROUP]: 'group',
  [BOTH_AS_PRIMARY]: 'group',
  [BOTH_AS_SECONDARY]: 'group',
  [ORPHAN_GROUP]: 'group',
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
  },
};

// What each install reports as its OWN account's identity — `/v1/accounts`, the `phoneNumber` on
// the `isSelf` user entry (measured live 2026-09-12 on both installs: +16468217865 on anrodz42's,
// +13472576794 on dolly.egpt's). This is where the two exclusion identities come from: they are
// MEASURED per connection, not configured.
const SELF_IDENTITY = { [PRIMARY]: [AN], [SECONDARY]: [RODZ] };

const digits = (v) => String(v ?? '').replace(/\D/g, '');

// ── THE TRANSPORT SEAM ──────────────────────────────────────────────────────────────────────
// One spy per startBridge CALL, carrying which connection it is and the onIncoming the port late-
// binds, so a case can drive a real inbound through either connection.
function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const token = opts.beeperToken;
    const world = DESKTOPS[token] ?? {};
    const spy = { connection: NAME_OF[token] ?? token, token, opts, onIncoming: opts.onIncoming, sent: [], streams: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      async chatHasParticipant(chat, identity) {
        const roster = world[chat];
        if (!roster) return null;                     // a chat this account does not have is UNKNOWN
        return roster.some((p) => p.phoneNumber && digits(p.phoneNumber) === digits(identity));
      },
      // THE THREE READS THE MOUTH MAKES, all of them of this account's OWN copies.
      async selfIdentities() { return SELF_IDENTITY[token] ?? []; },
      async chatRaw(chat) { return world[chat] ? rawChat(chat, world[chat]) : null; },
      async listChatsRaw() { return Object.entries(world).map(([id, roster]) => rawChat(id, roster)); },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

// The raw /v1/chats payload shape crossAccountChatKey reads: the TYPE and the roster itself,
// never the normalized listChats() item.
const rawChat = (id, roster) => ({ id, type: TYPE_OF[id] ?? 'single', participants: { items: roster } });

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

// A ONE-CONNECTION NODE — the INTENT.md baseline, and the lock that this change costs it nothing.
const SINGLE = () => ({
  node_name: 'kg',
  user_name: 'An',
  beeper: { primary: { account: 'anrodz42@example.com', token: PRIMARY } },
  agents: { egpt: { configuration: 'egpt', default: true, handles: ['e'], name: 'E' } },
});

async function bootWith(config) {
  const { start, built } = fakeTransport();
  const lines = [];
  const io = memIo();
  let convState = emptyState();
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
  });
  const byConnection = Object.fromEntries(built.map((s) => [s.connection, s]));
  // EVERY reply that left the node, whichever connection it went out on — streams (the ⏳ train)
  // and fresh sends alike, because the defect can surface as either.
  const replies = () => built.flatMap((s) => [
    ...s.streams.map((h) => ({ connection: s.connection, chatId: h.chatId })),
    ...s.sent.map((m) => ({ connection: s.connection, chatId: m.chatId })),
  ]);
  return { app, built, byConnection, replies, lines, io };
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
