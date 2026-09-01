// A RELAYED TURN IS A TURN (operator 2026-08-31, after the live fault).
//
// THE FAULT. The operator wrote in a WhatsApp group whose E is reached over the mesh, E began
// answering, he wrote again — and got a SECOND bare "🤔 thinking…" instead of a queued indication
// or his line woven into the running turn. Measured on the responder, two envelopes for one origin
// conversation, BEFORE this change:
//
//     brain.turn calls  : 2     ← both in flight; warm-sessions.mjs chains them at the POOL
//     scopeOf consulted : 0     ← the spine never sees either
//     allowNewInput     : 0
//     steer             : 0
//     frames            : [ '🤔 thinking…', '🤔 thinking…' ]
//
// The turns WERE serialized, by the warm pool, so nothing raced the session file. What was missing
// is everything the SPINE would have provided: the per-conversation FIFO, the queued placeholder,
// the allow_new_input steer, the scopeOf instance resolution. All of it was closure-private to
// createSpine, so src/spine/mesh.mjs called brain.turn bare. It now lives in src/spine/turns.mjs
// and boot.mjs injects ONE instance into both services.
//
// AND AT THE ORIGIN. The origin's own mesh branch returns ABOVE the steer path, so a second
// @being.node line opened a second placeholder there too. The obvious fix — ask the responder,
// invent a "folded in" wire frame — was ruled out: "the mesh is only transport". The placeholder's
// lifecycle belongs to the ORIGIN, which already knows a relay is unanswered, so it applies
// allow_new_input on its OWN side before forwarding and simply opens no second placeholder.
// Nothing new crosses the wire.
import { describe, it, expect } from 'vitest';
import { createMeshService } from '../src/spine/mesh.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createTurns } from '../src/spine/turns.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

function fakeBridge({ chatIds = {} } = {}) {
  const b = {
    sent: [], statusPosts: [], streams: [], reactions: [],
    onMessage() {}, stop() {},
    async resolveChatId(name) { return (name in chatIds) ? chatIds[name] : name; },
    send(chat, text) { b.sent.push({ chat, text }); return { ok: true }; },
    async postStatus(chat, text) { const id = `post-${b.statusPosts.length + 1}`; b.statusPosts.push({ chat, text, id }); return id; },
    async react(chatId, msgId, emoji) { b.reactions.push({ chatId, msgId, emoji }); return true; },
    startStream(chat, init, opts = {}) {
      const h = { chat, init, opts, updates: [], finals: [] };
      h.update = (t) => h.updates.push(t);
      h.finish = async (t) => { h.finals.push(t); };
      b.streams.push(h);
      return h;
    },
  };
  return b;
}

// A Brain whose FIRST turn hangs, so a second message genuinely arrives mid-turn, and whose
// spine-side seams are all counted — the counter table above is exactly these four.
function countingBrain({ allow = 'same_sender', steerTakes = true, seams = true } = {}) {
  const counts = { turn: 0, scopeOf: 0, allowNewInput: 0, steer: 0 };
  const order = [];
  let release = null;
  const brain = {
    counts, order, calls: [],
    release: () => { release?.(); release = null; },
    async turn(being, ev) {
      const i = counts.turn++;
      brain.calls.push({ being, ev });
      order.push(`start:${ev.body}`);
      if (i === 0) await new Promise((r) => { release = r; });
      order.push(`end:${ev.body}`);
      return { text: `reply-${ev.body}` };
    },
    async scopeOf(being, ev) { counts.scopeOf++; return ev; },
  };
  if (seams) {
    brain.allowNewInput = async () => { counts.allowNewInput++; return allow; };
    brain.steer = () => { counts.steer++; return steerTakes; };
  }
  return brain;
}

const CHANNEL = 'egpt-mesh-do-kg';
const GROUP = 'perrito traducciones';
const chatIds = { [GROUP]: 'do-perrito' };
const persona = { e: { configuration: 'egpt', name: 'e' } };
const req = (body, post_id, by = 'An') => encodeMesh({ by, body, from: GROUP, from_node: 'kg', to: 'e.do', post_id });

