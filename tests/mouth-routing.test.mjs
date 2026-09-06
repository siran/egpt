// mouth-routing.test.mjs — WHEN the peer spine says a reply, and what happens every time it
// cannot (operator 2026-09-05).
//
// THE ARRANGEMENT. One machine, two spines, one Beeper account each, one checkout, differing only
// by EGPT_HOME. The PRIMARY is the ear and the brain — it receives, logs, gates and runs the turn
// exactly as it always has — and when it wants to reply it hands the finished text over a loopback
// link and the SECONDARY says it on the other account. The TRANSPORT for that (the frames, the
// dial, the handshake, the cross-account chat mapping) shipped and is locked in
// tests/peer-mouth.test.mjs. THIS file locks the thing that was still missing: the WHEN.
//
// The decision lives in ONE place — src/spine/sender.mjs, THE reply path — and reads one fact:
// is the peer's account a participant of the chat being replied in? boot's makePeerMouth answers
// it (and hands back the raw chat payload the cross-account key is computed from); the sender acts
// on it. Everything here drives those two, with no socket, no Beeper and no network.
//
// THE TWO PROPERTIES, and they pull in opposite directions:
//
//   1. ADDITIVE. A node with no peer_spine must behave BYTE-IDENTICALLY — same placeholder, same
//      stream, same fallback, and nothing dialled. tests/single-account-node.test.mjs is the
//      baseline; the first describe here is its mouth-shaped corner.
//
//   2. FALL BACK, NEVER GO SILENT — the INVERSE of the fail-closed rule the mouth's own refusals
//      follow. Refusing to POST INTO A CHAT is fail-closed because a reply in the wrong chat is
//      public before anyone notices; refusing to REPLY AT ALL is not the same trade. So every
//      refusal the link can produce (unreachable, no-key, no-match, ambiguous, send-failed, a
//      handler that threw) must end with the reply posted on THIS node's own account and a loud
//      log line naming the reason. That is the bulk of this file.
import { describe, it, expect, afterAll, vi } from 'vitest';

// A PRIVATE profile for this file — egpt-home.mjs freezes EGPT_HOME at module load, so it must be
// set BEFORE the imports below; vi.hoisted is what does that. Private (not the suite's shared
// throwaway) because the boot cases at the end write state/spine.pid and heartbeats, and files
// running in parallel would race on them. Same shape as tests/single-account-node.test.mjs.
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-mouth-routing-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { createSender } from '../src/spine/sender.mjs';
import { boot, makePeerMouth } from '../src/spine/boot.mjs';
import { createMouthReceiver } from '../src/shell/peer-mouth.mjs';
import { crossAccountChatKey } from '../src/bridges/beeper.mjs';
import { LIVE_FRAME_MARK } from '../src/dispatch-line.mjs';

// ── FIXTURES ───────────────────────────────────────────────────────────────────────────────────
// The MEASURED shape (tests/cross-account-chat-key.test.mjs, tests/peer-mouth.test.mjs): every
// ordinary member carries a phoneNumber, the VIEWING account carries none at all (it is its matrix
// id with isSelf true), and each account sees the others through its OWN id namespace — so the two
// views below share no id of any kind. Roles only, never people.
const PRIMARY_NUM = '+15550000001';
const SECONDARY_NUM = '+15550000002';
const M1 = '+1 (555) 111-0001';
const M2 = '+15551110002';
const ACCOUNTS = [PRIMARY_NUM, SECONDARY_NUM];
const PEER = { consolePort: 23377, consoleToken: 'peer-shell-token', accounts: ACCOUNTS };

const member = (id, phoneNumber) => ({ id, phoneNumber, fullName: id });
const self = (id) => ({ id, isSelf: true });

// The chat the brain is replying in, as the PRIMARY account sees it.
const AS_PRIMARY = {
  id: '!6ljZJkx0OaY9ZVhEzFgi:beeper.local', title: 'Group', type: 'group',
  participants: { items: [self('@primary:beeper.com'), member('p-secondary', SECONDARY_NUM), member('p-m1', M1), member('p-m2', M2)] },
};
// The SAME real chat as the SECONDARY account sees it: different room id, different participant
// ids, different order. Only the phone numbers line up.
const AS_SECONDARY = {
  id: '!HuXFQeZSY1X4khNDWTzz:beeper.local', title: 'Group', type: 'group',
  participants: { items: [member('s-m2', M2), self('@secondary:beeper.com'), member('s-primary', PRIMARY_NUM), member('s-m1', M1)] },
};
const SECONDARY_CHAT_ID = 'HuXFQeZSY1X4khNDWTzz';   // what shortChatId makes of it
// A chat the peer's account is NOT in: the members and this account, nobody else.
const NO_PEER_CHAT = {
  id: '!solo:beeper.local', title: 'Solo', type: 'group',
  participants: { items: [self('@primary:beeper.com'), member('p-m1', M1), member('p-m2', M2)] },
};

