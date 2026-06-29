// The real Bridge adapter, unit-tested with a FAKE startBeeperBridge — no Beeper,
// no network (SPINE-REWRITE-PLAN.md Phase 2). Locks the shape translation: real
// onIncoming → port onMessage, and the flipped send/startStream arg order. The
// LIVE echo (the Phase 2 verify gate) is tests-manual/phase2-echo.mjs.
import { describe, it, expect } from 'vitest';
import { createBeeperBridgePort } from '../src/bridges/beeper-port.mjs';

// A fake real-bridge that captures the host callbacks it was constructed with,
// so a test can drive inbound by invoking the captured onIncoming.
function fakeStart() {
  const spy = { captured: null, sent: [], streams: [], stopped: false, alive: true };
  const start = async (opts) => {
    spy.captured = opts;   // { onIncoming, onMessageEdit, onMedia, ...passthrough }
    return {
      async send(text, o) { spy.sent.push({ text, opts: o }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { delivered: false, lastError: null, updates: [], finals: [], init, opts: o };
        h.update = (t) => h.updates.push(t);
        h.finish = (t) => { h.finals.push(t); h.delivered = true; };
        spy.streams.push(h);
        return h;
      },
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
    expect(h.init).toBe('⌛');
    expect(h.opts).toMatchObject({ chatId: '!room' });
    expect(h.updates).toEqual(['partial']);
    expect(h.finals).toEqual(['done']);
    expect(s.delivered).toBe(true);          // reflects the live handle
  });

  it('ENFORCES body_emoji: stamps every streamed edit + final, passes showThink/persona, leaves the 🤔 placeholder clean', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    const s = port.startStream('!room', '🤔', { showThink: true, persona: 'e', bodyEmoji: '🐶' });
    s.update('Aquí');
    s.finish('Aquí estoy');
    const h = spy.streams[0];
    expect(h.init).toBe('🤔');                                    // placeholder unstamped
    expect(h.opts).toMatchObject({ chatId: '!room', showThink: true, persona: 'e' });
    expect(h.updates).toEqual(['🐶 Aquí']);                       // every edit stamped
    expect(h.finals).toEqual(['🐶 Aquí estoy']);
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

  it('isAlive + stop proxy to the real bridge', async () => {
    const { start, spy } = fakeStart();
    const port = await createBeeperBridgePort({}, { start });
    expect(port.isAlive()).toBe(true);
    port.stop();
    expect(spy.stopped).toBe(true);
  });
});
