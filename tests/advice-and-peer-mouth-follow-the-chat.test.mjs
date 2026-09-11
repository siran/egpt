// advice-and-peer-mouth-follow-the-chat.test.mjs — THE LAST TWO OUTBOUNDS THAT NEVER ASKED.
//
// THE OPERATOR'S RULE (2026-09-11, verbatim): *"self doesn't have mouth. if mouth is available
// always use mouth."* One uniform question for every outbound this node places:
//
//     IF THE MOUTH CAN REACH THE CHAT, THE MOUTH SPEAKS. IF IT CANNOT, THE EAR DOES.
//
// 32aa5c1 gave that to REPLIES, b085f2a to the node's own lines, 3d88dff to the member sender.
// TWO call sites were still holding ONE FROZEN BRIDGE — the node's DEFAULT MOUTH — and asking
// nothing:
//
//   · createAdvice (src/spine/advice.mjs, wired in src/spine/boot.mjs) — the mode:auto consult
//     channel. It posts E's /ask question with `bridge.postStatus`, and `bridge` was the fan-out
//     facade, which delegates postStatus to the default mouth.
//   · makePeerMouth's route() (src/spine/boot.mjs) — the roster reads that decide whether the
//     PEER says a reply. `chatHasParticipant` is fanned by the facade; `chatRaw` is NOT, so the
//     membership answer came from the connection that has the chat and the chat PAYLOAD was then
//     asked of an account that does not.
//
// WHY THE ADVICE CHANNEL IS NOT A MOUTH CHANNEL, established from the code and not from taste.
// advice.ask stores the id postStatus handed back; advice.isAnswer(ev) matches an INBOUND event's
// replyToId against those stored ids. An inbound only ever arrives on one of this node's EARS —
// every other connection boot opens is wrapped outbound-only and its onMessage is a no-op
// (src/spine/boot.mjs outboundOnly). So an ask posted on a connection this node does not HEAR can
// never be answered: the ids the operator's quote-reply carries were minted by a different
// account, in a different Matrix room. The round trip closes only if the ask is posted where the
// answer will be heard. On the live kg node — ear `primary` (anrodz42), default mouth `secondary`
// (dolly.egpt), `beeper.use` removed — that is `primary`, and the wiring said `secondary`.
//
// THE SHAPE MODELLED HERE IS THAT LIVE NODE: two Beeper accounts, ingest on 'primary' (the ear
// rule), output resolving by name to 'secondary' (nameDerivedConnection), and no `use:` crutch.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// A PRIVATE profile for this file — egpt-home.mjs freezes EGPT_HOME at module load, so it must be
// set BEFORE the imports below; vi.hoisted is what does that. Private (not the suite's shared
// throwaway) because boot writes state/spine.pid and heartbeats.readonly.yaml, and files running
// in parallel would race on them.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-advice-and-peer-mouth-follow-the-chat-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

