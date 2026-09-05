// spine-mesh.test.mjs — the v2 WIRING level for Phase 4b cross-node relay. The mesh
// ENGINE (src/mesh/relay.mjs) is already test-locked (tests/mesh-relay.test.mjs); here
// we exercise the mesh SERVICE (src/spine/mesh.mjs) — the adapters that feed the engine
// from v2's bridge/brain/config — and the spine SEAM (handleInbound routing to mesh),
// all against fakes. No network, no Claude, no relay.mjs internals asserted directly.
import { describe, it, expect } from 'vitest';
import { createMeshService } from '../src/spine/mesh.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
// The responder's nugget is rendered through the SHARED wrap, so since 2026-07-26 it also carries
// the STRUCTURAL (invisible, tag-encoded) node id of the node that rendered it — decoded here so
// the assertions read the visible bytes and the node id separately.
import { decodeNodeSignature, stripNodeSignature } from '../src/node-signature.mjs';

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

// A fake Bridge port exposing just the surface the mesh service uses.
function fakeBridge({ chatIds = {} } = {}) {
  const b = {
    sent: [],          // { chat, text }
    statusPosts: [],   // { chat, text, id }
    streams: [],       // { chat, init, opts, updates[], finals[], delivered }
    resolveCalls: [],  // { nameOrId, opts } — records the network pin canonRoute passes through
    // name→id resolution, as the real bridge does (relay_channel is configured by NAME;
    // an observed envelope's ev.chatId is always the RESOLVED id). Unknown → identity.
    // The optional 2nd arg is the network pin (operator 2026-07-06) — recorded, not applied.
    // An explicit `null` value models a chat the bridge CANNOT resolve (absent, or simply not
    // visible to it) — the live "send DROPPED … resolved=null" case.
    async resolveChatId(nameOrId, opts) { b.resolveCalls.push({ nameOrId, opts }); return (nameOrId in chatIds) ? chatIds[nameOrId] : nameOrId; },
    send(chat, text) { b.sent.push({ chat, text }); return { ok: true }; },
    async postStatus(chat, text) { const id = `post-${b.statusPosts.length + 1}`; b.statusPosts.push({ chat, text, id }); return id; },
    startStream(chat, init, opts = {}) {
      const h = { chat, init, opts, updates: [], finals: [], delivered: false, lastError: null };
      h.update = (t) => h.updates.push(t);
      h.finish = async (t) => { h.finals.push(t); h.delivered = true; };
      h.delete = async () => {};
      b.streams.push(h);
      return h;
    },
  };
  return b;
}

function fakeBrain({ reply = 'yes here', partials = [] } = {}) {
  return {
    calls: [],
    async turn(being, ev, onPartial) {
      this.calls.push({ being, ev });
      for (const p of partials) onPartial?.(p);
      return { text: reply, sessionId: 's1', being };
    },
  };
}

// Fake timers so the origin-wait timeout is deterministic (no real time).
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
  };
}

const EMOJI = { don: '🤝', wren: '🐦' };
const bodyEmojiOf = (b) => EMOJI[String(b).toLowerCase()] ?? '';

function svc({ node, aliases = [], agents = {}, meshCfg = {}, brain, timers, logs, chatIds = {}, selfChatId = null, sig = {}, loadState } = {}) {
  const bridge = fakeBridge({ chatIds });
  const cfg = { node_name: node, node_alias: aliases, agents, mesh: meshCfg, ...sig };   // sig = this node's bridge_signature_* (the keys boot hands the ports)
  const mesh = createMeshService({
    bridge, brain: brain ?? fakeBrain(),
    getConfig: () => cfg, bodyEmojiOf,
    getSelfChatId: () => selfChatId,
    setTimer: timers?.setTimer, clearTimer: timers?.clearTimer,
    ...(loadState ? { loadState } : {}),   // allowed_users per-conversation override (operator 2026-08-15) — default: no-op
    onLog: (m) => logs?.push(m),
  });
  return { bridge, mesh, cfg };
}

describe('mesh service — outbound (origin relays through a relay agent)', () => {
  it('(a) posts a 🤔 placeholder + an encoded request envelope to the relay_channel, with the return-address', async () => {
    const { bridge, mesh } = svc({ node: 'kg' });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don do X' };

    const ok = await mesh.forward(ev, { being: 'don', route: { room_id: 'RELAY' }, to: 'don.do' });
    expect(ok).toBe(true);

    // origin placeholder (its id rides as post_id)
    expect(bridge.statusPosts).toEqual([{ chat: 'CHAT', text: '🤔 thinking…', id: 'post-1' }]);

    // one envelope, to the relay chat, round-tripping via parseMesh (no minted mid — the origin
    // correlates the reply by the re:+awaiting return-address alone)
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].chat).toBe('RELAY');
    const p = parseMesh(bridge.sent[0].text);
    expect(p).toMatchObject({ to: 'don.do', from: 'HFM', from_node: 'kg', by: 'An', body: '@don do X', post_id: 'post-1' });
  });

  it('EVICTION LOCK: a routeless target (the old { being, node } mesh.nodes shape) is REJECTED, not relayed', async () => {
    // Routing is the agent now (operator 2026-07-25): a target that names a node but carries no
    // relay_channel route has no way to travel, so forward refuses it outright rather than
    // minting a phantom relay. Nothing is posted anywhere — not even a placeholder.
    const logs = [];
    const { bridge, mesh } = svc({ node: 'kg', logs });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don.do hi' };
    const ok = await mesh.forward(ev, { being: 'don', node: 'do', target: 'don.do' });
    expect(ok).toBe(false);
    expect(bridge.sent).toHaveLength(0);
    expect(bridge.statusPosts).toHaveLength(0);
    expect(logs.some((m) => /bad target/.test(m))).toBe(true);
  });

  it('ROUTE-DIRECT (a relay agent): forward posts the envelope straight to the relay_channel chat, open-channel (empty `to`)', async () => {
    // The router hands mesh.forward a route-direct target { being, route } — the relay_channel
    // IS the route. The envelope lands in that chat.
    const { bridge, mesh } = svc({ node: 'kg', meshCfg: {} });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don hola' };

    const ok = await mesh.forward(ev, { being: 'don', route: { room_id: 'Rodz' } });
    expect(ok).toBe(true);

    // origin placeholder still posted (the living mirror will edit it)
    expect(bridge.statusPosts).toEqual([{ chat: 'CHAT', text: '🤔 thinking…', id: 'post-1' }]);

    // ONE envelope, posted into the relay_channel "Rodz"
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].chat).toBe('Rodz');
    const p = parseMesh(bridge.sent[0].text);
    expect(p).toMatchObject({ from: 'HFM', from_node: 'kg', by: 'An', body: '@don hola', post_id: 'post-1' });
    expect(p.to).toBe('');                     // open-channel: the owner of "don" answers, others silent
  });
});

// ── MULTIPATH (operator 2026-07-06: multipath is configuration — an agent is a list of paths,
//    every message through every path). @carol fans out ONE envelope per path — same body, same
//    return address, same placeholder (ONE 🤔 / post_id) — each posting into its OWN relay_channel
//    with its OWN network pin. First reply home wins the placeholder; a later duplicate is consumed. ──
describe('mesh service — multipath outbound (a list agent fans out one envelope per path)', () => {
  const target = {
    being: 'carol',
    paths: [
      { route: { room_id: 'rodz1', network: 'whatsapp' }, to: 'don.do', label: 'path1' },
      { route: { room_id: 'egpt-mesh', network: 'telegram' }, to: 'don.do', label: 'path2' },
    ],
  };

  it('REPRODUCE-FIRST: posts ONE 🤔 placeholder + TWO envelopes (different resolved chats, SAME post_id/re/body)', async () => {
    const chatIds = { rodz1: 'ID1', 'egpt-mesh': 'IDM' };
    const { bridge, mesh } = svc({ node: 'kg', chatIds });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@carol hola' };

    const ok = await mesh.forward(ev, target);
    expect(ok).toBe(true);

    // ONE placeholder for the human (not N)
    expect(bridge.statusPosts).toEqual([{ chat: 'CHAT', text: '🤔 thinking…', id: 'post-1' }]);

    // TWO envelopes, one per path, into the RESOLVED relay-channel ids (name → id via canonRoute)
    expect(bridge.sent.map((s) => s.chat).sort()).toEqual(['ID1', 'IDM']);
    // each path resolved its NAME with its own network pin
    expect(bridge.resolveCalls).toContainEqual({ nameOrId: 'rodz1', opts: { network: 'whatsapp' } });
    expect(bridge.resolveCalls).toContainEqual({ nameOrId: 'egpt-mesh', opts: { network: 'telegram' } });

    // both envelopes share body / return-address / placeholder id; via is seeded with carol.kg (origin hop)
    const parsed = bridge.sent.map((s) => parseMesh(s.text));
    for (const p of parsed) {
      expect(p).toMatchObject({ to: 'don.do', from: 'HFM', from_node: 'kg', by: 'An', body: '@carol hola', post_id: 'post-1', via: 'carol.kg' });
    }
  });

  it('a path failing (send throws) does NOT kill the other path — the surviving envelope still posts', async () => {
    const chatIds = { rodz1: 'ID1', 'egpt-mesh': 'IDM' };
    const { bridge, mesh } = svc({ node: 'kg', chatIds });
    const realSend = bridge.send.bind(bridge);
    bridge.send = (chat, text) => { if (chat === 'ID1') throw new Error('boom'); return realSend(chat, text); };
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@carol hola' };

    const ok = await mesh.forward(ev, target);
    expect(ok).toBe(true);                                   // at least one path survived
    expect(bridge.sent.map((s) => s.chat)).toEqual(['IDM']); // the good path posted; the failed one did not
  });

  it('FIRST reply home wins the placeholder; the duplicate (same post_id) is consumed without a second mirror', async () => {
    const chatIds = { rodz1: 'ID1', 'egpt-mesh': 'IDM' };
    const { bridge, mesh } = svc({ node: 'kg', chatIds });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@carol hola' };
    await mesh.forward(ev, target);                          // posts placeholder 'post-1' + two envelopes

    // reply #1 arrives (via path1's room) and finalizes the origin mirror
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'r1', body: encodeMesh({ by: 'don.do', body: '🤝 hey', re: 'HFM.kg', post_id: 'post-1', done: true }) });
    // reply #2 (a duplicate, SAME post_id, via path2's room) must be consumed silently — no second mirror
    await mesh.handle({ surface: 'wa', chatId: 'IDM', msgId: 'r2', body: encodeMesh({ by: 'don.do', body: '🤝 hey', re: 'HFM.kg', post_id: 'post-1', done: true }) });

    const mirrors = bridge.streams.filter((s) => s.opts?.existingMsgId === 'post-1');
    expect(mirrors).toHaveLength(1);                         // exactly one placeholder mirror opened
    expect(mirrors[0].finals).toContain('🤝 hey');
  });
});

