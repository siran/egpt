// send-rate-guard.test.mjs — the per-chat SEND RATE, counted at the send guard (src/loop-guard.mjs).
//
// Operator 2026-10-18: "a signed message is also from a being; but a being is triggered only if
// it's mentioned. loop guard has to count how many messages are sent to beeper. a mere sustained
// rate of 5msg every 3 secs should be stopped."
//
// The 2026-10-14 outbreak looped through reactions, steer marks and lines said on the operator's
// account; the turn counter (stop-guard noteBeing) never saw those as turns. This counts what
// actually LEAVES for Beeper, per chat. SUSTAINED = ≥5 in each of two consecutive 3 s windows.
// A trip pauses THAT chat in the loop guard (the pause RESUME clears) and drops its later sends.
//
// Operator 2026-10-18, later: "one quick burst, even 12 in a second, doesn't trip it" — "on the
// contrary, it MUST." / "five equal sends or more in 2s" / "it might be going on a crazy loop just
// changing a timestamp, so that should also trip it". So two more rules: BURST (≥10 in 2 s, any
// content) and SIMILAR (≥5 near-identical in 2 s).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-send-rate-guard-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { createSendGuard } from '../src/loop-guard.mjs';
import { createStopGuard, anyChannel, normalizeLine } from '../src/stop-guard.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';

const flush = () => new Promise((r) => setImmediate(r));

// Distinct content per n: letters only, so the digit fold never makes two of them equal.
const word = (n) => { let s = ''; do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } while (n > 0); return s; };

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, set(ms) { t = start + ms; } };
}

function fakePort(clock) {
  const posts = [];
  const rec = (kind, chat, extra = {}) => posts.push({ at: clock.now(), kind, chat, ...extra });
  return {
    posts,
    async send(chat, text) { rec('send', chat, { text }); return { ok: true }; },
    async postStatus(chat, text) { rec('postStatus', chat, { text }); return 'id-1'; },
    async postVerbatim(chat, text) { rec('postVerbatim', chat, { text }); return { ok: true }; },
    async sendMedia(chat, filePath) { rec('sendMedia', chat, { filePath }); return true; },
    editStatus(chat) { rec('editStatus', chat); return true; },
    editOwn(chat) { rec('editOwn', chat); return true; },
    react(chat) { rec('react', chat); return true; },
    getChatName: (id) => (id === '!flood' ? 'Flood Room' : null),
    startStream(chat, init) {
      const h = { delivered: false, frames: [] };
      rec('startStream', chat, { text: init });
      h.update = (t) => h.frames.push(t);
      h.finish = async (t) => { h.frames.push(t); h.delivered = true; };
      h.fail = () => {};
      return h;
    },
  };
}

// The send guard bound to a REAL turn guard, the way boot binds it.
function rig({ keyOf = (c) => c, limits = {} } = {}) {
  const clock = fakeClock();
  const guard = createStopGuard({ now: clock.now });
  const trips = [];
  const nodeTrips = [];
  const port = fakePort(clock);
  const sendGuard = createSendGuard({ now: clock.now, onTrip: (t) => nodeTrips.push(t), ...limits });
  sendGuard.bindChats({
    keyOf,
    lineOf: normalizeLine,
    isPaused: (key) => guard.blocked(anyChannel(key)),
    onTrip: (key, info) => { trips.push({ key, ...info }); guard.stopChannel(anyChannel(key)); },
  });
  const bridge = sendGuard.wrap(port);
  const sends = (chat, n, at, step = 100, opts = {}, text = (ms) => `line ${word(ms)}`) => Promise.all(Array.from({ length: n }, (_, i) => {
    clock.set(at + i * step);
    return bridge.send(chat, text(at + i * step, i), opts);
  }));
  return { clock, guard, trips, nodeTrips, port, bridge, sends };
}
const sentTo = (port, chat) => port.posts.filter((p) => p.chat === chat);

