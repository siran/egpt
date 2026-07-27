// transcript-log.mjs — build the bytes appended to a chat's transcript.md for
// ONE line (an inbound message or a being's reply).
//
// Limb-agnostic (C1.2 / I3): every surface + every being routes through this so a
// received message — or a reply, surfaced or withheld — always lands in
// conversations/<surface>/<slug>/transcript.md. The regression this guards
// against: the bot→Wren `forceTarget` route bypassed runDefaultBrainTurn's logger
// and Telegram went unlogged. The IO wrapper lives in egpt-spine.mjs (`_logChatLine`).
//
// Pure + Node-import-free (so it can't drag node builtins into a bundled limb).
//
// The READ side lives here too (mode:accum's window, at the bottom): the shape of a
// transcript line is defined in this module, so the one function that reads lines back
// out of transcript.md keys on THAT definition rather than on a copy of it.
import { renderFrontMatter, stripFrontMatter } from './transcript-meta.mjs';
import { hhmm } from './dispatch-line.mjs';

/**
 * Bytes to append for one transcript line. Prepends the YAML front matter when
 * the transcript is new (`existing` false). THROWS on an empty body so a
 * received message can never be silently dropped — a "logged nothing" is a bug,
 * not a no-op.
 *
 * The header carries the CHAT id, the static surface key this file belongs to — it is known
 * at first sight and never changes. It does NOT carry `thread_id`: this runs at ingestion,
 * before the turn, so no thread exists yet; conversations-state.stampThreadId fills that slot
 * when one is minted (operator 2026-07-26: chat id and thread id are two different static keys).
 */
export function transcriptAppend({ existing = false, body, name, surface, slug, chatId, persona } = {}) {
  const text = String(body ?? '').trim();
  if (!text) throw new Error('transcriptAppend: empty body — a received message must not be silently dropped');
  const header = existing
    ? ''
    : renderFrontMatter({ name: name ?? chatId ?? slug, surface, slug, chat_id: chatId, persona });
  return header + text + '\n\n';
}

/**
 * Format a being's reply line for the transcript: `[<being> (HH:MM)]: body`,
 * tagged `(not surfaced)` when the reply was withheld by the gate/mode.
 *
 * HH:MM renders in `timeZone` — the node's config `default_time_zone`, injected by boot
 * through the SAME `hhmm` the inbound line uses, so the two halves of a transcript can
 * never disagree about what time it is. Unset/invalid → UTC (operator 2026-07-26).
 */
export function replyLine({ being, body, surfaced = true, now = new Date(), timeZone = null } = {}) {
  const t = hhmm(now, timeZone);
  const tag = surfaced ? '' : '(not surfaced) ';
  return `[@${being} (${t})]: ${tag}${String(body ?? '').trim()}`;
}

// ── RECENT CONTEXT — reading the gap back out of transcript.md ────────────────
// (operator 2026-07-26, the skin-cells incident: an un-@mentioned message never reached
// E, so the next @mention was answered from twenty-minute-old context.)
//
// THE CONTROL IS `mode: accum` (src/auto-mode.mjs) — the ONE switch, no config key beside
// it. This module is control-agnostic: it only builds the window when the spine asks.
//
// send_to_egpt:'mode' means a being only runs a turn on messages it will ANSWER, so
// everything said between two of its turns is invisible to it. This reads that gap back
// out of the record — the transcript IS the accumulated buffer, so nothing else is
// stored anywhere.
//
// THE BOUNDARY IS THIS BEING'S OWN LAST REPLY LINE (operator 2026-07-26: "should the
// window include what E already has? no"). Its warm session already holds everything up
// to its last turn, so the gap starts exactly there — no overlap, and no time window,
// which is also why NO TIMESTAMP IS PARSED here: `(HH:MM)` renders in the node's
// configured zone and carries no date, so any clock comparison would be both
// zone-sensitive and ambiguous across midnight. The predicate is the SHAPE `replyLine`
// (above) writes — `[@<being>[.<node>] (HH:MM)]:` — matched at the head of a block:
//   - only THIS being's line is the boundary; another agent's reply is part of the gap
//     (E did not see it either),
//   - a WITHHELD reply counts: `(not surfaced) ` follows the `]:`, so it matches — and
//     it SHOULD, because that turn ran and the being saw everything before it,
//   - a being that has never replied here has no boundary → the whole tail.
//
// SIZE IS THE ONLY BOUND. If the being has not spoken in a chat for days the gap can be
// enormous, so `maxChars` caps it, keeping the MOST RECENT blocks (the ones nearest the
// prompt) and reporting `truncated` so the caller can SAY the gap is partial instead of
// letting the model believe it has all of it. A CONSTANT, deliberately — the mode is the
// only switch this behaviour has, and it is not getting a config knob beside it.
export const RECENT_CONTEXT_MAX_CHARS = 8000;

