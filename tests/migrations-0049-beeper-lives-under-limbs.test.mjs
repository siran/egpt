// 0049 — top-level beeper: → limbs.beeper, verbatim. Fixtures are the two live shapes (keys, comment
// placement and blank lines as measured 2026-10-23; values made up): reve already carries an empty
// `limbs:` with the operator's two comment lines, dolly has none.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';

const bootHome = join(tmpdir(), `egpt-0049-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = bootHome;
let plan, runMigrations, listMigrations, MIGRATIONS_DIR, beeperBlockOf;
beforeAll(async () => {
  ({ plan } = await import('../migrations/0049-beeper-lives-under-limbs.mjs'));
  ({ runMigrations, listMigrations, MIGRATIONS_DIR } = await import('../setup/migrate.mjs'));
  ({ beeperBlockOf } = await import('../src/tools/config-io.mjs'));
});
afterAll(() => { delete process.env.EGPT_HOME; rmSync(bootHome, { recursive: true, force: true }); });

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const lf = (lines) => lines.map((l) => `${l}\n`).join('');

const REVE_HEAD = [
  '# config.yaml — Reference: config/skeletons/config.yaml',
  '',
  '# --- Identity ----------------------------------------------------------------',
  'node_name: kg',
  'user_name: An',
  'peer_nodes: [kg, do]   # co-account',
  'bridge_signature_close: "~"   # sig',
  '',
];
const REVE_LIMBS = ['limbs:', '  # beeper - to copy lower block', '  # local-endpoint'];
const REVE_BEEPER = [
  '# --- Beeper ------------------------------------------------------------------',
  'beeper:',
  '  # (optional) beeper is used to connect to social media (whatsapp, telegram, etc.)',
  '  # one or many accounts',
  '  primary:',
  '    # the ear',
  '    account: an@example.com',
  '    phone: "+10000000001"',
  '    token: TOK-REVE-PRIMARY',
  '  secondary:',
  '    # the mouth',
  '    account: rodz@example.com',
  '    phone: "+10000000002"',
  '    token: TOK-REVE-SECONDARY',
];
const REVE_TAIL = ['', '# --- Agents ---', 'agents:', '  egpt:', '    handles: [e]   # wake'];
const REVE = [...REVE_HEAD, ...REVE_LIMBS, '', ...REVE_BEEPER, ...REVE_TAIL];

const DOLLY_BEEPER = [
  '# --- Beeper accounts ---',
  'beeper:',
  '  primary:',
  '    # the ear on kg',
  '    # shared account',
  '    account: an@example.com',
  '    phone: "+10000000001"',
  '    token: TOK-DOLLY-PRIMARY',
  '    owner_node: kg',
  '  # the mouth',
  '  # on this node',
  '  # wakes here',
  '  secondary:',
  '    # rodz',
  '    # second number',
  '    account: rodz@example.com',
  '    phone: "+10000000002"',
  '    token: TOK-DOLLY-SECONDARY',
];
const DOLLY = [
  '# config.yaml - node do (DOLLY).',
  '',
  '# --- Identity ---',
  'node_name: do',
  'user_name: An',
  'peer_nodes: [kg, do]   # co-account',
  'bridge_signature_close: "~"',
  '',
  ...DOLLY_BEEPER,
  '',
  '# agents',
  '# one per being',
  '# on this node',
  'agents:',
  '  don:',
  '    handles: [d]',
];
const under = (lines, n = 2) => lines.map((l) => (l ? `${' '.repeat(n)}${l}` : l));

let root, egptHome;
const cfgPath = () => join(egptHome, 'config', 'config.yaml');
const logs = [];
const ctx = () => ({ id: '0049', egptHome, platform: 'win32', dryRun: false, log: (l) => logs.push(l) });
const write = (text) => { mkdirSync(join(egptHome, 'config'), { recursive: true }); writeFileSync(cfgPath(), text); };
const read = () => readFileSync(cfgPath(), 'utf8');
const vaults = () => (existsSync(join(egptHome, 'disposable')) ? readdirSync(join(egptHome, 'disposable')) : []);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'egpt-0049-')); egptHome = join(root, '.egpt'); logs.length = 0; write(lf(REVE)); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('0049 — top-level beeper: → limbs.beeper', () => {
  it('REPRODUCE: reve states a top-level `beeper:` and an empty `limbs:`', async () => {
    const cfg = YAML.parse(read());
    expect(cfg.limbs).toBe(null);
    expect(Object.keys(cfg.beeper)).toEqual(['primary', 'secondary']);
    expect((await plan(ctx())).satisfied).toBe(false);
  });

  it('reve: the block goes under the existing limbs:, after the operator\'s two comment lines, one blank line kept', async () => {
    const before = YAML.parse(read());
    await (await plan(ctx())).apply();
    expect(read()).toBe(lf([...REVE_HEAD, ...REVE_LIMBS, ...under(REVE_BEEPER), ...REVE_TAIL]));
    const after = YAML.parse(read());
    expect(after.limbs).toEqual({ beeper: before.beeper });
    expect(after.beeper).toBeUndefined();
    expect(beeperBlockOf(after)).toEqual(beeperBlockOf(before));
  });

  it('dolly, CRLF: no limbs: — it is written where beeper: stood, CRLF kept', async () => {
    write(crlf(DOLLY));
    await (await plan(ctx())).apply();
    expect(read()).toBe(crlf([...DOLLY.slice(0, 8), 'limbs:', ...under(DOLLY_BEEPER), ...DOLLY.slice(8 + DOLLY_BEEPER.length)]));
    expect(YAML.parse(read()).limbs.beeper.primary.owner_node).toBe('kg');
  });

  it('a limbs: that already maps a limb takes beeper: beside it, at its indent', async () => {
    write(lf(['beeper:', '  main: { account: a@b, token: T }', 'limbs:', '    http:', '      port: 8080   # chatbox', '# next', 'agents: {}']));
    await (await plan(ctx())).apply();
    expect(read()).toBe(lf(['limbs:', '    http:', '      port: 8080   # chatbox', '    beeper:', '      main: { account: a@b, token: T }', '# next', 'agents: {}']));
  });

  it('backs up into disposable/migration-0049-<ts>/config.yaml, never beside the file', async () => {
    const original = read();
    await (await plan(ctx())).apply();
    const [vault] = vaults();
    expect(vault).toMatch(/^migration-0049-\d{8}T\d{6}$/);
    expect(readFileSync(join(egptHome, 'disposable', vault, 'config.yaml'), 'utf8')).toBe(original);
    expect(readdirSync(join(egptHome, 'config'))).toEqual(['config.yaml']);
    expect(logs.join('\n')).toContain(join('disposable', vault, 'config.yaml'));
  });

  it('is idempotent: satisfied once moved, nothing written the second time', async () => {
    await (await plan(ctx())).apply();
    const moved = read();
    const p = await plan(ctx());
    expect(p.satisfied).toBe(true);
    expect(p.notes.join()).toMatch(/no top-level `beeper:` left/);
    expect(read()).toBe(moved);
    expect(vaults()).toHaveLength(1);
  });

  it('refuses a top-level beeper: beside limbs.beeper, and changes nothing', async () => {
    const both = lf(['limbs:', '  beeper:', '    main: { token: A }', 'beeper:', '  main: { token: B }']);
    write(both);
    await expect(plan(ctx())).rejects.toThrow(/0049 refuses: .*top-level `beeper:` AND `limbs\.beeper`/);
    expect(read()).toBe(both);
    expect(vaults()).toEqual([]);
  });

  it('refuses a beeper: or limbs: it cannot move into, and a config.yaml that does not parse', async () => {
    write(lf(['beeper: { main: { token: A } }']));
    await expect(plan(ctx())).rejects.toThrow(/0049 refuses: `beeper:` is not a block mapping/);
    write(lf(['limbs: {}', 'beeper:', '  main: { token: A }']));
    await expect(plan(ctx())).rejects.toThrow(/0049 refuses: `limbs:` is neither an empty key nor a block mapping/);
    write('beeper: [unclosed\r\n');
    await expect(plan(ctx())).rejects.toThrow(/0049 refuses: .*config\.yaml does not parse/);
  });

  it('refuses to write over an edit made after planning (the operator edits config.yaml in parallel)', async () => {
    const p = await plan(ctx());
    const edited = read().replace('user_name: An', 'user_name: Ann');
    write(edited);
    await expect(p.apply()).rejects.toThrow(/0049 refuses: .*changed since it was planned/);
    expect(read()).toBe(edited);
    expect(vaults()).toEqual([]);
  });

  it('the plan names keys and lines, never a value', async () => {
    const p = await plan(ctx());
    const shown = p.changes.join('\n');
    expect(shown).toMatch(/lines 13-26; keys primary, secondary\) → `limbs\.beeper`, under the existing `limbs:` \(line 9\)/);
    for (const secret of ['TOK-REVE', 'example.com', '+1000']) expect(shown).not.toContain(secret);
  });

  it('through the runner, on a node whose ledger records 0001-0048: applied and recorded', async () => {
    mkdirSync(join(egptHome, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0049');
    writeFileSync(join(egptHome, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-23T00:00:00Z' }]))));
    const { exitCode } = await runMigrations({ through: '0049', egptHome, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(egptHome, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0049-beeper-lives-under-limbs'].outcome).toBe('applied');
    expect(Object.keys(YAML.parse(read()).limbs.beeper)).toEqual(['primary', 'secondary']);
  });
});
