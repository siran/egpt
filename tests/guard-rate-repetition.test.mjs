// guard-rate-repetition.test.mjs — THE LIVE LOOP, kg 2026-09-20, "🌴FAMILIA PALMA🌴"
// (whatsapp:aYFq5skcCliVAmwIhRqH). The channel was auto-STOPped at 00:35:50 and nobody noticed
// until 08:21; every message in between logged `stopped — prompt suppressed`, including the
// operator's own `@ken @don @e están?`, and his wife wrote "Todos se desconectaron… 😂" at 01:32.
//
// The six turns that filled the cap arrived in FIVE SECONDS and were the spine's OWN bookkeeping:
//   00:35:38 incoming An:   "estas por ahi perrito 🐕?"
//   00:35:40 incoming Rodz: "🐶 E: ⏳ Thinking… 🏰<kg/egpt>"
//   00:35:41 incoming Rodz: "🐶 E: ⏳ Queued (1 ahead)… 🏰<kg/egpt>"
//   00:35:50 guard: … auto-STOP — 6 consecutive non-human turns
// E's own placeholders, posted through the mouth account and carrying THIS node's signature,
// came back through Beeper, classified non-human, and each consumed a guard slot.
//
// THREE RULINGS ARE LOCKED HERE (operator 2026-09-20):
//   1. "pause on repetition, not chatter" — "a chatter between bots is desired, and even
//      encouraged". This node's own echo is not a turn at all.
//   2. The cap is a RATE: "six spread over a day is the kind of conservatism we must avoid… a
//      hard limit of turns is only effective on a rapid succession".
//   3. "if the bridge pauses, it must emit warning in the channel with instructions on how to
//      recover, instead of leaving everybody hanging."
import { describe, it, expect } from 'vitest';
import { createStopGuard, turnKind } from '../src/stop-guard.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { encodeNodeSignature } from '../src/node-signature.mjs';
import { parseMesh } from '../src/mesh/relay.mjs';

const MIN = 60_000;
// THIS node is kg. Its mouth signs every frame it commits — including the ⏳ placeholders.
const SIG_KG = encodeNodeSignature('kg', 'egpt');
const SIG_DO = encodeNodeSignature('do', 'don');

// ── the spine, wired the way boot wires it: the REAL identity (so the invisible frame is
//    decoded into ev.fromNode and then rendered away, exactly as in production), the guard,
//    and `say` — boot's sayOnce, the ONE outbound placement — captured as a spy.
function buildSpine({ guard, now = () => 1000 } = {}) {
  const said = [];
  const bridge = { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false };
  const brain = { calls: [], async turn(b, ev) { this.calls.push({ b, ev }); return { text: 'x' }; } };
  const spine = createSpine({
    bridge, brain, guard,
    identity: createIdentity({ now }),
    router: { resolve: () => 'e' },
    gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: (d) => d.mayReply },
    transcript: { logged: [], async log(ev) { this.logged.push(ev); } },
    heartbeats: { runDue() {} },
    sender: { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } },
    mesh: { isEnvelope: (ev) => parseMesh(ev?.body ?? '') != null, async handle() {} },
    // boot: (ev) => ev.fromNode != null && !fromOtherNode(getConfig(), ev) — THIS node is kg.
    fromThisNode: (ev) => ev.fromNode != null && String(ev.fromNode).toLowerCase() === 'kg',
    say: async (o) => { said.push(o); return true; },
    isSelfChat: () => false,
    clock: { now },
  });
  return { spine, said, brain };
}
const CH = 'whatsapp:PALMA';
const from = (over = {}) => ({
  chatId: 'PALMA', chatName: '🌴FAMILIA PALMA🌴', network: 'whatsapp', userId: 'u-an',
  senderName: 'An', msgKey: `m${Math.random()}`, isSender: false, authorized: true, ...over,
});
// Rodz is the MOUTH account: everything E says lands back on the ear under that display name.
const rodz = (over = {}) => from({ userId: 'u-rodz', senderName: 'Rodz', isSender: true, authorized: false, ...over });

