// src/shell/history-file.mjs — the shell's input history on disk, so ↑ reaches past sessions.
//
// WHY A FILE (operator 2026-09-25: "is it possible to have cross session history?"). history.mjs's
// buffer lives in the editor's memory, so every reconnect - every spine restart - began with an
// empty ↑ ("not sure if up/down"). Each submitted entry is appended here and the editor loads the
// last HISTORY_CAP at start. One JSON string per line, because an entry can span lines; oldest
// first; under the node's own profile, the same EGPT_HOME every other state file uses.
//
// A missing, empty or partly unreadable file never stops the editor: a line that does not parse
// to a string is skipped and the history just starts shorter. A failed write is swallowed - the
// history is a convenience, the send already happened.
//
// ITS OWN MODULE only so the tests can reach it: egpt.mjs starts the app when imported, and
// app.mjs is the TTY-bound Ink view the editor tests (tests/shell-editor.test.mjs) leave alone.
import { readFileSync, appendFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EGPT_HOME } from '../egpt-home.mjs';

export const HISTORY_CAP = 1000;

export function historyFileOf(egptHome = EGPT_HOME) {
  return join(egptHome, 'state', 'shell-history.jsonl');
}

function readEntries(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const v = JSON.parse(line); if (typeof v === 'string') out.push(v); } catch { /* a torn or foreign line */ }
  }
  return out;
}

// The last `cap` entries, oldest first. Consecutive repeats are collapsed by history.fromEntries.
export function loadHistory(file, cap = HISTORY_CAP) {
  return readEntries(file).slice(-cap);
}

// Append one submitted entry. Once the file holds twice the cap it is rewritten to the last `cap`
// (temp + rename), so it never grows without bound and is not rewritten on every send.
export function recordHistory(file, entry, cap = HISTORY_CAP) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(String(entry))}\n`, 'utf8');
    const entries = readEntries(file);
    if (entries.length >= cap * 2) {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, entries.slice(-cap).map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      renameSync(tmp, file);
    }
  } catch { /* the send already happened; losing one history line is not worth an error */ }
}
