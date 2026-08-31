// foreign-node-wake.test.mjs — A BEING DOES NOT WAKE ON A FRAME ANOTHER NODE'S SPINE POSTED.
//
// Operator 2026-08-31, on the reverse direction of the room tunnel: a room message fanned into a
// group, which the OTHER node then sees. The discriminator is the invisible node signature
// (src/node-signature.mjs) — the node name in the Unicode TAGS block, decoded on every inbound
// into `ev.fromNode` (src/spine/identity.mjs) and already read by src/stop-guard.mjs.
//
// TODAY fromNode marks a turn non-human, which only affects the guard's COUNTING. It does not
// prevent a reply: a node-posted line containing `@e` mention-matches like any other text and gets
// answered, bounded only by guard.turns — so two spines watching one chat answer each other,
// guard.turns deep, in front of everybody.
//
// TWO TRAPS, both fatal if missed, both locked below:
//   1. `fromNode != null` is the WRONG test. It means "some spine posted this", which includes THIS
//      node's own synthetics — the room relay's tunnel carries fromNode across on purpose. The test
//      is "another node": ev.fromNode compared against node_name ∪ node_alias.
//   2. Mesh envelopes must be unreachable by this rule or the mesh dies. classify() returns for an
//      envelope BEFORE the wake path — verified here rather than assumed.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';
import { encodeNodeSignature, hasNodeSignature } from '../src/node-signature.mjs';
import { makeWrapPersona } from '../src/bridges/persona-wrap.mjs';
import { fromOtherNode } from '../src/spine/node-names.mjs';

const CFG = { node_name: 'kg', node_alias: ['reve'], agents: { egpt: { default: true, handles: ['e', 'egpt'] } } };
const SIG_DO = encodeNodeSignature('do');
const SIG_KG = encodeNodeSignature('kg');
const CH = 'whatsapp:!fam';

// `wired: false` builds the spine with NO fromOtherNode at all — the pre-change derivation, which
// is what makes the LOCK below a comparison against the old code, not the new code agreeing with
// itself.
function harness({ wired = true } = {}) {
  const meshCalls = [];
  const bridge = { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false };
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, body: ev.body, chatId: ev.chatId }); return { text: 'ok' }; } };
  const identity = createIdentity({ now: () => 1000 });        // the REAL one — it renders the frame away
  const router = { resolve: () => 'egpt' };
  const gating = {
    async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; },
    surfaces: () => true,
  };
  const transcript = { logged: [], async log(ev, reply) { this.logged.push({ chatId: ev.chatId, body: ev.body, reply: reply ?? null }); } };
  const heartbeats = { runDue() {} };
  const sender = { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
  const mesh = { isEnvelope: (ev) => parseMesh(ev?.body ?? '') != null, async handle(ev) { meshCalls.push(ev.body); } };
  const guard = createStopGuard({ turns: 6 });
  const spine = createSpine({
    bridge, brain, identity, router, gating, sender, transcript, heartbeats, mesh, guard,
    clock: { now: () => 1000 }, turnTimeoutMs: 0,
    ...(wired ? { fromOtherNode: (ev) => fromOtherNode(CFG, ev) } : {}),
  });
  return { spine, brain, transcript, meshCalls, guard };
}

// The bridge payload for a message on a chat both nodes can see.
const inbound = (body, over = {}) => ({
  body,
  from: { network: 'whatsapp', chatId: '!fam', chatName: 'familia', userId: 'u-an', senderName: 'An', msgKey: 'm1', ...over },
});

describe('REPRODUCE-FIRST — a node-posted @e still got answered', () => {
  it("DOLLY's spine posts a line naming @e; kg records it, counts it, and wakes NOBODY", async () => {
    const { spine, brain, transcript, guard } = harness();
    await spine.handleInbound(inbound(`🤝 don\n@e ¿lo traducimos?${SIG_DO}`));
    expect(brain.calls).toEqual([]);                                     // ← fails on HEAD: E answered
    // …and everything the frame ALREADY did keeps happening. The record stays complete (the frame
    // rendered into a legible <do>, as it must — no invisible byte reaches a prompt)…
    expect(transcript.logged.filter((l) => l.reply == null).map((l) => l.body)).toEqual(['🤝 don\n@e ¿lo traducimos?<do>']);
    // …and the loop counter still counts it, so the guard is not weakened by this rule.
    expect(guard.countOf(CH)).toBe(1);
  });

  it('a burst of them still trips the guard at `turns` — the counter is untouched', async () => {
    const { spine, brain, guard } = harness();
    for (let i = 0; i < 6; i++) await spine.handleInbound(inbound(`@e ping${SIG_DO}`, { msgKey: `p${i}` }));
    expect(brain.calls).toEqual([]);
    expect(guard.countOf(CH)).toBe(6);
    expect(guard.blocked(CH)).toBe(true);
  });

  it('an ORDINARY human message in the same chat is answered exactly as before', async () => {
    const { spine, brain, guard } = harness();
    await spine.handleInbound(inbound('@e ¿lo traducimos?', { msgKey: 'h1', senderName: 'Vero' }));
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);
    expect(guard.countOf(CH)).toBe(0);
  });

  it('the RENDERED form is forgeable, so it is never the test — a person typing "<do>" still wakes E', async () => {
    const { spine, brain } = harness();
    await spine.handleInbound(inbound('@e mira, escribo <do> a mano', { msgKey: 'h2', senderName: 'Vero' }));
    expect(brain.calls).toHaveLength(1);
  });
});

