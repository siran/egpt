// side-group-mouth-room.test.mjs — how the node learns Rodz's own room for a side group it made, by
// id, never by title (operator 2026-10-18). The real boot() on kg's two-connection shape: the primary
// makes the group P and posts the opener there itself; the opener's canary names P; Rodz's account
// receives its copy in its own room R (any chat — the bridge's awaitMessage); R is stored as the
// alias's mouth_chat, and the being's replies in P then go out on Rodz's connection, in R.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-side-group-mouth-room-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { shortChatId } from '../src/bridges/chat-id.mjs';
import { encodeNodeSignature, encodeChatCanary } from '../src/node-signature.mjs';

let boot, emptyState, ensureContact, recordThread, patchContact, aliasContact;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact, recordThread, patchContact, aliasContact } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const PRIMARY = 'TOK-primary';       // anrodz42 — the ear, and the account that makes every side group
const SECONDARY = 'TOK-secondary';   // dolly.egpt — Rodz, the mouth
const NAME_OF = { [PRIMARY]: 'primary', [SECONDARY]: 'secondary' };
const AN = '+16468217865';
const RODZ = '+13472576794';
const RODZ_ID = '@whatsapp_lid-rodz:beeper.local';
const ORIGIN = '!origin-as-primary-sees-it';
const P_FULL = '!sidegroup:beeper.local';    // what the primary's create returns
const P = shortChatId(P_FULL);
const R = '!sidegroup-as-rodz-sees-it';      // Rodz's own room for the same group
const LOGS_NAME = 'eGPT Logs';               // log_to_group
const LOGS = 'logsroom';
// The same title on another group Rodz is in: nothing may find a group by its title.
const DECOY = '!decoy-same-title';

const self = (id) => ({ id, isSelf: true });
const member = (id, phoneNumber) => ({ id, phoneNumber, fullName: id });
const WORLD = {
  [PRIMARY]: {
    [ORIGIN]: [self('an@beeper.local'), member(RODZ_ID, RODZ), member('lulu@beeper.local', '+34600000000')],
    [P]: [self('an@beeper.local'), member(RODZ_ID, RODZ)],
  },
  [SECONDARY]: {
    [R]: [self('rodz@dolly.local'), member('an@dolly.local', AN)],
    [DECOY]: [self('rodz@dolly.local'), member('an@dolly.local', AN)],
  },
};
const TITLE_OF = { [R]: 'SI+Origen-x', [DECOY]: 'SI+Origen-x' };
const SELF_IDENTITY = { [PRIMARY]: [AN, '@anrodriguez:beeper.com'], [SECONDARY]: [RODZ, '@dolly-egpt:beeper.com'] };
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const rawChat = (token, id) => (WORLD[token][id] ? { id, type: 'group', accountID: 'whatsapp', title: TITLE_OF[id] ?? id, participants: { items: WORLD[token][id] } } : null);