describe('send-rate guard — loop_guard.outbound counts each chat\'s sends', () => {
  // contract 15.2
  it('REPRODUCE: 5 + 5 sends in two consecutive 3 s windows pause THAT chat and drop what follows', async () => {
    const { guard, trips, nodeTrips, port, bridge, sends, clock } = rig();
    await sends('!flood', 5, 0);                 // t = 0..400
    const second = await sends('!flood', 5, 3000);   // t = 3000..3400
    expect(second.slice(0, 4).every((r) => r?.ok)).toBe(true);
    expect(second[4]).toMatchObject({ dropped: true });   // the send that completes the rate is not sent
    expect(sentTo(port, '!flood')).toHaveLength(9);
    expect(trips).toEqual([{ key: '!flood', chat: '!flood', name: 'Flood Room', rule: 'sustained', count: 10, spanMs: 3400, why: 'sustained: 10 messages in 3.4s' }]);
    expect(guard.blocked(anyChannel('!flood'))).toBe(true);
    expect(guard.blocked('whatsapp:!flood')).toBe(true);  // the prompt chokepoint's own key sees it
    expect(nodeTrips).toEqual([]);                        // the node is NOT stopped

    // While paused every new line to that chat is dropped — and dropped is not failed, so no
    // caller re-routes it through another account (a delivered dead stream, a truthy send).
    clock.set(20_000);
    expect(await bridge.send('!flood', 'later')).toMatchObject({ dropped: true });
    expect(await bridge.sendMedia('!flood', '/tmp/x.png')).toBe(true);
    expect(await bridge.postStatus('!flood', '🤔')).toBe(null);
    expect(await bridge.postVerbatim('!flood', 'peer line')).toMatchObject({ dropped: true });
    const s = bridge.startStream('!flood', '⏳ Thinking…');
    expect(s.delivered).toBe(true);
    s.update('x'); await s.finish('done');
    expect(sentTo(port, '!flood')).toHaveLength(9);
    expect(trips).toHaveLength(1);                        // ONE trip, however long the flood goes on

    expect((await bridge.send('!other', 'fine'))?.ok).toBe(true);   // other chats untouched
  });

  it('a slower SUSTAINED rate (4 per 3 s, for 30 s) never trips', async () => {
    const { trips, port, sends } = rig();
    await sends('!busy', 40, 0, 750);
    expect(sentTo(port, '!busy')).toHaveLength(40);
    expect(trips).toEqual([]);
  });

  // The 6ad1494 lock was "one burst never trips"; the operator reversed it the same day.
  it('BURST: 12 different messages in one second trip at the 10th — any content', async () => {
    const { trips, port, sends, nodeTrips } = rig();
    const out = await sends('!burst', 12, 0, 80);
    expect(out.slice(0, 9).every((r) => r?.ok)).toBe(true);
    expect(out[9]).toMatchObject({ dropped: true });
    expect(sentTo(port, '!burst')).toHaveLength(9);
    expect(trips).toMatchObject([{ key: '!burst', rule: 'burst', count: 10, spanMs: 720, why: 'burst: 10 messages in 0.7s' }]);
    expect(nodeTrips).toEqual([]);
  });

  it('SIMILAR: 5 messages differing only in a timestamp within 2 s trip at the 5th', async () => {
    const { trips, port, sends } = rig();
    const out = await sends('!tick', 5, 0, 100, {}, (ms, i) => `Heartbeat OK at 2026-10-18T12:30:0${i}.${ms}Z (run #${i})`);
    expect(out.slice(0, 4).every((r) => r?.ok)).toBe(true);
    expect(out[4]).toMatchObject({ dropped: true });
    expect(sentTo(port, '!tick')).toHaveLength(4);
    expect(trips).toMatchObject([{ key: '!tick', rule: 'similar', count: 5, spanMs: 400, why: 'similar: 5 near-identical messages in 0.4s' }]);
  });

  it('SIMILAR: above chat_similar_ratio counts too — one word changing in a long line', async () => {
    const { trips, sends } = rig();
    const names = ['alfa', 'bravo', 'charlie', 'delta', 'echo'];
    await sends('!near', 5, 0, 300, {}, (ms, i) => `the deploy on node kg is still waiting for the lock held by ${names[i]}`);
    expect(trips).toMatchObject([{ rule: 'similar', count: 5 }]);
  });

  it('5 DIFFERENT messages in 2 s do not trip similar — but they count toward the burst', async () => {
    const { trips, sends } = rig();
    await sends('!chat', 5, 0, 100);
    expect(trips).toEqual([]);
    await sends('!chat', 5, 500, 100);       // the 10th inside 2 s
    expect(trips).toMatchObject([{ rule: 'burst', count: 10 }]);
  });

  it('status placeholders are not a repeated line: six ⏳ streams in a second do not trip similar', async () => {
    const { trips, bridge, clock } = rig();
    for (let i = 0; i < 6; i++) { clock.set(i * 150); bridge.startStream('!room', i ? `⏳ Queued (${i} ahead)…` : '⏳ Thinking…'); }
    expect(trips).toEqual([]);
  });

  it('a media caption is its text; captionless media counts only toward burst/sustained', async () => {
    let r = rig();
    for (let i = 0; i < 5; i++) { r.clock.set(i * 100); await r.bridge.sendMedia('!m', `/tmp/shot-${i}.png`, { caption: `screenshot ${i}` }); }
    expect(r.trips).toMatchObject([{ rule: 'similar', count: 5 }]);
    r = rig();
    for (let i = 0; i < 5; i++) { r.clock.set(i * 100); await r.bridge.sendMedia('!m', `/tmp/shot-${i}.png`); }
    expect(r.trips).toEqual([]);
  });

  it('every rule reads its own limits, and <= 0 turns each one off', async () => {
    const same = (ms, i) => `same line ${i}`;
    // all three off: 12 identical in a second is let through
    let r = rig({ limits: { chatSimilarCount: 0, chatBurstCount: 0, chatMessages: 0 } });
    await r.sends('!a', 12, 0, 80, {}, same);
    expect(sentTo(r.port, '!a')).toHaveLength(12);
    expect(r.trips).toEqual([]);
    // similar off: identical lines now trip only the burst
    r = rig({ limits: { chatSimilarCount: 0 } });
    await r.sends('!a', 12, 0, 80, {}, same);
    expect(r.trips).toMatchObject([{ rule: 'burst', count: 10 }]);
    // burst off: 12 different in a second pass
    r = rig({ limits: { chatBurstCount: -1 } });
    await r.sends('!a', 12, 0, 80);
    expect(r.trips).toEqual([]);
    // a window <= 0 is off too
    r = rig({ limits: { chatBurstWindowMs: 0, chatSimilarWindowMs: 0 } });
    await r.sends('!a', 12, 0, 80, {}, same);
    expect(r.trips).toEqual([]);
    // custom count + window
    r = rig({ limits: { chatSimilarCount: 3, chatSimilarWindowMs: 1000 } });
    await r.sends('!a', 3, 0, 600, {}, same);            // 1.2 s end to end: outside the 1 s window
    expect(r.trips).toEqual([]);
    r = rig({ limits: { chatSimilarCount: 3, chatSimilarWindowMs: 1000 } });
    await r.sends('!a', 3, 0, 300, {}, same);
    expect(r.trips).toMatchObject([{ rule: 'similar', count: 3 }]);
    r = rig({ limits: { chatBurstCount: 4, chatBurstWindowMs: 500 } });
    await r.sends('!a', 4, 0, 100);
    expect(r.trips).toMatchObject([{ rule: 'burst', count: 4 }]);
    // ratio <= 0: only a line equal after the fold is similar, not a merely close one
    r = rig({ limits: { chatSimilarRatio: 0 } });
    const names = ['alfa', 'bravo', 'charlie', 'delta', 'echo'];
    await r.sends('!a', 5, 0, 300, {}, (ms, i) => `the deploy on node kg is still waiting for the lock held by ${names[i]}`);
    expect(r.trips).toEqual([]);
    await r.sends('!b', 5, 0, 300, {}, same);
    expect(r.trips).toMatchObject([{ key: '!b', rule: 'similar' }]);
  });

  it('streaming edits, liveness pulses, status edits and reactions are not messages', async () => {
    const { trips, port, bridge, clock } = rig();
    const s = bridge.startStream('!live', '⏳ Thinking…');
    for (let i = 0; i < 300; i++) {           // 6 s of frames + pulses, edits and reactions
      clock.set(i * 20);
      s.update(`frame ${i}`);
      if (i % 10 === 0) { bridge.editStatus('!live', 'id', '…'); bridge.editOwn('!live', 'id', '…'); bridge.react('!live', 'id', '👀'); }
    }
    await s.finish('the reply');
    expect(trips).toEqual([]);
    expect(sentTo(port, '!live').filter((p) => p.kind === 'startStream')).toHaveLength(1);
    expect((await bridge.send('!live', 'next'))?.ok).toBe(true);
  });

  it('system lines and the STOP path are never counted and never held', async () => {
    const { trips, port, bridge, sends, clock } = rig();
    await sends('!log', 5, 0, 100, { systemLine: true });
    await sends('!log', 5, 3000, 100, { systemLine: true });
    expect(trips).toEqual([]);
    expect(sentTo(port, '!log')).toHaveLength(10);

    clock.set(20_000);                          // a fresh node-wide window
    await sends('!log', 5, 20_000);
    await sends('!log', 5, 23_000);             // being output pauses the chat…
    expect(trips).toHaveLength(1);
    clock.set(24_000);
    expect((await bridge.send('!log', 'audit line', { systemLine: true }))?.ok).toBe(true);   // …a system line still lands
    expect((await bridge.send('!log', 'STOP notice', { bypassLoopGuard: true }))?.ok).toBe(true);
    expect(await bridge.send('!log', 'being line')).toMatchObject({ dropped: true });
  });

  it('the pause IS the loop guard\'s: `resume` in that chat clears it, `resume all` too', async () => {
    const { guard, trips, port, bridge, sends, clock } = rig();
    await sends('!flood', 5, 0);
    await sends('!flood', 5, 3000);
    expect(trips).toHaveLength(1);
    guard.applyControl('resume', 'whatsapp:!flood');   // RESUME typed in the chat
    expect(guard.blocked('whatsapp:!flood')).toBe(false);
    clock.set(3500);
    expect((await bridge.send('!flood', 'back'))?.ok).toBe(true);
    expect(sentTo(port, '!flood')).toHaveLength(10);

    await sends('!flood', 5, 20_000);
    await sends('!flood', 5, 23_000);
    expect(trips).toHaveLength(2);
    guard.applyControl('resume_all', 'whatsapp:!elsewhere');
    expect(guard.blocked(anyChannel('!flood'))).toBe(false);
  });

  it('a mouth room counts WITH its home chat, and pauses under the home chat', async () => {
    const homeOf = { '!mouth-room': '!home' };
    const { trips, port, bridge, clock } = rig({ keyOf: (c) => homeOf[c] ?? c });
    for (let i = 0; i < 10; i++) {
      clock.set((i < 5 ? 0 : 3000) + (i % 5) * 100);
      await bridge.send(i % 2 ? '!mouth-room' : '!home', `m ${word(i)}`);
    }
    expect(trips).toMatchObject([{ key: '!home', chat: '!mouth-room', count: 10 }]);
    expect(await bridge.send('!home', 'x')).toMatchObject({ dropped: true });   // the fallback account is held too
    expect(port.posts).toHaveLength(9);
  });
});

