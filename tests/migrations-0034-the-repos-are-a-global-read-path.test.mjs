// 0034 — the operator's repositories are a global read path. A kg-shaped config.yaml, CRLF like the
// operator's file; whether C:/Users/an/src/siran is on "this node" is answered by the ctx seam, so
// the suite never depends on the machine it runs on and never reads a real profile.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0034-the-repos-are-a-global-read-path.mjs';
import { globalReadPathsOf } from '../src/spine/brainpool.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const KG = [
  'node_name: kg',
  'user_name: An',
  'agents:',
  '  egpt:',
  '    handles: [ e, egpt ]',
  'admin_channel: eGPT Admin',
];
const SIRAN = 'C:/Users/an/src/siran';

let root, egptHome;
const cfgPath = () => join(egptHome, 'config', 'config.yaml');
// kg by default: the folder is there. `onNode: false` is do.
const ctx = ({ onNode = true } = {}) => ({
  id: '0034', egptHome, platform: 'win32', dryRun: false, log: () => {},
  isDirectory: (p) => onNode && p === SIRAN,
  backup: (p) => { const b = `${p}.bak-0034-test`; writeFileSync(b, readFileSync(p)); return b; },
});
const write = (text) => { mkdirSync(join(egptHome, 'config'), { recursive: true }); writeFileSync(cfgPath(), text); };
const read = () => readFileSync(cfgPath(), 'utf8');

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'egpt-0034-')); egptHome = join(root, '.egpt'); write(crlf(KG)); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('0034 — the repos are a global read path', () => {
  it('REPRODUCE: kg states no global_read_paths, so since the path left the scripts nothing is mounted', async () => {
    expect(YAML.parse(read()).global_read_paths).toBeUndefined();
    expect(globalReadPathsOf(YAML.parse(read()).global_read_paths)).toEqual([]);
    expect((await plan(ctx())).satisfied).toBe(false);
  });

  it('inserts `global_read_paths:` with `- repos: C:/Users/an/src/siran` at the root, the ruling quoted above it', async () => {
    await (await plan(ctx())).apply();
    expect(YAML.parse(read()).global_read_paths).toEqual([{ repos: SIRAN }]);
    // ...which the spine and the provisioner read as exactly the one mount.
    expect(globalReadPathsOf(YAML.parse(read()).global_read_paths)).toEqual([{ name: 'repos', path: SIRAN }]);
    expect(read()).toMatch(/# THE FOLDERS EVERY SANDBOXED BEING MAY READ \(0034, operator 2026-09-28: "sandboxed beings should\r\n/);
    expect(read()).toMatch(/please frame this in\r\n# config\.yaml as global_read_paths list"\)/);
    expect(read()).toMatch(/\.env/);
    expect(read().endsWith('global_read_paths:\r\n  - repos: C:/Users/an/src/siran\r\n')).toBe(true);
  });

  it('touches nothing else, keeps CRLF, and leaves a backup', async () => {
    const before = YAML.parse(read());
    await (await plan(ctx())).apply();
    const { global_read_paths: _g, ...rest } = YAML.parse(read());
    expect(rest).toEqual(before);
    expect(read().startsWith(crlf(KG))).toBe(true);
    expect(read().split('\n').slice(0, -1).every((l) => l.endsWith('\r'))).toBe(true);
    expect(readdirSync(join(egptHome, 'config')).filter((n) => n.includes('bak-0034'))).toEqual(['config.yaml.bak-0034-test']);
  });

  it('plans the inserted lines, and says the provisioner is still to run', async () => {
    const p = await plan(ctx());
    expect(p.changes[0]).toMatch(/config\.yaml:7-15 {2}insert `global_read_paths:` with `repos: C:\/Users\/an\/src\/siran` at the root$/);
    expect(p.changes).toContain('  + global_read_paths:');
    expect(p.changes).toContain(`  +   - repos: ${SIRAN}`);
    expect(p.changes.some((c) => /provision-sandbox-account\.cmd/.test(c))).toBe(true);
  });

  it('is idempotent: satisfied once applied', async () => {
    await (await plan(ctx())).apply();
    expect((await plan(ctx())).satisfied).toBe(true);
  });

  it('do: the folder is not on this node - satisfied with a note, nothing written', async () => {
    const p = await plan(ctx({ onNode: false }));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toMatch(/C:\/Users\/an\/src\/siran is not a directory on this node/);
    expect(read()).toBe(crlf(KG));
  });

  it('a node that already states one is left alone, whatever it lists - even an empty list', async () => {
    for (const mine of [['global_read_paths:', '  - notes: D:/notes'], ['global_read_paths: []']]) {
      write(crlf([...KG, ...mine]));
      const p = await plan(ctx());
      expect(p.satisfied).toBe(true);
      expect(read()).toBe(crlf([...KG, ...mine]));
    }
  });

  it('refuses, naming the file, on a config.yaml that does not parse', async () => {
    write('agents: [unclosed\r\n');
    await expect(plan(ctx())).rejects.toThrow(/0034 refuses: .*config\.yaml does not parse/);
  });

  it('refuses when the file changed between plan and apply, and writes no backup', async () => {
    const p = await plan(ctx());
    write(crlf([...KG, 'aliases: {}']));
    await expect(p.apply()).rejects.toThrow(/0034 refuses: .*changed since it was planned/);
    expect(readdirSync(join(egptHome, 'config')).filter((n) => n.includes('bak-0034'))).toEqual([]);
  });

  it('through the runner, on a node whose ledger already records 0001-0033: applied and recorded', async () => {
    // A real node's ledger - so the runner never loads an earlier migration against this minimal
    // fixture, which is not a whole node and is not meant to satisfy them.
    mkdirSync(join(egptHome, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0034');
    writeFileSync(join(egptHome, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-09-28T00:00:00Z' }]))));
    const { exitCode } = await runMigrations({ through: '0034', egptHome, elevated: false, platform: 'win32', ctx: { isDirectory: (p) => p === SIRAN }, log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(egptHome, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0034-the-repos-are-a-global-read-path'].outcome).toBe('applied');
    expect(YAML.parse(read()).global_read_paths).toEqual([{ repos: SIRAN }]);
    expect(readdirSync(join(egptHome, 'config')).filter((n) => n.startsWith('config.yaml.bak-0034-'))).toHaveLength(1);
  });

  it('through the runner on do: recorded as already satisfied, nothing touched', async () => {
    mkdirSync(join(egptHome, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0034');
    writeFileSync(join(egptHome, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-09-28T00:00:00Z' }]))));
    const { exitCode } = await runMigrations({ through: '0034', egptHome, elevated: false, platform: 'win32', ctx: { isDirectory: () => false }, log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(egptHome, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0034-the-repos-are-a-global-read-path'].outcome).toBe('already-satisfied');
    expect(read()).toBe(crlf(KG));
  });
});