// One spy per connection. What the primary sends into P reaches Rodz's account as its own copy in R.
// `refuse`: chat ids the PRIMARY's Beeper refuses (send → null, stream not delivered) — a forced drop.
function fakeTransport({ refuse = [] } = {}) {
  const built = [];
  const waiters = [];
  const start = async (opts) => {
    const token = opts.beeperToken;
    const spy = { connection: NAME_OF[token], token, onIncoming: opts.onIncoming, sent: [], streams: [], created: [] };
    built.push(spy);
    const refused = (chatId) => token === PRIMARY && refuse.includes(shortChatId(chatId));
    const copyToRodz = (chatId, text) => {
      if (token !== PRIMARY || shortChatId(chatId) !== P) return;
      const copy = { id: `copy-${waiters.length}`, chatID: R, text };
      for (const w of [...waiters]) if (w.test(copy)) { waiters.splice(waiters.indexOf(w), 1); w.done(copy); }
    };
    return {
      async send(text, o) {
        if (refused(o?.chatId)) return null;
        spy.sent.push({ text, chatId: o?.chatId }); copyToRodz(o?.chatId, text); return { ok: true, confirmedId: Promise.resolve(`m-${spy.sent.length}`) };
      },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = !refused(o?.chatId); } };
        spy.streams.push(h); return h;
      },
      async editMessage() { return true; },
      async createGroup(o) { spy.created.push(o); return { success: true, chatID: P_FULL }; },
      async chatHasParticipant(chat, identity) {
        const roster = WORLD[token][shortChatId(chat)] ?? WORLD[token][chat];
        return roster ? roster.some((p) => (p.phoneNumber && digits(p.phoneNumber) === digits(identity)) || p.id === identity) : null;
      },
      async selfIdentities() { return SELF_IDENTITY[token]; },
      async chatRaw(chat) { return rawChat(token, chat) ?? rawChat(token, shortChatId(chat)); },
      async listChatsRaw() { return Object.keys(WORLD[token]).map((id) => rawChat(token, id)); },
      async listMessagesRaw() { return []; },
      async resolveUserIdByPhone(d) { return digits(d) === digits(RODZ) ? RODZ_ID : null; },
      awaitMessage(chat, test, ms) {
        if (token !== SECONDARY) return Promise.resolve(null);
        return new Promise((done) => { waiters.push({ chat, test, done }); setTimeout(() => done(null), ms).unref?.(); });
      },
      async resolveChatIdByTitle() { spy.byTitle = (spy.byTitle ?? 0) + 1; return DECOY; },
      async resolveChatId(n) { return n === LOGS_NAME ? LOGS : n; },
      getChatName: (id) => (shortChatId(id) === P ? 'SI+Origen' : null),
      sendFailure: (id) => (refused(id) ? 'POST /v1/chats/…/messages → 404 Chat not found' : null),
      isAlive: () => true, stop() {},
    };
  };
  return { start, built, waiters };
}

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
const fakeSession = (opts) => ({ sessionId: opts.sessionId ?? 'sess-1', async turn(m, onUpdate) { onUpdate?.('ok'); return { text: 'ok', sessionId: this.sessionId }; }, close() {} });

const KG = () => ({
  node_name: 'kg', node_role: 'primary', user_name: 'An',
  beeper: {
    primary: { account: 'anrodz42@example.com', token: PRIMARY, phone: AN },
    secondary: { account: 'dolly.egpt@example.com', token: SECONDARY, phone: RODZ },
  },
  agents: { egpt: { configuration: 'egpt', default: true, handles: ['e'], name: 'E' } },
});

async function bootWith(config, state, transport = {}) {
  const { start, built } = fakeTransport(transport);
  let convState = state;
  const lines = [];
  const app = await boot({
    readConfig: () => config, startBridge: start, makeSession: fakeSession, probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState, writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0, now: () => Date.UTC(2026, 9, 18, 22, 0),
    log: { line: (s) => lines.push(s) },
  });
  const byConnection = Object.fromEntries(built.map((s) => [s.connection, s]));
  return { app, byConnection, lines, state: () => convState };
}
async function waitFor(check, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const v = check(); if (v) return v; await new Promise((r) => setTimeout(r, stepMs)); }
  return check();
}
const seed = () => {
  const st = ensureContact(emptyState(), 'whatsapp', ORIGIN, { pushedName: 'Origen' }).state;
  return recordThread(st, 'whatsapp', ORIGIN, 'th-1', '2026-10-18T00:00:00Z', 'egpt');
};
const say = (spy, chatId, body, extra = {}) => spy.onIncoming(body, { chatId, chatName: chatId === ORIGIN ? 'Origen' : 'SI+Origen-x', network: 'whatsapp', userId: '@anrodriguez:beeper.com', senderName: 'An', authorized: true, isSender: true, msgKey: `k-${body}`, ...extra });

