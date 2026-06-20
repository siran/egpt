import { describe, it, expect } from 'vitest';
import { createMeshRelay, encodeMesh, parseMesh, mentionedBeing } from '../src/mesh/relay.mjs';

// A shared relay channel (the 1:1) observed by both spines, plus captures of what
// each surfaced home and acked. No network — just visible text.
function harness({ donReply = async () => 'yes, here', emojis = { don: '🤝' } } = {}) {
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
    beingEmoji: (b) => emojis[b] || '',
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
    const p = parseMesh(encodeMesh({ by: 'don.do', body, re: 'HFM', emoji: '🤝', done: true }));
    expect(p.body).toBe(body);
  });

  it('legacy un-encoded messages (no enc tag) still parse raw — backward compatible', () => {
    expect(parseMesh('```\nhi @don\n\n---\nfrom: HFM\nby: An\n```'))
      .toMatchObject({ body: 'hi @don', from: 'HFM', by: 'An' });
  });

  it('carries a being emoji in the provenance and round-trips it (body stays clean)', () => {
    const w = encodeMesh({ by: 'don.do', body: 'Jaja, me pillaste', re: 'HFM', emoji: '🤝' });
    expect(w).toMatch(/\nemoji: 🤝\n/);
    const p = parseMesh(w);
    expect(p.body).toBe('Jaja, me pillaste');     // emoji stays in provenance, not baked into body
    expect(p).toMatchObject({ by: 'don.do', re: 'HFM', emoji: '🤝' });
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
    expect(h.channel[0]).toMatch(/to: do/);        // routing tail readable
    expect(parseMesh(h.channel[0])).toMatchObject({ body: 'hi @don', to: 'do' });   // decodes back
    expect(h.channel[0]).not.toMatch(/egpt-mesh/);
    // honest ack on the origin (NOT a faked "thinking")
    expect(h.acks.kg[0].text).toMatch(/relayed to don\.do — waiting/);
    expect(h.acks.kg[0].text).not.toMatch(/thinking/i);

    // both observe; only `do` owns don → it runs (mention stripped) and replies,
    // stamping its OWN body_emoji into the provenance so the relayer can identify it
    await h.deliver(h.channel[0]);
    expect(h.channel).toHaveLength(2);
    expect(parseMesh(h.channel[1])).toMatchObject({ by: 'don.do', re: 'HFM', body: 'you said: hi', emoji: '🤝' });

    // both observe the reply; kg correlates via re:HFM and surfaces home — WITH the
    // being's identity (by + emoji) so it can't read as the operator's own typing
    await h.deliver(h.channel[1]);
    expect(h.surfaced.kg).toEqual([
      { origin: { chat_id: 'HFM-id', name: 'HFM' }, text: 'you said: hi', info: { by: 'don.do', emoji: '🤝' } },
    ]);
    expect(h.surfaced.do).toHaveLength(0);
  });

  it('a relayed reply surfaces home identified by the being (emoji + by), never bare', async () => {
    const h = harness({ donReply: async () => 'Jaja, me pillaste' });
    await h.kg.relayOut({ being: 'don', toNode: 'do', body: 'hi @don', origin: { chat_id: 'HFM-id', name: 'HFM' }, sender: 'An' });
    await h.deliver(h.channel[h.channel.length - 1]);    // do answers, stamps 🤝
    await h.deliver(h.channel[h.channel.length - 1]);    // kg surfaces home
    const s = h.surfaced.kg.at(-1);
    expect(s.text).toBe('Jaja, me pillaste');             // body itself stays clean (no emoji baked in)
    expect(s.info).toMatchObject({ by: 'don.do', emoji: '🤝' });   // identity rides alongside → surfacer stamps it
  });

  it('answers "no <being>.<node> here" — never silence — when the peer lacks it', async () => {
    const h = harness();
    await h.do.onRoomMessage({ route: h.route, text: encodeMesh({ by: 'An', body: 'hi @ghost', from: 'HFM', to: 'do' }) });
    expect(h.channel).toHaveLength(1);
    expect(parseMesh(h.channel[0])).toMatchObject({ by: 'ghost.do', body: 'no ghost.do here' });
  });

  it('never re-relays mesh traffic (a provenance-tailed message is consumed)', async () => {
    const h = harness();
    // kg is not the target node (to: do) → consume, no re-relay, no "not here"
    const consumed = await h.kg.onRoomMessage({ route: h.route, text: encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', to: 'do' }) });
    expect(consumed).toBe(true);
    expect(h.channel).toHaveLength(0);
  });

  it('the relayer ignores its own request echo (no false "not here")', async () => {
    const h = harness();
    await h.kg.relayOut({ being: 'don', toNode: 'do', body: 'hi @don', origin: { chat_id: 'HFM-id', name: 'HFM' }, sender: 'An' });
    h.channel.length = 0;
    await h.kg.onRoomMessage({ route: h.route, text: encodeMesh({ by: 'An', body: 'hi @don', from: 'HFM', to: 'do' }) });
    expect(h.channel).toHaveLength(0);  // to: do != kg → stays quiet (no false "not here")
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
      await relay.onRoomMessage({ route: { room_id: 'C' }, text: encodeMesh({ by: 'An', body: `hi @don ${i}`, from: 'HFM', to: 'do' }) });
    }
    expect(sends.length).toBeLessThanOrEqual(5);   // 20 requests, but the breaker halts the flood
  });

  // ── STREAMING (An 2026-06-20): a relayed reply streams via edits — the responder
  //    edit-streams into the relay room, the origin mirrors onto the origin chat. ──
  it('done round-trips and is omitted when false', () => {
    expect(encodeMesh({ by: 'don.do', body: 'x', re: 'HFM', done: true })).toMatch(/\ndone: true\n/);
    expect(encodeMesh({ by: 'don.do', body: 'x', re: 'HFM' })).not.toMatch(/\bdone:/);
    expect(parseMesh(encodeMesh({ by: 'don.do', body: 'x', re: 'HFM', done: true })).done).toBe(true);
    expect(parseMesh(encodeMesh({ by: 'don.do', body: 'x', re: 'HFM' })).done).toBe(false);
  });

  it('RESPONDER hands the prompt to the NORMAL dispatch (relayDispatch) — does not run the being itself', async () => {
    let dispatched = null; let ranBeing = false;
    const doSpine = createMeshRelay({
      node: 'do', send: async () => {}, surface: async () => {},
      runBeing: async () => { ranBeing = true; return 'should not run'; },
      beingEmoji: () => '🤝', resolveRoute: () => ({ room_id: 'C' }), isLocalBeing: (b) => b === 'don',
      relayDispatch: async (d) => { dispatched = d; },
    });
    await doSpine.onRoomMessage({ route: { room_id: 'C' }, text: encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', to: 'do' }), msgId: 'm1' });
    expect(ranBeing).toBe(false);                                                 // routed, not run locally
    expect(dispatched).toMatchObject({ being: 'don', prompt: 'hola', re: 'HFM', by: 'don.do', emoji: '🤝' });
    expect(dispatched.route).toMatchObject({ room_id: 'C' });
  });

  it('RESPONDER falls back to one-shot runBeing when no relayDispatch is wired', async () => {
    const sent = [];
    const doSpine = createMeshRelay({
      node: 'do', send: async (_r, t) => sent.push(t), surface: async () => {},
      runBeing: async () => 'Jaja, aquí', beingEmoji: () => '🤝',
      resolveRoute: () => ({ room_id: 'C' }), isLocalBeing: (b) => b === 'don',
    });
    await doSpine.onRoomMessage({ route: { room_id: 'C' }, text: encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', to: 'do' }), msgId: 'm1' });
    expect(parseMesh(sent[sent.length - 1])).toMatchObject({ by: 'don.do', body: 'Jaja, aquí', re: 'HFM', emoji: '🤝', done: true });
  });

  it('ORIGIN mirrors a streamed reply: first frame opens a stream, edits update it, done finalizes', async () => {
    const updates = []; let finished = null; const oneShot = [];
    const kg = createMeshRelay({
      node: 'kg', send: async () => {}, surface: async (_o, t) => oneShot.push(t), ack: async () => {},
      runBeing: async () => '', resolveRoute: () => ({ room_id: 'C' }), isLocalBeing: () => false,
      openOriginStream: (_returnTo, info) => { updates.push({ open: info }); return { update: (b) => updates.push(b), finish: async (b) => { finished = b; } }; },
    });
    await kg.relayOut({ being: 'don', toNode: 'do', body: '@don hola', origin: { surface: 'whatsapp', chat_id: 'X', name: 'HFM' }, sender: 'An' });
    await kg.onRoomMessage({ route: { room_id: 'C' }, text: encodeMesh({ by: 'don.do', body: '🤔', re: 'HFM', emoji: '🤝' }), msgId: 'r1' });
    await kg.onRoomMessageEdit({ msgId: 'r1', text: encodeMesh({ by: 'don.do', body: 'Jaja', re: 'HFM', emoji: '🤝' }) });
    await kg.onRoomMessageEdit({ msgId: 'r1', text: encodeMesh({ by: 'don.do', body: 'Jaja, aquí', re: 'HFM', emoji: '🤝', done: true }) });
    expect(updates[0].open).toMatchObject({ by: 'don.do', emoji: '🤝' });        // stream opened with the being's identity
    expect(updates).toContain('🤔');
    expect(updates).toContain('Jaja');
    expect(finished).toBe('Jaja, aquí');                                          // done frame finalized
    expect(oneShot).toHaveLength(0);                                             // streamed, never one-shot surfaced
  });

  it('ORIGIN one-shots (pre-streaming behavior) with no stream primitive, or a first frame already done', async () => {
    const surfaced = [];
    const kg = createMeshRelay({
      node: 'kg', send: async () => {}, surface: async (_o, t) => surfaced.push(t), ack: async () => {},
      runBeing: async () => '', resolveRoute: () => ({ room_id: 'C' }), isLocalBeing: () => false,
    });
    await kg.relayOut({ being: 'don', toNode: 'do', body: '@don hola', origin: { surface: 'whatsapp', chat_id: 'X', name: 'HFM' }, sender: 'An' });
    await kg.onRoomMessage({ route: { room_id: 'C' }, text: encodeMesh({ by: 'don.do', body: 'final', re: 'HFM', emoji: '🤝', done: true }), msgId: 'r1' });
    expect(surfaced).toEqual(['final']);
  });

  it('onRoomMessageEdit ignores an edit for a message it is not streaming (returns false → bridge handles it)', async () => {
    const kg = createMeshRelay({ node: 'kg', send: async () => {}, surface: async () => {}, resolveRoute: () => ({ room_id: 'C' }), isLocalBeing: () => false });
    expect(await kg.onRoomMessageEdit({ msgId: 'unknown', text: 'whatever' })).toBe(false);
  });
});
