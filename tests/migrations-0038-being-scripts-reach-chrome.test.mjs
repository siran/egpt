// tests/migrations-0038-being-scripts-reach-chrome.test.mjs — migrations/0038-being-scripts-reach-chrome-through-the-spine.mjs.
//
// A fixture profile shaped like reve's: being scripts in a chat's desktop/ and media/, a room, the
// heartbeats that name the CDP chrome, and the pointers card.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { plan, withInsert, INSERT, TEXT, CARD_LINES } from '../migrations/0038-being-scripts-reach-chrome-through-the-spine.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const CHAT = join('conversations', 'whatsapp', 'eGPT Rodz Lola An-2609201419');
const LITERAL = "const list = await (await fetch('http://localhost:9221/json')).json();\nconst ws = new WebSocket(list[0].webSocketDebuggerUrl);\n";
const VIA_PORT = 'const PORT = 9221;\nconst r = await fetch(`http://localhost:${PORT}/json/new?x`, { method: \'PUT\' });\n';
const GMAIL = TEXT.find((t) => t.file[1] === 'gmail-watch3-0700.yaml');
const DOJO = TEXT.find((t) => t.file[1] === 'afterschool-session2-watch.yaml');
const CARD = TEXT.find((t) => !t.chat);
const CARD_TEXT = ['# Pointers', '', "The browser is the spine's. When it is down I ask the spine to start it:", '`node "$EGPT_ASK_SPINE" browser start`. I never launch chrome.exe on that', CARD.before, '', "If I don't know something, I look before I say so.", ''];

const FILES = {
  [`${CHAT}/desktop/tab-peek.mjs`]: `// peek\n${LITERAL}`,
  [`${CHAT}/desktop/cli.mjs`]: `#!/usr/bin/env node\r\n${LITERAL.replace(/\n/g, '\r\n')}`,
  [`${CHAT}/desktop/amz.mjs`]: VIA_PORT,
  [`${CHAT}/media/cdp-shot.mjs`]: "const v = await (await fetch('http://127.0.0.1:9221/json/version')).json();\n",
  [`${CHAT}/desktop/own.mjs`]: `import WebSocket from 'ws';\n${LITERAL}`,
  [`${CHAT}/desktop/http.mjs`]: "import http from 'node:http';\nhttp.get('http://localhost:9221/json', () => {});\n",
  [`${CHAT}/desktop/clash.mjs`]: `const [fetch] = [1];\n${LITERAL}`,
  [`${CHAT}/desktop/broken.mjs`]: `const a = ;\n${LITERAL}`,
  [`${CHAT}/desktop/unrelated.mjs`]: "const r = await fetch('http://localhost:3000/');\n",
  [`${CHAT}/desktop/run.sh`]: 'curl -s http://localhost:9221/json/version\n',
  [`${CHAT}/desktop/pdftool/node_modules/lib/index.mjs`]: LITERAL,
  [`${CHAT}/transcripts/old.cli/x.mjs`]: LITERAL,
  [`${CHAT}/heartbeats/gmail-watch3-0700.yaml`]: `daily: "07:00"\nbrowser: true\nagent: e\nprompt: >-\n${GMAIL.before}\n  forward, or change labels.\n`,
  [`${CHAT}/heartbeats/afterschool-session2-watch.yaml`]: `daily: "08:15"\r\nprompt: >-\r\n  Afterschool watch.\r\n${DOJO.before}\r\n  and (b) the packet.\r\n`,
  ['rooms/acim/scripts/acim-lote.x.md']: '1. Browser. If `curl -s http://localhost:9221/json/version` fails, run\n',
  ['rooms/acim/desktop/send.mjs']: "const v = await fetch('http://localhost:9221/json/list');\n",
  ['config/skeletons/room/30-pointers.md']: CARD_TEXT.join('\n'),
};
const EDITED = [`${CHAT}/desktop/tab-peek.mjs`, `${CHAT}/desktop/cli.mjs`, `${CHAT}/desktop/amz.mjs`, `${CHAT}/media/cdp-shot.mjs`, 'rooms/acim/desktop/send.mjs'];
const UNTOUCHED = Object.keys(FILES).filter((f) => !EDITED.includes(f) && !f.endsWith('.yaml') && !f.endsWith('30-pointers.md'));

function home(files = FILES) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0038-')), '.egpt');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(h, rel)), { recursive: true });
    writeFileSync(join(h, rel), text);
  }
  return h;
}
const read = (h, rel) => readFileSync(join(h, rel), 'utf8');
const ctxFor = (h, extra = {}) => ({ egptHome: h, log: () => {}, ...extra });
const vaultOf = (h) => {
  const d = readdirSync(join(h, 'disposable')).filter((n) => /^migration-0038-\d{8}T\d{6}$/.test(n));
  expect(d).toHaveLength(1);
  return join(h, 'disposable', d[0]);
};

