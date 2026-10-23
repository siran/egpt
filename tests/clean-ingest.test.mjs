// clean-ingest.test.mjs — the three-check wake model (operator 2026-10-13): a message is
// classified by WHO PRODUCED it, then routed.
//   1. SIGNED being line (decodeBeingSignature → <being>): OUR output. Logged. NEVER wakes its
//      own author being (same-being), but DOES wake a DIFFERENT being it explicitly addresses
//      (@mention or replyToBeing) — the cross-being exception that lets E↔E+ (same node) and
//      E↔don (cross node) talk.
//   2. UNSIGNED own-output from a MOUTH/Rodz identity (reaction, synthesized-voice re-transcription):
//      log-only, never a wake. SOURCE gate (keys on the mouth identities, NOT the ear/operator).
//   3. Everything else is HUMAN input — including the OPERATOR'S OWN typed messages from the ear.
//
// Reproduce-first: these are written against the TARGET behavior. On CURRENT code the headline
// same-node-sibling case (#1 cross-being) is RED — the spine's node-based echo gate (spine.mjs
// `kindOf(ev)==='echo'` via fromThisNode) suppresses the WHOLE wake, so E+ never sees E's `@e+`.
// The rest LOCK behavior the target model must preserve.
//
// Harness: the REAL spine + REAL identity + REAL router + REAL gating, composed exactly as the
// buildReplySpine pattern in guard-provenance.test.mjs does (fake brain/sender/transcript/mesh),
// so the wake decision is the live one, not a mock.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
import { encodeNodeSignature } from '../src/node-signature.mjs';

// THIS node is 'kg' with a persona `egpt` (@e/@egpt) and a sibling `eplus` (@eplus). 'do' is a PEER.
const AGENTS = {
  egpt:  { handles: ['e', 'egpt'] },
  eplus: { handles: ['eplus'] },
};
// fromThisNode exactly as boot wires it: fromNode set AND the node is ours ('kg').
const fromThisNode = (ev) => ev?.fromNode != null && String(ev.fromNode).toLowerCase() === 'kg';

const SIG_KG_E   = encodeNodeSignature('kg', 'egpt');   // a line E (the persona) committed
const SIG_KG_EP  = encodeNodeSignature('kg', 'eplus');  // a line E+ committed
const SIG_DO_DON = encodeNodeSignature('do', 'don');    // a PEER node's being

// mode drives the gate: 'mention' wakes only on a mention; 'on' wakes on every message (so the
// ONLY thing that can stop a wake is the own-output classification — the faithful PALMA shape).
function buildSpine({ mode = 'mention', guard = null } = {}) {
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, body: ev.body }); return { text: 'x' }; } };
  const identity = createIdentity({ now: () => 1000 });
  const config = { dispatch: { auto_default_mode: mode } };
  const router = createRouter({ getAgents: () => AGENTS, getConfig: () => config });
  const gating = createGating({ getConfig: () => config, loadState: null });
  const transcript = { logged: [], async log(ev) { this.logged.push(ev); } };
  const sender = { opened: 0, open() { this.opened++; return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
    brain, identity, router, gating, sender, transcript,
    heartbeats: { runDue() {} }, mesh: { isEnvelope: () => false, async handle() {} },
    fromThisNode, guard, isSelfChat: () => false, clock: { now: () => 1000 },
  });
  return { spine, brain, transcript };
}

// The bridge payload shape the port delivers. network whatsapp → surface whatsapp.
const from = (over = {}) => ({ chatId: 'c', chatName: 'fam', network: 'whatsapp', userId: 'u', senderName: 'x', msgKey: 'm1', ...over });
const wokeBeings = (brain) => brain.calls.map((c) => c.being);

