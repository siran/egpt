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
import { createIdentity } from '../src/spine/identity.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';
import { encodeNodeSignature } from '../src/node-signature.mjs';

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

  it('a web-brain member reply re-entering the room (fromMember, kind brain) is NON-human by provenance (phase 4, design B)', () => {
    // The room relay re-feeds a brain member's own reply as a synthetic inbound tagged
    // fromMember — it is OUR output, so it counts toward the cap (bounds a two-brain room),
    // never resets it. Provenance, not display name (senderName is the member).
    expect(isHumanTurn({ ...humanMsg, senderName: 'chatgpt', fromMember: { id: 'chatgpt', kind: 'brain' } }, { isEnvelope })).toBe(false);
  });

  it("an INVITED GROUP's message tunnelled into the room it joined stays HUMAN — the KIND is the test (operator 2026-08-31)", () => {
    // The SAME re-entry carries a wa-group member's line into the room, so the group can trigger
    // the room's agents. That is a person talking: counting it would auto-STOP the room after
    // guard.turns group messages and silence the very agents the tunnel exists to wake.
    expect(isHumanTurn({ ...humanMsg, fromMember: { id: '!grp-A', kind: 'wa-group' } }, { isEnvelope })).toBe(true);
    // …but one of OUR OWN sends that escaped the bridge's echo gate is caught by the signature the
    // tunnel synthetic carries across the re-addressing — non-human, so the guard still bounds it.
    expect(isHumanTurn({ ...humanMsg, fromMember: { id: '!grp-A', kind: 'wa-group' }, fromNode: 'kg' }, { isEnvelope })).toBe(false);
  });
});

// === THE PEER NODE — the signal the other four could not carry ==============================
// (operator 2026-07-26: "the mere presence of a non-readable char points to non-human".)
// On a SHARED Beeper account a PEER node's plain post arrives isSender:true with an id THIS
// node never sent, so wasSentByUs — id-exact and NODE-LOCAL — says false, and a plain post is
// no envelope. All four old signals therefore said "human", and the peer both got recorded as
// the operator AND reset the loop counter that exists to stop two nodes talking forever.
// The fifth signal is the STRUCTURAL node signature every spine now commits to every frame:
// its PRESENCE means a bridge wrote the text, whoever the display sender is.
const SIG_DO = encodeNodeSignature('do');
// The peer's post: DOLLY's reply on the shared account. isSender (the account is ours), an id
// only DOLLY ever sent, and a plain body — indistinguishable from the owner typing, EXCEPT for
// the frame DOLLY's own bridge appended.
const peerPost = (over = {}) => ({
  surface: 'wa', chatId: 'c', chatName: 'fam', senderName: 'An', isSender: true, authorized: true,
  msgId: 'peer-1', body: `🤝 don\naquí${SIG_DO}`, kind: 'text', raw: {}, ...over,
});
// wasSentByUs as the bridge really implements it: id-exact against OUR OWN sends only.
const oursOnly = (ids) => (ev) => ids.has(ev.msgId);

