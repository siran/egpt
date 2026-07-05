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
    const w = encodeMesh({ by: 'An', body: 'hi', from: 'HFM', to: 'wren.kg', re: 'HFM.kg', mid: 'm1' });
    const linkified = w.replace('to: wren.kg', 'to: [wren.kg](http://wren.kg)').replace('re: HFM.kg', 're: [HFM.kg](http://HFM.kg)');
    expect(parseMesh(linkified)).toMatchObject({ to: 'wren.kg', re: 'HFM.kg', mid: 'm1' });
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

// ── MULTI-HOP TRANSIT (An 2026-06-21): a spine that isn't the destination forwards one
//    hop toward it. Loop-safe by forwarding each `mid` ONCE (no ttl). Requests forward as
//    new posts; replies re-mirror via EDITS (rate-free), chaining the stream hop by hop. ──
describe('mesh relay — multi-hop transit', () => {
  const A = { room_id: 'A' }, B = { room_id: 'B' };           // rooms: A = {kg,do}, B = {do,mo}
  const routeFor = (self) => ({                                // next-hop routing table
    kg: { do: A, mo: A }, do: { kg: A, mo: B }, mo: { kg: B, do: B },
  }[self]);

  it('a transit node forwards a REQUEST one hop toward the target (mid preserved), only once', async () => {
    const sent = [];
    const doSpine = createMeshRelay({
      node: 'do', send: async (r, t) => sent.push({ room: r.room_id, t }),
      resolveRoute: (n) => routeFor('do')[n] ?? null, isLocalBeing: () => false,   // do does NOT own don
    });
    const req = encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', from_node: 'kg', to: 'don.mo', mid: 'M1' });
    await doSpine.onRoomMessage({ route: A, text: req, msgId: 'a1' });              // seen in room A → forward to room B
    expect(sent).toHaveLength(1);
    expect(sent[0].room).toBe('B');
    expect(parseMesh(sent[0].t)).toMatchObject({ to: 'don.mo', from: 'HFM', from_node: 'kg', mid: 'M1', body: 'hi @don' });
    await doSpine.onRoomMessage({ route: A, text: req, msgId: 'a2' });              // re-seen (loop) → NOT forwarded again
    expect(sent).toHaveLength(1);
  });

  it('a transit node never forwards a request back the way it came (no echo loop)', async () => {
    const sent = [];
    const kg = createMeshRelay({
      node: 'kg', send: async (r) => sent.push(r.room_id),
      resolveRoute: (n) => routeFor('kg')[n] ?? null, isLocalBeing: () => false,
    });
    // kg sees its OWN request echo in room A (to: don.mo); next hop toward mo is room A === incoming → skip
    await kg.onRoomMessage({ route: A, text: encodeMesh({ by: 'An', body: 'hi', from: 'HFM', from_node: 'kg', to: 'don.mo', mid: 'M2' }), msgId: 'x1' });
    expect(sent).toHaveLength(0);
  });

  it('a node that FORWARDED a request re-mirrors the reply back into the channel (return hop), once', async () => {
    const opened = []; const updates = []; let finished = null;
    const doSpine = createMeshRelay({
      node: 'do', send: async () => {}, surface: async () => {},
      resolveRoute: (n) => routeFor('do')[n] ?? null, isLocalBeing: () => false,
      openRelayStream: (route, info) => { opened.push({ room: route.room_id, info }); return { update: (b) => updates.push(b), finish: async (b) => { finished = b; } }; },
    });
    // do first FORWARDS the request (toward mo) — recording that it handled this mid
    await doSpine.onRoomMessage({ route: A, text: encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', from_node: 'kg', to: 'don.mo', mid: 'M3' }), msgId: 'q1' });
    // the reply for that mid comes back through the channel → do re-mirrors it (same channel)
    const frame = (body, done = false) => encodeMesh({ by: 'don.mo', body, re: 'HFM.kg', mid: 'M3', done });
    await doSpine.onRoomMessage({ route: A, text: frame('🤝 Ja'), msgId: 'r1' });
    await doSpine.onRoomMessageEdit({ msgId: 'r1', text: frame('🤝 Jaja') });
    await doSpine.onRoomMessageEdit({ msgId: 'r1', text: frame('🤝 Jaja, aquí', true) });
    expect(opened).toEqual([{ room: 'A', info: { by: 'don.mo', re: 'HFM.kg', mid: 'M3' } }]);   // re-mirrored into the channel it arrived on
    expect(updates).toContain('🤝 Jaja');
    expect(finished).toBe('🤝 Jaja, aquí');
    await doSpine.onRoomMessage({ route: A, text: frame('🤝 Ja'), msgId: 'r2' });   // re-seen → no 2nd stream
    expect(opened).toHaveLength(1);
  });

  it('a RELAY-RECORD re-addresses a request and forwards it toward the mapped being.node (once)', async () => {
    const sent = [];
    const doSpine = createMeshRelay({
      node: 'do', send: async (r, t) => sent.push({ room: r.room_id, t }),
      resolveRoute: (n) => routeFor('do')[n] ?? null, isLocalBeing: () => false,
      resolveBeingRelay: (b) => (b === 'wren2' ? { being: 'wren', node: 'kg' } : null),
    });
    const req = encodeMesh({ by: 'An', body: 'hi @wren2', from: 'HFM', from_node: 'kg', to: 'wren2.do', mid: 'R1' });
    await doSpine.onRoomMessage({ route: B, text: req, msgId: 'a1' });          // do hosts the wren2 relay-record → re-address to wren.kg
    expect(sent).toHaveLength(1);
    expect(parseMesh(sent[0].t)).toMatchObject({ to: 'wren.kg', from: 'HFM', from_node: 'kg', mid: 'R1', body: 'hi @wren2' });
    await doSpine.onRoomMessage({ route: B, text: req, msgId: 'a2' });          // re-seen → forward-once
    expect(sent).toHaveLength(1);
  });

  it('the ORIGIN mirrors the reply forwarded to it (end of the chain)', async () => {
    const rendered = []; let done = null;
    const kg = createMeshRelay({
      node: 'kg', send: async () => {}, surface: async () => {}, ack: async () => {},
      resolveRoute: (n) => routeFor('kg')[n] ?? null, isLocalBeing: () => false,
      openOriginStream: (_back, info) => { rendered.push(['open', info]); return { update: (b) => rendered.push(b), finish: async (b) => { done = b; } }; },
    });
    await kg.relayOut({ being: 'don', toNode: 'mo', body: '@don hola', origin: { surface: 'whatsapp', chat_id: 'X', name: 'HFM' }, sender: 'An' });
    await kg.onRoomMessage({ route: A, text: encodeMesh({ by: 'don.mo', body: '🤝 Jaja', re: 'HFM.kg', mid: 'M4' }), msgId: 'f1' });
    await kg.onRoomMessageEdit({ msgId: 'f1', text: encodeMesh({ by: 'don.mo', body: '🤝 Jaja, aquí', re: 'HFM.kg', mid: 'M4', done: true }) });
    expect(rendered).toContain('🤝 Jaja');
    expect(done).toBe('🤝 Jaja, aquí');
  });
});

// ── MULTI-HOP REPLY RETURN (the fix, 2026-07-05): a reply must travel back to the ORIGIN
//    node past a transit hop. The transit node that forwarded the request's outbound leg
//    carries the reply back via resolveRoute(originNode) — the room where IT reaches the
//    origin — NOT the reply's own arrival room. The responder answers in ITS room, not the
//    origin's, so reposting into the arrival room dead-ended every reply one hop short. ──
describe('mesh relay — multi-hop reply return', () => {
  const A = { room_id: 'A' }, B = { room_id: 'B' };           // rooms: A = {kg,do}, B = {do,mo}
  const routeFor = (self) => ({                                // next-hop routing table
    kg: { do: A, mo: A }, do: { kg: A, mo: B }, mo: { kg: B, do: B },
  }[self]);

  // A real 3-node chain over 2 rooms driven by the engine. Posts land on an ASYNC bus (a
  // drain queue): delivery is deferred so relayOut returns and arms its `awaiting` entry
  // before any reply comes back — exactly as a real bridge delivers. Each node sees the
  // others' posts (never its own echo). One-shot `done` replies (no relayDispatch) keep it
  // deterministic — what's under test is which ROOM each hop targets, not stream cadence.
  function chain() {
    const relays = {};
    const members = { A: ['kg', 'do'], B: ['do', 'mo'] };
    const queue = [];
    let ids = 0; let origin = null;                            // origin set when kg's mirror resolves
    const roomOf = (r) => (r.room_id === 'A' ? A : B);
    const post = async (route, self, text) => {               // enqueue delivery, return at once (async bus)
      const id = `x${++ids}`;
      for (const n of members[route.room_id]) if (n !== self) queue.push(() => relays[n].onRoomMessage({ route: roomOf(route), text, msgId: id }));
    };
    const drain = async () => { while (queue.length) await queue.shift()(); };
    const mk = (node, { local = [], reply } = {}) => createMeshRelay({
      node, log: () => {},
      resolveRoute: (n) => routeFor(node)[n] ?? null,
      isLocalBeing: (b) => local.includes(b),
      send: async (route, text) => { await post(route, node, text); },
      surface: async () => {},
      runBeing: reply,
      beingEmoji: () => '🤝',
      openOriginStream: (_back, info) => ({ update: () => {}, finish: async (body) => { origin = { by: info.by, body }; } }),
      openRelayStream: (route, info) => ({ update: () => {}, finish: async (body) => { await post(route, node, encodeMesh({ by: info.by, body, re: info.re, mid: info.mid, done: true })); } }),
    });
    relays.kg = mk('kg');
    relays.do = mk('do');
    relays.mo = mk('mo', { local: ['don'], reply: async (_b, p) => `you said ${p}` });
    return { relays, drain, get origin() { return origin; } };
  }

  it('REPRODUCE-FIRST: a reply completes the round trip back to the ORIGIN and resolves its placeholder', async () => {
    const c = chain();
    // kg relays @don.mo — posts the request into room A (its next hop toward mo); do forwards
    // it into room B; mo answers IN room B; do must carry the reply back into room A for kg.
    await c.relays.kg.relayOut({ being: 'don', toNode: 'mo', body: 'hi @don', origin: { chat_id: 'HFM-id', name: 'HFM' }, sender: 'An' });
    await c.drain();                                          // async delivery: request → forward → answer → return-hop → origin
    expect(c.origin).toBeTruthy();                            // kg's origin mirror resolved (FAILS pre-fix: reply died at do)
    expect(c.origin.by).toBe('don.mo');
    expect(c.origin.body).toContain('you said hi');
  });

  it('a transit re-mirrors the reply toward the ORIGIN room (resolveRoute of re:<node>), not the arrival room', async () => {
    const opened = [];
    const doSpine = createMeshRelay({
      node: 'do', send: async () => {}, surface: async () => {},
      resolveRoute: (n) => routeFor('do')[n] ?? null, isLocalBeing: () => false,
      openRelayStream: (route, info) => { opened.push({ room: route.room_id, info }); return { update() {}, finish: async () => {} }; },
    });
    // do FORWARDS the request toward mo: it arrives in room A, is forwarded into room B.
    await doSpine.onRoomMessage({ route: A, text: encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', from_node: 'kg', to: 'don.mo', mid: 'M5' }), msgId: 'q1' });
    // the reply comes back through room B (mo answers in ITS room) → do carries it toward kg = room A.
    await doSpine.onRoomMessage({ route: B, text: encodeMesh({ by: 'don.mo', body: '🤝 hi', re: 'HFM.kg', mid: 'M5' }), msgId: 'r1' });
    expect(opened).toHaveLength(1);
    expect(opened[0].room).toBe('A');                         // toward the ORIGIN (kg), NOT arrival room B (FAILS pre-fix)
    expect(opened[0].info).toMatchObject({ by: 'don.mo', re: 'HFM.kg', mid: 'M5' });
  });

  it('reply-leg forward-once (hop cap): a transit re-mirrors a given reply mid only once', async () => {
    const opened = [];
    const doSpine = createMeshRelay({
      node: 'do', send: async () => {}, surface: async () => {},
      resolveRoute: (n) => routeFor('do')[n] ?? null, isLocalBeing: () => false,
      openRelayStream: (route) => { opened.push(route.room_id); return { update() {}, finish: async () => {} }; },
    });
    await doSpine.onRoomMessage({ route: A, text: encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', from_node: 'kg', to: 'don.mo', mid: 'M7' }), msgId: 'q1' });   // forwards req M7
    await doSpine.onRoomMessage({ route: B, text: encodeMesh({ by: 'don.mo', body: 'a', re: 'HFM.kg', mid: 'M7' }), msgId: 'r1' });   // reply → re-mirror once
    await doSpine.onRoomMessage({ route: B, text: encodeMesh({ by: 'don.mo', body: 'a', re: 'HFM.kg', mid: 'M7' }), msgId: 'r2' });   // a DISTINCT reply msg, same mid → NOT re-mirrored again
    expect(opened).toEqual(['A']);
  });

  it('a node that did NOT forward the request does not re-mirror its reply (no runaway)', async () => {
    const opened = [];
    const mo = createMeshRelay({
      node: 'mo', send: async () => {}, surface: async () => {},
      resolveRoute: (n) => routeFor('mo')[n] ?? null, isLocalBeing: (b) => b === 'don',
      openRelayStream: (route) => { opened.push(route.room_id); return { update() {}, finish: async () => {} }; },
    });
    // mo never forwarded M8's request (a responder owns the being; it doesn't transit) — a
    // reply for M8 is not its to carry, so the return-hop gate (fwdSeen.has(req:mid)) stays shut.
    await mo.onRoomMessage({ route: B, text: encodeMesh({ by: 'don.mo', body: 'x', re: 'HFM.kg', mid: 'M8' }), msgId: 'r1' });
    expect(opened).toHaveLength(0);
  });
});