describe('clean ingest — the three-check wake model', () => {
  // 1. SAME-NODE SIBLING (THE reproduce-first). E (signed kg/egpt) posts a line addressing @eplus →
  //    E+ must wake. FAILS today: the signed line decodes to node 'kg' → kindOf 'echo' → the whole
  //    wake is suppressed, so the sibling never sees it.
  it('1. a signed line from E addressing @eplus WAKES E+ (cross-being, same node)', async () => {
    const { spine, brain } = buildSpine({ mode: 'mention' });
    await spine.handleInbound({ body: `@eplus ¿vienes?${SIG_KG_E}`, from: from({ msgKey: 'kg-e-1', isSender: false }) });
    expect(wokeBeings(brain)).toEqual(['eplus']);
  });

  // 2. SAME-BEING SELF. E's signed line containing @e must NOT wake E (no self-loop).
  it('2. a signed line from E containing @e does NOT wake E (no self-loop)', async () => {
    const { spine, brain } = buildSpine({ mode: 'mention' });
    await spine.handleInbound({ body: `@e nota para mí${SIG_KG_E}`, from: from({ msgKey: 'kg-e-2', atEAnywhere: true, isSender: false }) });
    expect(wokeBeings(brain)).toEqual([]);
  });

  // 3. ECHO. E's own signed output re-entering (no cross-being address), in mode 'on' (replies to
  //    everything) — must NOT re-wake E. This is the PALMA loop's REPLY face: only the own-output
  //    classification stops it, since 'on' has no mention gate.
  // contract 7.3
  it("3. E's own signed output re-entering does NOT re-wake E (mode on)", async () => {
    const { spine, brain, transcript } = buildSpine({ mode: 'on' });
    await spine.handleInbound({ body: `ya terminé la tarea${SIG_KG_E}`, from: from({ msgKey: 'kg-e-3', isSender: false }) });
    expect(wokeBeings(brain)).toEqual([]);
    // …but it WAS recorded (a being never deletes a message; the frame rendered to a legible <kg>).
    expect(transcript.logged.at(-1)?.body).toBe('ya terminé la tarea<kg>');
  });

  // 4. OPERATOR INPUT (CRITICAL). The operator types @e from the EAR account (unsigned, isSender) —
  //    one of "our accounts", but HUMAN input. Must wake E. The SOURCE gate keys on the MOUTH, not
  //    the ear, so the operator is never suppressed.
  it('4. the operator typing @e from the ear (unsigned, isSender) WAKES E', async () => {
    const { spine, brain } = buildSpine({ mode: 'mention' });
    await spine.handleInbound({ body: '@e ¿estás?', from: from({ msgKey: 'op-1', atEAnywhere: true, isSender: true, authorized: true }) });
    expect(wokeBeings(brain)).toEqual(['egpt']);
  });

  // 5. THIRD-PARTY HUMAN. @e from a stranger (unsigned, not isSender) → E wakes.
  it('5. a stranger typing @e (unsigned) WAKES E', async () => {
    const { spine, brain } = buildSpine({ mode: 'mention' });
    await spine.handleInbound({ body: '@e hola', from: from({ msgKey: 'h-1', atEAnywhere: true, isSender: false, senderName: 'Bob' }) });
    expect(wokeBeings(brain)).toEqual(['egpt']);
  });

  // 7. CROSS-NODE being→being (regression lock). A PEER's signed line (do/don) containing @e → E
  //    wakes. fromThisNode is false for 'do', so it is turnKind 'being' and still wakes — this MUST
  //    keep working (it is what E↔don rests on).
  it('7. a PEER node line (do/don) containing @e WAKES E (cross-node, unchanged)', async () => {
    const { spine, brain } = buildSpine({ mode: 'mention' });
    await spine.handleInbound({ body: `@e ayúdame${SIG_DO_DON}`, from: from({ msgKey: 'peer-1', atEAnywhere: true, isSender: false }) });
    expect(wokeBeings(brain)).toEqual(['egpt']);
  });

  // 8. FENCED. A being's line whose @eplus sits inside a code fence contributes no live wake
  //    (auto-mode _escapeWake). E+ must NOT wake.
  it('8. a fenced @eplus in a being line does NOT wake E+', async () => {
    const { spine, brain } = buildSpine({ mode: 'mention' });
    await spine.handleInbound({ body: `mira \`@eplus\` en el código${SIG_KG_E}`, from: from({ msgKey: 'kg-e-8', isSender: false }) });
    expect(wokeBeings(brain)).toEqual([]);
  });
});

// RULING 1 (loop guard): a same-node cross-being wake must COUNT toward the loop guard exactly as a
// cross-node one does, or a runaway E↔E+ never auto-STOPs. A line that would wake only its own
// author still counts for nothing.
describe('clean ingest — the loop guard counts a same-node cross-being wake', () => {
  // vary the body each turn so only the RATE trigger (turns) can trip, never REPETITION.
  const burst = async (spine, bodyFor) => { for (let i = 0; i < 4; i++) await spine.handleInbound({ body: bodyFor(i), from: from({ msgKey: `m${i}`, isSender: false }) }); };

  it('(a) a runaway same-node E↔E+ trips at `turns`, exactly as a cross-node E↔don does', async () => {
    // same-node cross-being: E (kg/egpt) addressing @eplus, over and over.
    const g1 = createStopGuard({ turns: 4 });
    const { spine: s1 } = buildSpine({ mode: 'on', guard: g1 });
    await burst(s1, (i) => `@eplus turno ${i}${SIG_KG_E}`);
    expect(g1.blocked('whatsapp:c')).toBe(true);
    expect(g1.countOf('whatsapp:c')).toBe(4);

    // cross-node peer: do/don addressing @e — the behavior it must MATCH.
    const g2 = createStopGuard({ turns: 4 });
    const { spine: s2 } = buildSpine({ mode: 'on', guard: g2 });
    await burst(s2, (i) => `@e turno ${i}${SIG_DO_DON}`);
    expect(g2.blocked('whatsapp:c')).toBe(true);
    expect(g2.countOf('whatsapp:c')).toBe(4);
  });

  it('(a-lock) E\'s OWN output that wakes only itself still counts for nothing (no false auto-STOP)', async () => {
    const g = createStopGuard({ turns: 4 });
    const { spine } = buildSpine({ mode: 'on', guard: g });
    await burst(spine, (i) => `nota propia ${i}${SIG_KG_E}`);   // no cross-being address → record-only
    expect(g.blocked('whatsapp:c')).toBe(false);
    expect(g.countOf('whatsapp:c')).toBe(0);
  });
});