describe('mesh service — responder (a request arrives at the owning node)', () => {
  it('(b) runs the target local being (brain.turn) and edit-streams the reply as an envelope (re/post_id/done), mirrored', async () => {
    const brain = fakeBrain({ reply: 'aquí', partials: ['aq', 'aquí'] });
    const { bridge, mesh } = svc({ node: 'do', agents: { don: { configuration: 'sonnet-high', name: 'don' } }, brain });
    const req = encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', from_node: 'kg', to: 'don.do', post_id: 'p1' });

    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();

    // ran the being (mention stripped → prompt 'hola'), not the persona
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('don');
    expect(brain.calls[0].ev.body).toBe('hola');

    // ONE streamed relay-room message; its frames wrap the being's reply in the mesh tail
    expect(bridge.streams).toHaveLength(1);
    const s = bridge.streams[0];
    expect(s.chat).toBe('RELAY');
    // The reply is RENDERED INTO the payload by the shared persona wrap — the same renderer a
    // local reply gets — so the being's identity travels inside the nugget. Live frames carry the
    // bare stamp (the ports' once-at-the-end convention); the final carries the full wrap.
    expect(stripNodeSignature(parseMesh(s.updates.at(-1)).body)).toBe('🤝 don: aquí');
    const fin = parseMesh(s.finals.at(-1));
    expect(fin).toMatchObject({ by: 'don.do', re: 'HFM.kg', post_id: 'p1', done: true });
    expect(stripNodeSignature(fin.body)).toBe('🤝 don: aquí');
    expect(decodeNodeSignature(fin.body)).toBe('do');   // the STRUCTURAL id of the node that rendered it
  });

  // THE NUGGET (operator 2026-07-25: "signing by do, in this case, is the message being
  // transported… it's a nugget that gets signed again on delivery in shell"). The responder
  // renders its reply COMPLETELY — shared stamp + its OWN bridge signature — BEFORE encodeMesh,
  // so the rendering is the payload and travels intact. Rendering at SEND time instead would put
  // the signature outside the fence, where parseMesh (relay.mjs) stops recognising the envelope.
  it('the responder renders the nugget through the SHARED wrap: its stamp + its OWN bridge signature ride INSIDE the payload', async () => {
    const brain = fakeBrain({ reply: 'aquí' });
    // bridge_signature_* = do's own node signature, the SAME config keys boot hands the ports.
    const { bridge, mesh } = svc({ node: 'do', agents: { don: { configuration: 'sonnet-high', name: 'don' } }, brain, sig: { bridge_signature_open: '🌉do', bridge_signature_close: '🌉do' } });
    const req = encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', from_node: 'kg', to: 'don.do', post_id: 'p1' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();

    const wire = bridge.streams[0].finals.at(-1);
    expect(stripNodeSignature(parseMesh(wire).body)).toBe('🌉do 🤝 don: aquí 🌉do');   // stamp + VISIBLE signature INSIDE the nugget
    expect(decodeNodeSignature(parseMesh(wire).body)).toBe('do');                        // …and the STRUCTURAL one too
    expect(parseMesh(wire)).toMatchObject({ by: 'don.do', done: true });                 // …and the envelope still parses
  });

  it('TASK-3 (terminal dedup): two identical envelopes (same post_id, DIFFERENT arrival rooms) → the being answers ONCE', async () => {
    // The multipath fan-out delivers the SAME request to the terminal via two channels. The engine's
    // `seen` replay guard keys on `${being}${from}${body}` — identical across the paths (same being
    // from `to`, same origin, same human body) — so the second delivery is dropped: ONE brain.turn,
    // redundant transport. (No new dedup machinery — this falls out of the existing guard.)
    const brain = fakeBrain({ reply: 'aquí' });
    const { bridge, mesh } = svc({ node: 'do', agents: { don: { configuration: 'sonnet-high', name: 'don' } }, brain });
    const req = encodeMesh({ by: 'An', body: '@carol hola', from: 'HFM', from_node: 'kg', to: 'don.do', post_id: 'post-1' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'm1', body: req });     // path1 arrival
    await mesh.handle({ surface: 'wa', chatId: 'IDM', msgId: 'm2', body: req });     // path2 duplicate
    await flush();
    expect(brain.calls).toHaveLength(1);                                            // answered exactly once
    expect(bridge.streams).toHaveLength(1);                                         // one reply stream, not two
  });

  // NEVER SILENCE, restated to the truth (operator 2026-07-26: "disabling is just commenting the
  // config. no need to have or check an enabled key in this case"). This used to prove the
  // not-here answer for a being carrying `enabled: false`; that state no longer exists, so the
  // case it now covers is the one that actually occurs live — the being is COMMENTED OUT of (or
  // was never in) this node's registry.
  it('answers "no <being>.<node> here" (never silence) when the being is not in the registry', async () => {
    const { bridge, mesh } = svc({ node: 'do', agents: { someoneelse: { configuration: 'sonnet-high', name: 'someoneelse' } } });
    const req = encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', from_node: 'kg', to: 'don.do', mid: 'M9' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();
    const said = bridge.sent.map((s) => parseMesh(s.text)?.body).filter(Boolean);
    expect(said).toContain('no don.do here');
  });

  // …and the counterpart: an INERT `enabled: false` key does NOT make a hosted being not-here.
  // findAgentByToken stopped consulting the key, so this agent answers exactly like any other.
  it('an `enabled: false` key is INERT — a hosted being still answers', async () => {
    const brain = fakeBrain({ reply: 'aquí' });
    const { bridge, mesh } = svc({ node: 'do', agents: { don: { configuration: 'sonnet-high', name: 'don', enabled: false } }, brain });
    const req = encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', from_node: 'kg', to: 'don.do', post_id: 'p1' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();
    expect(brain.calls).toHaveLength(1);
    expect(parseMesh(bridge.streams[0].finals.at(-1))).toMatchObject({ by: 'don.do', done: true });
  });
});

// ── THE STAMP CARRIES THE `name:`, NEVER THE MAP KEY (operator 2026-09-01: "please don't use
//    the yaml array key as name … that is why agents have name") ────────────────────────────
//
// THIS ONE REGRESSED THREE TIMES IN TWO DAYS and nothing in the suite noticed (3296 tests before
// the real fix, 3296 after):
//   c13db3f  fixed it — "a relayed reply is stamped with the being's NAME, not its map key".
//   7dad417  REVERTED it. The ruling was taken while looking at kg, where the persona's key and
//            its `name:` happen to be the SAME STRING — so the bug was invisible there and the
//            revert looked correct.
//   24c2a7d  } re-fixed it INERTLY, twice: both shipped the wiring (boot.mjs's labelOf, the
//   c346d8e  } startup warning) but NOT the one-line change here, because the patch script
//            asserted after editing and before writing — it printed success and saved nothing.
//   e782524  finally applied `label: labelOf(being)` in mesh.mjs's renderReply for real.
//
// THE FIXTURE'S KEY AND ITS `name:` MUST DIFFER — that is the entire point of this block, and
// both ways of "simplifying" it are how the bug walks back in:
//   • Key the persona the same as its name (`e`/`e`, `don`/`don`) and this test passes with the
//     bug fully reinstated. That is precisely the condition 7dad417 was ruled under. do's live
//     persona is KEYED `egpt` and NAMED `don`, so it answered `🤝 don:` locally and `🤝 egpt:`
//     when relayed — one being with two names depending on which path served it.
//   • Drop `body_emoji` and the stamp stops rendering an identity line at all (persona-wrap.mjs:
//     personaStamp returns the text untouched when bodyEmoji is falsy), so the assertion has
//     nothing left to bite on. The neighbouring `e` fixture below has exactly that hole, which
//     is why the lock lives here on its own fixture instead of riding on that one.
//
// bodyEmojiOf/labelOf below are boot.mjs's own resolvers, mirrored — including labelOf's
// deliberate ABSENCE of a key fallback: the key is an identifier (it keys warm sessions, threads
// and transcripts), not a display name, and falling back to it is what made the wrong answer
// look like a right one.
describe('mesh service — a relayed reply is stamped with the being\'s NAME, never its map key', () => {
  // do's live shape: KEYED `egpt`, NAMED `don`. The two MUST NOT be made equal (see above).
  const persona = { egpt: { configuration: 'egpt', name: 'don', body_emoji: '🤝' } };
  const emojiOf = (being) => persona[String(being ?? '').toLowerCase()]?.body_emoji ?? '🐶';
  const nameOf = (being) => String(persona[String(being ?? '').toLowerCase()]?.name ?? '');

  it('REGRESSION LOCK (regressed 3×): the nugget stamps `don` (the `name:`) and never `egpt` (the key)', async () => {
    const brain = fakeBrain({ reply: 'aquí', partials: ['aq', 'aquí'] });
    const bridge = fakeBridge();
    const mesh = createMeshService({ bridge, brain, getConfig: () => ({ node_name: 'do', agents: persona }), bodyEmojiOf: emojiOf, labelOf: nameOf });
    // Addressed by the token that IS the key, so the being that RUNS is `egpt` — which is exactly
    // the string the stamp must not carry.
    const req = encodeMesh({ by: 'An', body: '@egpt hola', from: 'HFM', from_node: 'kg', to: 'egpt.do', post_id: 'p1' });

    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();

    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('egpt');            // the KEY still identifies who runs — only the STAMP is the name
    const live = stripNodeSignature(parseMesh(bridge.streams[0].updates.at(-1)).body);
    const final = stripNodeSignature(parseMesh(bridge.streams[0].finals.at(-1)).body);
    // BOTH DIRECTIONS, on BOTH frames (renderReply owns the final, personaStamp the live ones).
    // A one-sided "contains don" assertion is how the reverted state read as correct.
    expect(final).toBe('🤝 don: aquí');
    expect(final).not.toMatch(/egpt/);
    expect(live).toBe('🤝 don: aquí');
    expect(live).not.toMatch(/egpt/);
  });
});