describe('TRAP 1 — the test is "ANOTHER node", never `fromNode != null`', () => {
  it("THIS node's own signed frame still wakes its beings (multi-brain rooms must not go silent)", async () => {
    const { spine, brain } = harness();
    // One of OUR OWN sends that escaped the bridge's echo gate, and — the case that matters — the
    // room relay's tunnel, which carries fromNode across the re-addressing deliberately (8227b99).
    await spine.handleInbound(inbound(`@e seguimos${SIG_KG}`, { msgKey: 'own-1' }));
    await spine.handleInbound({ body: '@e seguimos', from: { network: 'room', chatId: 'acim', chatName: 'acim', userId: 'u', msgKey: null, fromNode: 'kg', fromMember: { id: '!grp', kind: 'wa-group' } } });
    expect(brain.calls).toHaveLength(2);
    // A node_alias answers like the node name — ownNodeNamesOf is the SAME set every other node
    // gate matches, never a second notion of "who are we".
    await spine.handleInbound(inbound(`@e y otra${SIG_KG}`, { msgKey: 'own-2', chatId: '!fam2' }));
    expect(brain.calls).toHaveLength(3);
  });

  it('fromOtherNode: null is a person, our own name (and alias) is us, anything else is another spine', () => {
    expect(fromOtherNode(CFG, { fromNode: null })).toBe(false);      // UNSIGNED — the ordinary case
    expect(fromOtherNode(CFG, {})).toBe(false);
    expect(fromOtherNode(CFG, { fromNode: 'kg' })).toBe(false);
    expect(fromOtherNode(CFG, { fromNode: 'KG' })).toBe(false);      // lowercased both sides
    expect(fromOtherNode(CFG, { fromNode: 'reve' })).toBe(false);    // node_alias
    expect(fromOtherNode(CFG, { fromNode: 'do' })).toBe(true);
    // '' = SIGNED BY A NODE WE CANNOT NAME (an empty or garbled frame). Provably not us — boot
    // refuses to start without a node_name and every frame we commit carries it.
    expect(fromOtherNode(CFG, { fromNode: '' })).toBe(true);
  });
});

describe('TRAP 2 — the mesh is unreachable by this rule', () => {
  // First the FACT, checked rather than assumed. The operator's premise was that envelopes are
  // node-signed by construction; in this codebase they are NOT, and deliberately so: persona-wrap
  // refuses to sign a mesh envelope (a close line under the tail makes parseMesh fail and the mesh
  // goes deaf), and the responder's signed reply nugget is base64 INSIDE the fence, so no readable
  // frame survives on the wire. Either way the rule cannot reach an envelope — but the reason is
  // the early return, not the encoding, so both are locked.
  it('a real envelope carries NO node signature on the wire (the premise, checked)', () => {
    const wrap = makeWrapPersona({ nodeName: 'do' });
    const nugget = wrap({ bodyEmoji: '🐶', label: 'don' }, 'la traducción');
    expect(hasNodeSignature(nugget)).toBe(true);                                   // the payload IS signed…
    const env = encodeMesh({ by: 'An', body: nugget, from: 'familia', from_node: 'do', to: 'e.kg' });
    expect(hasNodeSignature(env)).toBe(false);                                     // …the envelope is not
    expect(wrap({ bodyEmoji: '', label: '' }, env)).toBe(env);                     // and never gets signed
  });

  it('an envelope reaches mesh.handle and wakes no chat path — signed or not', async () => {
    const { spine, meshCalls, brain } = harness();
    const env = encodeMesh({ by: 'An', body: 'hola', from: 'familia', from_node: 'do', to: 'e.kg' });
    await spine.handleInbound(inbound(env, { msgKey: 'env-1' }));
    // …and the BELT: even if a node-signed envelope ever arrived, classify returns for it two
    // branches above the wake check, so the mesh cannot be silenced by this rule.
    await spine.handleInbound(inbound(env + SIG_DO, { msgKey: 'env-2' }));
    expect(meshCalls).toHaveLength(2);
    expect(brain.calls).toEqual([]);
  });
});

describe('BYTE-IDENTICAL — a message with no fromNode', () => {
  it('the SAME traffic records, counts and dispatches identically with the seam absent and with it wired', async () => {
    const runs = [];
    for (const wired of [false, true]) {
      const h = harness({ wired });
      await h.spine.handleInbound(inbound('@e hola', { msgKey: 'a' }));
      await h.spine.handleInbound(inbound('vamos 🏴󠁧󠁢󠁳󠁣󠁴󠁿', { msgKey: 'b' }));                 // an RGI flag: same block, no opener
      await h.spine.handleInbound(inbound('as the docs say:​ lazy', { msgKey: 'c' }));   // a pasted ZWSP run
      runs.push({ logged: h.transcript.logged, turns: h.brain.calls, count: h.guard.countOf(CH) });
    }
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0].turns).toHaveLength(3);          // …and all three were genuinely answered
  });
});
