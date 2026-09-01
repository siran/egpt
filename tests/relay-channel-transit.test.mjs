// relay-channel-transit.test.mjs — A RELAY CHANNEL IS TRANSIT, NOT A CONVERSATION.
//
// Operator 2026-08-31: *"when a message arrived to a 'egpt-mesh-*' channel, it must be treated
// as a transit message. the log if required is in beeper itself."*
//
// THE LIVE EVIDENCE on kg, both of which should not exist:
//   ~/.egpt/conversations/whatsapp/egpt-mesh-do-kg-2608311419/transcript.md
//   conversations.yaml: EWlUhmXiFZTYGiKdbfRP → agents.egpt.threadId 30688631-… (14:21 today)
// A chat named as some agent's `relay_channel` was an ordinary WhatsApp group this node belongs
// to, so its traffic ran the normal ingestion path and grew a slug, a record and a thread — a
// second, worse copy of what Beeper already holds.
//
// THE TRAP, and the reason every case here checks BOTH halves: envelopes ARRIVE on that chat and
// must still be processed. Skipping the RECORD must not skip the ROUTING. classify() returns for
// a mesh envelope two branches ABOVE the transit check, which is what makes that structural
// rather than remembered — so each assertion below pairs "not recorded" with "still handled".
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';
import { relayChannels, isRelayChannelChat } from '../src/spine/node-names.mjs';

// kg's live shape: a persona, and the relay agent whose channel IS the transit chat.
const CFG = {
  node_name: 'kg',
  agents: {
    egpt: { handles: ['e', 'egpt'], default: true },
    don: { configuration: 'relay', relay_channel: 'egpt-mesh-do-kg', to: 'don.do' },
    _note: 'a comment key, never a route',
  },
};

// The transit chat as it really arrives: the bridge reports the Matrix id, and the chat's NAME is
// what config.yaml declares as the relay_channel.
const RELAY_ID = 'EWlUhmXiFZTYGiKdbfRP';
const RELAY_NAME = 'egpt-mesh-do-kg';

const onRelay = (body, over = {}) => ({
  body,
  from: { network: 'whatsapp', chatId: RELAY_ID, chatName: RELAY_NAME, userId: 'u-an', senderName: 'An', authorized: true, msgKey: 'm1', ...over },
});
const elsewhere = (body, over = {}) => ({
  body,
  from: { network: 'whatsapp', chatId: '!fam', chatName: 'familia', userId: 'u-bob', senderName: 'Bob', msgKey: 'm2', ...over },
});
// A genuine request envelope, exactly the wire form the mesh puts on the channel.
const envelope = () => encodeMesh({ by: 'An', body: 'hola @don', from: 'familia', from_node: 'kg', to: 'don.do' });

// THE UNNAMED WIRE — the 2026-08-31 ACCOUNT SPLIT shape, measured on the operator's profile: a
// SECOND egpt-mesh-do-kg chat appeared, its pushedName was never recorded (its conversations.yaml
// entry still carries the raw chat id as its comment), so the arriving event has NO chatName to
// match `relay_channel: egpt-mesh-do-kg` against. Same configured channel, same traffic, and
// isRelayChannelChat answers FALSE for it — a chat-identity test fails exactly when a channel is
// NEW, which is exactly when it must not.
const SPLIT_ID = 'HkQpZvNrLmTdWbXe';
const onUnnamed = (body, over = {}) => ({
  body,
  from: { network: 'whatsapp', chatId: SPLIT_ID, chatName: null, userId: 'u-an', senderName: 'An', authorized: true, msgKey: 'u1', ...over },
});

