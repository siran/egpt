// src/shell/input.mjs — the multi-line compose reducer as PURE functions.
//
// Ported from v1's Ink MultiLineInput (deleted src/shell/ink-limb.mjs) but lifted OUT of
// the component so the cursor math is unit-testable with no TTY. State is a plain
// { lines: string[], row, col }; every function returns a NEW state, never mutates. The
// Ink view (src/shell/app.mjs) holds this in useState and calls these on each keypress.
//
// The load-bearing detail is the d53a947 cursor-advance fix: a single-line insert must
// advance the column FORWARD by `col + chunk.length`, NOT set it to the chunk's length —
// the latter stranded the cursor at position 1 so typing ran backwards ('hello' → 'holle').

// Fresh empty compose state.
export function empty() { return { lines: [''], row: 0, col: 0 }; }

// The composed text (newline-joined lines).
export function text(state) { return state.lines.join('\n'); }

// Insert typed/pasted input at the cursor. `\r\n`/`\r` normalize to `\n`; a multi-line
// paste splices new lines in and lands the cursor at the end of the LAST pasted line.
export function insert(state, input) {
  const { lines, row, col } = state;
  const chunks = String(input).replace(/\r\n?/g, '\n').split('\n');
  const next = lines.slice();
  const before = next[row].slice(0, col);
  const after = next[row].slice(col);
  next[row] = before + chunks[0];
  for (let i = 1; i < chunks.length; i++) next.splice(row + i, 0, chunks[i]);
  const last = row + chunks.length - 1;
  next[last] += after;
  // d53a947: single-line insert moves col FORWARD (col + chunk); a multi-line paste
  // lands on the last line at that chunk's length.
  const nextCol = chunks.length === 1 ? col + chunks[0].length : chunks[chunks.length - 1].length;
  return { lines: next, row: last, col: nextCol };
}

// Backspace/delete: remove the char before the cursor, or at col 0 join into the line above.
export function backspace(state) {
  const { lines, row, col } = state;
  const next = lines.slice();
  if (col > 0) {
    next[row] = next[row].slice(0, col - 1) + next[row].slice(col);
    return { lines: next, row, col: col - 1 };
  }
  if (row > 0) {
    const prevLen = next[row - 1].length;
    next[row - 1] += next[row];
    next.splice(row, 1);
    return { lines: next, row: row - 1, col: prevLen };
  }
  return state;
}

// Enter: split the current line at the cursor into a new line below.
export function newline(state) {
  const { lines, row, col } = state;
  const next = lines.slice();
  const tail = next[row].slice(col);
  next[row] = next[row].slice(0, col);
  next.splice(row + 1, 0, tail);
  return { lines: next, row: row + 1, col: 0 };
}

// Arrow navigation — wraps across line boundaries like a text editor.
export function left(state) {
  const { lines, row, col } = state;
  if (col > 0) return { lines, row, col: col - 1 };
  if (row > 0) return { lines, row: row - 1, col: lines[row - 1].length };
  return state;
}
export function right(state) {
  const { lines, row, col } = state;
  if (col < lines[row].length) return { lines, row, col: col + 1 };
  if (row < lines.length - 1) return { lines, row: row + 1, col: 0 };
  return state;
}
// Ctrl+← / Ctrl+→ (Alt on some terminals) — jump by word, readline-style: ← lands on the start of
// the word the cursor is in, or the previous one; → on the end of the word it is in, or the next
// one. A word is a run of non-whitespace and a line break counts as whitespace, so the jump wraps
// across lines as left/right do. At the very start (←) or end (→) the same state comes back.
const _flat = (lines, row, col) => lines.slice(0, row).reduce((n, l) => n + l.length + 1, 0) + col;
function _at(lines, pos) {
  let row = 0;
  while (row < lines.length - 1 && pos > lines[row].length) { pos -= lines[row].length + 1; row++; }
  return { row, col: pos };
}
export function wordLeft(state) {
  const { lines, row, col } = state;
  const text = lines.join('\n');
  let p = _flat(lines, row, col);
  if (p === 0) return state;
  while (p > 0 && /\s/.test(text[p - 1])) p--;
  while (p > 0 && !/\s/.test(text[p - 1])) p--;
  return { lines, ..._at(lines, p) };
}
export function wordRight(state) {
  const { lines, row, col } = state;
  const text = lines.join('\n');
  let p = _flat(lines, row, col);
  if (p === text.length) return state;
  while (p < text.length && /\s/.test(text[p])) p++;
  while (p < text.length && !/\s/.test(text[p])) p++;
  return { lines, ..._at(lines, p) };
}
export function up(state) {
  const { lines, row, col } = state;
  if (row > 0) { const r = row - 1; return { lines, row: r, col: Math.min(col, lines[r].length) }; }
  return state;
}
export function down(state) {
  const { lines, row, col } = state;
  if (row < lines.length - 1) { const r = row + 1; return { lines, row: r, col: Math.min(col, lines[r].length) }; }
  return state;
}

// Ctrl+A / Ctrl+E — jump to line start / end.
export function home(state) { return { ...state, col: 0 }; }
export function end(state) { return { ...state, col: state.lines[state.row].length }; }
