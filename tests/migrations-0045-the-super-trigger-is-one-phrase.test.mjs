// 0045 — superseded by 0046 (super_chats.triggers is a list again): a no-op wherever it has not run.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0045-the-super-trigger-is-one-phrase.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const PRE_0045 = crlf(['node_name: kg', 'peer_nodes: [kg, do]', 'super_chats:', '  enabled: true', '  triggers: [ "SI chat", "abre SI" ]   # whole-message', '  suffix: -super']);

let root, egptHome;
const cfgPath = () => join(egptHome, 'config', 'config.yaml');
const ctx = () => ({ id: '0045', egptHome, platform: 'win32', dryRun: false, log: () => {} });
const write = (text) => { mkdirSync(join(egptHome, 'config'), { recursive: true }); writeFileSync(cfgPath(), text); };
const read = () => readFileSync(cfgPath(), 'utf8');

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'egpt-0045-')); egptHome = join(root, '.egpt'); write(PRE_0045); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('0045 — a no-op, superseded by 0046', () => {
  it('a pre-0045 `triggers:` list is satisfied and untouched (no phrase dropped), naming 0046', async () => {
    const p = await plan(ctx());
    expect(p.satisfied).toBe(true);
    expect(p.notes.join('\n')).toMatch(/0046/);
    expect(read()).toBe(PRE_0045);
    expect(existsSync(join(egptHome, 'disposable'))).toBe(false);
  });

  it('through the runner, on a node whose ledger records 0001-0044: recorded as already satisfied, config untouched', async () => {
    mkdirSync(join(egptHome, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0045');
    writeFileSync(join(egptHome, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-18T00:00:00Z' }]))));
    const { exitCode } = await runMigrations({ through: '0045', egptHome, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(egptHome, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0045-the-super-trigger-is-one-phrase'].outcome).toBe('already-satisfied');
    expect(read()).toBe(PRE_0045);
    expect(readdirSync(join(egptHome, 'config'))).toEqual(['config.yaml']);
  });
});
