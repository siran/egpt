// LIVENESS (operator 2026-10-15): "there are turns running... perhaps the bridge can maintain an
// animation" and "bridge must not evict background agents on its own ... instead we can prompt
// model if they're still necessary. if unresponsiveness then post in egpt logging group."
//
// The chat shows a being is alive: its running turn's ⏳ placeholder is re-edited with the elapsed
// time. WhatsApp refuses edits ~15 min after the post, so nothing is edited past LIVE_EDIT_MS: a
// fresh status takes over the animation and a late reply is sent fresh. While background work runs,
// ONE status per chat is POSTED — a new message when its task list changes, else every
// liveness.background_every_ms — never edited; a finished task is marked as its session's CLI said it
// ended (An #2944): ✓ ✗ ⏹, ◦ not known. All of it rides the spine's tick (STOP-first) and
// THE reply path (sender.open / sender.post), with the real sender over a fake bridge here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender, THINKING, LIVE_EDIT_MS } from '../src/spine/sender.mjs';
import { ASK_AFTER_MS, ASK_ANSWER_MS, LIVENESS_EVERY_MS, LIVENESS_BACKGROUND_EVERY_MS } from '../src/spine/liveness.mjs';
import { editAction, isLiveStreamFrame } from '../src/dispatch-line.mjs';
import { createWarmCliSession } from '../src/warm-cli-session.mjs';
import { EventEmitter } from 'node:events';

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
function build({ stop = { present: false }, mouth = null, livenessEveryMs, livenessBackgroundEveryMs, publicOf, backgroundOutcome = () => ({ status: 'completed', message: null }) } = {}) {
  const bridge = fakeBridge();
  const brain = heldBrain();
  const peerMouth = mouth ? { route: async () => ({ bridge: mouth, chatId: 'mouth-room', connection: 'rodz' }) } : null;
  const logged = [], streamed = [], notes = [], group = [], said = [];
  const spine = createSpine({
    bridge, brain, livenessEveryMs, livenessBackgroundEveryMs,
    // every warm session's live tasks with the conversation each would wake in (boot: the pool's)
    allBackground: () => brain.tasks.map((t) => ({ being: 'egpt', surface: 'whatsapp', chatId: CHAT, ...t })),
    // how a finished one ended, as its session's CLI said it (boot: the pool's) — completed, unless a test says otherwise
    backgroundOutcome,
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
const posts = (b) => b.bridge.sent.map((s) => s.text);
const ticks = async (b, from, until, step = 15 * sec) => { for (let t = from; t <= until; t += step) { at(t); b.spine.tick(); } await flush(); };

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

  it("(a) a multi-line reply's frame keeps the ⏳ and the tick at its end", async () => {
    const b = build();
    b.bridge.emit(mention('@e long job'));
    await flush();
    const ph = b.bridge.streams[0];
    b.brain.calls[0].onPartial('Two things:\n• the audit\n• the crawl');
    at(15 * sec); b.spine.tick();
    expect(ph.frames).toEqual(['Two things:\n• the audit\n• the crawl ⏳', 'Two things:\n• the audit\n• the crawl ⏳ ⤴️ 15s']);
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

  it('(d) in a MOUTH chat every background status is posted by the mouth, in its room — never from the ear', async () => {
    const mouth = fakeBridge();
    const b = build({ mouth });
    const done = b.bridge.emit(mention('@e run the audit in the background'));
    await flush();
    b.brain.tasks = [{ description: 'Run the audit', since: T0 }];
    b.brain.calls[0].release('started it');
    await done;
    await flush();
    for (let t = 30 * sec; t <= 11 * min; t += 30 * sec) { at(t); b.spine.tick(); }
    await flush();
    expect(mouth.sent.map((s) => [s.chat, s.text])).toEqual([['mouth-room', '⚙️ background work (1):\n• Run the audit · 0s'], ['mouth-room', '⚙️ background work (1):\n• Run the audit · 10m00s']]);
    expect(mouth.sent.map((s) => s.opts.persona)).toEqual(['egpt', 'egpt']);
    expect(mouth.streams).toHaveLength(1);                            // the reply's own: a status is no stream
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
    expect(b.bridge.sent).toEqual([]);
  });
});

// A CHAT'S BACKGROUND STATUS IS POSTED, NOT EDITED (operator 2026-10-30, #2735: "en lugar de editar los
// mensajes, puedes solo publicar el estatus de todas las tareas en un mensaje cada cierto tiempo"; #2384:
// "puedes dar updates cada minuto, o cuando terminen"). A fresh message when the chat's task list changes,
// else every liveness.background_every_ms; each task with its elapsed time, the finished ones ✓.
describe('liveness — background work is POSTED, never edited', () => {
  async function dispatchBackground(b, endAt = 0) {
    const done = b.bridge.emit(mention('@e run the audit in the background'));
    await flush();
    b.brain.tasks = [{ description: 'Run the audit', since: T0 }];
    at(endAt);
    b.brain.calls[0].release('started it');
    await done;
    await flush();
  }

  it("(b) the dispatching turn's end POSTS the chat's status: one send, a reply to its own message, as its being, the task timed", async () => {
    const b = build();
    await dispatchBackground(b, 1 * min + 4 * sec);
    expect(posts(b)).toEqual(['⚙️ background work (1):\n• Run the audit · 1m04s']);
    expect(b.bridge.sent[0]).toMatchObject({ chat: CHAT, opts: { bodyEmoji: '🐶', label: 'E', persona: 'egpt', replyTo: b.bridge.streams[0].confirmedId } });
    expect(b.bridge.streams).toHaveLength(1);                         // the turn's own placeholder: a status is no stream
    expect(b.notes.join('\n')).toContain('egpt/chat-A@g.us — background task(s) Run the audit still running, status posted');
  });

  // An #3499, 2026-11-01: "por qué los mensajes se están viendo así? … se van así" — a background Bash described
  // by its whole command was posted as a heredoc, line by line. Its session keeps it one line (warm-cli-session).
  it("(b) a task the CLI described by a whole heredoc command is ONE line in the status, as its session keeps it", async () => {
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {}, end() {} }, kill() {} });
    const session = createWarmCliSession({ adopt: { proc, background: [{ task_id: 'b1', description: "cd /srv/e4; python3 - <<'PY'\np='aws/job-boleta.ps1'; s=open(p).read()\nPY", since: T0 }] } });
    const b = build();
    const done = b.bridge.emit(mention('@e run the audit in the background'));
    await flush();
    b.brain.tasks = session.backgroundTasks.map(({ description, since }) => ({ description, since }));
    b.brain.calls[0].release('started it');
    await done;
    await flush();
    expect(posts(b)).toEqual(["⚙️ background work (1):\n• cd /srv/e4; python3 - <<'PY'… · 0s"]);
    session.close();
  });

  it('(b) a change — a task appears or finishes — is posted at the next pulse; several in one pulse make ONE message, the finished ones ✓', async () => {
    const b = build();
    await dispatchBackground(b);
    at(15 * sec); b.spine.tick();                                     // nothing changed: nothing posted
    b.brain.tasks = [...b.brain.tasks, { being: 'leo', description: 'Crawl the site', since: T0 + 20 * sec }, { being: 'leo', description: 'Lint the repo', since: T0 + 20 * sec }];
    at(25 * sec); b.spine.tick();                                     // between pulses: not yet
    expect(posts(b)).toHaveLength(1);
    at(30 * sec); b.spine.tick();
    await flush();
    expect(posts(b).slice(1)).toEqual(['⚙️ background work (3):\n• E — Run the audit · 30s\n• leo — Crawl the site · 10s\n• leo — Lint the repo · 10s']);
    at(45 * sec); b.spine.tick();
    await flush();
    expect(posts(b)).toHaveLength(2);                                 // no change, no post
    b.brain.tasks = b.brain.tasks.filter((t) => t.description !== 'Lint the repo');              // one finishes…
    b.brain.tasks.push({ description: 'Queue 07: Factuwin office test', since: T0 + 50 * sec });  // …one appears, same pulse
    at(60 * sec); b.spine.tick();
    await flush();
    expect(posts(b).slice(2)).toEqual(['⚙️ background work (3):\n• E — Run the audit · 1m00s\n• leo — Crawl the site · 40s\n• E — Queue 07: Factuwin office test · 10s\n✓ leo — Lint the repo · 40s']);
  });

  it('(b) liveness.every_ms paces the check: a change is posted at the next pulse of that cadence', async () => {
    const b = build({ livenessEveryMs: () => 20 * sec });
    await dispatchBackground(b);
    b.brain.tasks.push({ description: 'Crawl the site', since: T0 + 5 * sec });
    for (const t of [5, 10, 15]) { at(t * sec); b.spine.tick(); }
    expect(posts(b)).toHaveLength(1);                                 // not on the 15 s default
    at(20 * sec); b.spine.tick();
    await flush();
    expect(posts(b).slice(1)).toEqual(['⚙️ background work (2):\n• Run the audit · 20s\n• Crawl the site · 15s']);
  });

  it('(b) nothing changed: posted again every liveness.background_every_ms — 10 min by default — never in between, each a reply to the same message', async () => {
    expect(LIVENESS_BACKGROUND_EVERY_MS).toBe(10 * min);
    const b = build();
    await dispatchBackground(b);
    await ticks(b, 15 * sec, 25 * min);
    expect(posts(b)).toEqual([
      '⚙️ background work (1):\n• Run the audit · 0s',
      '⚙️ background work (1):\n• Run the audit · 10m00s',
      '⚙️ background work (1):\n• Run the audit · 20m00s',
    ]);
    expect(b.bridge.sent.map((s) => s.opts.replyTo)).toEqual(Array(3).fill(b.bridge.streams[0].confirmedId));
    expect(b.bridge.sent.map((s) => s.opts.replyTo)).not.toContain('m1');   // never the human's trigger
  });

  it('(b) liveness.background_every_ms is read each pulse: a changed value reaches the next one, no restart', async () => {
    let every = 5 * min;
    const b = build({ livenessBackgroundEveryMs: () => every });
    await dispatchBackground(b);
    await ticks(b, 15 * sec, 6 * min);
    expect(posts(b).map((p) => p.split(' · ')[1])).toEqual(['0s', '5m00s']);
    every = 2 * min;
    await ticks(b, 6 * min + 15 * sec, 9 * min);
    expect(posts(b).map((p) => p.split(' · ')[1])).toEqual(['0s', '5m00s', '7m00s', '9m00s']);
  });

  it('(b) the last task finishes: after one quiet pulse a last post lists it ✓; nothing follows, and a later wake posts its own placeholder', async () => {
    const b = build();
    await dispatchBackground(b);
    b.brain.tasks = [];
    at(1 * min); b.spine.tick();
    await flush();
    expect(posts(b)).toHaveLength(1);                                 // one quiet pulse: a wake may be on its way
    at(2 * min); b.spine.tick();
    await flush();
    expect(posts(b).slice(1)).toEqual(['✓ background work done:\n✓ Run the audit · 1m00s']);
    await ticks(b, 3 * min, 30 * min);
    expect(posts(b)).toHaveLength(2);
    b.spine.wakeOnBackground({ being: 'egpt', surface: 'whatsapp', chatId: CHAT, summaries: ['x'] });
    await flush();
    expect(b.bridge.streams.map((s) => s.init)).toEqual([THINKING, THINKING]);   // the wake's own placeholder
  });

  it("(b) a finished task's wake posts its own placeholder, and the last post waits for it: a turn running there may start more", async () => {
    const b = build();
    await dispatchBackground(b);
    b.brain.tasks = [];
    const woke = b.spine.wakeOnBackground({ being: 'egpt', surface: 'whatsapp', chatId: CHAT, summaries: ['Run the audit — completed'] });
    await flush();
    expect(b.bridge.streams.at(-1).init).toBe(THINKING);
    await ticks(b, 1 * min, 3 * min, 1 * min);
    expect(posts(b)).toHaveLength(1);
    b.brain.calls[1].release('the audit is clean');
    await woke;
    at(4 * min); b.spine.tick();
    await flush();
    expect(posts(b).slice(1)).toEqual(['✓ background work done:\n✓ Run the audit · 1m00s']);
  });

  it('(c) nothing is edited and the spine records none of it: every status is ONE send; the record holds the turn only', async () => {
    const b = build();
    await dispatchBackground(b);
    b.brain.tasks.push({ being: 'leo', description: 'Crawl the site', since: T0 + 10 * sec });
    await ticks(b, 15 * sec, 11 * min);                               // a change, then the 10-min post
    b.brain.tasks = [];
    await ticks(b, 11 * min + 15 * sec, 12 * min);                    // the last post
    expect(posts(b)).toHaveLength(4);
    expect(b.bridge.streams).toHaveLength(1);
    expect(b.bridge.streams[0]).toMatchObject({ frames: [], finals: ['started it'] });
    expect(b.logged).toEqual(['@e run the audit in the background', 'started it']);
    expect(b.streamed).toEqual([]);
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
    expect(b.bridge.sent).toMatchObject([{ text: '⚙️ background work (1):\n• Run the audit · 0s', opts: { replyTo: null } }]);
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
    expect(b.bridge.sent).toEqual([]);                                // STOP: no status posted
    stop.present = false;
    const second = b.bridge.emit(mention('@e and the crawl too', 'm2'));
    await flush();
    b.brain.calls[1].release('crawl started too');
    await second;
    await flush();
    expect(b.bridge.sent.map((s) => s.opts.replyTo)).toEqual([b.bridge.streams[1].confirmedId]);
    expect(b.bridge.streams[1].finals).toEqual(['crawl started too']);
  });

  it('(e) STOP: nothing is posted while the STOP file exists', async () => {
    const stop = { present: false };
    const b = build({ stop });
    await dispatchBackground(b);
    stop.present = true;
    b.brain.tasks = [];
    await ticks(b, 1 * min, 15 * min, 1 * min);
    expect(posts(b)).toHaveLength(1);
  });
});