describe('a side group\'s mouth room is learned from Rodz\'s copy of the opener, by id', () => {
  it('/split: the primary makes P and posts the opener there; Rodz\'s copy in R makes R the mouth room; replies in P go out in R', async () => {
    const { app, byConnection, state } = await bootWith(KG(), seed());
    await say(byConnection.primary, ORIGIN, '/e split x');
    await waitFor(() => state().contacts.whatsapp[P]?.mouth_chat);
    expect(byConnection.primary.created).toEqual([expect.objectContaining({ participantIDs: [RODZ_ID], title: 'SI+Origen-x' })]);
    expect(byConnection.primary.sent.map((m) => shortChatId(m.chatId))).toContain(P);   // the opener, from the creator
    expect(state().contacts.whatsapp[P]).toMatchObject({ parent_chat: ORIGIN, mouth_chat: R });

    await say(byConnection.primary, P, 'e hola', { atEStart: true, atEAnywhere: true, msgKey: 'k-2' });
    await waitFor(() => byConnection.secondary.streams.length || byConnection.secondary.sent.length);
    expect([...byConnection.secondary.streams, ...byConnection.secondary.sent].map((m) => m.chatId)).toEqual([R]);
    expect(byConnection.primary.byTitle ?? 0).toBe(0);
    expect(byConnection.secondary.byTitle ?? 0).toBe(0);
    app.stop();
  });
});

// THE AUTOMATIC GROUP (reply_in_side_group, operator 2026-10-18): the message arrives in the ORIGIN and
// the reply goes to P, where nothing has arrived — so the node must know P is a room on the primary,
// the account that made it (live 2026-10-19: the reply went out on Rodz's account addressed by P, a
// room only the primary has). And whatever is lost there says so on log_to_group, once.
describe('the automatic group: its reply goes out on the account that holds it, and a lost one is reported', () => {
  const automatic = () => patchContact(seed(), 'whatsapp', ORIGIN, { reply_in_side_group: true });
  const ask = (spy) => say(spy, ORIGIN, 'e eso es cierto?', { atEStart: true, atEAnywhere: true, msgKey: 'k-ask' });
  const outOf = (spy) => [...spy.streams, ...spy.sent].map((m) => m.chatId);

  it('REPRODUCE: the first reply, right after the group is made, is said by Rodz in R — never on Rodz\'s account addressed by P', async () => {
    const { app, byConnection, state } = await bootWith(KG(), automatic());
    await ask(byConnection.primary);
    await waitFor(() => byConnection.secondary.streams.length || byConnection.secondary.sent.length || byConnection.primary.streams.length);
    expect(state().contacts.whatsapp[P]).toMatchObject({ aliasOf: ORIGIN, automatic: true, mouth_chat: R });
    expect(outOf(byConnection.secondary)).toEqual([R]);
    expect(byConnection.primary.streams).toEqual([]);
    app.stop();
  });

  it('REPRODUCE: after a restart (the group already stored, nothing arrived in it since), the reply is still said in R', async () => {
    const st = aliasContact(automatic(), 'whatsapp', P, ORIGIN, { transcript: 'si-origen', automatic: true, mouth_chat: R });
    const { app, byConnection } = await bootWith(KG(), st);
    await ask(byConnection.primary);
    await waitFor(() => byConnection.secondary.streams.length || byConnection.secondary.sent.length || byConnection.primary.streams.length);
    expect(byConnection.primary.created).toEqual([]);
    expect(outOf(byConnection.secondary)).toEqual([R]);
    app.stop();
  });

  it('REPRODUCE: the primary refuses every send into P → ONE log_to_group line for the opener and ONE for the reply, naming the group, its id and why', async () => {
    const { app, byConnection } = await bootWith({ ...KG(), log_to_group: LOGS_NAME }, automatic(), { refuse: [P] });
    await ask(byConnection.primary);
    const logged = () => [...byConnection.primary.sent, ...byConnection.secondary.sent].filter((m) => m.chatId === LOGS).map((m) => m.text);
    await waitFor(() => logged().length >= 2, { timeoutMs: 15000 });
    await new Promise((r) => setTimeout(r, 200));
    const lines = logged();
    expect(lines.filter((t) => /opener/.test(t))).toHaveLength(1);
    expect(lines.filter((t) => /reply/.test(t))).toHaveLength(1);
    expect(lines).toHaveLength(2);
    for (const t of lines) {
      expect(t).toContain(P);
      expect(t).toContain('SI+Origen');
      expect(t).toContain('404 Chat not found');
    }
    app.stop();
  }, 30000);
});