// ── THE MESH IS TRANSPORT, NOT IDENTITY (operator 2026-08-31) ──────────────────────────────
// *"the mesh tail should get from/to agents separate, and so the threads. there should be
// relation between thread-id and the egpt-mesh. mesh is transport, not mixing."* and, on the
// same day, *"E on the radio and E on acim MUST BE DIFFERENT THREADS!"*.
//
// meshEv used to hand brain.turn the RELAY CHANNEL as the conversation, so every group reached
// through egpt-mesh-do-kg answered on ONE thread, one warm CLI and one access_level — Radio WnL
// and "perrito traducciones" both landing in the transport's conversation, with their real
// origin present only as text inside the prompt. It also defeated a569ada: a chat listed as a
// `wa-group` member of a room resolves to that room's identity, but a group reached through the
// relay never presented its own address, so the membership rule could never fire for it.
//
// THE HARD PART, and why this is not `chatId: <the requester's chat id>`: Beeper chat ids do NOT
// cross accounts. The same WhatsApp group is `!6ljZJkx0OaY9ZVhEzFgi` on anrodz42 and
// `!HuXFQeZSY1X4khNDWTzz` on dolly.egpt (measured on these two machines, 2026-08-31), so the
// requester's id is meaningless here — rooms.yaml on THIS node lists members by THIS node's ids.
// The chat NAME is what crosses (a WhatsApp group's title is the same on both accounts) and the
// tail has carried it as `from:` since the first envelope. So the responder resolves that name
// to its OWN local id (bridge.resolveChatId, live since c84deac) and answers THERE.
describe('mesh service — the RESPONDER answers in the ORIGIN conversation, not the transport channel', () => {
  const persona = { e: { configuration: 'egpt', name: 'e' } };
  const CHANNEL = 'egpt-mesh-do-kg';
  // The responder's OWN ids for the two groups (its account's, not the requester's).
  const chatIds = { 'Radio WnL': 'do-radio-wnl', 'perrito traducciones': 'do-perrito' };
  const req = (from, body, post_id) => encodeMesh({ by: 'An', body, from, from_node: 'kg', to: 'e.do', post_id });

  it('THE ASK: two origin chats relayed through ONE channel run in TWO conversations', async () => {
    const brain = fakeBrain({ reply: 'ok' });
    const { mesh } = svc({ node: 'do', agents: persona, brain, chatIds });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('Radio WnL', '@e pon musica', 'p1') });
    await flush();
    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm2', body: req('perrito traducciones', '@e traduce esto', 'p2') });
    await flush();

    expect(brain.calls).toHaveLength(2);
    // Radio-E and acim-E are DIFFERENT conversations — which is what makes them different
    // threads, different warm processes and different run configs downstream.
    expect(brain.calls[0].ev.chatId).toBe('do-radio-wnl');
    expect(brain.calls[1].ev.chatId).toBe('do-perrito');
    expect(brain.calls[0].ev.chatId).not.toBe(brain.calls[1].ev.chatId);
    // …and the being is told WHICH chat it is in by name, not by the transport's name.
    expect(brain.calls[0].ev.chatName).toBe('Radio WnL');
    expect(brain.calls[1].ev.chatName).toBe('perrito traducciones');
  });

  it('THE REPLY PATH IS UNTOUCHED: both answers still mirror home through the one relay channel', async () => {
    const brain = fakeBrain({ reply: 'ok' });
    const { bridge, mesh } = svc({ node: 'do', agents: persona, brain, chatIds });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('Radio WnL', '@e pon musica', 'p1') });
    await flush();
    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm2', body: req('perrito traducciones', '@e traduce esto', 'p2') });
    await flush();

    // Transport is transport: the envelope goes back the way it came, on the channel, with the
    // same return-address and the same post_id it arrived with.
    expect(bridge.streams.map((s) => s.chat)).toEqual([CHANNEL, CHANNEL]);
    expect(parseMesh(bridge.streams[0].finals.at(-1))).toMatchObject({ by: 'e.do', re: 'Radio WnL.kg', post_id: 'p1', done: true });
    expect(parseMesh(bridge.streams[1].finals.at(-1))).toMatchObject({ by: 'e.do', re: 'perrito traducciones.kg', post_id: 'p2', done: true });
  });

  it("LOCK: an origin that does NOT resolve here keeps today's behaviour — the relay channel — and says so", async () => {
    const logs = [];
    const brain = fakeBrain({ reply: 'ok' });
    // `null` = the bridge cannot resolve this name (we are not in that chat, or it simply is not
    // visible). NEVER GUESS: the turn falls back to the transport chat, exactly as before.
    const { bridge, mesh } = svc({ node: 'do', agents: persona, brain, chatIds: { 'chat de EyAy': null }, logs });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('chat de EyAy', '@e hola', 'p1') });
    await flush();

    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].ev.chatId).toBe(CHANNEL);
    expect(brain.calls[0].ev.chatName).toBe(CHANNEL);      // byte-identical to the pre-change meshEv
    expect(logs.join('\n')).toMatch(/chat de EyAy.*does not resolve/);
    expect(bridge.streams[0].chat).toBe(CHANNEL);
  });

  it("LOCK: an id-shaped `from:` is REFUSED without a lookup — a chat id from the requester's account is not an address here", async () => {
    const logs = [];
    const brain = fakeBrain({ reply: 'ok' });
    // A resolver that WOULD answer, to prove it is never asked: resolveChatId's `!` branch hands
    // a full-form id straight back UNVERIFIED, which is exactly how a foreign account's id would
    // become this node's thread key.
    const { bridge, mesh } = svc({ node: 'do', agents: persona, brain, chatIds: { '!6ljZJkx0OaY9ZVhEzFgi': 'do-would-be-wrong' }, logs });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('!6ljZJkx0OaY9ZVhEzFgi', '@e hola', 'p1') });
    await flush();

    expect(brain.calls[0].ev.chatId).toBe(CHANNEL);
    expect(bridge.resolveCalls).toEqual([]);               // not even looked up
    expect(logs.join('\n')).toMatch(/ids do not cross accounts/);
  });

  it('LOCK: a bridge with no resolver (raw-id configs, test fakes) is unchanged — the relay channel, no lookup', async () => {
    const brain = fakeBrain({ reply: 'ok' });
    const bridge = fakeBridge();
    delete bridge.resolveChatId;
    const mesh = createMeshService({ bridge, brain, getConfig: () => ({ node_name: 'do', agents: persona }), bodyEmojiOf });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('Radio WnL', '@e hola', 'p1') });
    await flush();

    expect(brain.calls[0].ev.chatId).toBe(CHANNEL);
    expect(brain.calls[0].ev.chatName).toBe(CHANNEL);
  });

  it("LOCK: a node-addressed COMMAND still runs in the responder's own private per-command id, never the origin chat", async () => {
    // A `/command` is node plumbing, not a conversation: commandReply mints `<channel>#cmd<n>`
    // and marks the event `mesh:true` so a room-scoped command resolves to THIS node's lobby
    // (bug #23 half A, 2026-07-27). The origin conversation has nothing to do with it, so it is
    // never resolved for one — and the name is never even looked up.
    const captured = [];
    const commands = {
      nodeCommandForMe: (p) => p.startsWith('/'),
      isCommand: () => true,
      runCaptured: async (ev) => { captured.push(ev); return 'chrome tabs: 3 open'; },
    };
    const bridge = fakeBridge({ chatIds });
    const mesh = createMeshService({ bridge, brain: fakeBrain(), commands, getConfig: () => ({ node_name: 'do', agents: persona }), bodyEmojiOf });

    await mesh.handle({ surface: 'whatsapp', chatId: CHANNEL, msgId: 'm1', body: req('perrito traducciones', '/tabs', 'p1') });
    await flush();

    expect(captured).toHaveLength(1);
    expect(captured[0].chatId).toBe(`${CHANNEL}#cmd1`);
    expect(captured[0].chatName).toBe(CHANNEL);
    expect(captured[0].mesh).toBe(true);
    expect(bridge.resolveCalls).toEqual([]);
  });
});

