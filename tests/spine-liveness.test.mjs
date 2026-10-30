// LIVENESS (operator 2026-10-15): "there are turns running... perhaps the bridge can maintain an
// animation" and "bridge must not evict background agents on its own ... instead we can prompt
// model if they're still necessary. if unresponsiveness then post in egpt logging group."
//
// The chat shows a being is alive: its running turn's ⏳ placeholder is re-edited with the elapsed
// time; while background work runs ONE status message per chat does the same, kept across wakes (each
// wake posts its own placeholder) and ended ✓ once the work is gone. WhatsApp refuses
// edits ~15 min after the post, so nothing is edited past LIVE_EDIT_MS: a fresh status takes over
// the animation and a late reply is sent fresh. All of it rides the spine's tick (STOP-first) and
// THE reply path (sender.open), with the real sender over a fake bridge here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender, THINKING, LIVE_EDIT_MS } from '../src/spine/sender.mjs';
import { ASK_AFTER_MS, ASK_ANSWER_MS, LIVENESS_EVERY_MS } from '../src/spine/liveness.mjs';
import { editAction, isLiveStreamFrame } from '../src/dispatch-line.mjs';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const CHAT = 'chat-A@g.us';
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function fakeBridge() {
  let cb = null;
  const streams = [], sent = [];
  return {
    streams, sent,
    onMessage(fn) { cb = fn; }, emit(msg) { return cb(msg); }, stop() {},
    send(chat, text, opts) { sent.push({ chat, text, opts }); return { ok: true, confirmedId: null }; },
    startStream(chat, init, opts) {
      const h = { chat, init, opts, frames: [], finals: [], delivered: false, confirmedId: `${chat}#${streams.length + 1}`, update(t) { h.frames.push(t); }, async finish(t) { h.finals.push(t); h.delivered = true; } };
      streams.push(h);
      return h;
    },
  };
}

// A brain whose turns stay open until released; `tasks` is what its warm sessions report running.
function heldBrain() {
  const calls = [];
  const brain = {
    calls, tasks: [],
    async turn(being, ev, onPartial) {
      let release;
      const p = new Promise((r) => { release = r; });
      calls.push({ being, ev, onPartial, release: (text = `reply-${calls.length}`) => release({ text, sessionId: 's1' }) });
      return p;
    },
  };
  return brain;
}

// `mouth`: the chat is said by a second connection on this node (boot's local mouth): every reply,
// placeholder and status goes out from ITS bridge in ITS room — never from the ear (`bridge`).
function build({ stop = { present: false }, mouth = null, livenessEveryMs, publicOf } = {}) {
  const bridge = fakeBridge();
  const brain = heldBrain();
  const peerMouth = mouth ? { route: async () => ({ bridge: mouth, chatId: 'mouth-room', connection: 'rodz' }) } : null;
  const logged = [], streamed = [], notes = [], group = [], said = [];
  const spine = createSpine({
    bridge, brain, livenessEveryMs,
    // every warm session's live tasks with the conversation each would wake in (boot: the pool's)
    allBackground: () => brain.tasks.map((t) => ({ being: 'egpt', surface: 'whatsapp', chatId: CHAT, ...t })),
    say: async (o) => { said.push(o); return true; },
    identity: { build: (m) => ({ ...m, line: m.body }), spineEvent: async (surface, chatId) => ({ surface, chatId }) },
    router: { resolve: (ev) => ({ being: /^@leo\b/.test(ev.body) ? 'leo' : 'egpt', mention: { atEStart: true, atEAnywhere: true } }) },
    gating: { async decide() { return { mode: 'mention', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: (d) => d.mayReply },
    sender: createSender({ bridge, peerMouth, publicOf, bodyEmojiOf: () => '🐶', labelOf: () => 'E' }),
    transcript: { async log(ev, reply) { logged.push(reply ? reply.text : ev.body); }, logStream(ev, before, after) { streamed.push(after); } },
    heartbeats: { runDue() {} },
    stopSwitch: { present: () => stop.present, pull: async () => {} },
    logToGroup: async (text) => { group.push(text); return true; },
    labelOf: (being) => (being === 'leo' ? 'leo' : 'E'),
    clock: { now: () => Date.now() },
    turnTimeoutMs: 0,
    log: { line: (s) => notes.push(s) },
  });
  spine.start();
  return { spine, bridge, brain, logged, streamed, notes, group, said };
}

const mention = (body, msgId = 'm1') => ({ surface: 'whatsapp', node: 'wa', chatId: CHAT, chatName: 'fam', senderId: 'u', senderName: 'An', msgId, ts: T0, body, kind: 'text', raw: {} });
const at = (ms) => vi.setSystemTime(T0 + ms);
const sec = 1000, min = 60 * sec;

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); at(0); });
afterEach(() => { vi.useRealTimers(); });