// ── the paused chat at the PROMPT chokepoint: no being is prompted until `resume` ──────────────
describe('send-rate pause at the spine — the same paused state the loop guard keeps', () => {
  it('a human message in the paused chat prompts nobody; `resume` typed there brings it back', async () => {
    const guard = createStopGuard();
    const brain = { calls: [], async turn(b, ev) { this.calls.push({ b, ev }); return { text: 'x' }; } };
    const spine = createSpine({
      bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
      brain, guard,
      identity: createIdentity({ now: () => 1000 }),
      router: { resolve: () => 'e' },
      gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: (d) => d.mayReply },
      transcript: { async log() {} },
      heartbeats: { runDue() {} },
      sender: { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } },
      say: async () => true,
      isSelfChat: () => false,
      clock: { now: () => 1000 },
    });
    const from = (msgKey) => ({ chatId: 'PALMA', chatName: 'PALMA', chatType: 'group', network: 'whatsapp', userId: 'an', username: 'An', senderName: 'An', isSender: true, authorized: true, msgKey });

    guard.stopChannel(anyChannel('PALMA'));
    await spine.handleInbound({ body: 'e hola', from: from('h1') });
    expect(brain.calls).toHaveLength(0);

    await spine.handleInbound({ body: 'resume', from: from('r1') });
    expect(guard.blocked('whatsapp:PALMA')).toBe(false);
    await spine.handleInbound({ body: 'e seguimos', from: from('h2') });
    expect(brain.calls.length).toBeGreaterThan(0);
  });
});

