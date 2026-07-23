// guard-provenance.test.mjs — the CRUX that makes the single turn-counter guard safe
// (operator 2026-06-19 post-mortem): "human" is decided by PROVENANCE, not display name.
// A mesh message posted AS the operator parses as an envelope, so it is NON-human and
// counts toward the loop cap instead of resetting it — the case a name-based counter
// missed and the removed flood-guard existed for. Plus the spine wiring: the guard is
// invoked at the ONE prompt chokepoint (handleFast), so a stopped/tripped channel never
// reaches a brain — a guard that isn't in the path is false confidence.
import { describe, it, expect } from 'vitest';
import { createStopGuard, isHumanTurn } from '../src/stop-guard.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';

// The real provenance detector — genuine envelopes, not a mocked flag.
const isEnvelope = (ev) => parseMesh(ev?.body ?? '') != null;

// A genuine inbound human message (some other person, plain text).
const humanMsg = { surface: 'wa', chatId: 'c', chatName: 'fam', senderName: 'Bob', authorized: true, msgId: 'm1', body: 'hello', kind: 'text', raw: {} };
// A mesh message posted AS THE OPERATOR: the DISPLAY sender is the operator ("An",
// isSender), but its body carries a provenance tail → it is relay traffic, not a human
// turn. This is the exact 2026-06-19 shape.
const opEnvelope = () => ({
  surface: 'wa', chatId: 'relay', chatName: 'relay', senderName: 'An', isSender: true, authorized: true,
  msgId: null, body: encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', to: 'don.do' }), kind: 'text', raw: {},
});

describe('isHumanTurn — provenance, not display name', () => {
  it('a genuine inbound message is human; a mesh envelope posted AS the operator is NOT', () => {
    expect(isHumanTurn(humanMsg, { isEnvelope })).toBe(true);
    // display sender is the operator, but provenance says relay traffic → non-human
    expect(isHumanTurn(opEnvelope(), { isEnvelope })).toBe(false);
  });

  it('a backlog replay and one of our own bot sends are non-human', () => {
    expect(isHumanTurn({ ...humanMsg, backlog: true }, { isEnvelope })).toBe(false);
    expect(isHumanTurn(humanMsg, { isEnvelope, wasSentByUs: () => true })).toBe(false);
  });
});

describe('2026-06-19 lock — mesh-posted-AS-operator counts toward the cap, does NOT reset', () => {
  // Model the chokepoint's classification: human → reset, else count.
  const classify = (guard, ev, channel) => {
    if (isHumanTurn(ev, { isEnvelope })) { guard.noteHuman(channel); return 'human'; }
    return guard.noteBeing(channel);
  };

  it('a burst of operator-posted envelopes trips at `turns` (a name-based reset would never trip)', () => {
    const guard = createStopGuard({ turns: 6 });
    const ch = 'wa:relay';
    const actions = [];
    for (let i = 0; i < 6; i++) actions.push(classify(guard, opEnvelope(), ch));
    // NONE of them classified as human (the display sender is the operator, but provenance wins)
    expect(actions.includes('human')).toBe(false);
    expect(actions[5]).toBe('stop');            // trips at turns, exactly the loop it was missing
    expect(guard.countOf(ch)).toBe(6);
  });

  it('a genuine human turn between bursts DOES reset (normal traffic never trips)', () => {
    const guard = createStopGuard({ turns: 6 });
    const ch = 'wa:relay';
    for (let i = 0; i < 5; i++) classify(guard, opEnvelope(), ch);   // 5 non-human
    expect(classify(guard, { ...humanMsg, chatId: 'relay' }, ch)).toBe('human');   // a real person speaks
    expect(guard.countOf(ch)).toBe(0);                              // reset
    // now it takes a fresh full run of 6 to trip again
    let last;
    for (let i = 0; i < 6; i++) last = classify(guard, opEnvelope(), ch);
    expect(last).toBe('stop');
  });
});

// --- Spine wiring: the guard is actually IN the path (handleFast chokepoint). --------
function buildSpine({ guard, guardOverride } = {}) {
  const meshCalls = [];
  const bridge = { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false };
  const brain = { calls: [], async turn(b, ev) { this.calls.push({ b, ev }); return { text: 'x' }; } };
  const identity = { build: (msg) => ({ ...msg }) };   // the fake feeds ready-made envelopes
  const router = { resolve: () => 'e' };
  const gating = {
    async decide() { return { mode: 'on', receives: true, mayReply: false, sendToEgpt: 'mode' }; },
    surfaces: () => false,
  };
  const transcript = { logged: [], async log(ev) { this.logged.push(ev); } };
  const heartbeats = { runDue() {} };
  const sender = { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
  const mesh = { isEnvelope: (ev) => parseMesh(ev?.body ?? '') != null, async handle(ev) { meshCalls.push(ev); } };
  const spine = createSpine({
    bridge, brain, identity, router, gating, sender, transcript, heartbeats,
    mesh, guard, guardOverride, clock: { now: () => 1000 },
  });
  return { spine, meshCalls, transcript, brain };
}

describe('guard wiring at the prompt chokepoint (handleFast)', () => {
  it('operator-posted relay envelopes pause the responder after `turns` (mesh.handle suppressed)', async () => {
    const guard = createStopGuard({ turns: 3 });
    const { spine, meshCalls } = buildSpine({ guard });
    for (let i = 0; i < 5; i++) await spine.handleInbound(opEnvelope());
    // turns=3 → the 3rd trips + still runs, pausing the channel; the 4th/5th are suppressed
    expect(meshCalls).toHaveLength(3);
    expect(guard.blocked('wa:relay')).toBe(true);
  });

  it('a genuine human↔bot chat never trips the guard (every human turn resets)', async () => {
    const guard = createStopGuard({ turns: 3 });
    const { spine } = buildSpine({ guard });
    for (let i = 0; i < 10; i++) await spine.handleInbound({ ...humanMsg, chatId: 'fam', msgId: `m${i}` });
    expect(guard.blocked('wa:fam')).toBe(false);
  });

  it('the STOP safe-word pauses prompting for the channel; RESUME clears it', async () => {
    const guard = createStopGuard({ turns: 6 });
    const { spine, meshCalls } = buildSpine({ guard });
    await spine.handleInbound({ surface: 'wa', chatId: 'relay', chatName: 'relay', authorized: true, msgId: 's1', body: 'STOP', kind: 'text', raw: {} });
    expect(guard.blocked('wa:relay')).toBe(true);
    await spine.handleInbound(opEnvelope());                 // suppressed while stopped
    expect(meshCalls).toHaveLength(0);
    await spine.handleInbound({ surface: 'wa', chatId: 'relay', chatName: 'relay', authorized: true, msgId: 's2', body: 'RESUME', kind: 'text', raw: {} });
    expect(guard.blocked('wa:relay')).toBe(false);
    await spine.handleInbound(opEnvelope());                 // flows again
    expect(meshCalls).toHaveLength(1);
  });

  it('a per-conversation override (turns: -1) disables tripping for that channel', async () => {
    const guard = createStopGuard({ turns: 3 });
    const guardOverride = async (surface, chatId) => (chatId === 'relay' ? { turns: -1 } : null);
    const { spine, meshCalls } = buildSpine({ guard, guardOverride });
    for (let i = 0; i < 20; i++) await spine.handleInbound(opEnvelope());
    expect(meshCalls).toHaveLength(20);                      // never paused
    expect(guard.blocked('wa:relay')).toBe(false);
  });
});