// ONE STATUS PER CHAT (operator 2026-10-30: "Background jobs suddenly post update messages... each
// one its own message. Wouldn't it be better to group these jobs by chat? Updates every minute, or
// when they finish."). Every finished task's wake used to end the status ✓ and the next turn opened a
// new one; two beings in a chat had two. Now the chat has one status, posted as the being whose turn
// opened it, across wakes.
describe('liveness — ONE background status per chat, kept across wakes', () => {
  async function dispatch(b, body, msgId, task, n, endAt) {
    const done = b.bridge.emit(mention(body, msgId));
    await flush();
    b.brain.tasks = [...b.brain.tasks, task];
    at(endAt);
    b.brain.calls[n].release(`started ${task.description}`);
    await done;
    await flush();
  }
  async function twoBeings(b) {
    await dispatch(b, '@e run the audit in the background', 'm1', { description: 'Run the audit', since: T0 }, 0, 0);
    await dispatch(b, '@leo crawl the site', 'm2', { being: 'leo', description: 'Crawl the site', since: T0 + 5 * sec }, 1, 5 * sec);
  }
  const wake = (b, being, summary) => b.spine.wakeOnBackground({ being, surface: 'whatsapp', chatId: CHAT, summaries: [summary] });

  it("two beings with background work in one chat → ONE status, posted as the being whose turn opened it, each task labelled by its being", async () => {
    const b = build();
    await twoBeings(b);
    expect(posts(b)).toEqual(['⚙️ background work (1):\n• Run the audit · 0s']);   // E's turn, as E: its own work needs no label; leo's turn ending posts nothing
    at(15 * sec); b.spine.tick();
    await flush();
    expect(posts(b).slice(1)).toEqual(['⚙️ background work (2):\n• E — Run the audit · 15s\n• leo — Crawl the site · 10s']);
    expect(b.bridge.sent.map((s) => [s.opts.persona, s.opts.replyTo])).toEqual(Array(2).fill(['egpt', b.bridge.streams[0].confirmedId]));
  });

  // operator 2026-10-30: "una por línea, con su bullet"; "cada minuto, o cuando terminen"
  it("the operator's format: one task per line — • running, ✓ finished since the last post — timed, and labelled when not all the poster's", async () => {
    const b = build();
    const done = b.bridge.emit(mention('@e run the queue, and leo the lint'));
    await flush();
    b.brain.tasks = [{ description: 'Queue 07: Factuwin office test', since: T0 + 2 * min + 56 * sec }, { being: 'leo', description: 'Lint the repo', since: T0 + 7 * min }];
    at(7 * min);
    b.brain.calls[0].release('both started');
    await done;
    await flush();
    await ticks(b, 7 * min + 15 * sec, 14 * min + 45 * sec);
    b.brain.tasks = [b.brain.tasks[0], { being: 'leo', description: 'Crawl the site', since: T0 + 11 * min + 50 * sec }];   // the lint ends as the crawl starts
    at(15 * min); b.spine.tick();
    b.brain.tasks = [];
    await ticks(b, 15 * min + 15 * sec, 16 * min);
    expect(posts(b)).toEqual([
      '⚙️ background work (2):\n• E — Queue 07: Factuwin office test · 4m04s\n• leo — Lint the repo · 0s',
      '⚙️ background work (2):\n• E — Queue 07: Factuwin office test · 12m04s\n• leo — Crawl the site · 3m10s\n✓ leo — Lint the repo · 8m00s',
      '✓ background work done:\n✓ E — Queue 07: Factuwin office test · 12m19s\n✓ leo — Crawl the site · 3m25s',
    ]);
    expect(b.notes.join('\n')).toContain('background task(s) E — Queue 07: Factuwin office test; leo — Lint the repo still running, status posted');   // the log line stays one line
  });

  it("a queue: a finished task's wake answers in its own placeholder; the next pulse posts the next task with the finished one ✓", async () => {
    const b = build();
    await dispatch(b, '@e run the queue in the background', 'm1', { description: 'Queue 07: Factuwin office test', since: T0 }, 0, 0);
    b.brain.tasks = [];
    at(1 * min);
    const woke = wake(b, 'egpt', 'Queue 07: Factuwin office test — completed');
    await flush();
    expect(b.bridge.streams.at(-1).init).toBe(THINKING);              // the wake's own placeholder
    at(1 * min); b.spine.tick();
    at(2 * min); b.spine.tick();                                      // quiet, but the wake turn is still running here
    b.brain.tasks = [{ description: 'Queue 08: Factuwin home test', since: T0 + 2 * min }];   // the wake starts the next one
    b.brain.calls[1].release('07 passed; 08 started');
    await woke;
    await flush();
    at(3 * min); b.spine.tick();
    await flush();
    expect(posts(b).slice(1)).toEqual(['⚙️ background work (1):\n• Queue 08: Factuwin home test · 1m00s\n✓ Queue 07: Factuwin office test · 1m00s']);
    b.brain.tasks = [];
    const last = wake(b, 'egpt', 'Queue 08: Factuwin home test — completed');
    await flush();
    b.brain.calls[2].release('08 passed');
    await last;
    at(4 * min); b.spine.tick();                                      // one quiet pulse
    at(5 * min); b.spine.tick();
    await flush();
    expect(posts(b).slice(2)).toEqual(['✓ background work done:\n✓ Queue 08: Factuwin home test · 2m00s']);
    expect(b.bridge.streams.map((s) => s.init)).toEqual([THINKING, THINKING, THINKING]);   // the turn and the two wakes: nothing edited for the status
  });

  it("one being's task finishes: the status runs on while another being's work remains, and the last post comes when it is gone", async () => {
    const b = build();
    await twoBeings(b);
    at(15 * sec); b.spine.tick();
    b.brain.tasks = b.brain.tasks.filter((t) => t.being === 'leo');
    const woke = wake(b, 'egpt', 'Run the audit — completed');
    await flush();
    b.brain.calls[2].release('the audit is clean');
    await woke;
    at(1 * min); b.spine.tick();
    await flush();
    expect(posts(b).slice(2)).toEqual(['⚙️ background work (1):\n• leo — Crawl the site · 55s\n✓ E — Run the audit · 1m00s']);   // still E's: leo's work is labelled
    b.brain.tasks = [];
    const woke2 = wake(b, 'leo', 'Crawl the site — completed');
    await flush();
    b.brain.calls[3].release('crawled: 40 pages');
    await woke2;
    at(2 * min); b.spine.tick();
    at(3 * min); b.spine.tick();
    await flush();
    expect(posts(b).slice(3)).toEqual(['✓ background work done:\n✓ leo — Crawl the site · 1m55s']);
    expect(b.bridge.sent.every((s) => s.opts.persona === 'egpt')).toBe(true);
  });

  it("a finished task the CLI's own turn answered with a bare '…': nobody is woken, and the last post comes as after any wake", async () => {
    const b = build();
    await dispatch(b, '@e run the audit in the background', 'm1', { description: 'Run the audit', since: T0 }, 0, 0);
    b.brain.tasks = [];
    expect(await b.spine.wakeOnBackground({ being: 'egpt', surface: 'whatsapp', chatId: CHAT, summaries: ['Run the audit — completed'], reply: '…' })).toBe(true);
    await flush();
    expect(b.brain.calls).toHaveLength(1);                            // no wake turn
    expect(b.bridge.streams).toHaveLength(1);                         // no wake placeholder
    at(1 * min); b.spine.tick();
    at(2 * min); b.spine.tick();
    await flush();
    expect(posts(b).slice(1)).toEqual(['✓ background work done:\n✓ Run the audit · 1m00s']);
  });

  it("/standdown: the chat's line is posted as its status was, naming every being's stopped work; nothing follows it", async () => {
    const b = build();
    await twoBeings(b);
    await b.spine.noteStoppedBackground();
    await flush();
    expect(b.bridge.sent.at(-1)).toMatchObject({ chat: CHAT, text: '⏹ background work stopped: E — Run the audit; leo — Crawl the site — eGPT moved to the logged-in session. Ask again if you still need it.', opts: { persona: 'egpt', replyTo: b.bridge.streams[0].confirmedId } });
    expect(b.said).toEqual([]);
    await ticks(b, 15 * sec, 15 * min);
    expect(posts(b)).toHaveLength(2);                                 // the first status and the line
  });

  it('/standdown in a chat with no status: the line is said ONCE for the chat', async () => {
    const b = build({ stop: { present: true } });                    // STOP when the work started: no status posted
    await twoBeings(b);
    expect(b.bridge.sent).toEqual([]);
    await b.spine.noteStoppedBackground();
    expect(b.said).toEqual([{ being: 'egpt', chatId: CHAT, what: 'standdown', text: '⏹ background work stopped: E — Run the audit; leo — Crawl the site — eGPT moved to the logged-in session. Ask again if you still need it.' }]);
  });
});