// `wired: false` builds the spine with NO isTransit at all — literally the pre-change
// derivation, which is what makes the LOCKs below a comparison against the old code rather
// than the new code agreeing with itself.
function harness({ wired = true, cfg = CFG } = {}) {
  const meshCalls = [];
  const bridge = { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false };
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, chatId: ev.chatId, body: ev.body }); return { text: 'ok' }; } };
  const identity = createIdentity({ now: () => 1000 });        // the REAL one
  const router = { resolve: () => 'egpt' };
  const gating = {
    async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; },
    surfaces: () => true,
  };
  const transcript = { logged: [], async log(ev, reply) { this.logged.push({ chatId: ev.chatId, body: ev.body, reply: reply ?? null }); } };
  const heartbeats = { runDue() {} };
  const sender = { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
  const mesh = { isEnvelope: (ev) => parseMesh(ev?.body ?? '') != null, async handle(ev) { meshCalls.push({ chatId: ev.chatId, body: ev.body }); } };
  const guard = createStopGuard({ turns: 6 });
  const spine = createSpine({
    bridge, brain, identity, router, gating, sender, transcript, heartbeats, mesh, guard,
    clock: { now: () => 1000 }, turnTimeoutMs: 0,
    ...(wired ? { isTransit: (ev) => isRelayChannelChat(cfg, ev) } : {}),
  });
  return { spine, brain, transcript, meshCalls, guard };
}

// A spine wired for the COMMAND path only (`/restart` exits the process for real, so it is
// asserted through commands.isCommand/run rather than run). `guard` is optional: without one the
// case is purely about where the transit check sits; with one it is about the guard not being
// able to lock the operator out of a stopped transport.
function commandSpine({ guard = null } = {}) {
  const ran = [];
  const transcript = { logged: [], async log(ev) { this.logged.push(ev.chatId); } };
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
    brain: { async turn() { return { text: '' }; } },
    identity: createIdentity({ now: () => 1000 }),
    router: { resolve: () => 'egpt' },
    gating: { async decide() { return { mode: 'on', receives: true, mayReply: false, sendToEgpt: 'mode' }; }, surfaces: () => false },
    sender: { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } },
    transcript, heartbeats: { runDue() {} },
    commands: { isCommand: (ev) => String(ev.body ?? '').startsWith('/'), run: async (ev) => ran.push(ev.body) },
    isTransit: (ev) => isRelayChannelChat(CFG, ev),
    guard, clock: { now: () => 1000 }, turnTimeoutMs: 0,
  });
  return { spine, ran, transcript };
}

describe('REPRODUCE-FIRST — the transcript, the registration and the thread on a relay channel', () => {
  it('an ENVELOPE on the relay channel is HANDLED but never recorded (no slug, no transcript.md, no stats)', async () => {
    const { spine, transcript, meshCalls } = harness();
    await spine.handleInbound(onRelay(envelope()));
    // The record is where the conversation gets REGISTERED: transcript.log resolves the slug
    // through contacts.resolve → ensureContact, which is what wrote the conversations.yaml entry
    // and mkdir'd conversations/whatsapp/egpt-mesh-do-kg-…/. No call, none of it.
    expect(transcript.logged).toEqual([]);
    // …and the routing is untouched: the envelope still reaches the mesh.
    expect(meshCalls).toHaveLength(1);
  });

  it('ORDINARY chat on the relay channel runs NO turn — which is what minted agents.egpt.threadId there', async () => {
    const { spine, brain, transcript } = harness();
    // A gate that WOULD reply (mode 'on', mayReply true) — so the only thing keeping the being
    // out of the pipe is the transit rule, not the mode.
    await spine.handleInbound(onRelay('hola?'));
    expect(brain.calls).toEqual([]);            // a thread is minted by a TURN; no turn, no thread
    expect(transcript.logged).toEqual([]);
  });

  it('THE SAME MESSAGES on an ordinary chat are recorded and answered exactly as before', async () => {
    const { spine, brain, transcript, meshCalls } = harness();
    await spine.handleInbound(elsewhere('hola?'));
    await spine.handleInbound(elsewhere(envelope(), { chatId: '!fam2', msgKey: 'm3' }));
    expect(transcript.logged.map((l) => l.chatId)).toContain('!fam');
    expect(brain.calls.map((c) => c.chatId)).toEqual(['!fam']);
    expect(meshCalls).toHaveLength(1);          // an envelope elsewhere is still an envelope
  });
});

