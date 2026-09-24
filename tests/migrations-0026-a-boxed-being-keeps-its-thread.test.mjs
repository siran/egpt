// 0026 — a being moved into the box keeps its thread. Every fixture lives under a temp HOME: the
// migration is handed that home (ctx.homeDir), so nothing here reads the real ~/.claude or
// ~/.egpt-jsonl.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { plan } from '../migrations/0026-a-boxed-being-keeps-its-thread.mjs';

const FOLDER = 'C--Users-an--egpt-conversations-whatsapp-HFM---high-frequency-2607101214';
const T = {
  moved: '915d6617-0000-4000-8000-000000000001',   // don, boxed now, written unboxed: THE DEFECT
  stored: '40467c22-0000-4000-8000-000000000002',  // don, already in its store
  codex: 'c0dec0de-0000-4000-8000-000000000003',   // codex, regular + sandboxed:false: unboxed
  none: 'deadbeef-0000-4000-8000-000000000004',    // don, no session file anywhere
  wren: '6b31bcf5-0000-4000-8000-000000000005',    // the meta engineer: all + sandboxed:false
  plain: 'a11a11a1-0000-4000-8000-000000000006',   // `regular`, no sandboxed line: the platform decides
  local: 'b0b0b0b0-0000-4000-8000-000000000007',   // don, but THIS chat runs him unboxed
};

const CONFIG = [
  'agents:',
  '  don:',
  '    conversation_defaults:',
  '      access_level: sandbox',
  '  codex:',
  '    conversation_defaults:',
  '      access_level: regular',
  '      sandboxed: false',
  '  wren:',
  '    conversation_defaults:',
  '      access_level: all',
  '      sandboxed: false',
  '  plain:',
  '    conversation_defaults:',
  '      access_level: regular',
  '',
].join('\n');

const CONVERSATIONS = [
  'contacts:',
  '  whatsapp:',
  '    chatA:',
  '      agents:',
  '        don:',
  `          threadId: ${T.moved}`,
  '        codex:',
  `          threadId: ${T.codex}`,
  '    chatB:',
  '      agents:',
  '        don:',
  `          threadId: ${T.stored}`,
  '    chatC:',
  '      agents:',
  '        don:',
  `          threadId: ${T.none}`,
  '        plain:',
  `          threadId: ${T.plain}`,
  '    chatD:',
  '      agents:',
  '        don:',
  `          threadId: ${T.local}`,
  '          access_level: all',
  '          sandboxed: false',
  '',
].join('\n');

const AGENTS = ['agents:', '  agent/wren:', '    agents:', '      wren:', `        threadId: ${T.wren}`, ''].join('\n');

let root, home;
const ctx = (over = {}) => ({ id: '0026', egptHome: join(home, '.egpt'), platform: 'win32', homeDir: home, dryRun: false, log: () => {}, ...over });
const claudeFile = (id, folder = FOLDER) => join(home, '.claude', 'projects', folder, `${id}.jsonl`);
const storeFile = (id, folder = FOLDER) => join(home, '.egpt-jsonl', id, 'projects', folder, `${id}.jsonl`);
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'egpt-0026-'));
  home = join(root, 'home');
  put(join(home, '.egpt', 'config', 'config.yaml'), CONFIG);
  put(join(home, '.egpt', 'config', 'conversations.yaml'), CONVERSATIONS);
  put(join(home, '.egpt', 'config', 'agents.yaml'), AGENTS);
  put(claudeFile(T.moved), '{"turn":1}\n{"turn":2}\n');
  put(join(home, '.claude', 'projects', FOLDER, T.moved, 'subagents', 'agent-1.jsonl'), '{"sub":1}\n');
  put(claudeFile(T.codex), '{"codex":1}\n');
  put(claudeFile(T.wren), '{"wren":1}\n');
  put(claudeFile(T.plain), '{"plain":1}\n');
  put(claudeFile(T.local), '{"local":1}\n');
  put(storeFile(T.stored), '{"stored":1}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('0026 — a being moved into the box keeps its thread', () => {
  it('REPRODUCE: a boxed thread written unboxed is only in ~/.claude, where the boxed CLI never looks', async () => {
    expect(existsSync(claudeFile(T.moved))).toBe(true);
    expect(existsSync(storeFile(T.moved))).toBe(false);
    const p = await plan(ctx());
    expect(p.satisfied).toBe(false);
    expect(p.changes.some((l) => l.includes(T.moved))).toBe(true);
  });

  it('copies exactly the boxed threads that are only in ~/.claude, and nothing else', async () => {
    const p = await plan(ctx());
    const named = Object.entries(T).filter(([, id]) => p.changes.some((l) => l.includes(id))).map(([k]) => k).sort();
    expect(named).toEqual(['moved', 'plain']);   // `plain` is boxed on win32, by the platform rung
  });

  it('decides boxed the way a turn does: the platform rung, a per-chat override, the meta engineer', async () => {
    const linux = await plan(ctx({ platform: 'linux' }));
    expect(linux.changes.some((l) => l.includes(T.plain))).toBe(false);   // regular, no line: unboxed off win32
    expect(linux.changes.some((l) => l.includes(T.moved))).toBe(true);    // access_level sandbox forces the box anywhere
    const win = await plan(ctx());
    expect(win.changes.some((l) => l.includes(T.local))).toBe(false);     // this chat runs don unboxed
    expect(win.changes.some((l) => l.includes(T.wren))).toBe(false);      // the meta engineer
    expect(win.changes.some((l) => l.includes(T.codex))).toBe(false);     // sandboxed: false
  });

  it("carries the file into the SAME folder name inside the thread's own store, byte for byte, with its sibling folder", async () => {
    await (await plan(ctx())).apply();
    expect(readFileSync(storeFile(T.moved), 'utf8')).toBe('{"turn":1}\n{"turn":2}\n');
    expect(readFileSync(join(home, '.egpt-jsonl', T.moved, 'projects', FOLDER, T.moved, 'subagents', 'agent-1.jsonl'), 'utf8')).toBe('{"sub":1}\n');
  });

  it('copies, never moves: the ~/.claude file is still there afterwards', async () => {
    await (await plan(ctx())).apply();
    expect(readFileSync(claudeFile(T.moved), 'utf8')).toBe('{"turn":1}\n{"turn":2}\n');
  });

  it('is satisfied once applied, and names the thread it has nothing to copy for', async () => {
    await (await plan(ctx())).apply();
    const again = await plan(ctx());
    expect(again.satisfied).toBe(true);
    expect(again.notes.join('\n')).toContain(T.none.slice(0, 8));
  });

  it('finds the thread BY ID: a store copy under another folder name counts, and nothing is copied over it', async () => {
    put(storeFile(T.moved, 'C--Users-an--egpt-conversations-whatsapp-renamed-group'), '{"newer":1}\n');
    const p = await plan(ctx());
    expect(p.changes.some((l) => l.includes(T.moved))).toBe(false);
  });

  it('never overwrites: a file that appears between plan and apply is left as it is', async () => {
    const p = await plan(ctx());
    put(storeFile(T.moved), '{"arrived":1}\n');
    await p.apply();
    expect(readFileSync(storeFile(T.moved), 'utf8')).toBe('{"arrived":1}\n');
  });

  it('refuses, naming the file, when a config file does not parse', async () => {
    put(join(home, '.egpt', 'config', 'conversations.yaml'), 'contacts:\n  whatsapp: [unclosed\n');
    await expect(plan(ctx())).rejects.toThrow(/conversations\.yaml does not parse/);
  });
});