function responder({ brain, wired = true } = {}) {
  const bridge = fakeBridge({ chatIds });
  const turns = wired ? createTurns({ brain, bridge }) : null;
  const mesh = createMeshService({
    bridge, brain,
    getConfig: () => ({ node_name: 'do', agents: persona }),
    bodyEmojiOf: () => '',
    ...(turns ? { turns } : {}),
    onLog: () => {},
  });
  return { bridge, mesh, turns };
}

// The body of each opened placeholder frame, decoded out of the envelope it travels in.
const frames = (bridge) => bridge.streams.map((s) => parseMesh(s.init).body);

describe('PART 1 — a relayed turn runs on the SPINE\'S OWN turn machinery', () => {
  it('REPRODUCE: two envelopes for ONE origin conversation used to run TWO concurrent turns under TWO bare placeholders', async () => {
    // The whole counter table, now: the spine's machinery IS consulted, only one turn is ever in
    // flight, and the second placeholder says it is waiting rather than repeating the first.
    const brain = countingBrain({ allow: 'none' });
    const { bridge, mesh } = responder({ brain });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('@e pon musica', 'p1') });
    await flush();
    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm2', body: req('@e y sube el volumen', 'p2') });
    await flush();

    expect(brain.counts.turn).toBe(1);                 // was 2, both in flight
    expect(brain.counts.scopeOf).toBeGreaterThan(0);   // was 0
    expect(brain.counts.allowNewInput).toBe(1);        // was 0 — asked once, for the second envelope
    expect(brain.counts.steer).toBe(0);                // allow_new_input: none ⇒ queue, never weave
    expect(frames(bridge)).toEqual(['🤔 thinking…', '🤔 waiting behind 1…']);

    // …and the queued turn runs only after the live one finishes, never beside it.
    brain.release();
    await flush();
    expect(brain.counts.turn).toBe(2);
    expect(brain.order).toEqual([
      'start:pon musica', 'end:pon musica',
      'start:y sube el volumen', 'end:y sube el volumen',
    ]);
    // the queued placeholder flips to live when its turn starts (the local activate())
    expect(parseMesh(bridge.streams[1].updates[0]).body).toBe('🤔 thinking…');
  });

  it('the SECOND envelope is WOVEN into the live turn when allow_new_input admits — no stream, no turn, no envelope', async () => {
    const brain = countingBrain({ allow: 'same_sender' });
    const { bridge, mesh } = responder({ brain });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('@e pon musica', 'p1') });
    await flush();
    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm2', body: req('@e mejor algo tranquilo', 'p2') });
    await flush();

    expect(brain.counts.steer).toBe(1);
    expect(brain.counts.turn).toBe(1);                 // the live turn answers BOTH lines
    expect(bridge.streams).toHaveLength(1);            // NOTHING new for the conversation
    expect(bridge.sent).toEqual([]);
    // NO 👀 either: the ack goes on the inbound message, and the real message lives on the ORIGIN
    // node's account (meshEv has msgId: null), so there is nothing here to react to.
    expect(bridge.reactions).toEqual([]);
  });

  it('same_sender is answered off the wire\'s own `by:` — a DIFFERENT asker queues instead of hijacking the turn', async () => {
    // meshEv's senderId is null by design, so a naive same_sender read would match EVERY relayed
    // envelope against every other and weave a stranger's line into someone else's turn.
    const brain = countingBrain({ allow: 'same_sender' });
    const { bridge, mesh } = responder({ brain });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('@e pon musica', 'p1', 'An') });
    await flush();
    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm2', body: req('@e y yo quiero otra', 'p2', 'Marina') });
    await flush();

    expect(brain.counts.steer).toBe(0);                // not the same person — no weave
    expect(frames(bridge)).toEqual(['🤔 thinking…', '🤔 waiting behind 1…']);
  });

  it('an UNNAMEABLE asker never reads as "the same person" — two anonymous envelopes queue', async () => {
    // relayOut stamps `by: someone` when the origin surface gave it no sender name. A shared
    // sentinel would make two strangers match; each gets a per-turn unique identity instead.
    const brain = countingBrain({ allow: 'same_sender' });
    const { bridge, mesh } = responder({ brain });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('@e uno', 'p1', 'someone') });
    await flush();
    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm2', body: req('@e dos', 'p2', 'someone') });
    await flush();

    expect(brain.counts.steer).toBe(0);
    expect(frames(bridge)).toEqual(['🤔 thinking…', '🤔 waiting behind 1…']);
  });

  it('allow_new_input: any weaves ANY asker in', async () => {
    const brain = countingBrain({ allow: 'any' });
    const { bridge, mesh } = responder({ brain });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('@e uno', 'p1', 'An') });
    await flush();
    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm2', body: req('@e dos', 'p2', 'Marina') });
    await flush();

    expect(brain.counts.steer).toBe(1);
    expect(bridge.streams).toHaveLength(1);
  });

  it('a steer the pool REFUSES (no inject — llama/pi) is "nothing happened": the envelope queues normally', async () => {
    const brain = countingBrain({ allow: 'any', steerTakes: false });
    const { bridge, mesh } = responder({ brain });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('@e uno', 'p1') });
    await flush();
    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm2', body: req('@e dos', 'p2') });
    await flush();

    expect(brain.counts.steer).toBe(1);
    expect(frames(bridge)).toEqual(['🤔 thinking…', '🤔 waiting behind 1…']);
  });

  it('DIFFERENT origin conversations still run FULLY CONCURRENTLY — the queue is per conversation, not per channel', async () => {
    const brain = countingBrain({ allow: 'none' });
    const { bridge, mesh } = responder({ brain });
    const other = (body, post_id) => encodeMesh({ by: 'An', body, from: 'Radio WnL', from_node: 'kg', to: 'e.do', post_id });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('@e uno', 'p1') });
    await flush();
    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm2', body: other('@e dos', 'p2') });
    await flush();

    expect(brain.counts.turn).toBe(2);                 // both live: different keys
    expect(frames(bridge)).toEqual(['🤔 thinking…', '🤔 thinking…']);
  });

  it('LOCK: a mesh service with NO turns service is byte-identical to before — no queue, no steer, no depth', async () => {
    // Every existing caller and every test fake. The seam is optional precisely so this stays true.
    const brain = countingBrain({ allow: 'any' });
    const { bridge, mesh } = responder({ brain, wired: false });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('@e uno', 'p1') });
    await flush();
    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm2', body: req('@e dos', 'p2') });
    await flush();

    expect(brain.counts).toEqual({ turn: 2, scopeOf: 0, allowNewInput: 0, steer: 0 });
    expect(frames(bridge)).toEqual(['🤔 thinking…', '🤔 thinking…']);
  });

  it('a LOCAL message and a RELAYED turn in the SAME conversation meet on the SAME queue', async () => {
    // f70edce put the relayed turn in the ORIGIN conversation, so both derive the same key. That
    // collision is the reason ONE shared instance is required rather than one per service.
    const brain = countingBrain({ allow: 'none' });
    const bridge = fakeBridge({ chatIds });
    const turns = createTurns({ brain, bridge });
    const mesh = createMeshService({
      bridge, brain, turns, getConfig: () => ({ node_name: 'do', agents: persona }), bodyEmojiOf: () => '', onLog: () => {},
    });
    const opened = [];
    const spine = createSpine({
      bridge, brain, turns,
      identity: { build: (m) => ({ ...m, line: m.body }) },
      router: { resolve: () => ({ being: 'e', mention: { atEStart: true, atEAnywhere: true, replyToBot: false } }) },
      gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
      sender: { open(chatId, opts) { opened.push(opts); return { activate() {}, update() {}, fail() {}, async finish() {}, confirmedId: Promise.resolve(null) }; } },
      transcript: { async log() {} }, heartbeats: { runDue() {} },
      clock: { now: () => 1 },
    });

    // the RELAYED turn opens first, in the origin conversation ('do-perrito')…
    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('@e pon musica', 'p1') });
    await flush();
    expect(brain.counts.turn).toBe(1);
    // …and a LOCAL message in that very chat queues behind it instead of running beside it.
    spine.handleInbound({ surface: 'whatsapp', node: 'wa', chatId: 'do-perrito', chatName: GROUP, senderId: 'u-local', senderName: 'An', msgId: 'lm1', ts: 1, kind: 'text', body: '@e hola', raw: {} });
    await flush();
    expect(brain.counts.turn).toBe(1);
    expect(opened[0]).toMatchObject({ queued: true, queuedAhead: 1 });
  });
});