let boot, makePeerMouth, createAdvice, emptyState;
beforeAll(async () => {
  ({ boot, makePeerMouth } = await import('../src/spine/boot.mjs'));
  ({ createAdvice } = await import('../src/spine/advice.mjs'));
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

// An account's OWN entry: a matrix id and NO phoneNumber. A member's entry carries the number.
const self = (id) => ({ id });
const member = (id, phoneNumber) => ({ id, phoneNumber });

const SELF_DM = '!self-dm-as-primary-sees-it';
// A group anrodz42 is in and dolly.egpt is NOT — with RODZ present, so the peer mouth SHOULD take
// the reply. The chat id is primary's; secondary's install has no such room.
const RODZ_GROUP = '!rodz-group-as-primary-sees-it';
// The advice channel in each of its two documented forms (config/config-schema.mjs advice_channel:
// "a chat NAME or a raw Beeper room id in SHORT form").
const ADVICE_ROOM = '!egpt-auto-as-primary-sees-it';
const ADVICE_NAME = 'EGPT AUTO';

// The raw chat payloads chatRaw hands back — the ones the cross-account key is computed from.
const RAW = {
  [RODZ_GROUP]: { id: RODZ_GROUP, title: 'rodz group', participants: { items: [self('an@beeper.local'), member('rodz@beeper.local', RODZ)] } },
};
const ROSTERS = {
  [PRIMARY]: {
    [SELF_DM]: [self('an@beeper.local')],
    [RODZ_GROUP]: [self('an@beeper.local'), member('rodz@beeper.local', RODZ)],
  },
  [SECONDARY]: {},   // dolly.egpt has neither room — that is the whole point
};

const digits = (v) => String(v ?? '').replace(/\D/g, '');

// ── THE TRANSPORT SEAM ──────────────────────────────────────────────────────────────────────
// One spy per startBridge CALL. `statuses` is the list this file actually reads: postStatus goes
// through the core's sendAndGetId (src/bridges/beeper-port.mjs), which is the ONE outbound the
// advice channel uses, and recording it separately keeps it apart from the reply that rides the
// same connection in the same turn.
function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const token = opts.beeperToken;
    const world = ROSTERS[token] ?? {};
    const spy = { connection: NAME_OF[token] ?? token, token, onIncoming: opts.onIncoming, sent: [], streams: [], statuses: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      async sendAndGetId(text, o) { spy.statuses.push({ text, chatId: o?.chatId }); return `${spy.connection}-status-1`; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      async chatHasParticipant(chat, identity) {
        const roster = world[chat];
        if (!roster) return null;                     // a chat this account does not have is UNKNOWN
        return roster.some((p) => p.phoneNumber && digits(p.phoneNumber) === digits(identity));
      },
      // ONLY the account that has the room hands back a payload. An account asked about a room it
      // does not have answers null, which is exactly what the live install does with a 404.
      async chatRaw(chat) { return world[chat] ? RAW[chat] ?? null : null; },
      async listChatsRaw() { return Object.keys(world).map((id) => RAW[id]).filter(Boolean); },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

// Complete in-memory fs seam — the same shape tests/reply-follows-the-arrival.test.mjs uses.
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

// The being's reply carries ONE own-line limb — the /ask — plus prose, which is the shape the
// advice channel is actually reached by (src/spine/reply-actions.mjs).
const ASKING_SESSION = (opts) => ({
  sessionId: opts.sessionId ?? 'sess-1',
  async turn() { return { text: 'voy a preguntar.\n/ask should I confirm?', sessionId: 'sess-1' }; },
  close() {},
});
const QUIET_SESSION = (opts) => ({
  sessionId: opts.sessionId ?? 'sess-1',
  async turn(m, onUpdate) { onUpdate?.(`↩ ${m}`); return { text: `↩ ${m}`, sessionId: 'sess-1' }; },
  close() {},
});

const fakeProbe = async () => ({ ok: false, status: 0 });
const fakeSpawn = () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } });

// kg's live shape with the crutch removed: two connections, NO `beeper.use`, no `owner_node`.
const KG = (extra = {}) => ({
  node_name: 'kg',
  user_name: 'An',
  networks: { whatsapp: { chat_ids: [SELF_DM], allowed_users: [DANDO, AN] } },
  beeper: {
    primary: { account: 'anrodz42@example.com', token: PRIMARY },
    secondary: { account: 'dolly.egpt@example.com', token: SECONDARY },
  },
  agents: { egpt: { configuration: 'egpt', default: true, handles: ['e'], name: 'E' } },
  ...extra,
});

// THE SAME TWO CONNECTIONS ON ONE ACCOUNT — two Desktop installs of anrodz42, the primary /
// primary_gui pair the operator runs. The mouth CAN reach everything here, so the mouth speaks:
// the other half of the rule, and what keeps it a rule rather than "the ear always wins".
const KG_ONE_ACCOUNT = (extra = {}) => {
  const c = KG(extra);
  c.beeper.secondary.account = 'anrodz42@example.com';
  return c;
};

// A ONE-CONNECTION NODE — the INTENT.md baseline, and the lock that this costs it nothing.
const SINGLE = (extra = {}) => {
  const c = KG(extra);
  delete c.beeper.secondary;
  return c;
};

async function bootWith(config, { makeSession = QUIET_SESSION } = {}) {
  const { start, built } = fakeTransport();
  const lines = [];
  let convState = emptyState();
  const app = await boot({
    readConfig: () => config,
    startBridge: start,
    makeSession,
    probeEndpoint: fakeProbe,
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0,
    spawn: fakeSpawn,
    reapPort: () => 0,
    now: () => Date.UTC(2026, 8, 11, 14, 5),
    log: { line: (s) => lines.push(s) },
  });
  const byConnection = Object.fromEntries(built.map((s) => [s.connection, s]));
  // Every advice-channel post that left the node, whichever connection carried it.
  const statuses = () => built.flatMap((s) => s.statuses.map((m) => ({ connection: s.connection, chatId: m.chatId, text: m.text })));
  return { app, built, byConnection, statuses, lines };
}

const deliver = (spy, chatId, body, { atE = true } = {}) => spy.onIncoming(body, {
  chatId, chatName: chatId.replace(/^!/, ''), network: 'whatsapp',
  userId: DANDO, senderName: 'Dando', authorized: true, msgKey: `m-${chatId}-${body.length}`,
  atEStart: atE, atEAnywhere: atE,
});

// The /ask limb runs AFTER the reply is recorded and delivered (src/spine/spine.mjs), so poll
// rather than guess a number of microtask ticks.
async function waitFor(check, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return check();
}

// ═══ 1. THE ADVICE CHANNEL ══════════════════════════════════════════════════════════════════
describe('the advice channel is posted on the connection that can REACH it', () => {
  // THE REPRODUCTION, in the form the schema documents first: a raw Beeper room id. That id was
  // minted by anrodz42's install; posting it on dolly.egpt names a room that does not exist.
  it('a RAW-ROOM-ID advice channel is posted on primary, not on the default mouth', async () => {
    const { app, byConnection, statuses } = await bootWith(KG({ advice_channel: ADVICE_ROOM }), { makeSession: ASKING_SESSION });

    // The precondition: this really is the split shape — both connections held, only one ear.
    expect(Object.keys(byConnection).sort()).toEqual(['primary', 'secondary']);

    await deliver(byConnection.primary, RODZ_GROUP, 'e hola');
    await waitFor(() => statuses().length > 0);

    expect(statuses().map((s) => ({ connection: s.connection, chatId: s.chatId }))).toEqual([{ connection: 'primary', chatId: ADVICE_ROOM }]);
    expect(statuses()[0].text).toContain('eGPT needs advice');
    expect(byConnection.secondary.statuses).toEqual([]);
    app.stop();
  });

  // …AND IN THE FORM THE SKELETON SHIPS (`advice_channel: "EGPT AUTO"`). A NAME is not a chat id
  // and resolves per-account — both installs may well have a chat by that name, and they are two
  // different rooms. The node must post in the one it can HEAR the answer in, which is the ear's.
  // This is the case the arrival map can never answer and the config must: the channel is declared
  // in this node's own config as a channel it consults, exactly like the Self chat above it.
  it('a NAMED advice channel is posted on primary, not on the default mouth', async () => {
    const { app, byConnection, statuses } = await bootWith(KG({ advice_channel: ADVICE_NAME }), { makeSession: ASKING_SESSION });

    await deliver(byConnection.primary, RODZ_GROUP, 'e hola');
    await waitFor(() => statuses().length > 0);

    expect(statuses().map((s) => ({ connection: s.connection, chatId: s.chatId }))).toEqual([{ connection: 'primary', chatId: ADVICE_NAME }]);
    expect(byConnection.secondary.statuses).toEqual([]);
    app.stop();
  });

  // THE OTHER HALF OF THE RULE: two connections on ONE account see the same rooms under the same
  // ids, so the default mouth reaches the advice channel and the default mouth is what speaks.
  it('two connections on the SAME account — the ask rides the MOUTH', async () => {
    const { app, byConnection, statuses } = await bootWith(KG_ONE_ACCOUNT({ advice_channel: ADVICE_ROOM }), { makeSession: ASKING_SESSION });
    expect(Object.keys(byConnection).sort()).toEqual(['primary', 'secondary']);

    await deliver(byConnection.primary, RODZ_GROUP, 'e hola');
    await waitFor(() => statuses().length > 0);

    expect(statuses().map((s) => s.connection)).toEqual(['secondary']);
    expect(byConnection.primary.statuses).toEqual([]);
    app.stop();
  });

  // THE BASELINE LOCK: one connection, one bridge, nothing to choose between.
  it('a ONE-connection node is untouched', async () => {
    const { app, built, byConnection, statuses } = await bootWith(SINGLE({ advice_channel: ADVICE_ROOM }), { makeSession: ASKING_SESSION });
    expect(built.map((s) => s.connection)).toEqual(['primary']);

    await deliver(byConnection.primary, RODZ_GROUP, 'e hola');
    await waitFor(() => statuses().length > 0);

    expect(statuses().map((s) => ({ connection: s.connection, chatId: s.chatId }))).toEqual([{ connection: 'primary', chatId: ADVICE_ROOM }]);
    app.stop();
  });
});

// The resolver's half of it, at the unit the boot cases exercise through four layers.
describe('createAdvice asks the per-chat resolver for its bridge', () => {
  const EV = { surface: 'whatsapp', chatId: '!origin', chatName: 'origin', senderId: 'u-1' };
  const fakeBridge = (tag) => { const posts = []; return { tag, posts, async postStatus(chat, text) { posts.push({ chat, text }); return `${tag}-1`; } }; };

  it('the channel is posted on the bridge the resolver names for it', async () => {
    const mouth = fakeBridge('mouth');
    const ear = fakeBridge('ear');
    const advice = createAdvice({ bridge: mouth, bridgeOf: (being, chatId) => (chatId === ADVICE_NAME ? ear : null), getConfig: () => ({ advice_channel: ADVICE_NAME }) });

    expect(await advice.ask({ ev: EV, question: 'should I confirm?' })).toBe(true);
    expect(ear.posts).toHaveLength(1);
    expect(ear.posts[0].chat).toBe(ADVICE_NAME);
    expect(mouth.posts).toEqual([]);
  });

  // A resolver that knows nothing about this chat answers with nothing, and the injected bridge
  // is what posts — which is precisely today's behaviour, and the whole back-compat story.
  it('a resolver with no answer falls back to the injected bridge', async () => {
    const mouth = fakeBridge('mouth');
    const advice = createAdvice({ bridge: mouth, bridgeOf: () => null, getConfig: () => ({ advice_channel: ADVICE_NAME }) });

    expect(await advice.ask({ ev: EV, question: 'q?' })).toBe(true);
    expect(mouth.posts).toHaveLength(1);
  });

  // NO resolver at all — every existing caller and every existing test — is byte-identical.
  it('no bridgeOf at all is byte-identical', async () => {
    const mouth = fakeBridge('mouth');
    const advice = createAdvice({ bridge: mouth, getConfig: () => ({ advice_channel: ADVICE_NAME }) });

    expect(await advice.ask({ ev: EV, question: 'q?' })).toBe(true);
    expect(mouth.posts).toHaveLength(1);
  });
});

// ═══ 2. THE PEER MOUTH'S ROUTING READS ══════════════════════════════════════════════════════
// route() answers "should the PEER say this reply?" from TWO reads about one chat —
// chatHasParticipant (is the peer's identity here) and chatRaw (the payload the cross-account key
// is computed from). The fan-out facade fans the FIRST and not the SECOND, so on a two-account
// node the membership answer came from the connection that has the chat and the payload was then
// demanded of one that does not. route() gave up, and the peer link was dead for every chat heard
// on the ear — silently, because "the payload came back empty" reads like a Beeper hiccup.
describe('makePeerMouth asks the connection that HOLDS the chat', () => {
  const PEER = { accounts: [AN, RODZ], consolePort: 23377 };
  const fakeReadBridge = (tag, world) => ({
    tag,
    async chatHasParticipant(chat, identity) {
      const roster = world[chat];
      if (!roster) return null;
      return roster.some((p) => p.phoneNumber && digits(p.phoneNumber) === digits(identity));
    },
    async chatRaw(chat) { return world[chat] ? RAW[chat] ?? null : null; },
  });

  // THE REPRODUCTION at the unit. The mouth's own bridge has never seen this room; the ear's has.
  it('a chat the EAR holds is routed off the EAR\'s bridge, not the frozen mouth', async () => {
    const mouthBridge = fakeReadBridge('mouth', ROSTERS[SECONDARY]);
    const earBridge = fakeReadBridge('ear', ROSTERS[PRIMARY]);
    const mouth = makePeerMouth({ peer: PEER, bridge: mouthBridge, bridgeOf: (being, chatId) => (chatId === RODZ_GROUP ? earBridge : null) });

    expect(await mouth.route(RODZ_GROUP)).toBe(RAW[RODZ_GROUP]);
  });

  // THE FALLBACK, and today's behaviour for every chat the resolver cannot place: the injected
  // bridge answers, exactly as it did before the resolver existed.
  it('a chat the resolver cannot place still asks the injected bridge', async () => {
    const mouthBridge = fakeReadBridge('mouth', { [RODZ_GROUP]: ROSTERS[PRIMARY][RODZ_GROUP] });
    const mouth = makePeerMouth({ peer: PEER, bridge: mouthBridge, bridgeOf: () => null });

    expect(await mouth.route(RODZ_GROUP)).toBe(RAW[RODZ_GROUP]);
  });

  // NO resolver at all — a one-connection node, and every existing caller — is byte-identical.
  it('no bridgeOf at all is byte-identical', async () => {
    const mouthBridge = fakeReadBridge('mouth', { [RODZ_GROUP]: ROSTERS[PRIMARY][RODZ_GROUP] });
    const mouth = makePeerMouth({ peer: PEER, bridge: mouthBridge });

    expect(await mouth.route(RODZ_GROUP)).toBe(RAW[RODZ_GROUP]);
  });

  // THE SPEAKING HALF IS UNTOUCHED, and must stay so: a reply the peer says goes over the PEER
  // CONSOLE, never over any bridge on this node. Same for the 👀. Locked with a bridge that
  // THROWS on every send-shaped call, so a regression here cannot pass quietly.
  it('SPEAKING and REACTING still go over the peer console, never over a bridge', async () => {
    const exploding = new Proxy({}, { get: (_t, k) => { if (k === 'then') return undefined; return () => { throw new Error(`the peer mouth touched bridge.${String(k)}`); }; } });
    const streamed = [];
    const reacted = [];
    const mouth = makePeerMouth({
      peer: PEER,
      bridge: exploding,
      bridgeOf: () => exploding,
      stream: (o) => { streamed.push(o); return { update() {}, async finish() {}, delivered: true }; },
      reactor: async (o) => { reacted.push(o); return { ok: true, chatId: 'peer-room' }; },
    });

    const chat = RAW[RODZ_GROUP];
    const h = mouth.startStream(chat, '⏳ Thinking…', { fallback: null });
    await h.finish('hola');
    expect(streamed).toHaveLength(1);
    expect(streamed[0].chat).toBe(chat);
    expect(streamed[0].peer).toBe(PEER);

    expect(await mouth.react(chat, { msgKey: 'k-1', timestamp: 7, emoji: '👀' })).toEqual({ ok: true, chatId: 'peer-room' });
    expect(reacted).toHaveLength(1);
    expect(reacted[0].chat).toBe(chat);
  });

  // …and the console is still never routed at all: a shell chat id is not a Beeper chat, so no
  // bridge — resolved or frozen — is asked about it.
  it('a chat the console owns is never routed and no bridge is asked', async () => {
    let asked = 0;
    const counting = { async chatHasParticipant() { asked += 1; return true; }, async chatRaw() { asked += 1; return {}; } };
    const mouth = makePeerMouth({ peer: PEER, bridge: counting, bridgeOf: () => counting, owns: (c) => c === 'main' });

    expect(await mouth.route('main')).toBeNull();
    expect(asked).toBe(0);
  });
});

// ═══ 3. THE STRUCTURAL LOCK ═════════════════════════════════════════════════════════════════
// A source-shape lock rather than a behavioural one, and for the same reason the createSender
// scan in tests/node-announce-follows-the-chat.test.mjs is one: the miss is STRUCTURAL. The
// argument was simply ABSENT at the call site, and no amount of exercising the service would
// have said so — it answered, on one connection, forever.
describe('every bridge-holding service boot builds resolves per chat', () => {
  const CALLS = ['createAdvice', 'makePeerMouth'];
  it('no createAdvice( / makePeerMouth( in boot.mjs passes `bridge` without `bridgeOf`', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../src/spine/boot.mjs', import.meta.url)), 'utf8');
    for (const name of CALLS) {
      // The CALL SITE, not the definition: `export function makePeerMouth({` would match a bare
      // `name(` scan, and its default is deliberately null (a one-connection node passes none).
      const calls = [...src.matchAll(new RegExp(`(?<!function )${name}\\(\\{[\\s\\S]*?\\}\\)`, 'g'))].map((m) => m[0]);
      expect(calls.length, `the ${name} scan found nothing — it has been renamed or reshaped`).toBeGreaterThan(0);
      for (const call of calls) expect(call, `a ${name} without bridgeOf:\n${call}`).toContain('bridgeOf');
    }
  });
});

// …and the same thing through the real boot(), which is where the wiring actually lives.
describe('boot hands the peer mouth the per-chat resolver', () => {
  const KG_WITH_PEER = () => KG({ peer_spine: { console_port: 23377, console_token: 'shared-secret', accounts: [AN, RODZ] } });

  it('a group heard on primary routes off primary — the default mouth never had that room', async () => {
    const { app, byConnection } = await bootWith(KG_WITH_PEER());
    expect(Object.keys(byConnection).sort()).toEqual(['primary', 'secondary']);

    // Prime the arrival map the way every real route() call is primed: the chat ARRIVED. Nothing
    // addresses E here, so no turn runs and nothing dials the (absent) peer console.
    await deliver(byConnection.primary, RODZ_GROUP, 'hola dando', { atE: false });
    expect(byConnection.primary.streams).toEqual([]);

    expect(await app.peerMouth.route(RODZ_GROUP)).toBe(RAW[RODZ_GROUP]);
    app.stop();
  });
});
