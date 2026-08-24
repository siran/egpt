// The real Bridge adapter, unit-tested with a FAKE startBeeperBridge — no Beeper,
// no network (plans/2606291226-SPINE-REWRITE-PLAN.md Phase 2). Locks the shape translation: real
// onIncoming → port onMessage, and the flipped send/startStream arg order. The
// LIVE echo (the Phase 2 verify gate) is tests-manual/phase2-echo.mjs.
import { describe, it, expect } from 'vitest';
import { createBeeperBridgePort } from '../src/bridges/beeper-port.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';

// A fake real-bridge that captures the host callbacks it was constructed with,
// so a test can drive inbound by invoking the captured onIncoming.
function fakeStart() {
  const spy = { captured: null, sent: [], streams: [], statusPosts: [], statusEdits: [], statusDeletes: [], media: [], stopped: false, alive: true };
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
      sendMedia(chatId, filePath, o) { spy.media.push({ chatId, filePath, caption: o?.caption ?? null }); return true; },
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
    s.finish('Aquí estoy bien');                                  // sender supplies the completed reply — NO inline end-marker
    const h = spy.streams[0];
    expect(h.init).toBe('🐶 egpt\n⏳');                            // persona header line + placeholder, no nonce suffix
    expect(h.opts).toMatchObject({ chatId: '!room', persona: 'e', replyToMessageID: 'm7' });
    expect(h.updates).toEqual(['🐶 egpt\nAquí estoy ⏳', '🐶 egpt\nAquí estoy bien ⏳']);   // header on every frame; "egpt:" stripped
    expect(h.finals).toEqual(['🐶 egpt\nAquí estoy bien']);
  });

  it('exposes NO delete limb — a being never removes a message', async () => {
    // operator 2026-08-24: there is no use case for deletion.
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    const s2 = port.startStream('!room', '⏳', { persona: 'e', bodyEmoji: '🐶', label: 'egpt' });
    expect(s2.delete).toBeUndefined();
    expect(spy.streams[0].deleted).toBe(false);
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

  // (The port-level flood guard was removed with the guard unification —
  // plans/260722-COMMAND-SURFACE-ROADMAP.md phase 3. The single turn-counter guard at the
  // spine chokepoint is the whole loop-breaker now; its coverage lives in
  // tests/stop-guard.test.mjs + tests/guard-provenance.test.mjs.)

  it('isAlive + stop proxy to the real bridge', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    expect(port.isAlive()).toBe(true);
    port.stop();
    expect(spy.stopped).toBe(true);
  });
});

