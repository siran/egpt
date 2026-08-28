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
// The live-frame marker is defined ONCE, in dispatch-line.mjs, where its recogniser
// (isLiveStreamFrame) lives — this file is the STAMPER and imports it. They were two
// independent literals, so changing either silently stopped the guard recognising real
// frames while every fixture-built test stayed green.
import { LIVE_FRAME_MARK } from '../dispatch-line.mjs';

const FAIL_SUFFIX = '… ❌ Sending failed.';
// A turn that was MEANT to surface but produced no deliverable text (brainpool
// returned '' / whitespace, OR the spine blanked a failure-shaped result) must
// resolve its placeholder VISIBLY — never a silent delete or a forever "⏳ Thinking…"
// (operator 2026-07-04, DEFECT 1: turn 1 vanished with its placeholder stuck). Its own
// "⚠️ …" marker; distinct from FAIL_SUFFIX (a SEND fault). It still flows through the
// port's wrapPersona, so a configured agent_signature_close layer still appends — the
// marker no longer carries a signature itself.
const noReplyMark = () => `⚠️ no reply (turn failed/empty)`;
// '…' is the MODEL's word (40-rules.md). The bridge must never fabricate it:
// a silence the bridge invented is indistinguishable from one the being chose.
// When the bridge has nothing from the model, it says so in its OWN voice.
const BRIDGE_SILENCE = '<received silence (error?)>';
const THINKING = `${LIVE_FRAME_MARK} Thinking…`;   // NOT a lone emoji (renders oversized in some clients)
// A mention that arrives while THIS conversation's train is still running gets its
// OWN placeholder immediately (the operator's per-message ack), opened in the QUEUED
// state — `ahead` = how many trains run before it. When its turn starts it flips to
// THINKING (activate) and then streams. The DISTINCT text is not cosmetic only: the
// bridge resolves a placeholder's id by matching the newest message with identical
// text, so two coexisting "⏳ Thinking…" placeholders would collapse onto one id (the
// live "stuck placeholder" bug). A queued placeholder's text differs from THINKING
// and — via `ahead` — from every other queued one, so each resolves to its own id.
const QUEUED = (ahead) => `${LIVE_FRAME_MARK} Queued (${ahead} ahead)…`;

