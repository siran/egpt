// peer-mouth.test.mjs — THE MOUTH LINK: one spine hands another a finished line and the other
// says it, on the other Beeper account (operator 2026-09-05).
//
// THE ARRANGEMENT. One machine, two spines, one Beeper account each, one checkout, differing only
// by EGPT_HOME. The PRIMARY is the ear and the brain — it receives, logs, gates and runs the turn
// exactly as it always has — and the SECONDARY is the MOUTH: instead of posting the finished reply
// on its own account, the primary hands the text over and the secondary posts it.
//
// THE TWO THINGS THAT CAN GO WRONG, and what this file locks:
//
//   1. THE RECEIVER ANSWERS INSTEAD OF SPEAKING. The console protocol's frames are `{ text,
//      chatId }` and they mean "a HUMAN said this" — shell-port turns one into an inbound event
//      and the spine RUNS A TURN on it. A mouth frame means the exact opposite. So the wire has a
//      discriminator of its own (`say`), it is recognized before the console parse, and the tests
//      below assert the dispatch handler is NEVER called on the receiving side.
//
//   2. THE LINE IS SAID IN THE WRONG CHAT — the worst outcome available here, because nobody
//      notices a wrong-chat answer until it is already public. The two accounts see one real group
//      as two different Matrix rooms with NOTHING shared in the payload, so the mapping runs on
//      crossAccountChatKey (participant phone numbers, both accounts excluded). Zero matches and
//      two matches both REFUSE and report back; a chat that cannot be keyed refuses before the
//      frame is even sent.
//
// ALL TRANSPORT INJECTED: a linked pair of fake sockets, a fake `ws` server, a fake clock. No real
// socket, no real port, no real Beeper, no profile touched.
import { describe, it, expect } from 'vitest';
import { createShellPort } from '../src/bridges/shell-port.mjs';
import { MOUTH_PATH, sayFrame, parseMouthFrame } from '../src/shell/mouth.mjs';
import { peerSpineFrom, findChatByKey, createMouthReceiver, speakThroughPeer } from '../src/shell/peer-mouth.mjs';
import { responseFrame } from '../src/shell/auth.mjs';

// ── THE FIXTURE ────────────────────────────────────────────────────────────────────────────────
// The MEASURED shape (tests/cross-account-chat-key.test.mjs): every ordinary member carries a
// phoneNumber, the VIEWING account carries none at all (it is its matrix id with isSelf true), and
// each account sees the others through its OWN id namespace — so the two views below share no id
// of any kind. Roles only, never people.
const PRIMARY_NUM = '+15550000001';
const SECONDARY_NUM = '+15550000002';
const M1 = '+1 (555) 111-0001';
const M2 = '+15551110002';
const M3 = '+15551110003';
const ACCOUNTS = [PRIMARY_NUM, SECONDARY_NUM];

const member = (id, phoneNumber) => ({ id, phoneNumber, fullName: id });
const self = (id) => ({ id, isSelf: true });

// The chat the brain is replying in, as the PRIMARY account sees it.
const AS_PRIMARY = {
  id: '!6ljZJkx0OaY9ZVhEzFgi:beeper.local', title: 'Group', type: 'group',
  participants: { items: [self('@primary:beeper.com'), member('p-secondary', SECONDARY_NUM), member('p-m1', M1), member('p-m2', M2)] },
};
// The SAME real chat, as the SECONDARY account sees it: different room id, different participant
// ids, different order. Only the phone numbers line up.
const AS_SECONDARY = {
  id: '!HuXFQeZSY1X4khNDWTzz:beeper.local', title: 'Group', type: 'group',
  participants: { items: [member('s-m2', M2), self('@secondary:beeper.com'), member('s-primary', PRIMARY_NUM), member('s-m1', M1)] },
};
const SECONDARY_CHAT_ID = 'HuXFQeZSY1X4khNDWTzz';   // what shortChatId makes of it: no '!', no ':beeper.local'
// A DIFFERENT group on the secondary's account — same two spines in it, a different third member.
const OTHER_CHAT = {
  id: '!other:beeper.local', title: 'Other', type: 'group',
  participants: { items: [self('@secondary:beeper.com'), member('s-primary2', PRIMARY_NUM), member('s-m1b', M1), member('s-m3', M3)] },
};
// A 1:1 — keyable by nobody: one identity left after the exclusions, which is exactly the case
// that LOOKS usable and would put a group's reply into a private chat.
const ONE_TO_ONE = {
  id: '!dm:beeper.local', title: 'DM', type: 'single',
  participants: { items: [self('@primary:beeper.com'), member('p-m1', M1)] },
};

