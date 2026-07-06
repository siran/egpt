// spine-mesh.test.mjs — the v2 WIRING level for Phase 4b cross-node relay. The mesh
// ENGINE (src/mesh/relay.mjs) is already test-locked (tests/mesh-relay.test.mjs); here
// we exercise the mesh SERVICE (src/spine/mesh.mjs) — the adapters that feed the engine
// from v2's bridge/brain/config — and the spine SEAM (handleInbound routing to mesh),
// all against fakes. No network, no Claude, no relay.mjs internals asserted directly.
import { describe, it, expect } from 'vitest';
import { createMeshService } from '../src/spine/mesh.mjs';
import { createSpine } from '../spine.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';

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
    async resolveChatId(nameOrId, opts) { b.resolveCalls.push({ nameOrId, opts }); return chatIds[nameOrId] ?? nameOrId; },
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

function svc({ node, aliases = [], agents = {}, meshCfg = {}, brain, timers, logs, chatIds = {} } = {}) {
  const bridge = fakeBridge({ chatIds });
  const cfg = { node_name: node, node_alias: aliases, agents, mesh: meshCfg };
  const mesh = createMeshService({
    bridge, brain: brain ?? fakeBrain(),
    getConfig: () => cfg, bodyEmojiOf,
    setTimer: timers?.setTimer, clearTimer: timers?.clearTimer,
    onLog: (m) => logs?.push(m),
  });
  return { bridge, mesh, cfg };
}

describe('mesh service — outbound (origin relays @being.node)', () => {
  it('(a) posts a 🤔 placeholder + an encoded request envelope to the resolved relay chat, with the return-address', async () => {
    const { bridge, mesh } = svc({ node: 'kg', meshCfg: { nodes: { do: { routes: [{ room_id: 'RELAY' }] } } } });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don.do do X' };

    const ok = await mesh.forward(ev, { being: 'don', node: 'do', target: 'don.do' });
    expect(ok).toBe(true);

    // origin placeholder (its id rides as post_id)
    expect(bridge.statusPosts).toEqual([{ chat: 'CHAT', text: '🤔 thinking…', id: 'post-1' }]);

    // one envelope, to the relay chat, round-tripping via parseMesh (no minted mid — the origin
    // correlates the reply by the re:+awaiting return-address alone)
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].chat).toBe('RELAY');
    const p = parseMesh(bridge.sent[0].text);
    expect(p).toMatchObject({ to: 'don.do', from: 'HFM', from_node: 'kg', by: 'An', body: '@don.do do X', post_id: 'post-1' });
  });

  it('surfaces "no route" home when the target node has no relay route', async () => {
    const { bridge, mesh } = svc({ node: 'kg', meshCfg: {} });   // no mesh.nodes
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don.do hi' };
    const ok = await mesh.forward(ev, { being: 'don', node: 'do' });
    expect(ok).toBe(false);
    expect(bridge.sent.some((s) => s.chat === 'CHAT' && /no route/i.test(s.text))).toBe(true);
  });

  it('ROUTE-DIRECT (a relay agent): forward posts the envelope straight to the relay_channel chat, open-channel (empty `to`)', async () => {
    // The router hands mesh.forward a route-direct target { being, route } — no node,
    // no mesh.nodes config needed. The envelope lands in the relay_channel chat.
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
    expect(parseMesh(s.updates.at(-1)).body).toBe('🤝 aquí');           // body_emoji stamped INTO the body
    const fin = parseMesh(s.finals.at(-1));
    expect(fin).toMatchObject({ by: 'don.do', re: 'HFM.kg', post_id: 'p1', done: true, body: '🤝 aquí' });
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

  it('answers "no <being>.<node> here" (never silence) when the being is disabled', async () => {
    const { bridge, mesh } = svc({ node: 'do', agents: { don: { configuration: 'sonnet-high', name: 'don', enabled: false } } });
    const req = encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', from_node: 'kg', to: 'don.do', mid: 'M9' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();
    const said = bridge.sent.map((s) => parseMesh(s.text)?.body).filter(Boolean);
    expect(said).toContain('no don.do here');
  });
});

