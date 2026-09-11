// multi-connection-wake.test.mjs — ONE spine, TWO Beeper connections, ONE real group.
//
// THE QUESTION (operator 2026-09-07, NODE-SHAPE.md "The shape of a node"). The node is folding
// its two spines — one Beeper account each, joined by peer_spine — into ONE spine holding BOTH
// accounts as two connections. The inbound half of that shape has been in the tree since
// 2026-09-02 (src/spine/bridge-fanout.mjs): the spine registers onMessage on EVERY connection it
// holds, and it deliberately does NOT deduplicate, because Beeper is Matrix and one real
// WhatsApp group is TWO rooms with TWO chatIds — "which of them ANSWERS is decided by
// addressing".
//
// So one `@ken` typed into a group both accounts are in arrives at the SAME spine TWICE, once per
// connection. Today that is prevented by having TWO CONFIGS: the An-side spine declares
// `handles: [king, ken, …]` while the Rodz-side one carries
// `fallback_handle: { handle: [ken, …], unless_present: <An's number> }`. Merged into one
// `agents:` block that split disappears — and a token declared in `handles:` beats a fallback for
// the same token (router.mjs's second pass skips a token some agent already owns outright), so a
// naive merge yields an UNCONDITIONAL handle on a node that hears the group twice.
//
// THIS FILE MEASURES WHAT ACTUALLY HAPPENS. It boots a real spine on two connections through the
// same transport seam tests/single-account-node.test.mjs uses, delivers ONE addressed message on
// BOTH connections, and counts the replies that leave.
//
// WHAT IT FOUND, and where each finding now stands:
//
//   1. `fallback_handle`'s `unless_present` did NOT discriminate between the two arrivals. The
//      roster question was asked of the DEFAULT connection's bridge whatever connection the
//      message came in on (src/spine/boot.mjs: `isPresent: (identity, ev) =>
//      bridge.chatHasParticipant?.(ev?.chatId, identity)`, where `bridge` is the fanout facade),
//      and `chatHasParticipant` was not among the keys bridge-fanout.mjs fanned out. One real
//      group is a different chatId per account, so the default connection had never seen the
//      other account's room and answered UNKNOWN: in the shared group that yielded one reply for
//      the fail-closed reason rather than the membership one, and in a group only the SECOND
//      account is in it yielded NONE. FIXED 2026-09-07 — the fanout now asks every connection and
//      the one that has the chat answers. The four cases below are the contract.
//
//   2. ⚠️ STILL A HAZARD, deliberately locked as one: an UNCONDITIONAL declared handle answers
//      once per connection — two messages from the node for one message from a person. Nothing
//      above fixes that, and nothing can: the handle says "wake, always". boot warns about it at
//      startup (src/spine/boot.mjs, "wakes on 2 connections"); see THE HAZARD below.
//
//   3. Recorded in passing, NOT fixed here: outbound is per-BEING, not per-arrival, so a reply to
//      a message heard on one connection is posted on the addressed being's own connection — a
//      chat id the other account may not even have. See THE HAZARD below.
//
// WHAT THE FAKE DESKTOPS MODEL, and why each is a measured fact and not an assumption:
//   · one real group is a DIFFERENT chatId per account — src/bridges/beeper.mjs
//     crossAccountChatKey's header records both ids, measured live 2026-09-05;
//   · an account's OWN entry in its OWN roster carries NO phoneNumber, only a matrix id — the
//     same header, and the predicate side of it is locked in tests/beeper-bridge.test.mjs
//     ("an account's OWN entry in its own roster has no phoneNumber…");
//   · a chat an account does not have answers UNKNOWN (null), never false — beeper.mjs chatInfo
//     catches the failed GET and leaves `participants: null`, locked in the same file
//     ("a FAILING chat GET answers null (UNKNOWN), never false").
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// A PRIVATE profile for this file — egpt-home.mjs freezes EGPT_HOME at module load, so it must be
// set BEFORE the imports below; vi.hoisted is what does that. Private (not the suite's shared
// throwaway) because boot writes state/spine.pid and heartbeats.readonly.yaml, and files running
// in parallel would race on them.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-multi-connection-wake-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

let boot, emptyState;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

// ── THE TWO ACCOUNTS ────────────────────────────────────────────────────────────────────────
const MAIN = 'TOK-main';         // An — the operator's own number
const SECONDARY = 'TOK-secondary';   // Rodz — the mouth
const NAME_OF = { [MAIN]: 'main', [SECONDARY]: 'secondary' };