// A NODE-SIGNED line (this node's or a peer's) wakes a being only by EXPLICIT address — @handle or a
// quote of that being's own post — never by the persona fall-through, mode on/auto, or a generic
// replyToBot (live 2026-10-18, eGPT Admin: do's audit line woke kg's E in mode on; E's ⏳ quoting it
// woke do's D, D's quoting E woke E).
describe('clean ingest — a signed line wakes only the being it explicitly addresses', () => {
  const SIG_DO = encodeNodeSignature('do');   // a peer node's own system line (no being)
  const CH = 'whatsapp:c';

  it('LIVE: a peer node-only frame in a mode-on chat wakes nobody, is recorded, and is not counted', async () => {
    const g = createStopGuard({ turns: 4 });
    const { spine, brain, transcript } = buildSpine({ mode: 'on', guard: g });
    await spine.handleInbound({ body: `do: /agents in eGPT Admin by An → no egpt in node do ⟦e8dc68c68e⟧${SIG_DO}`, from: from({ msgKey: 'do-sys-1', isSender: true }) });
    expect(wokeBeings(brain)).toEqual([]);
    expect(transcript.logged.at(-1)?.body).toMatch(/⟦e8dc68c68e⟧<do>$/);
    expect(g.countOf(CH)).toBe(0);
  });

  it('a peer being frame (do/don) addressing nobody does not wake E in mode on', async () => {
    const { spine, brain } = buildSpine({ mode: 'on' });
    await spine.handleInbound({ body: `…${SIG_DO_DON}`, from: from({ msgKey: 'don-1', isSender: true }) });
    expect(wokeBeings(brain)).toEqual([]);
  });

  it('a peer being frame with @e wakes E, and the guard counts it', async () => {
    const g = createStopGuard({ turns: 4 });
    const { spine, brain } = buildSpine({ mode: 'on', guard: g });
    await spine.handleInbound({ body: `@e ¿lo ves?${SIG_DO_DON}`, from: from({ msgKey: 'don-2', isSender: true }) });
    expect(wokeBeings(brain)).toEqual(['egpt']);
    expect(g.countOf(CH)).toBe(1);
  });

  it("a peer being frame quoting E's own post (replyToBeing egpt) wakes E", async () => {
    const { spine, brain } = buildSpine({ mode: 'on' });
    await spine.handleInbound({ body: `…${SIG_DO_DON}`, from: from({ msgKey: 'don-3', isSender: true, replyToBot: true, replyToBeing: 'egpt' }) });
    expect(wokeBeings(brain)).toEqual(['egpt']);
  });

  it('a peer being frame quoting a system line (replyToBot, no replyToBeing) wakes nobody', async () => {
    for (const mode of ['on', 'mention']) {
      const { spine, brain } = buildSpine({ mode });
      await spine.handleInbound({ body: `⏳ Thinking…${SIG_DO_DON}`, from: from({ msgKey: `don-4-${mode}`, isSender: true, replyToBot: true }) });
      expect(wokeBeings(brain)).toEqual([]);
    }
  });

  it("an 'off' chat still does not receive a peer node-only frame (not recorded)", async () => {
    const { spine, brain, transcript } = buildSpine({ mode: 'off' });
    await spine.handleInbound({ body: `aviso${SIG_DO}`, from: from({ msgKey: 'do-sys-2', isSender: true }) });
    expect(wokeBeings(brain)).toEqual([]);
    expect(transcript.logged).toHaveLength(0);
  });

  it('LOCK: a human (unsigned) line in a mode-on chat still wakes every being on there', async () => {
    const { spine, brain } = buildSpine({ mode: 'on' });
    await spine.handleInbound({ body: 'hola', from: from({ msgKey: 'h-2', isSender: false, senderName: 'Bob' }) });
    expect(wokeBeings(brain).sort()).toEqual(['egpt', 'eplus']);
  });

  // contract 7.3
  it("LOCK: this node's own node-only frame wakes nobody, even naming @eplus", async () => {
    const { spine, brain } = buildSpine({ mode: 'on' });
    await spine.handleInbound({ body: `@eplus aviso${encodeNodeSignature('kg')}`, from: from({ msgKey: 'kg-sys-1', isSender: true }) });
    expect(wokeBeings(brain)).toEqual([]);
  });
});
