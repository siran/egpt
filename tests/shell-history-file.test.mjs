// The shell's ↑ history survives sessions (operator 2026-09-25: "is it possible to have cross
// session history?"). Every file here is under a temp dir; nothing touches the real profile.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as hist from '../src/shell/history.mjs';
import { historyFileOf, loadHistory, recordHistory, HISTORY_CAP } from '../src/shell/history-file.mjs';

let root, file;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'egpt-shell-history-')); file = historyFileOf(join(root, '.egpt')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the shell history survives sessions', () => {
  it('REPRODUCE: a fresh session recalls the previous session\'s last entry with ↑', () => {
    recordHistory(file, '/rooms');
    recordHistory(file, 'can we continue the conversation?');
    const fresh = hist.fromEntries(loadHistory(file));   // what a new editor starts from
    const r = hist.up(fresh, '');
    expect(r.text).toBe('can we continue the conversation?');
    expect(hist.up(r.state, '').text).toBe('/rooms');
  });

  it('lives in the node\'s own profile, under state/', () => {
    expect(historyFileOf(join(root, '.egpt'))).toBe(join(root, '.egpt', 'state', 'shell-history.jsonl'));
    recordHistory(file, 'x');
    expect(existsSync(file)).toBe(true);
  });

  it('a multi-line entry comes back exactly as sent', () => {
    const entry = 'first line\n\n  indented second\nthird';
    recordHistory(file, entry);
    expect(loadHistory(file)).toEqual([entry]);
    expect(hist.up(hist.fromEntries(loadHistory(file)), '').text).toBe(entry);
  });

  it('consecutive repeats are kept once; a repeat further back is kept', () => {
    const b = hist.fromEntries(['a', 'a', 'b', 'b', 'b', 'a']);
    expect(b.entries).toEqual(['a', 'b', 'a']);
    expect(b.cursor).toBe(null);
  });

  it('a torn or foreign line is skipped, and the rest still loads', () => {
    writeFileSync(join(root, 'h.jsonl'), '"one"\n{not json\n42\n"two"\n\n');
    expect(loadHistory(join(root, 'h.jsonl'))).toEqual(['one', 'two']);
  });

  it('a missing or empty file is an empty history, not an error', () => {
    expect(loadHistory(join(root, 'nope.jsonl'))).toEqual([]);
    writeFileSync(join(root, 'empty.jsonl'), '');
    expect(loadHistory(join(root, 'empty.jsonl'))).toEqual([]);
    expect(hist.fromEntries(loadHistory(join(root, 'nope.jsonl')))).toEqual(hist.empty());
  });

  it('holds the cap: loads the last N, and rewrites the file to N once it reaches twice that', () => {
    const cap = 5;
    for (let i = 1; i <= 9; i++) recordHistory(file, `e${i}`, cap);
    expect(loadHistory(file, cap)).toEqual(['e5', 'e6', 'e7', 'e8', 'e9']);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(9);   // not rewritten yet
    recordHistory(file, 'e10', cap);                                          // 10 = 2 x cap
    expect(readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual(['e6', 'e7', 'e8', 'e9', 'e10']);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(HISTORY_CAP).toBe(1000);
  });

  it('a write that cannot land never throws into the editor', () => {
    writeFileSync(join(root, 'blocker'), 'a file where a directory should be');
    expect(() => recordHistory(join(root, 'blocker', 'shell-history.jsonl'), 'x')).not.toThrow();
  });
});
