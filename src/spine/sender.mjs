// sender.mjs — the §2c sender service: the reply train (operator 2026-06-30).
// TWO messages, the proven eager structure:
//   A (knee-jerk): "📨 Sending to <Being>..." posted immediately to cover brain
//     spin-up, DELETED the moment the reply starts streaming.
//   B (reply): posted EAGERLY as a fixed "⏳" placeholder (a reply to the question)
//     so its id resolves during spin-up — smooth edits once tokens arrive, no
//     mid-stream stutter. Streams the answer (trailing ⏳), ENDS VISIBLY with ∎. A
//     send failure ends it with "… ❌ Sending failed."; an 'on'-mode '...' silence
//     deletes it and posts nothing.
// Why A + B stay SEPARATE (not one edited message): B's "⏳" placeholder resolves
// to the message we JUST posted, never a past turn — a prior turn's "⏳" was long
// since edited into its own reply. Collapsing the reply onto the "📨 Sending to E..."
// text (a single message) made E edit an OLD reply when that text mis-resolved.
// body_emoji is enforced by the bridge; the train markers (⏳ / ∎ / failure) here.
const END_MARK = '∎';
const FAIL_SUFFIX = '… ❌ Sending failed.';
const displayName = (b) => (String(b).toLowerCase() === 'e' ? 'E' : String(b).charAt(0).toUpperCase() + String(b).slice(1));

export function createSender({ bridge, bodyEmojiOf = () => null, displayOf = displayName } = {}) {
  if (!bridge) throw new Error('createSender: bridge is required');
  const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? '');
  return {
    open(chatId, { being = 'e', replyTo = null } = {}) {
      const bodyEmoji = bodyEmojiOf(being);
      // A — knee-jerk status (best-effort id, so we can delete it later). Covers the
      // instant BEFORE the reply placeholder is up.
      const statusP = Promise.resolve(bridge.postStatus?.(chatId, `📨 Sending to ${displayOf(being)}...`)).catch(() => null);
      let statusKilled = false;
      const killStatus = async () => {
        if (statusKilled) return; statusKilled = true;
        try { const id = await statusP; if (id) await bridge.deleteStatus?.(chatId, id); } catch { /* best effort */ }
      };
      // B — reply stream, EAGER: FIXED placeholder posted NOW so the bridge resolves
      // its id before any edit (the race fix) AND during spin-up (smooth). Carries
      // TEXT, not a lone "⏳" (a single emoji renders oversized in some clients).
      const stream = bridge.startStream?.(chatId, '⏳ Thinking…', { bodyEmoji, replyTo, persona: being });
      // The hourglass is up now → drop the knee-jerk (operator: delete the knee-jerk
      // once the hourglass appears). killStatus awaits the knee-jerk's own id, which
      // resolves after the (faster) hourglass POST, so the hourglass is already shown.
      killStatus();
      let acc = '';
      return {
        update(partial) {
          const t = textOf(partial);
          if (!t) return;
          acc = t;
          stream?.update?.(`${t} ⏳`);
        },
        async finish(reply, { surface = true } = {}) {
          const t = textOf(reply);
          await killStatus();
          if (!surface || !t) { if (stream) await stream.delete?.(); return; }   // withheld ('...') / empty → no message
          if (stream) {
            await stream.finish?.(`${t} ${END_MARK}`);
            if (!stream.delivered) await bridge.send(chatId, `${t} ${END_MARK}`, { bodyEmoji, replyTo });   // §7 fallback
          } else {
            await bridge.send(chatId, `${t} ${END_MARK}`, { bodyEmoji, replyTo });
          }
        },
        async fail() {                          // visible failure: the message ends with ❌
          await killStatus();
          try {
            if (stream) await stream.finish?.(`${acc ? `${acc} ` : ''}${FAIL_SUFFIX}`);
            else await bridge.send(chatId, FAIL_SUFFIX, { bodyEmoji, replyTo });
          } catch { /* best effort */ }
        },
      };
    },
  };
}