// Layered signatures (operator 2026-07-12) — the persona reply wraps [bridge, agent] concentrically
// around the stamped core (🐶 egpt\n<reply>). bridge_signature_open/close are per-NODE (port construction);
// agent_signature_open/close are per-AGENT, resolved by the sender and delivered in the send/stream opts
// (agentSigOpen/agentSigClose). Order top→bottom: bridge_open, agent_open, CORE, agent_close, bridge_close.
// The core carries NO inline end-marker (the historical ∎ / signature was removed 2026-07-12); the agent
// close is now the sole agent-side end line. Applied ONLY on a full persona header (bodyEmoji + label) —
// NEVER on mode:auto plain posts. The 👂 echo layers live one layer down (beeper.mjs); this layer forwards
// bridge_* + transcription_* onward.
describe('beeper-port adapter — layered signatures (bridge + agent wrap)', () => {
  it('a streamed persona reply renders CONCENTRIC (bridge_open, agent_open, CORE, agent_close, bridge_close) on EVERY frame', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '💸' }, { start });
    const s = port.startStream('!room', '⏳', { persona: 'e', bodyEmoji: '🐶', label: 'egpt', replyTo: 'm7', agentSigOpen: '— e —', agentSigClose: '~ e' });
    s.update('Hola ⏳');
    s.finish('Hola mundo');                                      // sender supplies the completed reply — NO inline end-marker
    const h = spy.streams[0];
    // WAS: "placeholder/updates stay un-wrapped … sigs appear once, at the end". C13 (operator
    // 2026-07-26) reversed that — a live frame is a message on a surface, so it signs. Id
    // resolution is unaffected: beeper.mjs matches on the exact bytes it posted.
    expect(h.init).toBe('🌉kg\n— e —\n🐶 egpt\n⏳\n~ e\n💸');    // placeholder: FULL wrap
    expect(h.updates).toEqual(['🌉kg\n— e —\n🐶 egpt\nHola ⏳\n~ e\n💸']);   // intermediate frame: FULL wrap
    // FINAL: outer bridge_open, inner agent_open, the stamped core, inner agent_close, outer bridge_close
    expect(h.finals).toEqual(['🌉kg\n— e —\n🐶 egpt\nHola mundo\n~ e\n💸']);
    expect(h.finals[0].startsWith('🌉kg')).toBe(true);
    expect(h.finals[0].endsWith('\n💸')).toBe(true);
  });

  it('each slot works alone — only agent_open+agent_close set (bridge empty) wraps just the inner layer', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });   // no bridge_* → outer layer invisible
    const s = port.startStream('!room', '⏳', { bodyEmoji: '🐶', label: 'egpt', agentSigOpen: 'A_open', agentSigClose: 'A_close' });
    s.finish('Hola');
    expect(spy.streams[0].finals).toEqual(['A_open\n🐶 egpt\nHola\nA_close']);   // agent layer only, concentric around the core
  });

  it('only bridge_open+bridge_close set (agent empty) wraps just the outer layer', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ bridgeSignatureOpen: 'B_open', bridgeSignatureClose: 'B_close' }, { start });
    const s = port.startStream('!room', '⏳', { bodyEmoji: '🐶', label: 'egpt' });   // no agentSig* → inner layer invisible
    s.finish('Hola');
    expect(spy.streams[0].finals).toEqual(['B_open\n🐶 egpt\nHola\nB_close']);
  });

  it('the §7 fallback send of a persona reply carries the same concentric wrap', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸' }, { start });
    await port.send('!room', 'reply', { bodyEmoji: '🐶', label: 'egpt', replyTo: 'm1', agentSigOpen: 'A_open', agentSigClose: 'A_close' });
    expect(spy.sent[0].text).toBe('🌉\nA_open\n🐶 egpt\nreply\nA_close\n💸');
  });

  // WAS "mode:auto plain posts get NO layers". Operator 2026-07-25: "all messages coming out from a
  // spine to any surface are signed. period." — the bridge layer says WHICH SPINE posted, which is
  // true of a plain post too, so it no longer waits for a persona stamp. ⚠️ mode:auto is E writing
  // AS the operator (src/spine/sender.mjs `auto`): it now carries the node signature like every
  // other send — flagged to the operator as the one case that may want to stay bare.
  it('a plain/auto post is SIGNED too — unstamped (nothing to stamp) but carrying the node bridge layer', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸' }, { start });
    await port.send('!room', 'Hey, all good', {});   // auto branch: no bodyEmoji/label passed
    expect(spy.sent[0].text).toBe('🌉\nHey, all good\n💸');
  });

  // C12 (HANDOFF 2026-07-26). postStatus was the ONE outbound in this port that never met the
  // wrap. Its two callers are the mesh ORIGIN placeholder and — the reason this matters — the
  // advice-channel post (src/spine/advice.mjs `ask`), a real, terminal message to a real chat:
  // E's "❓ eGPT needs advice" landed with no node signature on a two-node account, so the
  // operator could not tell WHICH spine was asking. "All messages coming out from a spine to any
  // surface are signed. period." — same wrap, no second stamping site.
  it('REPRODUCE-FIRST: postStatus is SIGNED — the advice post carries the node bridge layer', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸' }, { start });
    const text = '❓ eGPT needs advice — «Bea» (whatsapp):\nconfirm the Friday move?';
    const id = await port.postStatus('!advice', text);
    expect(spy.statusPosts[0]).toEqual({ text: `🌉\n${text}\n💸`, chatId: '!advice' });
    expect(id).toBe('id-1');                       // the CONFIRMED id advice.ask routes answers on
  });

  // A mesh envelope rides bridge.send too (mesh.mjs `send`/relayDispatch fallback) — but it is
  // spine→spine TRANSPORT, and a signature below the provenance tail would make parseMesh stop
  // recognising it. The port must post it verbatim.
  it('a mesh ENVELOPE is posted verbatim — transport is never signed', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸' }, { start });
    const env = encodeMesh({ by: 'An', body: '@don hola', from: 'HFM', from_node: 'kg', to: 'don.do' });
    await port.send('!room', env, {});
    expect(spy.sent[0].text).toBe(env);
    expect(parseMesh(spy.sent[0].text)).toMatchObject({ to: 'don.do' });
  });

  it('with ALL slots empty (default), a streamed persona reply is BYTE-IDENTICAL to today (regression lock)', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });   // no bridge_*, no agentSig*
    const s = port.startStream('!room', '⏳', { bodyEmoji: '🐶', label: 'egpt' });
    s.finish('Hola');
    expect(spy.streams[0].finals).toEqual(['🐶 egpt\nHola']);   // exactly today's output — bare core, no end-marker
  });

  // C13 (operator 2026-07-26): "how is that that dolly posted without signing? bridge must sign.
  // always. structurally." — and, on the placeholder specifically: "it should also sign
  // 'thinking... 💸|🌉'". LIVE EVIDENCE from a real transcript: a PEER node's frames arrived BARE
  // for the whole life of the stream —
  //     🤝 don
  //     ⏳ Thinking…                     ← the placeholder, no 💸
  //     🤝 don
  //     30 años ya — ⏳                  ← every intermediate edit, no 💸
  // and only the SETTLED frame ended "… 💸". The placeholder and every edit are REAL messages,
  // visible to (and ingested by) the co-account node for the entire duration of the turn, so
  // "a bridge always signs" was false for all of it. THREE unsigned sites lived in startStream:
  // the placeholder (`stamp(init)`) and every `update` (`stamp(t)`); only `finish` met the wrap.
  it('REPRODUCE-FIRST: placeholder → N updates → finish — EVERY frame carries the node signature, exactly once', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '💸' }, { start });
    const s = port.startStream('!room', '⏳ Thinking…', { persona: 'don', bodyEmoji: '🤝', label: 'don', agentSigOpen: '— e —', agentSigClose: '~ e' });
    s.update('30 años ⏳');
    s.update('30 años ya — ⏳');
    s.finish('30 años ya — y aquí seguimos');
    const h = spy.streams[0];

    // the placeholder is a real posted message → signed
    expect(h.init).toBe('🌉kg\n— e —\n🤝 don\n⏳ Thinking…\n~ e\n💸');
    // every intermediate edit → signed
    expect(h.updates).toEqual([
      '🌉kg\n— e —\n🤝 don\n30 años ⏳\n~ e\n💸',
      '🌉kg\n— e —\n🤝 don\n30 años ya — ⏳\n~ e\n💸',
    ]);
    // the settled reply is BYTE-IDENTICAL to what finish produced before this change
    expect(h.finals).toEqual(['🌉kg\n— e —\n🤝 don\n30 años ya — y aquí seguimos\n~ e\n💸']);
    // NO ACCUMULATION: a frame EDITS a message that already carries the signature — each frame is
    // built from the raw core, so every one of them carries exactly one open and one close.
    const count = (s2, needle) => s2.split(needle).length - 1;
    for (const frame of [h.init, ...h.updates, ...h.finals]) {
      expect(count(frame, '🌉kg')).toBe(1);
      expect(count(frame, '💸')).toBe(1);
      expect(count(frame, '🤝 don')).toBe(1);
    }
  });

  // The mesh's RESPONDER streams ENVELOPES (mesh.mjs relayDispatch: init + every update are
  // encodeMesh output). parseMesh trusts the TRAILING run of provenance lines, so a close line
  // appended below the tail makes the envelope unrecognisable and the mesh goes deaf. Signing
  // every frame must NOT reach transport.
  it('a streamed mesh ENVELOPE stays unsigned on EVERY frame — placeholder, update and final', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸' }, { start });
    const env = (body, done) => encodeMesh({ by: 'don.do', body, re: 'HFM.kg', post_id: 'p1', done });
    const s = port.startStream('!relay', env('🤔', false), {});
    s.update(env('🤝 don\nYep', false));
    s.finish(env('🤝 don\nYep, still here', true));
    const h = spy.streams[0];
    for (const frame of [h.init, ...h.updates, ...h.finals]) {
      expect(frame.includes('💸')).toBe(false);
      expect(parseMesh(frame)).toMatchObject({ by: 'don.do' });
    }
  });

  // The remaining outbound text surfaces of this port. sendMedia's caption is E speaking (a real
  // committed message with a persona stamp on it); editOwn REPLACES the text of a message that was
  // signed when it was sent; editStatus replaces the text of a postStatus line that IS signed. All
  // three stamped but never wrapped → an unsigned frame out of a spine.
  it('sendMedia caption, editOwn and editStatus are signed too', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({ bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸' }, { start });
    await port.sendMedia('!room', '/tmp/a.png', { caption: 'mira esto', bodyEmoji: '🐶', label: 'egpt' });
    await port.editOwn('!room', 'm1', 'corregido', { bodyEmoji: '🐶', label: 'egpt' });
    await port.editStatus('!room', 'm2', '📨 … ✅');
    expect(spy.media[0].caption).toBe('🌉\n🐶 egpt\nmira esto\n💸');
    expect(spy.statusEdits).toEqual([
      { chatId: '!room', msgId: 'm1', text: '🌉\n🐶 egpt\ncorregido\n💸' },
      { chatId: '!room', msgId: 'm2', text: '🌉\n📨 … ✅\n💸' },
    ]);
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