describe('liveness — a running turn', () => {
  it('(a) the ⏳ placeholder is re-edited every 15 s (the default), alternating ⤴️ / ↪️ before the elapsed time', async () => {
    expect(LIVENESS_EVERY_MS).toBe(15 * sec);
    const b = build();
    const done = b.bridge.emit(mention('@e long job'));
    await flush();
    const ph = b.bridge.streams[0];
    expect(ph.init).toBe(THINKING);

    at(14 * sec); b.spine.tick();
    expect(ph.frames).toEqual([]);                                   // nothing before the cadence
    at(15 * sec); b.spine.tick();
    at(20 * sec); b.spine.tick();                                    // 5 s later: no second edit
    at(30 * sec); b.spine.tick();
    at(45 * sec); b.spine.tick();
    expect(ph.frames).toEqual(['⏳ Thinking… ⤴️ 15s', '⏳ Thinking… ↪️ 30s', '⏳ Thinking… ⤴️ 45s']);

    b.brain.calls[0].onPartial('Let me check');                      // writing: the tick rides after the streamed text
    at(80 * sec); b.spine.tick();
    at(95 * sec); b.spine.tick();
    expect(ph.frames.slice(3)).toEqual(['Let me check ⏳', 'Let me check ⏳ ↪️ 1m20s', 'Let me check ⏳ ⤴️ 1m35s']);

    b.brain.calls[0].release('Let me check, done');
    await done;
    expect(ph.finals).toEqual(['Let me check, done']);
    at(10 * min); b.spine.tick();
    expect(ph.frames).toHaveLength(6);                               // nothing after the turn ended
  });

  it('(a) the cadence is config-driven (liveness.every_ms → livenessEveryMs)', async () => {
    const b = build({ livenessEveryMs: () => 20 * sec });
    b.bridge.emit(mention('@e long job'));
    await flush();
    const ph = b.bridge.streams[0];
    for (const t of [5, 10, 15]) { at(t * sec); b.spine.tick(); }
    expect(ph.frames).toEqual([]);                                   // not on the 15 s default
    for (const t of [20, 25, 35, 40]) { at(t * sec); b.spine.tick(); }
    expect(ph.frames).toEqual(['⏳ Thinking… ⤴️ 20s', '⏳ Thinking… ↪️ 40s']);
  });

  it('a changed liveness.every_ms reaches the next tick — read each tick, no restart (step B)', async () => {
    let every = 20 * sec;
    const b = build({ livenessEveryMs: () => every });
    b.bridge.emit(mention('@e long job'));
    await flush();
    const ph = b.bridge.streams[0];
    for (const t of [10, 20]) { at(t * sec); b.spine.tick(); }
    expect(ph.frames).toEqual(['⏳ Thinking… ⤴️ 20s']);
    every = 10 * sec;
    for (const t of [25, 30]) { at(t * sec); b.spine.tick(); }
    expect(ph.frames).toEqual(['⏳ Thinking… ⤴️ 20s', '⏳ Thinking… ↪️ 30s']);
  });

  it('(d) at the 15 s cadence nothing edits the placeholder at or past LIVE_EDIT_MS; the rolled status ticks on', async () => {
    const b = build();
    b.bridge.emit(mention('@e very long job'));
    await flush();
    const ph = b.bridge.streams[0];
    for (let t = 5 * sec; t <= 20 * min; t += 5 * sec) { at(t); b.spine.tick(); }
    expect(ph.frames).toHaveLength(LIVE_EDIT_MS / (15 * sec) - 1);  // 15 s … 12m45s
    expect(ph.frames.at(-1)).toBe('⏳ Thinking… ⤴️ 12m45s');
    expect(ph.finals).toEqual([]);
    const st = b.bridge.streams[1];
    expect(st.init).toBe('⏳ still thinking…');
    expect(st.frames.slice(0, 2)).toEqual(['⏳ still thinking… ⤴️ 13m15s', '⏳ still thinking… ↪️ 13m30s']);
    expect(st.frames.at(-1)).toBe('⏳ still thinking… ↪️ 20m00s');
    expect(b.bridge.streams).toHaveLength(2);
  });

  it('(d) no edit past the edit window: the placeholder freezes, a status message takes over, the late reply goes out fresh', async () => {
    const b = build();
    const done = b.bridge.emit(mention('@e very long job'));
    await flush();
    const ph = b.bridge.streams[0];
    for (let t = 30 * sec; t <= 20 * min; t += 30 * sec) { at(t); b.spine.tick(); }
    expect(ph.frames.length).toBeGreaterThan(20);
    expect(ph.frames.at(-1)).toBe('⏳ Thinking… ⤴️ 12m30s');            // the last edit inside LIVE_EDIT_MS
    expect(b.bridge.streams).toHaveLength(2);
    const st = b.bridge.streams[1];
    expect(st.chat).toBe(CHAT);
    expect(st.init).toBe('⏳ still thinking…');
    expect(st.frames.at(-1)).toBe('⏳ still thinking… ↪️ 20m00s');

    b.brain.calls[0].release('done');
    await done;
    expect(ph.finals).toEqual([]);                                    // the 20-min-old placeholder is not touched
    expect(b.bridge.streams[2]).toMatchObject({ chat: CHAT, init: 'done', finals: ['done'] });   // a fresh message, same path
    expect(b.bridge.streams[2].opts).toMatchObject({ replyTo: 'm1', persona: 'egpt' });
    expect(b.bridge.sent).toEqual([]);
    expect(st.finals).toEqual(['✓ 20m00s']);
  });

  it('(d) a turn that ends at 14 min sends the reply FRESH and never edits its 14-min-old placeholder', async () => {
    const b = build();
    const done = b.bridge.emit(mention('@e slow job'));
    await flush();
    const ph = b.bridge.streams[0];
    at(14 * min);
    b.brain.calls[0].onPartial('half way');                          // a late token is not edited in either
    b.brain.calls[0].release('the answer');
    await done;
    expect(ph.frames).toEqual([]);
    expect(ph.finals).toEqual([]);
    expect(b.bridge.streams[1]).toMatchObject({ init: 'the answer', finals: ['the answer'] });
  });

  it('(d) in a MOUTH chat the 14-min reply is a fresh message from the mouth, in its room — never from the ear', async () => {
    const mouth = fakeBridge();
    const b = build({ mouth });
    const done = b.bridge.emit(mention('@e slow job'));
    await flush();
    expect(mouth.streams.map((s) => [s.chat, s.init])).toEqual([['mouth-room', THINKING]]);
    at(14 * min);
    b.brain.calls[0].release('the answer');
    await done;
    expect(mouth.streams[0].finals).toEqual([]);                      // the 14-min-old placeholder is not touched
    expect(mouth.streams[1]).toMatchObject({ chat: 'mouth-room', init: 'the answer', finals: ['the answer'] });
    expect(mouth.streams[1].opts).toMatchObject({ persona: 'egpt', bodyEmoji: '🐶' });
    expect(b.bridge.streams).toEqual([]);
    expect(b.bridge.sent).toEqual([]);
    expect(mouth.sent).toEqual([]);
  });

  it('(d) in a MOUTH chat a background status and its replacement come from the mouth too', async () => {
    const mouth = fakeBridge();
    const b = build({ mouth });
    const done = b.bridge.emit(mention('@e run the audit in the background'));
    await flush();
    b.brain.tasks = [{ description: 'Run the audit', since: T0 }];
    b.brain.calls[0].release('started it');
    await done;
    await flush();
    for (let t = 30 * sec; t <= 14 * min; t += 30 * sec) { at(t); b.spine.tick(); }
    await flush();
    const statuses = mouth.streams.filter((s) => s.init.startsWith('⚙️'));
    expect(statuses).toHaveLength(2);
    expect(statuses.map((s) => s.chat)).toEqual(['mouth-room', 'mouth-room']);
    expect(b.bridge.streams).toEqual([]);
    expect(b.bridge.sent).toEqual([]);
  });

  it('(d) a turn that ends at 5 min still edits its placeholder in place (unchanged)', async () => {
    const b = build();
    const done = b.bridge.emit(mention('@e quick job'));
    await flush();
    at(5 * min);
    b.brain.calls[0].release('the answer');
    await done;
    expect(b.bridge.streams[0].finals).toEqual(['the answer']);
    expect(b.bridge.sent).toEqual([]);
  });

  it('(d) a status message is rolled to a fresh one before its own window closes', async () => {
    const b = build();
    b.bridge.emit(mention('@e endless'));
    await flush();
    for (let t = 30 * sec; t <= 13 * min + LIVE_EDIT_MS + min; t += 30 * sec) { at(t); b.spine.tick(); }
    const [, first, second] = b.bridge.streams;
    expect(second).toBeTruthy();
    expect(first.frames.at(-1)).toBe('⏳ still thinking… ⤴️ 25m30s');   // its last edit, 12m30s after its post
    expect(first.finals).toEqual([]);                                 // frozen there, never edited again
    expect(b.bridge.streams).toHaveLength(3);
  });

  it('(f) a PUBLIC being has no placeholder, so nothing ticks: no stream, no status, only its reply', async () => {
    const b = build({ publicOf: () => true });
    const done = b.bridge.emit(mention('@e long job'));
    await flush();
    for (let t = 5 * sec; t <= 20 * min; t += 5 * sec) { at(t); b.spine.tick(); }
    b.brain.tasks = [{ description: 'Run the audit', since: T0 }];
    b.brain.calls[0].release('the answer');
    await done;
    for (let t = 20 * min; t <= 25 * min; t += 5 * sec) { at(t); b.spine.tick(); }
    expect(b.bridge.streams).toEqual([]);
    expect(b.bridge.sent.map((s) => s.text)).toEqual(['the answer']);
  });

  it('(e) STOP: no animation edit and no status message while the STOP file exists', async () => {
    const stop = { present: false };
    const b = build({ stop });
    const done = b.bridge.emit(mention('@e job'));
    await flush();
    stop.present = true;
    for (let t = 30 * sec; t <= 20 * min; t += 30 * sec) { at(t); b.spine.tick(); }
    expect(b.bridge.streams[0].frames).toEqual([]);
    b.brain.tasks = [{ description: 'Run the audit', since: T0 }];
    b.brain.calls[0].release('started');
    await done;
    expect(b.bridge.streams.filter((s) => s.init.startsWith('⚙️'))).toEqual([]);
  });
});

