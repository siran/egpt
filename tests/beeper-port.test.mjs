// The real Bridge adapter, unit-tested with a FAKE startBeeperBridge — no Beeper,
// no network (plans/2606291226-SPINE-REWRITE-PLAN.md Phase 2). Locks the shape translation: real
// onIncoming → port onMessage, and the flipped send/startStream arg order. The
// LIVE echo (the Phase 2 verify gate) is tests-manual/phase2-echo.mjs.
import { describe, it, expect } from 'vitest';
import { createBeeperBridgePort } from '../src/bridges/beeper-port.mjs';

// A fake real-bridge that captures the host callbacks it was constructed with,
// so a test can drive inbound by invoking the captured onIncoming.
function fakeStart() {
  const spy = { captured: null, sent: [], streams: [], statusPosts: [], statusEdits: [], statusDeletes: [], stopped: false, alive: true };
  const start = async (opts) => {
    spy.captured = opts;   // { onIncoming, onMessageEdit, onMedia, ...passthrough }
    return {
      async send(text, o) { spy.sent.push({ text, opts: o }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { delivered: false, lastError: null, deleted: false, updates: [], finals: [], init, opts: o };
        h.update = (t) => h.updates.push(t);
        h.finish = (t) => { h.finals.push(t); h.delivered = true; };
        h.delete = () => { h.deleted = true; };
        spy.streams.push(h);
        return h;
      },
      async sendAndGetId(text, o) { const id = `id-${spy.statusPosts.length + 1}`; spy.statusPosts.push({ text, chatId: o?.chatId }); return id; },
      editMessage(chatId, msgId, text) { spy.statusEdits.push({ chatId, msgId, text }); },
      deleteMessage(chatId, msgId) { spy.statusDeletes.push({ chatId, msgId }); },
      isAlive: () => spy.alive,
      stop: () => { spy.stopped = true; },
    };
  };
  return { start, spy };
}

describe('beeper-port adapter', () => {
  it('forwards passthrough opts but OWNS the three host callbacks', async () => {
    const { start, spy } = fakeStart();
    await createBeeperBridgePort({ beeperToken: 'tok', networks: ['whatsapp'] }, { start });
    expect(spy.captured.beeperToken).toBe('tok');
    expect(spy.captured.networks).toEqual(['whatsapp']);
    expect(typeof spy.captured.onIncoming).toBe('function');
    expect(typeof spy.captured.onMessageEdit).toBe('function');
    expect(typeof spy.captured.onMedia).toBe('function');
  });

  it('real onIncoming(body, from) → port onMessage({ body, from })', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    const got = [];
    port.onMessage((m) => got.push(m));

    await spy.captured.onIncoming('hola', { chatId: '!room', senderName: 'An' });
    expect(got).toEqual([{ body: 'hola', from: { chatId: '!room', senderName: 'An' } }]);
  });

  it('drops an inbound that arrives before onMessage is registered (no throw)', async () => {
    const { start, spy } = fakeStart();
    await createBeeperBridgePort({}, { start });
    await expect(spy.captured.onIncoming('early', { chatId: '!room' })).resolves.toBeUndefined();
  });

  it('port send(chat, text) → real send(text, { chatId: chat }) — arg order flips', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    await port.send('!room', 'echo back');
    expect(spy.sent).toEqual([{ text: 'echo back', opts: { chatId: '!room', replyToMessageID: null } }]);
  });

  it('startStream wraps the real handle: update/finish proxy, delivered/lastError pass through', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    const s = port.startStream('!room', '⌛');
    expect(s.delivered).toBe(false);
    s.update('partial');
    s.finish('done');
    const h = spy.streams[0];
    expect(h.init).toBe('⌛');                        // placeholder is exactly the stamped init — no nonce suffix
    expect(h.opts).toMatchObject({ chatId: '!room' });
    expect(h.updates).toEqual(['partial']);          // markers are the sender's job — port only stamps
    expect(h.finals).toEqual(['done']);
    expect(s.delivered).toBe(true);          // reflects the live handle
  });

  it('B reply stream: enforces the "🐶 egpt" persona header line on every frame + strips a model self-label, replies-to', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    const s = port.startStream('!room', '⏳', { persona: 'e', bodyEmoji: '🐶', label: 'egpt', replyTo: 'm7' });
    s.update('Aquí estoy ⏳');                                     // sender supplies the ⏳ marker
    s.update('egpt: Aquí estoy bien ⏳');                          // model wrote "egpt:" → bridge strips it
    s.finish('Aquí estoy bien ∎');                                // sender supplies the ∎ end-mark
    const h = spy.streams[0];
    expect(h.init).toBe('🐶 egpt\n⏳');                            // persona header line + placeholder, no nonce suffix
    expect(h.opts).toMatchObject({ chatId: '!room', persona: 'e', replyToMessageID: 'm7' });
    expect(h.updates).toEqual(['🐶 egpt\nAquí estoy ⏳', '🐶 egpt\nAquí estoy bien ⏳']);   // header on every frame; "egpt:" stripped
    expect(h.finals).toEqual(['🐶 egpt\nAquí estoy bien ∎']);
  });

  it('stream.delete proxies to the real handle (tearing down a withheld reply)', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    const s = port.startStream('!room', '⏳');
    await s.delete();
    expect(spy.streams[0].deleted).toBe(true);
  });

  it('A status: postStatus posts + returns id; editStatus edits; deleteStatus deletes', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    const id = await port.postStatus('!room', '📨 Sending to E...');
    await port.editStatus('!room', id, '📨 Sending to E... ✅');
    await port.deleteStatus('!room', id);
    expect(spy.statusPosts).toContainEqual({ text: '📨 Sending to E...', chatId: '!room' });
    expect(spy.statusEdits).toContainEqual({ chatId: '!room', msgId: id, text: '📨 Sending to E... ✅' });
    expect(spy.statusDeletes).toContainEqual({ chatId: '!room', msgId: id });
  });

  it('ENFORCES body_emoji on a one-shot send too', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    await port.send('!room', 'hola', { bodyEmoji: '🐶' });
    expect(spy.sent).toEqual([{ text: '🐶 hola', opts: { chatId: '!room', replyToMessageID: null } }]);
  });

  it('threads replyTo → replyToMessageID on both stream + send (mention reply quotes the message)', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    port.startStream('!room', '🤔', { replyTo: 'm7' });
    await port.send('!room', 'hi', { replyTo: 'm7' });
    expect(spy.streams[0].opts.replyToMessageID).toBe('m7');
    expect(spy.sent[0].opts.replyToMessageID).toBe('m7');
  });

  it('onEdit verdict flows back to the bridge; default is false when unwired', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    expect(await spy.captured.onMessageEdit('!room', 'm1', 'new', 'old')).toBe(false);
    port.onEdit(() => true);
    expect(await spy.captured.onMessageEdit('!room', 'm1', 'new', 'old')).toBe(true);
  });

  it('flood guard: blocks sends to a chat once it exceeds the limit within the window', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ flood: { limit: 3, window_ms: 10000 } }, { start });
    for (let i = 0; i < 3; i++) await port.send('!room', `m${i}`);
    const r = await port.send('!room', 'over');            // 4th within the window → over limit
    expect(r).toEqual({ blocked: true });
    expect(spy.sent).toHaveLength(3);                       // only the first 3 reached the transport
  });

  it('flood guard: a paused chat gets an inert stream handle (a reply loop can’t open new streams)', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ flood: { limit: 2, window_ms: 10000 } }, { start });
    await port.send('!room', 'a'); await port.send('!room', 'b');   // at the limit
    const s = port.startStream('!room', '⏳');                       // over → inert handle
    expect(s.delivered).toBe(false);
    s.update('x'); s.finish('y');
    expect(spy.streams).toHaveLength(0);                             // no real stream opened
  });

  it('isAlive + stop proxy to the real bridge', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    expect(port.isAlive()).toBe(true);
    port.stop();
    expect(spy.stopped).toBe(true);
  });
});

