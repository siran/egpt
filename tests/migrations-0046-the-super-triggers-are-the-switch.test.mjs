// 0046 — super_chats: `triggers: [ … ]` is the switch; `trigger:` and `enabled:` go, the on/off state is kept.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0046-the-super-triggers-are-the-switch.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const lf = (lines) => lines.map((l) => `${l}\n`).join('');

// kg and do as they are after 0045 (2026-10-18).
const LIVE = [
  'node_name: kg',
  'peer_nodes: [kg, do]',
  'super_chats:',
  '  enabled: false',
  '  suffix: "-super"       # side-room title = <chat title> + suffix',
  '  mode: "on"             # reply mode inside the side-room',
  '  trigger: "SI chat"     # exact whole message, any case; empty = no super channel',
  '  automatic: false',
  'compaction:',
  '  enabled: true',
];
const LIVE_AFTER = [
  'node_name: kg',
  'peer_nodes: [kg, do]',
  'super_chats:',
  '  suffix: "-super"       # side-room title = <chat title> + suffix',
  '  mode: "on"             # reply mode inside the side-room',
  '  triggers: []     # exact whole message, any case; empty = no super channel',
  '  automatic: false',
  'compaction:',
  '  enabled: true',
];
const block = (...lines) => ['node_name: kg', 'peer_nodes: [kg, do]', 'super_chats:', ...lines.map((l) => `  ${l}`), '  mode: "on"', 'compaction:', '  enabled: true'];