describe('liveness — background work with no turn in flight', () => {
  async function dispatchBackground(b) {
    const done = b.bridge.emit(mention('@e run the audit in the background'));
    await flush();
    b.brain.tasks = [{ description: 'Run the audit', since: T0 + 5 * sec }];
    b.brain.calls[0].release('started it');
    await done;
    await flush();
  }

  it('(b) ONE status message opens when the dispatching turn ends and animates; the wake posts its own placeholder and the status ends ✓ once the work is gone', async () => {
    const b = build();
    await dispatchBackground(b);
    expect(b.bridge.streams).toHaveLength(2);
    const st = b.bridge.streams[1];
    expect(st.chat).toBe(CHAT);
    expect(st.init).toBe('⚙️ working in background: Run the audit ⏳');
    expect(st.opts).toMatchObject({ bodyEmoji: '🐶', persona: 'egpt', replyTo: b.bridge.streams[0].confirmedId });

    at(4 * min + 5 * sec); b.spine.tick();
    expect(st.frames).toEqual(['⚙️ working in background: Run the audit ⏳ ⤴️ 4m00s']);

    b.brain.tasks = [];
    const woke = b.spine.wakeOnBackground({ being: 'egpt', surface: 'whatsapp', chatId: CHAT, summaries: ['Run the audit — completed'] });
    await flush();
    expect(st.finals).toEqual([]);                                    // the wake does not end it
    expect(b.bridge.streams).toHaveLength(3);                         // the wake's own fresh placeholder, at the bottom
    const wake = b.bridge.streams[2];
    expect(wake.init).toBe(THINKING);
    b.brain.calls[1].release('the audit is clean');
    await woke;
    expect(wake.finals).toEqual(['the audit is clean']);
    at(5 * min); b.spine.tick();                                      // one quiet tick
    at(6 * min); b.spine.tick();
    await flush();
    expect(st.finals).toEqual(['✓ background work ended: Run the audit']);
    expect(b.bridge.streams).toHaveLength(3);
  });

  it('(b) background work gone with no wake: the status is ended ✓ (after one quiet tick); a later wake posts its own placeholder', async () => {
    const b = build();
    await dispatchBackground(b);
    const st = b.bridge.streams[1];
    b.brain.tasks = [];
    at(1 * min); b.spine.tick();
    expect(st.finals).toEqual([]);                                    // one quiet tick: a wake may be on its way
    at(2 * min); b.spine.tick();
    await flush();
    expect(st.finals).toEqual(['✓ background work ended: Run the audit']);
    b.spine.wakeOnBackground({ being: 'egpt', surface: 'whatsapp', chatId: CHAT, summaries: ['x'] });
    await flush();
    expect(b.bridge.streams).toHaveLength(3);                         // a fresh placeholder, not the ended status
  });

  it('(b) on a 5 s tick the background status pulses every 15 s, alternating ⤴️ / ↪️, with one quiet interval', async () => {
    const b = build();
    await dispatchBackground(b);
    const st = b.bridge.streams[1];
    for (let t = 5 * sec; t <= 60 * sec; t += 5 * sec) { at(t); b.spine.tick(); }
    expect(st.frames).toEqual([
      '⚙️ working in background: Run the audit ⏳ ⤴️ 10s',
      '⚙️ working in background: Run the audit ⏳ ↪️ 25s',
      '⚙️ working in background: Run the audit ⏳ ⤴️ 40s',
      '⚙️ working in background: Run the audit ⏳ ↪️ 55s',
    ]);
    b.brain.tasks = [];
    for (let t = 65 * sec; t <= 85 * sec; t += 5 * sec) { at(t); b.spine.tick(); }
    expect(st.finals).toEqual([]);                                    // quiet at 1m15s: a wake may be on its way
    at(90 * sec); b.spine.tick();
    await flush();
    expect(st.finals).toEqual(['✓ background work ended: Run the audit']);
  });

  it('(b) config liveness.every_ms sets the background cadence too', async () => {
    const b = build({ livenessEveryMs: () => 20 * sec });
    await dispatchBackground(b);
    const st = b.bridge.streams[1];
    for (let t = 5 * sec; t <= 60 * sec; t += 5 * sec) { at(t); b.spine.tick(); }
    expect(st.frames).toEqual([
      '⚙️ working in background: Run the audit ⏳ ⤴️ 15s',
      '⚙️ working in background: Run the audit ⏳ ↪️ 35s',
      '⚙️ working in background: Run the audit ⏳ ⤴️ 55s',
    ]);
  });

  it('(c) animation frames are never recorded: no transcript line, no stream bytes, and each one is a live frame the bridge drops before the spine', async () => {
    const b = build();
    const done = b.bridge.emit(mention('@e run the audit in the background'));
    await flush();
    at(30 * sec); b.spine.tick();
    b.brain.tasks = [{ description: 'Run the audit', since: T0 }];
    b.brain.calls[0].release('started it');
    await done;
    await flush();
    at(90 * sec); b.spine.tick();
    const frames = b.bridge.streams.flatMap((s) => s.frames.map((f) => [s.init, f]));
    expect(frames).toHaveLength(2);
    for (const [init, f] of frames) expect(isLiveStreamFrame(editAction({ targetId: '1', oldText: init, newText: f }))).toBe(true);
    expect(b.logged).toEqual(['@e run the audit in the background', 'started it']);
    expect(b.streamed).toEqual([]);
  });

  it("(i) the status is a REPLY to the dispatching turn's own message; its rolled replacement replies to the same one", async () => {
    const b = build();
    await dispatchBackground(b);
    const reply = b.bridge.streams[0];
    expect(reply.finals).toEqual(['started it']);
    for (let t = 30 * sec; t <= 14 * min; t += 30 * sec) { at(t); b.spine.tick(); }
    await flush();
    const statuses = b.bridge.streams.filter((s) => s.init.startsWith('⚙️'));
    expect(statuses).toHaveLength(2);
    expect(statuses.map((s) => s.opts.replyTo)).toEqual([reply.confirmedId, reply.confirmedId]);
    expect(statuses.map((s) => s.opts.replyTo)).not.toContain('m1');   // never the human's trigger
  });

  it("(i) the dispatching turn's reply id is unknown: the status posts unquoted, as before", async () => {
    const b = build();
    const done = b.bridge.emit(mention('@e run the audit in the background'));
    await flush();
    b.bridge.streams[0].confirmedId = null;                          // the placeholder never resolved its id
    b.brain.tasks = [{ description: 'Run the audit', since: T0 }];
    b.brain.calls[0].release('started it');
    await done;
    await flush();
    const st = b.bridge.streams[1];
    expect(st.init).toBe('⚙️ working in background: Run the audit ⏳');
    expect(st.opts.replyTo).toBeNull();
  });

  it("(i) work launched by an earlier turn with no status yet: the status replies to the MOST RECENT turn's message", async () => {
    const stop = { present: true };
    const b = build({ stop });
    const first = b.bridge.emit(mention('@e start the audit', 'm1'));
    await flush();
    b.brain.tasks = [{ description: 'Run the audit', since: T0 }];
    b.brain.calls[0].release('started it');
    await first;
    await flush();
    expect(b.bridge.streams.filter((s) => s.init.startsWith('⚙️'))).toEqual([]);   // STOP: no status opened
    stop.present = false;
    const second = b.bridge.emit(mention('@e and the crawl too', 'm2'));
    await flush();
    b.brain.calls[1].release('crawl started too');
    await second;
    await flush();
    const st = b.bridge.streams.find((s) => s.init.startsWith('⚙️'));
    expect(st.opts.replyTo).toBe(b.bridge.streams[1].confirmedId);
    expect(b.bridge.streams[1].finals).toEqual(['crawl started too']);
  });

  it("(i) in a MOUTH chat the status quotes the mouth's own reply, by its id in the mouth's room — never an ear-side id", async () => {
    const mouth = fakeBridge();
    const b = build({ mouth });
    const done = b.bridge.emit(mention('@e run the audit in the background'));
    await flush();
    b.brain.tasks = [{ description: 'Run the audit', since: T0 }];
    b.brain.calls[0].release('started it');
    await done;
    await flush();
    for (let t = 30 * sec; t <= 14 * min; t += 30 * sec) { at(t); b.spine.tick(); }
    await flush();
    const reply = mouth.streams[0];
    expect(reply).toMatchObject({ chat: 'mouth-room', finals: ['started it'] });
    const statuses = mouth.streams.filter((s) => s.init.startsWith('⚙️'));
    expect(statuses).toHaveLength(2);
    expect(statuses.map((s) => [s.chat, s.opts.replyTo])).toEqual([['mouth-room', reply.confirmedId], ['mouth-room', reply.confirmedId]]);
    expect(b.bridge.streams).toEqual([]);
  });

  it('(e) STOP: the status is not animated while the STOP file exists', async () => {
    const stop = { present: false };
    const b = build({ stop });
    await dispatchBackground(b);
    stop.present = true;
    at(5 * min); b.spine.tick();
    expect(b.bridge.streams[1].frames).toEqual([]);
  });
});