describe('1 — this node\'s OWN echo is bookkeeping, not a turn (the 2026-09-20 loop)', () => {
  it('REPRODUCE 00:35:38-00:35:50: a human ask plus E\'s own ⏳ placeholders leaves the channel running', async () => {
    const guard = createStopGuard();
    const { spine, brain } = buildSpine({ guard });

    await spine.handleInbound({ body: 'estas por ahi perrito 🐕?', from: from() });
    // …and E's own bookkeeping comes straight back through Beeper, four turns of it.
    for (let i = 0; i < 2; i++) {
      await spine.handleInbound({ body: `🐶 E: ⏳ Thinking… 🏰${SIG_KG}`, from: rodz() });
      await spine.handleInbound({ body: `🐶 E: ⏳ Queued (${i + 1} ahead)… 🏰${SIG_KG}`, from: rodz() });
    }
    expect(guard.countOf(CH)).toBe(0);         // our own output never consumed a slot…
    expect(guard.blocked(CH)).toBe(false);     // …so the channel is still alive

    // 08:21, the operator again — this is the message that was suppressed for eight hours.
    const before = brain.calls.length;
    await spine.handleInbound({ body: '@ken @don @e están?', from: from() });
    expect(brain.calls.length).toBeGreaterThan(before);
  });

  it('ANOTHER node\'s being still counts — that is real chatter, not our echo', () => {
    const isEnvelope = () => false;
    const ours = { surface: 'whatsapp', chatId: 'PALMA', body: 'hola', fromNode: 'kg' };
    const theirs = { surface: 'whatsapp', chatId: 'PALMA', body: 'hola', fromNode: 'do' };
    const person = { surface: 'whatsapp', chatId: 'PALMA', body: 'hola', fromNode: null };
    const mine = (ev) => ev.fromNode === 'kg';
    expect(turnKind(ours, { isEnvelope, fromThisNode: mine })).toBe('echo');
    expect(turnKind(theirs, { isEnvelope, fromThisNode: mine })).toBe('being');
    expect(turnKind(person, { isEnvelope, fromThisNode: mine })).toBe('human');
    // …and our own send that the bridge recognises by id is the same bookkeeping.
    expect(turnKind(person, { isEnvelope, wasSentByUs: () => true, fromThisNode: mine })).toBe('echo');
  });
});

describe('2 — the cap is a RATE, not a lifetime count', () => {
  it('six non-human turns inside the window stop the channel; the same six over three hours do not', () => {
    let t = 0;
    const fast = createStopGuard({ now: () => t });
    const hot = [];
    for (let i = 0; i < 6; i++) { t += 5_000; hot.push(fast.noteBeing('A', null, { body: `linea ${i}`, author: `bot${i}` })); }
    expect(hot.at(-1)).toBe('stop');                         // six in half a minute is the runaway
    expect(fast.countOf('A')).toBe(6);

    let u = 0;
    const slow = createStopGuard({ now: () => u });
    const actions = [];
    for (let i = 0; i < 6; i++) { u += 30 * MIN; actions.push(slow.noteBeing('A', null, { body: `linea ${i}`, author: `bot${i}` })); }
    expect(actions.every((a) => a === 'none')).toBe(true);   // six across three hours is normal life
  });

  it('the SIXTH fast turn returns stop, and the reason carries the numbers', () => {
    let t = 0;
    const g = createStopGuard({ now: () => t });
    const actions = [];
    for (let i = 0; i < 6; i++) { t += 5_000; actions.push(g.noteBeing('A', null, { body: `linea ${i}`, author: `bot${i}` })); }
    expect(actions.at(-1)).toBe('stop');
    expect(g.reasonOf('A')).toMatch(/6 non-human turns in 2 min/);
  });
});

describe('3 — pause on REPETITION: the same thing said again, however slowly', () => {
  it('the same line three times in ten minutes stops the channel and the reason names it', () => {
    let t = 0;
    const g = createStopGuard({ now: () => t });
    const line = 'estas por ahi perrito 🐕?';
    expect(g.noteBeing('A', null, { body: line, author: 'bot' })).toBe('none');
    t += 4 * MIN;
    expect(g.noteBeing('A', null, { body: line, author: 'bot' })).toBe('none');
    t += 4 * MIN;
    expect(g.noteBeing('A', null, { body: line, author: 'bot' })).toBe('stop');
    expect(g.reasonOf('A')).toContain(line);
  });

  it('the being stamp and the node signature are not part of the line', () => {
    let t = 0;
    const g = createStopGuard({ now: () => t });
    // The SAME sentence from two beings on two nodes — different bytes on the wire, one line.
    const bodies = ['🐶 E: seguimos <kg>', '🤖 don: seguimos <do>', '🐶 E: seguimos <kg>'];
    let last;
    for (const body of bodies) { t += MIN; last = g.noteBeing('A', null, { body, author: 'anyone' }); }
    expect(last).toBe('stop');
    expect(g.reasonOf('A')).toContain('seguimos');
  });

  it('an A,B,A,B alternation stops it — two bodies going nowhere', () => {
    let t = 0;
    const g = createStopGuard({ now: () => t });
    const say = (body, author) => { t += MIN; return g.noteBeing('A', null, { body, author }); };
    expect(say('¿estás?', 'ken')).toBe('none');
    expect(say('aquí estoy', 'don')).toBe('none');
    expect(say('¿estás?', 'ken')).toBe('none');
    expect(say('aquí estoy', 'don')).toBe('stop');
    expect(g.reasonOf('A')).toContain('¿estás?');
  });

  it('SIX DIFFERENT bot messages, slowly, never stop it — chatter is encouraged', () => {
    let t = 0;
    const g = createStopGuard({ now: () => t });
    const actions = [];
    for (const body of ['hola', 'qué tal', 'mira esto', 'jaja', 'te cuento', 'listo']) {
      t += 3 * MIN;
      actions.push(g.noteBeing('A', null, { body, author: 'ken' }));
    }
    expect(actions.every((a) => a === 'none')).toBe(true);
    expect(g.blocked('A')).toBe(false);
  });
});