const _escapeBeing = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// `[@e (22:05)]:` / `[@e.kg (22:05)]: (not surfaced) …` — replyLine's shape, with the
// optional `.<node_name>` qualifier the transcript service adds (spine/transcript.mjs).
function beingReplyRe(being) {
  return new RegExp(`^\\[@${_escapeBeing(String(being ?? '').toLowerCase())}(?:\\.[^\\s\\]]+)?\\s\\(\\d{1,2}:\\d{2}\\)\\]:`, 'i');
}

/**
 * The conversation blocks recorded since `being`'s last reply — oldest first.
 * A transcript entry is one blank-line-separated block (transcriptAppend/replyLine both
 * end `\n\n`), so a multi-line body stays whole.
 *
 * @param {string} text      transcript.md, front matter included
 * @param {{being?: string, maxChars?: number, exclude?: string}} opts
 *        exclude — the TRIGGERING line, which was already appended at ingestion: it is
 *        THE prompt, so it must never also appear as context.
 * @returns {{ blocks: string[], truncated: boolean }}
 */
export function contextSinceLastTurn(text, { being = null, maxChars = RECENT_CONTEXT_MAX_CHARS, exclude = null } = {}) {
  const blocks = stripFrontMatter(String(text ?? '')).split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const mine = being ? beingReplyRe(being) : null;
  const skip = String(exclude ?? '').trim();
  const out = [];
  let used = 0, truncated = false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (mine && mine.test(b)) break;                                  // the boundary — above it is already in the session
    if (skip && b === skip) continue;                                 // the prompt itself
    if (used + b.length > maxChars) { truncated = true; break; }      // cap: keep the most recent
    used += b.length;
    out.push(b);
  }
  out.reverse();
  return { blocks: out, truncated };
}

/**
 * The labelled prompt (ROADMAP §backburner: "this line is THE prompt; the following is
 * accumulated context"). The trigger comes FIRST under an unmistakable header — without
 * a hard boundary a model answers the context instead of the question, which is the same
 * failure from the other direction. An EMPTY gap renders nothing at all: the line is
 * returned unchanged, so a chat with nothing accumulated prompts exactly as it does with
 * the option off.
 */
export function promptWithRecentContext(line, { blocks = [], truncated = false } = {}) {
  const trigger = String(line ?? '');
  if (!blocks.length) return trigger;
  const note = truncated ? '\n[earlier messages omitted — this is only the most recent part of what you missed]' : '';
  return `THIS LINE IS THE PROMPT — answer THIS:\n${trigger}\n\n`
    + `THE FOLLOWING IS ACCUMULATED CONTEXT — what was said in this conversation since your last turn, oldest first. `
    + `It is BACKGROUND for the prompt above; do not answer it.${note}\n${blocks.join('\n\n')}`;
}