describe('mesh service — origin (the reply streams home as a living mirror)', () => {
  it('(c) edits the origin placeholder in place (existingMsgId); the done frame finalizes it', async () => {
    const timers = fakeTimers();
    const { bridge, mesh } = svc({ node: 'kg', meshCfg: { nodes: { do: { routes: [{ room_id: 'RELAY' }] } }, timeout_ms: 60000 }, timers });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don.do hola' };
    await mesh.forward(ev, { being: 'don', node: 'do' });          // arms the wait + posts placeholder 'post-1'
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

  it('does NOT forward an envelope addressed to a self-alias (its own relay route is never consulted)', async () => {
    const brain = fakeBrain({ reply: 'aquí' });
    // if `do` were treated as a foreign node this would forward to ELSEWHERE; it must stay local.
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents: { don: { configuration: 'egpt', name: 'don' } }, brain, meshCfg: { nodes: { do: { routes: [{ room_id: 'ELSEWHERE' }] } } } });
    const req = encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', from_node: 'kg', to: 'don.do', mid: 'M2' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();
    expect(brain.calls).toHaveLength(1);                                       // answered locally as don …
    expect(bridge.sent.filter((s) => s.chat === 'ELSEWHERE')).toHaveLength(0); // … never forwarded to the `do` route
  });

  it('still FORWARDS an envelope addressed to a non-self node (the alias set does not swallow foreign targets)', async () => {
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do', 'mo'], meshCfg: { nodes: { zz: { routes: [{ room_id: 'B' }] } } } });
    const req = encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', from_node: 'kg', to: 'don.zz' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'A', msgId: 'a1', body: req });
    const forwards = bridge.sent.filter((s) => s.chat === 'B');
    expect(forwards).toHaveLength(1);
    expect(parseMesh(forwards[0].text)).toMatchObject({ to: 'don.zz' });
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
  it('(d) a transit node forwards a delivered request one hop toward the target', async () => {
    // 'do' does not own 'don' (no sibling) → it forwards toward 'mo'. Loop safety is the
    // bridge's: it delivers each message once (echo suppression + per-id dedup), so the engine
    // forwards each DELIVERY — there is no minted mid and no engine-level forward-once.
    const { bridge, mesh } = svc({ node: 'do', meshCfg: { nodes: { mo: { routes: [{ room_id: 'B' }] } } } });
    const req = encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', from_node: 'kg', to: 'don.mo' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'A', msgId: 'a1', body: req });
    const forwards = bridge.sent.filter((s) => s.chat === 'B');
    expect(forwards).toHaveLength(1);
    expect(parseMesh(forwards[0].text)).toMatchObject({ to: 'don.mo' });
  });

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
//    RUN-being resolves to `e` (stable warm keys), while the reply stays stamped `by: ed.do`. ──
describe('mesh service — being resolved by a handle (Part A)', () => {
  it('answers an envelope to a persona HANDLE (ed.do) by running the persona being `e`, stamped by: ed.do (FAILS pre-Part-A: "no ed.do here")', async () => {
    const brain = fakeBrain({ reply: 'hola' });
    const { bridge, mesh } = svc({ node: 'do', agents: { egpt: { configuration: 'egpt', handles: ['ed'] } }, brain });
    const req = encodeMesh({ by: 'An', body: '@ed hola', from: 'HFM', from_node: 'kg', to: 'ed.do', post_id: 'p1' });
    await mesh.handle({ surface: 'wa', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();
    // ran the RESOLVED persona being `e`, not the literal handle `ed`
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('e');
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

  it('MULTIPATH record hop (config-driven): a LIST-shaped relay agent forwards an arriving envelope into EVERY resolved path', async () => {
    const chatIds = { rodz1: 'ID1', rodz2: 'ID2', rodz4: 'ID4' };
    const agents = { don: [
      { p1: { relay_channel: 'rodz2', network: 'whatsapp', to: 'wren.kg' } },
      { p2: { relay_channel: 'rodz4', network: 'telegram', to: 'wren.kg' } },
    ] };
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
    // The origin @don.do arms awaiting('HFM') + posts placeholder 'post-1'. The reply arrives in
    // the shared relay room; the origin observes it and edits the placeholder in place.
    const { bridge, mesh } = svc({ node: 'kg', meshCfg: { nodes: { do: { routes: [{ room_id: 'RELAY' }] } } } });
    await mesh.forward({ surface: 'wa', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don.do hola' },
      { being: 'don', node: 'do' });
    await mesh.handle({ surface: 'wa', chatId: 'RELAY', msgId: 'r1', body: encodeMesh({ by: 'don.do', body: '🤝 hey', re: 'HFM.kg', post_id: 'post-1', done: true }) });
    const mirror = bridge.streams.find((s) => s.opts?.existingMsgId === 'post-1');
    expect(mirror?.chat).toBe('CHAT');                                    // the origin placeholder resolved in place
    expect(mirror.finals).toContain('🤝 hey');
  });
});
describe('mesh service — origin-wait timeout', () => {
  it('(f) surfaces "<target> did not answer" into the origin chat when no reply arrives', async () => {
    const timers = fakeTimers();
    const { bridge, mesh } = svc({ node: 'kg', meshCfg: { nodes: { do: { routes: [{ room_id: 'RELAY' }] } }, timeout_ms: 30000 }, timers });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don.do hola' };
    await mesh.forward(ev, { being: 'don', node: 'do' });
    expect(timers.timers).toHaveLength(1);
    expect(timers.timers[0].ms).toBe(30000);

    timers.timers[0].fn();                                          // fire the timeout
    await flush();
    expect(bridge.sent.some((s) => s.chat === 'CHAT' && /don\.do did not answer/.test(s.text))).toBe(true);
  });
});

// ── the SPINE SEAM: handleInbound routes envelopes + mesh targets to the service,
//    and leaves ordinary chat untouched (regression lock g). ──
function seamSpine({ router, mesh, mayReply = true } = {}) {
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
    mesh, clock: { now: () => 1 },
  });
  return { spine, bridge, brain, transcript };
}

describe('spine seam — handleInbound ↔ mesh', () => {
  const localRouter = { resolve: () => ({ being: 'e', mention: {} }) };
  const meshRouter = { resolve: () => ({ being: null, mesh: { being: 'don', node: 'do', target: 'don.do' }, mention: { atEStart: true, atEAnywhere: true, replyToBot: false } }) };
  const recorderMesh = () => ({ handled: [], forwarded: [], isEnvelope: (ev) => String(ev.body).startsWith('ENV:'), async handle(ev) { this.handled.push(ev); }, async forward(ev, t) { this.forwarded.push({ ev, t }); return true; }, async onEdit() { return false; } });
  const MSG = { surface: 'wa', node: 'wa', chatId: 'CHAT', chatName: 'fam', senderId: 'u', senderName: 'An', msgId: 'm1', ts: 1, kind: 'text', raw: {} };

  it('an inbound envelope → mesh.handle, logged, NO brain, NO routing', async () => {
    const mesh = recorderMesh();
    const { spine, brain, transcript } = seamSpine({ router: localRouter, mesh });
    await spine.handleInbound({ ...MSG, body: 'ENV: relay traffic' });
    expect(mesh.handled).toHaveLength(1);
    expect(brain.calls).toHaveLength(0);
    expect(transcript.entries).toHaveLength(1);
  });

  it('a mesh-target mention (mayReply) → mesh.forward, logged, NO brain', async () => {
    const mesh = recorderMesh();
    const { spine, brain, transcript } = seamSpine({ router: meshRouter, mesh });
    await spine.handleInbound({ ...MSG, body: '@don.do do X' });
    expect(mesh.forwarded).toHaveLength(1);
    expect(mesh.forwarded[0].t).toMatchObject({ being: 'don', node: 'do' });
    expect(brain.calls).toHaveLength(0);
    expect(transcript.entries).toHaveLength(1);
  });

  it('a mesh target that gating gates out (mayReply=false) → NOT forwarded (logged only)', async () => {
    const mesh = recorderMesh();
    const { spine } = seamSpine({ router: meshRouter, mesh, mayReply: false });
    await spine.handleInbound({ ...MSG, body: '@don.do do X' });
    expect(mesh.forwarded).toHaveLength(0);
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