const AN = '+16468217865';
const RODZ = '+13472576794';
const DANDO = '+34658515045';

// An account's OWN entry: a matrix id and NO phoneNumber. A member's entry carries the number.
const self = (id) => ({ id });
const member = (id, phoneNumber) => ({ id, phoneNumber });

// The four chats. ONE real group both accounts are in is TWO rooms with TWO ids; the other two
// groups have exactly one of the accounts in them.
const SHARED_ON_MAIN = '!shared-as-an-sees-it';
const SHARED_ON_SECONDARY = '!shared-as-rodz-sees-it';
const AN_ONLY = '!an-only-group';
const RODZ_ONLY = '!rodz-only-group';

// Each Desktop's whole world: the chats THAT account has, and nothing else. A lookup for a chat
// missing here is the 404 → `participants: null` → UNKNOWN path.
const DESKTOPS = {
  [MAIN]: {
    [SHARED_ON_MAIN]: [self('an@beeper.local'), member('rodz@beeper.local', RODZ), member('dando@beeper.local', DANDO)],
    [AN_ONLY]: [self('an@beeper.local'), member('dando@beeper.local', DANDO)],
  },
  [SECONDARY]: {
    [SHARED_ON_SECONDARY]: [self('rodz@beeper.local'), member('an@beeper.local', AN), member('dando@beeper.local', DANDO)],
    [RODZ_ONLY]: [self('rodz@beeper.local'), member('dando@beeper.local', DANDO)],
  },
};

// The membership predicate, on the SAME rule the bridge uses: a phone-shaped identity compares on
// DIGITS ONLY (src/bridges/beeper.mjs idKey), and an entry with no phoneNumber can never match a
// phone-shaped one. Kept to phone identities here because that is what `unless_present` carries.
const digits = (v) => String(v ?? '').replace(/\D/g, '');

// ── THE TRANSPORT SEAM ──────────────────────────────────────────────────────────────────────
// One spy per startBridge CALL, carrying which connection it is and the onIncoming the port late-
// binds, so a case can drive a real inbound through either connection.
function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const token = opts.beeperToken;
    const world = DESKTOPS[token] ?? {};
    const spy = { connection: NAME_OF[token] ?? token, token, opts, onIncoming: opts.onIncoming, sent: [], streams: [], rosterAsks: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      // The roster question, answered from THIS account's own copy — which is the whole point:
      // a chat this account does not have is UNKNOWN, exactly as a failed GET is.
      async chatHasParticipant(chat, identity) {
        spy.rosterAsks.push({ chat, identity });
        const roster = world[chat];
        if (!roster) return null;
        return roster.some((p) => p.phoneNumber && digits(p.phoneNumber) === digits(identity));
      },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

// Complete in-memory fs seam — same shape as tests/single-account-node.test.mjs.
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

// Nothing answers the port probe — a boot that reaches it still falls back to the bridge default,
// which is all this file needs (it never asserts on discovery).
const fakeProbe = async () => ({ ok: false, status: 0 });

// TWO EARS, DECLARED (operator 2026-09-10). Until the ingest/output split this file got its
// second ear for free: boot dialled one bridge per connection an AGENT RODE, and `mouth` — an
// agent addressable by nothing, riding the other connection — was enough to make that connection
// an ear as a side effect of being a mouth. That coupling is exactly what took the live node deaf
// on the operator's own account, and it is gone: `use:`/`beeper_connection` now name where an
// agent SPEAKS and nothing else.
//
// A node that wants to wake on two accounts must now SAY SO, and the key for it already existed —
// `owner_node`, "which node WAKES on this connection". Both blocks name this node, so both are
// ears. That is the honest form of what this file has always been testing: a node deliberately
// holding two ears, and every hazard that follows from it.
//
// `mouth` STAYS, unchanged, and now means only what its name says: an agent that speaks on the
// other connection. `handles: []` is a COMPLETE wake list that happens to be empty, so it is
// addressable by nothing and enters no routing decision here.
const NODE = (persona, { use = 'main' } = {}) => ({
  node_name: 'kg',
  user_name: 'An',
  beeper: {
    use,
    main: { account: 'an@example.com', token: MAIN, owner_node: 'kg' },
    secondary: { account: 'rodz@example.com', token: SECONDARY, owner_node: 'kg' },
  },
  agents: {
    egpt: { configuration: 'egpt', default: true, ...persona },
    mouth: { configuration: 'egpt', handles: [], beeper_connection: use === 'main' ? 'secondary' : 'main' },
  },
});

// THE MERGE HAZARD: kg's `handles: [king, ken]` and kg2's fallback for the same tokens, folded
// into one block. A token declared in `handles:` beats a fallback for it, so the merged agent
// wakes on `ken` UNCONDITIONALLY.
const MERGED_UNGUARDED = () => NODE({ handles: ['king', 'ken'] });

// THE GUARDED SHAPE the operator proposes instead: `ken` is a FALLBACK token, silenced wherever
// An's own number is a participant.
const GUARDED_PERSONA = { handles: ['king'], fallback_handle: { handle: ['ken'], unless_present: AN } };
const MERGED_GUARDED = () => NODE(GUARDED_PERSONA);
// The SAME guarded persona, riding the OTHER connection — so the roster question reaches the
// account that actually has the room. The only difference is which connection is the default.
const MERGED_GUARDED_ON_SECONDARY = () => NODE(GUARDED_PERSONA, { use: 'secondary' });

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
    now: () => Date.UTC(2026, 8, 7, 14, 5),
    log: { line: (s) => lines.push(s) },
  });
  const byConnection = Object.fromEntries(built.map((s) => [s.connection, s]));
  // EVERY reply that left the node, whichever connection it went out on.
  const replies = () => built.flatMap((s) => s.streams.map((h) => ({ connection: s.connection, chatId: h.chatId, text: h.finals[0] })));
  return { app, built, byConnection, replies, lines, io };
}

