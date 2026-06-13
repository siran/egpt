// transcript-log.mjs — build the bytes appended to a chat's transcript.md for
// ONE line (an inbound message or a being's reply).
//
// Limb-agnostic (C1.2 / I3): every surface + every being routes through this so a
// received message — or a reply, surfaced or withheld — always lands in
// conversations/<surface>/<slug>/transcript.md. The regression this guards
// against: the bot→Wren `forceTarget` route bypassed runDefaultBrainTurn's logger
// and Telegram went unlogged. The IO wrapper lives in egpt.mjs (`_logChatLine`).
//
// Pure + Node-import-free (so it can't drag node builtins into a bundled limb).
import { renderFrontMatter } from './transcript-meta.mjs';

/**
 * Bytes to append for one transcript line. Prepends the YAML front matter when
 * the transcript is new (`existing` false). THROWS on an empty body so a
 * received message can never be silently dropped — a "logged nothing" is a bug,
 * not a no-op.
 */
export function transcriptAppend({ existing = false, body, name, surface, slug, threadId, persona } = {}) {
  const text = String(body ?? '').trim();
  if (!text) throw new Error('transcriptAppend: empty body — a received message must not be silently dropped');
  const header = existing
    ? ''
    : renderFrontMatter({ name: name ?? threadId ?? slug, surface, slug, thread_id: threadId, persona });
  return header + text + '\n\n';
}

/**
 * Format a being's reply line for the transcript: `[<being> (HH:MM)]: body`,
 * tagged `(not surfaced)` when the reply was withheld by the gate/mode.
 */
export function replyLine({ being, body, surfaced = true, now = new Date() } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const t = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
  const tag = surfaced ? '' : '(not surfaced) ';
  return `[@${being} (${t})]: ${tag}${String(body ?? '').trim()}`;
}
