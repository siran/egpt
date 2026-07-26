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
import { renderFrontMatter } from './transcript-meta.mjs';
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
