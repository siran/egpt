// Ctrl+← / Ctrl+→ jump by word in the shell composer (operator 2026-09-25: "ctrl-arrow"), as in
// Claude Code's TUI and ordinary shells. Pure reducers; Ink 7 reports Ctrl+Arrow as the arrow key
// with ctrl (Alt+Arrow with meta), and app.mjs routes both to these before plain left/right.
import { describe, it, expect } from 'vitest';
import * as edit from '../src/shell/input.mjs';

const at = (lines, row, col) => ({ lines, row, col });
const pos = (s) => [s.row, s.col];

describe('word jumps (readline-style)', () => {
  const one = ['can we continue the conversation'];

  it('← from mid-word lands on that word\'s start; → on its end', () => {
    expect(pos(edit.wordLeft(at(one, 0, 9)))).toEqual([0, 7]);     // "cont|inue" -> "|continue"
    expect(pos(edit.wordRight(at(one, 0, 9)))).toEqual([0, 15]);   // -> "continue|"
  });

  it('← at a word start goes to the previous word; → at a word end goes to the next', () => {
    expect(pos(edit.wordLeft(at(one, 0, 7)))).toEqual([0, 4]);     // "|continue" -> "|we"
    expect(pos(edit.wordRight(at(one, 0, 6)))).toEqual([0, 15]);   // "we|" -> "continue|"
  });

  it('runs of spaces are skipped', () => {
    const s = ['a    b'];
    expect(pos(edit.wordLeft(at(s, 0, 5)))).toEqual([0, 0]);
    expect(pos(edit.wordRight(at(s, 0, 1)))).toEqual([0, 6]);
  });

  it('a line break counts as whitespace, so the jump wraps across lines', () => {
    const two = ['first line', 'second'];
    expect(pos(edit.wordLeft(at(two, 1, 0)))).toEqual([0, 6]);     // "|second" -> "|line"
    expect(pos(edit.wordRight(at(two, 0, 10)))).toEqual([1, 6]);   // "line|" -> "second|"
    expect(pos(edit.wordRight(at(['a', '', 'b'], 0, 1)))).toEqual([2, 1]);   // across an empty line
  });

  it('at the very start (←) or very end (→) the same state comes back', () => {
    const s0 = at(one, 0, 0);
    expect(edit.wordLeft(s0)).toBe(s0);
    const sEnd = at(one, 0, one[0].length);
    expect(edit.wordRight(sEnd)).toBe(sEnd);
    const e = edit.empty();
    expect(edit.wordLeft(e)).toBe(e);
    expect(edit.wordRight(e)).toBe(e);
  });

  it('only the cursor moves: the lines are untouched', () => {
    const s = at(['x y'], 0, 3);
    expect(edit.wordLeft(s).lines).toBe(s.lines);
  });
});
