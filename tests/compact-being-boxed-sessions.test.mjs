// A boxed being's session lives in its own store (~/.egpt-jsonl/<threadId>), not in ~/.claude.
// The compaction probe must find it there BY ID, or no boxed being is ever due. Every root here is
// a temp directory handed in, so nothing reads a real profile.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSessionFile, dueForCompaction } from '../src/tools/compact-being.mjs';

const ID = '53e9e587-384a-4d1b-9795-7e947847292c';
const FOLDER = 'C--Users-an--egpt-rooms-roger';
const usageLine = (n) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 10, cache_read_input_tokens: n, cache_creation_input_tokens: 0 } } });

let root, roots;
const claudeFile = () => join(roots.claudeProjects, FOLDER, `${ID}.jsonl`);
const storeFile = (folder = FOLDER) => join(roots.storeRoot, ID, 'projects', folder, `${ID}.jsonl`);
const put = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'egpt-boxed-sessions-'));
  roots = { claudeProjects: join(root, '.claude', 'projects'), storeRoot: join(root, '.egpt-jsonl') };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('findSessionFile finds a session BY ID in both roots', () => {
  it('REPRODUCE: a boxed session exists only in its own store - it is found there', () => {
    put(storeFile(), usageLine(300000));
    expect(findSessionFile(ID, roots)).toBe(storeFile());
  });

  it('an unboxed session in ~/.claude is still found', () => {
    put(claudeFile(), usageLine(1000));
    expect(findSessionFile(ID, roots)).toBe(claudeFile());
  });

  it('by id, not by folder name: a store copy under any folder is found', () => {
    put(storeFile('C--Users-an--egpt-conversations-whatsapp-renamed-group'), usageLine(1000));
    expect(findSessionFile(ID, roots)).toBe(storeFile('C--Users-an--egpt-conversations-whatsapp-renamed-group'));
  });

  it('when both roots hold the thread (0026 copies, never moves), the one written last wins', () => {
    put(claudeFile(), usageLine(1000));
    put(storeFile(), usageLine(300000));
    const old = new Date('2026-09-20T00:00:00Z'), fresh = new Date('2026-09-24T00:00:00Z');
    utimesSync(claudeFile(), old, old);
    utimesSync(storeFile(), fresh, fresh);
    expect(findSessionFile(ID, roots)).toBe(storeFile());
    utimesSync(claudeFile(), fresh, new Date('2026-09-25T00:00:00Z'));
    expect(findSessionFile(ID, roots)).toBe(claudeFile());
  });

  it('nothing anywhere, or no id: null', () => {
    expect(findSessionFile(ID, roots)).toBe(null);
    expect(findSessionFile('', roots)).toBe(null);
  });

  it('so a boxed session over the threshold is DUE - the defect was { due: false } for every one', () => {
    put(storeFile(), usageLine(300000));
    const due = dueForCompaction({ sessionId: ID, model: 'opus', window: 1_000_000 }, { ratio: 0.25, resolveFile: (id) => findSessionFile(id, roots) });
    expect(due).toMatchObject({ due: true, tokens: 300010, threshold: 250000 });
  });
});
