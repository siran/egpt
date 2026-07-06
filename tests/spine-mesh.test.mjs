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
    // name→id resolution, as the real bridge does (relay_channel is configured by NAME;
    // an observed envelope's ev.chatId is always the RESOLVED id). Unknown → identity.
    async resolveChatId(nameOrId) { return chatIds[nameOrId] ?? nameOrId; },
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
  it('(a) posts a 🤔 placeholder + an encoded request envelope to the resolved relay chat, with mid + return-address', async () => {
    const { bridge, mesh } = svc({ node: 'kg', meshCfg: { nodes: { do: { routes: [{ room_id: 'RELAY' }] } } } });
    const ev = { surface: 'whatsapp', chatId: 'CHAT', chatName: 'HFM', senderName: 'An', body: '@don.do do X' };

    const ok = await mesh.forward(ev, { being: 'don', node: 'do', target: 'don.do' });
    expect(ok).toBe(true);

    // origin placeholder (its id rides as post_id)
    expect(bridge.statusPosts).toEqual([{ chat: 'CHAT', text: '🤔 thinking…', id: 'post-1' }]);

    // one envelope, to the relay chat, round-tripping via parseMesh
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].chat).toBe('RELAY');
    const p = parseMesh(bridge.sent[0].text);
    expect(p).toMatchObject({ to: 'don.do', from: 'HFM', from_node: 'kg', by: 'An', body: '@don.do do X', post_id: 'post-1' });
    expect(p.mid).toMatch(/^mesh-kg-/);            // minted return-correlation id
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
    expect(p.mid).toMatch(/^mesh-kg-/);        // return-correlation id minted as usual
  });
});

describe('mesh service — responder (a request arrives at the owning node)', () => {
  it('(b) runs the target local being (brain.turn) and edit-streams the reply as an envelope (re/post_id/done), mirrored', async () => {
    const brain = fakeBrain({ reply: 'aquí', partials: ['aq', 'aquí'] });
    const { bridge, mesh } = svc({ node: 'do', agents: { don: { configuration: 'sonnet-high', name: 'don' } }, brain });
    const req = encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', from_node: 'kg', to: 'don.do', post_id: 'p1', mid: 'M1' });

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
    expect(fin).toMatchObject({ by: 'don.do', re: 'HFM.kg', post_id: 'p1', mid: 'M1', done: true, body: '🤝 aquí' });
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
    const req = encodeMesh({ by: 'An', body: '@wren hola', from: 'HFM', from_node: 'do', to: 'wren.mo', post_id: 'p1', mid: 'M1' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'RELAY', msgId: 'm1', body: req });
    await flush();
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0].being).toBe('wren');
    const fin = parseMesh(bridge.streams[0].finals.at(-1));
    expect(fin).toMatchObject({ by: 'wren.mo', re: 'HFM.do', post_id: 'p1', mid: 'M1', done: true });   // addressed-as mo, not the node_name kg
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
    const req = encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', from_node: 'kg', to: 'don.zz', mid: 'M3' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'A', msgId: 'a1', body: req });
    const forwards = bridge.sent.filter((s) => s.chat === 'B');
    expect(forwards).toHaveLength(1);
    expect(parseMesh(forwards[0].text)).toMatchObject({ to: 'don.zz', mid: 'M3' });
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
  it('(d) forward-once: a transit node forwards the same mid only ONCE', async () => {
    // 'do' does not own 'don' (no sibling) → it forwards toward 'mo'
    const { bridge, mesh } = svc({ node: 'do', meshCfg: { nodes: { mo: { routes: [{ room_id: 'B' }] } } } });
    const req = encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', from_node: 'kg', to: 'don.mo', mid: 'M1' });
    await mesh.handle({ surface: 'whatsapp', chatId: 'A', msgId: 'a1', body: req });
    await mesh.handle({ surface: 'whatsapp', chatId: 'A', msgId: 'a2', body: req });   // re-seen → dropped
    const forwards = bridge.sent.filter((s) => s.chat === 'B');
    expect(forwards).toHaveLength(1);
    expect(parseMesh(forwards[0].text)).toMatchObject({ to: 'don.mo', mid: 'M1' });
  });

  it('a 3-hop relay-record CHAIN through ONE process now completes past what the old ttl cap would have dropped (hop-cap removed; forward-once + destination-termination are the only bounds)', async () => {
    const agents = {
      carol: { relay_channel: 'rodz1', to: 'don.do' },
      don: { relay_channel: 'rodz2', to: 'wren.kg' },
      wren: { relay_channel: 'rodz3', to: 'egpt.kg' },
      egpt: { configuration: 'egpt', name: 'egpt' },
    };
    const brain = fakeBrain({ reply: 'hey' });
    // meshCfg.ttl:2 is what the OLD code would have used to cap this chain at hop 3 (rodz3);
    // it's now just an ignored/no-op config key — the removal must not need it deleted from a
    // node's existing config.yaml for the chain to work.
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents, meshCfg: { ttl: 2 }, brain });
    const origin = encodeMesh({ by: 'An', body: 'hi', from: 'SELF', from_node: 'kg', to: 'don.do', mid: 'MC' });
    await mesh.handle({ surface: 'wa', chatId: 'rodz1', msgId: 'a1', body: origin });              // hop 1 — forwards to rodz2
    const r2 = bridge.sent.find((s) => s.chat === 'rodz2');
    expect(parseMesh(r2.text)).toMatchObject({ to: 'wren.kg', mid: 'MC' });
    await mesh.handle({ surface: 'wa', chatId: 'rodz2', msgId: 'a2', body: r2.text });             // hop 2 — forwards to rodz3
    const r3 = bridge.sent.find((s) => s.chat === 'rodz3');
    expect(parseMesh(r3.text)).toMatchObject({ to: 'egpt.kg', mid: 'MC' });
    await mesh.handle({ surface: 'wa', chatId: 'rodz3', msgId: 'a3', body: r3.text });             // hop 3 — previously capped at ttl:2, now reaches egpt
    await flush();
    expect(bridge.streams.some((s) => s.chat === 'rodz3')).toBe(true);   // egpt DISPATCHED — no hop gate stopped it
  });
});

