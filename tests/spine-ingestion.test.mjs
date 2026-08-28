// ONE INGESTION PATH (operator 2026-07-25: "an agent only replies when prompted. it is the
// bridge that adds each message to the transcript when the spine receives it, not when it
// prompts the model" / "there must only be one path for message ingestion, digestion and
// dispatching").
//
// These run the REAL transcript service over an in-memory fs, so they assert the BYTES in
// transcript.md — the record itself, not a fake's call log. What they pin:
//   1. a message addressed to TWO local agents is recorded ONCE, and BOTH reply lines land
//      AFTER it (the inbound is written at arrival, so a fast second agent can no longer
//      answer above the message it is answering);
//   2. a turn that FAILS after its message was recorded does not record it twice;
//   3. the auto-dwell burst still records each line exactly once, in arrival order, and the
//      fired turn still prompts with the whole combined burst.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createTranscript } from '../src/spine/transcript.mjs';

// --- an in-memory fs for the real transcript service (same harness shape as
//     tests/spine-transcript.test.mjs: the stats collector needs readFile/writeFile/readdir
//     virtualized over the SAME map, else it falls through to the real fs). ---
const readdirOver = (files) => async (dir) => {
  const norm = (p) => String(p).replace(/\\/g, '/');
  const prefix = norm(dir).replace(/\/$/, '') + '/';
  const out = new Set();
  for (const k of files.keys()) {
    const nk = norm(k);
    if (nk.startsWith(prefix)) { const rest = nk.slice(prefix.length); if (!rest.includes('/')) out.add(rest); }
  }
  return [...out];
};
const memIo = (files) => ({
  appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); },
  mkdir: async () => {},
  existsSync: (p) => files.has(p),
  readFile: async (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
  writeFile: async (p, d) => { files.set(p, d); },
  readdir: readdirOver(files),
});
const transcriptText = (files) => [...files.entries()].find(([p]) => p.endsWith('transcript.md'))?.[1] ?? '';
const fakeContacts = { resolve: async () => 'fam-1' };

const fakeIdentity = { build: (m) => ({ ...m, line: `${m.senderName}@[${m.chatName}] #${m.msgId}: ${m.body}` }) };
function fakeBridge() {
  let cb = null;
  return { sent: [], onMessage(fn) { cb = fn; }, emit(m) { return cb(m); }, send(chat, text) { this.sent.push({ chat, text }); }, stop() {} };
}
function fakeSender(bridge) {
  return { open(chatId) {
    return { activate() {}, update() {}, async fail() {},
      async finish(reply, { surface = true } = {}) { const t = typeof reply === 'string' ? reply : reply?.text; if (surface && t) bridge.send(chatId, t); } };
  } };
}
const heartbeats = { runDue() {} };
const MSG = { surface: 'whatsapp', node: 'wa', chatId: '!room:beeper.com', chatName: 'fam', senderId: 'u-1', senderName: 'An', msgId: 'm1', ts: Date.UTC(2026, 6, 25, 12, 0), body: 'hola', kind: 'text', raw: {} };

// Where each line sits in transcript.md. -1 when absent.
const at = (text, needle) => text.indexOf(needle);
const countOf = (text, re) => (text.match(re) ?? []).length;