// One arrival, shaped the way the real bridge shapes it. `atE` is the bridge's OWN mention
// finding, computed from `wakeWords` — the persona's DECLARED handles only (boot.mjs via
// wakeTokens). That is why a message addressing a FALLBACK token arrives with atE FALSE: the
// bridge does not know that token, and the router's guard is the only thing that can wake on it.
const deliver = (spy, chatId, body, { atE = false } = {}) => spy.onIncoming(body, {
  chatId, chatName: chatId.replace(/^!/, ''), network: 'whatsapp',
  userId: DANDO, senderName: 'Dando', authorized: true, msgKey: `m-${chatId}-${body.length}`,
  atEStart: atE, atEAnywhere: atE,
});

describe('ONE spine, TWO connections — the merged-config shape (operator 2026-09-07)', () => {
  // The precondition every case below rests on. Two connections, both real (not outbound-only),
  // and the spine registered inbound on BOTH — otherwise "arrives twice" is not even possible and
  // nothing here would be measuring what it claims to.
  it('holds both connections, and an inbound on EITHER reaches the spine', async () => {
    const { app, byConnection, replies } = await bootWith(MERGED_UNGUARDED());
    expect(Object.keys(byConnection).sort()).toEqual(['main', 'secondary']);

    await deliver(byConnection.secondary, SHARED_ON_SECONDARY, '@ken hola', { atE: true });
    expect(replies()).toHaveLength(1);          // the non-default connection is not deaf

    app.stop();
  });

  // …AND A CONNECTION HAS TO BE ONE OF THE TWO THINGS TO BE HELD AT ALL.
  //
  // REWRITTEN 2026-09-10, deliberately. This case used to read "a declared connection NO AGENT
  // RIDES is never opened", and it was the lock on the very coupling the ingest/output split
  // removes: it deleted `mouth` and asserted that `secondary` therefore went undialled, which is
  // only true while an agent's outbound binding is also what opens the node's ears. That sentence
  // can no longer be written, because riding is now about the MOUTH alone — and it should not be,
  // because it is the sentence that made a declared `primary` nobody speaks on unreachable, and
  // took the live node deaf on the operator's own account.
  //
  // WHAT REPLACES IT is the true statement of the same discipline — boot still opens the SMALLEST
  // set of bridges the config asks for, never one per declared block — now stated over BOTH
  // directions: a connection is dialled if it is an EAR (claimed here by `owner_node`) or if some
  // agent SPEAKS on it, and a block that is neither is a token that is never dialled and an
  // account that is never touched. `spare` below is exactly that block. Deleting `mouth` is kept
  // in the same case, because it is now the interesting half: `secondary` stays open, and stays an
  // ear, with no agent riding it at all — which is the whole point of the split.
  it('a declared connection that is neither an ear nor any agent\'s mouth is never opened', async () => {
    const config = MERGED_UNGUARDED();
    config.beeper.spare = { account: 'spare@example.com', token: 'TOK-spare' };   // declared, claimed by nobody
    delete config.agents.mouth;                 // …and nobody SPEAKS on `secondary` any more either
    const { app, built, byConnection, replies, lines } = await bootWith(config);

    // `spare` is never dialled. `secondary` still is — it is a declared EAR, and that no longer
    // depends on an agent riding it.
    expect(built.map((s) => s.connection).sort()).toEqual(['main', 'secondary']);

    // …and it is a real ear, not merely an open socket.
    await deliver(byConnection.secondary, SHARED_ON_SECONDARY, '@ken hola', { atE: true });
    expect(replies()).toHaveLength(1);

    // Two ears is two ears: the double-answer warning is exactly as loud as before.
    expect(lines.filter((l) => /wakes on 2 connections/.test(l))).toHaveLength(1);
    app.stop();
  });

  // THE OTHER HALF OF THE SPLIT, stated here because this file is where the two-ear shape lives:
  // an agent's `use:` / `beeper_connection` moves its MOUTH and can no longer make an ear. With
  // `owner_node` taken off `secondary`, `mouth` still speaks there and the node still holds the
  // connection — and nothing arriving on it can wake anything.
  it('an agent riding a connection makes it a MOUTH, never an ear', async () => {
    const config = MERGED_UNGUARDED();
    delete config.beeper.secondary.owner_node;  // no longer claimed as an ear; `mouth` still rides it
    const { app, built, byConnection, replies, lines } = await bootWith(config);

    expect(built.map((s) => s.connection).sort()).toEqual(['main', 'secondary']);
    await deliver(byConnection.secondary, SHARED_ON_SECONDARY, '@ken hola', { atE: true });
    expect(replies()).toEqual([]);
    // …one ear is one ear: no double-answer warning, because there is no second arrival to be had.
    expect(lines.filter((l) => /wakes on \d+ connections/.test(l))).toEqual([]);
    app.stop();
  });

  // ── THE BOOT WARNING ─────────────────────────────────────────────────────────────────────
  // The operator should not discover the hazard below in a live group. A node that wakes on 2+
  // connections and holds an agent with an unconditional handle says so, once, at boot — naming
  // the agent and the handles, and pointing at the guard that actually fixes it.
  it('WARNS at boot, naming the agent and its handles, and boots anyway', async () => {
    const { app, lines } = await bootWith(MERGED_UNGUARDED());

    const warned = lines.filter((l) => /wakes on 2 connections/.test(l));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("'egpt' wakes on @king @ken unconditionally and this node wakes on 2 connections");
    expect(warned[0]).toMatch(/ONE mention wakes it TWICE/);
    expect(warned[0]).toMatch(/move those handles into fallback_handle/);
    // A WARNING, NOT A REFUSAL — the node is up and its connections are open.
    expect(app.bridge).toBeTruthy();

    app.stop();
  });

  // …and it warns about exactly the agents that CAN double-answer. `mouth` carries `handles: []`
  // (addressable by nothing), and the guarded persona's tokens are all conditional — neither can
  // wake twice, so neither is named. This is what keeps the line from being boot noise.
  it('does NOT warn about an agent whose every token is guarded, nor one addressable by nothing', async () => {
    const { app, lines } = await bootWith(NODE({ handles: [], fallback_handle: { handle: ['ken'], unless_present: AN } }));
    expect(lines.filter((l) => /wakes on \d+ connections/.test(l))).toEqual([]);
    app.stop();
  });

  // OUTBOUND-ONLY IS NOT A SECOND EAR. A connection owned by another node has its inbound
  // registrations swallowed, so it can never deliver half of a double answer — the warning counts
  // connections this node WAKES on, not connections it holds.
  it('does NOT warn when the second connection is outbound-only (owner_node)', async () => {
    const config = MERGED_UNGUARDED();
    config.beeper.secondary.owner_node = 'some-other-node';
    const { app, built, lines } = await bootWith(config);
    expect(built.map((s) => s.connection).sort()).toEqual(['main', 'secondary']);   // still held…
    expect(lines.filter((l) => /wakes on \d+ connections/.test(l))).toEqual([]);    // …but not an ear
    app.stop();
  });

  // ── THE HAZARD, VISIBLE ──────────────────────────────────────────────────────────────────
  // One `@ken` in one real group, delivered on both connections because that is what the group
  // IS to this node. With an unconditional declared handle nothing decides between them.
  it('THE HAZARD: an unconditional declared handle answers ONCE PER CONNECTION', async () => {
    const { app, byConnection, replies } = await bootWith(MERGED_UNGUARDED());

    await deliver(byConnection.main, SHARED_ON_MAIN, '@ken hola', { atE: true });
    await deliver(byConnection.secondary, SHARED_ON_SECONDARY, '@ken hola', { atE: true });

    // ONE message, typed once, by one person, in one group. TWO answers.
    // …and note the SECOND line: outbound is per-BEING, not per-arrival (createSender's
    // `bridgeOf(being) ?? bridge`, src/spine/sender.mjs), so the reply to RODZ'S room is posted on
    // AN's connection — a chat id An's account does not have. NODE-SHAPE.md says the spine
    // "answers on whichever one heard the message"; it does not, and this is where that shows.
    expect(replies().map((r) => `${r.connection}:${r.chatId}`)).toEqual([
      `main:${SHARED_ON_MAIN}`,
      `main:${SHARED_ON_SECONDARY}`,
    ]);

    app.stop();
  });

  // ── THE GUARDED SHAPE — THE CONTRACT ─────────────────────────────────────────────────────
  // EXACTLY ONE REPLY IN EVERY CASE. These four are the operator's own enumeration, and they hold
  // because bridge-fanout.mjs now asks the roster question of EVERY connection (2026-09-07):
  // whichever one has the chat answers, the rest answer UNKNOWN and are ignored.
  //
  // Case 1 of 4: the shared group, heard twice. Answered once, and — the part that has to be
  // checked and not assumed — answered because An is genuinely ABSENT from his own copy of the
  // roster (self carries no phoneNumber) and genuinely PRESENT in Rodz's, never because the
  // question went unanswered. The absence of any "NOT woken" line is what says so.
  it('GUARDED, shared group: exactly ONE reply, on main, and no unknown anywhere', async () => {
    const { app, byConnection, replies, lines } = await bootWith(MERGED_GUARDED());

    await deliver(byConnection.main, SHARED_ON_MAIN, '@ken hola');
    await deliver(byConnection.secondary, SHARED_ON_SECONDARY, '@ken hola');

    expect(replies().map((r) => `${r.connection}:${r.chatId}`)).toEqual([`main:${SHARED_ON_MAIN}`]);
    expect(lines.filter((l) => /could not establish whether/.test(l))).toEqual([]);

    app.stop();
  });

  // THE MECHANISM, NOT THE COUNT. The secondary arrival is silenced because An IS a participant of
  // RODZ'S copy of the group — which only Rodz's connection can say. Both connections are asked;
  // An's has never seen that room and answers UNKNOWN, Rodz's answers a definite true, and true
  // wins. A hit dropped for real membership is dropped SILENTLY (router.mjs: the token belongs to
  // the other account's agent), so the absence of a log line here is itself the assertion.
  it('GUARDED, shared group: the secondary arrival is silenced by An being PRESENT in Rodz\'s copy', async () => {
    const { app, byConnection, replies, lines } = await bootWith(MERGED_GUARDED());

    await deliver(byConnection.secondary, SHARED_ON_SECONDARY, '@ken hola');

    expect(byConnection.main.rosterAsks).toEqual([{ chat: SHARED_ON_SECONDARY, identity: AN }]);
    expect(byConnection.secondary.rosterAsks).toEqual([{ chat: SHARED_ON_SECONDARY, identity: AN }]);
    expect(replies()).toEqual([]);
    expect(lines.filter((l) => /NOT woken/.test(l))).toEqual([]);

    app.stop();
  });

  // Case 2 of 4: a group only An is in. Heard on main alone, answered there — self carries no
  // phoneNumber, so `unless_present` reads a definite FALSE against An's own entry.
  it('GUARDED, An-only group: heard on main alone, and answered', async () => {
    const { app, byConnection, replies } = await bootWith(MERGED_GUARDED());
    await deliver(byConnection.main, AN_ONLY, '@ken hola');
    expect(replies().map((r) => `${r.connection}:${r.chatId}`)).toEqual([`main:${AN_ONLY}`]);
    app.stop();
  });

  // Case 3 of 4: a group only Rodz is in — THE ONE THE OLD ROUTING BROKE. Heard on secondary
  // alone; An is provably not in it, so the fallback applies and the node answers. Before the
  // fanout of chatHasParticipant the question went to An's Desktop, which had never seen this
  // room, and NOBODY answered a message addressed to this node.
  it('GUARDED, Rodz-only group: heard on secondary alone, and ANSWERED', async () => {
    const { app, byConnection, replies, lines } = await bootWith(MERGED_GUARDED());

    await deliver(byConnection.secondary, RODZ_ONLY, '@ken hola');

    expect(replies()).toHaveLength(1);
    expect(byConnection.secondary.rosterAsks).toEqual([{ chat: RODZ_ONLY, identity: AN }]);
    expect(lines.filter((l) => /NOT woken/.test(l))).toEqual([]);

    app.stop();
  });

  // Case 4 of 4: WHICH CONNECTION IS THE DEFAULT NO LONGER DECIDES. The same config with `use:`
  // flipped answers identically — one reply per case, in the same cases. Under the old routing
  // this same pair went 0 and 1; the default connection was silently part of the wake rule.
  it('GUARDED: flipping the default connection changes nothing about WHO answers', async () => {
    const { app, byConnection, replies } = await bootWith(MERGED_GUARDED_ON_SECONDARY());

    await deliver(byConnection.main, SHARED_ON_MAIN, '@ken hola');
    await deliver(byConnection.secondary, SHARED_ON_SECONDARY, '@ken hola');
    await deliver(byConnection.secondary, RODZ_ONLY, '@ken hola');

    // The shared group: answered once (on the main arrival, where An is absent from his own
    // roster). The Rodz-only group: answered. Both replies ride the persona's own connection,
    // which is `secondary` here — see THE HAZARD above on why that is a separate defect.
    expect(replies().map((r) => `${r.connection}:${r.chatId}`)).toEqual([
      `secondary:${SHARED_ON_MAIN}`,
      `secondary:${RODZ_ONLY}`,
    ]);

    app.stop();
  });
});

