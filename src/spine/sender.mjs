// sender.mjs — the §2c sender service: deliver a being's reply as a LIVE stream
// with the thinking train (operator 2026-06-29, the beta-20 contract): post a
// lone 🤔 immediately (renders big = "working"), stream the reply in place as the
// brain writes it, and finish with a ✅ Done marker. Default ON — a surfaced
// reply (every mention reply is surfaced) shows the train.
//
// The body_emoji is the BEING's, resolved from config and handed to the bridge,
// which ENFORCES it on every edit/final/fallback (see beeper-port). The §7
// invariant holds: a fresh send fires only when the in-place stream didn't deliver.
//
// Loop usage:  const out = sender.open(chatId, { being });
//              reply = await brain.turn(being, ev, out.update);
//              await out.finish(reply);
const PLACEHOLDER = '🤔';

export function createSender({ bridge, bodyEmojiOf = () => null, showThink = true } = {}) {
  if (!bridge) throw new Error('createSender: bridge is required');
  const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? '');
  return {
    open(chatId, { being = 'e', replyTo = null } = {}) {
      const bodyEmoji = bodyEmojiOf(being);
      // Post 🤔 now (the thinking marker); the bridge edits it into the reply live.
      // replyTo threads the triggering message id so a mention reply quotes it.
      const stream = bridge.startStream?.(chatId, PLACEHOLDER, { showThink, bodyEmoji, persona: being, replyTo });
      return {
        update(partial) { const t = textOf(partial); if (t) stream?.update?.(t); },
        async finish(reply) {
          const t = textOf(reply);
          if (stream) {
            await stream.finish?.(t);
            if (!stream.delivered && t) await bridge.send(chatId, t, { bodyEmoji, replyTo });   // §7 fallback
          } else if (t) {
            await bridge.send(chatId, t, { bodyEmoji, replyTo });   // no streaming bridge → one-shot
          }
        },
        fail: (e) => { try { stream?.fail?.(e); } catch { /* already torn down */ } },
      };
    },
  };
}