// ── PART 2 — THE ORIGIN DECIDES THE STEER, SO NOTHING CROSSES THE WIRE ──────────────────────
function origin({ allow = 'same_sender', beingOf = () => 'don' } = {}) {
  const bridge = fakeBridge();
  const timers = [];
  const brain = {
    calls: [],
    async turn(b, ev) { brain.calls.push({ b, ev }); return { text: 'x' }; },
    async allowNewInput() { return allow; },
    steer: () => true,
  };
  const mesh = createMeshService({
    bridge, brain,
    getConfig: () => ({ node_name: 'kg', agents: { don: { relay_channel: 'RELAY', to: 'e.do' } } }),
    bodyEmojiOf: () => '',
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
    onLog: () => {},
  });
  const spine = createSpine({
    bridge, brain,
    identity: { build: (m) => ({ ...m }) },
    router: { resolve: (ev) => { const b = beingOf(ev); return { being: null, mesh: { being: b, route: { room_id: 'RELAY' }, to: `e.${b === 'don' ? 'do' : 'kg2'}` }, mention: { atEStart: true, atEAnywhere: true, replyToBot: false } }; } },
    gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
    sender: { open() { return { activate() {}, update() {}, fail() {}, async finish() {} }; } },
    transcript: { async log() {} }, heartbeats: { runDue() {} },
    mesh, clock: { now: () => 1 },
  });
  const line = (body, msgId, senderId = 'u-an', senderName = 'An') =>
    spine.handleInbound({ surface: 'whatsapp', node: 'wa', chatId: 'CHAT', chatName: 'fam', senderId, senderName, msgId, ts: 1, kind: 'text', body, raw: {} });
  return { bridge, mesh, spine, timers, line };
}