describe('isHumanTurn — the node signature is provenance (a peer node is not the operator)', () => {
  it('a PEER node\'s plain post on the shared account is NOT a human turn', () => {
    const ev = peerPost();
    // the four old signals all say "human" — this is exactly why the fifth exists
    expect(ev.backlog).toBeFalsy();
    expect(ev.fromMember).toBeFalsy();
    expect(isEnvelope(ev)).toBe(false);
    expect(oursOnly(new Set(['our-1']))(ev)).toBe(false);
    expect(isHumanTurn(ev, { isEnvelope, wasSentByUs: oursOnly(new Set(['our-1'])) })).toBe(false);
  });

  it('PRESENCE is sufficient — an undecodable frame is still a bridge', () => {
    // Empty interior: decodeNodeSignature returns null, so a decode-gated test would let it
    // through. The gate is presence, because an unknown node is still not a human.
    expect(isHumanTurn({ ...humanMsg, body: 'hola\u{E0001}\u{E007F}' }, { isEnvelope })).toBe(false);
  });

  it('a FLAG EMOJI stays human — RGI tag sequences use this block but never our opener', () => {
    // 🏴󠁧󠁢󠁳󠁣󠁴󠁿 = U+1F3F4 + tag chars + U+E007F, OUR terminator. The asymmetry that makes the frame
    // safe: an RGI sequence has no U+E0001 TAG LANGUAGE (deprecated, not a valid member), so
    // the frame regex cannot match one. A naive "any invisible character" rule would misread
    // every Scottish, Welsh and English flag as a bridge.
    const flags = {
      scotland: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
      wales: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}',
      england: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
    };
    for (const flag of Object.values(flags)) {
      expect(isHumanTurn({ ...humanMsg, body: `vamos ${flag}` }, { isEnvelope })).toBe(true);
    }
  });

  it('a PASTED zero-width run stays human — web text routinely carries ZWSP/BOM', () => {
    const paste = 'as the docs say:\u{200B} the\u{FEFF} value\u{200C} is\u{200D} lazy';
    expect(isHumanTurn({ ...humanMsg, body: paste }, { isEnvelope })).toBe(true);
  });

  it('a bodyless event (reaction/edit shapes) is unaffected', () => {
    expect(isHumanTurn({ ...humanMsg, body: null }, { isEnvelope })).toBe(true);
    expect(isHumanTurn({ ...humanMsg, body: undefined }, { isEnvelope })).toBe(true);
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

  // The 2026-07-26 case: two NODES on the shared account, not a mesh envelope in sight. Every
  // peer post used to classify as human and RESET the counter, so the guard that exists to stop
  // a message flood could never trip on the one flood it now has to worry about.
  it('a burst of PEER-NODE posts trips at `turns` — it never resets the counter', () => {
    const guard = createStopGuard({ turns: 6 });
    const ch = 'wa:fam';
    const actions = [];
    for (let i = 0; i < 6; i++) actions.push(classify(guard, peerPost({ msgId: `peer-${i}` }), ch));
    expect(actions.includes('human')).toBe(false);
    expect(actions[5]).toBe('stop');
    expect(guard.countOf(ch)).toBe(6);
  });

  it('a genuine human turn in the same channel still resets it', () => {
    const guard = createStopGuard({ turns: 6 });
    const ch = 'wa:fam';
    for (let i = 0; i < 5; i++) classify(guard, peerPost({ msgId: `peer-${i}` }), ch);
    expect(classify(guard, { ...humanMsg, chatId: 'fam' }, ch)).toBe('human');
    expect(guard.countOf(ch)).toBe(0);
  });
});

// --- Spine wiring: the guard is actually IN the path (handleFast chokepoint). --------
function buildSpine({ guard, guardOverride, stopSwitch = null } = {}) {
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
    // isSelfChat: TRUE for every chat in this file. These cases are about the loop counter
    // and the kill-switch-vs-channel-pause split, not about WHERE the safe word is honoured
    // — that scoping (Self only, since 2026-07-26) is locked in tests/stop-file.test.mjs (D).
    mesh, guard, guardOverride, stopSwitch, isSelfChat: () => true, clock: { now: () => 1000 },
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

  // The safe-word split (operator 2026-07-25): STOP is the KILL SWITCH — it writes
  // EGPT_HOME/STOP and stops the SERVICE, it does not pause a channel (that whole contract
  // is locked end-to-end in tests/stop-file.test.mjs). What still pauses a channel is the
  // LOOP COUNTER, and RESUME is still the way back from it.
  it('STOP pulls the kill switch (never a channel pause); RESUME clears an auto-stopped channel', async () => {
    const guard = createStopGuard({ turns: 3 });
    const pulls = [];
    const { spine, meshCalls } = buildSpine({ guard, stopSwitch: { present: () => false, pull: (why) => pulls.push(why) } });

    await spine.handleInbound({ surface: 'wa', chatId: 'relay', chatName: 'relay', authorized: true, msgId: 's1', body: 'STOP', kind: 'text', raw: {} });
    expect(pulls).toHaveLength(1);                           // the service goes down
    expect(guard.blocked('wa:relay')).toBe(false);           // …not a per-channel mute

    for (let i = 0; i < 3; i++) await spine.handleInbound(opEnvelope());   // the counter trips at 3
    expect(meshCalls).toHaveLength(3);
    expect(guard.blocked('wa:relay')).toBe(true);
    await spine.handleInbound(opEnvelope());                 // suppressed while stopped
    expect(meshCalls).toHaveLength(3);

    await spine.handleInbound({ surface: 'wa', chatId: 'relay', chatName: 'relay', authorized: true, msgId: 's2', body: 'RESUME', kind: 'text', raw: {} });
    expect(guard.blocked('wa:relay')).toBe(false);
    await spine.handleInbound(opEnvelope());                 // flows again
    expect(meshCalls).toHaveLength(4);
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

// === THE REAL IDENTITY IN THE PATH — the only wiring that proves the signal is alive =========
// Every case ABOVE feeds the spine a ready-made envelope through a FAKE identity
// (`build: (msg) => ({ ...msg })`), so the body reaches isHumanTurn exactly as written. THE LIVE
// PATH DOES NOT WORK THAT WAY: handleFast calls identity.build FIRST (spine.mjs:375) and every
// humanTurn() call site runs after it, and build RENDERS the invisible frame away
// (`renderNodeSignature`, identity.mjs) — it must, because an invisible byte may never reach a
// prompt or the transcript. So a body-only provenance test passes against the fake and is DEAD in
// production. These cases wire the REAL createIdentity and feed the bridge payload shape
// (`{ body, from }`) the port actually delivers, so they fail if that ordering ever regresses.
function buildRealSpine({ guard = null, stopSwitch = null, wasSentByUs = () => false } = {}) {
  const bridge = { onMessage() {}, send() {}, stop() {}, wasSentByUs };
  const brain = { calls: [], async turn(b, ev) { this.calls.push({ b, ev }); return { text: 'x' }; } };
  const identity = createIdentity({ now: () => 1000 });     // ← THE REAL ONE. The whole point.
  const router = { resolve: () => 'e' };
  const gating = {
    async decide() { return { mode: 'on', receives: true, mayReply: false, sendToEgpt: 'mode' }; },
    surfaces: () => false,
  };
  const transcript = { logged: [], async log(ev) { this.logged.push(ev); } };
  const heartbeats = { runDue() {} };
  const sender = { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
  const mesh = { isEnvelope: (ev) => parseMesh(ev?.body ?? '') != null, async handle() {} };
  const spine = createSpine({
    bridge, brain, identity, router, gating, sender, transcript, heartbeats,
    mesh, guard, stopSwitch, isSelfChat: () => true, clock: { now: () => 1000 },
  });
  return { spine, transcript, brain };
}
// The bridge payload for a message on the SHARED Beeper account. `network: whatsapp` → the real
// identity resolves surface 'whatsapp', so the guard channel is 'whatsapp:c'.
const realFrom = (over = {}) => ({
  chatId: 'c', chatName: 'fam', network: 'whatsapp', userId: 'u-an', senderName: 'An',
  msgKey: 'm1', isSender: true, authorized: true, ...over,
});
const CH = 'whatsapp:c';

describe('the node signature survives the REAL identity into the guard', () => {
  it("a PEER NODE's post is NON-human and COUNTS toward the cap (never resets it)", async () => {
    const guard = createStopGuard({ turns: 3 });
    const { spine, transcript } = buildRealSpine({ guard });
    for (let i = 0; i < 3; i++) {
      await spine.handleInbound({ body: `🤝 don\naquí${SIG_DO}`, from: realFrom({ msgKey: `peer-${i}` }) });
    }
    // the frame is GONE from the record (it must be — no invisible byte reaches a prompt)…
    expect(transcript.logged.at(-1).body).toBe('🤝 don\naquí<do>');
    // …and the guard still knew it was a bridge. Three non-human turns, no reset, channel paused.
    expect(guard.countOf(CH)).toBe(3);
    expect(guard.blocked(CH)).toBe(true);
  });

  it('an ORDINARY human message through the SAME real path is still human (it resets)', async () => {
    const guard = createStopGuard({ turns: 3 });
    const { spine } = buildRealSpine({ guard });
    for (let i = 0; i < 2; i++) {
      await spine.handleInbound({ body: `aquí${SIG_DO}`, from: realFrom({ msgKey: `peer-${i}` }) });
    }
    expect(guard.countOf(CH)).toBe(2);
    await spine.handleInbound({ body: 'hola, ¿qué tal?', from: realFrom({ msgKey: 'h1', isSender: false, senderName: 'Bob' }) });
    expect(guard.countOf(CH)).toBe(0);
    expect(guard.blocked(CH)).toBe(false);
  });

  it('the RENDERED form is FORGEABLE, so it is never the test — a human typing "<do>" stays human', async () => {
    // renderNodeSignature turns the frame into the plain text `<do>`, which anyone can type. If
    // provenance were read off the rendered body, this message would classify a person as a node.
    const guard = createStopGuard({ turns: 3 });
    const { spine } = buildRealSpine({ guard });
    await spine.handleInbound({ body: `aquí${SIG_DO}`, from: realFrom({ msgKey: 'peer-0' }) });
    expect(guard.countOf(CH)).toBe(1);
    await spine.handleInbound({ body: 'mira, escribo <do> a mano', from: realFrom({ msgKey: 'h1', isSender: false, senderName: 'Bob' }) });
    expect(guard.countOf(CH)).toBe(0);
  });

  it("a PEER NODE's bare 'stop' never pulls the kill switch — the operator's still does", async () => {
    const pulls = [];
    const { spine } = buildRealSpine({
      guard: createStopGuard({ turns: 6 }),
      stopSwitch: { present: () => false, pull: (why) => pulls.push(why) },
    });
    // An UNDECODABLE frame renders to NOTHING, so the rendered body is the bare safe word and
    // parseStopWord matches it: provenance is the only thing left standing between a peer node
    // and the kill switch.
    await spine.handleInbound({ body: 'stop\u{E0001}\u{E007F}', from: realFrom({ msgKey: 'peer-stop' }) });
    expect(pulls).toHaveLength(0);
    // …and the operator typing the word in Self still takes the service down.
    await spine.handleInbound({ body: 'stop', from: realFrom({ msgKey: 'op-stop', isSender: false }) });
    expect(pulls).toHaveLength(1);
  });

  it('a FLAG EMOJI and a PASTED zero-width run survive renderNodeSignature and stay human', async () => {
    // renderNodeSignature now runs on these for real. It must leave them byte-identical (the RGI
    // sequence has no U+E0001 opener; ZWSP/BOM are not in the tags block at all) AND they must
    // still reset the counter — a naive "any invisible character" rule fails both.
    const guard = createStopGuard({ turns: 4 });
    const { spine, transcript } = buildRealSpine({ guard });
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    const paste = 'as the docs say:\u{200B} the\u{FEFF} value\u{200C} is\u{200D} lazy';
    for (const [i, body] of [`vamos ${scotland}`, paste].entries()) {
      await spine.handleInbound({ body: `aquí${SIG_DO}`, from: realFrom({ msgKey: `peer-${i}` }) });
      expect(guard.countOf(CH)).toBe(1);
      await spine.handleInbound({ body, from: realFrom({ msgKey: `h${i}`, isSender: false, senderName: 'Bob' }) });
      expect(transcript.logged.at(-1).body).toBe(body);      // untouched by the render
      expect(guard.countOf(CH)).toBe(0);                     // and human
    }
  });
});