// An #2944, 2026-10-31: "si termina en error (muy raro) debería mostrar una X y el mensaje de error? esto
// debe ser estructural, no pongas al SI a determinar el error cuando falla el proceso".
describe('liveness — a finished task is marked as its session\'s CLI said it ended', () => {
  const FAILED = { status: 'failed', message: 'Background command "npm run lint" failed (exit code 1)' };
  // E's audit (b1) and leo's lint (b2) running; `ended`: taskId → how the CLI said it ended. `asked` gets each lookup.
  async function auditAndLint(ended, asked = []) {
    const b = build({ backgroundOutcome: (t) => { asked.push(t); return ended[t.taskId] ?? null; } });
    const done = b.bridge.emit(mention('@e run the audit, and leo the lint'));
    await flush();
    b.brain.tasks = [{ taskId: 'b1', description: 'Run the audit', since: T0 }, { being: 'leo', taskId: 'b2', description: 'Lint the repo', since: T0 + 20 * sec }];
    b.brain.calls[0].release('both started');
    await done;
    await flush();
    return b;
  }
  const finish = async (b, taskIds, t) => { b.brain.tasks = b.brain.tasks.filter((x) => !taskIds.includes(x.taskId)); at(t); b.spine.tick(); await flush(); };

  it("a failed task is ✗ with the CLI's own message, beside the running ones — read once, as it leaves the list", async () => {
    const asked = [];
    const b = await auditAndLint({ b2: FAILED }, asked);
    await finish(b, ['b2'], 1 * min);
    expect(posts(b).slice(1)).toEqual(['⚙️ background work (1):\n• E — Run the audit · 1m00s\n✗ leo — Lint the repo · 40s — Background command "npm run lint" failed (exit code 1)']);
    expect(asked).toEqual([{ being: 'leo', chatId: CHAT, taskId: 'b2' }]);
    await ticks(b, 1 * min + 15 * sec, 2 * min);
    expect(asked).toHaveLength(1);
  });

  it('the last post: "✓ … done" only if all it lists completed; a failure among them → "⚠️ background work ended:"', async () => {
    const b = await auditAndLint({ b1: { status: 'completed', message: null }, b2: FAILED });
    await finish(b, ['b1', 'b2'], 1 * min);                           // one quiet pulse
    await finish(b, [], 2 * min);
    expect(posts(b).slice(1)).toEqual(['⚠️ background work ended:\n✓ E — Run the audit · 1m00s\n✗ leo — Lint the repo · 40s — Background command "npm run lint" failed (exit code 1)']);
    const ok = await auditAndLint({ b1: { status: 'completed', message: null }, b2: { status: 'completed', message: null } });
    await finish(ok, ['b1', 'b2'], 3 * min);
    await finish(ok, [], 4 * min);
    expect(posts(ok).slice(1)).toEqual(['✓ background work done:\n✓ E — Run the audit · 3m00s\n✓ leo — Lint the repo · 2m40s']);
  });

  it('a stopped task is ⏹ "stopped" — no error, no ⚠️, and not "done"', async () => {
    const b = await auditAndLint({ b1: { status: 'completed', message: null }, b2: { status: 'stopped', message: 'Lint the repo' } });
    await finish(b, ['b1', 'b2'], 1 * min);
    await finish(b, [], 2 * min);
    expect(posts(b).slice(1)).toEqual(['background work ended:\n✓ E — Run the audit · 1m00s\n⏹ leo — Lint the repo · 40s — stopped']);
  });

  it('how it ended is not known (its session is gone, or none wired) → ◦, never a ✓ it cannot see', async () => {
    const b = await auditAndLint({ b1: { status: 'completed', message: null } });
    await finish(b, ['b2'], 1 * min);
    expect(posts(b).at(-1)).toBe('⚙️ background work (1):\n• E — Run the audit · 1m00s\n◦ leo — Lint the repo · 40s');
    const none = build({ backgroundOutcome: null });
    const done = none.bridge.emit(mention('@e run the audit in the background'));
    await flush();
    none.brain.tasks = [{ taskId: 'b1', description: 'Run the audit', since: T0 + 2 * min }];
    at(2 * min);
    none.brain.calls[0].release('started it');
    await done;
    await flush();
    await finish(none, ['b1'], 3 * min);
    await finish(none, [], 4 * min);
    expect(posts(none)).toEqual(['⚙️ background work (1):\n• Run the audit · 0s', 'background work ended:\n◦ Run the audit · 1m00s']);
  });
});