describe('mesh service — origin (the reply streams home as a living mirror)', () => {
  it('(c) edits the origin placeholder in place (existingMsgId); the done frame finalizes it', async () => {
    const timers = fakeTimers();
    const { bridge, mesh } = svc({ node: 'kg', meshCfg: { timeout_ms: 60000 }, timers });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don hola' };
    await mesh.forward(ev, { being: 'don', route: { room_id: 'RELAY' }, to: 'don.do' });   // arms the wait + posts 'post-1'
    expect(timers.timers).toHaveLength(1);

    // first reply frame (a new relay-room message) opens the origin mirror keyed by msgId r1
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'r1', body: encodeMesh({ by: 'don.do', body: '🤝 Jaja', re: 'HFM.kg', post_id: 'post-1' }) });
    // a later EDIT of r1 flows onto the placeholder; done:true finalizes
    await mesh.onEdit({ msgId: 'r1', newText: encodeMesh({ by: 'don.do', body: '🤝 Jaja, aquí', re: 'HFM.kg', post_id: 'post-1', done: true }) });

    const mirror = bridge.streams.find((s) => s.opts.existingMsgId === 'post-1');
    expect(mirror).toBeTruthy();
    expect(mirror.chat).toBe('CHAT');
    expect(mirror.opts.showThink).toBe(true);
    expect(mirror.updates).toContain('🤝 Jaja');
    expect(mirror.finals).toContain('🤝 Jaja, aquí');
    expect(timers.timers[0].cleared).toBe(true);                    // the reply streamed → the wait was cancelled
  });
});

// STRUCTURAL vs THINKING (operator 2026-07-27: "seems like there's an AI thinking, when it's
// actually water through pipes"). forwardCommand is the ORIGIN's ONLY entry point for a
// node-addressed `/command` (spine.mjs gates on commands.remoteNode before calling it) — it
// already knows no AI turn is involved, so it must show plumbing, not thinking: a different
// placeholder AND no "✅ Done" theatre on the reply. mesh.forward (the @being-prompt path) must
// stay byte-identical.
describe('mesh service — structural relay (a forwarded /command is plumbing, not an AI turn)', () => {
  const agents = { don: { configuration: 'egpt', name: 'don', relay_channel: 'RELAY', to: 'don.do' } };

  it('forwardCommand posts the STRUCTURAL placeholder ("🔗 relaying…"), never the AI "🤔 thinking…" one', async () => {
    const { bridge, mesh } = svc({ node: 'kg', agents });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '/tabs' };
    const ok = await mesh.forwardCommand(ev, 'do');
    expect(ok).toBe(true);
    expect(bridge.statusPosts).toEqual([{ chat: 'CHAT', text: '🔗 relaying…', id: 'post-1' }]);
  });

  it('a forwarded command finishes to just the reply body — no "✅ Done" theatre', async () => {
    const { bridge, mesh } = svc({ node: 'kg', agents });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '/tabs' };
    await mesh.forwardCommand(ev, 'do');

    // the responder answers in ONE frame (a static command never streams partials — the
    // 2026-07-25 fix already stops it opening a placeholder it doesn't use)
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'r1', body: encodeMesh({ by: 'don.do', body: 'chrome tabs: 3 open', re: 'HFM.kg', post_id: 'post-1', done: true }) });

    const mirror = bridge.streams.find((s) => s.opts.existingMsgId === 'post-1');
    expect(mirror).toBeTruthy();
    expect(mirror.opts.showThink).toBe(false);           // structural: the origin never appends "✅ Done"
    expect(mirror.finals).toContain('chrome tabs: 3 open');
  });

  // REGRESSION LOCK (operator ruling: "the AI path must be BYTE-IDENTICAL to today"). A
  // forwarded BEING-PROMPT — every existing mesh.forward call site, structural defaults false —
  // keeps the exact same thinking placeholder, streaming updates, and "✅ Done" finish.
  it('REGRESSION: a forwarded being-prompt is unchanged — same "🤔 thinking…", same streaming, same "✅ Done"', async () => {
    const { bridge, mesh } = svc({ node: 'kg' });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don hola' };
    await mesh.forward(ev, { being: 'don', route: { room_id: 'RELAY' }, to: 'don.do' });
    expect(bridge.statusPosts).toEqual([{ chat: 'CHAT', text: '🤔 thinking…', id: 'post-1' }]);

    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'r1', body: encodeMesh({ by: 'don.do', body: '🤝 Jaja', re: 'HFM.kg', post_id: 'post-1' }) });
    await mesh.onEdit({ msgId: 'r1', newText: encodeMesh({ by: 'don.do', body: '🤝 Jaja, aquí', re: 'HFM.kg', post_id: 'post-1', done: true }) });

    const mirror = bridge.streams.find((s) => s.opts.existingMsgId === 'post-1');
    expect(mirror.opts.showThink).toBe(true);
    expect(mirror.updates).toContain('🤝 Jaja');
    expect(mirror.finals).toContain('🤝 Jaja, aquí');
  });
});

describe('mesh service — node_alias (one process, several node identities)', () => {
  it('answers an envelope addressed to a self-ALIAS locally, stamping the identity it was ADDRESSED AS', async () => {
    const brain = fakeBrain({ reply: 'aquí' });
    // node_name kg, aliases [do, mo]: an envelope to wren.mo is LOCAL (wren answers here).
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do', 'mo'], agents: { wren: { configuration: 'egpt', name: 'wren' } }, brain });
    const req = encodeMesh({ by: 'An', body: '@wren hola', from: 'HFM', from_node: 'do', to: 'wren.mo', post_id: 'p1' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('wren');
    const fin = parseMesh(bridge.streams[0].finals.at(-1));
    expect(fin).toMatchObject({ by: 'wren.mo', re: 'HFM.do', post_id: 'p1', done: true });   // addressed-as mo, not the node_name kg
  });

  it('answers an envelope addressed to a self-alias LOCALLY (a self-name is never treated as foreign)', async () => {
    const brain = fakeBrain({ reply: 'aquí' });
    // if `do` were treated as a foreign node this envelope would be consumed in silence.
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents: { don: { configuration: 'egpt', name: 'don' } }, brain });
    const req = encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', from_node: 'kg', to: 'don.do', mid: 'M2' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();
    expect(brain.calls).toHaveLength(1);                                       // answered locally as don …
    expect(bridge.streams[0].chat).toBe('RELAY');                              // … replying in the arrival room
  });

  it('an envelope addressed to a NON-self node is consumed in silence (nothing is emitted anywhere)', async () => {
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do', 'mo'] });
    const req = encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', from_node: 'kg', to: 'don.zz' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'A', msgId: 'a1', body: req });
    await flush();
    expect(bridge.sent).toHaveLength(0);      // no transit hop (mesh.nodes evicted) …
    expect(bridge.streams).toHaveLength(0);   // … and no answer on another node's behalf
  });

  it('answers "no <being>.<self-alias> here" when addressed to a self-alias it does not host the being on', async () => {
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['mo'], agents: { wren: { configuration: 'egpt', name: 'wren' } } });
    const req = encodeMesh({ by: 'An', body: '@ghost hola', from: 'HFM', from_node: 'do', to: 'ghost.mo', mid: 'M4' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();
    const said = bridge.sent.map((s) => parseMesh(s.text)?.body).filter(Boolean);
    expect(said).toContain('no ghost.mo here');   // stamped with the addressed-as identity, not kg
  });
});

describe('mesh service — loop safety', () => {
  it('a 3-hop relay-record CHAIN reaches the local terminal — a real visible hop per room, no depth cap', async () => {
    const agents = {
      carol: { relay_channel: 'rodz1', to: 'don.do' },
      don: { relay_channel: 'rodz2', to: 'wren.kg' },
      wren: { relay_channel: 'rodz3', to: 'egpt.kg' },
      egpt: { configuration: 'egpt', name: 'egpt' },
    };
    const brain = fakeBrain({ reply: 'hey' });
    // meshCfg.ttl:2 is a now-ignored config key (the old hop cap) — the removal must not require
    // it deleted from a node's existing config.yaml for the chain to work.
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents, meshCfg: { ttl: 2 }, brain });
    const origin = encodeMesh({ by: 'An', body: 'hi', from: 'SELF', from_node: 'kg', to: 'don.do' });
    await mesh.handle({ surface: 'wa', chatId: 'rodz1', msgId: 'a1', body: origin });              // hop 1 — forwards to rodz2
    const r2 = bridge.sent.find((s) => s.chat === 'rodz2');
    expect(parseMesh(r2.text)).toMatchObject({ to: 'wren.kg' });
    await mesh.handle({ surface: 'wa', chatId: 'rodz2', msgId: 'a2', body: r2.text });             // hop 2 — forwards to rodz3
    const r3 = bridge.sent.find((s) => s.chat === 'rodz3');
    expect(parseMesh(r3.text)).toMatchObject({ to: 'egpt.kg' });
    await mesh.handle({ surface: 'wa', chatId: 'rodz3', msgId: 'a3', body: r3.text });             // hop 3 — reaches egpt (no hop cap)
    await flush();
    expect(bridge.streams.some((s) => s.chat === 'rodz3')).toBe(true);   // egpt DISPATCHED — no hop gate stopped it
  });
});


