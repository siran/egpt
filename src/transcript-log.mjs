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
// WHICH NODE committed a line, read back off the record. The frame is invisible on the wire and
// identity.build renders it to `<node>` before the transcript is written, so this reader — not
// decodeNodeSignature — is the one that works on a file. See lastSurfacedBeing below.
import { decodeRenderedNodeSignature } from './node-signature.mjs';

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
 *   @egpt.kg@[SPOILER ALERT: chat de EyAy].wa (07:36) #202360: No, no te creería sin evidencia
 *
 * The file used to carry TWO shapes — `Sender@[chat].node (HH:MM) #id: body` for what was
 * received and `[@being (HH:MM)]: body` for what a being said — and they had already drifted
 * apart (the reply half carried no chat, no surface, no message id, and its clock/label were
 * maintained separately). Routing both through one formatter is what stops that happening
 * again; every field below is a pass-through to it.
 *
 * `being` is the BEING-ID (its `agents:` map key — `egpt`, never the handle `e`), node-qualified
 * `<being>.<node_name>` by the transcript service so the record still says WHICH of two
 * co-account nodes produced the line (provenance, operator 2026-07-10).
 *
 * THE `@` SIGIL IS LOAD-BEARING, not decoration. In this one shape a being's name sits in the
 * same slot a human's display name does, so it is the only thing that still separates "an agent
 * spoke" from "a person spoke" — and three readers turn on exactly that question:
 * lastSurfacedBeing (who `r` addresses — a human line in between must stay irrelevant, operator
 * 2026-07-26), contextSinceLastTurn's boundary, and /status's member roster. It is also the
 * sigil this system already uses for a being everywhere else (`@e`, `@don`, and the `@<being>`
 * membersFromTranscript itself reports).
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
    senderName: `@${being}`,
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
// (above) writes — `@<being>[.<node>]@[<chat>].<surface> (HH:MM)`, and the pre-2026-08-28
// `[@<being>[.<node>] (HH:MM)]:` still on disk — matched at the head of a block:
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

// ── THE TWO SHAPES A REPLY LINE CAN HAVE ON DISK ─────────────────────────────
// Every reader below understands BOTH, and that is permanent, not a migration window: the
// operator's live transcripts are months of history and NOTHING already written is ever
// rewritten (this file is append-only by contract). So a file straddling the 2026-08-28
// change reads correctly end to end — old blocks above, new blocks below.
//
//   NEW — one line shape for the whole file (replyLine → formatDispatchLine):
//     @<being>[.<node>]@[<chat>].<surface> (HH:MM)[ #<id>]: [(not surfaced) |(streaming) ]body
//   OLD — the reply-only template this replaced:
//     [@<being>[.<node>] (HH:MM)]: [(not surfaced) |(streaming) ]body
//
// The `.<node>` provenance qualifier is optional in both (a transcript service wired without
// node_name writes a bare being label), and `[^\s\]@]+` stops it swallowing the `@[` that
// opens the chat in the new shape while still matching the old one's `]`-terminated form.
const _TS = String.raw`\(\d{1,2}:\d{2}\)`;
const _NODE_Q = String.raw`(?:\.[^\s\]@]+)?`;                                   // the optional .<node_name>
const _ID_TAGS = String.raw`(?:\s+#[^\s:]+)?(?:\s+re\s+#[^\s:]+)?`;             // formatDispatchLine's ` #<id>` / ` re #<id>`

