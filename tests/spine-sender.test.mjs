// The single-message reply train (operator 2026-06-30): one bridge message, opened
// eagerly as the knee-jerk placeholder (so its id resolves during spin-up — no
// mid-stream stutter), edited into the streamed answer ending with ∎. body_emoji
// stamping is the bridge/port's job (locked in beeper-port.test); here the FAKE
// bridge records raw text, so these assert the SENDER's own markers (⏳ / ∎ / ❌).
import { describe, it, expect } from 'vitest';
import { createSender } from '../src/spine/sender.mjs';

function fakeBridge() {
  const streams = [], sent = [];
  return {
    streams, sent,
    send(chat, text, opts) { sent.push({ chat, text, opts }); },
    startStream(chat, init, opts) {
      const h = {
        chat, init, opts, frames: [], finals: [], deleted: false, delivered: false,
        update(t) { h.frames.push(t); },
        async finish(t) { h.finals.push(t); h.delivered = true; },
        async delete() { h.deleted = true; },
      };
      streams.push(h); return h;
    },
  };
}

describe('sender — single-message reply train', () => {
  it('opens with the knee-jerk placeholder (reply-to), streams with ⏳, ends with ∎', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge, bodyEmojiOf: () => '🐶' }).open('!c', { being: 'e', replyTo: 'm1' });
    out.update('Hola');
    await out.finish({ text: 'Hola mundo' });
    const s = bridge.streams[0];
    expect(s.init).toBe('📨 Sending to E...');                 // eager fixed placeholder = the knee-jerk
    expect(s.opts).toMatchObject({ replyTo: 'm1', bodyEmoji: '🐶', persona: 'e' });
    expect(s.frames).toEqual(['Hola ⏳']);                      // streaming marker
    expect(s.finals).toEqual(['Hola mundo ∎']);                // visible ending
    expect(bridge.sent).toHaveLength(0);                       // delivered in place — no fallback send
  });

  it("not surfaced (on-mode '...'): deletes the message, posts nothing", async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e' });
    out.update('...');
    await out.finish({ text: '...' }, { surface: false });
    expect(bridge.streams[0].deleted).toBe(true);
    expect(bridge.streams[0].finals).toHaveLength(0);
    expect(bridge.sent).toHaveLength(0);
  });

  it('falls back to a fresh send when the in-place edit did not deliver (§7)', async () => {
    const bridge = fakeBridge();
    // a stream whose finish never flips delivered
    bridge.startStream = (chat, init, opts) => { const h = { update() {}, async finish() {}, async delete() {}, delivered: false }; bridge.streams.push(h); return h; };
    const out = createSender({ bridge, bodyEmojiOf: () => '🐶' }).open('!c', { being: 'e', replyTo: 'm1' });
    await out.finish({ text: 'reply' });
    expect(bridge.sent).toEqual([{ chat: '!c', text: 'reply ∎', opts: { bodyEmoji: '🐶', replyTo: 'm1' } }]);
  });

  it('send failure ends the message with ❌', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e' });
    out.update('partial');
    await out.fail(new Error('boom'));
    expect(bridge.streams[0].finals[0]).toMatch(/partial … ❌ Sending failed\./);
  });
});