describe('PART 2 — the ORIGIN decides the steer, so nothing crosses the wire', () => {
  it('REPRODUCE: a second @being.node line while the relay is unanswered used to open a SECOND 🤔', async () => {
    const { bridge, timers, line } = origin();

    await line('@don pon musica', 'm1'); await flush();
    await line('@don y sube el volumen', 'm2'); await flush();

    expect(bridge.statusPosts.map((p) => p.text)).toEqual(['🤔 thinking…']);   // was two
    expect(bridge.sent).toHaveLength(2);                                       // BOTH lines still travel
    expect(timers).toHaveLength(1);                                            // …and no second "did not answer" clock
    // Nothing new on the wire: the quiet envelope is an ordinary request, carrying a correlation
    // id like every other one.
    const p2 = parseMesh(bridge.sent[1].text);
    expect(p2).toMatchObject({ to: 'e.do', from: 'fam', from_node: 'kg', by: 'An', body: '@don y sube el volumen' });
    expect(p2.post_id).toBeTruthy();
    expect(p2.post_id).not.toBe(parseMesh(bridge.sent[0].text).post_id);
  });

  it('DEGRADES SAFELY: the responder QUEUES instead of weaving ⇒ the reply posts FRESH, nothing strands', async () => {
    // The origin bets on the weave; the responder is free to disagree (a same_sender chat over a
    // pi/llama being, or a turn that ended between the two). Its reply still comes home — carrying
    // the SYNTHETIC post_id the quiet forward minted, which openOriginStream never PATCHes — so it
    // opens its own message rather than resolving a placeholder that was never opened.
    const { bridge, mesh, line } = origin();

    await line('@don pon musica', 'm1'); await flush();
    await line('@don y sube el volumen', 'm2'); await flush();
    const quietPostId = parseMesh(bridge.sent[1].text).post_id;

    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'r2', body: encodeMesh({ by: 'e.do', body: 'subido', re: 'fam.kg', post_id: quietPostId, done: true }) });
    await flush();

    const mirror = bridge.streams.at(-1);
    expect(mirror.chat).toBe('CHAT');
    expect(mirror.opts.existingMsgId).toBeNull();     // a FRESH post, not an edit of something absent
    expect(mirror.finals).toEqual(['subido']);
  });

  it('a DIFFERENT sender under same_sender still gets its OWN placeholder and its own wait clock', async () => {
    const { bridge, timers, line } = origin();

    await line('@don pon musica', 'm1'); await flush();
    await line('@don y yo quiero otra', 'm2', 'u-marina', 'Marina'); await flush();

    expect(bridge.statusPosts.map((p) => p.text)).toEqual(['🤔 thinking…', '🤔 thinking…']);
    expect(timers).toHaveLength(2);
  });

  it('allow_new_input: none never goes quiet — today\'s behaviour, byte for byte', async () => {
    const { bridge, timers, line } = origin({ allow: 'none' });

    await line('@don uno', 'm1'); await flush();
    await line('@don dos', 'm2'); await flush();

    expect(bridge.statusPosts).toHaveLength(2);
    expect(timers).toHaveLength(2);
  });

  it('once the relay FINISHES (done:true), the next line opens its own placeholder again', async () => {
    const { bridge, mesh, line } = origin();

    await line('@don pon musica', 'm1'); await flush();
    const postId = parseMesh(bridge.sent[0].text).post_id;
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'r1', body: encodeMesh({ by: 'e.do', body: 'listo', re: 'fam.kg', post_id: postId, done: true }) });
    await flush();

    await line('@don otra cosa', 'm2'); await flush();
    expect(bridge.statusPosts.map((p) => p.text)).toEqual(['🤔 thinking…', '🤔 thinking…']);
  });

  it('two DIFFERENT remote beings in one chat are two independent relays — the second keeps its own placeholder', async () => {
    // The ledger is keyed by being as well as conversation, exactly as the local turn key is: a
    // turn `don` is running is not a turn `wren`'s line could ever be folded into.
    const { bridge, timers, line } = origin({ beingOf: (ev) => (String(ev.body).startsWith('@wren') ? 'wren' : 'don') });

    await line('@don pon musica', 'm1'); await flush();
    await line('@wren y tu que dices', 'm2'); await flush();

    expect(bridge.statusPosts.map((p) => p.text)).toEqual(['🤔 thinking…', '🤔 thinking…']);
    expect(timers).toHaveLength(2);
  });

  it('a mesh service WITHOUT the relayInFlight seam is never quiet — an older/faked service is unchanged', async () => {
    const forwarded = [];
    const bridge = fakeBridge();
    const brain = { async turn() { return { text: 'x' }; }, async allowNewInput() { return 'any'; }, steer: () => true };
    const spine = createSpine({
      bridge, brain,
      identity: { build: (m) => ({ ...m }) },
      router: { resolve: () => ({ being: null, mesh: { being: 'don', route: { room_id: 'RELAY' }, to: 'e.do' }, mention: {} }) },
      gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
      sender: { open() { return { activate() {}, update() {}, fail() {}, async finish() {} }; } },
      transcript: { async log() {} }, heartbeats: { runDue() {} },
      mesh: { isEnvelope: () => false, async handle() {}, async forward(ev, t, opts) { forwarded.push(opts); return true; }, async onEdit() { return false; } },
      clock: { now: () => 1 },
    });
    const msg = { surface: 'whatsapp', node: 'wa', chatId: 'CHAT', chatName: 'fam', senderId: 'u', senderName: 'An', ts: 1, kind: 'text', raw: {} };
    await spine.handleInbound({ ...msg, msgId: 'm1', body: '@don uno' });
    await spine.handleInbound({ ...msg, msgId: 'm2', body: '@don dos' });
    expect(forwarded).toEqual([{ quiet: false }, { quiet: false }]);
  });
});