// === AN ENVELOPE IS NEVER A RECORD, WHATEVER CHAT IT LANDS IN ==============================
// The RECORD half of the ruling f013bea made for the guard channel: ask about the MESSAGE, never
// about the chat. `isTransit` (isRelayChannelChat) can only recognise a wire whose NAME this node
// has already learned; `isEnvelope` needs nothing learned and nothing configured, because relay
// traffic is recognisable in the FRAME from the first one. The two are OR'd, NOT swapped — the
// name test stays the only thing that catches a HUMAN line typed into a wire, which is not an
// envelope, and the cases below check both halves are still doing their own job.
describe('AN ENVELOPE IS NEVER RECORDED — the message, not the chat', () => {
  it('REPRODUCE-FIRST: an envelope on the UNNAMED relay channel is handled but never recorded', async () => {
    // Stated first, so this case cannot quietly stop modelling the live shape: the chat-identity
    // test is blind to this chat by construction.
    expect(isRelayChannelChat(CFG, { chatId: SPLIT_ID, chatName: null })).toBe(false);
    const { spine, brain, transcript, meshCalls } = harness();
    await spine.handleInbound(onUnnamed(envelope()));
    // FAILED before this change with ONE inbound line — and that one line is the whole defect:
    // transcript.log is where the conversation gets REGISTERED (contacts.resolve → ensureContact
    // writes the conversations.yaml entry and mkdirs conversations/whatsapp/egpt-mesh-do-kg-…/),
    // so it IS the folder and the transcript.md a relay channel must never have.
    expect(transcript.logged).toEqual([]);
    expect(brain.calls).toEqual([]);            // never dispatched as chat…
    expect(meshCalls).toHaveLength(1);          // …and the routing is untouched
  });

  it('a HUMAN line on that same unnamed channel is STILL an ordinary conversation — the residual half, locked', async () => {
    // The honest limit of a message-level test, locked so it is not mistaken for closed. Chatter
    // in a wire — a human wandering in, our own 🤔 placeholder escaping the echo gate, a peer's
    // mirror frame — is NOT an envelope, so only the NAME test can recognise it, and on this chat
    // the name test is blind. That is what mints `agents.egpt.threadId` on a channel that should
    // have none. Closing it needs isRelayChannelChat to learn the id: a different change, on a
    // different file, deliberately not made here.
    const { spine, brain, transcript } = harness();
    await spine.handleInbound(onUnnamed('hola?', { msgKey: 'u2' }));
    expect(transcript.logged.map((l) => l.chatId)).toContain(SPLIT_ID);
    expect(brain.calls.map((c) => c.chatId)).toEqual([SPLIT_ID]);
  });

  it('DECISION — a stray envelope in an ORDINARY chat is not recorded either: relay traffic is not chat wherever it lands', async () => {
    // Not a hypothetical. mesh's SELF-FALLBACK posts envelopes into the Self chat BY DESIGN when a
    // relay channel does not resolve (mesh.mjs selfRoute — "Relaying through this chat meanwhile"),
    // so the chat an envelope arrives in is not reliably a wire and a chat-identity test can never
    // cover that case; a message-level one covers it for free. Nothing is lost: since f70edce the
    // relayed turn runs in the ORIGIN conversation and is recorded THERE, and the frame itself is
    // in Beeper. What is avoided is a machine frame in a human transcript — which is not an audit
    // trail, it is read BACK into the next prompt as recent context.
    const { spine, brain, transcript, meshCalls } = harness();
    await spine.handleInbound(elsewhere(envelope(), { msgKey: 'e1' }));
    expect(transcript.logged).toEqual([]);
    expect(brain.calls).toEqual([]);
    expect(meshCalls).toHaveLength(1);          // still decoded and acted on, exactly as before
  });

  it('…and that chat itself is NOT transit: an ordinary line in it records and answers exactly as before', async () => {
    const { spine, brain, transcript } = harness();
    await spine.handleInbound(elsewhere(envelope(), { msgKey: 'e1' }));
    await spine.handleInbound(elsewhere('hola?', { msgKey: 'e2' }));
    expect(transcript.logged.filter((l) => l.reply == null).map((l) => l.chatId)).toEqual(['!fam']);
    expect(brain.calls.map((c) => c.chatId)).toEqual(['!fam']);
  });
});

