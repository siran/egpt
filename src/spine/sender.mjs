// sender.mjs — the §2c sender service: the two-message thinking train (operator
// 2026-06-29):
//   A (status):  post "🤔 Thinking…" immediately; on finish edit it to "🤔 Thinking… ✅".
//   B (reply):   stream the answer as a REPLY to the question; while streaming the
//                message ends with " ⏳"; on finish the ⏳ is dropped.
// B is lazy — it posts on the brain's first token (the message IS the reply). The
// body_emoji + ⏳ are enforced by the bridge layer (beeper-port). The §7 invariant
// holds: a fresh send fires only when the in-place stream didn't deliver.
//
// Loop usage:  const out = sender.open(chatId, { being, replyTo });
//              reply = await brain.turn(being, ev, out.update);
//              await out.finish(reply);
const THINKING = '🤔 Thinking…';
const DONE = '🤔 Thinking… ✅';

export function createSender({ bridge, bodyEmojiOf = () => null } = {}) {
  if (!bridge) throw new Error('createSender: bridge is required');
  const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? '');
  return {
    open(chatId, { being = 'e', replyTo = null } = {}) {
      const bodyEmoji = bodyEmojiOf(being);
      // A: status message — immediate "🤔 Thinking…" (best-effort id for the ✅ edit).
      const statusP = Promise.resolve(bridge.postStatus?.(chatId, THINKING)).catch(() => null);
      // B: the reply stream — opened lazily on the first token so the message is
      // the reply from its first chunk.
      let stream = null;
      const finalizeStatus = async () => {
        try { const id = await statusP; if (id) await bridge.editStatus?.(chatId, id, DONE); } catch { /* best effort */ }
      };
      return {
        update(partial) {
          const t = textOf(partial);
          if (!t) return;
          if (!stream) stream = bridge.startStream?.(chatId, t, { bodyEmoji, replyTo, persona: being });
          else stream.update?.(t);
        },
        async finish(reply) {
          const t = textOf(reply);
          if (stream) {
            await stream.finish?.(t);
            if (!stream.delivered && t) await bridge.send(chatId, t, { bodyEmoji, replyTo });   // §7 fallback
          } else if (t) {
            await bridge.send(chatId, t, { bodyEmoji, replyTo });   // brain didn't stream → one-shot reply
          }
          await finalizeStatus();
        },
        fail: (e) => { try { stream?.fail?.(e); } catch { /* already torn down */ } },
      };
    },
  };
}
