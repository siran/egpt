// The real Bridge adapter, unit-tested with a FAKE startBeeperBridge — no Beeper,
// no network (SPINE-REWRITE-PLAN.md Phase 2). Locks the shape translation: real
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
    expect(h.init).toBe('⌛');                        // fixed placeholder, posted as-is
    expect(h.opts).toMatchObject({ chatId: '!room' });
    expect(h.updates).toEqual(['partial']);          // markers are the sender's job — port only stamps
    expect(h.finals).toEqual(['done']);
    expect(s.delivered).toBe(true);          // reflects the live handle
  });

  it('B reply stream: body_emoji stamped on every frame (markers owned by sender), replies-to', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    const s = port.startStream('!room', '⏳', { persona: 'e', bodyEmoji: '🐶', replyTo: 'm7' });
    s.update('Aquí estoy ⏳');                                     // sender supplies the ⏳ marker
    s.finish('Aquí estoy bien ∎');                                // sender supplies the ∎ end-mark
    const h = spy.streams[0];
    expect(h.init).toBe('⏳');                                     // fixed placeholder, posted as-is
    expect(h.opts).toMatchObject({ chatId: '!room', persona: 'e', replyToMessageID: 'm7' });
    expect(h.updates).toEqual(['🐶 Aquí estoy ⏳']);               // every frame body_emoji-stamped
    expect(h.finals).toEqual(['🐶 Aquí estoy bien ∎']);
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