// ── HANDLE RESOLUTION (Part A): the mesh resolves a being addressed by a HANDLE exactly as
//    the router does. `ed` is a handle of the egpt persona → isLocalBeing('ed') is true and the
//    RUN-being resolves to the agent's KEY `egpt` (operator 2026-07-10 — the persona runs its
//    own key, no longer special-cased to 'e'), while the reply stays stamped `by: ed.do`. ──
describe('mesh service — being resolved by a handle (Part A)', () => {
  it('answers an envelope to a persona HANDLE (ed.do) by running the persona KEY `egpt`, stamped by: ed.do', async () => {
    const brain = fakeBrain({ reply: 'hola' });
    const { bridge, mesh } = svc({ node: 'do', agents: { egpt: { configuration: 'egpt', handles: ['ed'] } }, brain });
    const req = encodeMesh({ by: 'An', body: '@ed hola', from: 'HFM', from_node: 'kg', to: 'ed.do', post_id: 'p1' });
    await mesh.handle({ surface: 'wa', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();
    // ran the RESOLVED persona being KEY `egpt`, not the literal handle `ed`
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('egpt');
    // it answered (streamed), stamped with the addressed-as handle identity — never "no ed.do here"
    expect(bridge.streams).toHaveLength(1);
    expect(parseMesh(bridge.streams[0].finals.at(-1))).toMatchObject({ by: 'ed.do', re: 'HFM.kg', post_id: 'p1', done: true });
    expect(bridge.sent.some((s) => /no ed\.do here/.test(parseMesh(s.text)?.body ?? ''))).toBe(false);
  });

  it('a LOCAL sibling agent addressed by its handle runs that sibling being (not the persona)', async () => {
    const brain = fakeBrain({ reply: 'ok' });
    const { bridge, mesh } = svc({ node: 'do', agents: { don: { configuration: 'sonnet-high', handles: ['donny'] } }, brain });
    const req = encodeMesh({ by: 'An', body: '@donny hi', from: 'HFM', from_node: 'kg', to: 'donny.do' });
    await mesh.handle({ surface: 'wa', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();
    expect(brain.calls[0].being).toBe('don');                              // sibling handle → sibling being
    expect(parseMesh(bridge.streams[0].finals.at(-1)).by).toBe('donny.do'); // stamped as addressed
  });

  // WAKE VOCABULARY (operator 2026-07-26: "don must not wake or respond with 'egpt'"). The mesh
  // resolves an envelope's `<being>.<node>` through the SAME wake vocabulary the router does, so
  // the rule holds on the wire too: declared handles are the complete list, the map KEY is not a
  // token. DOLLY's persona is KEYED `egpt` and wakes on [d, don] — an envelope to `egpt.do` must
  // NOT be answered here (it would respond stamped `by: egpt.do`, the very thing the ruling
  // forbids), while `don.do` still runs the being-id `egpt`.
  it('REPRODUCE-FIRST: an envelope to `egpt.do` is NOT answered by DOLLY (key `egpt`, handles [d, don])', async () => {
    const brain = fakeBrain({ reply: 'hola' });
    const DOLLY = { egpt: { configuration: 'egpt', handles: ['d', 'don'], default: true, name: 'don' } };
    const { bridge, mesh } = svc({ node: 'do', agents: DOLLY, brain });
    const req = encodeMesh({ by: 'An', body: '@egpt hola', from: 'HFM', from_node: 'kg', to: 'egpt.do', post_id: 'p1' });
    await mesh.handle({ surface: 'wa', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();
    expect(brain.calls).toHaveLength(0);                                    // the key is not a wake token
    expect(bridge.sent.some((s) => /no egpt\.do here/.test(parseMesh(s.text)?.body ?? ''))).toBe(true);
  });

  it('…and the SAME node still answers `don.do` by running its being-id `egpt`', async () => {
    const brain = fakeBrain({ reply: 'hola' });
    const DOLLY = { egpt: { configuration: 'egpt', handles: ['d', 'don'], default: true, name: 'don' } };
    const { bridge, mesh } = svc({ node: 'do', agents: DOLLY, brain });
    const req = encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', from_node: 'kg', to: 'don.do', post_id: 'p1' });
    await mesh.handle({ surface: 'wa', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();
    expect(brain.calls.map((c) => c.being)).toEqual(['egpt']);              // handle → BEING-ID (the key), which still runs
    expect(parseMesh(bridge.streams[0].finals.at(-1))).toMatchObject({ by: 'don.do', done: true });
  });
});

// ── RELAY ROUTING RESOLVES BY WAKE TOKEN TOO (operator 2026-07-26: "the relay agent must route
//    with the handle, not with the key. we must fix that"). The wake vocabulary was applied to the
//    three WAKE sites (the router's @token scan, boot's wakeWords, and the mesh's
//    isLocalBeing/resolveLocalBeing) but NOT to relay ROUTING: resolveBeingRelay did a bare
//    `agents()[being]`. So an agent addressed by a handle that differs from its key passed the wake
//    gate and then its `to:` chain missed — the envelope never travelled. It now goes through the
//    SAME findAgentByToken (= router.mjs wakeTokens) as every other resolution here. ──
describe('mesh service — a relay agent addressed by its HANDLE routes its `to:` chain', () => {
  // key `wren2`, handle `wren`: nothing about this agent's KEY is an address any more.
  const HANDLED_RELAY = { wren2: { handles: ['wren'], relay_channel: 'rodz3', to: 'ed.do' } };

  it('REPRODUCE-FIRST: an envelope to `wren.kg` forwards onto wren2\'s relay channel', async () => {
    const { bridge, mesh } = svc({ node: 'kg', agents: HANDLED_RELAY });
    const req = encodeMesh({ by: 'An', body: 'hi', from: 'HFM', from_node: 'do', to: 'wren.kg' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'a1', body: req });
    await flush();
    const hop = bridge.sent.find((s) => s.chat === 'rodz3');
    expect(hop).toBeTruthy();                                        // the chain actually fired
    expect(parseMesh(hop.text)).toMatchObject({ to: 'ed.do', body: 'hi', via: 'wren.kg' });
    // …and the wake gate never fell through to "no <being> here"
    expect(bridge.sent.some((s) => /no wren\.kg here/.test(parseMesh(s.text)?.body ?? ''))).toBe(false);
  });

  it('REGRESSION: the same agent addressed by its KEY (`wren2.kg`) routes NOTHING — the key is not an address', async () => {
    const { bridge, mesh } = svc({ node: 'kg', agents: HANDLED_RELAY });
    const req = encodeMesh({ by: 'An', body: 'hi', from: 'HFM', from_node: 'do', to: 'wren2.kg' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'a1', body: req });
    await flush();
    expect(bridge.sent.some((s) => s.chat === 'rodz3')).toBe(false);  // no hop
    expect(bridge.sent.some((s) => /no wren2\.kg here/.test(parseMesh(s.text)?.body ?? ''))).toBe(true);
  });

  // MULTIPATH IS NOT AN EXCEPTION ANY MORE (operator 2026-07-26: "you can make it work with
  // handles differing from key names"). The shape used to be a bare Array of single-key path maps
  // — nowhere to declare `handles:`, so it was addressed by its KEY alone via wakeTokens' fallback.
  // The list now lives one level down under `paths:`, so a multipath agent is an ordinary map and
  // routing by wake token reaches it through exactly the same lookup as every other agent.
  const MULTIPATH = { carol: { handles: ['maria'], paths: [
    { p1: { relay_channel: 'rodz2', network: 'whatsapp', to: 'wren.kg' } },
    { p2: { relay_channel: 'rodz4', network: 'telegram', to: 'wren.kg' } },
  ] } };

  it('REPRODUCE-FIRST: a MULTIPATH agent addressed by its HANDLE fans out to every path', async () => {
    const chatIds = { rodz2: 'ID2', rodz4: 'ID4' };
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents: MULTIPATH, chatIds });
    const req = encodeMesh({ by: 'An', body: 'hi', from: 'SELF', from_node: 'kg', to: 'maria.do' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'a1', body: req });
    await flush();
    expect(bridge.sent.map((s) => s.chat).sort()).toEqual(['ID2', 'ID4']);
    for (const s of bridge.sent) expect(parseMesh(s.text)).toMatchObject({ to: 'wren.kg', via: 'maria.do' });
  });

  it('REGRESSION: the same MULTIPATH agent addressed by its KEY routes NOTHING', async () => {
    const chatIds = { rodz2: 'ID2', rodz4: 'ID4' };
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents: MULTIPATH, chatIds });
    const req = encodeMesh({ by: 'An', body: 'hi', from: 'SELF', from_node: 'kg', to: 'carol.do' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'a1', body: req });
    await flush();
    expect(bridge.sent.some((s) => s.chat === 'ID2' || s.chat === 'ID4')).toBe(false);
    expect(bridge.sent.some((s) => /no carol\.do here/.test(parseMesh(s.text)?.body ?? ''))).toBe(true);
  });

  // THE LINE 1da74ae ADDED, re-pointed at the new shape. A multipath agent is a RELAY BY
  // CONSTRUCTION — its `paths:` carry the relay_channels and it has no top-level relay_channel/to
  // of its own, so nothing else in isRelay would catch it. When the shape was an Array the test
  // read `Array.isArray(a)`; it now reads `Array.isArray(a.paths)`. Get this wrong and carol is
  // classified LOCAL: brain.turn runs her on this node and she answers in her own name instead
  // of forwarding — the exact bug that commit prevented.
  it('a MULTIPATH agent is a RELAY, never a local being (it forwards; it does not answer here)', async () => {
    const brain = fakeBrain({ reply: 'aquí' });
    const chatIds = { rodz2: 'ID2', rodz4: 'ID4' };
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents: MULTIPATH, chatIds, brain });
    const req = encodeMesh({ by: 'An', body: 'hi', from: 'SELF', from_node: 'kg', to: 'maria.do' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'a1', body: req });
    await flush();
    expect(brain.calls).toHaveLength(0);                                // never ran as a local being
    expect(bridge.streams).toHaveLength(0);                             // …so no reply stream either
    expect(bridge.sent.map((s) => s.chat).sort()).toEqual(['ID2', 'ID4']);   // it forwarded instead
  });
});

// ── FORWARD RESOLUTION + REPLY HOME. A relay_channel configured by NAME ("rodz2") resolves via
//    bridge.resolveChatId to the delivered id ("ID2"), so the relay hop forwards into the SAME
//    room the terminal observes (and an origin present there catches the reply). Reply-home is the
//    re:+awaiting path alone (no reverse-mirror transit — a chain terminating in a room the origin
//    is NOT in is out of scope). ──
describe('mesh service — relay_channel name resolution + reply home', () => {
  it('a relay-record forwards into the RESOLVED relay_channel id (name → id), not the raw name', async () => {
    const chatIds = { rodz1: 'ID1', rodz2: 'ID2' };
    const agents = { don: { relay_channel: 'rodz2', to: 'wren.kg' } };
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents, chatIds });
    const req = encodeMesh({ by: 'An', body: 'hi', from: 'SELF', from_node: 'kg', to: 'don.do' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'a1', body: req });     // arrives in resolved rodz1 (ID1)
    expect(bridge.sent.some((s) => s.chat === 'ID2')).toBe(true);                    // forwarded into the RESOLVED rodz2
    expect(bridge.sent.some((s) => s.chat === 'rodz2')).toBe(false);                 // not the raw name
    expect(parseMesh(bridge.sent.find((s) => s.chat === 'ID2').text)).toMatchObject({ to: 'wren.kg' });
  });

  it('MULTIPATH record hop (config-driven): a `paths:` relay agent forwards an arriving envelope into EVERY resolved path', async () => {
    const chatIds = { rodz1: 'ID1', rodz2: 'ID2', rodz4: 'ID4' };
    const agents = { don: { paths: [
      { p1: { relay_channel: 'rodz2', network: 'whatsapp', to: 'wren.kg' } },
      { p2: { relay_channel: 'rodz4', network: 'telegram', to: 'wren.kg' } },
    ] } };
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents, chatIds });
    const req = encodeMesh({ by: 'An', body: 'hi', from: 'SELF', from_node: 'kg', to: 'don.do' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'a1', body: req });
    expect(bridge.sent.map((s) => s.chat).sort()).toEqual(['ID2', 'ID4']);          // both paths forwarded, resolved
    for (const s of bridge.sent) expect(parseMesh(s.text)).toMatchObject({ to: 'wren.kg', via: 'don.do' });
    expect(bridge.resolveCalls).toContainEqual({ nameOrId: 'rodz2', opts: { network: 'whatsapp' } });
    expect(bridge.resolveCalls).toContainEqual({ nameOrId: 'rodz4', opts: { network: 'telegram' } });
  });

  it('NETWORK PIN: canonRoute passes the route network through to bridge.resolveChatId (operator 2026-07-06: multi-network mesh)', async () => {
    const chatIds = { rodz2: 'ID2' };
    const agents = { don: { relay_channel: 'rodz2', to: 'wren.kg', network: 'Telegram' } };
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents, chatIds });
    const req = encodeMesh({ by: 'An', body: 'hi', from: 'SELF', from_node: 'kg', to: 'don.do' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'a1', body: req });
    // resolveBeingRelay built a raw route { room_id:'rodz2', network:'telegram' }; canonRoute
    // resolved the NAME with the pin, lowercased.
    expect(bridge.resolveCalls).toContainEqual({ nameOrId: 'rodz2', opts: { network: 'telegram' } });
    // and the forward still lands in the resolved id (the pin rode canonRoute, didn't break it)
    expect(bridge.sent.some((s) => s.chat === 'ID2')).toBe(true);
  });

  it('NO PIN: canonRoute calls resolveChatId with NO options (regression — unpinned stays cross-network)', async () => {
    const chatIds = { rodz2: 'ID2' };
    const agents = { don: { relay_channel: 'rodz2', to: 'wren.kg' } };
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents, chatIds });
    const req = encodeMesh({ by: 'An', body: 'hi', from: 'SELF', from_node: 'kg', to: 'don.do' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'a1', body: req });
    expect(bridge.resolveCalls).toContainEqual({ nameOrId: 'rodz2', opts: undefined });
  });

  it('REGRESSION: a relay_channel configured as a RAW id (not a name) forwards unchanged', async () => {
    const chatIds = { rodz1: 'ID1' };                                     // "ID2" is NOT a name → resolveChatId('ID2') === 'ID2'
    const agents = { don: { relay_channel: 'ID2', to: 'wren.kg' } };
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents, chatIds });
    const req = encodeMesh({ by: 'An', body: 'hi', from: 'SELF', from_node: 'kg', to: 'don.do' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'a1', body: req });
    expect(bridge.sent.some((s) => s.chat === 'ID2')).toBe(true);
  });

  it('REPLY HOME: the terminal reply mirrors onto the origin placeholder (re:+awaiting), origin present in the terminal room', async () => {
    // The origin @don arms awaiting('post-1') + posts placeholder 'post-1'. The reply arrives in
    // the shared relay room; the origin observes it and edits the placeholder in place.
    const { bridge, mesh } = svc({ node: 'kg' });
    await mesh.forward({ surface: 'wa', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don hola' },
      { being: 'don', route: { room_id: 'RELAY' }, to: 'don.do' });
    await mesh.handle({ surface: 'wa', chatId: 'RELAY', msgId: 'r1', body: encodeMesh({ by: 'don.do', body: '🤝 hey', re: 'HFM.kg', post_id: 'post-1', done: true }) });
    const mirror = bridge.streams.find((s) => s.opts?.existingMsgId === 'post-1');
    expect(mirror?.chat).toBe('CHAT');                                    // the origin placeholder resolved in place
    expect(mirror.finals).toContain('🤝 hey');
  });
});
// ── UNRESOLVED RELAY CHANNEL → SELF (operator 2026-07-25). A relay_channel the bridge cannot
//    resolve is a DEAD transport: bridge.send drops the envelope ("send DROPPED … resolved=null")
//    and the operator sees nothing but the eventual origin-wait "did not answer". Both spines ride
//    ONE Beeper account, so the Self chat is a valid two-node link — relay through it and say so
//    ONCE per channel. Unresolved ≠ absent (the bridge may just not see the chat yet), so the
//    notice never asserts the group doesn't exist. ──
describe('mesh service — an unresolved relay channel falls back to Self', () => {
  const RELAY = 'egpt-mesh-do-kg';
  const target = { being: 'don', route: { room_id: RELAY, network: 'whatsapp' }, to: 'don.do' };
  const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don hola' };
  const envelopes = (bridge) => bridge.sent.filter((s) => parseMesh(s.text));
  const notices = (bridge) => bridge.sent.filter((s) => !parseMesh(s.text));

  it('REPRODUCE-FIRST: the envelope rides the SELF chat (not the dead name) and Self is told which channel is missing', async () => {
    const { bridge, mesh } = svc({ node: 'kg', chatIds: { [RELAY]: null }, selfChatId: 'SELF' });
    const ok = await mesh.forward(ev, target);
    expect(ok).toBe(true);

    // the request envelope went somewhere the other node can actually see it
    expect(envelopes(bridge)).toHaveLength(1);
    expect(envelopes(bridge)[0].chat).toBe('SELF');
    expect(parseMesh(envelopes(bridge)[0].text)).toMatchObject({ to: 'don.do', body: '@don hola', from_node: 'kg' });

    // and exactly one operator-readable notice naming the channel, in Self
    expect(notices(bridge)).toHaveLength(1);
    expect(notices(bridge)[0].chat).toBe('SELF');
    expect(notices(bridge)[0].text).toContain(RELAY);
  });

  it('the notice is posted ONCE per channel across repeated forwards (a permanently missing channel never spams Self)', async () => {
    const { bridge, mesh } = svc({ node: 'kg', chatIds: { [RELAY]: null }, selfChatId: 'SELF' });
    await mesh.forward(ev, target);
    await mesh.forward({ ...ev, chatId: 'CHAT2', body: '@don otra vez' }, target);
    expect(notices(bridge)).toHaveLength(1);                       // one notice …
    expect(envelopes(bridge).map((s) => s.chat)).toEqual(['SELF', 'SELF']);   // … but BOTH relays still transported
  });

  it('a RESOLVING channel is untouched: the envelope posts to the configured channel, no notice', async () => {
    const { bridge, mesh } = svc({ node: 'kg', chatIds: { rodz2: 'ID2' }, selfChatId: 'SELF' });
    const ok = await mesh.forward(ev, { being: 'don', route: { room_id: 'rodz2' }, to: 'don.do' });
    expect(ok).toBe(true);
    expect(bridge.sent).toHaveLength(1);                           // envelope only — nothing extra
    expect(bridge.sent[0].chat).toBe('rodz2');                     // as configured (byte-identical to today)
    expect(bridge.sent.some((s) => s.chat === 'SELF')).toBe(false);
  });

  it('NO Self configured → today\'s behaviour exactly (route unchanged, no throw, no notice)', async () => {
    const { bridge, mesh } = svc({ node: 'kg', chatIds: { [RELAY]: null } });   // no selfChatId
    const ok = await mesh.forward(ev, target);
    expect(ok).toBe(true);
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].chat).toBe(RELAY);                       // still the raw name (the bridge drops it — unchanged)
  });

  it('the RELAY-RECORD hop (canonRoute) falls back too: an arriving envelope forwards through Self', async () => {
    const agents = { don: { relay_channel: RELAY, to: 'wren.kg' } };
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents, chatIds: { [RELAY]: null, rodz1: 'ID1' }, selfChatId: 'SELF' });
    const req = encodeMesh({ by: 'An', body: 'hi', from: 'SELFCHAT', from_node: 'kg', to: 'don.do' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'a1', body: req });
    expect(envelopes(bridge).map((s) => s.chat)).toEqual(['SELF']);
    expect(parseMesh(envelopes(bridge)[0].text)).toMatchObject({ to: 'wren.kg' });
    expect(notices(bridge)).toHaveLength(1);
    expect(notices(bridge)[0].text).toContain(RELAY);
  });
});