// ── boot's wiring: the trip pauses the chat, says so there, and posts ONE logging-group line ────
let boot, emptyState, makePeerMouth;
beforeAll(async () => {
  ({ boot, makePeerMouth } = await import('../src/spine/boot.mjs'));
  ({ emptyState } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const SELF_DM = '!self-dm';
const ADMIN_ROOM = '!egpt-admin-room';
function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { sent: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      async sendAndGetId(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return 'status-1'; },
      startStreamMessage(init, o) { return { delivered: true, chatId: o?.chatId, update() {}, async finish() {} }; },
      async resolveChatId(nameOrId) { const s = String(nameOrId); return s.startsWith('!') ? s : ({ 'eGPT Admin': ADMIN_ROOM }[s] ?? null); },
      getChatName: (id) => (id === '!flood' ? 'Flood Room' : null),
      async chatHasParticipant() { return null; },
      async chatRaw() { return null; },
      async listChatsRaw() { return []; },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}
function memIo() {
  const files = new Map();
  const dirs = new Set();
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    appendFile: async (path, data) => files.set(path, `${files.get(path) ?? ''}${data}`),
    writeFile: async (path, data) => files.set(path, String(data)),
    readFile: async (path) => { if (!files.has(path)) throw missing(path); return files.get(path); },
    mkdir: async (path) => { dirs.add(path); },
    existsSync: (path) => files.has(path) || dirs.has(path),
    readdir: async (path) => [...files.keys()].filter((f) => dirname(f) === path).map((f) => f.slice(path.length + 1)),
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
  };
}

let app = null;
afterEach(() => { try { app?.stop(); } catch {} app = null; vi.useRealTimers(); });

async function bootNode(outbound = undefined) {
  const { start, built } = fakeTransport();
  const lines = [];
  let convState = emptyState();
  app = await boot({
    readConfig: () => ({
      node_name: 'kg', user_name: 'An', log_to_group: 'eGPT Admin',
      networks: { whatsapp: { chat_ids: [SELF_DM], allowed_users: ['+16468217865'] } },
      beeper: { primary: { account: 'an@example.com', token: 'TOK' } },
      agents: { egpt: { configuration: 'egpt', default: true, handles: ['e'], name: 'E' } },
      loop_guard: { outbound },
    }),
    startBridge: start,
    makeSession: (o) => ({ sessionId: o.sessionId ?? 's', async turn(m) { return { text: `↩ ${m}` }; }, close() {} }),
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0,
    spawn: () => ({ on(ev, cb) { if (ev === 'exit') cb(0); return this; } }),
    reapPort: () => 0,
    log: { line: (s) => lines.push(s) },
  });
  const sentTo = (room) => built.flatMap((b) => b.sent).filter((s) => s.chatId === room);
  return { app, lines, sentTo };
}
const T0 = Date.UTC(2026, 9, 18, 12, 0);
async function flood(chat, at) {
  const out = [];
  for (let i = 0; i < 5; i++) { vi.setSystemTime(T0 + at + i * 100); out.push(await app.bridge.send(chat, `loop ${word(at + i)}`)); }
  return out;
}

describe('makePeerMouth.homeChatOf — the mouth room maps back to the chat it was routed from', () => {
  it('a local mouth route records its home chat; an unrouted room has none', async () => {
    const mouthBridge = { send() {} };
    const peerMouth = makePeerMouth({
      peer: null, bridge: { send() {} },
      localMouth: () => ({ name: 'secondary', home: 'primary', bridge: mouthBridge }),
      mouthRoomFor: async () => ({ isAlias: true, mouthChat: '!mouth-room:beeper.local' }),
    });
    expect(await peerMouth.route('!home:beeper.local', 'e')).toMatchObject({ chatId: '!mouth-room:beeper.local' });
    expect(peerMouth.homeChatOf('!mouth-room:beeper.local')).toBe('!home:beeper.local');
    expect(peerMouth.homeChatOf('!elsewhere')).toBe(null);
  });
});

describe('boot — the send-rate trip, wired', () => {
  // contract 15.2
  it('pauses the chat, says so in it, and posts ONE line to the logging group', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const t = await bootNode();
    await flood('!flood', 0);
    const second = await flood('!flood', 3000);
    expect(second[4]).toMatchObject({ dropped: true });
    await flush(); await flush();

    const log = t.sentTo(ADMIN_ROOM);
    expect(log).toHaveLength(1);
    expect(log[0].text).toContain('kg · send-rate guard paused Flood Room — sustained: 10 messages in 3.4s');
    const inChat = t.sentTo('!flood');
    expect(inChat).toHaveLength(10);                    // 9 being lines + the ⏸️ notice
    expect(inChat.at(-1).text).toMatch(/paused this chat[\s\S]*resume/);

    vi.setSystemTime(T0 + 9000);
    expect(await app.bridge.send('!flood', 'still looping')).toMatchObject({ dropped: true });
    await flush();
    expect(t.sentTo('!flood')).toHaveLength(10);
    expect(t.sentTo(ADMIN_ROOM)).toHaveLength(1);       // one line per trip, not per dropped send
  });

  it('the logging-group line is never blocked — not even when the logging group itself is paused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const t = await bootNode();
    await flood(ADMIN_ROOM, 0);
    await flood(ADMIN_ROOM, 3000);
    await flush(); await flush();
    const before = t.sentTo(ADMIN_ROOM).length;
    expect(t.sentTo(ADMIN_ROOM).at(-1).text).toContain('send-rate guard paused');   // its own trip line landed
    vi.setSystemTime(T0 + 9000);
    await app.logToGroup('kg · /status in Self by An');
    expect(t.sentTo(ADMIN_ROOM)).toHaveLength(before + 1);
    expect(await app.bridge.send(ADMIN_ROOM, 'being line')).toMatchObject({ dropped: true });
  });

  it('reads each per-chat rule from config.yaml loop_guard.outbound, names the rule it tripped, and <= 0 turns rules off', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    let t = await bootNode({ chat_burst_count: 3, chat_burst_window_ms: 1000, chat_similar_count: 2, chat_similar_window_ms: 500 });
    const out = [];
    for (let i = 0; i < 3; i++) { vi.setSystemTime(T0 + i * 100); out.push(await app.bridge.send('!flood', `line ${word(i)}`)); }
    expect(out[2]).toMatchObject({ dropped: true });
    vi.setSystemTime(T0 + 1000); await app.bridge.send('!other', 'all good');
    vi.setSystemTime(T0 + 1100); expect(await app.bridge.send('!other', 'All good ')).toMatchObject({ dropped: true });
    for (let i = 0; i < 2; i++) { vi.setSystemTime(T0 + 3000 + i * 100); app.bridge.startStream('!third', '⏳ Thinking…'); }
    await flush(); await flush();
    const log = t.sentTo(ADMIN_ROOM).map((s) => s.text);
    expect(log).toEqual([
      expect.stringContaining('kg · send-rate guard paused Flood Room — burst: 3 messages in 0.2s'),
      expect.stringContaining('kg · send-rate guard paused !other — similar: 2 near-identical messages in 0.1s'),
    ]);   // and the ⏳ placeholders (boot's lineOf: the loop guard's normalizeLine) are not a similar line
    expect(t.sentTo('!flood').at(-1).text).toMatch(/send-rate guard, burst: 3 messages[\s\S]*resume/);
    app.stop();

    t = await bootNode({ chat_similar_count: 0, chat_burst_count: 0, chat_messages: 0 });
    for (let i = 0; i < 12; i++) { vi.setSystemTime(T0 + 10_000 + i * 80); expect((await app.bridge.send('!flood', 'same line'))?.ok).toBe(true); }
    await flush();
    expect(t.sentTo(ADMIN_ROOM)).toEqual([]);
  });
});