// === A TRANSPORT IS NOT A GUARD CHANNEL (live outage 2026-09-01) ============================
// The same "transit is not a conversation" fact, one layer down: the LOOP COUNTER was keyed on
// the chat the envelope ARRIVED IN, i.e. the wire, instead of the conversation the turn runs in.
//
// THE LIVE EVIDENCE, from the operator's own log that morning:
//   guard: whatsapp:EWlUhmXiFZTYGiKdbfRP stopped — mesh turn suppressed
//   [bridge] incoming [perrito traduciones] Rodz Rodriguez: "⚠ ekg.kg did not answer"
// egpt-mesh-do-kg auto-STOPped three times before lunch, each time `nearing the loop cap (4)`
// then `[guard] STOP` — and E went silent in a chat the guard never even looked at.
//
// WHY IT COULD ONLY EVER MISFIRE HERE: the counter is a LOOP detector resting on one assumption,
// written in stop-guard.mjs's own header — "a human turn resets the count, so normal conversation
// never trips it". On a relay channel every message is an envelope, isHumanTurn correctly says an
// envelope is not a human turn, so the count only ever climbs. Not a loop detector: a countdown
// to a permanent stop, unrecoverable in practice because clearing it needs a `resume` typed in a
// machine-to-machine channel nobody watches.
describe('THE TRANSPORT IS NOT THE GUARD CHANNEL — an envelope carries none', () => {
  it('REPRODUCE-FIRST: N+1 envelopes with no human between them ALL dispatch (the 7th and 8th used to be suppressed)', async () => {
    const { spine, meshCalls, guard } = harness();     // turns: 6
    for (let i = 0; i < 8; i++) await spine.handleInbound(onRelay(envelope(), { msgKey: `m${i}` }));
    expect(meshCalls).toHaveLength(8);                 // was 6: the channel auto-STOPped at the 6th
    expect(guard.blocked(`whatsapp:${RELAY_ID}`)).toBe(false);
  });

  it('an envelope never TOUCHES the counter — so a relay channel can no longer auto-stop at all', async () => {
    // The consequence, stated out loud rather than discovered later: the only messages left that
    // can move this channel's counter are HUMAN ones, and a human turn resets it. Loop protection
    // for relayed traffic did not vanish — since f70edce a relayed turn runs in the ORIGIN
    // conversation, which has its own channel, its own counter and real human turns that reset it
    // (locked in tests/spine-mesh.test.mjs, "the protection moved").
    const { spine, guard } = harness();
    for (let i = 0; i < 20; i++) await spine.handleInbound(onRelay(envelope(), { msgKey: `m${i}` }));
    expect(guard.countOf(`whatsapp:${RELAY_ID}`)).toBe(0);
    expect(guard.status().stoppedChannels).toEqual([]);
  });

  it('a HUMAN message in the relay channel KEEPS its guard channel — `resume` typed there still clears a stop', async () => {
    // Load-bearing, and it is how the operator recovered that morning: he typed `resume` in
    // egpt-mesh-do-kg and it worked. Only ENVELOPES go unguarded.
    const { spine, guard } = harness();
    guard.stopChannel(`whatsapp:${RELAY_ID}`);         // however it got stopped, this is the way out
    expect(guard.blocked(`whatsapp:${RELAY_ID}`)).toBe(true);
    await spine.handleInbound(onRelay('resume', { msgKey: 'r1' }));
    // blocked(true → false) is the whole assertion: a `resume` that derived the `null` channel an
    // envelope now gets would have cleared nothing at all.
    expect(guard.blocked(`whatsapp:${RELAY_ID}`)).toBe(false);
  });

  it('`resume all` typed there clears every channel too (the counter can stop several)', async () => {
    const { spine, guard } = harness();
    guard.stopChannel(`whatsapp:${RELAY_ID}`);
    guard.stopChannel('whatsapp:!fam');
    await spine.handleInbound(onRelay('resume all', { msgKey: 'r2' }));
    expect(guard.status().stoppedChannels).toEqual([]);
  });
});