// ── THE CONNECTION GATE (operator 2026-09-08) ────────────────────────────────────────────────
// A node holding TWO EARS (declared above with `owner_node`) hears one real message twice, and
// the router's gate decides which arrival wakes an agent (boot's inboundOf). The operator's ruling
// on what one real message typed into a chat BOTH accounts
// are in must do: "received by primary, logs, recognized agent, produces reply… received by
// secondary, logs, K is not an agent. continue." — both arrivals ingest and log, only the arrival
// on the connection that CARRIES the agent produces a turn. NOT deduplication: the second arrival
// is a conversation of its own and is recorded as one.
//
// The arrival's connection is stamped where it is known — the fan-out registration, the one point
// that still has the bridge in hand (src/spine/bridge-fanout.mjs) — and read by router.resolve as
// a fourth post-match filter beside the surface pin, allowed_users and the fallback guard.
const K_BOUND_TO_MAIN = () => {
  const c = NODE({ handles: ['king'] });
  c.agents.k = { configuration: 'egpt', name: 'K', handles: ['k'], beeper_connection: 'main' };
  return c;
};

// The SAME agent, addressable only through a GUARDED token — the shape that survives a chat its
// own connection is not in (see the last case below).
const K_GUARDED_ON_MAIN = () => {
  const c = NODE({ handles: ['king'] });
  c.agents.k = { configuration: 'egpt', name: 'K', handles: [], beeper_connection: 'main',
                 fallback_handle: { handle: ['k'], unless_present: AN } };
  return c;
};

