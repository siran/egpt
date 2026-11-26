// Two nodes, one account, one reaction (live 2026-11-25, WhatsApp "An"): kg (E, mode on) and nu (ENU) hear
// the same two Beeper accounts and each ran its emoji train on the same line from the same account. Stale 🤔s
// stayed on the operator's messages after both turns ended.
//
// The account, as the network and Beeper hold it (mautrix bridgev2 portal.go): ONE reaction per account per
// message, the last placed. Placing the glyph it already holds is ignored by the network ("Ignoring duplicate
// reaction") and the placement stays in Beeper's view; a placement the network replaced is gone; a removal takes
// the remover's own placement back, and is ignored when the network never held it. A plain single slot (no
// duplicates) never ends stale with two trains on it: each node's last write takes off its own last glyph.
//
// (1)+(2): a node runs no train on an 'on' line that addresses none of its own beings ("enu …" on kg, or "hola").
// (3): a line addressing beings on both nodes runs both trains; each end takes off only what the account shows
//      of its own glyphs (Beeper's GET message → reactions[]), so a duplicate of ours comes off too.
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender, THINKING } from '../src/spine/sender.mjs';
import { createReplyActions } from '../src/spine/reply-actions.mjs';
import { createTurns } from '../src/spine/turns.mjs';
import { makePeerMouth } from '../src/spine/boot.mjs';
import { crossAccountMsgKey } from '../src/bridges/beeper.mjs';
import { mentionStatus } from '../src/auto-mode.mjs';

const flush = () => new Promise((r) => setImmediate(r));
async function until(cond) { for (let i = 0; i < 100 && !cond(); i++) await flush(); }
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const LIST = ['🤔', '🤓', '👀'];
const MOUTH_HOLDS = { route: async () => null, mouthIsElsewhere: () => false };
const CHAT = { surface: 'whatsapp', node: 'wa', chatId: '!an', chatName: 'An', kind: 'text', raw: { chatType: 'group' }, senderId: 'u-1', senderName: 'An' };

// `script`: the order some placements land in ('kg+👾', …). One not yet due waits; one that never comes is skipped.
function account(script = []) {
  const events = [], log = [];
  const due = async (label) => {
    if (!script.includes(label)) return;
    for (let i = 0; i < 100 && script[0] !== label; i++) await flush();
    script.splice(script.indexOf(label), 1);
  };
  return {
    log,
    async put(by, g) {
      await due(`${by}+${g}`);
      log.push(`${by}+${g}`);
      const held = events.find((e) => e.held);
      if (held?.g === g) { events.push({ g, by, held: false }); return true; }
      if (held) events.splice(events.indexOf(held), 1);
      events.push({ g, by, held: true });
      return true;
    },
    async take(by, g) {
      log.push(`${by}-${g}`);
      const own = events.filter((e) => e.by === by && e.g === g);
      for (const e of own) events.splice(events.indexOf(e), 1);
      return own.length > 0;
    },
    shown: () => events.map((e) => e.g),
  };
}

function fakeBridge(node, acct, { reads = true, own = false } = {}) {
  let cb = null;
  const streams = [], posts = [];
  return {
    streams, posts,
    onMessage(fn) { cb = fn; }, emit(m) { return cb(m); }, stop() {},
    send(chat, text) { posts.push(text); return { ok: true }; },
    startStream(chat, init, opts) {
      const h = { chat, init, opts, frames: [], finals: [], delivered: false, confirmedId: `${chat}#${streams.length + 1}`, update(t) { h.frames.push(t); }, async finish(t) { h.finals.push(t); h.delivered = true; posts.push(t); } };
      streams.push(h);
      return h;
    },
    react: (chat, msgId, g) => acct.put(node, g),
    unreact: (chat, msgId, g) => acct.take(node, g),
    ...(reads ? { ownReactions: async () => acct.shown() } : {}),
    ...(own ? { beingAccount: true } : {}),
  };
}

function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    setTimeout: (fn) => { const id = ++n; pending.set(id, fn); return { id, unref() {} }; },
    clearTimeout: (t) => { if (t?.id != null) pending.delete(t.id); },
    fire() { const all = [...pending.values()]; pending.clear(); for (const fn of all) fn(); },
  };
}

