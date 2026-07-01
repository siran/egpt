// sender.mjs — the §2c sender service: the reply train (operator 2026-06-30).
// ONE message: post "⏳ Thinking…" eagerly as a REPLY to the question — the instant
// ack AND the streaming target in one. FIXED placeholder text so the bridge resolves
// its id before any edit (and during spin-up → smooth edits, no stutter). Once tokens
// arrive it edits in place into the answer, ENDING VISIBLY with ∎. A send failure ends
// it with "… ❌ Sending failed."; an 'on'-mode '...' silence deletes it (posts nothing).
//
// No SEPARATE knee-jerk message: a per-turn "📨 Sending to E..." piled up and
// cross-deleted in busy chats (its id-resolution races the next turn's). The reply's
// own reply-to quote is the ack; nothing to linger. body_emoji is enforced by the
// bridge; the train markers (⏳ / ∎ / failure) are owned here.
const END_MARK = '∎';
const FAIL_SUFFIX = '… ❌ Sending failed.';
const THINKING = '⏳ Thinking…';   // NOT a lone emoji (renders oversized in some clients)

export function createSender({ bridge, bodyEmojiOf = () => null, labelOf = () => null } = {}) {
  if (!bridge) throw new Error('createSender: bridge is required');
  const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? '');
  return {
    open(chatId, { being = 'e', replyTo = null } = {}) {
      const bodyEmoji = bodyEmojiOf(being);
      const label = labelOf(being);
      const tag = { bodyEmoji, label, replyTo };   // the bridge enforces the persona line (emoji + label) from these
      const stream = bridge.startStream?.(chatId, THINKING, { ...tag, persona: being });
      let acc = '';
      return {
        update(partial) { const t = textOf(partial); if (!t) return; acc = t; stream?.update?.(`${t} ⏳`); },
        async finish(reply, { surface = true } = {}) {
          const t = textOf(reply);
          if (!surface || !t) { if (stream) await stream.delete?.(); return; }   // withheld ('...') / empty → no message
          if (stream) {
            await stream.finish?.(`${t} ${END_MARK}`);
            if (!stream.delivered) await bridge.send(chatId, `${t} ${END_MARK}`, tag);   // §7 fallback
          } else {
            await bridge.send(chatId, `${t} ${END_MARK}`, tag);
          }
        },
        async fail() {                                 // visible failure: the message ends with ❌
          try {
            if (stream) await stream.finish?.(`${acc ? `${acc} ` : ''}${FAIL_SUFFIX}`);
            else await bridge.send(chatId, FAIL_SUFFIX, tag);
          } catch { /* best effort */ }
        },
      };
    },
  };
}
