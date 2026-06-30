// sender.mjs — the §2c sender service: the reply train (operator 2026-06-30).
// ONE message, edited in place. It opens as the knee-jerk "📨 Sending to <Being>..."
// — a reply to the question, with FIXED text so the bridge resolves its message id
// DURING brain spin-up (not mid-stream — that lazy resolution was the stutter). Once
// tokens arrive it edits smoothly into the answer (trailing ⏳) and ENDS VISIBLY with
// ∎. A send failure ends it with "… ❌ Sending failed."; an 'on'-mode '...' silence
// (surface:false) deletes it and posts nothing. body_emoji is enforced by the bridge
// layer (beeper-port); the train markers (⏳ / ∎ / failure) are owned here.
//
// Loop usage:  const out = sender.open(chatId, { being, replyTo });
//              reply = await brain.turn(being, ev, out.update);
//              await out.finish(reply, { surface });   // surface=false → delete, post nothing
const END_MARK = '∎';
const FAIL_SUFFIX = '… ❌ Sending failed.';
const displayName = (b) => (String(b).toLowerCase() === 'e' ? 'E' : String(b).charAt(0).toUpperCase() + String(b).slice(1));

export function createSender({ bridge, bodyEmojiOf = () => null, displayOf = displayName } = {}) {
  if (!bridge) throw new Error('createSender: bridge is required');
  const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? '');
  return {
    open(chatId, { being = 'e', replyTo = null } = {}) {
      const bodyEmoji = bodyEmojiOf(being);
      // Open the reply message NOW with the knee-jerk text — a FIXED placeholder (so
      // the bridge resolves its id before any edit: the race fix) that is ALSO a
      // reply to the question. Resolving the id during spin-up is what keeps the
      // live edits smooth once tokens start arriving.
      const stream = bridge.startStream?.(chatId, `📨 Sending to ${displayOf(being)}...`, { bodyEmoji, replyTo, persona: being });
      let acc = '';
      return {
        update(partial) { const t = textOf(partial); if (!t) return; acc = t; stream?.update?.(`${t} ⏳`); },
        async finish(reply, { surface = true } = {}) {
          const t = textOf(reply);
          if (!surface || !t) { await stream?.delete?.(); return; }   // withheld ('...') or empty → no message
          if (stream) {
            await stream.finish?.(`${t} ${END_MARK}`);
            if (!stream.delivered) await bridge.send(chatId, `${t} ${END_MARK}`, { bodyEmoji, replyTo });   // §7 fallback
          } else {
            await bridge.send(chatId, `${t} ${END_MARK}`, { bodyEmoji, replyTo });
          }
        },
        async fail() {                                 // visible failure: the message ends with ❌
          try {
            if (stream) await stream.finish?.(`${acc ? `${acc} ` : ''}${FAIL_SUFFIX}`);
            else await bridge.send(chatId, FAIL_SUFFIX, { bodyEmoji, replyTo });
          } catch { /* best effort */ }
        },
      };
    },
  };
}
