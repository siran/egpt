// Telegram "show-think" formatting (operator 2026-06-13).
//
// Per prompt the operator sees TWO Telegram messages:
//   1. an INITIAL streaming message carrying the LIVE thinking — marked 💭 and
//      ending "(thinking... 🤔)" while the turn is in flight; on finish it is
//      FROZEN as the thinking artifact and its suffix flips to "(done ✅)" so
//      the operator can tell AT A GLANCE the turn has finished;
//   2. a CLOSING message with the clean final answer, posted as a reply to the
//      original message.
//
// Two bugs this module fixes (operator 2026-06-13):
//   • "I cant see the 🤔 suffix" — the live thinking body was markdown-rendered
//     (mdToTgHtml) mid-stream, so a partial tail with an unbalanced ** / <tag>
//     made Telegram REJECT the edit; the streamed suffix never landed. The
//     thinking body is now ALWAYS HTML-escaped (never markdown-rendered), which
//     is exactly what the finish path already did for the same reason. Only the
//     CLOSING answer message — which is complete and balanced — is md-rendered.
//   • "how could i know if you finished?" — the frozen artifact carried the SAME
//     "(thinking... 🤔)" suffix as the live one, so finished and in-flight were
//     indistinguishable. `done:true` flips it to "(done ✅)".
//
// "add an empty new line between thinking statements" → spaceThinkStatements.
//
// Pure + exported so tests/show-think.test.mjs locks the shape and the two
// surfaces (resident path + meta-brain path in egpt.mjs) share ONE formatter.

// Live (in-flight) suffix — the operator's exact wording (2026-06-12 01:48:
// "if you are thinking, the message should end with (thinking... 🤔)").
export const THINKING_SUFFIX = '\n\n(thinking... 🤔)';
// Finished suffix — the "you finished" signal that distinguishes the frozen
// thinking artifact from a still-streaming one (operator 2026-06-13 02:05).
export const THOUGHT_SUFFIX = '\n\n(done ✅)';
// Telegram caps messages at 4096 chars; clip the thinking tail with headroom
// for the header + suffix so an edit never bounces on length.
export const THINK_CLIP = 3500;

// A blank line between thinking "statements" so the streamed block is evenly
// spaced (operator 2026-06-13 02:15). Each non-empty line becomes its own
// statement; whitespace-only lines are dropped and existing blank runs collapse
// (no triple-spacing). Leading indentation is preserved.
export function spaceThinkStatements(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))   // trailing whitespace only
    .filter((l) => l.trim().length > 0)
    .join('\n\n');
}

// Compose the 💭 thinking message — the INITIAL streaming message and the
// FROZEN-on-finish artifact are the same shape, differing only by `done`.
//   header — message header WITHOUT a trailing newline, e.g. "💭 <b>wren@kg</b>"
//   body   — RAW thinking text; spaced, clipped, and HTML-escaped here
//   escape — the host's HTML escaper (egpt's escapeHtml); identity by default
//   done   — false → live "(thinking... 🤔)"; true → frozen "(done ✅)"
export function renderThink({ header, body, escape = (s) => String(s ?? ''), done = false } = {}) {
  const h = String(header ?? '').replace(/\s+$/, '');
  const spaced = spaceThinkStatements(body);
  if (!spaced) return `${h}\n\n⌛ thinking…`;
  const clipped = spaced.length > THINK_CLIP ? '…' + spaced.slice(-THINK_CLIP) : spaced;
  return `${h}\n\n${escape(clipped)}${done ? THOUGHT_SUFFIX : THINKING_SUFFIX}`;
}