describe('mesh service — origin-wait timeout', () => {
  it('(f) surfaces "<target> did not answer" into the origin chat when no reply arrives', async () => {
    const timers = fakeTimers();
    const { bridge, mesh } = svc({ node: 'kg', meshCfg: { timeout_ms: 30000 }, timers });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don hola' };
    await mesh.forward(ev, { being: 'don', route: { room_id: 'RELAY' }, to: 'don.do' });
    expect(timers.timers).toHaveLength(1);
    expect(timers.timers[0].ms).toBe(30000);

    timers.timers[0].fn();                                          // fire the timeout
    await flush();
    expect(bridge.sent.some((s) => s.chat === 'CHAT' && /don\.do did not answer/.test(s.text))).toBe(true);
  });
});

// ── SHELL-ORIGIN (operator 2026-07-28): shell-port's postStatus resolves — never throws — but
//    always returns null (the shell has no editable message id, by design). Pre-fix, `pending` was
//    keyed by `chatId` ALONE: two concurrent relays from the SAME chat collided on ONE timer — the
//    second armTimeout(ev.chatId,…) cleared the first's timer via clearTimeoutFor(ev.chatId) before
//    rearming, so a stranded relay didn't even surface "did not answer". The fix keys `pending` by
//    the per-relay `origin.waitKey` (set by relay.mjs from its own synthetic post_id), armed AFTER
//    relayOut resolves so the key is populated. ──
describe('mesh service — shell-origin (postStatus resolves null) concurrent relays get independent timeouts', () => {
  it('two concurrent forwards from the SAME chat each get their OWN timer AND their OWN reply home', async () => {
    const timers = fakeTimers();
    const { bridge, mesh } = svc({ node: 'kg', meshCfg: { timeout_ms: 60000 }, timers });
    // shell-port.postStatus's exact contract: resolves, never returns a string.
    bridge.postStatus = async (chat, text) => { bridge.statusPosts.push({ chat, text, id: null }); return null; };

    const ev1 = { surface: 'shell', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don /tabs' };
    const ev2 = { surface: 'shell', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@wren /tabs' };
    const ok1 = await mesh.forward(ev1, { being: 'don', route: { room_id: 'R1' }, to: 'don.do' });
    const ok2 = await mesh.forward(ev2, { being: 'wren', route: { room_id: 'R2' }, to: 'wren.mo' });
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);

    // TWO independent timer entries — the second forward did not clear/replace the first's
    expect(timers.timers).toHaveLength(2);
    expect(timers.timers.every((t) => !t.cleared)).toBe(true);

    // each request envelope minted its OWN synthetic post_id (no real one — postStatus returned null)
    const [p1, p2] = bridge.sent.map((s) => parseMesh(s.text).post_id);
    expect(p1).toMatch(/^noid:/);
    expect(p2).toMatch(/^noid:/);
    expect(p1).not.toBe(p2);

    // reply #1 arrives and finds its own way home, clearing ONLY its own timer
    await mesh.handle({ surface: 'shell', chatId: 'R1', msgId: 'r1', body: encodeMesh({ by: 'don.do', body: 'reply one', re: 'HFM.kg', post_id: p1, done: true }) });
    expect(timers.timers[0].cleared).toBe(true);
    expect(timers.timers[1].cleared).toBe(false);              // the second relay's wait is UNTOUCHED (was falsely cleared pre-fix)

    // reply #2 arrives and finds its own way home too — not stranded
    await mesh.handle({ surface: 'shell', chatId: 'R2', msgId: 'r2', body: encodeMesh({ by: 'wren.mo', body: 'reply two', re: 'HFM.kg', post_id: p2, done: true }) });
    expect(timers.timers[1].cleared).toBe(true);

    const mirrors = bridge.streams.filter((s) => s.chat === 'CHAT');
    expect(mirrors.some((s) => s.finals.includes('reply one'))).toBe(true);
    expect(mirrors.some((s) => s.finals.includes('reply two'))).toBe(true);   // was stranded pre-fix
    // a synthetic post_id is never handed through as a literal existingMsgId (no shell id to PATCH)
    expect(mirrors.every((s) => s.opts.existingMsgId == null)).toBe(true);
  });
});

// ── the SPINE SEAM: handleInbound routes envelopes + mesh targets to the service,
//    and leaves ordinary chat untouched (regression lock g). ──
function seamSpine({ router, mesh, mayReply = true, guard = null } = {}) {
  const bridge = { sent: [], onMessage() {}, send(chat, text) { this.sent.push({ chat, text }); }, stop() {} };
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, ev }); return { text: `↩ ${ev.body}`, sessionId: 's1' }; } };
  const transcript = { entries: [], async log(ev, r) { this.entries.push({ ev, r }); } };
  const spine = createSpine({
    bridge, brain,
    identity: { build: (m) => ({ ...m }) },
    router,
    gating: { async decide() { return { mode: 'on', receives: true, mayReply, sendToEgpt: 'mode' }; }, surfaces: () => mayReply },
    sender: { open() { return { update() {}, fail() {}, async finish(reply, { surface = true } = {}) { const t = typeof reply === 'string' ? reply : reply?.text; if (surface && t) bridge.send('CHAT', t); } }; } },
    transcript, heartbeats: { runDue() {} },
    mesh, guard, clock: { now: () => 1 },
  });
  return { spine, bridge, brain, transcript };
}