// ── THE OTHER NODE (operator 2026-10-19: "DO makes a correct mapping of the group, so that don and other
// Do's beings can output to the right channel"). kg and do, each a real boot(), on the SAME two
// accounts. kg (node_role primary) makes every side group; do links it from the opener. What a primary
// connection posts into P reaches the other primary connection as its own message in P and every Rodz
// connection in R — each copy noted before any gate, as the bridge's noteArrival is. `secondaryFirst`:
// Rodz's copies land before the primary's.
const DON_THREAD = 'th-do-1';
const DO = () => ({ ...KG(), node_name: 'do', node_role: 'secondary', agents: { don: { configuration: 'egpt', default: true, handles: ['don'], name: 'Don' } } });
function sharedAccounts({ secondaryFirst = false, gapMs = 30 } = {}) {
  const spies = [];
  let n = 0;
  const deliver = (spy, chatId, text, from) => {
    const raw = { id: `w-${++n}`, chatID: chatId, text };
    spy.arrivals.push(raw);
    for (const w of [...spy.waiters]) if ((w.chat == null || w.chat === chatId) && w.test(raw)) { spy.waiters.splice(spy.waiters.indexOf(w), 1); w.done(raw); }
    return spy.onIncoming(text, { chatId, chatName: chatId === ORIGIN ? 'Origen' : 'SI+Origen-x', network: 'whatsapp', authorized: true, msgKey: raw.id, ...from });
  };
  const asAn = { userId: '@anrodriguez:beeper.com', senderName: 'An', isSender: true };
  const toRodz = { userId: 'an@dolly.local', senderName: 'An', isSender: false };
  const fanOut = (from, text) => {
    const same = () => spies.filter((s) => s !== from && s.token === from.token).forEach((s) => deliver(s, P, text, asAn));
    const rodz = () => spies.filter((s) => s.token === SECONDARY).forEach((s) => deliver(s, R, text, toRodz));
    const [first, second] = secondaryFirst ? [rodz, same] : [same, rodz];
    setTimeout(first, 0);
    setTimeout(second, gapMs);
  };
  const transport = () => async (opts) => {
    const token = opts.beeperToken;
    const spy = { connection: NAME_OF[token], token, onIncoming: opts.onIncoming, sent: [], streams: [], created: [], arrivals: [], waiters: [] };
    spies.push(spy);
    return {
      spy,
      async send(text, o) {
        spy.sent.push({ text, chatId: o?.chatId });
        if (token === PRIMARY && shortChatId(o?.chatId) === P) fanOut(spy, text);
        return { ok: true, confirmedId: Promise.resolve(`m-${spy.sent.length}`) };
      },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      async editMessage() { return true; },
      async createGroup(o) { spy.created.push(o); return { success: true, chatID: P_FULL }; },
      async chatHasParticipant(chat, identity) {
        const roster = WORLD[token][shortChatId(chat)] ?? WORLD[token][chat];
        return roster ? roster.some((p) => (p.phoneNumber && digits(p.phoneNumber) === digits(identity)) || p.id === identity) : null;
      },
      async selfIdentities() { return SELF_IDENTITY[token]; },
      async chatRaw(chat) { return rawChat(token, chat) ?? rawChat(token, shortChatId(chat)); },
      async listChatsRaw() { return Object.keys(WORLD[token]).map((id) => rawChat(token, id)); },
      async listMessagesRaw() { return []; },
      async resolveUserIdByPhone(d) { return digits(d) === digits(RODZ) ? RODZ_ID : null; },
      recentMessages: (chat) => (chat == null ? [...spy.arrivals] : spy.arrivals.filter((m) => m.chatID === shortChatId(chat))),
      awaitMessage(chat, test, ms) {
        return new Promise((done) => {
          const w = { chat: chat == null ? null : shortChatId(chat), test, done };
          spy.waiters.push(w);
          setTimeout(() => { const i = spy.waiters.indexOf(w); if (i >= 0) { spy.waiters.splice(i, 1); done(null); } }, ms).unref?.();
        });
      },
      async resolveChatIdByTitle() { spy.byTitle = (spy.byTitle ?? 0) + 1; return DECOY; },
      async resolveChatId(name) { return name; },
      getChatName: (id) => (shortChatId(id) === P ? 'SI+Origen-x' : null),
      sendFailure: () => null,
      isAlive: () => true, stop() {},
    };
  };
  return { transport, deliver, asAn, toRodz };
}
async function bootOn(accounts, config, state) {
  let convState = state;
  const lines = [];
  const built = [];
  const start = accounts.transport();
  const app = await boot({
    readConfig: () => config, startBridge: async (opts) => { const b = await start(opts); built.push(b.spy); return b; },
    makeSession: fakeSession, probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState, writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0, now: () => Date.UTC(2026, 9, 18, 22, 0),
    log: { line: (s) => lines.push(s) },
  });
  const byConnection = Object.fromEntries(built.map((s) => [s.connection, s]));
  return { app, byConnection, lines, state: () => convState };
}

