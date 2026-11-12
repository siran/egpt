// 0040 — SI config key rename `super:` → `super_chats:`. A kg-shaped config.yaml, CRLF like the operator's.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0040-super-is-super-chats.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
// A node still on the old `super:` key, with a FULL block so the rename's value-preservation is tested.
const KG = [
  'node_name: kg',
  'peer_nodes: [kg, do]',
  'user_name: An',
  'super:',
  '  enabled: true',
  '  mode: "on"',
  '  triggers: [ "SI chat" ]',
  '  suffix: -super',
  '  opener: hello {chat}',
  'compaction:',
  '  enabled: true',
];
const SUPER_BLOCK = { enabled: true, mode: 'on', triggers: ['SI chat'], suffix: '-super', opener: 'hello {chat}' };

let root, egptHome;
const cfgPath = () => join(egptHome, 'config', 'config.yaml');
const ctx = () => ({
  id: '0040', egptHome, platform: 'win32', dryRun: false, log: () => {},
  backup: (p) => { const b = `${p}.bak-0040-test`; writeFileSync(b, readFileSync(p)); return b; },
});
const write = (text) => { mkdirSync(join(egptHome, 'config'), { recursive: true }); writeFileSync(cfgPath(), text); };
const read = () => readFileSync(cfgPath(), 'utf8');

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'egpt-0040-')); egptHome = join(root, '.egpt'); write(crlf(KG)); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('0040 — super → super_chats', () => {
  it('REPRODUCE: a node still states `super:`, which the SI readers no longer read', async () => {
    expect(YAML.parse(read()).super).toBeDefined();
    expect(YAML.parse(read()).super_chats).toBeUndefined();
    expect((await plan(ctx())).satisfied).toBe(false);
  });

  it('renames the key, preserving every nested value', async () => {
    await (await plan(ctx())).apply();
    const data = YAML.parse(read());
    expect(data.super).toBeUndefined();
    expect(data.super_chats).toEqual(SUPER_BLOCK);
  });

  it('touches nothing else, keeps CRLF, and leaves a backup', async () => {
    const before = YAML.parse(read());
    await (await plan(ctx())).apply();
    const after = YAML.parse(read());
    const { super: _s, ...restBefore } = before;
    const { super_chats: _sc, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);                       // every other key untouched
    expect(read().split('\n').slice(0, -1).every((l) => l.endsWith('\r'))).toBe(true);
    expect(readdirSync(join(egptHome, 'config')).filter((n) => n.includes('bak-0040'))).toEqual(['config.yaml.bak-0040-test']);
  });

  it('is idempotent: satisfied once renamed', async () => {
    await (await plan(ctx())).apply();
    expect((await plan(ctx())).satisfied).toBe(true);
  });

  it('a node already on `super_chats:` is left alone', async () => {
    write(crlf(['node_name: kg', 'super_chats:', '  enabled: true']));
    const p = await plan(ctx());
    expect(p.satisfied).toBe(true);
    expect(YAML.parse(read()).super_chats.enabled).toBe(true);
  });

  it('a node with NEITHER key is satisfied (nothing to rename)', async () => {
    write(crlf(['node_name: kg', 'compaction:', '  enabled: true']));
    expect((await plan(ctx())).satisfied).toBe(true);
  });

  it('refuses, naming the file, on a config.yaml that does not parse', async () => {
    write('agents: [unclosed\r\n');
    await expect(plan(ctx())).rejects.toThrow(/0040 refuses: .*config\.yaml does not parse/);
  });

  it('through the runner, on a node whose ledger already records 0001-0039: applied and recorded', async () => {
    mkdirSync(join(egptHome, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0040');
    writeFileSync(join(egptHome, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-13T00:00:00Z' }]))));
    const { exitCode } = await runMigrations({ through: '0040', egptHome, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(egptHome, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0040-super-is-super-chats'].outcome).toBe('applied');
    expect(YAML.parse(read()).super_chats).toEqual(SUPER_BLOCK);
  });
});
