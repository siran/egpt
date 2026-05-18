// tools/play-rotate.mjs — ack-based rotation for play.md.
//
// play.md is the shared multi-sibling room. Per memory feedback_play_rotation_lifecycle:
// "rotate when all expected readers have ack'd (or 24h elapsed)". Operator (2026-05-18):
// "it shouldn't be based on how long it is, but if all have read… once read by all it
// should be recycled. if someone hasn't read in a while, it should be nudged."
//
// Policy:
//   - An entry's author is implicit-acked (they wrote it).
//   - Other expected readers must each leave an inline `[NAME: read]` token.
//   - When all expected readers have acked → rotate to play.history.md.
//   - Entries that linger (mtime of play.md older than STALE_HOURS) and still
//     have missing acks → surface as nudges so the daemon can log them.
//   - SIZE cap (HARD_CAP_BYTES) is an emergency backstop only — used when
//     something goes off the rails (e.g. play.md balloons past the cap and
//     ack-based rotation couldn't drain it). Then we drop oldest regardless.
//
// File shape (tolerant):
//   RULE: ...                       ← line 1, header
//                                   ← blank
//   [STATUS:JAY HH:MM] ...          ← STATUS lines, header (preserved)
//   [STATUS:WREN HH:MM] ...
//                                   ← blank
//   ---                             ← separator (optional)
//                                   ← blank
//   NAME [HH:MM]: <body>            ← dialog entry — may span multi-line
//                                   ← blank-line separates entries

import { readFile, writeFile, appendFile, stat } from 'node:fs/promises';

// Expected reader set. Author is automatically implicit-acked. The set is
// the active sibling roster (AN = operator, JAY/WREN = engineer siblings,
// E = persona). Update when new siblings join.
export const EXPECTED_READERS = ['AN', 'JAY', 'WREN', 'E'];

// Emergency backstop only; ack-based rotation is the primary mechanism.
const HARD_CAP_BYTES = 5000;
const TARGET_BYTES   = 3000;

// Stale = play.md hasn't been touched in this many hours AND entry still
// has missing acks. Surface as a nudge so the human or a sibling chases it.
const STALE_HOURS = 4;

/**
 * Split play.md text into:
 *   header — RULE line + STATUS lines + `---` separator (always preserved)
 *   entries — array of dialog-entry strings (multi-line possible)
 */
export function parsePlay(text) {
  const lines = text.split('\n');
  let headerEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/^\s*$/.test(L)) continue;
    if (i === 0 || /^RULE/i.test(L) || /^\[STATUS:/.test(L) || /^---+\s*$/.test(L)) {
      headerEnd = i;
    } else {
      break;
    }
  }
  while (headerEnd + 1 < lines.length && /^\s*$/.test(lines[headerEnd + 1])) headerEnd++;
  const header = lines.slice(0, headerEnd + 1).join('\n');
  const tail = lines.slice(headerEnd + 1).join('\n');

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
 * Parse one entry into { author, time, acks, raw }.
 *   author — leading uppercase identifier ("AN", "JAY", …)
 *   time   — HH:MM from the entry header
 *   acks   — Set of UPPERCASED reader names found via [NAME: read ...] tokens
 *            (author is added automatically)
 * Returns null when the entry doesn't match the expected NAME [HH:MM]: shape.
 */
export function parseEntry(entry) {
  // Accept both formats:
  //   NAME [HH:MM]: body                     (legacy)
  //   NAME [YYYY-MM-DD HH:MM]: body          (operator-requested 2026-05-18)
  const head = entry.match(/^([A-Z][A-Z0-9_-]*)\s*\[([^\]]+)\]\s*:/);
  if (!head) return null;
  const author = head[1].toUpperCase();
  const time = head[2].trim();
  const acks = new Set([author]); // author implicit-acks own entry
  const ackRe = /\[([A-Za-z][A-Za-z0-9_-]*)\s*:\s*read\b/g;
  let m;
  while ((m = ackRe.exec(entry))) acks.add(m[1].toUpperCase());
  return { author, time, acks, raw: entry };
}

/**
 * Classify an entry against the expected reader set.
 *   complete — every expected reader has acked → safe to rotate
 *   partial  — some readers still missing → keep, maybe nudge
 */
export function classifyEntry(parsed, expected = EXPECTED_READERS) {
  if (!parsed) return { status: 'unparseable', missing: [] };
  const missing = expected
    .map(r => r.toUpperCase())
    .filter(r => !parsed.acks.has(r));
  return { status: missing.length === 0 ? 'complete' : 'partial', missing };
}

/**
 * Rotate play.md. Returns:
 *   null                       — no work needed
 *   { rotated, beforeBytes,    — entries moved + sizes
 *     afterBytes, nudges,      — array of {author, time, missing} for stale entries
 *     reason }                 — 'acked' | 'emergency-cap'
 */
export async function rotatePlay({
  playPath,
  historyPath,
  expected = EXPECTED_READERS,
  hardCapBytes = HARD_CAP_BYTES,
  targetBytes = TARGET_BYTES,
  staleHours = STALE_HOURS,
} = {}) {
  let text, mtimeMs;
  try {
    text = await readFile(playPath, 'utf8');
    mtimeMs = (await stat(playPath)).mtimeMs;
  } catch { return null; }

  const beforeBytes = Buffer.byteLength(text, 'utf8');
  const { header, entries } = parsePlay(text);

  // Primary policy: drop entries whose acks are complete. Keep partials.
  const keep = [];
  const rotated = [];
  const nudges = [];
  const ageHours = (Date.now() - mtimeMs) / 3_600_000;

  for (const raw of entries) {
    const parsed = parseEntry(raw);
    const { status, missing } = classifyEntry(parsed, expected);
    if (status === 'complete') {
      rotated.push(raw);
    } else {
      keep.push(raw);
      if (status === 'partial' && ageHours >= staleHours && parsed) {
        nudges.push({ author: parsed.author, time: parsed.time, missing });
      }
    }
  }

  let reason = rotated.length ? 'acked' : null;

  // Emergency backstop — only triggers if ack-based rotation left play.md
  // over the hard cap (e.g., many partial entries piling up because a
  // sibling went silent). Drops from the front until under target.
  let working = keep.slice();
  const sizeOf = (arr) => Buffer.byteLength(
    arr.length ? header + '\n\n' + arr.join('\n\n') + '\n' : header + '\n',
    'utf8',
  );
  if (sizeOf(working) > hardCapBytes) {
    while (sizeOf(working) > targetBytes && working.length > 0) {
      rotated.push(working.shift());
    }
    reason = 'emergency-cap';
  }

  if (rotated.length === 0) return null;

  const newPlay = working.length
    ? header + '\n\n' + working.join('\n\n') + '\n'
    : header + '\n';
  await writeFile(playPath, newPlay, 'utf8');

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const block = `\n## rotated ${stamp} — ${rotated.length} entries (${reason})\n\n${rotated.join('\n\n')}\n`;
  await appendFile(historyPath, block, 'utf8');

  return {
    rotated: rotated.length,
    beforeBytes,
    afterBytes: Buffer.byteLength(newPlay, 'utf8'),
    nudges,
    reason,
  };
}
