// sender.mjs — the §2c sender service: the reply train (operator 2026-06-30).
//   A (knee-jerk): post "📨 Sending to <Being>..." immediately, to cover brain
//                  spin-up. A plain status can't become a reply-to, so the moment
//                  the reply starts streaming the knee-jerk is DELETED and B
//                  replaces it (a real reply-to the question).
//   B (reply):     the answer, streamed in place as a REPLY to the question. LAZY
//                  — created on the brain's first token, so only the knee-jerk
//                  shows during spin-up. Streams with a trailing ⏳; on finish the
//                  train ENDS VISIBLY with ∎. A send failure ends it with
//                  "… ❌ Sending failed." instead.
// body_emoji is enforced by the bridge layer (beeper-port); the train markers
// (⏳ / ∎ / failure) are owned HERE. §7 invariant holds: a fresh send fires only
// when the in-place stream didn't deliver.
//
// Loop usage:  const out = sender.open(chatId, { being, replyTo });
//              reply = await brain.turn(being, ev, out.update);
//              await out.finish(reply, { surface });   // surface=false → tear down, post nothing
const END_MARK = '∎';
const FAIL_SUFFIX = '… ❌ Sending failed.';
const displayName = (b) => (String(b).toLowerCase() === 'e' ? 'E' : String(b).charAt(0).toUpperCase() + String(b).slice(1));

export function createSender({ bridge, bodyEmojiOf = () => null, displayOf = displayName } = {}) {
  if (!bridge) throw new Error('createSender: bridge is required');
  const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? '');
  return {
    open(chatId, { being = 'e', replyTo = null } = {}) {
      const bodyEmoji = bodyEmojiOf(being);
      // A — knee-jerk status. Best-effort id, so we can delete it later.
      const statusP = Promise.resolve(bridge.postStatus?.(chatId, `📨 Sending to ${displayOf(being)}...`)).catch(() => null);
      let statusKilled = false;
      const killStatus = async () => {
        if (statusKilled) return; statusKilled = true;
        try { const id = await statusP; if (id) await bridge.deleteStatus?.(chatId, id); } catch { /* best effort */ }
      };
      // B — lazy reply stream. FIXED "⏳" init so the bridge resolves the message
      // id before any edit (the variable-placeholder race fix). Creating it kills
      // the knee-jerk — the reply has started streaming.
      let stream = null, acc = '';
      const ensureStream = () => {
        if (!stream) { stream = bridge.startStream?.(chatId, '⏳', { bodyEmoji, replyTo, persona: being }); killStatus(); }
        return stream;
      };
      return {
        update(partial) {
          const t = textOf(partial);
          if (!t) return;
          acc = t;
          ensureStream()?.update?.(`${t} ⏳`);
        },
        async finish(reply, { surface = true } = {}) {
          const t = textOf(reply);
          if (!surface || !t) {                        // withheld ('on'-mode '...') or empty → no message
            await killStatus();
            if (stream) await stream.delete?.();
            return;
          }
          if (stream) {
            await stream.finish?.(`${t} ${END_MARK}`);
            if (!stream.delivered) await bridge.send(chatId, `${t} ${END_MARK}`, { bodyEmoji, replyTo });   // §7 fallback
          } else {
            await bridge.send(chatId, `${t} ${END_MARK}`, { bodyEmoji, replyTo });   // brain didn't stream → one-shot reply
          }
          await killStatus();
        },
        async fail() {                                 // visible failure: the message ends with ❌
          try {
            if (stream) await stream.finish?.(`${acc ? `${acc} ` : ''}${FAIL_SUFFIX}`);
            else await bridge.send(chatId, FAIL_SUFFIX, { bodyEmoji, replyTo });
          } catch { /* best effort */ }
          await killStatus();
        },
      };
    },
  };
}