// ── THE QUOTED MESSAGE — one recorded entry, read back by its id ──────────────
// (operator 2026-07-26: someone replied to a message with `@e ubica esto en yotube` and E
// answered "No veo el contenido de #177210". Beeper carries a reply's quoted message ID ONLY —
// no inline quoted text/sender, src/bridges/beeper.mjs:1335 — so ` re #<id>` rode the dispatch
// line and the CONTENT was never resolved anywhere. E was handed a pointer and nothing else.)
//
// The content is already on the record: the quoted message is an entry in THIS file. The walk
// below is the one the voice-note reuse path has used since 2026-07-20 (beeper.mjs
// transcriptionForNoteId), GENERALISED — it was voice-specific for exactly one reason, a marker
// test on the matched entry, so that test moved out to the wrapper and one walk now serves both
// callers. Its home is here, beside contextSinceLastTurn, because this module defines the SHAPE
// of a transcript line (transcriptAppend/replyLine) and every function that reads a line back
// out must key on that definition rather than on a copy of it — and because the spine reads it
// too, which must not mean the spine importing a bridge's parser.
//
// An entry header is an inbound dispatch line ("Sender@[chat].node (HH:MM)…", optionally
// "[ "-wrapped for a stage-direction) OR a being reply ("[@being (HH:MM)]:"). A plain
// continuation line matches NEITHER, so it is kept as body and a multi-line message stays whole.
// The id is the tag directly AFTER the time, so a ` re #<id>` reply tag can never be mistaken
// for an entry's own id. Front matter is dropped with the shared stripFrontMatter so a
// `name:`/`---` line can't match. The id is compared as a STRING extracted from the header, so
// no caller-supplied id is ever spliced into a regex.
const _TS = String.raw`\(\d{1,2}:\d{2}\)`;
const _ENTRY_HEAD = new RegExp(String.raw`^(?:\[\s*)?[^@\n]+@\[[^\]]*\]\.\S+\s+${_TS}|^\[@\S+\s+${_TS}\]:`);
const _ID_AFTER_TS = new RegExp(`${_TS}\\s+#([^\\s:]+)`);   // the message-id tag directly after the time

/**
 * The recorded body of the entry whose OWN message id is `msgId`: the text after the header's
 * `: ` separator, plus every continuation line up to the next entry.
 *
 * NULL when no entry carries that id — a message older than any record, another node's, or one
 * never logged. The caller must then change nothing: never fabricate, never emit an empty block.
 *
 * @param {string} text   transcript.md, front matter included
 * @param {string|number} msgId
 */
export function bodyForMessageId(text, msgId) {
  if (!text || msgId == null) return null;
  const want = String(msgId);
  const lines = stripFrontMatter(String(text)).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    if (!_ENTRY_HEAD.test(head)) continue;                            // only a real entry header
    const idm = head.match(_ID_AFTER_TS);
    if (!idm || idm[1] !== want) continue;                            // …for THIS id
    const colon = head.indexOf(':', idm.index + idm[0].length);       // the separator after `#<id>[ re #<rid>]`
    if (colon < 0) return null;
    const parts = [head.slice(colon + 1)];
    for (let j = i + 1; j < lines.length && !_ENTRY_HEAD.test(lines[j]); j++) parts.push(lines[j]);
    return parts.join('\n').trim() || null;
  }
  return null;
}

/**
 * Append the quoted message to the prompt, LABELLED as the REFERENT — "esto" is that message,
 * and answering it instead of the prompt is the failure from the other direction. The label
 * names the id rather than a position, because this block is appended LAST: with
 * `mode: accum` it lands under the accumulated context, and the id is what ties it back
 * to the ` re #<id>` on the triggering line wherever it sits.
 *
 * Nothing resolved → the line is returned UNCHANGED, so an unresolvable quote prompts exactly
 * as it does today. PROMPT ONLY: no caller writes this back to the transcript or the surface —
 * the quoted message is already further up the record.
 */
export function promptWithQuotedMessage(line, { id, body } = {}) {
  const trigger = String(line ?? '');
  const text = String(body ?? '').trim();
  if (!text) return trigger;
  return `${trigger}\n\nTHE MESSAGE THIS REPLIES TO — #${id}. The prompt is a reply to it: `
    + `this is WHAT the prompt refers to, not what to answer.\n${text}`;
}