const PEER = { consolePort: 23377, consoleToken: 'peer-shell-token', accounts: ACCOUNTS };

// ── THE TRANSPORT SEAM ─────────────────────────────────────────────────────────────────────────
// One end of a linked pair. Delivery is a microtask (a real socket is never synchronous) which
// keeps every assertion below a plain `await` away, with no timers and no flakiness.
class Sock {
  constructor() { this._h = {}; this.readyState = 1; this.closed = false; this.other = null; this.sent = []; }
  on(ev, cb) { (this._h[ev] ||= []).push(cb); return this; }
  fire(ev, ...a) { for (const cb of [...(this._h[ev] || [])]) cb(...a); }
  send(d) {
    if (this.closed) throw new Error('socket is closed');
    this.sent.push(String(d));
    const o = this.other;
    if (o) queueMicrotask(() => { if (!o.closed) o.fire('message', Buffer.from(String(d))); });
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.readyState = 3;
    this.fire('close');
    const o = this.other;
    if (o && !o.closed) queueMicrotask(() => o.close());
  }
}

// The `ws` SERVER seam the limb binds through. `dial(path)` is a client arriving: pass MOUTH_PATH
// for a peer spine, and NOTHING for the operator's editor — an absent req is exactly what every
// pre-existing caller looks like, which is the point. It returns the LIMB'S END of that socket
// (same convention as tests/shell-port.test.mjs): `.sent` is what the limb pushed, and
// `.fire('message', …)` is the client speaking.
function makeFakeWss() {
  const servers = [];
  class FakeWSS {
    constructor(opts) { this.opts = opts; this._h = {}; servers.push(this); }
    on(ev, cb) { (this._h[ev] ||= []).push(cb); if (ev === 'listening') cb(); return this; }
    fire(ev, ...a) { for (const cb of [...(this._h[ev] || [])]) cb(...a); }
    close() {}
    dial(path) {
      const ws = new Sock();
      this.fire('connection', ws, path == null ? undefined : { url: path });
      return ws;
    }
  }
  return { WebSocketServer: FakeWSS, servers };
}

// The `ws` CLIENT seam speakThroughPeer dials through: constructing one reaches the fake server on
// the next microtask, exactly as a dial does. `dialled` records every URL so a test can assert
// that NOTHING was dialled at all.
function makeFakeClient(server) {
  const dialled = [];
  class FakeClient extends Sock {
    constructor(url) {
      super();
      dialled.push(String(url));
      const u = String(url);
      const path = u.slice(u.indexOf('/', u.indexOf('//') + 2)) || '/';
      queueMicrotask(() => {
        if (!server) { this.close(); return; }
        const srv = new Sock();
        srv.other = this; this.other = srv;
        server.fire('connection', srv, { url: path });
        this.fire('open');
      });
    }
  }
  return { FakeClient, dialled };
}

// A clock that arms nothing: every case below settles on a frame, so a fired timeout would be a
// bug, and a real timer would only add a wait.
function makeClock() {
  const armed = [];
  return { armed, setTimeout: (fn, ms) => { armed.push({ fn, ms }); return armed.length; }, clearTimeout: () => {} };
}

