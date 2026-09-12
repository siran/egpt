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
import { MOUTH_PATH, sayFrame, sayReactFrame, parseMouthFrame } from '../src/shell/mouth.mjs';
import { peerSpineFrom, findChatByKey, findChatByLastMessage, findMessageByKey, createMouthReceiver, speakThroughPeer, startPeerStream, reactThroughPeer } from '../src/shell/peer-mouth.mjs';
// The message key is minted in the BRIDGE, beside the echo plan's audioHash, and read back here
// rather than re-derived: a test that hashed its own fixtures would pass while the two ends drifted.
import { crossAccountMsgKey } from '../src/bridges/beeper.mjs';
import { responseFrame } from '../src/shell/auth.mjs';
// §2d dials the WHOLE reply path across the link — the real sender on one side, a real Beeper
// port on each account — so the bytes asserted there are the bytes a chat would show.
import { createBeeperBridgePort } from '../src/bridges/beeper-port.mjs';
import { createSender } from '../src/spine/sender.mjs';
import { encodeNodeSignature, decodeNodeSignature, stripNodeSignature } from '../src/node-signature.mjs';
import { LIVE_FRAME_MARK } from '../src/dispatch-line.mjs';

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

// ── ONE REAL MESSAGE, TWO MATRIX EVENTS ────────────────────────────────────────────────────────
// Measured live 2026-09-07, ONE WhatsApp message in a group both accounts are in. Nothing
// addressable crosses: the id is per-account (2901 / 1118) and so is the room. The BODY and the
// TIMESTAMP are byte-identical, and they are the whole basis of the reaction verb.
const STEERED_TEXT = 'and also X';
const STEERED_TS_ISO = '2026-09-07T11:07:17.000Z';
const STEERED_TS = Date.parse(STEERED_TS_ISO);
// As the PRIMARY (the brain) sees it — the message a human steered into the live turn.
const STEERED_ON_PRIMARY = { id: '2901', text: STEERED_TEXT, timestamp: STEERED_TS_ISO };
// The SAME message as the SECONDARY (the mouth) sees it: different id, same body, same timestamp.
const STEERED_ON_SECONDARY = { id: '1118', text: STEERED_TEXT, timestamp: STEERED_TS_ISO };
// Two neighbours on the secondary's copy of the chat, so a match is a match and not the only item.
const EARLIER_ON_SECONDARY = { id: '1117', text: 'something else entirely', timestamp: '2026-09-07T11:05:00.000Z' };
const LATER_ON_SECONDARY = { id: '1119', text: 'unrelated', timestamp: '2026-09-07T11:09:00.000Z' };
// The key the BRIDGE mints for that body — computed by the same function both ends call.
const STEERED_KEY = crossAccountMsgKey(STEERED_ON_PRIMARY);

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
// that NOTHING was dialled at all; `sockets` holds the client ends, so a test can READ every frame
// the speaker put on the wire, and can CUT one link mid-reply without stopping the whole limb.
function makeFakeClient(server) {
  const dialled = [];
  const sockets = [];
  class FakeClient extends Sock {
    constructor(url) {
      super();
      dialled.push(String(url));
      sockets.push(this);
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
  return { FakeClient, dialled, sockets };
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
function rig({
  chats = [AS_SECONDARY, OTHER_CHAT], token = PEER.consoleToken, post, startStream, mouth = true, legacy = false,
  // The RECEIVER's own copies of this chat's recent messages, and its reaction primitive — the two
  // seams `say: react` needs. `null` for either models a bridge that has neither, which is what
  // `no-react` is for (the same convention `startStream: null` already follows).
  messages = [LATER_ON_SECONDARY, STEERED_ON_SECONDARY, EARLIER_ON_SECONDARY], listMessages, react,
} = {}) {
  const { WebSocketServer, servers } = makeFakeWss();
  const posted = [];
  const trains = [];      // the live messages the RECEIVER opened: { chatId, init, frames, final }
  const reacted = [];     // what the RECEIVER placed, in ITS OWN id namespace: { chatId, msgId, emoji }
  const listed = [];      // which of its chats it looked in — a reaction may never leave that chat
  const logs = [];
  const turns = [];
  const receiver = createMouthReceiver({
    listChats: async () => chats,
    listMessages: listMessages === null ? null : (listMessages ?? (async (chatId) => { listed.push(chatId); return messages; })),
    react: react === null ? null : (react ?? (async (chatId, msgId, emoji) => { reacted.push({ chatId, msgId, emoji }); return true; })),
    post: post ?? (async (chatId, text) => { posted.push({ chatId, text }); return { ok: true }; }),
    // The secondary account's edit-in-place primitive (boot wires bridge.startStreamVerbatim).
    // `startStream: null` models a bridge that has none, which is what `no-stream` is for.
    startStream: startStream === null ? null : (startStream ?? ((chatId, init) => {
      const m = { chatId, init, frames: [], final: null, delivered: false };
      trains.push(m);
      return { update(t) { m.frames.push(t); }, async finish(t) { m.final = t; m.delivered = true; }, get delivered() { return m.delivered; } };
    })),
    accounts: ACCOUNTS,
    onLog: (m) => logs.push(m),
  });
  const port = createShellPort({
    WebSocketServer, token, reapPort: () => 0,
    // `legacy` is a node running the code from BEFORE the streaming verbs existed: a table with
    // `post` and nothing else, which is exactly what createMouthReceiver used to hand the limb.
    // The limb then refuses every other verb with `bad-frame` — the upgrade-one-at-a-time case.
    onPeerSay: mouth ? (legacy ? { post: (f) => receiver.post(f) } : receiver) : null,
    onLog: (m) => logs.push(m),
  });
  port.onMessage((ev) => { turns.push(ev); });
  port.start();
  const server = servers[0];
  const { FakeClient, dialled, sockets } = makeFakeClient(server);
  const clock = makeClock();
  const speak = ({ chat = AS_PRIMARY, text = 'the finished line', peer = PEER } = {}) =>
    speakThroughPeer({ peer, chat, text, WebSocket: FakeClient, onLog: (m) => logs.push(m), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  // The SPEAKER's reply train, over the same fake socket: what src/spine/sender.mjs opens on a
  // peer route. `fallback` is the sender's local stream factory (tier 3); `render` is the BRAIN's
  // own wrap, applied to every frame that crosses the wire (absent ⇒ the default identity, which
  // is what every case that is not about the persona passes).
  const train = ({ chat = AS_PRIMARY, init = '⏳ Thinking…', peer = PEER, fallback = null, render } = {}) =>
    startPeerStream({ peer, chat, init, fallback, render, WebSocket: FakeClient, onLog: (m) => logs.push(m), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  // The SPEAKER's reaction: what src/spine/turns.mjs asks for when the peer is saying the reply.
  const poke = ({ chat = AS_PRIMARY, msgKey = STEERED_KEY, timestamp = STEERED_TS, emoji = '👀', peer = PEER } = {}) =>
    reactThroughPeer({ peer, chat, msgKey, timestamp, emoji, WebSocket: FakeClient, onLog: (m) => logs.push(m), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  // Let every queued microtask drain — the fake sockets deliver on microtasks, so "the frames have
  // landed and been answered" is a few turns of the loop away and never a timer.
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { port, server, posted, trains, reacted, listed, logs, turns, speak, train, poke, dialled, sockets, clock, flush, FakeClient };
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

// ── 2b. THE REPLY TRAIN ACROSS THE LINK ────────────────────────────────────────────────────────
// The thing the first cut of this link could not do (operator 2026-09-05, "it's working, but
// please let's recover the thinking train"): a "⏳ Thinking…" placeholder on the OTHER account,
// edited in place until it is the answer. The shape that makes it safe is that the RECEIVER keeps
// the live stream object and hands back an opaque id of its own — no Beeper message id ever
// crosses the wire, in either direction.
describe('a reply TRAIN crosses the link: placeholder, edits, settled answer, all on the other account', () => {
  it('posts the placeholder, edits it in place, and settles it — ONE message on the secondary', async () => {
    const { trains, turns, posted, dialled, train, flush, port } = rig();
    const t = train({ init: '⏳ Thinking…' });
    await flush();
    t.update('Hol');
    t.update('Hola mun');
    await t.finish('Hola mundo');

    expect(trains).toHaveLength(1);
    expect(trains[0].chatId).toBe(SECONDARY_CHAT_ID);           // the SECONDARY's own id, resolved by key
    expect(trains[0].init).toBe('⏳ Thinking…');
    expect(trains[0].frames).toEqual(['Hol', 'Hola mun']);
    expect(trains[0].final).toBe('Hola mundo');
    expect(t.delivered).toBe(true);
    // ONE message, and one dial for the whole reply — not one per frame.
    expect(posted).toEqual([]);
    expect(dialled).toHaveLength(1);
    // Still the one that matters most: the receiving spine ran no turn on any of it.
    expect(turns).toEqual([]);
    port.stop();
  });

  it('NO BEEPER MESSAGE ID CROSSES THE WIRE — the brain only ever names the receiver\'s own handle', async () => {
    // The whole reason this shape is safe (src/shell/mouth.mjs). The brain cannot address an edit
    // to a message even in principle: the only token it holds is a key into the receiver's own map.
    const { sockets, train, port } = rig();
    const t = train();
    t.update('half');
    await t.finish('whole');

    const frames = sockets[0].sent.map((f) => JSON.parse(f)).filter((f) => typeof f.say === 'string');
    expect(frames.map((f) => f.say)).toEqual(['open', 'update', 'finish']);
    expect(frames[0]).not.toHaveProperty('stream');             // the open frame names no stream at all
    // …and the token the later frames DO carry is the receiver's minted handle, not any id that
    // exists on either Beeper account.
    const handle = frames[1].stream;
    expect(handle).toBeTruthy();
    expect(frames[2].stream).toBe(handle);
    expect(handle).not.toBe(SECONDARY_CHAT_ID);
    expect(handle).not.toContain(':beeper.local');
    expect(t.confirmedId).toBeNull();                           // and nothing addressable comes back either
    port.stop();
  });

  it('TOKENS NEVER WAIT ON THE OPEN ANSWER — an update pushed first is buffered, not lost', async () => {
    // The stream id comes back a round trip after the open frame goes out, and a fast first token
    // can beat it. It is held (every frame carries the WHOLE text, so only the newest matters) and
    // flushed the instant the answer arrives — so the round trip costs no latency on the tokens,
    // only on the brain's knowledge of the handle.
    const { trains, train, port } = rig();
    const t = train();
    t.update('written before the peer answered');               // synchronous: the stream id cannot exist yet
    await t.finish('the settled answer');
    expect(trains[0].frames).toEqual(['written before the peer answered']);
    expect(trains[0].final).toBe('the settled answer');
    port.stop();
  });

  it('AN OLD PEER — one that serves say:post only — gets the finished line instead, with no stall', async () => {
    // THE UPGRADE-ONE-AT-A-TIME CASE, and the reason an unknown verb is refused rather than
    // ignored: a node running the pre-streaming code answers `open` with a `post`-shaped
    // `bad-frame` result, and the speaker takes that as the open refusal ON THE SPOT rather than
    // waiting out its own watchdog. A ten-second stall on every reply is what silence would cost.
    const { trains, posted, logs, train, port } = rig({ legacy: true });
    const t = train();
    t.update('half');
    await t.finish('the whole answer');
    expect(trains).toEqual([]);
    expect(posted).toEqual([{ chatId: SECONDARY_CHAT_ID, text: 'the whole answer' }]);
    expect(t.delivered).toBe(true);
    expect(logs.some((l) => l.includes('does not serve reply trains') && l.includes('bad-frame'))).toBe(true);
    port.stop();
  });

  it('A PEER WHOSE BRIDGE CANNOT EDIT IN PLACE refuses with no-stream and gets the finished line too', async () => {
    // The same degradation from the other direction: the verbs are served, but this account's own
    // Beeper bridge has no edit-in-place primitive to hold a train with.
    const { trains, posted, logs, train, port } = rig({ startStream: null });
    const t = train();
    await t.finish('the whole answer');
    expect(trains).toEqual([]);
    expect(posted).toEqual([{ chatId: SECONDARY_CHAT_ID, text: 'the whole answer' }]);
    expect(t.delivered).toBe(true);
    expect(logs.some((l) => l.includes('would not open a reply train') && l.includes('no-stream'))).toBe(true);
    port.stop();
  });

  it('A CHAT THE RECEIVER CANNOT FIND refuses the train AND the line, and the caller is told', async () => {
    const { trains, posted, train, port } = rig({ chats: [] });
    const t = train();
    await t.finish('the answer');
    expect(trains).toEqual([]);
    expect(posted).toEqual([]);
    expect(t.delivered).toBe(false);                            // ⇒ src/spine/sender.mjs's §7 posts it here
    port.stop();
  });

  it('A CHAT THAT CANNOT BE KEYED never dials, and takes the LOCAL fallback immediately', async () => {
    // Known synchronously, so the local placeholder goes up at once rather than after a silent
    // wait — the one refusal that does not cost the user a delay.
    const local = { init: null, frames: [], final: null, delivered: false };
    const fallback = () => ({ update: (t) => local.frames.push(t), finish: async (t) => { local.final = t; local.delivered = true; }, get delivered() { return local.delivered; }, confirmedId: 'local-1' });
    const { dialled, train, port } = rig();
    const t = train({ chat: ONE_TO_ONE, fallback });
    t.update('half');
    await t.finish('the answer');
    expect(dialled).toEqual([]);
    expect(local.frames).toEqual(['half']);
    expect(local.final).toBe('the answer');
    expect(t.delivered).toBe(true);
    expect(t.confirmedId).toBe('local-1');                      // the ONLY case with an id this node can use
    port.stop();
  });

  it('NEITHER MOUTH AVAILABLE ⇒ the local fallback, replayed — the reply is never lost', async () => {
    const local = { frames: [], final: null, delivered: false };
    const fallback = () => ({ update: (t) => local.frames.push(t), finish: async (t) => { local.final = t; local.delivered = true; }, get delivered() { return local.delivered; } });
    const { trains, posted, logs, train, port } = rig({ chats: [] });   // the peer can neither stream nor post
    const t = train({ fallback });
    t.update('half an answer');
    await t.finish('the whole answer');
    expect(trains).toEqual([]);
    expect(posted).toEqual([]);
    expect(local.frames).toEqual(['half an answer']);           // what streamed is replayed, never lost
    expect(local.final).toBe('the whole answer');
    expect(t.delivered).toBe(true);
    expect(logs.some((l) => l.startsWith('mouth: FALLING BACK TO THIS ACCOUNT') && l.includes('no-match'))).toBe(true);
    port.stop();
  });
});

// ── 2c. THE MID-STREAM DROP ────────────────────────────────────────────────────────────────────
// THE decision this feature turns on. If the link dies after the placeholder is posted, the peer's
// account is holding a "⏳ Thinking…" message that ONLY the receiver can finish — the brain has no
// id for it and never will. A message stranded mid-thought on the other account is the worst
// outcome available here, worse than not streaming at all.
//
// THE RULE: the receiver finishes its own orphans on socket close, with a visible marker. And the
// bug this rule could have had is that "the link dropped" and "the reply ended" are the SAME close
// event, because the socket is per-reply — so the two are told apart by PRESENCE in the receiver's
// map, which `finish` clears BEFORE it awaits anything.
describe('the mid-stream drop — a half-written message is never left stranded, and never double-written', () => {
  const INTERRUPTED = '⚠️ interrupted — the link to the spine writing this reply dropped.';

  it('a link that dies mid-thought settles the peer\'s message on what was written, marked interrupted', async () => {
    const { trains, sockets, train, flush, port } = rig();
    const t = train();
    t.update('the brain got this far');
    await flush();
    expect(trains[0].final).toBeNull();                          // still thinking, placeholder up

    sockets[0].close();                                          // THE DROP: the brain died mid-reply
    await flush();

    expect(trains[0].final).toBe(`the brain got this far\n\n${INTERRUPTED}`);
    expect(trains[0].delivered).toBe(true);
    port.stop();
  });

  it('a drop before a single token settles the placeholder on the marker alone — never left thinking', async () => {
    const { trains, sockets, train, flush, port } = rig();
    train();
    await flush();
    expect(trains).toHaveLength(1);
    expect(trains[0].final).toBeNull();
    sockets[0].close();
    await flush();
    expect(trains[0].final).toBe(INTERRUPTED);
    port.stop();
  });

  it('A COMPLETED REPLY IS NOT AN ORPHAN — the close that follows it settles nothing a second time', async () => {
    // The socket is opened per reply and closed the instant the reply settles, so a normal
    // completion and a drop arrive as the SAME close event. `finish` removes the entry from the
    // receiver's map before it awaits anything, so this close finds nothing to settle. Without
    // that ordering every finished reply would be overwritten by the interruption marker.
    const { trains, sockets, train, flush, port } = rig();
    const t = train();
    t.update('half');
    await t.finish('the settled answer');
    expect(sockets[0].closed).toBe(true);                        // the speaker closed it, as it always does
    await flush();
    expect(trains[0].final).toBe('the settled answer');
    expect(trains[0].final).not.toContain('interrupted');
    port.stop();
  });

  it('THE LIMB STOPPING settles what its peers left open, rather than orphaning it on the way down', async () => {
    const { trains, train, flush, port } = rig();
    const t = train();
    t.update('mid-thought');
    await flush();
    port.stop();                                                 // closes every authenticated peer socket
    await flush();
    expect(trains[0].final).toBe(`mid-thought\n\n${INTERRUPTED}`);
    expect(t.delivered).toBe(false);                             // …and the brain has NOT been told it was said
  });

  it('`gone` IS NOT A VERB — a peer cannot settle another connection\'s replies by asking', async () => {
    // The orphan sweep is the LIMB's to call, on close, and nobody else's. shell-port's answer
    // table is also the allowlist, so a table entry that is not a wire verb is unreachable from a
    // frame — otherwise anything holding the token could truncate a reply mid-thought.
    const { server, trains, train, flush, port } = rig();
    const t = train();
    t.update('mid-thought');
    await flush();

    const peerWs = server.dial(MOUTH_PATH);
    const challenge = JSON.parse(peerWs.sent.shift());
    peerWs.fire('message', Buffer.from(responseFrame(PEER.consoleToken, challenge.nonce)));
    peerWs.fire('message', Buffer.from(JSON.stringify({ say: 'gone' })));
    await flush();

    expect(parseMouthFrame(peerWs.sent.pop())).toMatchObject({ say: 'result', ok: false, reason: 'bad-frame' });
    expect(trains[0].final).toBeNull();                          // the live train is untouched
    await t.finish('the whole answer');
    expect(trains[0].final).toBe('the whole answer');
    port.stop();
  });

  it('after a drop the brain RE-DIALS the peer, so the finished reply still lands on the RIGHT account', async () => {
    // Tier 2: a fresh dial and one finished line, beside the message the receiver just marked
    // interrupted. Posting on the brain's own account is only the LAST resort — the whole point of
    // the arrangement is which account the reply comes out of, and a dropped socket does not
    // change that. Two messages, one of them explicitly labelled interrupted, is the deliberate
    // trade: a truncated answer wearing the shape of a finished one would be worse.
    const { trains, posted, sockets, dialled, train, flush, port } = rig();
    const t = train();
    t.update('half');
    await flush();
    sockets[0].close();                                          // the link dies mid-thought
    await flush();
    await t.finish('the whole answer');

    expect(trains[0].final).toBe(`half\n\n${INTERRUPTED}`);      // the orphan, settled by the receiver
    expect(posted).toEqual([{ chatId: SECONDARY_CHAT_ID, text: 'the whole answer' }]);   // …and the reply, said
    expect(t.delivered).toBe(true);
    expect(dialled).toHaveLength(2);                             // one dial for the train, one for the retry
    port.stop();
  });
});

// ── 2d. WHOSE VOICE A PEER-SAID REPLY IS IN ────────────────────────────────────────────────────
// THE DEFECT (operator 2026-09-05, reading his own two chats): a local reply renders as
// "🤴 King Ken: <text> 🏰" plus the invisible node id, and a peer-routed one went out as BARE
// TEXT — so the same being appeared stamped in one chat and naked in the next. The mouth posts
// VERBATIM by contract (beeper-port.postVerbatim / startStreamVerbatim), and postVerbatim's own
// comment said the text "arrived already signed by the other spine" — which was simply false,
// because nothing on the way there signed it. These cases make it true.
//
// THE WRAP HAPPENS ON THE BRAIN, and the alternative is worth naming to see why not: making the
// RECEIVER wrap would mean shipping the brain's persona, emoji and signature strings over the
// wire so the mouth could re-render them — strictly more coupling for identical pixels, and a
// second definition of a stamp that persona-wrap.mjs deliberately owns alone.
//
// THE TWO SIDES ARE CONFIGURED DIFFERENTLY ON PURPOSE. On the operator's own machine both nodes
// are `King Ken 🤴 🏰`, so a reply rendered by the WRONG spine would look exactly right and no
// assertion could tell. Here the mouth is a different being on a different node, and what is
// being locked is that not one byte of it reaches the message.
describe('a peer-said reply is stamped by the BRAIN that wrote it, exactly once', () => {
  const BRAIN = { bodyEmoji: '🤴', label: 'King Ken', bridgeSignatureClose: '🏰', nodeName: 'kg' };
  const MOUTH = { bodyEmoji: '🤖', label: 'Rodz Bot', bridgeSignatureClose: '🏯', nodeName: 'kg2' };
  const KG = encodeNodeSignature(BRAIN.nodeName);

  // A fake real-bridge behind createBeeperBridgePort — the same seam tests/beeper-port.test.mjs
  // uses, kept to the two outbounds this file exercises. `sent` / `streams` are the BYTES that
  // account would have put in the chat.
  function fakeBeeper() {
    const spy = { sent: [], streams: [] };
    const start = async () => ({
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { init, chatId: o?.chatId, updates: [], finals: [], delivered: false };
        h.update = (t) => h.updates.push(t);
        h.finish = (t) => { h.finals.push(t); h.delivered = true; };
        spy.streams.push(h);
        return h;
      },
      isAlive: () => true, stop: () => {},
    });
    return { start, spy };
  }

  // Two spines over one fake link: the BRAIN's sender (the real createSender, with the real peer
  // route) speaking through the MOUTH's receiver, whose post/startStream are the mouth account's
  // own verbatim primitives — i.e. exactly boot's wiring (boot.mjs createMouthReceiver).
  async function twoSpines(rigOpts = {}) {
    const brainIO = fakeBeeper();
    const mouthIO = fakeBeeper();
    const brainPort = await createBeeperBridgePort({ bridgeSignatureClose: BRAIN.bridgeSignatureClose, nodeName: BRAIN.nodeName }, { start: brainIO.start });
    const mouthPort = await createBeeperBridgePort({ bridgeSignatureClose: MOUTH.bridgeSignatureClose, nodeName: MOUTH.nodeName }, { start: mouthIO.start });
    const r = rig({
      post: (chatId, text) => mouthPort.postVerbatim(chatId, text),
      startStream: (chatId, init) => mouthPort.startStreamVerbatim(chatId, init),
      ...rigOpts,
    });
    // boot's makePeerMouth in miniature: the membership question is already answered, and the
    // stream is the REAL transport with the sender's own render handed straight through.
    const peerMouth = {
      async route() { return AS_PRIMARY; },
      startStream(chat, init, { fallback = null, render } = {}) { return r.train({ chat, init, fallback, render }); },
    };
    const sender = createSender({ bridge: brainPort, bodyEmojiOf: () => BRAIN.bodyEmoji, labelOf: () => BRAIN.label, peerMouth });
    return { ...r, brain: brainIO.spy, mouth: mouthIO.spy, brainPort, sender };
  }

  // One whole turn down the peer route: placeholder, one edit, settled answer.
  const aTurn = async ({ sender, flush }) => {
    const out = sender.open(AS_PRIMARY.id, { being: 'e' });
    await flush();
    out.update('Hola');
    await out.finish({ text: 'Hola mundo' });
    await flush();
    return out;
  };

  it('THE DEFECT: the reply the peer says is byte-identical to the one this account would have said', async () => {
    // The operator's sentence, as an assertion. Both replies are the same being answering the same
    // words; the only difference is which account's name is on the message, and that must not show
    // in the text at all.
    const { mouth, brain, brainPort, sender, flush, port } = await twoSpines();
    await aTurn({ sender, flush });

    const local = createSender({ bridge: brainPort, bodyEmojiOf: () => BRAIN.bodyEmoji, labelOf: () => BRAIN.label });
    const out = local.open('!local:beeper.local', { being: 'e' });
    out.update('Hola');
    await out.finish({ text: 'Hola mundo' });

    expect(mouth.streams).toHaveLength(1);
    expect(brain.streams).toHaveLength(1);                       // the local one, and ONLY the local one
    expect(mouth.streams[0].init).toBe(brain.streams[0].init);
    expect(mouth.streams[0].updates).toEqual(brain.streams[0].updates);
    expect(mouth.streams[0].finals).toEqual(brain.streams[0].finals);
    port.stop();
  });

  it('EVERY FRAME is wrapped — the ⏳ placeholder and each intermediate edit, not just the answer', async () => {
    // Signing is a property of the SEND, therefore of every frame (persona-wrap.mjs's header). The
    // placeholder is a real message living on the OTHER account for the whole turn, so it is the
    // one that would be visibly unsigned the longest.
    const { mouth, sender, flush, port } = await twoSpines();
    await aTurn({ sender, flush });

    expect(mouth.streams[0].init).toBe(`${BRAIN.bodyEmoji} ${BRAIN.label}: ${LIVE_FRAME_MARK} Thinking… ${BRAIN.bridgeSignatureClose}${KG}`);
    expect(mouth.streams[0].updates).toEqual([`${BRAIN.bodyEmoji} ${BRAIN.label}: Hola ${LIVE_FRAME_MARK} ${BRAIN.bridgeSignatureClose}${KG}`]);
    expect(mouth.streams[0].finals).toEqual([`${BRAIN.bodyEmoji} ${BRAIN.label}: Hola mundo ${BRAIN.bridgeSignatureClose}${KG}`]);
    port.stop();
  });

  it('EXACTLY ONCE, and it is the BRAIN\'s — no 🏰 🏰, and nothing of the mouth\'s own identity', async () => {
    const { mouth, sender, flush, port } = await twoSpines();
    await aTurn({ sender, flush });

    const count = (s, needle) => s.split(needle).length - 1;
    const frames = [mouth.streams[0].init, ...mouth.streams[0].updates, ...mouth.streams[0].finals];
    expect(frames).toHaveLength(3);
    for (const f of frames) {
      expect(count(f, BRAIN.bridgeSignatureClose)).toBe(1);
      expect(count(f, BRAIN.bodyEmoji)).toBe(1);
      expect(count(f, `${BRAIN.label}:`)).toBe(1);
      // EXACTLY ONE node frame, and it is the last thing in the message — `strip + re-append`
      // reconstructs the string only when there is precisely one and it trails.
      expect(`${stripNodeSignature(f)}${KG}`).toBe(f);
      expect(decodeNodeSignature(f)).toBe(BRAIN.nodeName);       // kg composed it, whatever account says it
      // …and the mouth added nothing of its own: not its node, not its signature, not its persona.
      expect(f).not.toContain(MOUTH.bridgeSignatureClose);
      expect(f).not.toContain(MOUTH.bodyEmoji);
      expect(f).not.toContain(MOUTH.label);
      expect(f).not.toContain(encodeNodeSignature(MOUTH.nodeName));
    }
    port.stop();
  });

  it('TIER 2 — the degraded finished line is wrapped too (a peer whose bridge cannot edit in place)', async () => {
    // The train refuses with `no-stream` and the reply goes out whole through `say: post`. It is
    // still the brain speaking on the peer's account, so it is still the brain's stamp.
    const { mouth, sender, flush, port } = await twoSpines({ startStream: null });
    await aTurn({ sender, flush });

    expect(mouth.streams).toEqual([]);
    expect(mouth.sent).toHaveLength(1);
    expect(mouth.sent[0].text).toBe(`${BRAIN.bodyEmoji} ${BRAIN.label}: Hola mundo ${BRAIN.bridgeSignatureClose}${KG}`);
    port.stop();
  });

  it('TIER 3 — the local fallback is wrapped ONCE, by the ordinary local path, never twice', async () => {
    // The peer can neither stream nor say it, so sender.mjs's own openLocal factory takes over —
    // and that factory is beeper-port.startStream, which wraps. The text handed to it must
    // therefore still be RAW: pre-wrapping it here is what would produce "🏰 🏰".
    const { mouth, brain, sender, flush, port } = await twoSpines({ chats: [] });
    await aTurn({ sender, flush });

    expect(mouth.streams).toEqual([]);
    expect(mouth.sent).toEqual([]);
    expect(brain.streams).toHaveLength(1);                       // said here instead, loudly logged
    expect(brain.streams[0].init).toBe(`${BRAIN.bodyEmoji} ${BRAIN.label}: ${LIVE_FRAME_MARK} Thinking… ${BRAIN.bridgeSignatureClose}${KG}`);
    expect(brain.streams[0].finals).toEqual([`${BRAIN.bodyEmoji} ${BRAIN.label}: Hola mundo ${BRAIN.bridgeSignatureClose}${KG}`]);
    expect(brain.streams[0].finals[0].split(BRAIN.bridgeSignatureClose)).toHaveLength(2);   // one close marker, not two
    expect(brain.sent).toEqual([]);                              // the local stream delivered, so §7 sends nothing beside it
    port.stop();
  });

  it('THE RE-INGESTION: the brain can now recognise its own routed reply coming back as Rodz', async () => {
    // The reason this is worth more than the pixels. The brain is in the same chat, so the reply
    // the MOUTH posts arrives at the brain as an ordinary inbound from the other account — the
    // bridge's own-send suppression is id-based (beeper.mjs wasSentByUs) and those ids belong to
    // the other spine, so it cannot help. Unsigned, the frame read as a HUMAN turn and RESET the
    // very loop counter that exists to stop two spines talking to each other. Signed, its
    // provenance is legible: identity.build lifts the node id off it and stop-guard classifies it
    // as node-committed. (What this does NOT do is keep it off the record or away from the
    // router — see the module note in src/spine/sender.mjs.)
    const { mouth, sender, flush, port } = await twoSpines();
    await aTurn({ sender, flush });
    const asRodzSaysIt = mouth.streams[0].finals[0];

    const { createIdentity } = await import('../src/spine/identity.mjs');
    const { isHumanTurn } = await import('../src/stop-guard.mjs');
    const ev = createIdentity().build({ body: asRodzSaysIt, from: { network: 'whatsapp', chatId: '!x', senderName: 'Rodz', isSender: false } });
    expect(ev.fromNode).toBe(BRAIN.nodeName);
    expect(isHumanTurn(ev)).toBe(false);
    port.stop();
  });
});

// ── 2e. THE 👀 CROSSES THE LINK ────────────────────────────────────────────────────────────────
// The one verb that names a MESSAGE (operator 2026-09-07). Everything else on this wire names a
// chat and nothing finer, which is why the steer acknowledgement used to be SUPPRESSED whenever
// the peer said the reply: nobody could tell the peer which message to sit the 👀 on, and placing
// it on the brain's own account is precisely the fault — the read receipt would come from the one
// account that is NOT answering.
//
// AND STILL NO ID CROSSES. The frame carries the message's cross-account CONTENT KEY and its
// TIMESTAMP — the two fields both accounts measurably agree on (2901/1118 vs. the identical body
// and 2026-09-07T11:07:17.000Z) — and the receiver reacts with ITS OWN id, which the brain never
// learns. Exactly the property the reply train already has for message identity.
describe('a REACTION crosses the link and is placed on the OTHER account\'s own copy', () => {
  it('resolves the chat, then the message, and reacts with the SECONDARY\'s id — never the primary\'s', async () => {
    const { reacted, listed, turns, poke, dialled, port } = rig();
    const r = await poke();

    expect(r).toEqual({ ok: true, chatId: SECONDARY_CHAT_ID });
    // THE ASSERTION THIS WHOLE CHUNK EXISTS FOR: the 👀 is on the secondary's OWN message id.
    expect(reacted).toEqual([{ chatId: SECONDARY_CHAT_ID, msgId: '1118', emoji: '👀' }]);
    expect(reacted[0].msgId).not.toBe(STEERED_ON_PRIMARY.id);   // the brain's id means nothing here
    expect(listed).toEqual([SECONDARY_CHAT_ID]);                // it looked in that chat and no other
    expect(dialled).toEqual([`ws://127.0.0.1:23377${MOUTH_PATH}`]);
    expect(turns).toEqual([]);                                  // a reaction is placed, never answered
    port.stop();
  });

  it('the frame carries the four fields and NO id, in either direction', async () => {
    const { sockets, poke, port } = rig();
    await poke();
    const sent = sockets[0].sent.map((s) => JSON.parse(s));
    const frame = sent.find((f) => f.say === 'react');
    expect(frame).toEqual({ say: 'react', chatKey: 'group,#15551110001,#15551110002', msgKey: STEERED_KEY, timestamp: STEERED_TS, emoji: '👀' });
    // Neither account's message id appears anywhere on the wire, in either direction.
    const wire = [...sockets[0].sent, ...sockets[0].other.sent].join('\n');
    expect(wire).not.toContain('"2901"');
    expect(wire).not.toContain('"1118"');
    port.stop();
  });

  it('the SAME BODY IN ANOTHER CHAT is never reacted to — the chat is resolved first, always', async () => {
    // The secondary's copy of the RIGHT chat does not hold the message at all; an identical body
    // sitting in some other conversation must not rescue it.
    const { reacted, poke, logs, port } = rig({ messages: [EARLIER_ON_SECONDARY, LATER_ON_SECONDARY] });
    const r = await poke();
    expect(r).toMatchObject({ ok: false, reason: 'no-match' });
    expect(reacted).toEqual([]);
    expect(logs.join('\n')).toMatch(/REFUSING to react in HuXFQeZSY1X4khNDWTzz — no-match/);
    port.stop();
  });

  it('TWO IDENTICAL BODIES in the chat are told apart by the TIMESTAMP', async () => {
    // "ok" twice is not exotic — it is the ordinary case, and the reason the timestamp is on the
    // frame at all. Same body, two ids, two times: the frame's timestamp picks exactly one.
    const twinEarlier = { id: '1100', text: STEERED_TEXT, timestamp: '2026-09-07T10:00:00.000Z' };
    const { reacted, poke, port } = rig({ messages: [twinEarlier, STEERED_ON_SECONDARY] });
    const r = await poke();
    expect(r.ok).toBe(true);
    expect(reacted).toEqual([{ chatId: SECONDARY_CHAT_ID, msgId: '1118', emoji: '👀' }]);
    port.stop();
  });

  it('ONE match is answered whatever the timestamp says — the content already identified it', async () => {
    // The timestamp is a TIE-BREAK, not a filter. A single match must not be thrown away because
    // one account rendered the clock differently; that would turn a working ack into silence.
    const { reacted, poke, port } = rig({ messages: [{ ...STEERED_ON_SECONDARY, timestamp: '2026-09-07T11:07:19.000Z' }] });
    const r = await poke();
    expect(r.ok).toBe(true);
    expect(reacted).toEqual([{ chatId: SECONDARY_CHAT_ID, msgId: '1118', emoji: '👀' }]);
    port.stop();
  });

  it('a chat that does not resolve is never even searched for a message', async () => {
    const { listed, poke, port } = rig({ chats: [OTHER_CHAT] });   // no chat keys alike
    const r = await poke();
    expect(r).toMatchObject({ ok: false, reason: 'no-match' });
    expect(listed).toEqual([]);                                     // never looked for a message
    port.stop();
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
      onPeerSay: { post: () => { throw new Error('handler exploded before it ever returned a promise'); } },
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

  // ── the REACTION verb's own refusals. Every one ends with NO REACTION ANYWHERE, which is the
  // behaviour this link had before the verb existed and is deliberately kept as the floor: a
  // missing 👀 is cosmetic, a 👀 from the account that is not answering is the bug being fixed.
  it('TWO IDENTICAL BODIES AT THE SAME INSTANT stay ambiguous — the tie-break ran and did not break the tie', async () => {
    const twin = { id: '1200', text: STEERED_TEXT, timestamp: STEERED_TS_ISO };
    const { reacted, poke, logs, port } = rig({ messages: [STEERED_ON_SECONDARY, twin] });
    const r = await poke();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ambiguous');
    expect(r.detail).toMatch(/2 messages key alike \(1118, 1200\)/);
    expect(r.detail).toMatch(/2 of them at 2026-09-07T11:07:17\.000Z/);
    expect(r.detail).toMatch(/refusing to pick/);
    expect(reacted).toEqual([]);
    expect(logs.join('\n')).toMatch(/REFUSING to react in HuXFQeZSY1X4khNDWTzz — ambiguous/);
    port.stop();
  });

  it('TWO IDENTICAL BODIES AND NO TIMESTAMP on the frame stay ambiguous — it never takes the newest', async () => {
    const twin = { id: '1200', text: STEERED_TEXT, timestamp: '2026-09-07T11:08:00.000Z' };
    const { reacted, poke, port } = rig({ messages: [STEERED_ON_SECONDARY, twin] });
    const r = await poke({ timestamp: 0 });
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(r.detail).toMatch(/the frame carried no timestamp/);
    expect(reacted).toEqual([]);
    port.stop();
  });

  it('A MESSAGE THAT COULD NOT BE KEYED refuses BEFORE the frame is sent — no dial at all', async () => {
    // A voice note / a captionless attachment has no body to hash, so the bridge mints null and
    // the peer can never be told which message. Nothing to dial for.
    const { poke, dialled, reacted, logs, port } = rig();
    expect(await poke({ msgKey: '' })).toEqual({ ok: false, reason: 'no-key', detail: 'the message carries no cross-account key' });
    expect(await poke({ msgKey: null })).toMatchObject({ reason: 'no-key' });
    expect(dialled).toEqual([]);
    expect(reacted).toEqual([]);
    expect(logs.join('\n')).toMatch(/no body to hash.*NOBODY reacts/);
    port.stop();
  });

  it('A CHAT THAT CANNOT BE KEYED refuses the reaction before the frame is sent, exactly as a line is', async () => {
    const { poke, dialled, reacted, port } = rig();
    expect(await poke({ chat: ONE_TO_ONE })).toEqual({ ok: false, reason: 'no-key', detail: 'crossAccountChatKey refused this chat' });
    expect(dialled).toEqual([]);
    expect(reacted).toEqual([]);
    port.stop();
  });

  it('AN EMPTY EMOJI never dials, and a peer that sends one is refused', async () => {
    const { poke, dialled, port } = rig();
    expect(await poke({ emoji: '' })).toEqual({ ok: false, reason: 'no-text', detail: 'nothing to react with' });
    expect(dialled).toEqual([]);
    port.stop();
  });

  it('NO PEER CONFIGURED: the socket constructor is never reached', async () => {
    const { FakeClient, dialled } = makeFakeClient(null);
    const r = await reactThroughPeer({ peer: null, chat: AS_PRIMARY, msgKey: STEERED_KEY, timestamp: STEERED_TS, emoji: '👀', WebSocket: FakeClient });
    expect(r).toEqual({ ok: false, reason: 'no-peer', detail: 'no peer spine configured' });
    expect(dialled).toEqual([]);
  });

  it('A PEER THAT IS NOT THERE reads as unreachable, and nobody reacts', async () => {
    const { FakeClient, dialled } = makeFakeClient(null);
    const clock = makeClock();
    const r = await reactThroughPeer({ peer: PEER, chat: AS_PRIMARY, msgKey: STEERED_KEY, timestamp: STEERED_TS, emoji: '👀', WebSocket: FakeClient, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unreachable');
    expect(dialled).toHaveLength(1);
    expect(clock.armed).toHaveLength(1);            // armed and dropped; a settled call leaves no timer
  });

  it("A RECEIVER THAT CANNOT REACT AT ALL answers no-react, which is what an OLD peer looks like", async () => {
    // Two shapes of the same fact. A bridge with neither seam…
    const bare = rig({ listMessages: null, react: null });
    expect(await bare.poke()).toMatchObject({ ok: false, reason: 'no-react', detail: 'this bridge cannot list its messages or cannot react' });
    expect(bare.logs.join('\n')).toMatch(/cannot place one — refusing \(nobody will react\)/);
    bare.port.stop();

    // …and a peer running the code from BEFORE the verb existed, whose verb table has no `react`
    // entry: the limb refuses it with bad-frame, the same signal `open` degrades on.
    const legacy = rig({ legacy: true });
    expect(await legacy.poke()).toMatchObject({ ok: false, reason: 'bad-frame' });
    expect(legacy.reacted).toEqual([]);
    legacy.port.stop();
  });

  it("THE RECEIVER'S OWN MESSAGE LIST being unreadable is reported back as unavailable", async () => {
    const { poke, reacted, logs, port } = rig({ listMessages: async () => { throw new Error('desktop api is down'); } });
    expect(await poke()).toMatchObject({ ok: false, reason: 'unavailable', detail: 'desktop api is down' });
    expect(reacted).toEqual([]);
    expect(logs.join('\n')).toMatch(/could not read the messages of HuXFQeZSY1X4khNDWTzz — refusing to react/);
    port.stop();
  });

  it('THE REACTION ITSELF FAILING is reported back, not swallowed', async () => {
    const thrower = rig({ react: async () => { throw new Error('beeper said no'); } });
    expect(await thrower.poke()).toMatchObject({ ok: false, reason: 'send-failed', detail: 'beeper said no' });
    thrower.port.stop();

    const refuser = rig({ react: async () => false });          // a drop, not a throw
    expect(await refuser.poke()).toMatchObject({ ok: false, reason: 'send-failed' });
    refuser.port.stop();
  });

  it('AN UNAUTHENTICATED PEER cannot place a reaction either', async () => {
    const { reacted, port, server } = rig();
    const { FakeClient } = makeFakeClient(server);
    const clock = makeClock();
    const r = await reactThroughPeer({
      peer: { ...PEER, consoleToken: 'WRONG-token' }, chat: AS_PRIMARY, msgKey: STEERED_KEY, timestamp: STEERED_TS, emoji: '👀',
      WebSocket: FakeClient, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(reacted).toEqual([]);
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
  const KEY_OF_GROUP = 'group,#15551110001,#15551110002';

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

  // ── THE TITLE KEY, same mapping, same refusals (operator 2026-09-12) ────────────────────────
  // A group whose ONLY members are the two accounts leaves NO phone identity once both are
  // excluded, so crossAccountChatKey keys it by its NAME instead (its "THE CHAT THAT IS ONLY US").
  // That key arrives here like any other and must obey the same two refusals.
  const ONLY_US = {
    id: '!admin:beeper.local', title: 'eGPT Admin', type: 'group',
    participants: { items: [member('s-primary', PRIMARY_NUM), self('@secondary:beeper.com')] },
  };
  const KEY_OF_ONLY_US = 'group,title:egpt-admin';

  it('finds the two-account group by its TITLE key', () => {
    expect(findChatByKey([OTHER_CHAT, ONLY_US], KEY_OF_ONLY_US, ACCOUNTS)).toEqual({ ok: true, chatId: 'admin' });
  });

  // THE LOCK the title key needs most: its honest limit is two DIFFERENT two-account groups NAMED
  // ALIKE, and the answer must be the one a duplicate membership already gets — refuse, never pick.
  it('TWO two-account groups NAMED ALIKE are ambiguous — it still never picks one', () => {
    const twin = { ...ONLY_US, id: '!admin2:beeper.local' };
    const r = findChatByKey([ONLY_US, twin], KEY_OF_ONLY_US, ACCOUNTS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ambiguous');
    expect(r.detail).toMatch(/2 chats key alike/);
    expect(r.detail).toContain('admin');
    expect(r.detail).toContain('admin2');
  });

  it('a TITLE key and a MEMBER key can never answer for each other', () => {
    expect(findChatByKey([ONLY_US], KEY_OF_GROUP, ACCOUNTS).reason).toBe('no-match');
    expect(findChatByKey([AS_SECONDARY, OTHER_CHAT], KEY_OF_ONLY_US, ACCOUNTS).reason).toBe('no-match');
  });

  // AN UNNAMED two-account group: Beeper synthesises the title out of the members, so the EAR asks
  // with the name IT sees and the mouth's own room carries the other one. No match is the correct
  // outcome (the reply falls back to the ear); a WRONG match is the thing that must not happen.
  it('an UNNAMED two-account group answers to nothing the other account asks for', () => {
    const unnamedOnMouth = { ...ONLY_US, id: '!unnamed:beeper.local', title: 'The Primary' };
    const askedWith = 'group,title:the-secondary';        // what the EAR derived from ITS own view
    expect(findChatByKey([unnamedOnMouth, OTHER_CHAT], askedWith, ACCOUNTS).reason).toBe('no-match');
  });
});

// ── 4a-bis. THE SAME MAPPING, BY WHAT WAS LAST SAID (operator 2026-09-12) ──────────────────────
//
// *"if there's Rodz, use it, always... primary is last and surest fallback"*. findChatByKey
// refuses the 1:1 between the two accounts and the unnamed two-account group ON PURPOSE, and the
// mouth is obviously in both — so the refusal cannot be where the search stops. What the two
// views still share is the CONVERSATION.
//
// THE FIXTURES ARE THE LIVE PAYLOAD, measured 2026-09-12 across both of the operator's installs'
// views of the same real chat. Three facts came out of that sweep and all three are asserted:
//   · one message's BODY is byte-identical on the two accounts (8 of the 9 most recent were)
//   · the two TIMESTAMPS agree to the second and differ inside it — each account keeps full
//     precision on what it sent and truncates what it received (…:05.086Z / …:05.000Z)
//   · the SAME message renders DIFFERENTLY per endpoint, so both sides must hand in `preview`
describe('findChatByLastMessage — which of MY chats last heard that, on its own', () => {
  // `preview` off the ASKING account's own /v1/chats item for the chat being replied in.
  const HEARD_ON_EAR = { id: '5391', text: 'Conectado y listo', timestamp: '2026-09-12T13:45:05.086Z' };
  // …and the mouth's own chat page. Only `id` and `preview` matter here: no roster is read.
  const chat = (id, text, timestamp) => ({ id, type: 'single', preview: text == null ? null : { id: `${id}-last`, text, timestamp } });
  const THE_SAME_CHAT = chat('!dm-on-the-mouth:beeper.local', 'Conectado y listo', '2026-09-12T13:45:05.000Z');
  const ANOTHER_CHAT = chat('!someone-else:beeper.local', 'nothing to do with it', '2026-09-12T13:40:00.000Z');

  it("finds the one chat and returns it in the MOUTH's own id namespace", () => {
    expect(findChatByLastMessage([ANOTHER_CHAT, THE_SAME_CHAT], HEARD_ON_EAR))
      .toEqual({ ok: true, chatId: 'dm-on-the-mouth' });
  });

  // THE MEASURED SUB-SECOND DIVERGENCE, asserted rather than assumed: the two copies of one
  // message are 86ms apart and must still be one message.
  it('the two views of one message differ inside the second and still match', () => {
    expect(THE_SAME_CHAT.preview.timestamp).not.toBe(HEARD_ON_EAR.timestamp);
    expect(findChatByLastMessage([THE_SAME_CHAT], HEARD_ON_EAR).ok).toBe(true);
  });

  // …and a DIFFERENT second is a different message. This is the guard that makes a short body
  // ("ok", ":)") safe to key a whole account on — 11 of the operator's 154 chats had a `preview`
  // byte-identical to another chat's.
  it('the same words at a different second are not the same message', () => {
    const later = chat('!dm-on-the-mouth:beeper.local', 'Conectado y listo', '2026-09-12T13:45:06.000Z');
    expect(findChatByLastMessage([later], HEARD_ON_EAR).reason).toBe('no-match');
  });

  it('no chat that heard it: no-match, and nothing is picked', () => {
    expect(findChatByLastMessage([ANOTHER_CHAT], HEARD_ON_EAR)).toEqual({
      ok: false, reason: 'no-match', detail: 'no chat on this account last heard that message',
    });
  });

  // TWO ROOMS ANSWERING ALIKE REFUSE, exactly as findChatByKey does. A reply in the wrong room is
  // the failure this whole path exists to prevent.
  it('two chats that last heard the same thing at the same second refuse rather than pick', () => {
    const twin = chat('!a-different-room:beeper.local', 'Conectado y listo', '2026-09-12T13:45:05.500Z');
    const out = findChatByLastMessage([THE_SAME_CHAT, twin], HEARD_ON_EAR);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('ambiguous');
    expect(out.detail).toContain('dm-on-the-mouth');
    expect(out.detail).toContain('a-different-room');
  });

  // The same chat listed twice (page one and the full walk both hold it) is ONE chat, not two.
  it('the same chat listed twice is one chat, not an ambiguity', () => {
    expect(findChatByLastMessage([THE_SAME_CHAT, { ...THE_SAME_CHAT }], HEARD_ON_EAR).ok).toBe(true);
  });

  // NOTHING TO KEY ON IS NOT A MATCH FOR EVERYTHING — the same refusal crossAccountChatKey makes.
  // A chat whose last message is a bare voice note identifies no room.
  it("nothing keyable in the asking account's own copy refuses outright", () => {
    expect(findChatByLastMessage([THE_SAME_CHAT], null).reason).toBe('no-key');
    expect(findChatByLastMessage([THE_SAME_CHAT], { id: '1', text: '', timestamp: '2026-09-12T13:45:05.000Z' }).reason).toBe('no-key');
    // …and a body with NO timestamp is no evidence either: the guard cannot run.
    expect(findChatByLastMessage([THE_SAME_CHAT], { id: '1', text: 'Conectado y listo' }).reason).toBe('no-key');
  });

  // A chat with no last message at all (the mouth's freshly-created room) is skipped, not matched.
  it('a chat carrying no preview is skipped', () => {
    expect(findChatByLastMessage([chat('!brand-new:beeper.local', null)], HEARD_ON_EAR).reason).toBe('no-match');
  });

  // THE TWO MEASURED DIVERGENCES, both of which must cost a MISS and never a wrong match — the
  // only direction a failure here may fall. A MENTION renders through each account's own id
  // namespace; a CODE BLOCK carried one trailing newline more on one account than the other.
  it('a body that renders per-account (a mention, a code block) simply misses', () => {
    const mention = chat('!same-room:beeper.local', '<a href="https://matrix.to/#/@dolly-egpt:beeper.com">Rodz</a> ping', '2026-09-12T13:39:43.000Z');
    const earSawMention = { id: '9', text: '<a href="https://matrix.to/#/@whatsapp_lid-69433129173200:beeper.local">Rodz</a> ping', timestamp: '2026-09-12T13:39:43.000Z' };
    expect(findChatByLastMessage([mention], earSawMention).reason).toBe('no-match');
    const fence = chat('!same-room:beeper.local', '```\nqwinsta\n```', '2026-09-07T21:41:46.460Z');
    const earSawFence = { id: '9', text: '```\nqwinsta\n\n```', timestamp: '2026-09-07T21:41:46.000Z' };
    expect(findChatByLastMessage([fence], earSawFence).reason).toBe('no-match');
  });

  // AND THE REASON BOTH SIDES HAND IN `preview`: the SAME message off /messages and off the chat
  // page are two different renderings. This is that measurement, kept where it will be noticed if
  // a future caller is tempted to feed a message list in.
  it('the same message off /messages and off the chat page do NOT key alike', () => {
    const fromMessages = { id: '3002', text: '<pre><code>\nqwinsta\n</code></pre>', timestamp: '2026-09-07T21:41:46.000Z' };
    const fromChatPage = { id: '3002', text: '```\nqwinsta\n```', timestamp: '2026-09-07T21:41:46.000Z' };
    expect(crossAccountMsgKey(fromMessages)).not.toBe(crossAccountMsgKey(fromChatPage));
  });

  it('a junk argument is a refusal, not a throw', () => {
    expect(findChatByLastMessage(null, HEARD_ON_EAR).reason).toBe('no-match');
    expect(findChatByLastMessage([THE_SAME_CHAT], undefined).reason).toBe('no-key');
  });
});

// ── 4b. THE SAME MAPPING ONE LEVEL DOWN, PURE ──────────────────────────────────────────────────
describe('findMessageByKey — which of MY messages is that one, on its own', () => {
  const LIST = [LATER_ON_SECONDARY, STEERED_ON_SECONDARY, EARLIER_ON_SECONDARY];

  it("finds the one message and returns it in the RECEIVER's own id namespace", () => {
    expect(findMessageByKey(LIST, STEERED_KEY, STEERED_TS)).toEqual({ ok: true, msgId: '1118' });
  });

  it('keys the two accounts\' views of ONE message alike — which is the whole point', () => {
    expect(crossAccountMsgKey(STEERED_ON_PRIMARY)).toBe(crossAccountMsgKey(STEERED_ON_SECONDARY));
    expect(crossAccountMsgKey(STEERED_ON_PRIMARY)).not.toBe(crossAccountMsgKey(EARLIER_ON_SECONDARY));
    // …and it is NOT the id, which is exactly the divergence it exists to route around.
    expect(STEERED_ON_PRIMARY.id).not.toBe(STEERED_ON_SECONDARY.id);
  });

  it('a body with NOTHING in it is not a key at all — a bare voice note cannot be named', () => {
    expect(crossAccountMsgKey({ id: '9', text: '' })).toBeNull();
    expect(crossAccountMsgKey({ id: '9', text: '   ' })).toBeNull();
    expect(crossAccountMsgKey({ id: '9' })).toBeNull();
    expect(crossAccountMsgKey(null)).toBeNull();
  });

  it('one message listed twice is one message, not an ambiguity', () => {
    expect(findMessageByKey([STEERED_ON_SECONDARY, { ...STEERED_ON_SECONDARY }], STEERED_KEY, STEERED_TS)).toEqual({ ok: true, msgId: '1118' });
  });

  it('refuses an empty key, an empty list and a list that holds no match', () => {
    expect(findMessageByKey(LIST, '', STEERED_TS)).toEqual({ ok: false, reason: 'no-key', detail: 'the frame carried no message key' });
    expect(findMessageByKey([], STEERED_KEY, STEERED_TS).reason).toBe('no-match');
    expect(findMessageByKey(null, STEERED_KEY, STEERED_TS).reason).toBe('no-match');
    expect(findMessageByKey([EARLIER_ON_SECONDARY], STEERED_KEY, STEERED_TS).reason).toBe('no-match');
  });

  it('the TIMESTAMP is a tie-break and not a filter: one match stands, several need it', () => {
    // One match, wrong timestamp → still the answer (the content already identified it).
    expect(findMessageByKey([STEERED_ON_SECONDARY], STEERED_KEY, 1)).toEqual({ ok: true, msgId: '1118' });
    // Two matches, one at that instant → that one.
    const older = { id: '1100', text: STEERED_TEXT, timestamp: '2026-09-07T10:00:00.000Z' };
    expect(findMessageByKey([older, STEERED_ON_SECONDARY], STEERED_KEY, STEERED_TS)).toEqual({ ok: true, msgId: '1118' });
    // Two matches, NEITHER at that instant → refuse. Never "the closest", never "the newest".
    expect(findMessageByKey([older, STEERED_ON_SECONDARY], STEERED_KEY, Date.parse('2026-09-07T12:00:00.000Z')).reason).toBe('ambiguous');
    // Two matches at the SAME instant → refuse.
    expect(findMessageByKey([{ ...STEERED_ON_SECONDARY, id: '1200' }, STEERED_ON_SECONDARY], STEERED_KEY, STEERED_TS).reason).toBe('ambiguous');
    // Two matches and no timestamp to break with → refuse.
    expect(findMessageByKey([older, STEERED_ON_SECONDARY], STEERED_KEY, 0).reason).toBe('ambiguous');
  });

  it('reads epoch ms and epoch seconds the same way the bridge does — one parse, not two', () => {
    const asMs = { id: '1118', text: STEERED_TEXT, timestamp: STEERED_TS };
    const asSecs = { id: '1119', text: STEERED_TEXT, timestamp: Math.floor(STEERED_TS / 1000) };
    expect(findMessageByKey([asMs, asSecs], STEERED_KEY, STEERED_TS).reason).toBe('ambiguous');   // both ARE at that instant
    expect(findMessageByKey([asMs, { ...EARLIER_ON_SECONDARY }], STEERED_KEY, STEERED_TS)).toEqual({ ok: true, msgId: '1118' });
  });

  it('a message with no id is skipped — there would be nothing to react to', () => {
    expect(findMessageByKey([{ text: STEERED_TEXT, timestamp: STEERED_TS_ISO }], STEERED_KEY, STEERED_TS).reason).toBe('no-match');
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