// ONE STATUS PER CHAT (operator 2026-10-30: "Background jobs suddenly post update messages... each
// one its own message. Wouldn't it be better to group these jobs by chat? Updates every minute, or
// when they finish."). Every finished task's wake used to end the status ✓ and the next turn opened a
// new one; two beings in a chat had two. Now the chat has one, edited on the tick across wakes.
describe('liveness — ONE background status per chat, kept across wakes', () => {
  const statuses = (b) => b.bridge.streams.filter((s) => s.init.startsWith('⚙️'));
  async function dispatch(b, body, msgId, task, n) {
    const done = b.bridge.emit(mention(body, msgId));
    await flush();
    b.brain.tasks = [...b.brain.tasks, task];
    b.brain.calls[n].release(`started ${task.description}`);
    await done;
    await flush();
  }
  async function twoBeings(b) {
    await dispatch(b, '@e run the audit in the background', 'm1', { description: 'Run the audit', since: T0 + 5 * sec }, 0);
    await dispatch(b, '@leo crawl the site', 'm2', { being: 'leo', description: 'Crawl the site', since: T0 + 10 * sec }, 1);
  }
  const wake = (b, being, summary) => b.spine.wakeOnBackground({ being, surface: 'whatsapp', chatId: CHAT, summaries: [summary] });

  it('two beings with background work in one chat → ONE status message, listing both, each labelled by its being', async () => {
    const b = build();
    await twoBeings(b);
    expect(statuses(b)).toHaveLength(1);
    const st = statuses(b)[0];
    expect(st.init).toBe('⚙️ working in background: Run the audit ⏳');   // opened by E's turn, as E: its own work needs no label
    expect(st.opts).toMatchObject({ persona: 'egpt', replyTo: b.bridge.streams[0].confirmedId });
    at(1 * min); b.spine.tick();
    expect(st.frames).toEqual(['⚙️ working in background: E — Run the audit; leo — Crawl the site ⏳ ⤴️ 55s']);
    expect(statuses(b)).toHaveLength(1);
  });

  it("a queue: a finished task's wake does not end the status; the next task shows in the SAME message", async () => {
    const b = build();
    await dispatch(b, '@e run the queue in the background', 'm1', { description: 'Queue 07: Factuwin office test', since: T0 + 5 * sec }, 0);
    const st = statuses(b)[0];
    b.brain.tasks = [];
    const woke = wake(b, 'egpt', 'Queue 07: Factuwin office test — completed');
    await flush();
    expect(st.finals).toEqual([]);                                    // the wake no longer ends it
    expect(b.bridge.streams.at(-1).init).toBe(THINKING);              // the wake's own placeholder
    at(1 * min); b.spine.tick();
    at(2 * min); b.spine.tick();                                      // quiet, but the wake turn is still running here
    expect(st.finals).toEqual([]);
    b.brain.tasks = [{ description: 'Queue 08: Factuwin home test', since: T0 + 2 * min }];   // the wake starts the next one
    b.brain.calls[1].release('07 passed; 08 started');
    await woke;
    await flush();
    at(3 * min); b.spine.tick();
    expect(st.frames.at(-1)).toBe('⚙️ working in background: Queue 08: Factuwin home test ⏳ ⤴️ 1m00s');
    b.brain.tasks = [];
    const last = wake(b, 'egpt', 'Queue 08: Factuwin home test — completed');
    await flush();
    b.brain.calls[2].release('08 passed');
    await last;
    at(4 * min); b.spine.tick();
    expect(st.finals).toEqual([]);                                    // one quiet tick
    at(5 * min); b.spine.tick();
    await flush();
    expect(st.finals).toEqual(['✓ background work ended: Queue 08: Factuwin home test']);
    expect(statuses(b)).toHaveLength(1);                              // one message for the whole queue
  });

  it("one being's task finishes and its wake starts: the status runs on while another being's work remains, and ends ✓ when the last is gone", async () => {
    const b = build();
    await twoBeings(b);
    const st = statuses(b)[0];
    b.brain.tasks = b.brain.tasks.filter((t) => t.being === 'leo');
    const woke = wake(b, 'egpt', 'Run the audit — completed');
    await flush();
    expect(st.finals).toEqual([]);
    b.brain.calls[2].release('the audit is clean');
    await woke;
    await flush();
    at(1 * min); b.spine.tick();
    expect(st.frames).toEqual(['⚙️ working in background: leo — Crawl the site ⏳ ⤴️ 50s']);   // still E's message: leo's work is labelled
    b.brain.tasks = [];
    const woke2 = wake(b, 'leo', 'Crawl the site — completed');
    await flush();
    expect(st.finals).toEqual([]);
    b.brain.calls[3].release('crawled: 40 pages');
    await woke2;
    at(2 * min); b.spine.tick();
    at(3 * min); b.spine.tick();
    await flush();
    expect(st.finals).toEqual(['✓ background work ended: leo — Crawl the site']);
    expect(statuses(b)).toHaveLength(1);
  });

  it("a finished task the CLI's own turn answered with a bare '…': nobody is woken, and the status settles as after any wake", async () => {
    const b = build();
    await dispatch(b, '@e run the audit in the background', 'm1', { description: 'Run the audit', since: T0 + 5 * sec }, 0);
    const st = statuses(b)[0];
    b.brain.tasks = [];
    expect(await b.spine.wakeOnBackground({ being: 'egpt', surface: 'whatsapp', chatId: CHAT, summaries: ['Run the audit — completed'], reply: '…' })).toBe(true);
    await flush();
    expect(b.brain.calls).toHaveLength(1);                            // no wake turn
    expect(b.bridge.streams).toHaveLength(2);                         // no wake placeholder
    at(1 * min); b.spine.tick();
    at(2 * min); b.spine.tick();
    await flush();
    expect(st.finals).toEqual(['✓ background work ended: Run the audit']);
  });

  it("/standdown: the chat's ONE status ends on the line, naming every being's stopped work; nothing else is posted", async () => {
    const b = build();
    await twoBeings(b);
    await b.spine.noteStoppedBackground();
    await flush();
    expect(statuses(b)).toHaveLength(1);
    expect(statuses(b)[0].finals).toEqual(['⏹ background work stopped: E — Run the audit; leo — Crawl the site — eGPT moved to the logged-in session. Ask again if you still need it.']);
    expect(b.said).toEqual([]);
  });

  it('/standdown in a chat with no status: the line is said ONCE for the chat', async () => {
    const b = build({ stop: { present: true } });                    // STOP when the work started: no status opened
    await twoBeings(b);
    expect(statuses(b)).toEqual([]);
    await b.spine.noteStoppedBackground();
    expect(b.said).toEqual([{ being: 'egpt', chatId: CHAT, what: 'standdown', text: '⏹ background work stopped: E — Run the audit; leo — Crawl the site — eGPT moved to the logged-in session. Ask again if you still need it.' }]);
  });
});