describe('0038 on a profile whose being scripts dial localhost:9221', () => {
  it('REPRODUCE: the scripts and prompts name :9221 and nothing routes them through the spine', async () => {
    const h = home();
    expect(read(h, `${CHAT}/desktop/tab-peek.mjs`)).not.toContain('EGPT_CDP');
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes[0]).toBe('scripts: 5 to edit, 0 already carry the line, 4 skipped, 2 proposals (not .mjs, never edited)');
    expect(p.changes[1]).toBe('prompts: 3 lines to replace, 0 already replaced, 5 target files absent on this node');
  });

  it('plans each edit and each skip with its reason; never walks node_modules or transcripts', async () => {
    const h = home();
    const { changes } = await plan(ctxFor(h));
    for (const f of EDITED) expect(changes).toContain(`  + ${f.replace(/\\/g, '/')}`);
    const skip = (f, why) => expect(changes).toContainEqual(expect.stringMatching(new RegExp(`^skip      ${f.replace(/[.+()]/g, '\\$&')} - ${why}`)));
    skip(`${CHAT}/desktop/own.mjs`.replace(/\\/g, '/'), "declares its own fetch/WebSocket \\(`import WebSocket`\\)");
    skip(`${CHAT}/desktop/http.mjs`.replace(/\\/g, '/'), "reaches CDP another way \\(`from 'node:http'`\\)");
    skip(`${CHAT}/desktop/clash.mjs`.replace(/\\/g, '/'), "would not parse with the line \\(node --check: SyntaxError: Identifier 'fetch' has already been declared\\)");
    skip(`${CHAT}/desktop/broken.mjs`.replace(/\\/g, '/'), 'does not parse as it is');
    expect(changes).toContain(`proposal  ${CHAT.replace(/\\/g, '/')}/desktop/run.sh - not a .mjs, never edited: move its CDP calls into a .mjs that starts with the line`);
    expect(changes).toContain('proposal  rooms/acim/scripts/acim-lote.x.md - not a .mjs, never edited: move its CDP calls into a .mjs that starts with the line');
    expect(changes.join('\n')).not.toMatch(/node_modules|transcripts/);
  });

  it('apply: the line goes first (after a shebang), in the file\'s own line endings; skipped files are byte-identical; backups hold the originals', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(read(h, `${CHAT}/desktop/tab-peek.mjs`)).toBe(`${INSERT}\n// peek\n${LITERAL}`);
    expect(read(h, `${CHAT}/desktop/cli.mjs`)).toBe(`#!/usr/bin/env node\r\n${INSERT}\r\n${LITERAL.replace(/\n/g, '\r\n')}`);
    expect(read(h, `${CHAT}/desktop/amz.mjs`)).toBe(`${INSERT}\n${VIA_PORT}`);
    for (const f of UNTOUCHED) expect(read(h, f)).toBe(FILES[f]);
    const vault = vaultOf(h);
    for (const f of [...EDITED, `${CHAT}/heartbeats/gmail-watch3-0700.yaml`, 'config/skeletons/room/30-pointers.md']) expect(readFileSync(join(vault, f), 'utf8')).toBe(FILES[f]);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('idempotent: a second run is satisfied and changes nothing', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    const after = Object.fromEntries(Object.keys(FILES).map((f) => [f, read(h, f)]));
    const again = await plan(ctxFor(h));
    expect(again.satisfied).toBe(true);
    expect(again.notes[0]).toBe('scripts: 0 to edit, 5 already carry the line, 4 skipped, 2 proposals (not .mjs, never edited)');
    expect(again.notes[1]).toBe('prompts: 0 lines to replace, 3 already replaced, 5 target files absent on this node');
    for (const f of Object.keys(FILES)) expect(read(h, f)).toBe(after[f]);
    expect(readdirSync(join(h, 'disposable'))).toHaveLength(1);
  });

  it('a script that fails node --check after the write is restored, and the run fails naming it', async () => {
    const h = home();
    const victim = join(h, `${CHAT}/desktop/amz.mjs`);
    const nodeCheck = ({ file }) => (file === victim ? { ok: false, error: 'SyntaxError: simulated' } : { ok: true });
    const p = await plan(ctxFor(h, { nodeCheck }));
    await expect(p.apply()).rejects.toThrow(/1 script\(s\) did not parse after the insert and were restored as they were:\n.*desktop\/amz\.mjs \(node --check: SyntaxError: simulated\)/);
    expect(read(h, `${CHAT}/desktop/amz.mjs`)).toBe(FILES[`${CHAT}/desktop/amz.mjs`]);
    expect(read(h, `${CHAT}/desktop/tab-peek.mjs`).startsWith(INSERT)).toBe(true);
  });

  it('a file that changed after it was planned refuses before anything is written', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    writeFileSync(join(h, `${CHAT}/desktop/tab-peek.mjs`), '// a being edited me\n');
    await expect(p.apply()).rejects.toThrow(/0038 refuses: .*tab-peek\.mjs changed since it was planned - re-run/);
    expect(read(h, 'rooms/acim/desktop/send.mjs')).toBe(FILES['rooms/acim/desktop/send.mjs']);
    expect(existsSync(join(h, 'disposable'))).toBe(false);
  });
});

