// sender.mjs — the §2c sender service: deliver a being's reply to the chat as a
// stream-edit, with a one-shot fallback. The §7 invariant: the fresh fallback
// send fires ONLY when the in-place stream did not deliver — otherwise the reply
// would double-post. The bridge owns the edit lifecycle (placeholder → edit →
// finalize, one message); the sender just drives it and reads `delivered`.
//
// v1 delivers the FINAL text in one finish() (placeholder → reply). Live
// token-by-token partials (stream.update on each chunk) wire in when the brain
// streams — the seam is here (deliver could take an onPartial), not the loop.
export function createSender({ bridge, placeholder = '⌛' } = {}) {
  if (!bridge) throw new Error('createSender: bridge is required');
  return {
    async deliver(chatId, reply) {
      const text = typeof reply === 'string' ? reply : reply?.text;
      if (!chatId || !text) return { delivered: false };
      const stream = bridge.startStream?.(chatId, placeholder);
      if (stream) {
        await stream.finish(text);
        if (stream.delivered) return { delivered: true, via: 'stream' };
        // stream couldn't edit in place (dangling placeholder dropped by the
        // bridge) → fall through to a fresh send.
      }
      await bridge.send(chatId, text);
      return { delivered: true, via: 'send' };
    },
  };
}
