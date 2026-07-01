// The single-message reply train (operator 2026-06-30): ONE message, opened eagerly
// as the "⏳ Thinking…" reply placeholder (instant ack + streaming target; id resolves
// during spin-up), edited in place into the answer ending with ∎. No separate
// knee-jerk (it piled up / cross-deleted in busy chats). body_emoji stamping is the
// port's job (locked in beeper-port.test); the FAKE bridge records raw text, so these
// assert the SENDER's markers (⏳ / ∎ / ❌) + the reply-to placeholder.
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
  it('opens ONE "⏳ Thinking…" reply placeholder, streams with ⏳, ends with ∎ (no separate knee-jerk)', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge, bodyEmojiOf: () => '🐶' }).open('!c', { being: 'e', replyTo: 'm1' });
    expect(bridge.streams).toHaveLength(1);
    expect(bridge.streams[0].init).toBe('⏳ Thinking…');             // the eager placeholder = instant ack + target
    expect(bridge.streams[0].opts).toMatchObject({ replyTo: 'm1', bodyEmoji: '🐶', persona: 'e' });
    out.update('Hola');
    expect(bridge.streams[0].frames).toEqual(['Hola ⏳']);
    await out.finish({ text: 'Hola mundo' });
    expect(bridge.streams[0].finals).toEqual(['Hola mundo ∎']);      // ends with ∎
    expect(bridge.sent).toHaveLength(0);                             // delivered in place — no fallback
  });

  it("not surfaced (on-mode '...'): deletes the message, posts nothing", async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e' });
    out.update('...');
    await out.finish({ text: '...' }, { surface: false });
    expect(bridge.streams[0].deleted).toBe(true);
    expect(bridge.sent).toHaveLength(0);
  });

  it('falls back to a fresh send when the in-place edit did not deliver (§7)', async () => {
    const bridge = fakeBridge();
    bridge.startStream = (chat, init, opts) => { const h = { update() {}, async finish() {}, async delete() {}, delivered: false }; bridge.streams.push(h); return h; };
    const out = createSender({ bridge, bodyEmojiOf: () => '🐶' }).open('!c', { being: 'e', replyTo: 'm1' });
    await out.finish({ text: 'reply' });
    expect(bridge.sent).toEqual([{ chat: '!c', text: 'reply ∎', opts: { bodyEmoji: '🐶', label: null, replyTo: 'm1' } }]);
  });

  it('send failure ends the message with ❌', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e' });
    out.update('partial');
    await out.fail(new Error('boom'));
    expect(bridge.streams[0].finals[0]).toMatch(/partial … ❌ Sending failed\./);
  });
});
