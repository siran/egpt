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

describe('THE TRAP — mesh handling is completely unaffected', () => {
  it('the guard still classifies + counts an envelope on the channel (the loop cap is not weakened)', async () => {
    const { spine, meshCalls, guard } = harness();
    for (let i = 0; i < 3; i++) await spine.handleInbound(onRelay(envelope(), { msgKey: `m${i}` }));
    expect(meshCalls).toHaveLength(3);
    expect(guard.countOf(`whatsapp:${RELAY_ID}`)).toBe(3);
  });

  it('a STOPPED channel still suppresses the responder turn (transit changed the record, not the gate)', async () => {
    const { spine, meshCalls, guard } = harness();
    for (let i = 0; i < 8; i++) await spine.handleInbound(onRelay(envelope(), { msgKey: `m${i}` }));
    expect(guard.blocked(`whatsapp:${RELAY_ID}`)).toBe(true);
    expect(meshCalls).toHaveLength(6);          // turns:6 — the 7th and 8th are suppressed
  });

  it('a LIFECYCLE command on the channel is still the way back out of a wedged node', async () => {
    // /restart exits the process, so it is asserted through commands.isCommand/run rather than
    // run for real. The point is only that the transit check sits BELOW that branch.
    const ran = [];
    const bridge = { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false };
    const brain = { async turn() { return { text: '' }; } };
    const identity = createIdentity({ now: () => 1000 });
    const transcript = { logged: [], async log(ev) { this.logged.push(ev.chatId); } };
    const s2 = createSpine({
      bridge, brain, identity,
      router: { resolve: () => 'egpt' },
      gating: { async decide() { return { mode: 'on', receives: true, mayReply: false, sendToEgpt: 'mode' }; }, surfaces: () => false },
      sender: { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } },
      transcript, heartbeats: { runDue() {} },
      commands: { isCommand: (ev) => String(ev.body ?? '').startsWith('/'), run: async (ev) => ran.push(ev.body) },
      isTransit: (ev) => isRelayChannelChat(CFG, ev),
      clock: { now: () => 1000 }, turnTimeoutMs: 0,
    });
    await s2.handleInbound(onRelay('/restart'));
    expect(ran).toEqual(['/restart']);          // still dispatched…
    expect(transcript.logged).toEqual([]);      // …and still not a conversation
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