describe('0038 prompts — exact-line replacements', () => {
  it('each line is replaced verbatim, the rest of the file byte-identical, LF and CRLF kept', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    expect(read(h, `${CHAT}/heartbeats/gmail-watch3-0700.yaml`)).toBe(FILES[`${CHAT}/heartbeats/gmail-watch3-0700.yaml`].replace(GMAIL.before, GMAIL.after[0]));
    expect(read(h, `${CHAT}/heartbeats/afterschool-session2-watch.yaml`)).toBe(FILES[`${CHAT}/heartbeats/afterschool-session2-watch.yaml`].replace(DOJO.before, DOJO.after[0]));
    expect(read(h, 'config/skeletons/room/30-pointers.md')).toBe([...CARD_TEXT.slice(0, 5), ...CARD_LINES, ...CARD_TEXT.slice(5)].join('\n'));
    expect(GMAIL.after[0]).toContain('await import(process.env.EGPT_CDP)');
    expect(GMAIL.after[0]).not.toContain('the CDP chrome');
  });

  it('the repo card carries the same lines the migration adds', () => {
    const repoCard = readFileSync(join(import.meta.dirname, '..', 'config', 'skeletons', 'room', '30-pointers.md'), 'utf8').split('\n');
    const at = repoCard.indexOf(CARD.before);
    expect(repoCard.slice(at, at + 1 + CARD_LINES.length)).toEqual(CARD.after);
  });

  it('REFUSES when a target file carries neither the line nor its replacement — and changes nothing', async () => {
    const h = home();
    const hb = `${CHAT}/heartbeats/gmail-watch3-0700.yaml`;
    writeFileSync(join(h, hb), FILES[hb].replace('localhost:9221', 'localhost:9221 (a being edited this)'));
    await expect(plan(ctxFor(h))).rejects.toThrow(/0038 refuses: .*gmail-watch3-0700\.yaml has neither the line to replace nor its replacement verbatim/);
    expect(read(h, `${CHAT}/desktop/tab-peek.mjs`)).toBe(FILES[`${CHAT}/desktop/tab-peek.mjs`]);
  });

  it('a target absent on this node (dolly has no such heartbeats) is nothing to do', async () => {
    const h = home({ 'config/skeletons/room/30-pointers.md': CARD_TEXT.join('\n') });
    mkdirSync(join(h, 'conversations', 'whatsapp', 'eGPT Rodz Lola An-2609201420'), { recursive: true });
    const p = await plan(ctxFor(h));
    expect(p.changes.slice(0, 2)).toEqual([
      'scripts: 0 to edit, 0 already carry the line, 0 skipped, 0 proposals (not .mjs, never edited)',
      'prompts: 1 lines to replace, 0 already replaced, 7 target files absent on this node',
    ]);
  });
});

describe('0038 helpers and runner', () => {
  it('withInsert: after a shebang with no newline, and after a BOM', () => {
    expect(withInsert('#!/usr/bin/env node')).toBe(`#!/usr/bin/env node\n${INSERT}\n`);
    expect(withInsert('﻿console.log(1);\r\n')).toBe(`﻿${INSERT}\r\nconsole.log(1);\r\n`);
  });

  it('through the runner: applied and recorded, then in the ledger', async () => {
    const h = home();
    mkdirSync(join(h, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0038');
    writeFileSync(join(h, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-11T00:00:00Z' }]))));
    const run = () => runMigrations({ through: '0038', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    const first = await run();
    expect(first.exitCode).toBe(0);
    expect(first.results.at(-1)).toMatchObject({ id: '0038-being-scripts-reach-chrome-through-the-spine', outcome: 'applied' });
    expect((await run()).results.at(-1).outcome).toBe('in-ledger');
  });
});
