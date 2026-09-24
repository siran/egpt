// 0029 — the admin channel is declared. A kg-shaped config.yaml, CRLF like the operator's file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0029-the-admin-channel-is-declared.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const KG = [
  'node_name: kg',
  'user_name: An',
  'agents:',
  '  egpt:',
  '    handles: [ e, egpt ]',
  'compaction:',
  '  enabled: true',
  '  ratio: 0.2',
];

let root, egptHome;
const cfgPath = () => join(egptHome, 'config', 'config.yaml');
const ctx = () => ({
  id: '0029', egptHome, platform: 'win32', dryRun: false, log: () => {},
  backup: (p) => { const b = `${p}.bak-0029-test`; writeFileSync(b, readFileSync(p)); return b; },
});
const write = (text) => { mkdirSync(join(egptHome, 'config'), { recursive: true }); writeFileSync(cfgPath(), text); };
const read = () => readFileSync(cfgPath(), 'utf8');

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'egpt-0029-')); egptHome = join(root, '.egpt'); write(crlf(KG)); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('0029 — the admin channel is declared', () => {
  it('REPRODUCE: a node states no admin_channel, so the compaction notice has nowhere to go', async () => {
    expect(YAML.parse(read()).admin_channel).toBeUndefined();
    expect((await plan(ctx())).satisfied).toBe(false);
  });

  it('inserts `admin_channel: eGPT Admin` at the root, with the operator\'s words above it', async () => {
    await (await plan(ctx())).apply();
    expect(YAML.parse(read()).admin_channel).toBe('eGPT Admin');
    expect(read()).toMatch(/# THE ADMIN CHANNEL \(0029, operator 2026-09-24: "make it's posted on admin channel, eGPT Admin\./);
  });

  it('touches nothing else, keeps CRLF, and leaves a backup', async () => {
    const before = YAML.parse(read());
    await (await plan(ctx())).apply();
    const { admin_channel: _a, ...rest } = YAML.parse(read());
    expect(rest).toEqual(before);
    expect(read().split('\n').slice(0, -1).every((l) => l.endsWith('\r'))).toBe(true);
    expect(readdirSync(join(egptHome, 'config')).filter((n) => n.includes('bak-0029'))).toEqual(['config.yaml.bak-0029-test']);
  });

  it('is idempotent: satisfied once applied', async () => {
    await (await plan(ctx())).apply();
    expect((await plan(ctx())).satisfied).toBe(true);
  });

  it('a node that already states one is left alone, whatever it says', async () => {
    write(crlf([...KG, 'admin_channel: Some Other Group']));
    const p = await plan(ctx());
    expect(p.satisfied).toBe(true);
    expect(YAML.parse(read()).admin_channel).toBe('Some Other Group');
  });

  it('refuses, naming the file, on a config.yaml that does not parse', async () => {
    write('agents: [unclosed\r\n');
    await expect(plan(ctx())).rejects.toThrow(/0029 refuses: .*config\.yaml does not parse/);
  });

  it('through the runner, on a node whose ledger already records 0001-0028: applied and recorded', async () => {
    // A real node's ledger - so the runner never loads an earlier migration against this minimal
    // fixture, which is not a whole node and is not meant to satisfy them.
    mkdirSync(join(egptHome, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0029');
    writeFileSync(join(egptHome, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-09-24T00:00:00Z' }]))));
    const { exitCode } = await runMigrations({ through: '0029', egptHome, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(egptHome, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0029-the-admin-channel-is-declared'].outcome).toBe('applied');
    expect(YAML.parse(read()).admin_channel).toBe('eGPT Admin');
  });
});