// ── REPLY RETURN over a relay_channel configured by NAME (the fix, 2026-07-05). A
//    relay_channel is a NAME ("rodz2"); the reply always arrives under the RESOLVED id
//    ("ID2"). The engine keys its reverse-reply map (fwdArrival) on the room, so pre-fix
//    the store keyed on the NAME while the lookup keyed on the ID → every return-hop
//    MISSED and the reply dead-ended (never mirrored home). resolveBeingRelay now resolves
//    the relay_channel through bridge.resolveChatId, so store-key == observe-key. The
//    existing (e2) chain test never caught this: it fed chatId === the name (no resolution). ──
describe('mesh service — reply return over a name-configured relay_channel', () => {
  it('REPRODUCE-FIRST: a relay-record reply returns into the ARRIVAL room even though relay_channel is a NAME and the reply arrives under the RESOLVED id', async () => {
    const chatIds = { rodz1: 'ID1', rodz2: 'ID2' };
    const agents = { don: { relay_channel: 'rodz2', to: 'wren.kg' } };
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents, chatIds });
    // request arrives in rodz1 (resolved ID1), to don.do → relay-record forwards into rodz2 (ID2)
    const req = encodeMesh({ by: 'An', body: 'hi', from: 'SELF', from_node: 'kg', to: 'don.do', mid: 'M1' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'a1', body: req });
    expect(bridge.sent.some((s) => s.chat === 'ID2')).toBe(true);          // forwarded to the RESOLVED rodz2
    // the reply comes back in the RESOLVED rodz2 room (ID2); the transit must re-mirror it into ID1
    const reply = encodeMesh({ by: 'egpt.kg', body: 'answer', re: 'SELF.origin', mid: 'M1', done: true });
    await mesh.handle({ surface: 'wa', chatId: 'ID2', msgId: 'r1', body: reply });
    // openRelayStream posts the return-hop into the ARRIVAL room ID1 (pre-fix: no such stream — MISS)
    expect(bridge.streams.filter((s) => s.chat === 'ID1')).toHaveLength(1);
  });

  it('FULL 3-HOP: the reply mirrors rodz3→rodz2→rodz1→origin exactly once (return-hop wins over process-global awaiting)', async () => {
    const chatIds = { rodz1: 'ID1', rodz2: 'ID2', rodz3: 'ID3' };
    const agents = {
      carol: { relay_channel: 'rodz1', to: 'don.do' },
      don: { relay_channel: 'rodz2', to: 'wren.kg' },
      wren: { relay_channel: 'rodz3', to: 'egpt.kg' },
      egpt: { configuration: 'egpt', name: 'egpt' },
    };
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do', 'mo', 'ca'], agents, meshCfg: { ttl: 10 }, chatIds });

    // ORIGIN: operator "@carol" in the Self DM — arms awaiting('HFM'), posts the placeholder + the request into rodz1
    await mesh.forward({ surface: 'wa', chatId: 'ORIGIN', chatName: 'HFM', senderName: 'An', body: '@carol hi' },
      { being: 'carol', route: { room_id: 'rodz1' }, to: 'don.do' });
    const req0 = bridge.sent.find((s) => s.chat === 'rodz1');
    const mid = parseMesh(req0.text).mid;
    expect(parseMesh(req0.text)).toMatchObject({ to: 'don.do' });

    // REQUEST forward through the chain, each hop observed under its RESOLVED id (the
    // relay-record forwards into the RESOLVED relay_channel — that's the whole fix):
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'q1', body: req0.text });      // don relays → rodz2 (ID2)
    const req1 = bridge.sent.find((s) => s.chat === 'ID2');
    expect(parseMesh(req1.text)).toMatchObject({ to: 'wren.kg', mid });
    await mesh.handle({ surface: 'wa', chatId: 'ID2', msgId: 'q2', body: req1.text });      // wren relays → rodz3 (ID3)
    const req2 = bridge.sent.find((s) => s.chat === 'ID3');
    expect(parseMesh(req2.text)).toMatchObject({ to: 'egpt.kg', mid });
    await mesh.handle({ surface: 'wa', chatId: 'ID3', msgId: 'q3', body: req2.text });      // egpt is LOCAL → dispatched
    await flush();
    expect(bridge.streams.some((s) => s.chat === 'ID3')).toBe(true);                        // the request reached egpt cleanly

    // REPLY streams back. Feed the (done) reply frame in each RESOLVED room; assert each return target.
    const rep = () => encodeMesh({ by: 'egpt.kg', body: 'hey', re: 'HFM.kg', post_id: 'post-1', mid, done: true });
    const before = bridge.streams.length;
    await mesh.handle({ surface: 'wa', chatId: 'ID3', msgId: 'p3', body: rep() });          // rodz3 → return-hop into rodz2 (ID2)
    await mesh.handle({ surface: 'wa', chatId: 'ID2', msgId: 'p2', body: rep() });          // rodz2 → return-hop into rodz1 (ID1)
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'p1', body: rep() });          // rodz1 → ORIGIN mirror (awaiting HFM)

    const reverse = bridge.streams.slice(before).map((s) => s.chat);
    expect(reverse).toEqual(['ID2', 'ID1', 'ORIGIN']);                                      // the reverse chain, once each
    const originMirror = bridge.streams.find((s) => s.opts?.existingMsgId === 'post-1');
    expect(originMirror?.chat).toBe('ORIGIN');                                              // the true origin placeholder resolved
  });

  it('REPRODUCE-FIRST (single-process, faithful reverse-mirror): post_id survives EVERY reverse hop so the TRUE origin placeholder (existingMsgId) resolves — not a fresh one', async () => {
    // The FULL 3-HOP test above HAND-FEEDS post_id into every room; the LIVE failure was that
    // the reverse mirror (openRelayStream) STRIPPED post_id, so by the time the reply reached
    // the origin room it had none → openOriginStream opened a FRESH placeholder (existingMsgId
    // null → empty text → dropped by the bridge) and the real 🤔 one never updated (operator
    // 2026-07-05). Here we feed each reverse hop the ACTUAL output of the previous
    // openRelayStream — exactly as a single process re-observes its OWN posts — so the strip is
    // exercised end-to-end.
    const chatIds = { rodz1: 'ID1', rodz2: 'ID2', rodz3: 'ID3' };
    const agents = {
      carol: { relay_channel: 'rodz1', to: 'don.do' },
      don: { relay_channel: 'rodz2', to: 'wren.kg' },
      wren: { relay_channel: 'rodz3', to: 'egpt.kg' },
      egpt: { configuration: 'egpt', name: 'egpt' },
    };
    const brain = fakeBrain({ reply: 'hola qué tal' });
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do', 'mo', 'ca'], agents, meshCfg: { ttl: 10 }, brain, chatIds });

    // ORIGIN @carol — arms awaiting('HFM'), posts placeholder 'post-1' + the request into rodz1
    await mesh.forward({ surface: 'wa', chatId: 'ORIGIN', chatName: 'HFM', senderName: 'An', body: '@carol hi' },
      { being: 'carol', route: { room_id: 'rodz1' }, to: 'don.do' });
    const req0 = bridge.sent.find((s) => s.chat === 'rodz1');

    // FORWARD leg (each hop observed under its RESOLVED id)
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'q1', body: req0.text });
    await mesh.handle({ surface: 'wa', chatId: 'ID2', msgId: 'q2', body: bridge.sent.find((s) => s.chat === 'ID2').text });
    await mesh.handle({ surface: 'wa', chatId: 'ID3', msgId: 'q3', body: bridge.sent.find((s) => s.chat === 'ID3').text });
    await flush();

    // egpt answered in rodz3 (ID3) via relayDispatch — its OWN reply DOES carry post_id.
    const egptFrame = bridge.streams.find((s) => s.chat === 'ID3').finals.at(-1);
    expect(parseMesh(egptFrame)).toMatchObject({ by: 'egpt.kg', post_id: 'post-1', done: true });

    // REPLY leg — feed each hop the ACTUAL output of the previous openRelayStream (its final frame).
    let n = bridge.streams.length;
    await mesh.handle({ surface: 'wa', chatId: 'ID3', msgId: 'p3', body: egptFrame });          // rodz3 → return-hop into rodz2
    const frame2 = bridge.streams.slice(n).find((s) => s.chat === 'ID2').finals.at(-1);
    expect(parseMesh(frame2).post_id).toBe('post-1');                                           // post_id rode the hop (pre-fix: '')

    n = bridge.streams.length;
    await mesh.handle({ surface: 'wa', chatId: 'ID2', msgId: 'p2', body: frame2 });             // rodz2 → return-hop into rodz1
    const frame1 = bridge.streams.slice(n).find((s) => s.chat === 'ID1').finals.at(-1);
    expect(parseMesh(frame1).post_id).toBe('post-1');

    n = bridge.streams.length;
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'p1', body: frame1 });             // rodz1 → the TRUE origin mirror
    const originMirror = bridge.streams.slice(n).find((s) => s.chat === 'ORIGIN');
    expect(originMirror).toBeTruthy();
    expect(originMirror.opts.existingMsgId).toBe('post-1');                                     // edits the REAL placeholder (pre-fix: null → fresh/dropped)
    expect(originMirror.finals.at(-1)).toContain('hola qué tal');
  });

  it('REGRESSION: a relay_channel configured as a RAW id (not a name) still round-trips the reply, unchanged', async () => {
    // relay_channel is already the real id "ID2"; resolveChatId returns it unchanged, so the
    // store/lookup keys agree exactly as before the fix — a pure regression lock.
    const chatIds = { rodz1: 'ID1' };                                     // "ID2" is NOT a name → resolveChatId('ID2') === 'ID2'
    const agents = { don: { relay_channel: 'ID2', to: 'wren.kg' } };
    const { bridge, mesh } = svc({ node: 'kg', aliases: ['do'], agents, chatIds });
    const req = encodeMesh({ by: 'An', body: 'hi', from: 'SELF', from_node: 'kg', to: 'don.do', mid: 'M1' });
    await mesh.handle({ surface: 'wa', chatId: 'ID1', msgId: 'a1', body: req });
    const reply = encodeMesh({ by: 'egpt.kg', body: 'answer', re: 'SELF.origin', mid: 'M1', done: true });
    await mesh.handle({ surface: 'wa', chatId: 'ID2', msgId: 'r1', body: reply });
    expect(bridge.streams.filter((s) => s.chat === 'ID1')).toHaveLength(1);
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