const _escapeBeing = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// THIS being's reply line, in either shape — the accum boundary (below).
function beingReplyRe(being) {
  const b = _escapeBeing(String(being ?? '').toLowerCase());
  return new RegExp(`^(?:@${b}${_NODE_Q}@\\[[^\\]]*\\]\\.\\S+\\s${_TS}|\\[@${b}${_NODE_Q}\\s${_TS}\\]:)`, 'i');
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

// ── THE LAST BOT MESSAGE — who `r` addresses ─────────────────────────────────
// (operator 2026-07-27, verbatim: "nono, r is static, it searches the transcript".)
//
// `r <body>` answers the last AGENT that spoke in this conversation, and THE RECORD ANSWERS
// THAT — the file IS the conversation, so the target is READ BACK OUT of it rather than
// remembered. It replaced an in-memory Map in the spine, whose whole failure mode was that it
// was in memory: the live 2026-07-27 hole was E speaking at 23:32, a deploy restarting the node
// at 23:41, and `r cachifa?` at 00:02 doing nothing at all. The operator deploys several times
// an evening, so `r` was broken more often than it worked. A static lookup cannot have that
// hole, needs no clearing rule, and makes "a human spoke in between is irrelevant" free.
//
// SURFACED ONLY. replyLine writes a WITHHELD reply too — tagged `(not surfaced) ` immediately
// after the `]:` — and that turn's text was never posted, so nobody in the chat ever saw it. It
// is not a bot MESSAGE and `r` must not address it. The tag is therefore the filter here.
// DO NOT reuse contextSinceLastTurn's boundary predicate for this: it deliberately MATCHES a
// withheld line, because its question is "what has this being already seen" — the opposite test.
// One line shape, two predicates.
//
// TWO KINDS OF BOT MESSAGE, BECAUSE TWO NODES SHARE THE ACCOUNT (operator 2026-07-27, LIVE: one
// `r qué edad en Pescado Rabioso?` and BOTH nodes answered it — kg correctly, DOLLY unprompted,
// while SAYING that kg had already replied). `r` resolves PER NODE against THAT node's own file,
// and on a shared Beeper account both nodes receive the `r`. A peer's reply is not an agent line
// here: the far spine posted it, so this node wrote NO `[@being …]:` line for it — it arrived as
// an ordinary INBOUND line (isSender, displayed as the account owner). Each node therefore walked
// back to whichever of ITS OWN agents spoke last, and both claimed the message.
//
// So a bot message is EITHER of:
//   (a) THIS node's own surfaced reply line — the `[@being …]:` shape replyLine writes, or
//   (b) an INBOUND line carrying a NODE SIGNATURE — another spine committed that text.
// `r` targets the most recent of the two. When it is (b), ANOTHER NODE'S AGENT HAS THE FLOOR and
// this node returns null, which is the same nobody-addressed outcome as an empty record: `r …`
// stays ordinary text. Exactly one node answers, with no coordination, no lock and no race —
// this is a pure read of what is already written down.
//
// (b) IS READABLE because the signature is STRUCTURAL and already decoded: persona-wrap appends an
// invisible tag-encoded frame to every frame a spine commits (src/node-signature.mjs), and
// identity.build renders it to a legible `<node>` in ev.body before anything reads it — and the
// transcript's inbound line IS that rendered body. decodeRenderedNodeSignature (beside the
// renderer, so the shape has one definition) names the node.
//
// OUR OWN SIGNATURE IS NOT A PEER'S. Our replies carry `<this node>` on the wire too, so if one
// ever re-enters as an inbound line — the bridge's own-send gate is id-based and logs a miss on an
// UNCONFIRMED send — the walk must recognise it as ours and keep going, landing on our own reply
// line above it. Hence `node`: THIS node's name (config node_name, boot-asserted non-empty),
// threaded from the spine. Without it every signed line reads as another node's — the SAFE
// direction, since a missed `r` beats two nodes answering one message.
//
// THE CONTRACT, stated so it is not re-litigated: (a) is the last LOCAL one. A RELAY agent's reply
// (`@don`) is mirrored into the chat by the FAR node and this node writes NO agent line for it —
// src/spine/mesh.mjs never touches the transcript, and the only writers of a `[@being …]:` line
// are the spine's two transcript.log(ev, reply) calls. So `r` after a `@don` forward answers the
// last local being — unless that mirror carried the far node's signature, in which case it is (b)
// and the far node owns the follow-up. That IS the definition.
//
// The node qualifier is stripped (`e.kg` → `e`): the BEING-ID is what routes, and `.<node>` is
// provenance the transcript service adds (src/spine/transcript.mjs).
//
// THE `@` SIGIL IS WHAT MAKES (a) STILL ANSWERABLE. Since 2026-08-28 a being's line uses the
// SAME shape as a human's, so without the leading `@` on the speaker this walk would land on
// whoever spoke last — usually a person — and `r` would stop resolving the moment a human said
// anything after E. That is the exact behaviour operator 2026-07-26 ruled OUT ("human lines in
// between are irrelevant"). Both shapes are matched: the new one and the `[@…]:` still on disk.
const _REPLY_HEAD = new RegExp(
  String.raw`^(?:@([^\s@\[]+?)${_NODE_Q}@\[[^\]]*\]\.\S+\s${_TS}${_ID_TAGS}:`
  + String.raw`|\[@(\S+?)${_NODE_Q}\s${_TS}\]:)`,
);

/**
 * The being-id of the last SURFACED reply line in the transcript, lowercased — or null when this
 * node's agents do not own the last bot message: no agent has spoken here (a fresh chat, or one
 * where every reply was withheld), or a CO-ACCOUNT PEER answered more recently. Both are the same
 * outcome for the caller — `r …` addresses nobody and stays ordinary text — so the return shape is
 * unchanged: one reason to be silent is as good as another, and inventing a second one would only
 * give the spine a branch with nothing to do in it.
 *
 * @param {string} text   transcript.md, front matter included
 * @param {{node?: string|null}} opts
 *        node — THIS node's name (config node_name). Null → every signed line reads as a peer's.
 */
export function lastSurfacedBeing(text, { node = null } = {}) {
  const me = String(node ?? '').trim().toLowerCase();
  const blocks = stripFrontMatter(String(text ?? '')).split(/\n{2,}/);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i].trim();
    const m = b.match(_REPLY_HEAD);
    if (m) {                                                                      // (a) our own reply line
      const rest = b.slice(m[0].length).trimStart();
      if (rest.startsWith('(not surfaced)')) continue;                            // nobody saw it
      // The RAW BYTE TRAIN of a turn (operator 2026-08-27), not a message: those bytes were
      // live edits of a placeholder, and the turn's SETTLED line sits directly below carrying
      // the authority. Skipping keeps `r` resolution byte-identical to before the train was
      // recorded — without this a WITHHELD turn would claim the floor through its own train,
      // the exact opposite of what the `(not surfaced)` skip above decides.
      if (rest.startsWith('(streaming)')) continue;
      return (m[1] ?? m[2]).toLowerCase();                                      // whichever shape matched
    }
    const signer = decodeRenderedNodeSignature(b);                                // (b) a spine committed this
    if (signer == null) continue;                                                 // an ordinary human line
    if (me && signer.toLowerCase() === me) continue;                              // ours, echoed back — keep walking
    return null;                                                                  // a PEER answered last
  }
  return null;
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
// An entry header is a dispatch line — "Sender@[chat].node (HH:MM)…" for a human, the same
// shape with the being's `@` sigil ("@egpt.kg@[chat].wa (HH:MM)…") for a being since
// 2026-08-28, optionally "[ "-wrapped for a stage-direction — OR the pre-2026-08-28 being
// reply ("[@being (HH:MM)]:") still on disk. A plain continuation line matches NONE of them,
// so it is kept as body and a multi-line message stays whole. The id is the tag directly AFTER
// the time, so a ` re #<id>` reply tag can never be mistaken for an entry's own id. Front matter
// is dropped with the shared stripFrontMatter so a `name:`/`---` line can't match. The id is
// compared as a STRING extracted from the header, so no caller-supplied id is ever spliced into
// a regex. (`@?` is all the new shape costs here: `[^@\n]+` still demands a real speaker name
// between the sigil and the `@[`, so an @mention inside a body line stays a continuation.)
const _ENTRY_HEAD = new RegExp(String.raw`^(?:\[\s*)?@?[^@\n]+@\[[^\]]*\]\.\S+\s+${_TS}|^\[@\S+\s+${_TS}\]:`);
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
