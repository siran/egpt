// sender.mjs — the §2c sender service: the reply train (operator 2026-06-30).
// ONE message: post "⏳ Thinking…" eagerly as a REPLY to the question — the instant
// ack AND the streaming target in one. FIXED placeholder text so the bridge resolves
// its id before any edit (and during spin-up → smooth edits, no stutter). Once tokens
// arrive it edits in place into the answer. A send failure ends it with
// "… ❌ Sending failed."; an 'on'-mode '...' silence deletes it (posts nothing).
//
// No SEPARATE knee-jerk message: a per-turn "📨 Sending to E..." piled up and
// cross-deleted in busy chats (its id-resolution races the next turn's). The reply's
// own reply-to quote is the ack; nothing to linger. body_emoji is enforced by the
// bridge; the train markers (⏳ / failure) are owned here. The reply carries NO inline
// end-marker: the historical signature train end-marker was REMOVED (operator
// 2026-07-12) — its successor is the `agent_signature_close` layer, applied downstream
// in beeper-port (default EMPTY → a reply renders with no end-marker unless the operator
// sets agent_signature_close).
const FAIL_SUFFIX = '… ❌ Sending failed.';
// A turn that was MEANT to surface but produced no deliverable text (brainpool
// returned '' / whitespace, OR the spine blanked a failure-shaped result) must
// resolve its placeholder VISIBLY — never a silent delete or a forever "⏳ Thinking…"
// (operator 2026-07-04, DEFECT 1: turn 1 vanished with its placeholder stuck). Its own
// "⚠️ …" marker; distinct from FAIL_SUFFIX (a SEND fault). It still flows through the
// port's wrapPersona, so a configured agent_signature_close layer still appends — the
// marker no longer carries a signature itself.
const noReplyMark = () => `⚠️ no reply (turn failed/empty)`;
const THINKING = '⏳ Thinking…';   // NOT a lone emoji (renders oversized in some clients)
// A mention that arrives while THIS conversation's train is still running gets its
// OWN placeholder immediately (the operator's per-message ack), opened in the QUEUED
// state — `ahead` = how many trains run before it. When its turn starts it flips to
// THINKING (activate) and then streams. The DISTINCT text is not cosmetic only: the
// bridge resolves a placeholder's id by matching the newest message with identical
// text, so two coexisting "⏳ Thinking…" placeholders would collapse onto one id (the
// live "stuck placeholder" bug). A queued placeholder's text differs from THINKING
// and — via `ahead` — from every other queued one, so each resolves to its own id.
const QUEUED = (ahead) => `⏳ Queued (${ahead} ahead)…`;

export function createSender({ bridge, bodyEmojiOf = () => null, labelOf = () => null, agentSignatureOpenOf = () => '', agentSignatureCloseOf = () => '', defaultKey = 'e' } = {}) {
  if (!bridge) throw new Error('createSender: bridge is required');
  const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? '');
  return {
    open(chatId, { being = defaultKey, replyTo = null, queued = false, queuedAhead = 0, auto = false } = {}) {
      // mode:auto — E impersonates the operator, so the reply is PLAIN operator text:
      // NO persona line (no body_emoji/label tag passed → the port stamps nothing), no
      // end-marker, and NO thinking scaffold — no "⏳ Thinking…" placeholder, no streamed
      // edits, no queued placeholder. It posts ONCE, complete, when the turn finishes, the
      // way a human types a single message. A withheld ('…' silence, surface:false) or
      // empty reply posts NOTHING — silence is a valid operator move.
      if (auto) {
        return {
          activate() {},
          update() {},
          async finish(reply, { surface = true } = {}) {
            const t = textOf(reply);
            if (!surface || !t.trim()) return;          // withheld / empty → post nothing
            await bridge.send(chatId, t, { replyTo });   // plain text: no bodyEmoji/label, no end-marker
          },
          async fail() { /* a human doesn't post a typing/failure scaffold — stay silent */ },
        };
      }
      const bodyEmoji = bodyEmojiOf(being);
      const label = labelOf(being);
      // The per-AGENT signature WRAP (operator 2026-07-12): agent_signature_open/close bracket the
      // stamped reply as the INNER layer (the bridge does the concentric wrap in beeper-port). Resolved
      // per-being here (agent → node → ''); default empty → nothing added. agent_signature_close is the
      // SOLE agent close now — the historical inline signature end-marker was removed 2026-07-12.
      const agentSigOpen = agentSignatureOpenOf(being);
      const agentSigClose = agentSignatureCloseOf(being);
      const tag = { bodyEmoji, label, replyTo, agentSigOpen, agentSigClose };   // the bridge enforces the persona stamp (emoji + label) + wraps the layers from these
      const stream = bridge.startStream?.(chatId, queued ? QUEUED(queuedAhead) : THINKING, { ...tag, persona: being });
      let acc = '';
      return {
        // A queued placeholder flips from the queue into the live train the instant
        // its turn starts (before the first token), so the user sees it move. No-op
        // for a placeholder that was never queued.
        activate() { if (queued) stream?.update?.(THINKING); },
        update(partial) { const t = textOf(partial); if (!t) return; acc = t; stream?.update?.(`${t} ⏳`); },
        async finish(reply, { surface = true } = {}) {
          const t = textOf(reply);
          // Gate-withheld ('on'-mode '...' silence / not surfaced): delete, post nothing.
          if (!surface) { if (stream) await stream.delete?.(); return; }
          // Surfaced: deliver the reply, OR — when it came back empty — the no-reply
          // marker (a turn meant to reply that produced nothing is resolved VISIBLY,
          // not silently deleted / left stuck).
          const body = t.trim() ? t : noReplyMark();
          if (stream) {
            await stream.finish?.(body);
            if (!stream.delivered) await bridge.send(chatId, body, tag);   // §7 fallback
          } else {
            await bridge.send(chatId, body, tag);
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