// An #2971, 2026-10-31: "the task list is confusing: are you listing parent and child process in the same
// level? in that case why not nest?". The live case: ED's background agent and the two background Bash tasks
// it ran, listed flat. claude 2.1.309 names the live agent that launched a task (parent_task_id), and marks
// the tasks that are not activity (ambient: "hosts should exclude them from activity indicators").
describe('liveness — a task a background agent launched is listed under it', () => {
  const AGENT = { taskId: 'ae02d2d4edb413bc7', description: 'Factuwin tests on AWS Windows', since: T0 - 72 * min };
  const QUEUE = { taskId: 'bbsv9o3jx', parentTaskId: AGENT.taskId, description: 'Queue menu calibration job', since: T0 - 9 * min };
  const WAIT = { taskId: 'bs2650ese', parentTaskId: AGENT.taskId, description: 'Wait for E2-a job completion', since: T0 - 40 * sec };
  // The turn that launched `tasks` ends; `ended`: taskId → how the CLI said it ended (else completed).
  async function launched(tasks, ended = {}) {
    const b = build({ backgroundOutcome: (t) => ended[t.taskId] ?? { status: 'completed', message: null } });
    const done = b.bridge.emit(mention('@e run the Factuwin tests on AWS'));
    await flush();
    b.brain.tasks = tasks;
    b.brain.calls[0].release('started them');
    await done;
    await flush();
    return b;
  }
  const finish = async (b, taskIds, t) => { b.brain.tasks = b.brain.tasks.filter((x) => !taskIds.includes(x.taskId)); at(t); b.spine.tick(); await flush(); };

  it('THE LIVE CASE: the agent\'s two Bash tasks are listed under it, └, each timed; the count is every running task', async () => {
    const b = await launched([AGENT, QUEUE, WAIT]);
    expect(posts(b)).toEqual(['⚙️ background work (3):\n• Factuwin tests on AWS Windows · 1h12m\n  └ Queue menu calibration job · 9m00s\n  └ Wait for E2-a job completion · 40s']);
  });

  it('a finished task stays under its running agent, marked as its CLI said it ended', async () => {
    const b = await launched([AGENT, QUEUE, WAIT], { [WAIT.taskId]: { status: 'failed', message: 'job E2-a: exit code 2' } });
    await finish(b, [QUEUE.taskId], 1 * min);
    await finish(b, [WAIT.taskId], 2 * min);
    expect(posts(b).slice(1)).toEqual([
      '⚙️ background work (2):\n• Factuwin tests on AWS Windows · 1h13m\n  └ Wait for E2-a job completion · 1m40s\n  └ ✓ Queue menu calibration job · 10m00s',
      '⚙️ background work (1):\n• Factuwin tests on AWS Windows · 1h14m\n  └ ✗ Wait for E2-a job completion · 2m40s — job E2-a: exit code 2',
    ]);
  });

  it('the last post nests what finished together', async () => {
    const b = await launched([AGENT, QUEUE, WAIT]);
    await finish(b, [AGENT.taskId, QUEUE.taskId, WAIT.taskId], 3 * min);   // one quiet pulse
    await finish(b, [], 3 * min + 15 * sec);
    expect(posts(b).slice(1)).toEqual(['✓ background work done:\n✓ Factuwin tests on AWS Windows · 1h15m\n  └ ✓ Queue menu calibration job · 12m00s\n  └ ✓ Wait for E2-a job completion · 3m40s']);
  });

  it('a task whose agent is not in the post stands on its own: an agent not listed at all, or one that finished in an earlier post', async () => {
    const STRAY = { taskId: 'bx1', parentTaskId: 'a-gone', description: 'Tail the build log', since: T0 - 5 * min };
    const b = await launched([AGENT, QUEUE, WAIT, STRAY]);
    await finish(b, [AGENT.taskId], 1 * min);                         // the agent ends in this post: its tasks still under it
    await finish(b, [QUEUE.taskId], 2 * min);                         // …and is gone from the next one
    expect(posts(b)).toEqual([
      '⚙️ background work (4):\n• Factuwin tests on AWS Windows · 1h12m\n  └ Queue menu calibration job · 9m00s\n  └ Wait for E2-a job completion · 40s\n• Tail the build log · 5m00s',
      '⚙️ background work (3):\n• Tail the build log · 6m00s\n✓ Factuwin tests on AWS Windows · 1h13m\n  └ Queue menu calibration job · 10m00s\n  └ Wait for E2-a job completion · 1m40s',
      '⚙️ background work (2):\n• Wait for E2-a job completion · 2m40s\n• Tail the build log · 7m00s\n✓ Queue menu calibration job · 11m00s',
    ]);
  });

  it('an agent an agent launched: two levels, in whatever order the CLI lists them — labelled line by line when not all the poster\'s', async () => {
    const BUILD = { taskId: 'a2', parentTaskId: AGENT.taskId, description: 'Build the installer', since: T0 - 30 * min };
    const UPLOAD = { taskId: 'b9', parentTaskId: 'a2', description: 'Upload to S3', since: T0 - 2 * min };
    const LINT = { being: 'leo', taskId: 'b7', description: 'Lint the repo', since: T0 - 1 * min };
    const b = await launched([UPLOAD, LINT, AGENT, BUILD]);
    await finish(b, [UPLOAD.taskId], 1 * min);
    expect(posts(b)).toEqual([
      '⚙️ background work (4):\n• leo — Lint the repo · 1m00s\n• E — Factuwin tests on AWS Windows · 1h12m\n  └ E — Build the installer · 30m00s\n    └ E — Upload to S3 · 2m00s',
      '⚙️ background work (3):\n• leo — Lint the repo · 2m00s\n• E — Factuwin tests on AWS Windows · 1h13m\n  └ E — Build the installer · 31m00s\n    └ ✓ E — Upload to S3 · 3m00s',
    ]);
  });

  it('the CLI\'s ambient tasks are in no status: not listed, not counted, and they keep none going', async () => {
    const WATCH = { taskId: 'w1', parentTaskId: AGENT.taskId, description: 'Watch the job log', since: T0 - 9 * min, ambient: true };
    const INBOX = { taskId: 'm1', description: 'Monitor the inbox', since: T0 - 3 * min, ambient: true };
    const b = await launched([AGENT, WATCH, INBOX]);
    await finish(b, [AGENT.taskId], 1 * min);                         // the watchers run on: one quiet pulse…
    await finish(b, [], 1 * min + 15 * sec);                          // …and the last post
    expect(posts(b)).toEqual(['⚙️ background work (1):\n• Factuwin tests on AWS Windows · 1h12m', '✓ background work done:\n✓ Factuwin tests on AWS Windows · 1h13m']);
    const quiet = await launched([INBOX]);
    await ticks(quiet, 2 * min, 3 * min);
    expect(posts(quiet)).toEqual([]);                                 // a turn leaving only ambient tasks posts nothing
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
    expect(posts(b).filter((p) => p.startsWith('✓'))).toEqual([]);  // …and the work's status runs on: it is not done
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