describe('REPRODUCE-FIRST — one message, two local agents: ONE inbound line, BOTH replies after it', () => {
  it('records the message once and never lets a faster agent answer ABOVE the message it answers', async () => {
    const files = new Map();
    const bridge = fakeBridge();
    // Two local agents. `wren` answers instantly; `e` takes a real tick — the live shape (two
    // beings, different latencies). Whoever is fast must still land BELOW the inbound line.
    const brain = { calls: [], async turn(being, ev) {
      this.calls.push({ being, line: ev.line });
      if (being === 'e') await new Promise((r) => setTimeout(r, 10));
      return { text: `${being} says hi`, being, sessionId: 's1' };
    } };
    const spine = createSpine({
      bridge, brain, identity: fakeIdentity,
      router: { resolve: () => ({ targets: [{ being: 'e', mention: {} }, { being: 'wren', mention: {} }] }) },
      gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
      sender: fakeSender(bridge),
      transcript: createTranscript({ contacts: fakeContacts, io: memIo(files) }),
      heartbeats, clock: { now: () => 1000 }, turnTimeoutMs: 0,
    });
    spine.start();
    await bridge.emit({ ...MSG, body: '@e and @wren you here?' });

    const text = transcriptText(files);
    expect(brain.calls.map((c) => c.being).sort()).toEqual(['e', 'wren']);   // both agents answered
    expect(countOf(text, /An@\[fam\] #m1:/g)).toBe(1);                       // ONE inbound line
    expect(countOf(text, /^(?:e|wren)@\[fam\]\.wa /gm)).toBe(2);              // TWO reply lines
    const inbound = at(text, 'An@[fam] #m1:');
    expect(inbound).toBeGreaterThanOrEqual(0);
    expect(at(text, 'e@[fam].wa (')).toBeGreaterThan(inbound);
    expect(at(text, 'wren@[fam].wa (')).toBeGreaterThan(inbound);   // the fast agent must NOT precede the message
  });
});

describe('REPRODUCE-FIRST — a turn that FAILS does not re-record its message', () => {
  it('an auto-dwell turn whose brain throws leaves exactly ONE inbound line (it was recorded at arrival)', async () => {
    const files = new Map();
    const bridge = fakeBridge();
    const timers = (() => {
      let seq = 0; const pending = new Map();
      return {
        setTimeout: (fn) => { const id = ++seq; pending.set(id, fn); return { __id: id, unref() {} }; },
        clearTimeout: (t) => { if (t && t.__id != null) pending.delete(t.__id); },
        size: () => pending.size,
        flush() { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) fn(); },
      };
    })();
    const spine = createSpine({
      bridge, brain: { async turn() { throw new Error('brain exploded'); } },
      identity: fakeIdentity,
      router: { resolve: () => ({ being: 'e', mention: {} }) },
      gating: { async decide() { return { mode: 'auto', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
      sender: fakeSender(bridge),
      transcript: createTranscript({ contacts: fakeContacts, io: memIo(files) }),
      heartbeats, clock: { now: () => 1000 }, turnTimeoutMs: 0, rng: () => 0.5,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    spine.start();
    await bridge.emit({ ...MSG, isSender: false, senderName: 'Bea', body: 'hey' });
    timers.flush();                                        // the dwell fires → the turn throws
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(countOf(transcriptText(files), /Bea@\[fam\] #m1:/g)).toBe(1);   // recorded ONCE, not twice
  });
});

describe('REGRESSION — the auto-dwell burst still records each line once, in order, and prompts combined', () => {
  it('three burst lines → three inbound lines in arrival order, ONE reply line last', async () => {
    const files = new Map();
    const bridge = fakeBridge();
    const timers = (() => {
      let seq = 0; const pending = new Map();
      return {
        setTimeout: (fn) => { const id = ++seq; pending.set(id, fn); return { __id: id, unref() {} }; },
        clearTimeout: (t) => { if (t && t.__id != null) pending.delete(t.__id); },
        size: () => pending.size,
        flush() { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) fn(); },
      };
    })();
    const brain = { calls: [], async turn(being, ev) { this.calls.push(ev.line); return { text: 'ya voy', being, sessionId: 's1' }; } };
    const spine = createSpine({
      bridge, brain, identity: fakeIdentity,
      router: { resolve: () => ({ being: 'e', mention: {} }) },
      gating: { async decide() { return { mode: 'auto', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
      sender: fakeSender(bridge),
      transcript: createTranscript({ contacts: fakeContacts, io: memIo(files) }),
      heartbeats, clock: { now: () => 1000 }, turnTimeoutMs: 0, rng: () => 0.5,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    spine.start();
    await bridge.emit({ ...MSG, isSender: false, senderName: 'Bea', body: 'one', msgId: 'a' });
    await bridge.emit({ ...MSG, isSender: false, senderName: 'Cy', body: 'two', msgId: 'b' });
    await bridge.emit({ ...MSG, isSender: false, senderName: 'Bea', body: 'three', msgId: 'c' });
    for (let i = 0; i < 8 && timers.size(); i++) { timers.flush(); await new Promise((r) => setTimeout(r, 0)); }

    const text = transcriptText(files);
    // each burst line recorded exactly once, in arrival order
    expect(countOf(text, /#[abc]: /g)).toBe(3);
    expect(at(text, '#a: one')).toBeLessThan(at(text, '#b: two'));
    expect(at(text, '#b: two')).toBeLessThan(at(text, '#c: three'));
    // one reply, after the whole burst
    expect(countOf(text, /^e@\[fam\]\.wa /gm)).toBe(1);
    expect(at(text, 'e@[fam].wa (')).toBeGreaterThan(at(text, '#c: three'));
    // …and the COMBINED prompt form is intact
    expect(brain.calls).toEqual(['Bea@[fam] #a: one\n\nCy@[fam] #b: two\n\nBea@[fam] #c: three']);
  });
});

// SURFACES ARE OPEN (operator ruling): a network with no historical whitelist entry — e.g. a
// Google Voice message arriving via Beeper — gets its OWN transcript directory, never folded
// into whatsapp. transcript.log(ev) never reads ev.authorized (see src/spine/transcript.mjs) —
// authorization gates REPLIES elsewhere, never the record — so an unauthorized message on the
// new surface must still be logged.
describe('LOCK — a brand-new surface gets its own transcript directory, logged regardless of authorization', () => {
  it('a googlevoice message lands under conversations/googlevoice/, not whatsapp, even when unauthorized', async () => {
    const files = new Map();
    const bridge = fakeBridge();
    const spine = createSpine({
      bridge, brain: { async turn(being) { return { text: 'ok', being, sessionId: 's1' }; } },
      identity: fakeIdentity,
      router: { resolve: () => ({ being: 'e', mention: {} }) },
      gating: { async decide() { return { mode: 'auto', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
      sender: fakeSender(bridge),
      transcript: createTranscript({ contacts: fakeContacts, io: memIo(files) }),
      heartbeats, clock: { now: () => 1000 }, turnTimeoutMs: 0,
    });
    spine.start();
    await bridge.emit({ ...MSG, surface: 'googlevoice', authorized: false, senderName: 'Gv', body: 'hi from gv' });

    const hit = [...files.entries()].find(([p]) => p.endsWith('transcript.md'));
    expect(hit).toBeTruthy();
    const [path, text] = hit;
    const normPath = path.replace(/\\/g, '/');
    expect(normPath).toContain('/conversations/googlevoice/');
    expect(normPath).not.toContain('/conversations/whatsapp/');
    expect(text).toContain('Gv@[fam] #m1: hi from gv');   // recorded despite authorized:false
  });
});

// CONFIG REFRESH ON MESSAGE ARRIVAL (2026-08, replacing the old tick-based hot reload —
// src/spine/config-resolver.mjs / heartbeat-loader.mjs): handleFast — the single ingestion
// path above — awaits the injected refreshConfig at its very top, before transcript.log and
// before dispatch. No tick, no timer, no fake-clock advance is involved in picking up a
// config change: it rides the real inbound message.
describe('REPRODUCE-FIRST — config refresh fires on message arrival, no tick/timer involved', () => {
  it('refreshConfig runs exactly once per inbound message, BEFORE the turn dispatches, with zero advanceTimers', async () => {
    const files = new Map();
    const bridge = fakeBridge();
    const order = [];
    const refreshConfig = async () => { order.push('refresh'); };
    const brain = { async turn(being) { order.push('turn'); return { text: `${being} says hi`, being, sessionId: 's1' }; } };
    const spine = createSpine({
      bridge, brain, identity: fakeIdentity,
      router: { resolve: () => ({ targets: [{ being: 'e', mention: {} }] }) },
      gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
      sender: fakeSender(bridge),
      transcript: createTranscript({ contacts: fakeContacts, io: memIo(files) }),
      heartbeats, clock: { now: () => 1000 }, turnTimeoutMs: 0,
      refreshConfig,
    });
    spine.start();

    await bridge.emit({ ...MSG, body: '@e you there?' });
    expect(order).toEqual(['refresh', 'turn']);   // refreshed BEFORE this message's turn — no tick needed

    await bridge.emit({ ...MSG, msgId: 'm2', body: '@e again' });
    expect(order.filter((x) => x === 'refresh')).toHaveLength(2);   // fires again on the NEXT message too — no throttle
    expect(order.filter((x) => x === 'turn')).toHaveLength(2);
  });

  it('a null refreshConfig (every existing pipe path / test) is byte-identical — the pipe runs fine with no call', async () => {
    const files = new Map();
    const bridge = fakeBridge();
    const brain = { calls: 0, async turn(being) { this.calls++; return { text: 'ok', being, sessionId: 's1' }; } };
    const spine = createSpine({
      bridge, brain, identity: fakeIdentity,
      router: { resolve: () => ({ targets: [{ being: 'e', mention: {} }] }) },
      gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
      sender: fakeSender(bridge),
      transcript: createTranscript({ contacts: fakeContacts, io: memIo(files) }),
      heartbeats, clock: { now: () => 1000 }, turnTimeoutMs: 0,
      // refreshConfig omitted — null default
    });
    spine.start();
    await bridge.emit({ ...MSG, body: '@e hi' });

    expect(brain.calls).toBe(1);
    expect([...files.entries()].some(([p]) => p.endsWith('transcript.md'))).toBe(true);
  });
});

// ROOM-JOIN RECORD-KEEPING (operator, room-join transcript-routing fix): the redirect decision
// itself (currentRoomOf, the 'lobby' rule, the already-redirected-prose no-op) is now resolved
// INSIDE createTranscript — the service's ONE ingestion point (see transcript.mjs, and its own
// dedicated coverage in tests/spine-transcript.test.mjs). spine.mjs's handleFast is unaware rooms
// exist at all: it just calls `transcript.log(ev)`, exactly as before this feature (see the
// createSpine call below — no currentRoomOf option). This is therefore a THIN integration check,
// through the real spine + a room-wired transcript, that a joined-room command/inbound message
// ends up in the room's file and ev itself (what dispatch sees) stays untouched — not a re-test
// of the resolution logic, which lives with createTranscript's own tests.
describe('a room-joined inbound message lands in the room\'s transcript, ev used for dispatch untouched', () => {
  const SHELL_MSG = { ...MSG, surface: 'shell', chatId: 'main', chatName: 'shell', senderName: 'operator', body: '/agents egpt reset' };

  it('handleFast\'s plain transcript.log(ev) call still redirects, because createTranscript itself is room-wired', async () => {
    const files = new Map();
    const bridge = fakeBridge();
    const seenEv = [];
    const spine = createSpine({
      bridge, brain: { async turn(being, ev) { seenEv.push({ surface: ev.surface, chatId: ev.chatId }); return { text: `${being} ok`, being, sessionId: 's1' }; } },
      identity: fakeIdentity,
      router: { resolve: () => ({ being: 'e', mention: {} }) },
      gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
      sender: fakeSender(bridge),
      transcript: createTranscript({ contacts: fakeContacts, io: memIo(files), currentRoomOf: (surface) => (surface === 'shell' ? 'acim' : null) }),
      heartbeats, clock: { now: () => 1000 }, turnTimeoutMs: 0,
    });
    spine.start();
    await bridge.emit(SHELL_MSG);

    // DISPATCH untouched: the turn ran with the ORIGINAL native ev, not a room-redirected one.
    expect(seenEv).toEqual([{ surface: 'shell', chatId: 'main' }]);

    const roomText = [...files.entries()].find(([p]) => p.replace(/\\/g, '/').includes('/rooms/') && p.endsWith('transcript.md'))?.[1];
    const nativeText = [...files.entries()].find(([p]) => p.replace(/\\/g, '/').includes('/conversations/shell/') && p.endsWith('transcript.md'))?.[1];
    expect(roomText).toContain('/agents egpt reset');       // the RECORD landed in the joined room
    expect(nativeText ?? '').not.toContain('/agents egpt reset');   // NOT in the native chat's transcript
  });

  it('no currentRoomOf wired on the transcript (every existing pipe path / test) — byte-identical, logs to the native chat', async () => {
    const files = new Map();
    const bridge = fakeBridge();
    const spine = createSpine({
      bridge, brain: { async turn(being) { return { text: 'ok', being, sessionId: 's1' }; } },
      identity: fakeIdentity,
      router: { resolve: () => ({ being: 'e', mention: {} }) },
      gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
      sender: fakeSender(bridge),
      transcript: createTranscript({ contacts: fakeContacts, io: memIo(files) }),   // currentRoomOf omitted — null default
      heartbeats, clock: { now: () => 1000 }, turnTimeoutMs: 0,
    });
    spine.start();
    await bridge.emit(SHELL_MSG);

    const nativeText = [...files.entries()].find(([p]) => p.replace(/\\/g, '/').includes('/conversations/shell/') && p.endsWith('transcript.md'))?.[1];
    expect(nativeText).toContain('/agents egpt reset');
    expect([...files.keys()].some((p) => p.replace(/\\/g, '/').includes('/rooms/'))).toBe(false);
  });
});