describe('spine seam — handleInbound ↔ mesh', () => {
  const localRouter = { resolve: () => ({ being: 'e', mention: {} }) };
  const meshRouter = { resolve: () => ({ being: null, mesh: { being: 'don', route: { room_id: 'RELAY' }, to: 'don.do' }, mention: { atEStart: true, atEAnywhere: true, replyToBot: false } }) };
  const recorderMesh = () => ({ handled: [], forwarded: [], isEnvelope: (ev) => String(ev.body).startsWith('ENV:'), async handle(ev) { this.handled.push(ev); }, async forward(ev, t) { this.forwarded.push({ ev, t }); return true; }, async onEdit() { return false; } });
  const MSG = { surface: 'wa', node: 'wa', chatId: 'CHAT', chatName: 'fam', senderId: 'u', senderName: 'An', msgId: 'm1', ts: 1, kind: 'text', raw: {} };

  it('an inbound envelope → mesh.handle, NOT recorded, NO brain, NO routing', async () => {
    const mesh = recorderMesh();
    const { spine, brain, transcript } = seamSpine({ router: localRouter, mesh });
    await spine.handleInbound({ ...MSG, body: 'ENV: relay traffic' });
    expect(mesh.handled).toHaveLength(1);
    expect(brain.calls).toHaveLength(0);
    // WAS 1 — "recorded like any received message (C1.2)". An ENVELOPE is now never recorded,
    // whatever chat it lands in (this MSG's chat is an ordinary one, and no isTransit is wired
    // here at all): relay traffic is not chat wherever it lands, and a chat-identity test could
    // not see the unnamed wire the 2026-08-31 account split created. See spine.mjs's ingestion
    // point and tests/relay-channel-transit.test.mjs, "AN ENVELOPE IS NEVER RECORDED".
    expect(transcript.entries).toHaveLength(0);
  });

  it('a mesh-target mention (mayReply) → mesh.forward, logged, NO brain', async () => {
    const mesh = recorderMesh();
    const { spine, brain, transcript } = seamSpine({ router: meshRouter, mesh });
    await spine.handleInbound({ ...MSG, body: '@don do X' });
    expect(mesh.forwarded).toHaveLength(1);
    expect(mesh.forwarded[0].t).toMatchObject({ being: 'don', route: { room_id: 'RELAY' }, to: 'don.do' });
    expect(brain.calls).toHaveLength(0);
    expect(transcript.entries).toHaveLength(1);
  });

  it('a mesh target that gating gates out (mayReply=false) → NOT forwarded (logged only)', async () => {
    const mesh = recorderMesh();
    const { spine } = seamSpine({ router: meshRouter, mesh, mayReply: false });
    await spine.handleInbound({ ...MSG, body: '@don do X' });
    expect(mesh.forwarded).toHaveLength(0);
  });

  // THE PROTECTION MOVED, IT DID NOT VANISH (live outage 2026-09-01). An envelope no longer
  // carries a guard channel, so the TRANSPORT can never auto-stop again (locked in
  // tests/relay-channel-transit.test.mjs). What still bounds a mesh echo storm is the counter on
  // the conversation the relayed turn actually runs in — since f70edce the ORIGIN conversation,
  // not the wire. Model the storm at the origin: node-signed lines (a bridge wrote them, so
  // NEVER a human turn — nothing between them resets) keep landing in ONE chat, each addressing a
  // mesh target, so each would put another envelope on the wire. The ORIGIN channel counts them,
  // trips at `turns`, stops, and no further forward leaves that chat.
  it('a mesh echo storm into ONE ORIGIN conversation still trips THAT channel — never the transport', async () => {
    const mesh = recorderMesh();
    const guard = createStopGuard({ turns: 3 });
    const { spine } = seamSpine({ router: meshRouter, mesh, guard });
    for (let i = 0; i < 6; i++) {
      await spine.handleInbound({ ...MSG, msgId: `echo-${i}`, body: '@don do X', fromNode: 'kg' });
    }
    // turns:3 — the tripping turn still runs, the STOP pauses the next one
    expect(mesh.forwarded).toHaveLength(3);
    expect(guard.blocked('wa:CHAT')).toBe(true);        // the ORIGIN conversation stopped…
    expect(guard.blocked('wa:RELAY')).toBe(false);      // …and the relay channel never did
  });

  it('a HUMAN line in that origin conversation resets it — normal relayed talk never trips', async () => {
    const mesh = recorderMesh();
    const guard = createStopGuard({ turns: 3 });
    const { spine } = seamSpine({ router: meshRouter, mesh, guard });
    for (let i = 0; i < 10; i++) {
      await spine.handleInbound({ ...MSG, msgId: `h-${i}`, body: '@don do X' });
    }
    expect(mesh.forwarded).toHaveLength(10);
    expect(guard.blocked('wa:CHAT')).toBe(false);
  });

  it('(g) an ordinary message flows the normal pipe untouched — brain runs, mesh idle', async () => {
    const mesh = recorderMesh();
    const { spine, bridge, brain } = seamSpine({ router: localRouter, mesh });
    await spine.handleInbound({ ...MSG, body: 'just a normal message' });
    expect(mesh.handled).toHaveLength(0);
    expect(mesh.forwarded).toHaveLength(0);
    expect(brain.calls).toHaveLength(1);
    expect(bridge.sent).toEqual([{ chat: 'CHAT', text: '↩ just a normal message' }]);
  });
});