// THE MESSAGE IS APPEND-ONLY (operator 2026-08-28: "the message is replaced for a 'final'
// message, and the in-transit thinking is deleted … sometimes it is writing something and
// then boom, it changes … the messages should also be stable").
//
// The living mirror is ONE message edited in place, and every edit used to SUPERSEDE the
// last: `update()` assigned the whole partial, `finish()` posted the settled text whole.
// When the settled text is not an EXTENSION of what streamed — warm-cli resolves with
// `ev.result` (the LAST assistant message, not the accumulated train) and codex assigns
// `currentTurn.text = item.text` wholesale on item/completed — the last edit ERASED what a
// human had already read.
//
// So the message is now kept append-only: an extension grows the tail in place (the ordinary
// token stream, unchanged), a DIVERGENCE seals what was already read above this seam and
// writes the new text below it. Every value the message takes has its predecessor as a
// literal PREFIX — which is exactly what "nothing shown is ever removed" reduces to.
// The settled answer is therefore always the LAST block, where a chat reader's eye lands.
//
// IT CARRIES NO LIVE_FRAME_MARK, and that is load-bearing, not cosmetic: a peer node
// classifies a streaming frame by that marker's PRESENCE (dispatch-line.isLiveStreamFrame,
// 372c17f) and drops it from the record. A seam containing ⏳ would make every settled
// message look transient to an observing node and vanish from its transcript.
export const RETAINED_SEAM = '\n\n— ↓ reply —\n\n';

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
        // sendResult (operator 2026-08-10, voice-reply-as-a-reply-to-the-text chunk): the
        // delivered message's own confirmedId, exposed so a caller can thread a FOLLOW-UP
        // send (the synthesized voice note) as a reply TO this text once it's out.
        let sendResult = null;
        return {
          activate() {},
          update() {},
          async finish(reply, { surface = true } = {}) {
            const t = textOf(reply);
            if (!surface || !t.trim()) return;          // withheld / empty → post nothing
            sendResult = await bridge.send(chatId, t, { replyTo });   // plain text: no bodyEmoji/label, no end-marker
          },
          async fail() { /* a human doesn't post a typing/failure scaffold — stay silent */ },
          get confirmedId() { return sendResult?.confirmedId ?? null; },
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
      // What the human has already read, in two parts: `tail` is the block the current
      // frame extends, `head` everything sealed behind a seam. See RETAINED_SEAM.
      let head = '';
      let tail = '';
      const shown = () => (head ? `${head}${RETAINED_SEAM}${tail}` : tail);
      // Absorb the message's next value and return the text to display. EXTENSION → the tail
      // grows in place (the common case: no seam, no duplication, the settled answer reads as
      // the whole message). DIVERGENCE → seal the tail into `head` and start a new one below
      // the seam. Never removes; the previous rendering is always a prefix of the new one.
      const absorb = (next) => {
        const t = String(next ?? '');
        if (!t) return shown();
        if (t.startsWith(tail)) { tail = t; return shown(); }
        head = head ? `${head}${RETAINED_SEAM}${tail}` : tail;
        tail = t;
        return shown();
      };
      // fallbackResult (operator 2026-08-10, voice-reply-as-a-reply-to-the-text chunk): set
      // ONLY when the §7 fallback below fires (a FRESH send, not an edit-in-place) — its own
      // confirmedId then supersedes the stream's, which never delivered.
      let fallbackResult = null;
      return {
        // A queued placeholder flips from the queue into the live train the instant
        // its turn starts (before the first token), so the user sees it move. No-op
        // for a placeholder that was never queued.
        activate() { if (queued) stream?.update?.(THINKING); },
        update(partial) { const t = textOf(partial); if (!t) return; stream?.update?.(`${absorb(t)} ${LIVE_FRAME_MARK}`); },
        async finish(reply, { surface = true } = {}) {
          const t = textOf(reply);
          // Gate-withheld ('on'-mode silence / not surfaced). NOTHING IS EVER
          // DELETED (operator 2026-08-24): the placeholder resolves to the
          // silence mark instead of vanishing. 40-rules.md already names it —
          // "A polite silence is '...' or '…'" — so the withheld turn reads as
          // a deliberate silence rather than a message that disappeared.
          if (!surface) {
            // The model's own words if it produced any (its '…' is ITS silence);
            // otherwise the bridge says, in its own voice, that nothing arrived.
            // Absorbed like any other value: a silence that ARRIVES after the model
            // narrated does not erase the narration — it lands under the seam.
            if (stream) await stream.finish?.(absorb(t.trim() ? t : BRIDGE_SILENCE));
            return;
          }
          // Surfaced: deliver the reply, OR — when it came back empty — the no-reply
          // marker (a turn meant to reply that produced nothing is resolved VISIBLY,
          // not silently deleted / left stuck).
          const body = absorb(t.trim() ? t : noReplyMark());
          if (stream) {
            await stream.finish?.(body);
            if (!stream.delivered) fallbackResult = await bridge.send(chatId, body, tag);   // §7 fallback
          } else {
            fallbackResult = await bridge.send(chatId, body, tag);
          }
        },
        async fail() {                                 // visible failure: the message ends with ❌
          try {
            if (stream) await stream.finish?.(`${shown() ? `${shown()} ` : ''}${FAIL_SUFFIX}`);
            else await bridge.send(chatId, FAIL_SUFFIX, tag);
          } catch { /* best effort */ }
        },
        get confirmedId() { return fallbackResult ? (fallbackResult?.confirmedId ?? null) : (stream?.confirmedId ?? null); },
      };
    },
  };
}