describe('liveness — long background work is ASKED about, never evicted', () => {
  async function longBackground(b) {
    const done = b.bridge.emit(mention('@e start the crawl'));
    await flush();
    b.brain.tasks = [{ description: 'Crawl the site', since: T0 }];
    b.brain.calls[0].release('crawling');
    await done;
  }
  const ticks = (b, from, until) => { for (let t = from; t <= until; t += 30 * sec) { at(t); b.spine.tick(); } };

  it('(g) after ASK_AFTER_MS the being is asked through the wake path — once per interval', async () => {
    const b = build();
    await longBackground(b);
    ticks(b, 0, ASK_AFTER_MS - 30 * sec);
    expect(b.brain.calls).toHaveLength(1);
    at(ASK_AFTER_MS); b.spine.tick();
    await flush();
    expect(b.brain.calls).toHaveLength(2);
    const ask = b.brain.calls[1].ev.line;
    expect(ask).toBe('[egpt] Your background task(s) Crawl the site have been running for 2h00m. Are they still necessary? Stop any that aren\'t, and report.');
    expect(b.bridge.streams.at(-1).init).toBe(THINKING);            // the ask has its own placeholder…
    const status = b.bridge.streams.filter((s) => s.init.startsWith('⚙️')).at(-1);
    expect(status.finals).toEqual([]);                                // …and the work's status runs on: it is not done
    b.brain.calls[1].release('still needed: 40% done');
    await flush();
    ticks(b, ASK_AFTER_MS + 30 * sec, 2 * ASK_AFTER_MS - 30 * sec);
    expect(b.brain.calls).toHaveLength(2);                            // not again inside the interval
    at(2 * ASK_AFTER_MS); b.spine.tick();
    await flush();
    expect(b.brain.calls).toHaveLength(3);
    expect(b.group).toEqual([]);
  });

  it('(h) an EMPTY answer → ONE line to the logging group', async () => {
    const b = build();
    await longBackground(b);
    at(ASK_AFTER_MS); b.spine.tick();
    await flush();
    b.brain.calls[1].release('');
    await flush();
    expect(b.group).toEqual(['E in fam: background task(s) Crawl the site running 2h00m, the being did not answer whether they are still needed.']);
    at(ASK_AFTER_MS + ASK_ANSWER_MS); b.spine.tick();
    await flush();
    expect(b.group).toHaveLength(1);
  });

  it('(h) NO answer at all within ASK_ANSWER_MS → ONE line, and nothing is killed', async () => {
    const b = build();
    await longBackground(b);
    at(ASK_AFTER_MS); b.spine.tick();
    await flush();
    at(ASK_AFTER_MS + ASK_ANSWER_MS - sec); b.spine.tick();
    expect(b.group).toEqual([]);
    at(ASK_AFTER_MS + ASK_ANSWER_MS); b.spine.tick();
    at(ASK_AFTER_MS + ASK_ANSWER_MS + min); b.spine.tick();
    await flush();
    expect(b.group).toHaveLength(1);
    expect(b.group[0]).toMatch(/did not answer whether they are still needed/);
  });

  it('(g/e) STOP suppresses the ask and the line', async () => {
    const stop = { present: false };
    const b = build({ stop });
    await longBackground(b);
    stop.present = true;
    at(ASK_AFTER_MS + ASK_ANSWER_MS); b.spine.tick();
    await flush();
    expect(b.brain.calls).toHaveLength(1);
    expect(b.group).toEqual([]);
  });
});