// Layered signatures (operator 2026-07-12) — the persona reply wraps [bridge, agent] concentrically
// around the stamped core (🐶 egpt\n… ∎). bridge_signature_open/close are per-NODE (port construction);
// agent_signature_open/close are per-AGENT, resolved by the sender and delivered in the send/stream opts
// (agentSigOpen/agentSigClose). Order top→bottom: bridge_open, agent_open, CORE, agent_close, bridge_close.
// The ∎ stays INSIDE the core (sender-supplied); these are ADDITIONAL wrapper lines. Applied ONLY on a
// full persona header (bodyEmoji + label) — NEVER on mode:auto plain posts. The 👂 echo layers live one
// layer down (beeper.mjs); this layer forwards bridge_* + transcription_* onward.
describe('beeper-port adapter — layered signatures (bridge + agent wrap)', () => {
  it('a streamed persona reply renders CONCENTRIC (bridge_open, agent_open, CORE, agent_close, bridge_close); placeholder/updates stay un-wrapped', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '💸' }, { start });
    const s = port.startStream('!room', '⏳', { persona: 'e', bodyEmoji: '🐶', label: 'egpt', replyTo: 'm7', agentSigOpen: '— e —', agentSigClose: '~ e' });
    s.update('Hola ⏳');
    s.finish('Hola mundo ∎');                                    // sender supplies the ∎ end-mark (inside the core)
    const h = spy.streams[0];
    expect(h.init).toBe('🐶 egpt\n⏳');                          // placeholder: bare stamp, NO wrap (id resolution matches this)
    expect(h.updates).toEqual(['🐶 egpt\nHola ⏳']);             // intermediate frame: NO wrap (sigs appear once, at the end)
    // FINAL: outer bridge_open, inner agent_open, the stamped core (with ∎ inline), inner agent_close, outer bridge_close
    expect(h.finals).toEqual(['🌉kg\n— e —\n🐶 egpt\nHola mundo ∎\n~ e\n💸']);
    expect(h.finals[0].startsWith('🌉kg')).toBe(true);
    expect(h.finals[0].endsWith('\n💸')).toBe(true);
  });

  it('each slot works alone — only agent_open+agent_close set (bridge empty) wraps just the inner layer', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });   // no bridge_* → outer layer invisible
    const s = port.startStream('!room', '⏳', { bodyEmoji: '🐶', label: 'egpt', agentSigOpen: 'A_open', agentSigClose: 'A_close' });
    s.finish('Hola ∎');
    expect(spy.streams[0].finals).toEqual(['A_open\n🐶 egpt\nHola ∎\nA_close']);   // agent layer only, concentric around the core
  });

  it('only bridge_open+bridge_close set (agent empty) wraps just the outer layer', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ bridgeSignatureOpen: 'B_open', bridgeSignatureClose: 'B_close' }, { start });
    const s = port.startStream('!room', '⏳', { bodyEmoji: '🐶', label: 'egpt' });   // no agentSig* → inner layer invisible
    s.finish('Hola ∎');
    expect(spy.streams[0].finals).toEqual(['B_open\n🐶 egpt\nHola ∎\nB_close']);
  });

  it('the §7 fallback send of a persona reply carries the same concentric wrap', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸' }, { start });
    await port.send('!room', 'reply ∎', { bodyEmoji: '🐶', label: 'egpt', replyTo: 'm1', agentSigOpen: 'A_open', agentSigClose: 'A_close' });
    expect(spy.sent[0].text).toBe('🌉\nA_open\n🐶 egpt\nreply ∎\nA_close\n💸');
  });

  it('mode:auto plain posts get NO layers — no persona stamp → no wrap', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸' }, { start });
    await port.send('!room', 'Hey, all good', {});   // auto branch: no bodyEmoji/label passed
    expect(spy.sent[0].text).toBe('Hey, all good');   // unstamped → nothing added
  });

  it('with ALL slots empty (default), a streamed persona reply is BYTE-IDENTICAL to today (regression lock)', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });   // no bridge_*, no agentSig*
    const s = port.startStream('!room', '⏳', { bodyEmoji: '🐶', label: 'egpt' });
    s.finish('Hola ∎');
    expect(spy.streams[0].finals).toEqual(['🐶 egpt\nHola ∎']);   // exactly today's output
  });

  it('forwards bridge_* + transcription_* through to startBeeperBridge (the 👂 echo layers are applied there)', async () => {
    const { start, spy } = fakeStart();
    await createBeeperBridgePort({ bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸', transcriptionOpen: 'T_open', transcriptionClose: 'T_close' }, { start });
    expect(spy.captured.bridgeSignatureOpen).toBe('🌉');
    expect(spy.captured.bridgeSignatureClose).toBe('💸');
    expect(spy.captured.transcriptionOpen).toBe('T_open');    // reaches beeper.mjs for the 👂 echo wrap
    expect(spy.captured.transcriptionClose).toBe('T_close');
  });
});