// One node: its own beings, its own spine, the shared account. `work(being)` answers each turn.
// `chatType`: the chat's ('group' by default); `own`: the account is the being's own (a bot).
function node(name, acct, { agents, work, train, reads, chatType = 'group', own = false } = {}) {
  const config = { conversation_defaults: { allowed_users: ['u-1'] }, agents, ...(train ? { dispatch: { thinking_train: train } } : {}) };
  const bridge = fakeBridge(name, acct, { reads, own });
  const brain = { calls: [], async turn(being, ev) { brain.calls.push(being); return work(being); } };
  const frames = fakeTimers();
  const log = { line() {} };
  const spine = createSpine({
    bridge, brain, transcript: { async log() {} }, defaultBeing: Object.keys(agents)[0], peerMouth: MOUTH_HOLDS, turnTimeoutMs: 0,
    sender: createSender({ bridge, peerMouth: MOUTH_HOLDS, bodyEmojiOf: () => '🐶', labelOf: (b) => b, onLog() {}, now: () => 1 }),
    actions: createReplyActions({ bridge, peerMouth: MOUTH_HOLDS, bodyEmojiOf: () => '🐶', labelOf: (b) => b, onLog() {} }),
    router: createRouter({ getAgents: () => agents, getConfig: () => config }),
    gating: createGating({ getConfig: () => config }),
    identity: { build: (m) => ({ ...m, line: m.body }) },
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now: () => 1 },
    setTimeout: fakeTimers().setTimeout, clearTimeout: () => {}, rng: () => 0.5, log,
    turns: createTurns({ brain, bridge, peerMouth: MOUTH_HOLDS, log, thinkingFrames: () => LIST, setTimeout: frames.setTimeout, clearTimeout: frames.clearTimeout }),
  });
  spine.start();
  const handles = Object.values(agents).flatMap((a) => a.handles);
  return { bridge, brain, frames, emit: (body) => bridge.emit({ ...CHAT, raw: { chatType }, body, msgId: 'm1', ts: 1, mention: { ...mentionStatus(body, handles), replyToBot: false } }) };
}

const E = { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], mode: 'on' } };
const ENU = { enu: { configuration: 'enu', handles: ['enu'], mode: 'on' } };
// kg and nu on one account; each being's turn waits for its gate, then answers `says[being]`.
function pair(says, script) {
  const acct = account(script);
  const g = { egpt: gate(), enu: gate() };
  const work = (being) => g[being].p.then(() => ({ text: says[being] }));
  return { acct, g, kg: node('kg', acct, { agents: E, work }), nu: node('nu', acct, { agents: ENU, work }) };
}
// Both nodes' last turn steps: kg's frame, then kg ends; nu's frame, then nu ends.
async function play({ acct, g, kg, nu }, line) {
  const done = [kg.emit(line), nu.emit(line)];
  await until(() => kg.brain.calls.length + nu.brain.calls.length === 2 || acct.log.length >= 4);
  await flush(); await flush();
  kg.frames.fire(); await flush();
  g.egpt.open(); await flush(); await flush();
  nu.frames.fire(); await flush();
  g.enu.open();
  await Promise.all(done);
  for (let i = 0; i < 5; i++) await flush();
}

describe('two nodes, one account: no stale glyph once both turns end', () => {
  it('REPRODUCE (live 2026-11-25): "enu hola" — kg\'s E (on) is not addressed and stays silent; nu\'s ENU answers', async () => {
    const p = pair({ egpt: '…', enu: 'Hola.' }, ['kg+👾', 'nu+👾', 'kg+🤔', 'nu+🤔']);
    await play(p, 'enu hola');
    expect(p.acct.shown()).toEqual([]);
    expect(p.acct.log.filter((s) => s.startsWith('kg'))).toEqual([]);      // (1) kg runs no train on it
    expect(p.kg.bridge.posts).toEqual([]);                                  // E's '…' stays unposted
    expect(p.nu.bridge.posts).toEqual(['Hola.']);
  });

  it('REPRODUCE: "enu @egpt hola" — both addressed, both trains; each end takes off its own, duplicates included', async () => {
    const p = pair({ egpt: 'Sí.', enu: 'Hola.' }, ['kg+👾', 'nu+👾', 'kg+🤔', 'nu+🤔']);
    await play(p, 'enu @egpt hola');
    expect(p.acct.log.filter((s) => s[2] === '+').length).toBeGreaterThanOrEqual(2);   // both nodes ran a train
    expect(p.acct.shown()).toEqual([]);
    expect(p.kg.bridge.posts).toEqual(['Sí.']);
    expect(p.nu.bridge.posts).toEqual(['Hola.']);
  });

  it('(2) "hola" addresses no one: neither node marks it; a being that answers posts its reply, as before', async () => {
    const p = pair({ egpt: 'Hola, An.', enu: '…' });
    await play(p, 'hola');
    expect(p.acct.log).toEqual([]);
    expect(p.kg.bridge.posts).toEqual(['Hola, An.']);
    expect(p.nu.bridge.posts).toEqual([]);
  });
});

