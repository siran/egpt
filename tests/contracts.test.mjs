// tests/contracts.test.mjs — every CONTRACTS.md id is claimed by a test (`// contract n.m` on the
// line above its it(/describe(), or tests/contracts-gaps.json says why not. The gap list only shrinks.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = join(ROOT, 'tests');

// n.m sub-items; a top-level item is an id only when it has none.
function contractIds(md) {
  const ids = [];
  let top = null, hasSub = false;
  const close = () => { if (top && !hasSub) ids.push(top); };
  for (const line of md.split('\n')) {
    let m;
    if ((m = /^(\d+)\.\s/.exec(line))) { close(); top = m[1]; hasSub = false; }
    else if ((m = /^\s+(\d+)\.(\d+)\s/.exec(line))) {
      if (m[1] !== top) throw new Error(`CONTRACTS.md: ${m[1]}.${m[2]} sits under item ${top}`);
      ids.push(`${m[1]}.${m[2]}`);
      hasSub = true;
    }
  }
  close();
  return ids;
}

const MARK = /^\s*\/\/\s*contract\s+(\d\S*)/;
const CALL = /^\s*(?:it|test|describe)([.\w]*)\s*\(/;

// { id, where, problem } per marker; problem is null when it tags a running it/describe.
function markers() {
  const out = [];
  const files = readdirSync(TESTS, { recursive: true }).filter((f) => f.endsWith('.test.mjs'));
  for (const f of files) {
    const lines = readFileSync(join(TESTS, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = MARK.exec(line);
      if (!m) return;
      let j = i + 1;
      while (j < lines.length && /^\s*\/\//.test(lines[j])) j++;
      const call = CALL.exec(lines[j] ?? '');
      const problem = !call ? 'tags no it/describe on the next code line'
        : /\.(skip|todo)\b/.test(call[1]) ? 'tags a skipped test' : null;
      out.push({ id: m[1], where: `${relative(ROOT, join(TESTS, f)).replace(/\\/g, '/')}:${i + 1}`, problem });
    });
  }
  return out;
}

const IDS = contractIds(readFileSync(join(ROOT, 'CONTRACTS.md'), 'utf8'));
const MARKS = markers();
const GAPS = JSON.parse(readFileSync(join(TESTS, 'contracts-gaps.json'), 'utf8'));
const TESTED = new Set(MARKS.filter((m) => !m.problem).map((m) => m.id));

describe('CONTRACTS.md — every contract is protected by a test', () => {
  it('parses the contract ids', () => {
    expect(IDS.length).toBeGreaterThan(40);
    expect(new Set(IDS).size).toBe(IDS.length);
  });

  it('(a) every contract has a test, or a reason on the gap list', () => {
    const missing = IDS.filter((id) => !TESTED.has(id) && !(id in GAPS))
      .map((id) => `contract ${id} has no test: tag one with \`// contract ${id}\` or list it in tests/contracts-gaps.json`);
    expect(missing).toEqual([]);
  });

  it('(b) every marker names a real contract and tags a running it/describe', () => {
    const known = new Set(IDS);
    const bad = MARKS.filter((m) => !known.has(m.id) || m.problem)
      .map((m) => `${m.where}: contract ${m.id} ${known.has(m.id) ? m.problem : 'is not in CONTRACTS.md'}`);
    expect(bad).toEqual([]);
  });

  it('(c) the gap list names only real contracts that still have no test', () => {
    const known = new Set(IDS);
    const stale = Object.entries(GAPS).flatMap(([id, why]) =>
      !known.has(id) ? [`gap ${id} is not in CONTRACTS.md`]
        : TESTED.has(id) ? [`gap ${id} now has a test: remove it from tests/contracts-gaps.json`]
          : typeof why !== 'string' || !why.trim() ? [`gap ${id} has no reason`] : []);
    expect(stale).toEqual([]);
  });
});