describe('the connection gate — an agent wakes on ITS OWN connection\'s arrival', () => {
  // THE BUG THIS FIXES. One line, typed once, in one group both accounts are in. Before the gate
  // both arrivals resolved identically and K answered TWICE, from two visibly different numbers.
  it('one real message, two arrivals, K bound to main → K answers ONCE, on main', async () => {
    const { app, byConnection, replies } = await bootWith(K_BOUND_TO_MAIN());

    await deliver(byConnection.main, SHARED_ON_MAIN, 'k hola');
    await deliver(byConnection.secondary, SHARED_ON_SECONDARY, 'k hola');

    expect(replies().map((r) => `${r.connection}:${r.chatId}`)).toEqual([`main:${SHARED_ON_MAIN}`]);

    app.stop();
  });

  // …and the arrival that does NOT wake K still INGESTS. Nothing is dropped and nothing is
  // deduplicated — a gated hit falls through exactly as an unmatched @token does, so the message
  // is recorded, the guard counts it, and the being reads it as back-context like any other line.
  it('the non-waking arrival still LOGS', async () => {
    const { app, byConnection, replies, io } = await bootWith(K_BOUND_TO_MAIN());

    await deliver(byConnection.secondary, SHARED_ON_SECONDARY, 'k hola');

    expect(replies()).toEqual([]);
    const logged = [...io.files.keys()].filter((f) => /transcript\.md$/.test(f));
    expect(logged.some((f) => f.includes('shared-as-rodz-sees-it'))).toBe(true);

    app.stop();
  });

  // NO EFFECT ON A CHAT ONLY THE OWNING CONNECTION HAS: one arrival, on main, and it is main's
  // agent. The gate is a filter on the SECOND ear, never a new reason to stay silent.
  it('an An-only chat is unaffected — the single arrival is the owning connection\'s', async () => {
    const { app, byConnection, replies } = await bootWith(K_BOUND_TO_MAIN());
    await deliver(byConnection.main, AN_ONLY, 'k hola');
    expect(replies().map((r) => `${r.connection}:${r.chatId}`)).toEqual([`main:${AN_ONLY}`]);
    app.stop();
  });

  // THE CONDITIONAL. A group only the SECONDARY account is in: K's own connection is not there at
  // all, so the arrival that IS there must still wake it. The gate compares two connection NAMES
  // and CANNOT see that — one real group is a different chatId per account, so main's Desktop has
  // never seen this room. `fallback_handle` is the filter that CAN: `unless_present` is answered
  // from the ARRIVING chat's roster (fanned out since 32eb862), reads a definite FALSE because An
  // is genuinely not a member, and the hit wakes. A guarded hit is therefore EXEMPT from the gate
  // — the membership answer outranks the name comparison.
  it('CONDITIONAL: a GUARDED token still wakes on the other connection\'s arrival when its own is absent from the chat', async () => {
    const { app, byConnection, replies, lines } = await bootWith(K_GUARDED_ON_MAIN());

    await deliver(byConnection.secondary, RODZ_ONLY, 'k hola');

    expect(replies()).toHaveLength(1);
    expect(byConnection.secondary.rosterAsks).toEqual([{ chat: RODZ_ONLY, identity: AN }]);
    expect(lines.filter((l) => /NOT woken/.test(l))).toEqual([]);

    app.stop();
  });

  // …and the SAME guarded agent still answers exactly once in the shared group: the gate leaves it
  // alone and its own guard silences the secondary arrival (An IS in Rodz's copy of the roster).
  it('CONDITIONAL: the guarded token is still answered exactly ONCE in the shared group', async () => {
    const { app, byConnection, replies } = await bootWith(K_GUARDED_ON_MAIN());

    await deliver(byConnection.main, SHARED_ON_MAIN, 'k hola');
    await deliver(byConnection.secondary, SHARED_ON_SECONDARY, 'k hola');

    expect(replies().map((r) => `${r.connection}:${r.chatId}`)).toEqual([`main:${SHARED_ON_MAIN}`]);

    app.stop();
  });

  // ⚠️ THE GAP, LOCKED AS ONE — the piece the operator asked for that is NOT delivered. An
  // UNCONDITIONAL handle bound to `main` reaches nobody in a group only the SECONDARY account is
  // in, because the gate cannot ask whether main is in that chat and there is no guard to answer
  // it. The guarded shape above is the workaround, and it costs a hand-pasted phone number. Making
  // the gate itself ask "is my OWNING CONNECTION in this chat" needs the owning connection's own
  // account identity, and nothing in the `beeper:` block records one — see the STOP note.
  it('GAP: an UNCONDITIONAL handle whose connection is absent from the chat reaches nobody', async () => {
    const { app, byConnection, replies } = await bootWith(K_BOUND_TO_MAIN());
    await deliver(byConnection.secondary, RODZ_ONLY, 'k hola');
    expect(replies()).toEqual([]);
    app.stop();
  });
});