describe('one node (lock): 👾 → 🤔 → frames → off; an addressed silence shows "…"', () => {
  // Ruling 2026-11-25: the rule is a group's. A 1:1's line is for the being; a bot's account is its own.
  for (const [where, opts] of [['a 1:1', { chatType: 'private' }], ["a group on the being's own account (a bot)", { own: true }]]) {
    it(`${where}: an unaddressed 'on' line still gets 👾 → 🤔, off at the end`, async () => {
      const acct = account(), g = gate();
      const kg = node('kg', acct, { agents: E, ...opts, work: () => g.p.then(() => ({ text: '…' })) });
      const done = kg.emit('hola');
      await until(() => kg.brain.calls.length);
      await flush();
      expect(acct.log).toEqual(['kg+👾', 'kg+🤔']);
      g.open();
      await done;
      for (let i = 0; i < 5; i++) await flush();
      expect(acct.log).toEqual(['kg+👾', 'kg+🤔', 'kg-🤔']);
      expect(kg.bridge.posts).toEqual([]);                 // unaddressed: its '…' stays unposted
    });
  }

  for (const reads of [true, false]) {
    it(`the train, with the account's reactions ${reads ? 'readable' : 'unknown'}`, async () => {
      const acct = account(), g = gate();
      const kg = node('kg', acct, { agents: E, reads, work: () => g.p.then(() => ({ text: '…' })) });
      const done = kg.emit('@e hola');
      await until(() => kg.brain.calls.length);
      await flush();
      kg.frames.fire(); await flush();
      kg.frames.fire(); await flush();
      g.open();
      await done;
      for (let i = 0; i < 5; i++) await flush();
      expect(acct.log).toEqual(['kg+👾', 'kg+🤔', 'kg+🤓', 'kg+👀', 'kg-👀']);
      expect(acct.shown()).toEqual([]);
      expect(kg.bridge.posts).toEqual(['…']);
    });
  }

  it('bubble: an addressed line opens ⏳ with no mark; an unaddressed one gets ✍️, off at the end', async () => {
    const acct = account();
    const kg = node('kg', acct, { agents: E, train: 'bubble', work: async () => ({ text: '…' }) });
    await kg.emit('@e hola');
    await flush();
    expect(kg.bridge.streams.map((s) => [s.init, s.finals])).toEqual([[THINKING, ['✓']]]);
    expect(acct.log).toEqual([]);
    await kg.bridge.emit({ ...CHAT, body: 'qué calor', msgId: 'm2', ts: 1, mention: { replyToBot: false } });
    for (let i = 0; i < 5; i++) await flush();
    expect(acct.log).toEqual(['kg+✍️', 'kg-✍️']);
    expect(acct.shown()).toEqual([]);
  });
});