const CHAT_ID = 'chat-1';

// Let the route settle. On a peer-configured node the local placeholder is opened LAZILY — the
// moment the membership answer says "local" — so a case that asserts about the placeholder before
// finish() has to let the promise chain drain first. A macrotask flushes every pending microtask,
// which is what "the route has settled" means here; the live path does not wait on anything else.
const settled = () => new Promise((r) => setTimeout(r, 0));

// The sender's bridge seam — the same fake tests/spine-sender.test.mjs uses, so "posted locally"
// means exactly what it means there: a `startStream` handle (the ⏳ placeholder edited in place)
// or a fresh `send`.
function fakeBridge() {
  const streams = [], sent = [];
  return {
    streams, sent,
    send(chat, text, opts) { sent.push({ chat, text, opts }); return { confirmedId: 'local-1' }; },
    startStream(chat, init, opts) {
      const h = {
        chat, init, opts, frames: [], finals: [], delivered: false,
        update(t) { h.frames.push(t); },
        async finish(t) { h.finals.push(t); h.delivered = true; },
      };
      streams.push(h); return h;
    },
  };
}

// The MOUTH seam at the sender's boundary: what boot's makePeerMouth hands createSender. `answer`
// is what the peer says back — `{ ok: true, chatId }` or one of the documented refusals.
function fakeMouth({ route = async () => AS_PRIMARY, answer = { ok: true, chatId: SECONDARY_CHAT_ID } } = {}) {
  const calls = { route: [], say: [] };
  return {
    calls,
    mouth: {
      async route(chatId) { calls.route.push(chatId); return route(chatId); },
      async say(chat, text) { calls.say.push({ chat, text }); return typeof answer === 'function' ? answer() : answer; },
    },
  };
}

// A sender wired the way boot wires the persona sender, with the mouth (or without one).
function senderWith(mouth) {
  const bridge = fakeBridge();
  const logs = [];
  const sender = createSender({ bridge, bodyEmojiOf: () => '🐶', peerMouth: mouth, onLog: (m) => logs.push(m) });
  return { bridge, logs, sender };
}

// ── 1. NO peer_spine: BYTE-IDENTICAL, AND NOTHING IS ASKED ─────────────────────────────────────
// First, because everything else is only allowed to exist if this holds.
describe('no peer_spine — the reply posts locally and no peer is ever consulted', () => {
  it('opens the placeholder EAGERLY, streams into it and settles it in place — the mouth is not in the path at all', async () => {
    const { bridge, sender } = senderWith(null);
    const out = sender.open(CHAT_ID, { being: 'e', replyTo: 'm1' });

    // The placeholder is up SYNCHRONOUSLY, before any await — no route to wait for.
    expect(bridge.streams).toHaveLength(1);
    expect(bridge.streams[0].init).toBe(`${LIVE_FRAME_MARK} Thinking…`);
    expect(bridge.streams[0].opts).toMatchObject({ replyTo: 'm1', bodyEmoji: '🐶', persona: 'e' });

    out.update('Hola');
    expect(bridge.streams[0].frames).toEqual([`Hola ${LIVE_FRAME_MARK}`]);
    await out.finish({ text: 'Hola mundo' });
    expect(bridge.streams[0].finals).toEqual(['Hola mundo']);
    expect(bridge.sent).toHaveLength(0);
  });

  it('builds NO mouth out of a config that declares no peer — so there is nothing to dial', () => {
    // makePeerMouth is boot's ONE constructor for the speaking half; a null peer must produce a
    // null mouth, which is what createSender is then handed (and what turns this whole feature
    // off). peerSpineFrom's own reading of an absent/unusable block is locked in
    // tests/peer-mouth.test.mjs and is not repeated here.
    expect(makePeerMouth({ peer: null, bridge: fakeBridge() })).toBeNull();
    expect(makePeerMouth({})).toBeNull();
  });
});

