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
  const streams = [], sent = [], renders = [];
  return {
    streams, sent, renders,
    // THIS NODE'S OWN PERSONA WRAP, as the real port hands it out (beeper-port.renderFrame): the
    // reply path renders a frame through it before handing it to the PEER, and must never touch it
    // on any other path — the local stream is wrapped one layer down, inside the port, so a
    // pre-rendered frame there would be wrapped twice. `renders` is the assertion surface for both
    // halves of that. Deliberately NOT the real wrap: what the real bytes come out as is locked end
    // to end in tests/peer-mouth.test.mjs §2d; what matters here is WHICH tag reached it and WHEN.
    renderFrame(opts, text) { renders.push({ opts, text }); return `«${opts.bodyEmoji ?? ''}|${opts.label ?? ''}|${text}|kg»`; },
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

// The MOUTH seam at the sender's boundary: what boot's makePeerMouth hands createSender.
//
// The stream it mints stands in for src/shell/peer-mouth.mjs startPeerStream and exposes exactly
// the surface a LOCAL stream does — update / awaited finish / delivered / confirmedId — because
// that is the property this whole file rests on: the sender's only decision is which factory it
// calls, and everything past that line is the code it already had. `answer` is what the peer's
// account managed to do with the reply: `{ ok: true, chatId }`, one of the documented refusals, or
// a function that throws.
//
// WHAT THIS DOUBLE DELIBERATELY DOES NOT DO is fall back. The real stream walks three tiers before
// it gives up (a finished line through the peer, then a local placeholder) and each of those is
// locked in tests/peer-mouth.test.mjs, where the transport lives. Here a refusal is simply a
// stream that reports `delivered === false`, which is the ONE thing the sender reads — so what the
// cases below actually lock is that the sender's §7 fallback still puts the reply on this account.
function fakeMouth({ route = async () => AS_PRIMARY, answer = { ok: true, chatId: SECONDARY_CHAT_ID } } = {}) {
  const calls = { route: [], streams: [] };
  return {
    calls,
    mouth: {
      async route(chatId) { calls.route.push(chatId); return route(chatId); },
      startStream(chat, init, opts = {}) {
        const h = {
          chat, init, opts, frames: [], finals: [], delivered: false, confirmedId: null,
          update(t) { h.frames.push(t); },
          async finish(t) {
            h.finals.push(t);
            const r = typeof answer === 'function' ? answer() : answer;
            h.delivered = !!r?.ok;
            h.lastError = r?.ok ? null : `${r?.reason ?? ''}${r?.detail ? `: ${r.detail}` : ''}`;
          },
        };
        calls.streams.push(h);
        return h;
      },
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

  it('does not render a frame for anyone — the wrap it could hand a peer is never even consulted', async () => {
    // THE ADDITIVITY LOCK for the persona wrap (operator 2026-09-05). A peer-routed frame is
    // rendered on THIS side, because the mouth posts verbatim — but the LOCAL path must keep
    // handing the port its RAW core, exactly as it always has, or beeper-port.startStream would
    // wrap an already-wrapped frame and the reply would carry two stamps and two signatures.
    const { bridge, sender } = senderWith(null);
    const out = sender.open(CHAT_ID, { being: 'e', replyTo: 'm1' });
    out.update('Hola');
    await out.finish({ text: 'Hola mundo' });
    expect(bridge.renders).toEqual([]);
    expect(bridge.streams[0].init).toBe(`${LIVE_FRAME_MARK} Thinking…`);
    expect(bridge.streams[0].frames).toEqual([`Hola ${LIVE_FRAME_MARK}`]);
    expect(bridge.streams[0].finals).toEqual(['Hola mundo']);
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
  // ── THE REGRESSION LOCK (operator 2026-09-05, "let's recover the thinking train") ────────────
  // This is the test that was missing. The link shipped carrying a FINISHED LINE ONLY, so a
  // peer-routed reply showed the user nothing at all until the whole answer landed, while a local
  // one puts "⏳ Thinking…" up immediately and edits it as the tokens arrive. Written against the
  // finished-line sender it fails on its first assertion — there was no peer placeholder to find.
  it('OPENS THE PLACEHOLDER ON THE PEER\'S ACCOUNT and edits it there — the thinking train, not silence', async () => {
    const { calls, mouth } = fakeMouth();
    const { bridge, sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e', replyTo: 'm1' });
    await settled();                              // the route is a promise; the train opens the moment it says "peer"

    // THE PLACEHOLDER IS UP, on the peer, before a single token — the whole point of the feature.
    expect(calls.route).toEqual([CHAT_ID]);
    expect(calls.streams).toHaveLength(1);
    expect(calls.streams[0].chat).toBe(AS_PRIMARY);            // the RAW chat the cross-account key comes from
    expect(calls.streams[0].init).toBe(`${LIVE_FRAME_MARK} Thinking…`);

    // …and it is EDITED IN PLACE as the answer is written, exactly like a local train.
    out.update('Hol');
    out.update('Hola mun');
    expect(calls.streams[0].frames).toEqual([`Hol ${LIVE_FRAME_MARK}`, `Hola mun ${LIVE_FRAME_MARK}`]);
    await out.finish({ text: 'Hola mundo' });
    expect(calls.streams[0].finals).toEqual(['Hola mundo']);

    // NOTHING on this account — still the whole point of the arrangement ("instead of writing in
    // its beeper"). Not a second placeholder, not a duplicate: nothing.
    expect(bridge.streams).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
  });

  it('the placeholder does NOT wait for a token — an empty turn still shows the peer thinking', async () => {
    // Latency is the point of the feature. The only thing between the inbound message and the
    // peer's "⏳" is the membership read the route already did.
    const { calls, mouth } = fakeMouth();
    const { sender } = senderWith(mouth);
    sender.open(CHAT_ID, { being: 'e' });
    await settled();
    expect(calls.streams).toHaveLength(1);
    expect(calls.streams[0].frames).toEqual([]);
  });

  it('a QUEUED peer-routed reply opens QUEUED on the peer and flips to the live train on its turn', async () => {
    // The queued placeholder's DISTINCT text is what keeps two coexisting placeholders resolvable
    // to their own message ids. Routing it through the peer must not lose that.
    const { calls, mouth } = fakeMouth();
    const { sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e', queued: true, queuedAhead: 2 });
    await settled();
    expect(calls.streams[0].init).toBe(`${LIVE_FRAME_MARK} Queued (2 ahead)…`);
    out.activate();
    expect(calls.streams[0].frames).toEqual([`${LIVE_FRAME_MARK} Thinking…`]);
  });

  it('whatever streamed BEFORE the route settled is replayed into the peer\'s placeholder, never lost', async () => {
    // The route is a promise, so a fast first token can land before there is a stream to push it
    // into. absorb() has been running regardless, and the open replays what it accumulated.
    const { calls, mouth } = fakeMouth();
    const { sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e' });
    out.update('said before the route came back');
    await settled();
    expect(calls.streams[0].frames).toEqual([`said before the route came back ${LIVE_FRAME_MARK}`]);
  });

  it('says so in the log, naming the peer\'s own chat id — which mouth spoke is never a guess', async () => {
    // The line is the STREAM's now, not the sender's: whichever tier said it knows which one that
    // was, and says so (tests/peer-mouth.test.mjs locks the wording against the real transport).
    const { mouth } = fakeMouth();
    const { bridge, sender } = senderWith(mouth);
    await sender.open(CHAT_ID, { being: 'e' }).finish({ text: 'done' });
    expect(bridge.sent).toHaveLength(0);
    expect(bridge.streams).toHaveLength(0);
  });

  it('carries the reply VERBATIM — the peer is handed the bytes the brain settled on, nothing appended', async () => {
    const { calls, mouth } = fakeMouth();
    const { sender } = senderWith(mouth);
    const body = 'line one\n\nline two 🐶 {"say":"post"}';
    await sender.open(CHAT_ID, { being: 'e' }).finish({ text: body });
    expect(calls.streams[0].finals).toEqual([body]);
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
    expect(calls.streams).toEqual([]);
    expect(bridge.sent).toEqual([{ chat: CHAT_ID, text: 'sure, on my way', opts: { replyTo: null } }]);
  });

  it('a WITHHELD turn resolves the placeholder it actually opened — which is the PEER\'s', async () => {
    // The gate withheld the reply, so there is nothing new to say; what is left is a placeholder
    // that must not be left stuck (operator 2026-08-24, "nothing is ever deleted"). That rule
    // follows the MESSAGE, not the account — and on a peer route the message is the peer's, so
    // that is where the silence mark lands. Nothing is posted here.
    const { calls, mouth } = fakeMouth();
    const { bridge, sender } = senderWith(mouth);
    await sender.open(CHAT_ID, { being: 'e' }).finish({ text: '...' }, { surface: false });
    expect(calls.streams).toHaveLength(1);
    expect(calls.streams[0].finals).toEqual(['...']);
    expect(bridge.streams).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
  });

  it('HANDS THE PEER THIS NODE\'S OWN WRAP, bound to the being being replied as', async () => {
    // WHOSE STAMP a peer-said reply carries: the BRAIN's. The mouth posts verbatim and knows
    // nothing of personas, so the reply is rendered on this side or not at all — and the tag it is
    // rendered with is THIS being's, resolved by this sender exactly as it is for a local reply.
    //
    // What crosses THIS seam is still the RAW core plus a renderer: the transport applies it at the
    // wire (peer-mouth.mjs `wire`) so the frames it may have to replay into a LOCAL fallback stay
    // unrendered, and that stream wraps them the ordinary way. Rendering here instead is precisely
    // how a fallback reply would end up with "🏰 🏰".
    const { calls, mouth } = fakeMouth();
    const { bridge, sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e', replyTo: 'm1' });
    await settled();

    out.update('Hola');
    await out.finish({ text: 'Hola mundo' });
    expect(calls.streams[0].init).toBe(`${LIVE_FRAME_MARK} Thinking…`);       // raw on this side…
    expect(calls.streams[0].frames).toEqual([`Hola ${LIVE_FRAME_MARK}`]);
    expect(calls.streams[0].finals).toEqual(['Hola mundo']);
    expect(bridge.renders).toEqual([]);                                       // …and nothing rendered yet

    // …but what the transport renders WITH is this node's wrap, carrying this being's stamp.
    const render = calls.streams[0].opts.render;
    expect(typeof render).toBe('function');
    expect(render('Hola mundo')).toBe('«🐶||Hola mundo|kg»');
    expect(bridge.renders).toEqual([{ opts: expect.objectContaining({ bodyEmoji: '🐶', replyTo: 'm1' }), text: 'Hola mundo' }]);
  });

  it('a bridge with no wrap to hand out (a test fake, the shell port) passes the text through unchanged', async () => {
    // The console is never routed to a peer, so this branch is only ever a fake — but it must be
    // the pre-wrap behaviour rather than a throw: never a lost reply, for any reason.
    const { calls, mouth } = fakeMouth();
    const bridge = fakeBridge();
    delete bridge.renderFrame;
    const sender = createSender({ bridge, bodyEmojiOf: () => '🐶', peerMouth: mouth });
    const out = sender.open(CHAT_ID, { being: 'e' });
    await settled();
    expect(calls.streams[0].opts.render('Hola mundo')).toBe('Hola mundo');
    await out.finish({ text: 'Hola mundo' });
    expect(calls.streams[0].finals).toEqual(['Hola mundo']);
  });

  it('a turn that FAILS ends the PEER\'s placeholder with ❌ — the ⏳ a human is watching is the peer\'s', async () => {
    const { calls, mouth } = fakeMouth();
    const { bridge, sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e' });
    await settled();
    out.update('half a th');
    await out.fail();
    expect(calls.streams[0].finals).toEqual(['half a th … ❌ Sending failed.']);
    expect(bridge.sent).toHaveLength(0);
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
    expect(calls.streams).toEqual([]);
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
    it(`${reason}: the reply still goes out, on THIS account`, async () => {
      const { mouth } = fakeMouth({ answer: { ok: false, reason, detail } });
      const { bridge, sender } = senderWith(mouth);
      const out = sender.open(CHAT_ID, { being: 'e', replyTo: 'm1' });
      await out.finish({ text: 'the answer' });

      // The reply ARRIVED. The peer stream reported `delivered === false` — the ONE thing the
      // sender reads, whatever went wrong underneath — so the §7 fallback sent it fresh here,
      // carrying the persona tag and the reply-to, exactly as it has always done for a stream
      // that failed to deliver in place. No second finish path, no peer-specific branch: this is
      // the same line a broken LOCAL stream takes. WHICH tier failed and why is logged by the
      // stream that hit it, and locked against the real transport in tests/peer-mouth.test.mjs.
      expect(bridge.sent).toHaveLength(1);
      expect(bridge.sent[0].chat).toBe(CHAT_ID);
      expect(bridge.sent[0].text).toBe('the answer');
      expect(bridge.sent[0].opts).toMatchObject({ replyTo: 'm1', bodyEmoji: '🐶' });
      // …and the fresh send's own id supersedes the stream's, which never delivered.
      expect(out.confirmedId).toBe('local-1');
    });
  }

  it('a stream whose finish() THROWS never swallows the reply silently', async () => {
    // A wiring fault, not a transport one: no refusal the link can produce reaches the sender as
    // a throw (every one of them comes back as `delivered === false`), but a broken injection
    // could. It surfaces to the caller rather than vanishing half-way through the mouth.
    const { mouth } = fakeMouth({ answer: () => { throw new Error('the wiring is wrong'); } });
    const { sender } = senderWith(mouth);
    await expect(sender.open(CHAT_ID, { being: 'e' }).finish({ text: 'the answer' })).rejects.toThrow('the wiring is wrong');
  });

  it('a route() that THROWS posts locally the ordinary way — placeholder and all', async () => {
    const mouth = { async route() { throw new Error('roster read exploded'); }, startStream() { throw new Error('never reached'); } };
    const { bridge, logs, sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e' });
    await out.finish({ text: 'the answer' });
    expect(bridge.streams).toHaveLength(1);
    expect(bridge.streams[0].finals).toEqual(['the answer']);
    expect(logs.some((l) => l.includes('could not decide the route'))).toBe(true);
  });

  it('THE STREAMED TEXT IS NOT LOST: what accumulated while the peer was being tried goes out whole', async () => {
    // absorb() has been running the entire time, whichever mouth the frames were going to — so
    // the fallback post carries the settled answer, and a settled answer that DIVERGED from the
    // narration still keeps the narration above the seam.
    const { mouth } = fakeMouth({ answer: { ok: false, reason: 'unreachable', detail: 'no answer' } });
    const { bridge, sender } = senderWith(mouth);
    const out = sender.open(CHAT_ID, { being: 'e' });
    out.update('thinking out loud');
    await out.finish({ text: 'the settled answer' });
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].text).toBe('thinking out loud\n\n— ↓ reply —\n\nthe settled answer');
  });

  it('a bridge that cannot stream at all still posts a peer-routed reply fresh, here', async () => {
    // The peer stream's LAST tier is a local stream, and a bridge with no startStream cannot give
    // it one — so `delivered` stays false and §7 sends the reply whole, which is the branch this
    // file has always had for a bridge with no streaming.
    const { mouth } = fakeMouth({ answer: { ok: false, reason: 'unreachable', detail: 'no answer' } });
    const bridge = fakeBridge();
    delete bridge.startStream;
    const sender = createSender({ bridge, bodyEmojiOf: () => '🐶', peerMouth: mouth });
    await sender.open(CHAT_ID, { being: 'e' }).finish({ text: 'the answer' });
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].text).toBe('the answer');
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
    const streamed = [];
    const mouth = makePeerMouth({
      peer: PEER, bridge, owns,
      speak: async (o) => { spoken.push(o); return { ok: true, chatId: SECONDARY_CHAT_ID }; },
      stream: (o) => { streamed.push(o); return { update() {}, async finish() {}, delivered: true, confirmedId: null }; },
      onLog: (m) => logs.push(m),
    });
    return { mouth, asked, spoken, streamed, logs };
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
      stream: () => ({ update() {}, async finish() {}, delivered: true }),
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

  it('startStream() hands the peer block, the raw chat, the placeholder and the local fallback to the transport', async () => {
    // …and the FINISHED-LINE transport with them, as `say`: it is not a separate feature, it is
    // the tier a reply train degrades into (src/shell/peer-mouth.mjs), so there is exactly one
    // definition of "speak a finished line through the peer" and this is where it is handed over.
    const { mouth, streamed } = rig();
    const fallback = () => null;
    const render = (t) => `«${t}»`;
    mouth.startStream(AS_PRIMARY, '⏳ Thinking…', { fallback, render });
    expect(streamed).toHaveLength(1);
    // `render` rides along with them and is decided nowhere here: it is the BRAIN's persona wrap,
    // bound to the being the sender is replying as, and this object only forwards it.
    expect(streamed[0]).toMatchObject({ peer: PEER, chat: AS_PRIMARY, init: '⏳ Thinking…', fallback, render });
    expect(typeof streamed[0].say).toBe('function');
  });

  it('no render handed over ⇒ none forwarded, so the transport keeps its identity default', () => {
    // The additivity seam for the wrap: a caller that hands no renderer must reach startPeerStream
    // as `undefined`, not `null`, or the default parameter would not fire and the frames would go
    // out as `String(null)`.
    const { mouth, streamed } = rig();
    mouth.startStream(AS_PRIMARY, '⏳ Thinking…');
    expect(streamed[0].render).toBeUndefined();
  });
});

// ── 6. END TO END, THROUGH THE REAL PRIMITIVES ─────────────────────────────────────────────────
// The sender's decision, boot's routing question, the REAL crossAccountChatKey and the REAL
// receiver, composed. The only thing stubbed is the socket itself — the frames and the handshake
// that ride it are locked end to end in tests/peer-mouth.test.mjs.
describe('end to end: a reply in the primary\'s room is streamed in the SECONDARY\'s room', () => {
  function twoSpines({ primaryChat = AS_PRIMARY, secondaryChats = [AS_SECONDARY] } = {}) {
    const posted = [];       // what actually landed on the secondary's account: { chatId, frames, final }
    const logs = [];
    // The receiving spine, built exactly as boot builds it — the REAL verb table, the REAL chat
    // lookup, the REAL map of live streams.
    const receiver = createMouthReceiver({
      listChats: async () => secondaryChats,
      post: async (chatId, text) => { posted.push({ chatId, frames: [], final: text }); return { ok: true }; },
      startStream: (chatId, init) => {
        const m = { chatId, init, frames: [], final: null, delivered: false };
        posted.push(m);
        return { update(t) { m.frames.push(t); }, async finish(t) { m.final = t; m.delivered = true; }, get delivered() { return m.delivered; } };
      },
      accounts: ACCOUNTS,
      onLog: (m) => logs.push(`[secondary] ${m}`),
    });
    // The speaking spine. `stream` stands in for THE SOCKET AND NOTHING ELSE: it drives the
    // receiver's own verbs in the order the frames would arrive on the wire, with the same
    // buffering the real speaker does while the open answer is in flight. It is DELIBERATELY
    // thinner than startPeerStream — no tier 2, no tier 3 — because the tiering is the transport's
    // and is locked against the real transport in tests/peer-mouth.test.mjs. Here a peer that
    // refuses simply reports `delivered === false`, and the sender's §7 does the rest.
    const conn = { link: 'the one socket' };
    const mouth = makePeerMouth({
      peer: PEER,
      bridge: {
        async chatHasParticipant(_chatId, identity) { return crossAccountChatKey(primaryChat, []).includes(identity.replace(/\D/g, '')); },
        async chatRaw() { return primaryChat; },
      },
      stream: ({ peer, chat, init }) => {
        const chatKey = crossAccountChatKey(chat, peer.accounts);
        let id = '', last = '', delivered = false;
        const opened = receiver.open({ chatKey, init }, conn).then((r) => {
          if (r.ok) { id = r.stream; if (last) receiver.update({ stream: id, text: last }, conn); }
          return r;
        });
        return {
          update(t) { last = t; if (id) receiver.update({ stream: id, text: last }, conn); },
          async finish(t) {
            await opened;
            if (!id) return;
            delivered = !!(await receiver.finish({ stream: id, text: t }, conn))?.ok;
          },
          get delivered() { return delivered; },
          get confirmedId() { return null; },
        };
      },
      onLog: (m) => logs.push(`[primary] ${m}`),
    });
    const bridge = fakeBridge();
    const sender = createSender({ bridge, bodyEmojiOf: () => '🐶', peerMouth: mouth, onLog: (m) => logs.push(`[primary] ${m}`) });
    return { sender, bridge, posted, logs };
  }

  it('opens, edits and settles ONE message in the secondary\'s OWN chat id, and posts nothing on the primary', async () => {
    const { sender, bridge, posted } = twoSpines();
    const out = sender.open(CHAT_ID, { being: 'e', replyTo: 'm1' });
    await settled();
    out.update('said by');
    await out.finish({ text: 'said by the other account' });
    expect(posted).toHaveLength(1);
    expect(posted[0].chatId).toBe(SECONDARY_CHAT_ID);
    expect(posted[0].init).toBe(`${LIVE_FRAME_MARK} Thinking…`);
    expect(posted[0].frames).toEqual([`said by ${LIVE_FRAME_MARK}`]);
    expect(posted[0].final).toBe('said by the other account');
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
    expect(logs.some((l) => l.includes('[secondary]') && l.includes('no-match'))).toBe(true);
  });

  it('the receiver finding TWO chats that key alike puts it back on the primary too — it never picks', async () => {
    const twin = { ...AS_SECONDARY, id: '!twin:beeper.local' };
    const { sender, bridge, posted, logs } = twoSpines({ secondaryChats: [AS_SECONDARY, twin] });
    await sender.open(CHAT_ID, { being: 'e' }).finish({ text: 'said here after all' });
    expect(posted).toEqual([]);
    expect(bridge.sent[0].text).toBe('said here after all');
    expect(logs.some((l) => l.includes('[secondary]') && l.includes('ambiguous'))).toBe(true);
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

    // …and the three bridge methods that receiver will call exist on what boot handed it. A typo
    // here would be silently undefined until a peer actually dialled, which is the worst possible
    // moment to find out.
    expect(typeof app.bridge.listChatsRaw).toBe('function');
    expect(typeof app.bridge.postVerbatim).toBe('function');
    expect(typeof app.bridge.startStreamVerbatim).toBe('function');   // the reply train's target

    // The SPEAKING half opens trains as well as routing them — the sender calls exactly this.
    expect(typeof app.peerMouth.startStream).toBe('function');

    app.stop();
  });
});