describe('4 — a pause is ANNOUNCED in the channel, once, with the way out', () => {
  it('the stop posts one notice naming the trigger and `resume`; the warn posts nothing', async () => {
    let t = 0;
    const guard = createStopGuard({ now: () => t });
    const { spine, said } = buildSpine({ guard, now: () => 1000 });
    // four fast peer-node turns → the soft limit. Nothing is said.
    for (let i = 0; i < 4; i++) {
      t += 5_000;
      await spine.handleInbound({ body: `paso ${i}${SIG_DO}`, from: rodz({ msgKey: `do-${i}` }) });
    }
    expect(guard.blocked(CH)).toBe(false);
    expect(said).toEqual([]);

    for (let i = 4; i < 6; i++) {
      t += 5_000;
      await spine.handleInbound({ body: `paso ${i}${SIG_DO}`, from: rodz({ msgKey: `do-${i}` }) });
    }
    expect(guard.blocked(CH)).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0].chatId).toBe('PALMA');
    expect(said[0].text).toMatch(/resume/);
    expect(said[0].text).toMatch(/6 non-human turns in 2 min/);
  });

  it('a REPETITION pause names the repeated line in the channel, and `resume` brings it back', async () => {
    let t = 0;
    const guard = createStopGuard({ now: () => t });
    const { spine, said, brain } = buildSpine({ guard, now: () => 1000 });
    for (let i = 0; i < 3; i++) {
      t += 2 * MIN;
      await spine.handleInbound({ body: `otra vez lo mismo${SIG_DO}`, from: rodz({ msgKey: `do-${i}` }) });
    }
    expect(guard.blocked(CH)).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0].text).toContain('otra vez lo mismo');
    expect(said[0].text).toMatch(/resume/);

    // …and the operator's way back works after a repetition stop exactly as after a rate stop.
    await spine.handleInbound({ body: 'resume', from: from({ msgKey: 'r1' }) });
    expect(guard.blocked(CH)).toBe(false);
    const before = brain.calls.length;
    await spine.handleInbound({ body: 'seguimos entonces', from: from({ msgKey: 'h9' }) });
    expect(brain.calls.length).toBeGreaterThan(before);
  });

  it('a channel that cannot be spoken to still pauses and still logs (no `say` wired)', async () => {
    let t = 0;
    const guard = createStopGuard({ now: () => t });
    const lines = [];
    const { spine } = buildSpine({ guard });
    // rebuild without the say seam: the spine boot-wires it, a bare pipe does not have it
    const bare = createSpine({
      bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
      brain: { async turn() { return { text: 'x' }; } },
      guard,
      identity: createIdentity({ now: () => 1000 }),
      router: { resolve: () => 'e' },
      gating: { async decide() { return { mode: 'on', receives: true, mayReply: false, sendToEgpt: 'mode' }; }, surfaces: () => false },
      transcript: { async log() {} },
      heartbeats: { runDue() {} },
      sender: { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } },
      mesh: { isEnvelope: () => false, async handle() {} },
      isSelfChat: () => false,
      clock: { now: () => 1000 },
      log: { line: (m) => lines.push(m) },
    });
    expect(spine).toBeTruthy();
    for (let i = 0; i < 3; i++) {
      t += 2 * MIN;
      await bare.handleInbound({ body: `otra vez lo mismo${SIG_DO}`, from: rodz({ msgKey: `bare-${i}` }) });
    }
    expect(guard.blocked(CH)).toBe(true);
    expect(lines.some((l) => /auto-STOP/.test(l))).toBe(true);
  });
});
