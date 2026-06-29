// sender.mjs — the §2c sender service: deliver a being's reply as a LIVE stream.
//
// No placeholder (operator 2026-06-29: "not even a placeholder, and streaming"):
// nothing is posted until the brain's first token. The chat message IS the reply
// from its first chunk and edits in place as more arrives (the bridge owns the
// edit lifecycle + debounce). A brain that doesn't stream (no partials) falls
// back to one finished send. The §7 invariant holds: a fresh send fires only when
// the in-place stream did not deliver.
//
// Usage from the loop:  const out = sender.open(chatId);
//                       reply = await brain.turn(to, ev, out.update);
//                       await out.finish(reply);
export function createSender({ bridge } = {}) {
  if (!bridge) throw new Error('createSender: bridge is required');
  return {
    open(chatId) {
      let stream = null;   // opened lazily on the first non-empty partial
      const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? '');
      return {
        // each partial is the full text SO FAR (warm-cli accumulates), so the
        // first one posts the message and the rest edit it.
        update(partial) {
          const t = textOf(partial);
          if (!t) return;
          if (!stream) stream = bridge.startStream?.(chatId, t);
          else stream.update?.(t);
        },
        async finish(reply) {
          const t = textOf(reply);
          if (stream) {
            await stream.finish?.(t);
            if (!stream.delivered && t) await bridge.send(chatId, t);   // §7 fallback
          } else if (t) {
            await bridge.send(chatId, t);   // brain didn't stream → one-shot
          }
        },
        fail: (e) => { try { stream?.fail?.(e); } catch { /* already torn down */ } },
      };
    },
  };
}