describe('the other node links every side group from its opener; its beings\' replies there are said by Rodz in Rodz\'s room', () => {
  const doSeed = () => recordThread(ensureContact(emptyState(), 'whatsapp', ORIGIN, { pushedName: 'Origen' }).state, 'whatsapp', ORIGIN, DON_THREAD, '2026-10-18T00:00:00Z', 'don');
  const automatic = (st) => patchContact(st, 'whatsapp', ORIGIN, { reply_in_side_group: true });
  async function twoNodes({ kgState = seed(), doState = doSeed(), ...world } = {}) {
    const accounts = sharedAccounts(world);
    const kg = await bootOn(accounts, KG(), kgState);
    const dolly = await bootOn(accounts, DO(), doState);
    return { kg, dolly, stop: () => { kg.app.stop(); dolly.app.stop(); } };
  }
  // A line typed in a chat both nodes hear on the primary account.
  const both = (n, chatId, body, extra) => Promise.all([say(n.kg.byConnection.primary, chatId, body, extra), say(n.dolly.byConnection.primary, chatId, body, extra)]);
  const outOf = (spy) => [...spy.streams, ...spy.sent].map((m) => m.chatId);
  const sideOn = (node) => node.state().contacts.whatsapp[P];
  const doCreatedNothing = (n) => expect([...n.dolly.byConnection.primary.created, ...n.dolly.byConnection.secondary.created]).toEqual([]);
  // don answers; every reply must be Rodz's, in R — never the primary's, never Rodz's addressed by P.
  async function donSaysItInR(n, chatId = P, body = 'don hola') {
    const before = outOf(n.dolly.byConnection.secondary).length;
    await say(n.dolly.byConnection.primary, chatId, body, { atEStart: true, atEAnywhere: true, msgKey: `k-${body}` });
    await waitFor(() => outOf(n.dolly.byConnection.secondary).length > before || n.dolly.byConnection.primary.streams.length);
    expect(outOf(n.dolly.byConnection.secondary).length).toBeGreaterThan(before);
    expect(new Set(outOf(n.dolly.byConnection.secondary))).toEqual(new Set([R]));
    expect(n.dolly.byConnection.primary.streams).toEqual([]);
  }

  // The opener of a /join room kg made before /join was retired (2026-10-25), as do hears it: on the
  // primary in P (An's copy) and on Rodz's account in R.
  const JOIN_OPENER = `🔗 Side-room of Origen${encodeNodeSignature('kg', 'egpt')}${encodeChatCanary({ group: P, origin: ORIGIN, kind: 'join', transcript: 'SI+Origen-x' })}`;
  async function doAlone({ doState = doSeed(), ...world } = {}) {
    const accounts = sharedAccounts(world);
    const dolly = await bootOn(accounts, DO(), doState);
    const primaryCopy = () => accounts.deliver(dolly.byConnection.primary, P, JOIN_OPENER, accounts.asAn);
    const rodzCopy = () => accounts.deliver(dolly.byConnection.secondary, R, JOIN_OPENER, accounts.toRodz);
    return { n: { dolly }, dolly, primaryCopy, rodzCopy };
  }

  it('REPRODUCE /join (a room made before the retirement): do records it as an alias of the origin with kg\'s transcript key and Rodz\'s room R; don\'s reply there is said by Rodz in R', async () => {
    const { n, dolly, primaryCopy, rodzCopy } = await doAlone();
    await Promise.all([primaryCopy(), rodzCopy()]);
    await waitFor(() => sideOn(dolly)?.mouth_chat);
    expect(sideOn(dolly)).toEqual({ aliasOf: ORIGIN, transcript: 'SI+Origen-x', mouth_chat: R });
    await donSaysItInR(n);
    doCreatedNothing(n);
    dolly.app.stop();
  });

  it('REPRODUCE /split: do records its own conversation with parent_chat, don\'s thread forked by /split\'s copy code, and R', async () => {
    const n = await twoNodes();
    await both(n, ORIGIN, '/e split y');
    await waitFor(() => sideOn(n.dolly)?.mouth_chat && sideOn(n.kg)?.mouth_chat);
    expect(sideOn(n.kg)).toMatchObject({ parent_chat: ORIGIN, mouth_chat: R });
    const split = sideOn(n.dolly);
    expect(split).toMatchObject({ parent_chat: ORIGIN, mouth_chat: R });
    expect(split.aliasOf).toBeUndefined();
    expect(split.agents.don.threadId).toMatch(/^[0-9a-f-]{36}$/);   // a new, diverging thread for do's own being
    expect(split.agents.egpt).toBeUndefined();                         // never kg's
    expect(n.dolly.state().contacts.whatsapp[ORIGIN].agents.don.threadId).toBe(DON_THREAD);
    expect(split.slug).toBe(n.dolly.state().contacts.whatsapp[ORIGIN].slug);   // a fork in do's own folder of the chat
    expect(n.dolly.lines.some((l) => l.includes(`split: can't find don's session for #${DON_THREAD}`))).toBe(true);   // /split's own copy step ran
    await donSaysItInR(n);
    doCreatedNothing(n);
    n.stop();
  });

  it('REPRODUCE automatic: do links the group and records R; don\'s next reply goes there, said by Rodz', async () => {
    const n = await twoNodes({ kgState: automatic(seed()), doState: automatic(doSeed()) });
    // Addressed to E only: on do the bridge reads no mention of don (else don replies too and do makes its own group).
    await Promise.all([
      say(n.kg.byConnection.primary, ORIGIN, 'e eso es cierto?', { atEStart: true, atEAnywhere: true, msgKey: 'k-ask' }),
      say(n.dolly.byConnection.primary, ORIGIN, 'e eso es cierto?', { atEStart: false, atEAnywhere: false, msgKey: 'k-ask' }),
    ]);
    await waitFor(() => sideOn(n.dolly)?.mouth_chat);
    expect(sideOn(n.dolly)).toEqual({ aliasOf: ORIGIN, transcript: sideOn(n.kg).transcript, automatic: true, mouth_chat: R });
    await donSaysItInR(n, ORIGIN, 'don y ahora?');
    doCreatedNothing(n);
    n.stop();
  });

  it('REPRODUCE: a line in P between the primary\'s copy of the opener and Rodz\'s (live: 0.4–0.8 s apart) is answered by Rodz in R, never from the primary', async () => {
    const { n, dolly, primaryCopy, rodzCopy } = await doAlone();
    const heard = primaryCopy();
    expect(dolly.byConnection.secondary.arrivals).toEqual([]);   // the primary's copy is in; Rodz's is not yet
    setTimeout(rodzCopy, 400);
    await donSaysItInR(n);
    expect(sideOn(dolly)).toEqual({ aliasOf: ORIGIN, transcript: 'SI+Origen-x', mouth_chat: R });
    await heard;
    dolly.app.stop();
  });

  it('do after a restart (the linked group stored, nothing arrived in P since): don\'s reply is still Rodz\'s, in R', async () => {
    const linked = aliasContact(automatic(doSeed()), 'whatsapp', P, ORIGIN, { transcript: 'SI+Origen', automatic: true, mouth_chat: R });
    const dolly = await bootOn(sharedAccounts(), DO(), linked);
    await donSaysItInR({ dolly }, ORIGIN, 'don sigues?');
    expect(dolly.byConnection.primary.created).toEqual([]);
    dolly.app.stop();
  });

  it('REPRODUCE: Rodz\'s copy of the opener reaches do before the primary\'s — linked all the same, R found among what already arrived', async () => {
    const { n, dolly, primaryCopy, rodzCopy } = await doAlone();
    await rodzCopy();
    await primaryCopy();
    await waitFor(() => sideOn(dolly)?.mouth_chat);
    expect(sideOn(dolly)).toEqual({ aliasOf: ORIGIN, transcript: 'SI+Origen-x', mouth_chat: R });
    doCreatedNothing(n);
    dolly.app.stop();
  });

  it('an automatic opener posted before 2026-10-19 (its canary: group + origin) still links on do, and Rodz\'s copy gives R', async () => {
    const accounts = sharedAccounts();
    const dolly = await bootOn(accounts, DO(), automatic(doSeed()));
    const opener = `🔗 Side-room of Origen${encodeNodeSignature('kg')}${encodeChatCanary(`${P} ${ORIGIN}`)}`;
    await accounts.deliver(dolly.byConnection.secondary, R, opener, accounts.toRodz);
    await accounts.deliver(dolly.byConnection.primary, P, opener, accounts.asAn);
    await waitFor(() => sideOn(dolly)?.mouth_chat);
    expect(sideOn(dolly)).toEqual({ aliasOf: ORIGIN, transcript: 'SI+Origen-x', automatic: true, mouth_chat: R });
    dolly.app.stop();
  });

  it('REPRODUCE: a room do had only seen (a member spoke first, no being thread) is converted to the alias in place', async () => {
    const { dolly, primaryCopy, rodzCopy } = await doAlone({ doState: ensureContact(doSeed(), 'whatsapp', P, { pushedName: 'SI+Origen-x' }).state });
    await Promise.all([primaryCopy(), rodzCopy()]);
    await waitFor(() => sideOn(dolly)?.mouth_chat);
    expect(sideOn(dolly)).toEqual({ aliasOf: ORIGIN, transcript: 'SI+Origen-x', mouth_chat: R });
    dolly.app.stop();
  });

  it('a room do already answered in (its own entry, a being thread) is left alone and logged once', async () => {
    const own = recordThread(ensureContact(doSeed(), 'whatsapp', P, { pushedName: 'SI+Origen-x' }).state, 'whatsapp', P, 'th-do-p', '2026-10-18T00:00:00Z', 'don');
    const { dolly, primaryCopy, rodzCopy } = await doAlone({ doState: own });
    await Promise.all([primaryCopy(), rodzCopy()]);
    await waitFor(() => dolly.lines.some((l) => /left for the operator/.test(l)));
    await new Promise((r) => setTimeout(r, 100));
    expect(sideOn(dolly)).toMatchObject({ agents: { don: { threadId: 'th-do-p' } } });
    expect(sideOn(dolly).aliasOf).toBeUndefined();
    expect(sideOn(dolly).mouth_chat).toBeUndefined();
    expect(dolly.lines.filter((l) => /left for the operator/.test(l))).toHaveLength(1);
    dolly.app.stop();
  });
});
