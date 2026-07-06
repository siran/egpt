import { describe, it, expect } from 'vitest';
import { createMeshRelay, encodeMesh, parseMesh, mentionedBeing } from '../src/mesh/relay.mjs';

// A shared relay channel (the 1:1) observed by both spines, plus captures of what
// each surfaced home and acked. No network — just visible text.
function harness({ donReply = async () => 'yes, here' } = {}) {
  const channel = [];
  const surfaced = { kg: [], do: [] };
  const acks = { kg: [], do: [] };
  const route = { chat: 'C' };

  const mk = (node, beings, run) => createMeshRelay({
    node,
    send: async (_r, text) => { channel.push(text); },
    surface: async (origin, text, info = {}) => { surfaced[node].push({ origin, text, info }); },
    ack: async (origin, text) => { acks[node].push({ origin, text }); },
    runBeing: run,
    resolveRoute: () => route,
    isLocalBeing: (b) => beings.includes(b),
  });

  const kg = mk('kg', [], async () => '');
  const doSpine = mk('do', ['don'], donReply);

  async function deliver(text) {
    await kg.onRoomMessage({ route, text });
    await doSpine.onRoomMessage({ route, text });
  }
  return { channel, surfaced, acks, kg, do: doSpine, deliver, route };
}

describe('mesh relay — YAML provenance over a shared channel', () => {
  it('encodes an OPAQUE base64 body with a READABLE tail, and round-trips (An 2026-06-20)', () => {
    const w = encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM' });
    expect(w).toMatch(/\nfrom: HFM\n/);            // routing tail stays readable
    expect(w).toMatch(/\nby: An\n/);
    expect(w).toMatch(/\nenc: b64\n/);             // body-encoding marked
    expect(w).not.toContain('hi @don');            // body is opaque in the channel (mangle-proof + private)
    expect(parseMesh(w)).toMatchObject({ body: 'hi @don', from: 'HFM', by: 'An', re: '' });   // decodes back
  });

  it('a code-bearing body (backticks/fences) round-trips EXACTLY (the bug that broke Don)', () => {
    const body = 'fix:\n```js\nconst t = `x ${1}`;\n```\ndone';
    const p = parseMesh(encodeMesh({ by: 'don.do', body, re: 'HFM', done: true }));
    expect(p.body).toBe(body);
  });

  it('legacy un-encoded messages (no enc tag) still parse raw — backward compatible', () => {
    expect(parseMesh('```\nhi @don\n\n---\nfrom: HFM\nby: An\n```'))
      .toMatchObject({ body: 'hi @don', from: 'HFM', by: 'An' });
  });

  it('a reply omits empty keys and surfaces a CLEAN body (no leaked from: or ---)', () => {
    const reply = encodeMesh({ by: 'don.do', body: '🐕 Hola', re: 'HFM' });   // from is empty
    expect(reply).not.toMatch(/\bfrom:/);                                       // no empty key emitted
    const p = parseMesh(reply);
    expect(p.body).toBe('🐕 Hola');
    expect(p).toMatchObject({ by: 'don.do', re: 'HFM' });
  });

  it('strips a stray empty "from:" AND its divider out of the body (defense)', () => {
    const p = parseMesh('```\n🐕 Hola\n\n---\nfrom:\nby: don.do\nre: HFM\n```');
    expect(p.body).toBe('🐕 Hola');                                             // no trailing ---/from:
  });

  it('parses tolerantly even if a bridge mangles the fence/divider', () => {
    expect(parseMesh('hi @don\n---\nfrom: HFM\nby: An\nto: do'))
      .toMatchObject({ body: 'hi @don', from: 'HFM', by: 'An', to: 'do' });
  });

  it('relays @don, acks "relayed — waiting", and surfaces the reply home', async () => {
    const h = harness({ donReply: async (_b, prompt) => `you said: ${prompt}` });
    const ok = await h.kg.relayOut({ being: 'don', toNode: 'do', body: 'hi @don', origin: { chat_id: 'HFM-id', name: 'HFM' }, sender: 'An' });
    expect(ok).toBe(true);

    // wire: body OPAQUE (base64, mangle-proof), readable routing tail — no cryptic minted tag
    expect(h.channel).toHaveLength(1);
    expect(h.channel[0]).toMatch(/^```/);          // whole payload fenced (verbatim over transport)
    expect(h.channel[0]).not.toContain('hi @don'); // body opaque in the channel
    expect(h.channel[0]).toMatch(/to: don\.do/);    // routing tail readable — being.node format
    expect(parseMesh(h.channel[0])).toMatchObject({ body: 'hi @don', to: 'don.do' });   // decodes back
    expect(h.channel[0]).not.toMatch(/egpt-mesh/);
    // origin placeholder is a lone 🤔 (renders big; edited in place into the reply)
    expect(h.acks.kg[0].text).toBe('🤔 thinking…');

    // both observe; only `do` owns don → it runs (mention stripped) and replies
    await h.deliver(h.channel[0]);
    expect(h.channel).toHaveLength(2);
    expect(parseMesh(h.channel[1])).toMatchObject({ by: 'don.do', re: 'HFM.kg', body: 'you said: hi' });

    // both observe the reply; kg correlates via re:HFM.kg and surfaces home with the being's identity (by)
    await h.deliver(h.channel[1]);
    expect(h.surfaced.kg).toEqual([
      { origin: { chat_id: 'HFM-id', name: 'HFM' }, text: 'you said: hi', info: { by: 'don.do' } },
    ]);
    expect(h.surfaced.do).toHaveLength(0);
  });

  it('a relayed reply surfaces home identified by the being (by), never bare', async () => {
    const h = harness({ donReply: async () => 'Jaja, me pillaste' });
    await h.kg.relayOut({ being: 'don', toNode: 'do', body: 'hi @don', origin: { chat_id: 'HFM-id', name: 'HFM' }, sender: 'An' });
    await h.deliver(h.channel[h.channel.length - 1]);    // do answers
    await h.deliver(h.channel[h.channel.length - 1]);    // kg surfaces home
    const s = h.surfaced.kg.at(-1);
    expect(s.text).toBe('Jaja, me pillaste');             // body itself stays clean
    expect(s.info).toMatchObject({ by: 'don.do' });       // identity rides alongside
  });

  it('answers "no <being>.<node> here" — never silence — when the peer lacks it', async () => {
    const h = harness();
    await h.do.onRoomMessage({ route: h.route, text: encodeMesh({ by: 'An', body: 'hi @ghost', from: 'HFM', to: 'ghost.do' }) });
    expect(h.channel).toHaveLength(1);
    expect(parseMesh(h.channel[0])).toMatchObject({ by: 'ghost.do', body: 'no ghost.do here' });
  });

  it('never re-relays mesh traffic (a provenance-tailed message is consumed)', async () => {
    const h = harness();
    // kg is not the target node (to: don.do) → consume, no re-relay, no "not here"
    const consumed = await h.kg.onRoomMessage({ route: h.route, text: encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', to: 'don.do' }) });
    expect(consumed).toBe(true);
    expect(h.channel).toHaveLength(0);
  });

  it('the relayer ignores its own request echo (no false "not here")', async () => {
    const h = harness();
    await h.kg.relayOut({ being: 'don', toNode: 'do', body: 'hi @don', origin: { chat_id: 'HFM-id', name: 'HFM' }, sender: 'An' });
    h.channel.length = 0;
    await h.kg.onRoomMessage({ route: h.route, text: encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', to: 'don.do' }) });
    expect(h.channel).toHaveLength(0);  // to: don.do != kg → stays quiet (no false "not here")
  });

  it('ignores ordinary messages', async () => {
    const h = harness();
    expect(parseMesh('just a normal message')).toBeNull();
    expect(await h.do.onRoomMessage({ route: h.route, text: 'just a normal message' })).toBe(false);
  });

  it('mentionedBeing finds the first @mention', () => {
    expect(mentionedBeing('hi @don how are you')).toBe('don');
    expect(mentionedBeing('no mention here')).toBeNull();
  });

  // ── fail-safes (the 2026-06-19 re-relay loop) ──
  it('recognises its own echo even when a bridge renders it as HTML (no re-relay loop)', () => {
    const echo = '<p>An: hi <a href="http://don.do" rel="noopener">@don</a></p>\n<hr>\n<pre>from: HFM\nby: An\nto: do</pre>';
    const p = parseMesh(echo);
    expect(p).not.toBeNull();              // recognised as mesh traffic → consumed, never re-relayed
    expect(p).toMatchObject({ to: 'do', by: 'An', from: 'HFM' });
  });

  it('reads a tail value Beeper has linkified (don.do → [don.do](http://don.do))', () => {
    const w = encodeMesh({ by: 'An', body: 'hi', from: 'HFM', to: 'wren.kg', re: 'HFM.kg' });
    const linkified = w.replace('to: wren.kg', 'to: [wren.kg](http://wren.kg)').replace('re: HFM.kg', 're: [HFM.kg](http://HFM.kg)');
    expect(parseMesh(linkified)).toMatchObject({ to: 'wren.kg', re: 'HFM.kg' });
  });

  it('peels an accumulated "An: An: …" prefix (the loop signature) back to the body', () => {
    const p = parseMesh('An: An: An: hi @don\n\n---\n```\nfrom: HFM\nby: An\nto: do\n```');
    expect(p.body).toBe('hi @don');
  });

  it('CIRCUIT BREAKER: a runaway is capped — mesh sends to a channel stop after the cap', async () => {
    const sends = [];
    const relay = createMeshRelay({
      node: 'do',
      send: async (_r, t) => { sends.push(t); },
      isLocalBeing: () => true,
      runBeing: async () => 'ok',
      resolveRoute: () => ({ room_id: 'C' }),
      log: () => {},
    });
    for (let i = 0; i < 20; i++) {
      await relay.onRoomMessage({ route: { room_id: 'C' }, text: encodeMesh({ by: 'An', body: `hi @don ${i}`, from: 'HFM', to: 'don.do' }) });
    }
    expect(sends.length).toBeLessThanOrEqual(5);   // 20 requests, but the breaker halts the flood
  });

  // ── STREAMING — a LIVING MIRROR (An 2026-06-21): the responder edit-streams ONE
  //    relay-room message; the origin mirrors EVERY edit onto its placeholder. The
  //    being's body_emoji is stamped INTO the body by the responder (it owns the emoji;
  //    the origin can't look up a remote being's); the FINAL frame carries done:true so
  //    the origin appends "✅ Done". ──
  it('emits done (final-frame marker) and round-trips; emoji is NOT a wire key', () => {
    const final = encodeMesh({ by: 'don.do', body: '🤝 x', re: 'HFM', done: true });
    expect(final).not.toMatch(/\bemoji:/);                           // emoji is stamped into the body, never a key
    expect(final).toMatch(/\ndone: true\n/);
    expect(parseMesh(final)).toMatchObject({ by: 'don.do', re: 'HFM', body: '🤝 x', done: true });
    // a non-final frame carries no done
    const frame = encodeMesh({ by: 'don.do', body: 'x', re: 'HFM' });
    expect(frame).not.toMatch(/\bdone:/);
    expect(parseMesh(frame)).toMatchObject({ done: false });
  });

  it('RESPONDER hands the prompt to the NORMAL dispatch (relayDispatch) — does not run the being itself', async () => {
    let dispatched = null; let ranBeing = false;
    const doSpine = createMeshRelay({
      node: 'do', send: async () => {}, surface: async () => {},
      runBeing: async () => { ranBeing = true; return 'should not run'; },
      resolveRoute: () => ({ room_id: 'C' }), isLocalBeing: (b) => b === 'don',
      relayDispatch: async (d) => { dispatched = d; },
    });
    await doSpine.onRoomMessage({ route: { room_id: 'C' }, text: encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', to: 'don.do' }), msgId: 'm1' });
    expect(ranBeing).toBe(false);                                                 // routed, not run locally
    expect(dispatched).toMatchObject({ being: 'don', prompt: 'hola', re: 'HFM', by: 'don.do' });
    expect(dispatched.route).toMatchObject({ room_id: 'C' });
  });

  it('RESPONDER falls back to one-shot runBeing when no relayDispatch is wired', async () => {
    const sent = [];
    const doSpine = createMeshRelay({
      node: 'do', send: async (_r, t) => sent.push(t), surface: async () => {},
      runBeing: async () => 'Jaja, aquí',
      resolveRoute: () => ({ room_id: 'C' }), isLocalBeing: (b) => b === 'don',
    });
    await doSpine.onRoomMessage({ route: { room_id: 'C' }, text: encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', to: 'don.do' }), msgId: 'm1' });
    expect(parseMesh(sent[sent.length - 1])).toMatchObject({ by: 'don.do', body: 'Jaja, aquí', re: 'HFM' });
  });

  it('RESPONDER stamps the being body_emoji INTO the fallback body (no emoji wire key)', async () => {
    const sent = [];
    const doSpine = createMeshRelay({
      node: 'do', send: async (_r, t) => sent.push(t), surface: async () => {},
      runBeing: async () => 'aquí', beingEmoji: () => '🤝',
      resolveRoute: () => ({ room_id: 'C' }), isLocalBeing: (b) => b === 'don',
    });
    await doSpine.onRoomMessage({ route: { room_id: 'C' }, text: encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', to: 'don.do' }), msgId: 'm1' });
    expect(sent[sent.length - 1]).not.toMatch(/\bemoji:/);                 // emoji is not a wire key
    expect(parseMesh(sent[sent.length - 1]).body).toBe('🤝 aquí');          // it's stamped into the body
  });

  it('ORIGIN mirrors a streamed reply verbatim (stamp rides in the body): opens, updates, finalizes', async () => {
    const updates = []; let finished = null; const oneShot = [];
    const kg = createMeshRelay({
      node: 'kg', send: async () => {}, surface: async (_o, t) => oneShot.push(t), ack: async () => {},
      runBeing: async () => '', resolveRoute: () => ({ room_id: 'C' }), isLocalBeing: () => false,
      openOriginStream: (_returnTo, info) => { updates.push({ open: info }); return { update: (b) => updates.push(b), finish: async (b) => { finished = b; } }; },
    });
    await kg.relayOut({ being: 'don', toNode: 'do', body: '@don hola', origin: { surface: 'whatsapp', chat_id: 'X', name: 'HFM' }, sender: 'An' });
    // first sight of the responder's relay message (r1) opens the mirror, keyed by r1.
    // the body_emoji is part of the BODY (stamped by the responder) — no emoji key.
    await kg.onRoomMessage({ route: { room_id: 'C' }, text: encodeMesh({ by: 'don.do', body: '🤔', re: 'HFM' }), msgId: 'r1' });
    // every subsequent edit of r1 flows onto the placeholder; done:true finalizes it
    await kg.onRoomMessageEdit({ msgId: 'r1', text: encodeMesh({ by: 'don.do', body: '🤝 Jaja', re: 'HFM' }) });
    await kg.onRoomMessageEdit({ msgId: 'r1', text: encodeMesh({ by: 'don.do', body: '🤝 Jaja, aquí', re: 'HFM', done: true }) });
    expect(updates[0].open).toMatchObject({ by: 'don.do' });                // identity (by) rides to the origin stream
    expect(updates).toContain('🤔');
    expect(updates).toContain('🤝 Jaja');                                   // the stamp is in the mirrored body
    expect(finished).toBe('🤝 Jaja, aquí');                                 // done frame finalized (bridge appends ✅ Done)
    expect(oneShot).toHaveLength(0);                                        // streamed, never one-shot surfaced
  });

  it('ORIGIN one-shots (surfaces once) when no stream primitive is wired', async () => {
    const surfaced = [];
    const kg = createMeshRelay({
      node: 'kg', send: async () => {}, surface: async (_o, t) => surfaced.push(t), ack: async () => {},
      runBeing: async () => '', resolveRoute: () => ({ room_id: 'C' }), isLocalBeing: () => false,
    });
    await kg.relayOut({ being: 'don', toNode: 'do', body: '@don hola', origin: { surface: 'whatsapp', chat_id: 'X', name: 'HFM' }, sender: 'An' });
    await kg.onRoomMessage({ route: { room_id: 'C' }, text: encodeMesh({ by: 'don.do', body: 'final', re: 'HFM', done: true }), msgId: 'r1' });
    expect(surfaced).toEqual(['final']);
  });

  it('onRoomMessageEdit ignores an edit for a message it is not streaming (returns false → bridge handles it)', async () => {
    const kg = createMeshRelay({ node: 'kg', send: async () => {}, surface: async () => {}, resolveRoute: () => ({ room_id: 'C' }), isLocalBeing: () => false });
    expect(await kg.onRoomMessageEdit({ msgId: 'unknown', text: 'whatever' })).toBe(false);
  });
});

// ── DECLARATIVE RELAY CHAIN (operator 2026-07-05): agents.<name>.{relay_channel, to} —
//    @carol → Rodz1(to:don.do) → don → Rodz2(to:wren.kg) → … Each hop re-addresses onward via
//    its own relay-record and forwards into its OWN relay_channel. No minted mid: loop safety is
//    the bridge's (a node never re-sees its own posts; a foreign re-delivery dedups by msg id). ──
describe('mesh relay — declarative relay chain (relay_channel + to)', () => {
  it('relayOut with an explicit `to` encodes it as the envelope target (originating re-address)', async () => {
    const sent = [];
    const origin = createMeshRelay({
      node: 'origin', send: async (r, t) => sent.push({ room: r.room_id, t }),
      surface: async () => {}, ackWithPostId: async () => 'p1',
    });
    await origin.relayOut({ being: 'carol', route: { room_id: 'Rodz1' }, to: 'don.do', body: 'hola', origin: { chat_id: 'X', name: 'Me' }, sender: 'An' });
    expect(sent).toHaveLength(1);
    expect(sent[0].room).toBe('Rodz1');
    expect(parseMesh(sent[0].t)).toMatchObject({ to: 'don.do', body: 'hola' });
  });

  it('a relay-record forwards into its OWN route (relay_channel), re-addressed to `to`', async () => {
    const sent = [];
    const doSpine = createMeshRelay({
      node: 'do', send: async (r, t) => sent.push({ room: r.room_id, t }), surface: async () => {},
      isSelfNode: (n) => n === 'do', isLocalBeing: () => false, resolveRoute: () => null,   // pure declarative, no mesh.nodes
      resolveBeingRelay: (b) => (b === 'don' ? { being: 'wren', node: 'kg', route: { room_id: 'Rodz2' } } : null),
    });
    const req = encodeMesh({ by: 'An', body: 'hola', from: 'Me', from_node: 'origin', to: 'don.do' });
    await doSpine.onRoomMessage({ route: { room_id: 'Rodz1' }, text: req, msgId: 'a1' });
    expect(sent).toHaveLength(1);
    expect(sent[0].room).toBe('Rodz2');
    expect(parseMesh(sent[0].t)).toMatchObject({ to: 'wren.kg', body: 'hola' });
  });

  it('a relay-record ALWAYS forwards into its own route — even when the next hop is local (no collapse)', async () => {
    const sent = [];
    const kg = createMeshRelay({
      node: 'kg', send: async (r, t) => sent.push({ room: r.room_id, t }), surface: async () => {},
      isSelfNode: (n) => n === 'kg', isLocalBeing: (b) => b === 'e' || b === 'egpt',
      resolveBeingRelay: (b) => (b === 'wren' ? { being: 'egpt', node: 'kg', route: { room_id: 'Rodz3' } } : null),
      // a relay-record forwards; it must NOT dispatch locally even when its next hop is a local being
      relayDispatch: async () => { throw new Error('must not dispatch: a relay-record forwards, never collapses'); },
    });
    const req = encodeMesh({ by: 'An', body: 'hola', from: 'Me', from_node: 'origin', to: 'wren.kg' });
    await kg.onRoomMessage({ route: { room_id: 'Rodz2' }, text: req, msgId: 'a1' });
    expect(sent).toHaveLength(1);
    expect(sent[0].room).toBe('Rodz3');                                    // a REAL visible hop into wren's own route
    expect(parseMesh(sent[0].t)).toMatchObject({ to: 'egpt.kg', body: 'hola' });   // re-addressed to the local terminal
  });
});

// ── MULTI-HOP TRANSIT (mesh.nodes scheme): a spine that isn't the destination forwards the
//    request one hop toward it via resolveRoute(destNode). No engine-level forward-once — each
//    node observes a given envelope once (bridge echo suppression + per-id dedup). It never
//    forwards a request back the way it came (that would echo). ──
describe('mesh relay — multi-hop transit (forward toward a foreign node)', () => {
  const A = { room_id: 'A' }, B = { room_id: 'B' };           // rooms: A = {kg,do}, B = {do,mo}
  const routeFor = (self) => ({ kg: { do: A, mo: A }, do: { kg: A, mo: B }, mo: { kg: B, do: B } }[self]);

  it('a transit node forwards a REQUEST one hop toward the target (to preserved)', async () => {
    const sent = [];
    const doSpine = createMeshRelay({
      node: 'do', send: async (r, t) => sent.push({ room: r.room_id, t }),
      resolveRoute: (n) => routeFor('do')[n] ?? null, isLocalBeing: () => false,   // do does NOT own don
    });
    const req = encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', from_node: 'kg', to: 'don.mo' });
    await doSpine.onRoomMessage({ route: A, text: req, msgId: 'a1' });              // seen in room A → forward to room B
    expect(sent).toHaveLength(1);
    expect(sent[0].room).toBe('B');
    expect(parseMesh(sent[0].t)).toMatchObject({ to: 'don.mo', from: 'HFM', from_node: 'kg', body: 'hi @don' });
  });

  it('a transit node never forwards a request back the way it came (no echo loop)', async () => {
    const sent = [];
    const kg = createMeshRelay({
      node: 'kg', send: async (r) => sent.push(r.room_id),
      resolveRoute: (n) => routeFor('kg')[n] ?? null, isLocalBeing: () => false,
    });
    // kg's next hop toward mo is room A === the incoming room → skip (would echo)
    await kg.onRoomMessage({ route: A, text: encodeMesh({ by: 'An', body: 'hi', from: 'HFM', from_node: 'kg', to: 'don.mo' }), msgId: 'x1' });
    expect(sent).toHaveLength(0);
  });
});

// ── REPLY HOME — the origin is present in the terminal's room (2026-07-06). No minted mid: loop
//    safety is the bus's (a node never re-sees its own posts; a foreign re-delivery dedups by
//    message id). The operator's real chain over DISTINCT node engines sharing a bus:
//      node kg hosts the relay agents carol (→don.do, rodz1) and wren (→ed.do, rodz3)
//      node do hosts the relay agent don (→wren.kg, rodz2) and the egpt persona (handle `ed`)
//    @carol → rodz1(to don.do) → don(do) → rodz2(to wren.kg) → wren(kg) → rodz3(to ed.do) → ed
//    resolves to the egpt persona on do → ANSWERS. kg forwarded the wren→ed.do hop into rodz3, so
//    it is present there to catch ed's reply and surface it home. `ed` is a HANDLE: isLocalBeing
//    ('ed') is true (Part A) and the RUN-being resolves to `e` while the reply stays `by: ed.do`.
//    LIMITATION (out of scope): a chain terminating in a room the origin is NOT in can't reply home.
describe('mesh relay — reply home (origin present in the terminal room)', () => {
  function chain() {
    const surfaced = { kg: [], do: [] };
    const dispatchCount = { do: 0 };
    let ranAs = null;
    const queue = [];
    let ids = 0;
    const engines = {};
    // two nodes → every relay_channel is shared by exactly {kg, do}; a post goes to the OTHER node.
    const post = (room, self, text) => {
      const other = self === 'kg' ? 'do' : 'kg';
      queue.push(() => engines[other].onRoomMessage({ route: { room_id: room }, text, msgId: `x${++ids}` }));
    };
    const drain = async () => { while (queue.length) await queue.shift()(); };

    engines.kg = createMeshRelay({
      node: 'kg', log: () => {},
      isSelfNode: (n) => n === 'kg',
      isLocalBeing: () => false,                                    // kg hosts only relay agents
      resolveBeingRelay: (b) => (b === 'wren' ? { being: 'ed', node: 'do', route: { room_id: 'rodz3' } } : null),
      resolveRoute: () => null,
      send: async (route, text) => { post(route.room_id, 'kg', text); },
      surface: async (origin, text, info = {}) => { surfaced.kg.push({ origin, text, info }); },
      ackWithPostId: async () => 'P',
    });
    engines.do = createMeshRelay({
      node: 'do', log: () => {},
      isSelfNode: (n) => n === 'do',
      // `ed` is a HANDLE of the egpt persona: local, and it RUNS as `e`.
      isLocalBeing: (b) => b === 'e' || b === 'egpt' || b === 'ed',
      resolveLocalBeing: (b) => ((b === 'ed' || b === 'egpt' || b === 'e') ? 'e' : b),
      resolveBeingRelay: (b) => (b === 'don' ? { being: 'wren', node: 'kg', route: { room_id: 'rodz2' } } : null),
      resolveRoute: () => null,
      send: async (route, text) => { post(route.room_id, 'do', text); },
      surface: async (origin, text, info = {}) => { surfaced.do.push({ origin, text, info }); },
      runBeing: async (being, prompt) => { ranAs = being; dispatchCount.do++; return `answer: ${prompt}`; },
      beingEmoji: () => '🐶',
    });
    return { engines, drain, surfaced, dispatchCount, get ranAs() { return ranAs; } };
  }

  it('REPRODUCE-FIRST: carol→don→wren→ed (a HANDLE of egpt) answers and the reply surfaces home', async () => {
    const c = chain();
    await c.engines.kg.relayOut({ being: 'carol', route: { room_id: 'rodz1' }, to: 'don.do', body: '@carol hi', origin: { chat_id: 'SELF', name: 'HFM' }, sender: 'An' });
    await c.drain();                                          // request forwards through the chain; ed answers; reply comes home
    // Part A: `ed` resolved to the canonical persona being `e` (not run as the literal handle)
    expect(c.ranAs).toBe('e');
    // Part B: the reply travelled home (kg is present in the terminal room rodz3), stamped with
    // the addressed-as handle identity
    expect(c.surfaced.kg).toHaveLength(1);
    expect(c.surfaced.kg[0].text).toContain('answer: hi');
    expect(c.surfaced.kg[0].info).toMatchObject({ by: 'ed.do' });
    expect(c.surfaced.do).toHaveLength(0);
  });

  it('a re-delivered foreign request (same content) is not double-answered (the `seen` replay guard)', async () => {
    const c = chain();
    const req = encodeMesh({ by: 'An', body: '@carol hi', from: 'HFM', from_node: 'kg', to: 'ed.do' });
    await c.engines.do.onRoomMessage({ route: { room_id: 'rodz3' }, text: req, msgId: 'd1' });
    await c.engines.do.onRoomMessage({ route: { room_id: 'rodz3' }, text: req, msgId: 'd2' });   // same content, new id
    expect(c.dispatchCount.do).toBe(1);
  });
});
