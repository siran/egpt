// 0047 — the global super_chats block goes: SI chats are per conversation now (superchats on the chat's entry).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0047-the-super-chats-block-is-gone.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const lf = (lines) => lines.map((l) => `${l}\n`).join('');

// kg and do after 0046 (2026-10-18).
const LIVE = [
  'node_name: kg',
  'peer_nodes: [kg, do]',
  '# SI side channel',
  'super_chats:',
  '  suffix: "-super"       # side-room title = <chat title> + suffix',
  '  mode: "on"             # reply mode inside the side-room',
  '  triggers: []     # exact whole message, any case; empty = no super channel',
  '  automatic: false',
  '',
  'compaction:',
  '  enabled: true',
];
const LIVE_AFTER = ['node_name: kg', 'peer_nodes: [kg, do]', '', 'compaction:', '  enabled: true'];

let root, egptHome;
const cfgPath = () => join(egptHome, 'config', 'config.yaml');
const logs = [];
const ctx = () => ({ id: '0047', egptHome, platform: 'win32', dryRun: false, log: (l) => logs.push(l) });
const write = (text) => { mkdirSync(join(egptHome, 'config'), { recursive: true }); writeFileSync(cfgPath(), text); };
const read = () => readFileSync(cfgPath(), 'utf8');
const vaults = () => (existsSync(join(egptHome, 'disposable')) ? readdirSync(join(egptHome, 'disposable')) : []);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'egpt-0047-')); egptHome = join(root, '.egpt'); logs.length = 0; write(crlf(LIVE)); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('0047 — the global super_chats block is gone', () => {
  it('THE LIVE SHAPE (CRLF and LF): the off block and the comment above it go, every other byte stays', async () => {
    for (const eol of [crlf, lf]) {
      write(eol(LIVE));
      const p = await plan(ctx());
      expect(p.satisfied).toBe(false);
      await p.apply();
      expect(read()).toBe(eol(LIVE_AFTER));
    }
  });

  it('refuses a block that is ON (a phrase in triggers): moving it to a conversation is a human decision', async () => {
    write(lf(['super_chats:', '  triggers: [ "SI chat" ]', '  mode: "on"']));
    await expect(plan(ctx())).rejects.toThrow(/0047 refuses: .*"SI chat".*superchats/);
    expect(read()).toBe(lf(['super_chats:', '  triggers: [ "SI chat" ]', '  mode: "on"']));
  });

  it('no super_chats block: satisfied, untouched, no backup', async () => {
    write(lf(['node_name: kg', 'peer_nodes: [kg, do]', 'compaction:', '  enabled: true']));
    expect((await plan(ctx())).satisfied).toBe(true);
    expect(read()).toBe(lf(['node_name: kg', 'peer_nodes: [kg, do]', 'compaction:', '  enabled: true']));
    expect(vaults()).toEqual([]);
  });

  it('backs up into disposable/migration-0047-<ts>/config.yaml; idempotent', async () => {
    const original = read();
    await (await plan(ctx())).apply();
    const [vault] = vaults();
    expect(vault).toMatch(/^migration-0047-\d{8}T\d{6}$/);
    expect(readFileSync(join(egptHome, 'disposable', vault, 'config.yaml'), 'utf8')).toBe(original);
    expect(readdirSync(join(egptHome, 'config'))).toEqual(['config.yaml']);
    expect((await plan(ctx())).satisfied).toBe(true);
  });

  it('refuses a config that does not parse, and a missing one', async () => {
    write('super_chats: [unclosed\r\n');
    await expect(plan(ctx())).rejects.toThrow(/0047 refuses: .*does not parse/);
    rmSync(cfgPath());
    await expect(plan(ctx())).rejects.toThrow(/0047 refuses: there is no/);
  });

  it('through the runner after 0046: applied and recorded', async () => {
    mkdirSync(join(egptHome, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0047');
    writeFileSync(join(egptHome, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-18T00:00:00Z' }]))));
    const { exitCode } = await runMigrations({ through: '0047', egptHome, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(egptHome, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0047-the-super-chats-block-is-gone'].outcome).toBe('applied');
    expect(read()).toBe(crlf(LIVE_AFTER));
  });
});
