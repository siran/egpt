// 0044 — one loop_guard: block, in config.yaml and every registry entry; plus the one-release read
// of the pre-0044 keys (src/loop-guard.mjs loopGuardConfig / inboundOverrideOf) and the rename's own check: no "lasso" left outside this file, the migration
// and the legacy-key constant.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';
import { loopGuardConfig, inboundOverrideOf, legacyEntryCount, LEGACY_BLOCKS } from '../src/loop-guard.mjs';

// egpt-home.mjs reads EGPT_HOME once at load: set it first, import what derives from it after.
const bootHome = join(tmpdir(), `egpt-0044-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = bootHome;
let plan, runMigrations, listMigrations, MIGRATIONS_DIR, boot;
beforeAll(async () => {
  ({ plan } = await import('../migrations/0044-the-loop-guard-is-one-block.mjs'));
  ({ runMigrations, listMigrations, MIGRATIONS_DIR } = await import('../setup/migrate.mjs'));
  ({ boot } = await import('../src/spine/boot.mjs'));
});
afterAll(() => { delete process.env.EGPT_HOME; rmSync(bootHome, { recursive: true, force: true }); });

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const lf = (lines) => lines.map((l) => `${l}\n`).join('');

// reve, 2026-10-18: a guard: block, no lasso:.
const REVE = [
  'log_to_group: eGPT Admin',
  'super_chats:',
  '  enabled: false',
  'guard:',
  '  turns: 60      # non-human turns per window before auto-STOP (10x, operator 2026-10-11)',
  '  window: 2      # minutes',
  '# THE FOLDERS EVERY SANDBOXED BEING MAY READ',
  'global_read_paths:',
  '  - repos: C:\\Users\\user\\src\\siran',
  'node_name: kg',
  'peer_nodes: [kg, do]',
];
// Both old keys, lasso: first, flow + block, comments above and inside.
const BOTH = [
  'node_name: kg',
  'peer_nodes: [kg, do]',
  '# the outbound ceiling',
  'lasso:',
  '  messages: 30   # raised for the room',
  '  # per chat',
  '  chat_burst_count: 12',
  'warm:',
  '  max: 4',
  '# loop-breaker',
  'guard: { turns: 6, window: 2 }   # node default',
  'compaction:',
  '  enabled: true',
];

let root, egptHome;
const cfgPath = () => join(egptHome, 'config', 'config.yaml');
const logs = [];
const ctx = () => ({ id: '0044', egptHome, platform: 'win32', dryRun: false, log: (l) => logs.push(l) });
const write = (text) => { mkdirSync(join(egptHome, 'config'), { recursive: true }); writeFileSync(cfgPath(), text); };
const read = () => readFileSync(cfgPath(), 'utf8');
const writeReg = (name, text) => writeFileSync(join(egptHome, 'config', name), text);
const readReg = (name) => readFileSync(join(egptHome, 'config', name), 'utf8');
const vaults = () => (existsSync(join(egptHome, 'disposable')) ? readdirSync(join(egptHome, 'disposable')) : []);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'egpt-0044-')); egptHome = join(root, '.egpt'); logs.length = 0; write(lf(REVE)); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('0044 — guard: / lasso: → one loop_guard: block', () => {
  it('REPRODUCE: reve states `guard:` and no `loop_guard:`', async () => {
    expect(YAML.parse(read()).guard).toEqual({ turns: 60, window: 2 });
    expect((await plan(ctx())).satisfied).toBe(false);
  });

  it('moves reve\'s guard: under loop_guard.inbound, comments and every other line kept', async () => {
    await (await plan(ctx())).apply();
    expect(read()).toBe(lf([
      ...REVE.slice(0, 3),
      'loop_guard:',
      '  inbound:',
      '    turns: 60      # non-human turns per window before auto-STOP (10x, operator 2026-10-11)',
      '    window: 2      # minutes',
      ...REVE.slice(6),
    ]));
  });

  it('both old keys, CRLF: one block where the first stood, values equal, CRLF kept', async () => {
    write(crlf(BOTH));
    const before = YAML.parse(read());
    await (await plan(ctx())).apply();
    const after = YAML.parse(read());
    expect(after.loop_guard).toEqual({ outbound: before.lasso, inbound: before.guard });
    const { lasso: _l, guard: _g, ...restBefore } = before;
    const { loop_guard: _lg, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);
    expect(read()).toBe(crlf([
      'node_name: kg',
      'peer_nodes: [kg, do]',
      'loop_guard:',
      '  # the outbound ceiling',
      '  outbound:',
      '    messages: 30   # raised for the room',
      '    # per chat',
      '    chat_burst_count: 12',
      '  # loop-breaker',
      '  inbound: { turns: 6, window: 2 }   # node default',
      'warm:',
      '  max: 4',
      'compaction:',
      '  enabled: true',
    ]));
  });

  it('backs up into disposable/migration-0044-<ts>/config.yaml, never beside the file', async () => {
    const original = read();
    await (await plan(ctx())).apply();
    const [vault] = vaults();
    expect(vault).toMatch(/^migration-0044-\d{8}T\d{6}$/);
    expect(readFileSync(join(egptHome, 'disposable', vault, 'config.yaml'), 'utf8')).toBe(original);
    expect(readdirSync(join(egptHome, 'config'))).toEqual(['config.yaml']);
    expect(logs.join('\n')).toContain(join('disposable', vault, 'config.yaml'));
  });

  it('is idempotent: satisfied once moved', async () => {
    await (await plan(ctx())).apply();
    const p = await plan(ctx());
    expect(p.satisfied).toBe(true);
    expect(p.notes.join()).toMatch(/no `guard:` or `lasso:` left/);
  });

  it('a node with neither old key is satisfied', async () => {
    write(lf(['node_name: kg', 'warm:', '  max: 4']));
    expect((await plan(ctx())).satisfied).toBe(true);
    expect(vaults()).toEqual([]);
  });

  it('refuses old keys beside an existing loop_guard:', async () => {
    write(lf(['loop_guard:', '  inbound: { turns: 6 }', 'guard: { turns: 60 }']));
    await expect(plan(ctx())).rejects.toThrow(/0044 refuses: .*loop_guard:.*AND `guard:`/);
  });

  it('refuses an old key that is not a mapping, and a config.yaml that does not parse', async () => {
    write(lf(['guard: 6']));
    await expect(plan(ctx())).rejects.toThrow(/0044 refuses: `guard:` .* is not a mapping/);
    write('guard: [unclosed\r\n');
    await expect(plan(ctx())).rejects.toThrow(/0044 refuses: .*config\.yaml does not parse/);
  });

  it('conversations.yaml entries: guard: → loop_guard.inbound, every other byte kept, one backup', async () => {
    write(lf(['node_name: kg', 'loop_guard:', '  inbound: { turns: 60 }']));
    const conv = lf([
      'contacts:',
      '  whatsapp:',
      '    FakeRoomId0000000001: # @anapru',
      '      conversation_path: .egpt/conversations/whatsapp/@anapru-2606291919',
      '      home_dir: /c/Users/user',
      '    FakeRoomId0000000016:',
      '      guard:',
      '        turns: -1',
      '      conversation_path: .egpt/conversations/whatsapp/egpt-mesh-do-kg-2607051633',
      '      home_dir: /c/Users/user',
      '  telegram:',
      '    -1001234:',
      '      guard: { turns: -1, window: 30 }',
      '      home_dir: /c/Users/user',
    ]);
    writeReg('conversations.yaml', conv);
    const p = await plan(ctx());
    expect(p.satisfied).toBe(false);
    await p.apply();
    expect(readReg('conversations.yaml')).toBe(lf([
      'contacts:',
      '  whatsapp:',
      '    FakeRoomId0000000001: # @anapru',
      '      conversation_path: .egpt/conversations/whatsapp/@anapru-2606291919',
      '      home_dir: /c/Users/user',
      '    FakeRoomId0000000016:',
      '      loop_guard:',
      '        inbound:',
      '          turns: -1',
      '      conversation_path: .egpt/conversations/whatsapp/egpt-mesh-do-kg-2607051633',
      '      home_dir: /c/Users/user',
      '  telegram:',
      '    -1001234:',
      '      loop_guard:',
      '        inbound: { turns: -1, window: 30 }',
      '      home_dir: /c/Users/user',
    ]));
    const [vault] = vaults();
    expect(readdirSync(join(egptHome, 'disposable', vault))).toEqual(['conversations.yaml']);
    expect(readFileSync(join(egptHome, 'disposable', vault, 'conversations.yaml'), 'utf8')).toBe(conv);
    expect(readdirSync(join(egptHome, 'config')).sort()).toEqual(['config.yaml', 'conversations.yaml']);
    expect((await plan(ctx())).satisfied).toBe(true);
  });

  it('rooms.yaml and agents.yaml rows too, CRLF kept, beside the config.yaml move', async () => {
    writeReg('rooms.yaml', crlf(['rooms:', '  room/lobby:', '    guard: { turns: -1 }', '    members: []']));
    writeReg('agents.yaml', crlf(['agents:', '  agent/wren:', '    # quiet', '    guard:', '      turns: 3', '    agents:', '      wren: { threadId: t }']));
    await (await plan(ctx())).apply();
    expect(readReg('rooms.yaml')).toBe(crlf(['rooms:', '  room/lobby:', '    loop_guard:', '      inbound: { turns: -1 }', '    members: []']));
    expect(readReg('agents.yaml')).toBe(crlf(['agents:', '  agent/wren:', '    loop_guard:', '      # quiet', '      inbound:', '        turns: 3', '    agents:', '      wren: { threadId: t }']));
    expect(YAML.parse(read()).loop_guard).toEqual({ inbound: { turns: 60, window: 2 } });
    expect(readdirSync(join(egptHome, 'disposable', vaults()[0])).sort()).toEqual(['agents.yaml', 'config.yaml', 'rooms.yaml']);
  });

  it('refuses an entry that states both guard: and loop_guard:', async () => {
    writeReg('conversations.yaml', lf(['contacts:', '  whatsapp:', '    abc:', '      guard: { turns: -1 }', '      loop_guard: { inbound: { turns: 6 } }']));
    await expect(plan(ctx())).rejects.toThrow(/0044 refuses: conversations\.yaml contacts\.whatsapp\.abc states `loop_guard:` AND `guard:`/);
  });

  it('through the runner, on a node whose ledger records 0001-0043: applied and recorded', async () => {
    mkdirSync(join(egptHome, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0044');
    writeFileSync(join(egptHome, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-18T00:00:00Z' }]))));
    const { exitCode } = await runMigrations({ through: '0044', egptHome, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(egptHome, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0044-the-loop-guard-is-one-block'].outcome).toBe('applied');
    expect(YAML.parse(read()).loop_guard).toEqual({ inbound: { turns: 60, window: 2 } });
  });
});

describe('loopGuardConfig — the pre-0044 keys are still read for one release', () => {
  it('names exactly the two old blocks', () => {
    expect(LEGACY_BLOCKS).toEqual({ inbound: 'guard', outbound: 'lasso' });
  });

  it('reads guard: as inbound and lasso: as outbound, with ONE deprecation line', () => {
    const seen = [];
    const got = loopGuardConfig({ guard: { turns: 60, window: 2 }, lasso: { messages: 30 } }, { onDeprecated: (m) => seen.push(m) });
    expect(got).toEqual({ inbound: { turns: 60, window: 2 }, outbound: { messages: 30 } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/guard: read as loop_guard\.inbound; lasso: read as loop_guard\.outbound.*0044/);
  });

  it('loop_guard: wins; an old key beside it is ignored and said so', () => {
    const seen = [];
    const got = loopGuardConfig({ loop_guard: { inbound: { turns: 6 } }, guard: { turns: 60 } }, { onDeprecated: (m) => seen.push(m) });
    expect(got).toEqual({ inbound: { turns: 6 }, outbound: {} });
    expect(seen).toEqual([expect.stringMatching(/guard: ignored, loop_guard\.inbound is set/)]);
  });

  it('an entry override: loop_guard.inbound, else the old entry-level guard:, else null', () => {
    expect(inboundOverrideOf({ loop_guard: { inbound: { turns: -1 } }, guard: { turns: 9 } })).toEqual({ turns: -1 });
    expect(inboundOverrideOf({ guard: { turns: -1 } })).toEqual({ turns: -1 });
    expect(inboundOverrideOf({ loop_guard: {} })).toBe(null);
    expect(inboundOverrideOf(undefined)).toBe(null);
    expect(legacyEntryCount({ contacts: { whatsapp: { a: { guard: { turns: -1 } }, b: { loop_guard: { inbound: {} } } }, room: { r: { guard: {} } } } })).toBe(2);
  });

  it('the new block alone, or nothing at all: no deprecation line', () => {
    const seen = [];
    expect(loopGuardConfig({ loop_guard: { outbound: { edits: 9 } } }, { onDeprecated: (m) => seen.push(m) })).toEqual({ inbound: {}, outbound: { edits: 9 } });
    expect(loopGuardConfig({}, { onDeprecated: (m) => seen.push(m) })).toEqual({ inbound: {}, outbound: {} });
    expect(seen).toEqual([]);
  });
});

// boot() on a node that has NOT run 0044: its old lasso: still bounds what it sends.
describe('boot() reads an old block, logged once', () => {
  it('lasso: { messages: 3 } still trips at 3 (STOP lands in this file\'s profile), and guard: is read too', async () => {
    const sent = [];
    const lines = [];
    const exits = [];
    const app = await boot({
      readConfig: () => ({ whatsapp: {}, node_name: 'kg', lasso: { messages: 3, window_ms: 5000 }, guard: { turns: 60 }, agents: { egpt: { configuration: 'egpt', handles: ['e'], default: true } } }),
      startBridge: async () => ({ async send(text) { sent.push(text); return { ok: true }; }, startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; }, isAlive: () => true, stop() {} }),
      makeSession: () => ({ sessionId: 's', async turn() { return { text: 'ok' }; }, close() {} }),
      loadState: async () => (await import('../src/conversations-state.mjs')).emptyState(),
      writeState: async () => {},
      ingest: false, tickMs: 0, exit: (c) => exits.push(c), log: { line: (s) => lines.push(s) },
    });
    try {
      await Promise.all(Array.from({ length: 4 }, (_, i) => app.bridge.send(`!room${i}:beeper.com`, `x${i}`)));
      await new Promise((r) => setImmediate(r));
      expect(sent).toHaveLength(3);
      expect(exits).toEqual([0]);
      expect(readFileSync(join(bootHome, 'STOP'), 'utf8')).toContain('reason: loop_guard: outbound message flood');
      const dep = lines.filter((l) => l.includes('deprecated config.yaml key'));
      expect(dep).toHaveLength(1);
      expect(dep[0]).toMatch(/\[loop_guard\] .*guard: read as loop_guard\.inbound; lasso: read as loop_guard\.outbound/);
    } finally { app.stop(); }
  });
});

describe('boot() on old per-conversation guard: entries', () => {
  it('says so ONCE per boot, whatever the number of entries', async () => {
    rmSync(join(bootHome, 'STOP'), { force: true });   // the boot test above stopped this profile
    const { emptyState } = await import('../src/conversations-state.mjs');
    const state ={ ...emptyState(), contacts: { whatsapp: { a: { guard: { turns: -1 } }, b: { guard: { turns: -1 } }, c: { loop_guard: { inbound: { turns: 3 } } } } } };
    const lines = [];
    const app = await boot({
      readConfig: () => ({ whatsapp: {}, node_name: 'kg', loop_guard: {}, agents: { egpt: { configuration: 'egpt', handles: ['e'], default: true } } }),
      startBridge: async () => ({ async send() { return { ok: true }; }, startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; }, isAlive: () => true, stop() {} }),
      makeSession: () => ({ sessionId: 's', async turn() { return { text: 'ok' }; }, close() {} }),
      loadState: async () => structuredClone(state),
      writeState: async () => {},
      ingest: false, tickMs: 0, exit: () => {}, log: { line: (s) => lines.push(s) },
    });
    try {
      const dep = lines.filter((l) => l.includes('deprecated'));
      expect(dep).toEqual([expect.stringMatching(/^\[loop_guard\] deprecated per-conversation guard: on 2 conversations\.yaml entries .*0044/)]);
    } finally { app.stop(); }
  });
});

describe('the rename is complete', () => {
  const REPO = fileURLToPath(new URL('..', import.meta.url));
  const SKIP_DIRS = new Set(['node_modules', '.git']);
  const TEXT = /\.(mjs|js|cjs|json|md|ya?ml|cmd|ps1|psm1|sh|txt|html|css)$/i;
  const ALLOWED = new Set(['migrations/0044-the-loop-guard-is-one-block.mjs', 'tests/migrations-0044-the-loop-guard-is-one-block.test.mjs']);
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) return SKIP_DIRS.has(n) ? [] : walk(p);
    return TEXT.test(n) && !/\.disposable\.md$/i.test(n) ? [p] : [];   // gitignored scratch notes are history, not code
  });

  it('no "lasso" outside 0044 and the legacy-key constant', () => {
    const hits = [];
    for (const p of walk(REPO)) {
      const rel = relative(REPO, p).split(sep).join('/');
      if (ALLOWED.has(rel)) continue;
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (!/lasso/i.test(line)) return;
        if (rel === 'src/loop-guard.mjs' && line.startsWith('export const LEGACY_BLOCKS = ')) return;
        hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