// Dial an EDITOR in and pass the handshake — the console role, unchanged. The challenge frame is
// shifted off `sent` so later assertions count from the first real frame.
function seatEditor(server, token) {
  const ws = server.dial();
  const challenge = JSON.parse(ws.sent.shift());
  ws.fire('message', Buffer.from(responseFrame(token, challenge.nonce)));
  return ws;
}

// A whole two-spine rig: the RECEIVER's shell-port limb with a mouth handler over a fake Beeper,
// and the SPEAKER's client seam pointed at it. `turns` records anything the receiving spine
// dispatched as a message — it must stay EMPTY: a peer's line is posted, never answered.
function rig({ chats = [AS_SECONDARY, OTHER_CHAT], token = PEER.consoleToken, post, mouth = true } = {}) {
  const { WebSocketServer, servers } = makeFakeWss();
  const posted = [];
  const logs = [];
  const turns = [];
  const receiver = createMouthReceiver({
    listChats: async () => chats,
    post: post ?? (async (chatId, text) => { posted.push({ chatId, text }); return { ok: true }; }),
    accounts: ACCOUNTS,
    onLog: (m) => logs.push(m),
  });
  const port = createShellPort({
    WebSocketServer, token, reapPort: () => 0,
    onPeerSay: mouth ? receiver : null,
    onLog: (m) => logs.push(m),
  });
  port.onMessage((ev) => { turns.push(ev); });
  port.start();
  const server = servers[0];
  const { FakeClient, dialled } = makeFakeClient(server);
  const clock = makeClock();
  const speak = ({ chat = AS_PRIMARY, text = 'the finished line', peer = PEER } = {}) =>
    speakThroughPeer({ peer, chat, text, WebSocket: FakeClient, onLog: (m) => logs.push(m), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  return { port, server, posted, logs, turns, speak, dialled, clock, FakeClient };
}

// ── 1. ABSENT MEANS ABSENT ─────────────────────────────────────────────────────────────────────
// The additivity requirement, first, because everything else is only allowed to exist if this
// holds: a node that configures no peer dials nothing, offers nothing, and behaves as it always did.
describe('no peer_spine configured — nothing dials, nothing listens, nothing changes', () => {
  it('reads no peer out of the single-account config the skeleton ships', () => {
    const MINIMAL = {
      node_name: 'primary', user_name: 'John',
      beeper: { use: 'main', main: { account: 'you@example.com', token: 'TOK' } },
      agents: { egpt: { configuration: 'egpt', handles: ['e'], default: true } },
    };
    expect(peerSpineFrom(MINIMAL)).toBeNull();
    expect(peerSpineFrom({})).toBeNull();
    expect(peerSpineFrom(undefined)).toBeNull();
    expect(peerSpineFrom(null)).toBeNull();
  });

  it('reads no peer, and SAYS WHY, out of a block that is present but unusable', () => {
    const logs = [];
    const log = (m) => logs.push(m);
    const base = { console_port: 23377, console_token: 'tok', accounts: ACCOUNTS };
    expect(peerSpineFrom({ peer_spine: { ...base, console_port: 'nope' } }, log)).toBeNull();
    expect(peerSpineFrom({ peer_spine: { ...base, console_port: 0 } }, log)).toBeNull();
    expect(peerSpineFrom({ peer_spine: { ...base, console_token: '  ' } }, log)).toBeNull();
    expect(peerSpineFrom({ peer_spine: { ...base, accounts: [PRIMARY_NUM] } }, log)).toBeNull();
    expect(peerSpineFrom({ peer_spine: ['not', 'a', 'block'] }, log)).toBeNull();
    expect(logs).toHaveLength(5);                              // each refusal named, none silent
    expect(logs.join('\n')).toMatch(/console_port/);
    expect(logs.join('\n')).toMatch(/console_token/);
    expect(logs.join('\n')).toMatch(/BOTH accounts must be listed/);
    // …and an ABSENT block says nothing at all: an ordinary node has nothing to complain about.
    const quiet = [];
    expect(peerSpineFrom({ node_name: 'primary' }, (m) => quiet.push(m))).toBeNull();
    expect(quiet).toEqual([]);
  });

  it('a good block normalizes to the port, the token and the two identities', () => {
    expect(peerSpineFrom({ peer_spine: { console_port: 23377, console_token: ' peer-shell-token ', accounts: ACCOUNTS } }))
      .toEqual({ consolePort: 23377, consoleToken: 'peer-shell-token', accounts: ACCOUNTS });
  });

  it('DIALS NOTHING with no peer — the socket constructor is never even reached', async () => {
    const { FakeClient, dialled } = makeFakeClient(null);
    const r = await speakThroughPeer({ peer: null, chat: AS_PRIMARY, text: 'hola', WebSocket: FakeClient });
    expect(r).toEqual({ ok: false, reason: 'no-peer', detail: 'no peer spine configured' });
    expect(dialled).toEqual([]);
  });

  it('a limb with no mouth handler REFUSES a peer dial outright — and keeps serving the console', () => {
    const { port, server, logs } = rig({ mouth: false });
    const peerWs = server.dial(MOUTH_PATH);
    expect(peerWs.closed).toBe(true);                          // closed on the spot…
    expect(peerWs.sent).toEqual([]);                     // …and told NOTHING (not even a challenge)
    expect(logs.join('\n')).toMatch(/offers no mouth link/);
    // The console is untouched: the very next editor still takes the seat.
    seatEditor(server, PEER.consoleToken);
    expect(port.isConnected).toBe(true);
    port.stop();
  });
});

// ── 2. THE HAPPY PATH ──────────────────────────────────────────────────────────────────────────
describe('a finished line crosses the link and is posted VERBATIM on the other account', () => {
  it('resolves the primary chat to the SECONDARY account chatId and posts the exact text', async () => {
    const { posted, turns, speak, dialled, port } = rig();
    const r = await speak({ text: 'listo, ya lo hice' });

    expect(r).toEqual({ ok: true, chatId: SECONDARY_CHAT_ID });
    expect(posted).toEqual([{ chatId: SECONDARY_CHAT_ID, text: 'listo, ya lo hice' }]);
    expect(dialled).toEqual([`ws://127.0.0.1:23377${MOUTH_PATH}`]);
    // THE ONE THAT MATTERS MOST: the receiving spine did not treat the line as something a human
    // said. No inbound event, so no turn, so no reply to a reply.
    expect(turns).toEqual([]);
    port.stop();
  });

  it('posts the bytes it was handed — newlines, emoji and JSON-looking text all survive intact', async () => {
    const text = '🐶 primary: line one\nline two {"text":"not a console frame"}\n\ttabbed';
    const { posted, speak, port } = rig();
    const r = await speak({ text });
    expect(r.ok).toBe(true);
    expect(posted[0].text).toBe(text);
    port.stop();
  });

  it('a SEATED EDITOR neither blocks the mouth nor loses the console to it', async () => {
    const { server, posted, speak, port } = rig();
    const editor = seatEditor(server, PEER.consoleToken);
    expect(port.isConnected).toBe(true);

    const r = await speak({ text: 'said while the operator has the console open' });

    expect(r.ok).toBe(true);
    expect(posted).toHaveLength(1);
    expect(port.isConnected).toBe(true);                       // the operator still holds the seat
    expect(editor.closed).toBe(false);                         // and was not disturbed at all
    expect(editor.sent).toEqual([]);                     // nor sent the peer's line
    port.stop();
  });

  it('stop() closes an authenticated peer connection too, not just the console seat', async () => {
    const { server, port } = rig();
    // Dial a peer in and authenticate it, but never send a line — the socket is simply held.
    const peerWs = server.dial(MOUTH_PATH);
    const challenge = JSON.parse(peerWs.sent.shift());
    peerWs.fire('message', Buffer.from(responseFrame(PEER.consoleToken, challenge.nonce)));
    expect(peerWs.closed).toBe(false);
    port.stop();
    expect(peerWs.closed).toBe(true);
  });
});

// ── 3. REFUSALS ────────────────────────────────────────────────────────────────────────────────
// Every one of these must FAIL CLOSED (nothing posted) and REPORT BACK (the caller learns it must
// fall back to speaking on its own account).
describe('the mouth refuses rather than guessing — and always says so', () => {
  it('AN UNAUTHENTICATED PEER IS REFUSED: wrong token, nothing posted, no result frame', async () => {
    const { posted, logs, port, server } = rig();
    const { FakeClient } = makeFakeClient(server);
    const clock = makeClock();
    const r = await speakThroughPeer({
      peer: { ...PEER, consoleToken: 'WRONG-token' }, chat: AS_PRIMARY, text: 'should never be said',
      WebSocket: FakeClient, onLog: (m) => logs.push(m), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unreachable');                      // it was dropped, not answered
    expect(posted).toEqual([]);
    expect(logs.join('\n')).toMatch(/FAILED THE AUTH CHALLENGE/);
    expect(logs.join('\n')).toMatch(new RegExp(`claimed to be a peer spine`));
    port.stop();
  });

  it('NO CHAT KEYS ALIKE: refuses to post and reports no-match back over the same socket', async () => {
    // The receiver's account holds only OTHER groups — none with this participant set.
    const { posted, speak, port, logs } = rig({ chats: [OTHER_CHAT] });
    const r = await speak({ text: 'nowhere to put this' });
    expect(r).toEqual({ ok: false, reason: 'no-match', detail: 'no chat on this account keys to that participant set' });
    expect(posted).toEqual([]);
    expect(logs.join('\n')).toMatch(/REFUSING to speak — no-match/);
    port.stop();
  });

  it('TWO CHATS KEY ALIKE: refuses to post and reports ambiguous back — it never picks one', async () => {
    // The honest limit crossAccountChatKey documents: two DIFFERENT groups with the SAME membership
    // key identically. A participant set cannot tell them apart, so the only safe answer is none.
    const twin = { ...AS_SECONDARY, id: '!twin:beeper.local', title: 'Group (again)' };
    const { posted, speak, port } = rig({ chats: [AS_SECONDARY, twin, OTHER_CHAT] });
    const r = await speak({ text: 'which one?' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ambiguous');
    expect(r.detail).toMatch(/2 chats key alike/);
    expect(r.detail).toContain(SECONDARY_CHAT_ID);
    expect(r.detail).toContain('twin');
    expect(posted).toEqual([]);
    port.stop();
  });

  it('A CHAT THAT CANNOT BE KEYED refuses BEFORE the frame is sent — no dial at all', async () => {
    const { speak, dialled, posted, port } = rig();
    // A 1:1 keys to a single identity once both accounts are excluded, which crossAccountChatKey
    // refuses outright — accepting it is how a group's reply lands in a private chat.
    const dm = await speak({ chat: ONE_TO_ONE, text: 'must not travel' });
    expect(dm).toEqual({ ok: false, reason: 'no-key', detail: 'crossAccountChatKey refused this chat' });
    // …and the same for a payload with no roster in it at all: UNKNOWN is never "nobody".
    const bare = await speak({ chat: { id: '!bare:beeper.local', title: 'Bare', type: 'group' }, text: 'must not travel' });
    expect(bare.reason).toBe('no-key');
    expect(dialled).toEqual([]);                               // nothing was dialled, either time
    expect(posted).toEqual([]);
    port.stop();
  });

  it('AN EMPTY LINE never dials, and a peer that sends one is refused', async () => {
    const { speak, dialled, posted, port } = rig();
    expect(await speak({ text: '' })).toEqual({ ok: false, reason: 'no-text', detail: 'nothing to say' });
    expect(dialled).toEqual([]);
    expect(posted).toEqual([]);
    port.stop();
  });

  it('A FRAME THE LINK DOES NOT SERVE is refused with bad-frame, never dispatched as a turn', async () => {
    const { server, turns, posted, port } = rig();
    const peerWs = server.dial(MOUTH_PATH);
    const challenge = JSON.parse(peerWs.sent.shift());
    peerWs.fire('message', Buffer.from(responseFrame(PEER.consoleToken, challenge.nonce)));
    // A console-shaped frame on the mouth link — the exact confusion the discriminator exists for.
    peerWs.fire('message', Buffer.from(JSON.stringify({ text: 'hola', chatId: 'lobby' })));
    await Promise.resolve();
    expect(turns).toEqual([]);
    expect(posted).toEqual([]);
    expect(parseMouthFrame(peerWs.sent.pop())).toMatchObject({ say: 'result', ok: false, reason: 'bad-frame' });
    port.stop();
  });

  it('A MOUTH HANDLER THAT THROWS SYNCHRONOUSLY still answers — the read loop is never left holding it', async () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const port = createShellPort({
      WebSocketServer, token: PEER.consoleToken, reapPort: () => 0,
      onPeerSay: () => { throw new Error('handler exploded before it ever returned a promise'); },
    });
    port.start();
    const { FakeClient } = makeFakeClient(servers[0]);
    const clock = makeClock();
    const r = await speakThroughPeer({ peer: PEER, chat: AS_PRIMARY, text: 'x', WebSocket: FakeClient, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    expect(r).toMatchObject({ ok: false, reason: 'send-failed', detail: 'handler exploded before it ever returned a promise' });
    port.stop();
  });

  it('THE POST ITSELF FAILING is reported back, not swallowed', async () => {
    const thrower = rig({ post: async () => { throw new Error('beeper said no'); } });
    const r1 = await thrower.speak({ text: 'x' });
    expect(r1).toMatchObject({ ok: false, reason: 'send-failed', detail: 'beeper said no' });
    thrower.port.stop();

    const refuser = rig({ post: async () => null });           // a drop, not a throw
    const r2 = await refuser.speak({ text: 'x' });
    expect(r2).toMatchObject({ ok: false, reason: 'send-failed' });
    refuser.port.stop();
  });

  it("THE RECEIVER'S OWN CHAT LIST being unreadable is reported back as unavailable", async () => {
    const { WebSocketServer, servers } = makeFakeWss();
    const posted = [];
    const port = createShellPort({
      WebSocketServer, token: PEER.consoleToken, reapPort: () => 0,
      onPeerSay: createMouthReceiver({
        listChats: async () => { throw new Error('desktop api is down'); },
        post: async (chatId, text) => { posted.push({ chatId, text }); return true; },
        accounts: ACCOUNTS,
      }),
    });
    port.start();
    const { FakeClient } = makeFakeClient(servers[0]);
    const clock = makeClock();
    const r = await speakThroughPeer({ peer: PEER, chat: AS_PRIMARY, text: 'x', WebSocket: FakeClient, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    expect(r).toMatchObject({ ok: false, reason: 'unavailable', detail: 'desktop api is down' });
    expect(posted).toEqual([]);
    port.stop();
  });

  it('A PEER THAT IS NOT THERE reads as unreachable, so the caller can fall back', async () => {
    const { FakeClient, dialled } = makeFakeClient(null);      // nothing serving that port
    const clock = makeClock();
    const r = await speakThroughPeer({ peer: PEER, chat: AS_PRIMARY, text: 'x', WebSocket: FakeClient, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unreachable');
    expect(dialled).toHaveLength(1);
    // The timeout is ARMED and then dropped — a settled call leaves no timer behind.
    expect(clock.armed).toHaveLength(1);
  });
});

// ── 4. THE MAPPING, PURE ───────────────────────────────────────────────────────────────────────
describe('findChatByKey — the mapping, on its own', () => {
  const KEY_OF_GROUP = '#15551110001,#15551110002';

  it('finds the one chat and returns it in the RECEIVER\'s own id namespace', () => {
    expect(findChatByKey([OTHER_CHAT, AS_SECONDARY], KEY_OF_GROUP, ACCOUNTS)).toEqual({ ok: true, chatId: SECONDARY_CHAT_ID });
  });

  it('one chat listed twice is one chat, not an ambiguity', () => {
    expect(findChatByKey([AS_SECONDARY, { ...AS_SECONDARY }], KEY_OF_GROUP, ACCOUNTS)).toEqual({ ok: true, chatId: SECONDARY_CHAT_ID });
  });

  it('refuses an empty key, an empty list and a list of unkeyable chats', () => {
    expect(findChatByKey([AS_SECONDARY], '', ACCOUNTS).reason).toBe('no-key');
    expect(findChatByKey([], KEY_OF_GROUP, ACCOUNTS).reason).toBe('no-match');
    expect(findChatByKey(null, KEY_OF_GROUP, ACCOUNTS).reason).toBe('no-match');
    expect(findChatByKey([ONE_TO_ONE], KEY_OF_GROUP, ACCOUNTS).reason).toBe('no-match');
  });

  it('WITHOUT the account exclusions the two views do NOT key alike — which is why the config is explicit', () => {
    // Each account sees the OTHER as an ordinary member with a phone number, so an un-excluded key
    // carries the co-account and the two sides disagree. Locked so a future "simplification" that
    // drops peer_spine.accounts fails here instead of in a live chat.
    expect(findChatByKey([AS_SECONDARY], KEY_OF_GROUP, []).reason).toBe('no-match');
  });
});

// ── 5. THE CONSOLE MUST NOT REGRESS ────────────────────────────────────────────────────────────
// The operator's editor is the whole reason this port exists. Adding a second role to it is only
// acceptable if the first one is byte-for-byte what it was.
describe('the operator console is unchanged', () => {
  it('an editor still authenticates, takes the seat, and its text still runs a TURN', async () => {
    const { server, turns, port } = rig();
    const editor = seatEditor(server, PEER.consoleToken);
    expect(port.isConnected).toBe(true);

    editor.fire('message', Buffer.from(JSON.stringify({ text: 'hola E' })));
    expect(turns).toHaveLength(1);
    expect(turns[0].body).toBe('hola E');
    expect(turns[0].from).toMatchObject({ network: 'shell', chatId: 'lobby', authorized: true });

    // …and the reply still goes back over that same socket.
    port.send('lobby', 'the answer');
    expect(JSON.parse(editor.sent.pop())).toMatchObject({ text: 'the answer', chatId: 'lobby' });
    port.stop();
  });

  it('a bare (non-JSON) editor line still becomes a turn, exactly as before', () => {
    const { server, turns, port } = rig();
    const editor = seatEditor(server, PEER.consoleToken);
    editor.fire('message', Buffer.from('/status'));
    expect(turns).toHaveLength(1);
    expect(turns[0].body).toBe('/status');
    port.stop();
  });

  it('a SECOND editor is still refused while the seat is held (the mouth changed nothing there)', () => {
    const { server, port, logs } = rig();
    seatEditor(server, PEER.consoleToken);
    const second = server.dial();
    expect(second.closed).toBe(true);
    expect(second.sent).toEqual([]);
    expect(logs.join('\n')).toMatch(/second client dialed in while the console seat is held/);
    port.stop();
  });

  it('A MOUTH FRAME ON THE CONSOLE CONNECTION is discarded — never dispatched as a turn', () => {
    // A peer that dialled the root instead of MOUTH_PATH. Without this the console's toInbound
    // would hand the whole JSON line to the spine as something a human typed, and the receiving
    // node would ANSWER a finished reply. Belt and braces beside the path check.
    const { server, turns, posted, port, logs } = rig();
    const editor = seatEditor(server, PEER.consoleToken);
    editor.fire('message', Buffer.from(sayFrame({ chatKey: '#15551110001,#15551110002', text: 'say this' })));
    expect(turns).toEqual([]);
    expect(posted).toEqual([]);
    expect(logs.join('\n')).toMatch(/mouth frame arrived on the CONSOLE connection/);
    port.stop();
  });
});