// ── 2. THE PEER'S ACCOUNT IS IN THE CHAT: it says it, and this account says NOTHING ─────────────
describe('peer configured and the peer account IS in the chat — the peer speaks, this node does not', () => {
  it('hands the FINISHED text to the peer and posts nothing here: no placeholder, no edit, no send', async () => {
    const { calls, mouth } = fakeMouth();
    const { bridge, sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e', replyTo: 'm1' });
    out.update('Hol');
    out.update('Hola mun');
    await out.finish({ text: 'Hola mundo' });

    expect(calls.route).toEqual([CHAT_ID]);
    expect(calls.say).toEqual([{ chat: AS_PRIMARY, text: 'Hola mundo' }]);   // the FINAL text, and the RAW chat the key comes from
    // NOTHING on this account — this is the whole point of the arrangement ("instead of writing
    // in its beeper"). Not a placeholder that streamed the answer and then had to be explained
    // away, not a duplicate: nothing.
    expect(bridge.streams).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
  });

  it('says so in the log, naming the peer\'s own chat id — which mouth spoke is never a guess', async () => {
    const { mouth } = fakeMouth();
    const { logs, sender } = senderWith(mouth);
    await sender.open(CHAT_ID, { being: 'e' }).finish({ text: 'done' });
    expect(logs.filter((l) => l.includes('the PEER said this reply') && l.includes(SECONDARY_CHAT_ID))).toHaveLength(1);
  });

  it('carries the reply VERBATIM — the peer is handed the bytes the brain settled on, nothing appended', async () => {
    const { calls, mouth } = fakeMouth();
    const { sender } = senderWith(mouth);
    const body = 'line one\n\nline two 🐶 {"say":"post"}';
    await sender.open(CHAT_ID, { being: 'e' }).finish({ text: body });
    expect(calls.say[0].text).toBe(body);
  });

  it('exposes NO confirmedId — the delivered message lives in the OTHER account\'s id namespace', async () => {
    const { mouth } = fakeMouth();
    const { sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e' });
    await out.finish({ text: 'done' });
    expect(out.confirmedId).toBeNull();
  });

  it('mode:auto is NEVER routed — an operator-impersonating reply stays on the operator\'s account', async () => {
    // The point of mode:auto is that the reply looks like the operator typed it. Saying it from
    // the second account would defeat exactly the thing the mode exists for.
    const { calls, mouth } = fakeMouth();
    const { bridge, sender } = senderWith(mouth);
    await sender.open(CHAT_ID, { being: 'e', auto: true }).finish({ text: 'sure, on my way' });
    expect(calls.route).toEqual([]);
    expect(calls.say).toEqual([]);
    expect(bridge.sent).toEqual([{ chat: CHAT_ID, text: 'sure, on my way', opts: { replyTo: null } }]);
  });

  it('a WITHHELD turn resolves on THIS account — the link carries replies, and a silence is not one', async () => {
    // The gate withheld the reply, so there is nothing to say through the peer; what is left is a
    // placeholder that must not be left stuck (operator 2026-08-24, "nothing is ever deleted").
    // It is this account's placeholder, so it is opened here and resolved here.
    const { calls, mouth } = fakeMouth();
    const { bridge, sender } = senderWith(mouth);
    await sender.open(CHAT_ID, { being: 'e' }).finish({ text: '...' }, { surface: false });
    expect(calls.say).toEqual([]);
    expect(bridge.streams).toHaveLength(1);
    expect(bridge.streams[0].finals).toEqual(['...']);
  });
});

// ── 3. THE PEER'S ACCOUNT IS NOT IN THE CHAT: unchanged, and nothing is dialled ─────────────────
describe('peer configured but the peer account is NOT in the chat — posts locally, no dial', () => {
  it('opens the ordinary placeholder, streams into it, settles it in place, and never calls say()', async () => {
    const { calls, mouth } = fakeMouth({ route: async () => null });
    const { bridge, sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e', replyTo: 'm1' });
    await settled();                              // the route is a promise; the placeholder opens the moment it says "local"

    expect(bridge.streams).toHaveLength(1);
    expect(bridge.streams[0].init).toBe(`${LIVE_FRAME_MARK} Thinking…`);
    expect(bridge.streams[0].opts).toMatchObject({ replyTo: 'm1', bodyEmoji: '🐶', persona: 'e' });
    out.update('Hola');
    expect(bridge.streams[0].frames).toEqual([`Hola ${LIVE_FRAME_MARK}`]);
    await out.finish({ text: 'Hola mundo' });
    expect(bridge.streams[0].finals).toEqual(['Hola mundo']);
    expect(bridge.sent).toHaveLength(0);
    expect(calls.say).toEqual([]);
  });

  it('a QUEUED reply still opens queued and still flips to the live train when its turn starts', async () => {
    // The placeholder's DISTINCT queued text is not cosmetic — the bridge resolves a placeholder's
    // id by matching identical text, so two coexisting "⏳ Thinking…" placeholders collapse onto
    // one id. Deferring the open must not lose that.
    const { mouth } = fakeMouth({ route: async () => null });
    const { bridge, sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e', queued: true, queuedAhead: 2 });
    await settled();
    expect(bridge.streams[0].init).toBe(`${LIVE_FRAME_MARK} Queued (2 ahead)…`);
    out.activate();
    expect(bridge.streams[0].frames).toEqual([`${LIVE_FRAME_MARK} Thinking…`]);
    await out.finish({ text: 'now' });
    expect(bridge.streams[0].finals).toEqual(['now']);
  });

  it('a turn that FAILS still ends its local message with ❌', async () => {
    const { mouth } = fakeMouth({ route: async () => null });
    const { bridge, sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e' });
    await settled();
    out.update('half a th');
    await out.fail();
    expect(bridge.streams[0].finals).toEqual(['half a th … ❌ Sending failed.']);
  });
});

// ── 4. EVERY FAILURE FALLS BACK TO A LOCAL POST, LOUDLY ────────────────────────────────────────
// The inverse of the fail-closed rule, stated once in code and locked once here: a reply that
// arrives from the wrong mouth is a cosmetic problem; a reply that never arrives is not.
describe('every peer failure falls back to a LOCAL post and says why', () => {
  // The documented refusals, exactly as src/shell/peer-mouth.mjs's header lists them.
  const REFUSALS = [
    ['unreachable', 'the peer did not answer within 10000ms'],
    ['no-key', 'crossAccountChatKey refused this chat'],
    ['no-match', 'no chat on this account keys to that participant set'],
    ['ambiguous', '2 chats key alike (a, b) — refusing to pick'],
    ['unavailable', 'the chat list could not be read'],
    ['send-failed', 'the post into X was not accepted'],
    ['bad-frame', 'the mouth link serves say:post only'],
  ];

  for (const [reason, detail] of REFUSALS) {
    it(`${reason}: the reply still goes out, on THIS account, and the log names the reason`, async () => {
      const { mouth } = fakeMouth({ answer: { ok: false, reason, detail } });
      const { bridge, logs, sender } = senderWith(mouth);
      const out = sender.open(CHAT_ID, { being: 'e', replyTo: 'm1' });
      await out.finish({ text: 'the answer' });

      // The reply ARRIVED. No local stream was ever opened (the route said "peer"), so it goes
      // out as one fresh post carrying the persona tag — the no-stream branch finish() has always
      // had, doing exactly what it has always done.
      expect(bridge.streams).toHaveLength(0);
      expect(bridge.sent).toHaveLength(1);
      expect(bridge.sent[0].chat).toBe(CHAT_ID);
      expect(bridge.sent[0].text).toBe('the answer');
      expect(bridge.sent[0].opts).toMatchObject({ replyTo: 'm1', bodyEmoji: '🐶' });

      // …and it is LOUD: one line, naming the reason and the detail.
      const line = logs.find((l) => l.startsWith('mouth: FALLING BACK TO THIS ACCOUNT'));
      expect(line, `no fallback log line for ${reason}`).toBeTruthy();
      expect(line).toContain(reason);
      expect(line).toContain(detail);
      expect(out.confirmedId).toBe('local-1');
    });
  }

  it('a say() that THROWS is a fallback too, never an escaped exception', async () => {
    const { mouth } = fakeMouth({ answer: () => { throw new Error('the wiring is wrong'); } });
    const { bridge, logs, sender } = senderWith(mouth);
    await sender.open(CHAT_ID, { being: 'e' }).finish({ text: 'the answer' });
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].text).toBe('the answer');
    expect(logs.some((l) => l.includes('FALLING BACK') && l.includes('the wiring is wrong'))).toBe(true);
  });

  it('a route() that THROWS posts locally the ordinary way — placeholder and all', async () => {
    const mouth = { async route() { throw new Error('roster read exploded'); }, async say() { throw new Error('never reached'); } };
    const { bridge, logs, sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e' });
    await out.finish({ text: 'the answer' });
    expect(bridge.streams).toHaveLength(1);
    expect(bridge.streams[0].finals).toEqual(['the answer']);
    expect(logs.some((l) => l.includes('could not decide the route'))).toBe(true);
  });

  it('THE STREAMED TEXT IS NOT LOST: what accumulated while the peer was being tried goes out whole', async () => {
    // Nothing was pushed to this account during the turn (the route said "peer"), but absorb()
    // has been running the entire time — so the fallback post carries the settled answer, and a
    // settled answer that DIVERGED from the narration still keeps the narration above the seam.
    const { mouth } = fakeMouth({ answer: { ok: false, reason: 'unreachable', detail: 'no answer' } });
    const { bridge, sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e' });
    out.update('thinking out loud');
    await out.finish({ text: 'the settled answer' });
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].text).toBe('thinking out loud\n\n— ↓ reply —\n\nthe settled answer');
  });

  it('a turn that FAILS on a peer-routed chat posts a VISIBLE ❌ here — a failure nobody sees is the one thing worse', async () => {
    const { mouth } = fakeMouth();
    const { bridge, sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e' });
    await out.fail();
    expect(bridge.streams).toHaveLength(0);
    expect(bridge.sent).toEqual([{ chat: CHAT_ID, text: '… ❌ Sending failed.', opts: expect.objectContaining({ bodyEmoji: '🐶' }) }]);
  });
});

// ── 5. THE ROUTING QUESTION ITSELF (boot.makePeerMouth) ────────────────────────────────────────
// "Is the peer's account in this chat?" — answered off the bridge's own roster cache, with the raw
// payload the cross-account key needs handed back on a yes.
describe('makePeerMouth — the membership question, and what each answer means', () => {
  function rig({ present = () => true, raw = AS_PRIMARY, owns = () => false } = {}) {
    const asked = [];
    const spoken = [];
    const logs = [];
    const bridge = {
      async chatHasParticipant(chatId, identity) { asked.push({ chatId, identity }); return present(identity, chatId); },
      async chatRaw(chatId) { return typeof raw === 'function' ? raw(chatId) : raw; },
    };
    const mouth = makePeerMouth({
      peer: PEER, bridge, owns,
      speak: async (o) => { spoken.push(o); return { ok: true, chatId: SECONDARY_CHAT_ID }; },
      onLog: (m) => logs.push(m),
    });
    return { mouth, asked, spoken, logs };
  }

  it('routes when one of the two configured identities is a participant — and hands back the RAW payload', async () => {
    // The peer's identity is not configured separately and does not need to be: it is whichever
    // of the two is IN THIS ACCOUNT'S ROSTER. This account's own entry carries no phone number at
    // all (measured), so its own identity can never match here.
    const { mouth, asked } = rig({ present: (id) => id === SECONDARY_NUM });
    expect(await mouth.route(CHAT_ID)).toBe(AS_PRIMARY);
    expect(asked.map((a) => a.identity)).toEqual([PRIMARY_NUM, SECONDARY_NUM]);   // asks in order, stops at the hit
  });

  it('stops at the FIRST identity that is present — it does not keep asking once it knows', async () => {
    const { mouth, asked } = rig({ present: () => true });
    expect(await mouth.route(CHAT_ID)).toBe(AS_PRIMARY);
    expect(asked).toHaveLength(1);
  });

  it('NEITHER identity present ⇒ no route: this node says it itself', async () => {
    const { mouth } = rig({ present: () => false });
    expect(await mouth.route(CHAT_ID)).toBeNull();
  });

  // THE DOCUMENTED DECISION on the third answer.
  it('UNKNOWN membership (null) is treated exactly like ABSENT — the reply is posted locally, nothing is dialled', async () => {
    // chatHasParticipant answers true | false | null, and null means the roster could not be read
    // (a failed GET, a payload with no roster). Routing on a guess would risk handing the line to
    // a peer that is not in the chat, which then finds no match and costs a round trip before
    // falling back anyway; posting locally is guaranteed to arrive. So null routes nowhere.
    const { mouth, spoken } = rig({ present: () => null });
    expect(await mouth.route(CHAT_ID)).toBeNull();
    expect(spoken).toEqual([]);
  });

  it('a roster read that THROWS routes nowhere and says so — never a lost reply', async () => {
    const logs = [];
    const mouth = makePeerMouth({
      peer: PEER,
      bridge: { async chatHasParticipant() { throw new Error('beeper down'); } },
      speak: async () => ({ ok: true }),
      onLog: (m) => logs.push(m),
    });
    expect(await mouth.route(CHAT_ID)).toBeNull();
    expect(logs.some((l) => l.includes('could not read the roster') && l.includes('beeper down'))).toBe(true);
  });

  it('present but UNREADABLE (no raw payload) routes nowhere — a chat that cannot be keyed is not routable', async () => {
    const { mouth, logs } = rig({ raw: null });
    expect(await mouth.route(CHAT_ID)).toBeNull();
    expect(logs.some((l) => l.includes('came back empty'))).toBe(true);
  });

  it('THE CONSOLE IS NEVER ROUTED — a shell/room chat id is not a Beeper chat, so Beeper is not asked', async () => {
    const { mouth, asked } = rig({ owns: (c) => c === 'acim' });
    expect(await mouth.route('acim')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('say() hands the peer block, the raw chat and the text straight to the transport', async () => {
    const { mouth, spoken } = rig();
    await mouth.say(AS_PRIMARY, 'the finished line');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ peer: PEER, chat: AS_PRIMARY, text: 'the finished line' });
  });
});

// ── 6. END TO END, THROUGH THE REAL PRIMITIVES ─────────────────────────────────────────────────
// The sender's decision, boot's routing question, the REAL crossAccountChatKey and the REAL
// receiver, composed. The only thing stubbed is the socket itself — the frames and the handshake
// that ride it are locked end to end in tests/peer-mouth.test.mjs.
describe('end to end: a reply in the primary\'s room is posted in the SECONDARY\'s room', () => {
  function twoSpines({ primaryChat = AS_PRIMARY, secondaryChats = [AS_SECONDARY] } = {}) {
    const posted = [];
    const logs = [];
    // The receiving spine, built exactly as boot builds it.
    const receiver = createMouthReceiver({
      listChats: async () => secondaryChats,
      post: async (chatId, text) => { posted.push({ chatId, text }); return { ok: true }; },
      accounts: ACCOUNTS,
      onLog: (m) => logs.push(`[secondary] ${m}`),
    });
    // The speaking spine. `speak` stands in for the wire and does exactly what it does: compute
    // the cross-account key from the chat the reply is in and hand it over.
    const mouth = makePeerMouth({
      peer: PEER,
      bridge: {
        async chatHasParticipant(_chatId, identity) { return crossAccountChatKey(primaryChat, []).includes(identity.replace(/\D/g, '')); },
        async chatRaw() { return primaryChat; },
      },
      speak: ({ peer, chat, text }) => receiver({ chatKey: crossAccountChatKey(chat, peer.accounts), text }),
      onLog: (m) => logs.push(`[primary] ${m}`),
    });
    const bridge = fakeBridge();
    const sender = createSender({ bridge, bodyEmojiOf: () => '🐶', peerMouth: mouth, onLog: (m) => logs.push(`[primary] ${m}`) });
    return { sender, bridge, posted, logs };
  }

  it('lands the finished line in the secondary\'s OWN chat id, and posts nothing on the primary', async () => {
    const { sender, bridge, posted } = twoSpines();
    await sender.open(CHAT_ID, { being: 'e', replyTo: 'm1' }).finish({ text: 'said by the other account' });
    expect(posted).toEqual([{ chatId: SECONDARY_CHAT_ID, text: 'said by the other account' }]);
    expect(bridge.streams).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
  });

  it('a chat the peer is NOT in never reaches the link at all', async () => {
    const { sender, bridge, posted } = twoSpines({ primaryChat: NO_PEER_CHAT });
    const out = sender.open(CHAT_ID, { being: 'e' });
    await out.finish({ text: 'said here' });
    expect(posted).toEqual([]);
    expect(bridge.streams).toHaveLength(1);
    expect(bridge.streams[0].finals).toEqual(['said here']);
  });

  it('the receiver finding NO chat of its own puts the reply back on the primary, not nowhere', async () => {
    const { sender, bridge, posted, logs } = twoSpines({ secondaryChats: [] });
    await sender.open(CHAT_ID, { being: 'e' }).finish({ text: 'said here after all' });
    expect(posted).toEqual([]);
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].text).toBe('said here after all');
    expect(logs.some((l) => l.includes('FALLING BACK') && l.includes('no-match'))).toBe(true);
  });

  it('the receiver finding TWO chats that key alike puts it back on the primary too — it never picks', async () => {
    const twin = { ...AS_SECONDARY, id: '!twin:beeper.local' };
    const { sender, bridge, posted, logs } = twoSpines({ secondaryChats: [AS_SECONDARY, twin] });
    await sender.open(CHAT_ID, { being: 'e' }).finish({ text: 'said here after all' });
    expect(posted).toEqual([]);
    expect(bridge.sent[0].text).toBe('said here after all');
    expect(logs.some((l) => l.includes('FALLING BACK') && l.includes('ambiguous'))).toBe(true);
  });
});

// ── 7. BOOT WIRES BOTH HALVES, OR NEITHER ──────────────────────────────────────────────────────
// The real boot(), on the smallest config that works, with and without the block. Everything is
// injected (in-memory fs, fake transport, fake sessions, ingest off) — no socket is opened and no
// port is bound, which is also why the SPEAKING half is only asked its routing question here and
// never asked to dial.
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

// Complete in-memory fs seam — the same shape tests/single-account-node.test.mjs uses.
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

// The transport seam, carrying the two roster readers the mouth asks it for. A node that never
// routes never calls them; a node that does must reach THIS bridge through boot's wiring, which is
// what the route assertion below actually proves.
function fakeTransport() {
  const start = async () => ({
    async send() { return { ok: true }; },
    startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; },
    async chatHasParticipant(_chatId, identity) { return identity === SECONDARY_NUM; },
    async chatRaw() { return AS_PRIMARY; },
    async listChatsRaw() { return [AS_SECONDARY]; },
    isAlive: () => true, stop() {},
  });
  return { start };
}

const NODE = () => ({
  node_name: 'primary', user_name: 'John',
  beeper: { use: 'main', main: { account: 'you@example.com', token: 'TOK-mouth' } },
  agents: { egpt: { configuration: 'egpt', name: 'egpt', handles: ['e', 'egpt'], default: true } },
  shell: { token: 'this-node-shell-token', port: 23375 },
});

async function bootWith(config) {
  const lines = [];
  let convState = null;
  const app = await boot({
    readConfig: () => config,
    startBridge: fakeTransport().start,
    makeSession: (o) => ({ sessionId: o.sessionId ?? 's1', async turn() { return { text: '' }; }, close() {} }),
    loadState: async () => convState ?? (convState = { contacts: {} }),
    writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0,
    now: () => Date.UTC(2026, 8, 5, 14, 5),
    log: { line: (s) => lines.push(s) },
  });
  return { app, lines };
}

describe('boot — a node with no peer_spine builds neither half, and one with it builds both', () => {
  it('ABSENT: no mouth on the reply path, no receiver offered, and not a word about it', async () => {
    const { app, lines } = await bootWith(NODE());
    expect(app.peerMouth).toBeNull();
    expect(lines.filter((l) => l.startsWith('[mouth]'))).toEqual([]);
    app.stop();
  });

  it('PRESENT: the reply path gets a mouth wired to THIS node\'s bridge, and the console offers the receiver', async () => {
    const { app, lines } = await bootWith({
      ...NODE(),
      peer_spine: { console_port: 23377, console_token: 'peer-shell-token', accounts: ACCOUNTS },
    });

    // THE SPEAKING HALF, and that it is wired to the real bridge rather than to nothing: asked
    // about a chat, it goes to the bridge's roster reader and comes back with the RAW payload the
    // cross-account key is computed from. No socket is touched — routing is a read.
    expect(app.peerMouth).toBeTruthy();
    expect(await app.peerMouth.route('!room:beeper.com')).toBe(AS_PRIMARY);

    // THE RECEIVING HALF is constructed on the same condition and handed to the console limb as
    // its peer handler; this is the line boot logs when it is (and the limb refuses a /peer dial
    // outright without one — tests/peer-mouth.test.mjs).
    expect(lines.filter((l) => /^\[mouth\] offering the mouth link/.test(l) && l.includes('23377'))).toHaveLength(1);

    // …and the two bridge methods that receiver will call exist on what boot handed it. A typo
    // here would be silently undefined until a peer actually dialled, which is the worst possible
    // moment to find out.
    expect(typeof app.bridge.listChatsRaw).toBe('function');
    expect(typeof app.bridge.postVerbatim).toBe('function');

    app.stop();
  });
});