describe("the end: only what the account shows of this train's glyphs comes off", () => {
  const EV = { surface: 'whatsapp', chatId: '!an', msgId: 'm1', msgHash: 'h', msgTs: 1 };
  const build = (acct, by, frames = () => LIST) => {
    const t = fakeTimers();
    const turns = createTurns({ brain: {}, bridge: fakeBridge(by, acct), peerMouth: MOUTH_HOLDS, thinkingFrames: frames, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
    return { turns, t };
  };

  it("another node's glyph showing stays", async () => {
    const acct = account();
    const { turns } = build(acct, 'kg');
    const m = turns.train('egpt', EV);
    m.started();
    await flush();
    await acct.put('nu', '👀');
    await m.off();
    expect(acct.log.slice(-1)).toEqual(['nu+👀']);
    expect(acct.shown()).toEqual(['👀']);
  });

  it('an earlier glyph of ours still showing (a duplicate the network ignored) comes off with the last', async () => {
    const acct = account();
    const { turns, t } = build(acct, 'kg');
    const m = turns.train('egpt', EV);
    await flush();
    await acct.put('nu', '🤔');
    m.started();                                         // kg's 🤔 lands over nu's: a duplicate
    await flush();
    await acct.take('nu', '🤔');                          // nu's turn ends
    t.fire(); await flush();                             // kg's 🤓 is what the network holds now
    expect(acct.shown().sort()).toEqual(['🤓', '🤔'].sort());
    await m.off();
    expect(acct.shown()).toEqual([]);
  });

  it('a read that shows nothing of ours (or cannot tell our account) still takes the last glyph off', async () => {
    const acct = account();
    const bridge = { ...fakeBridge('kg', acct), ownReactions: async () => [] };
    const m = createTurns({ brain: {}, bridge, peerMouth: MOUTH_HOLDS, thinkingFrames: () => ['🤔'] }).train('egpt', EV);
    m.started();
    await flush();
    await m.off();
    expect(acct.log).toEqual(['kg+👾', 'kg+🤔', 'kg-🤔']);
    expect(acct.shown()).toEqual([]);
  });

  it("after the handover the mouth's own copy is read: another node's glyph there stays, our duplicate comes off", async () => {
    const TS = Date.parse('2026-10-31T02:53:07.260Z');
    const onEar = { id: '41174', text: 'w', timestamp: TS }, onMouth = { id: '17743', text: 'w', timestamp: '2026-10-31T02:53:08.000Z' };
    const ev = { ...EV, msgId: onEar.id, msgHash: crossAccountMsgKey(onEar), msgTs: TS };
    const holder = account(), mouthAcct = account();
    const mouthBridge = { ...fakeBridge('kg', mouthAcct), recentMessages: () => [onMouth], awaitMessage: async () => null };
    const ear = fakeBridge('kg', holder);
    const mouth = makePeerMouth({ peer: null, bridge: ear, localMouth: () => ({ name: 'secondary', home: 'primary', bridge: mouthBridge }), onLog() {} });
    const peerMouth = { ...mouth, route: async () => ({ connection: 'secondary', bridge: mouthBridge, chatId: 'mouth-1' }) };
    const t = fakeTimers();
    await mouthAcct.put('nu', '🤔');                     // nu's train holds the mouth
    const m = createTurns({ brain: {}, bridge: ear, peerMouth, thinkingFrames: () => LIST, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout }).train('egpt', ev);
    m.started();
    for (let i = 0; i < 5; i++) await flush();          // 👾, 🤔 on the holder; the 🤔 moves to the mouth: a duplicate there
    expect(holder.shown()).toEqual([]);
    t.fire(); await flush();                             // kg's 🤓 holds the mouth
    await mouthAcct.put('nu', '👀');                     // then nu's 👀
    expect(mouthAcct.shown()).toEqual(['🤔', '👀']);
    await m.off();
    expect(mouthAcct.shown()).toEqual(['👀']);
    expect(mouthAcct.log.filter((s) => s.startsWith('kg-'))).toEqual(['kg-🤔']);
  });

  it("random frames never draw a steer's glyph (✍️, 👍) or the arrival's 👾", async () => {
    const acct = account(), t = fakeTimers();
    let i = 0;
    const turns = createTurns({ brain: {}, bridge: fakeBridge('kg', acct), peerMouth: MOUTH_HOLDS, thinkingFrames: () => 'random', setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, rng: () => (i++ % 100) / 100 });
    const m = turns.train('egpt', EV);
    m.started();
    for (let k = 0; k < 300; k++) { t.fire(); await flush(); }
    await m.off();
    const drawn = new Set(acct.log.slice(2).map((s) => s.slice(3)));
    expect(drawn.size).toBeGreaterThan(40);
    for (const g of ['✍️', '👍', '👾']) expect(drawn.has(g)).toBe(false);
  });

  it('a glyph read back without its U+FE0F is still ours', async () => {
    const acct = account();
    const bridge = { ...fakeBridge('kg', acct), ownReactions: async () => acct.shown().map((g) => g.replace(/\uFE0F/g, '')) };
    const m = createTurns({ brain: {}, bridge, peerMouth: MOUTH_HOLDS, thinkingFrames: () => ['❤️'] }).train('egpt', EV);
    m.started();
    await flush();
    await m.off();
    expect(acct.shown()).toEqual([]);
  });
});