// ── ALLOWED_USERS GATE (operator 2026-08-15), RESPONDER side. A local being whose own
//    allowed_users (config.yaml's GLOBAL agents.<handle>.conversation_defaults.allowed_users, or
//    conversations.yaml's PER-CONVERSATION agents.<being>.allowed_users override) is set must
//    never run brain.turn for an envelope whose REAL requester (route.ev.senderId — the arriving
//    InboundEvent, not meshEv's synthetic senderId:null) is not on the list — checked in
//    relayDispatch, BEFORE the placeholder stream opens and BEFORE brain.turn is ever called.
//    Replaces the evicted DANGEROUS-TYPE GATE this block used to cover (mesh.mjs's old
//    dangerousDenial, meta-engineer.yaml — "i think the 'dangerous' key is mistake"). UNLIKE
//    router.mjs's silent drop, this file's own convention is NEVER SILENCE: the requester here is
//    a different, already-trusted node peer (it reached this node at all), so it gets an explicit
//    reason — the same pattern commandReply already uses ("⚠️ not authorized to run …") for its
//    own separate authorization gate. ──
describe('mesh service — allowed_users gate (operator 2026-08-15)', () => {
  const agents = { wren: { configuration: 'sonnet-high', name: 'wren', conversation_defaults: { allowed_users: ['boss'] } } };

  it('REPRODUCE-FIRST: a requester NOT on the GLOBAL allowed_users is denied — brain.turn never runs, no placeholder stream opens', async () => {
    const brain = fakeBrain({ reply: 'should never run' });
    const { bridge, mesh } = svc({ node: 'do', agents, brain });
    const req = encodeMesh({ by: 'Stranger', body: '@wren do X', from: 'HFM', from_node: 'kg', to: 'wren.do', post_id: 'p1' });
    // no `senderId` on the ev handed to mesh.handle → route.ev.senderId is undefined, off the list
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req, senderId: 'stranger' });
    await flush();
    expect(brain.calls).toHaveLength(0);
    expect(bridge.streams).toHaveLength(0);          // denied before the placeholder stream ever opened
    const p = parseMesh(bridge.sent[0].text);
    expect(p).toMatchObject({ by: 'wren.do', done: true });
    expect(stripNodeSignature(p.body)).toContain('not authorized to reach wren.do');
  });

  it('a requester ON the GLOBAL allowed_users reaches the being normally', async () => {
    const brain = fakeBrain({ reply: 'ok, working' });
    const { bridge, mesh } = svc({ node: 'do', agents, brain });
    const req = encodeMesh({ by: 'An', body: '@wren do X', from: 'HFM', from_node: 'kg', to: 'wren.do', post_id: 'p1' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req, senderId: 'boss' });
    await flush();
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('wren');
    expect(bridge.streams).toHaveLength(1);
    expect(parseMesh(bridge.streams[0].finals.at(-1))).toMatchObject({ by: 'wren.do', done: true });
  });

  // WILDCARD (operator 2026-08-16): the literal "*" entry is an explicit "reachable by anyone"
  // escape hatch (the pairing an access_level:'all' being needs) — shares its implementation
  // (conversations-state.mjs's allowedUsersPermits) with router.mjs's own wildcard test. Without
  // it, "*" would just be an entry no real sender id ever equals, denying everyone.
  it('REPRODUCE-FIRST: allowed_users: ["*"] is a wildcard — ANY mesh requester reaches the being', async () => {
    const wildAgents = { wren: { configuration: 'sonnet-high', name: 'wren', conversation_defaults: { allowed_users: ['*'] } } };
    const brain = fakeBrain({ reply: 'ok, working' });
    const { bridge, mesh } = svc({ node: 'do', agents: wildAgents, brain });
    const req = encodeMesh({ by: 'Anyone', body: '@wren do X', from: 'HFM', from_node: 'kg', to: 'wren.do', post_id: 'p1' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req, senderId: 'totally-unlisted' });
    await flush();
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('wren');
  });

  it('REGRESSION: a being with allowed_users set at NEITHER tier is reachable by any mesh requester', async () => {
    const brain = fakeBrain({ reply: 'ok' });
    const { bridge, mesh } = svc({ node: 'do', agents: { don: { configuration: 'sonnet-high', name: 'don' } }, brain });
    const req = encodeMesh({ by: 'Stranger', body: '@don hi', from: 'HFM', from_node: 'kg', to: 'don.do', post_id: 'p1' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req, senderId: 'nobody-in-particular' });
    await flush();
    expect(brain.calls).toHaveLength(1);
  });

  // AN EMPTY LIST IS DENY, AND IS NOT THE SAME AS AN ABSENT ONE (operator 2026-09-05).
  //
  // Three states, not two, and the rungs already told them apart before the predicate did:
  // router.mjs and mesh.mjs both resolve an absent list to null and a present one to the array
  // itself, so `convAllowed ?? globalAllowed` hands over null for "nobody set this" and [] for
  // "somebody set it to nothing". allowedUsersPermits was collapsing the two into ALLOW, which
  // made `allowed_users: []` - the exact syntax README.md:63 and MANUAL.md:155 teach as deny -
  // mean the opposite of what it says.
  //
  //   absent  -> inherit, and with nothing to inherit, permit (the test above)
  //   []      -> deny everyone (these two)
  //   ['*']   -> permit everyone (the test above that)
  it('REPRODUCE-FIRST: allowed_users: [] is DENY — no mesh requester reaches the being', async () => {
    const shutAgents = { wren: { configuration: 'sonnet-high', name: 'wren', conversation_defaults: { allowed_users: [] } } };
    const brain = fakeBrain({ reply: 'ok' });
    const { bridge, mesh } = svc({ node: 'do', agents: shutAgents, brain });
    const req = encodeMesh({ by: 'Anyone', body: '@wren do X', from: 'HFM', from_node: 'kg', to: 'wren.do', post_id: 'p1' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req, senderId: 'totally-unlisted' });
    await flush();
    expect(brain.calls).toHaveLength(0);
  });

  it('REPRODUCE-FIRST: a per-conversation allowed_users: [] SHUTS a being the global default would have allowed', async () => {
    // The nearest rung wins for deny exactly as it does for allow: 'boss' is on the global list
    // and is still refused, because this conversation set the list to nothing.
    const state = { contacts: { whatsapp: { RELAY: { slug: 'chat', agents: { wren: { allowed_users: [] } } } } } };
    const brain = fakeBrain({ reply: 'ok' });
    const { bridge, mesh } = svc({ node: 'do', agents, brain, loadState: async () => state });
    const req = encodeMesh({ by: 'Boss', body: '@wren do X', from: 'HFM', from_node: 'kg', to: 'wren.do', post_id: 'p1' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req, senderId: 'boss' });
    await flush();
    expect(brain.calls).toHaveLength(0);
  });

  it('a PER-CONVERSATION allowed_users override REPLACES (never merges with) the global default via the mesh path too', async () => {
    // surface/chatId keys mirror the RESPONDER's own resolution (route.limb/route.room_id — the
    // arriving envelope's ev.surface/ev.chatId): 'whatsapp'/'RELAY', same as mesh.handle below.
    const state = { contacts: { whatsapp: { RELAY: { slug: 'chat', agents: { wren: { allowed_users: ['other'] } } } } } };
    const brain = fakeBrain({ reply: 'ok' });
    const { bridge, mesh } = svc({ node: 'do', agents, brain, loadState: async () => state });

    // 'boss' is on the GLOBAL list, but this conversation's override REPLACED it — not merged.
    const req1 = encodeMesh({ by: 'Boss', body: '@wren do X', from: 'HFM', from_node: 'kg', to: 'wren.do', post_id: 'p1' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req1, senderId: 'boss' });
    await flush();
    expect(brain.calls).toHaveLength(0);

    // 'other' is on the per-conversation override list (body differs so the engine's own replay
    // guard, keyed on being+from+body, does not itself explain a second miss).
    const req2 = encodeMesh({ by: 'Other', body: '@wren do Y', from: 'HFM', from_node: 'kg', to: 'wren.do', post_id: 'p2' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm2', body: req2, senderId: 'other' });
    await flush();
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('wren');
    expect(bridge.streams).toHaveLength(1);
  });

  it('no loadState injected (default) → the gate falls straight to the global tier — today\'s behaviour for a caller that supplies nothing', async () => {
    const brain = fakeBrain({ reply: 'ok' });
    const { bridge, mesh } = svc({ node: 'do', agents, brain });   // no loadState
    const req = encodeMesh({ by: 'Boss', body: '@wren hi', from: 'HFM', from_node: 'kg', to: 'wren.do', post_id: 'p1' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req, senderId: 'boss' });
    await flush();
    expect(brain.calls).toHaveLength(1);
  });
});
