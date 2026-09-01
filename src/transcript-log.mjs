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
import { formatDispatchLine } from './dispatch-line.mjs';

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
 * Format a being's reply line for the transcript. ONE LINE SHAPE FOR THE WHOLE FILE
 * (operator 2026-08-28, reading a live transcript: "the correct format is 'e' outside the
 * [], and better egpt instead of e") — a being's utterance reads like every other utterance
 * in the file, so this is THE inbound formatter (dispatch-line.formatDispatchLine), not a
 * second near-identical template beside it:
 *
 *   egpt@[SPOILER ALERT: chat de EyAy].wa (07:36) #202360: No, no te creería sin evidencia
 *
 * The file used to carry TWO shapes — `Sender@[chat].node (HH:MM) #id: body` for what was
 * received and `[@being (HH:MM)]: body` for what a being said — and they had already drifted
 * apart (the reply half carried no chat, no surface, no message id, and its clock/label were
 * maintained separately). Routing both through one formatter is what stops that happening
 * again; every field below is a pass-through to it.
 *
 * NO SIGIL, NO DISTINCTION (operator 2026-08-28: "an agent is just another participant in a
 * room"). The speaker is written BARE, exactly as a person's display name is, and `being` is
 * the agent's NAME — its `agents:` `name:`, else its map key, resolved by the ONE resolver
 * (boot.mjs labelOf) and handed in by the transcript service. Two things went with the sigil,
 * on purpose: the `r` quick reply, which needed a reader that could tell an agent line from a
 * human one, was evicted the same day; and the `.<node_name>` provenance qualifier, redundant
 * once the label is the name — names are unique across a shared account by construction, since
 * both nodes hear every message.
 *
 * HH:MM renders in `timeZone` — the node's config `default_time_zone` — through the formatter's
 * own `hhmm`, so the two halves of a transcript can no longer disagree about what time it is
 * even in principle. Unset/invalid → UTC (operator 2026-07-26).
 *
 * `msgId` — the posted message's id, making the line addressable for `/react` / `/reply` the way
 * an inbound line is (MESSAGES-FIRST-CLASS plan). Omitted when absent, which is every caller
 * today: the spine records the reply BEFORE it is delivered (record-first is durability), so at
 * write time no id exists yet. The slot is here so the id lands the moment a caller has one.
 *
 * `streaming` opens the RAW BYTE TRAIN of a turn (operator 2026-08-27: "whatever reply is
 * emitted by model (the bytes) gets written into the transcript"). Its body is EMPTY here —
 * the model's own bytes are appended after it as they arrive, so the block grows in place
 * (src/spine/transcript.mjs logStream) and the settled reply still lands as its own line
 * below it. The tag rides the SAME slot `(not surfaced) ` uses because it answers the same
 * question about the same line shape — a reader (human or model) must be able to tell the
 * train from the record, and every predicate keyed on this shape keeps working. Both tags now
 * open the BODY rather than following a `]:`, which is the same position relative to the
 * `: ` separator they always had.
 */
export function replyLine({ being, body, surfaced = true, streaming = false, now = new Date(), timeZone = null, chatName = null, node = null, surface = null, msgId = null } = {}) {
  const tag = streaming ? '(streaming) ' : (surfaced ? '' : '(not surfaced) ');
  return formatDispatchLine({
    senderName: being,
    chatName, node, surface, msgId, timeZone,
    ts: now,
    body: `${tag}${String(body ?? '').trim()}`,
  });
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
// (above) writes — `<name>@[<chat>].<surface> (HH:MM)`, plus the two older shapes still on
// disk (see below) — matched at the head of a block:
//   - only THIS being's line is the boundary; another agent's reply is part of the gap
//     (E did not see it either),
//   - a WITHHELD reply counts: `(not surfaced) ` opens the BODY, past the head, so it matches — and
//     it SHOULD, because that turn ran and the being saw everything before it,
//   - a being that has never replied here has no boundary → the whole tail.
//
// SIZE IS THE ONLY BOUND. If the being has not spoken in a chat for days the gap can be
// enormous, so `maxChars` caps it, keeping the MOST RECENT blocks (the ones nearest the
// prompt) and reporting `truncated` so the caller can SAY the gap is partial instead of
// letting the model believe it has all of it. A CONSTANT, deliberately — the mode is the
// only switch this behaviour has, and it is not getting a config knob beside it.
export const RECENT_CONTEXT_MAX_CHARS = 8000;

// ── THE SHAPES A REPLY LINE CAN HAVE ON DISK ─────────────────────────────────
// The reader below understands ALL of them, and that is permanent, not a migration window: the
// operator's live transcripts are months of history and NOTHING already written is ever
// rewritten (this file is append-only by contract). So a file straddling the 2026-08-28
// changes reads correctly end to end — old blocks above, new blocks below.
//
//   NEW — no sigil, no node qualifier, the speaker is the agent's NAME (operator 2026-08-28):
//     <name>@[<chat>].<surface> (HH:MM)[ #<id>]: [(not surfaced) |(streaming) ]body
//   OLD — the same shape carrying the being's `@` sigil and `.<node>` provenance:
//     @<being>[.<node>]@[<chat>].<surface> (HH:MM)[ #<id>]: …
//   OLDER — the reply-only template both of those replaced:
//     [@<being>[.<node>] (HH:MM)]: [(not surfaced) |(streaming) ]body
//
// Sigil and qualifier are therefore both OPTIONAL here, and `[^\s\]@]+` stops the qualifier
// swallowing the `@[` that opens the chat while still matching the `]`-terminated older form.
const _TS = String.raw`\(\d{1,2}:\d{2}\)`;
const _NODE_Q = String.raw`(?:\.[^\s\]@]+)?`;                                   // the optional .<node_name>

const _escapeBeing = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// THIS being's reply line, in any of the shapes above — the accum boundary (below). Takes a
// LIST of the being's own labels because a straddling file carries more than one of them: new
// blocks say the NAME (`don`), old blocks say the map KEY (`egpt`), and on a node where the two
// differ neither alone finds the boundary. The caller passes both; the match is on either.
function beingReplyRe(beings) {
  const alt = [beings].flat().filter(Boolean).map((b) => _escapeBeing(String(b).toLowerCase())).join('|');
  return new RegExp(`^(?:@?(?:${alt})${_NODE_Q}@\\[[^\\]]*\\]\\.\\S+\\s${_TS}|\\[@(?:${alt})${_NODE_Q}\\s${_TS}\\]:)`, 'i');
}

/**
 * The conversation blocks recorded since `being`'s last reply — oldest first.
 *
 * AN ENTRY IS NOT ALWAYS ONE BLOCK (operator 2026-08-29, the "restart didn't clear the accum"
 * incident). transcriptAppend/replyLine end `\n\n`, so an entry whose body has no blank line
 * IS one blank-line-separated block — but a multi-paragraph body is written as SEVERAL, and
 * only the FIRST carries the `<name>@[<chat>].<surface> (HH:MM):` head. Walking backward, the
 * headerless paragraphs of the being's own last reply were therefore collected BEFORE the
 * boundary was reached, and the being was re-fed the tail of what it had just said, labelled
 * "what was said since your last turn", on every accum turn.
 *
 * So a HEADERLESS block belongs to the entry above it: it is held pending until an entry head
 * is reached (_ENTRY_HEAD — the SAME definition bodyForMessageId reads entries with, below),
 * and then included or dropped WITH that entry. A human's continuation paragraphs are equally
 * headerless and equally real context — only the run belonging to the BOUNDARY reply is
 * dropped, which is why the pending buffer is discarded exactly there and flushed everywhere
 * else. The cap applies to the whole entry, so a block never lands without its head.
 *
 * @param {string} text      transcript.md, front matter included
 * @param {{being?: string|string[], maxChars?: number, exclude?: string}} opts
 *        being — the being's label(s): its NAME (what new blocks carry) and its map KEY
 *        (what old blocks carry). Either matches; see beingReplyRe.
 *        exclude — the TRIGGERING line, which was already appended at ingestion: it is
 *        THE prompt, so it must never also appear as context.
 * @returns {{ blocks: string[], truncated: boolean }}
 */
export function contextSinceLastTurn(text, { being = null, maxChars = RECENT_CONTEXT_MAX_CHARS, exclude = null } = {}) {
  const blocks = stripFrontMatter(String(text ?? '')).split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const mine = [being].flat().filter(Boolean).length ? beingReplyRe(being) : null;
  const skip = String(exclude ?? '').trim();
  const out = [];
  let used = 0, truncated = false;
  // ONE entry — its head plus the continuation blocks it owns, newest-first like the walk.
  // False = the cap is reached, so the caller stops (`out` stays whole-entry aligned).
  const take = (entry) => {
    const keep = entry.filter((b) => !(skip && b === skip));                    // the prompt itself
    const size = keep.reduce((n, b) => n + b.length, 0);
    if (used + size > maxChars) { truncated = true; return false; }             // cap: keep the most recent
    used += size;
    out.push(...keep);
    return true;
  };
  let pending = [];                                                             // headerless blocks awaiting their head
  let i = blocks.length - 1;
  for (; i >= 0; i--) {
    const b = blocks[i];
    if (!_ENTRY_HEAD.test(b)) { pending.push(b); continue; }                    // a continuation of the entry below
    if (mine && mine.test(b)) { pending = []; break; }                          // the boundary — it and its own tail are already in the session
    if (!take([...pending, b])) break;
    pending = [];
  }
  if (i < 0 && pending.length) take(pending);                                   // continuations with no head in the file
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
// An entry header is a dispatch line — "Sender@[chat].node (HH:MM)…" — whoever spoke, human or
// agent (operator 2026-08-28: no sigil, no distinction), optionally "[ "-wrapped for a
// stage-direction, and optionally carrying the older being sigil ("@egpt.kg@[chat].wa (HH:MM)…")
// still on disk — OR the older-still reply template ("[@being (HH:MM)]:"). A plain continuation
// line matches NONE of them, so it is kept as body and a multi-line message stays whole. The id
// is the tag directly AFTER the time, so a ` re #<id>` reply tag can never be mistaken for an
// entry's own id. Front matter is dropped with the shared stripFrontMatter so a `name:`/`---`
// line can't match. Since 2026-09-01 the reply reference no longer sits between them at all —
// it opens the BODY as `[re #<id>] ` (dispatch-line.formatDispatchLine) — but the id is still
// read as the tag directly after the time, so the OLD shape still on disk (` re #<rid>:`) reads
// exactly as it always did: this file is append-only and months of history keep both.
// The id is compared as a STRING extracted from the header, so no
// caller-supplied id is ever spliced into a regex. (`@?` is all the old sigil costs here:
// `[^@\n]+` still demands a real speaker name before the `@[`, so an @mention inside a body
// line stays a continuation.)
const _ENTRY_HEAD = new RegExp(String.raw`^(?:\[\s*)?@?[^@\n]+@\[[^\]]*\]\.\S+\s+${_TS}|^\[@\S+\s+${_TS}\]:`);
const _ID_AFTER_TS = new RegExp(`${_TS}\\s+#([^\\s:]+)`);   // the message-id tag directly after the time
// The `[re #<id>] ` prefix formatDispatchLine puts at the FRONT OF THE BODY since 2026-09-01
// (the legibility move: the reference used to sit bare between the id and the `:`). It is a HEAD
// field wearing a body's clothes — it names what the message ANSWERS, not what it SAYS — so it
// comes back off here. That is what keeps this reader's contract byte-identical across the move:
// every caller that asks this module for "the recorded body" (promptWithQuotedMessage's quoted
// text, beeper.transcriptionForNoteId's `(voice transcription, Ns)` marker test) gets exactly the
// bytes it got when the reference lived before the colon. Anchored + `[^\]\s]+`, so an ordinary
// body that merely starts with a bracket is untouched.
const _REPLY_REF = /^\s*\[re #[^\]\s]+\]\s*/;

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
    const colon = head.indexOf(':', idm.index + idm[0].length);       // the separator after `#<id>` (or, on pre-2026-09-01 lines, after `#<id> re #<rid>`)
    if (colon < 0) return null;
    const parts = [head.slice(colon + 1).replace(_REPLY_REF, '')];   // see _REPLY_REF: the reply reference is head, not body
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
