// tools/play-rotate.mjs — token-tight enforcement for play.md.
//
// play.md is the shared multi-sibling room. Per memory feedback_play_token_tidiness:
// "play.md is loaded into every LLM's context every turn. Char × N reads × $/Mtok =
// real money. Keep TINY. Bulk-rotate to history aggressively."
//
// Policy was reader-ack based; enforcement was manual. This adds machine-enforced
// caps: when play.md grows past TARGET_BYTES, rotate the OLDEST dialog entries
// to play.history.md until size <= TARGET_BYTES. Exempt: the leading RULE line +
// the [STATUS:NAME ...] block at the top.
//
// File shape this expects (tolerant):
//
//   RULE: ...                       ← line 1, always preserved
//                                   ← blank
//   [STATUS:JAY HH:MM] ...          ← any number of STATUS lines, preserved
//   [STATUS:WREN HH:MM] ...
//   ...
//                                   ← blank
//   ---                             ← separator (optional)
//                                   ← blank
//   NAME [HH:MM]: <body>            ← dialog entry (rotatable)
//   NAME [HH:MM]: <body>            ← can span multiple lines
//   ...

import { readFile, writeFile, appendFile } from 'node:fs/promises';

const TARGET_BYTES = 2000;   // rotate down to ≤ this when over cap
const HARD_CAP_BYTES = 2500; // trigger threshold

/**
 * Split play.md text into:
 *   header — RULE line + STATUS lines (always preserved, may include the `---` separator)
 *   entries — array of dialog-entry strings (each may be multi-line)
 *
 * Heuristic: header runs from start through (and including) the `---` separator
 * line if present; otherwise through the last STATUS-prefixed line. Everything
 * after is treated as dialog entries, split on blank lines.
 */
export function parsePlay(text) {
  const lines = text.split('\n');
  let headerEnd = 0;
  // Find last index that's RULE, STATUS, or ---. Scan forward until we hit a
  // dialog-looking line (NAME [HH:MM]:).
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/^\s*$/.test(L)) continue;
    if (i === 0 || /^RULE/i.test(L) || /^\[STATUS:/.test(L) || /^---+\s*$/.test(L)) {
      headerEnd = i;
    } else {
      break;
    }
  }
  // Include any trailing blank line after the last header line.
  while (headerEnd + 1 < lines.length && /^\s*$/.test(lines[headerEnd + 1])) headerEnd++;
  const header = lines.slice(0, headerEnd + 1).join('\n');
  const tail = lines.slice(headerEnd + 1).join('\n');

  // Split tail into entries: groups of non-blank lines separated by blank lines.
  const entries = [];
  let buf = [];
  for (const L of tail.split('\n')) {
    if (/^\s*$/.test(L)) {
      if (buf.length) { entries.push(buf.join('\n')); buf = []; }
    } else {
      buf.push(L);
    }
  }
  if (buf.length) entries.push(buf.join('\n'));
  return { header, entries };
}

/**
 * Rotate oldest entries from play.md into play.history.md until play.md is
 * under TARGET_BYTES. Returns { rotated: N, beforeBytes, afterBytes }.
 * No-op (returns null) when file is already under HARD_CAP_BYTES.
 */
export async function rotatePlay({ playPath, historyPath, targetBytes = TARGET_BYTES, hardCapBytes = HARD_CAP_BYTES } = {}) {
  let text;
  try { text = await readFile(playPath, 'utf8'); }
  catch { return null; }
  const beforeBytes = Buffer.byteLength(text, 'utf8');
  if (beforeBytes <= hardCapBytes) return null;

  const { header, entries } = parsePlay(text);
  const rotated = [];
  let remaining = entries.slice();

  // Drop entries from the front until under target, leaving the header intact.
  while (Buffer.byteLength(header + '\n\n' + remaining.join('\n\n') + '\n', 'utf8') > targetBytes
         && remaining.length > 0) {
    rotated.push(remaining.shift());
  }
  if (rotated.length === 0) return null;

  const newPlay = remaining.length
    ? header + '\n\n' + remaining.join('\n\n') + '\n'
    : header + '\n';
  await writeFile(playPath, newPlay, 'utf8');

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const block = `\n## rotated ${stamp} — ${rotated.length} entries\n\n${rotated.join('\n\n')}\n`;
  await appendFile(historyPath, block, 'utf8');

  return {
    rotated: rotated.length,
    beforeBytes,
    afterBytes: Buffer.byteLength(newPlay, 'utf8'),
  };
}
