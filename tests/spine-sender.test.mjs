// The two-message reply train (operator 2026-06-30): a knee-jerk status posted
// immediately + an EAGER reply stream (its id resolves during spin-up → no
// mid-stream stutter). The knee-jerk is deleted when the reply starts streaming;
// the reply ends with ∎. Keeping them separate is what stops the reply from ever
// landing in a PAST message. body_emoji stamping is the port's job (locked in
// beeper-port.test); the FAKE bridge records raw text, so these assert the
// SENDER's own markers (⏳ / ∎ / ❌) + the knee-jerk lifecycle.
import { describe, it, expect } from 'vitest';
import { createSender } from '../src/spine/sender.mjs';

function fakeBridge() {
  const streams = [], sent = [], statusPosts = [], statusDeletes = [];
  return {
    streams, sent, statusPosts, statusDeletes,
    async postStatus(chat, text) { const id = `st-${statusPosts.length + 1}`; statusPosts.push({ chat, text, id }); return id; },
    deleteStatus(chat, id) { statusDeletes.push({ chat, id }); },
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

describe('sender — two-message reply train (eager)', () => {
  it('posts the knee-jerk + a text-bearing eager placeholder; deletes the knee-jerk when the hourglass appears; ends with ∎', async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge, bodyEmojiOf: () => '🐶' }).open('!c', { being: 'e', replyTo: 'm1' });
    expect(bridge.statusPosts[0].text).toBe('📨 Sending to E...');   // knee-jerk, posted immediately
    expect(bridge.streams[0].init).toBe('⏳ Thinking…');             // eager placeholder carries text (no lone-emoji amplification)
    expect(bridge.streams[0].opts).toMatchObject({ replyTo: 'm1', bodyEmoji: '🐶', persona: 'e' });
    await new Promise((r) => setTimeout(r, 0));                      // let the knee-jerk delete (fired at open) settle
    expect(bridge.statusDeletes).toHaveLength(1);                    // hourglass is up → knee-jerk deleted
    out.update('Hola');
    expect(bridge.streams[0].frames).toEqual(['Hola ⏳']);
    await out.finish({ text: 'Hola mundo' });
    expect(bridge.streams[0].finals).toEqual(['Hola mundo ∎']);      // ends with ∎
    expect(bridge.sent).toHaveLength(0);                             // delivered in place — no fallback
  });

  it("not surfaced (on-mode '...'): deletes the knee-jerk AND the reply, posts nothing", async () => {
    const bridge = fakeBridge();
    const out = createSender({ bridge }).open('!c', { being: 'e' });
    out.update('...');
    await out.finish({ text: '...' }, { surface: false });
    expect(bridge.streams[0].deleted).toBe(true);
    expect(bridge.statusDeletes).toHaveLength(1);
    expect(bridge.sent).toHaveLength(0);
  });

  it('falls back to a fresh send when the in-place edit did not deliver (§7)', async () => {
    const bridge = fakeBridge();
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