describe('THE TRAP — mesh handling is completely unaffected', () => {
  it('a LIFECYCLE command on the channel is still the way back out of a wedged node', async () => {
    // /restart exits the process, so it is asserted through commands.isCommand/run rather than
    // run for real. The point is only that the transit check sits BELOW that branch.
    const { spine, ran, transcript } = commandSpine();
    await spine.handleInbound(onRelay('/restart'));
    expect(ran).toEqual(['/restart']);          // still dispatched…
    expect(transcript.logged).toEqual([]);      // …and still not a conversation
  });

  it('…and it still is with the guard wired and that very channel STOPPED (lifecycle is exempt)', async () => {
    // The operator's way back out of a wedged node must survive a stopped transport: isLifecycle
    // returns above the guard block, so neither blocked() nor the counter can lock it out.
    const guard = createStopGuard({ turns: 6 });
    const { spine, ran } = commandSpine({ guard });
    guard.stopChannel(`whatsapp:${RELAY_ID}`);
    await spine.handleInbound(onRelay('/restart'));
    expect(ran).toEqual(['/restart']);
  });
});

describe('BYTE-IDENTICAL — a node with no relay channels', () => {
  it('the SAME two messages record and dispatch identically with the seam absent and with it wired to an agent-less config', async () => {
    const runs = [];
    for (const h of [harness({ wired: false }), harness({ wired: true, cfg: { node_name: 'kg', agents: {} } })]) {
      await h.spine.handleInbound(onRelay('hola?'));
      await h.spine.handleInbound(elsewhere('y aquí también'));
      runs.push({ logged: h.transcript.logged, turns: h.brain.calls });
    }
    expect(runs[0].logged).toEqual(runs[1].logged);
    expect(runs[0].turns).toEqual(runs[1].turns);
    // …and both are the OLD behaviour: the relay chat is an ordinary conversation to them
    // (one INBOUND line per message — `reply: null` — plus the reply line each turn appends).
    expect(runs[0].logged.filter((l) => l.reply == null).map((l) => l.chatId)).toEqual([RELAY_ID, '!fam']);
    expect(runs[0].turns.map((t) => t.chatId)).toEqual([RELAY_ID, '!fam']);
  });
});

describe('relayChannels / isRelayChannelChat — derived from THE routing table, never re-derived', () => {
  it('every agent route contributes its channel, lowercased; `_` comment keys and non-routes do not', () => {
    expect(relayChannels(CFG)).toEqual(new Set(['egpt-mesh-do-kg']));
    // MULTIPATH is an ordinary map with `paths:` — each path's channel is its own route.
    expect(relayChannels({ agents: { carol: { paths: [
      { p1: { relay_channel: 'Rodz1', to: 'don.do' } },
      { p2: { relay_channel: 'egpt-mesh', to: 'don.do' } },
    ] } } })).toEqual(new Set(['rodz1', 'egpt-mesh']));
    // A path with NO `to:` is not a route — agentRoutes has always skipped it, and this reuses
    // agentRoutes rather than growing a second walk of the agents block.
    expect(relayChannels({ agents: { open: { relay_channel: 'open-channel' } } })).toEqual(new Set());
    expect(relayChannels({})).toEqual(new Set());
  });

  it('matches the chat by NAME (how a relay_channel is configured) or by raw ID (how one may be)', () => {
    expect(isRelayChannelChat(CFG, { chatId: RELAY_ID, chatName: RELAY_NAME })).toBe(true);
    expect(isRelayChannelChat(CFG, { chatId: RELAY_ID, chatName: 'EGPT-Mesh-DO-KG' })).toBe(true);   // case-insensitive
    const byId = { node_name: 'kg', agents: { don: { relay_channel: RELAY_ID, to: 'don.do' } } };
    expect(isRelayChannelChat(byId, { chatId: RELAY_ID, chatName: 'whatever the group is called' })).toBe(true);
    expect(isRelayChannelChat(CFG, { chatId: '!fam', chatName: 'familia' })).toBe(false);
    expect(isRelayChannelChat({}, { chatId: RELAY_ID, chatName: RELAY_NAME })).toBe(false);
  });
});