let root, egptHome;
const cfgPath = () => join(egptHome, 'config', 'config.yaml');
const logs = [];
const ctx = () => ({ id: '0046', egptHome, platform: 'win32', dryRun: false, log: (l) => logs.push(l) });
const write = (text) => { mkdirSync(join(egptHome, 'config'), { recursive: true }); writeFileSync(cfgPath(), text); };
const read = () => readFileSync(cfgPath(), 'utf8');
const vaults = () => (existsSync(join(egptHome, 'disposable')) ? readdirSync(join(egptHome, 'disposable')) : []);
const migrate = async (lines) => { write(lf(lines)); const p = await plan(ctx()); await p.apply(); return p; };

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'egpt-0046-')); egptHome = join(root, '.egpt'); logs.length = 0; write(crlf(LIVE)); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('0046 — super_chats.triggers is the switch', () => {
  it('REPRODUCE: kg/do state `enabled:` and `trigger:`', async () => {
    expect(YAML.parse(read()).super_chats).toMatchObject({ enabled: false, trigger: 'SI chat' });
    expect((await plan(ctx())).satisfied).toBe(false);
  });

  it('THE LIVE SHAPE (CRLF and LF): enabled: false + trigger "SI chat" → triggers: [] with its comment, no enabled line', async () => {
    for (const eol of [crlf, lf]) {
      write(eol(LIVE));
      const p = await plan(ctx());
      expect(p.changes.join('\n')).toMatch(/set aside.*"SI chat"/);
      await p.apply();
      expect(read()).toBe(eol(LIVE_AFTER));
    }
  });

  it('enabled: true carries the phrase over; "" carries nothing', async () => {
    await migrate(block('enabled: true', 'trigger: "SI chat"   # c'));
    expect(read()).toBe(lf(block('triggers: [ "SI chat" ]   # c')));
    await migrate(block('enabled: true', 'trigger: ""'));
    expect(read()).toBe(lf(block('triggers: []')));
  });

  it('a `trigger:` with no `enabled:` was off: triggers: [] and the phrase set aside', async () => {
    const p = await migrate(block('trigger: SI chat'));
    expect(read()).toBe(lf(block('triggers: []')));
    expect(p.changes.join('\n')).toMatch(/set aside.*"SI chat"/);
  });

  it('pre-0045 `triggers:` + enabled: true → the list stays byte for byte, the enabled line goes', async () => {
    await migrate(block('enabled: true   # on', 'triggers: [ "SI chat", "abre SI" ]  # whole message'));
    expect(read()).toBe(lf(block('triggers: [ "SI chat", "abre SI" ]  # whole message')));
  });

  it('pre-0045 `triggers:` + enabled: false → triggers: [], every phrase set aside', async () => {
    const p = await migrate(block('enabled: false', 'triggers: [ "SI chat", abre SI ]'));
    expect(read()).toBe(lf(block('triggers: []')));
    expect(p.changes.join('\n')).toMatch(/set aside.*"SI chat", "abre SI"/);
  });

  it('only `enabled:` (no phrase anywhere) → triggers: [] in its place; enabled: true says SI is now off', async () => {
    const p = await migrate(block('enabled: true'));
    expect(read()).toBe(lf(block('triggers: []')));
    expect(p.changes.join('\n')).toMatch(/now OFF/);
    await migrate(['super_chats:', '  enabled: false']);
    expect(read()).toBe(lf(['super_chats:', '  triggers: []']));
  });

  it('backs up into disposable/migration-0046-<ts>/config.yaml, never beside the file', async () => {
    const original = read();
    await (await plan(ctx())).apply();
    const [vault] = vaults();
    expect(vault).toMatch(/^migration-0046-\d{8}T\d{6}$/);
    expect(readFileSync(join(egptHome, 'disposable', vault, 'config.yaml'), 'utf8')).toBe(original);
    expect(readdirSync(join(egptHome, 'config'))).toEqual(['config.yaml']);
    expect(logs.join('\n')).toContain(join('disposable', vault, 'config.yaml'));
  });

  it('is idempotent: satisfied once rewritten', async () => {
    await (await plan(ctx())).apply();
    expect((await plan(ctx())).satisfied).toBe(true);
  });

  it('no super_chats block, or one with neither `trigger:` nor `enabled:`: satisfied, untouched', async () => {
    for (const lines of [['node_name: kg', 'compaction:', '  enabled: true'], ['super_chats:', '  triggers: [ "SI chat" ]', '  mode: "on"']]) {
      write(lf(lines));
      expect((await plan(ctx())).satisfied).toBe(true);
      expect(read()).toBe(lf(lines));
    }
    expect(vaults()).toEqual([]);
  });

  it('refuses trigger beside triggers, a trigger that is not one phrase, a triggers that is not an inline list, and a config that does not parse', async () => {
    write(lf(['super_chats:', '  trigger: a', '  triggers: [ b ]']));
    await expect(plan(ctx())).rejects.toThrow(/0046 refuses: .*`trigger:` AND `triggers:`/);
    write(lf(['super_chats:', '  enabled: true', '  trigger: [ a, b ]']));
    await expect(plan(ctx())).rejects.toThrow(/0046 refuses: .*`trigger:` .*not one phrase/);
    write(lf(['super_chats:', '  enabled: false', '  triggers:', '    - SI chat']));
    await expect(plan(ctx())).rejects.toThrow(/0046 refuses: .*`triggers:` .*not an inline \[ \] list/);
    write('super_chats: [unclosed\r\n');
    await expect(plan(ctx())).rejects.toThrow(/0046 refuses: .*config\.yaml does not parse/);
  });

  it('through the runner, on kg (0045 in its ledger): applied and recorded', async () => {
    mkdirSync(join(egptHome, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0046');
    writeFileSync(join(egptHome, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-18T00:00:00Z' }]))));
    const { exitCode } = await runMigrations({ through: '0046', egptHome, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(egptHome, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0046-the-super-triggers-are-the-switch'].outcome).toBe('applied');
    expect(read()).toBe(crlf(LIVE_AFTER));
  });

  it('through the runner, on a node that never ran 0045: 0045 is a no-op and every phrase survives', async () => {
    write(crlf(block('enabled: true', 'triggers: [ "SI chat", "abre SI" ]')));
    mkdirSync(join(egptHome, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0045');
    writeFileSync(join(egptHome, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-18T00:00:00Z' }]))));
    const { exitCode } = await runMigrations({ through: '0046', egptHome, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(egptHome, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0045-the-super-trigger-is-one-phrase'].outcome).toBe('already-satisfied');
    expect(ledger['0046-the-super-triggers-are-the-switch'].outcome).toBe('applied');
    expect(read()).toBe(crlf(block('triggers: [ "SI chat", "abre SI" ]')));
  });
});
