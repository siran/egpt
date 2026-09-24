// 0028 — beings are kept thin. The fixtures carry the exact lines kg and do had on 2026-09-24, CRLF
// like the operator's files: a node ratio, a meta engineer's "lower than the node" block, and the
// room overrides 0022/0023 wrote.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0028-beings-are-kept-thin.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const LOWER = [
  '      # LOWER THRESHOLD THAN THE NODE (operator 2026-09-14). This being is ONE THREAD',
  '      # carrying every chat it is addressed in, so it fills a window far faster than any',
  '      # single chat does. Compact at half the window instead of the node-global ratio.',
  '      compaction:',
  '        ratio: 0.50',
];
const configOf = (meta, nodeRatio) => crlf([
  'agents:',
  '  egpt:',
  '    handles: [ e, egpt ]',
  '    conversation_defaults:',
  '      access_level: sandbox',
  `  ${meta}:`,
  `    scope: agent/${meta}`,
  `    handles: [ ${meta} ]`,
  '    conversation_defaults:',
  ...LOWER,
  '      access_level: all',
  '      sandboxed: false',
  '',
  'compaction:',
  '  enabled: true',
  `  ratio: ${nodeRatio}`,
  '  cooling_ms: 600000 # 10 minutes of quiet',
]);
const ROOM_OVERRIDE = [
  '        # THIS ROOM CARRIES EVERY CHAT INVITED INTO IT (0022). Compact at HALF the window.',
  '        compaction:',
  '          ratio: 0.50',
];
const KG_ROOMS = crlf([
  'rooms:',
  '  room/acim:',
  '    agents:',
  '      egpt:',
  '        threadId: 892d0ee4-8330-4edf-9408-2e0a5a543c90',
  ...ROOM_OVERRIDE,
  '        outbox_to: acim-drive',
]);
const DO_ROOMS = crlf([
  'rooms:',
  '  room/dj-son:',
  '    agents:',
  '      pi:',
  '        threadId: dcc2f09d-5291-45fd-9170-d225d229f437',
  ...ROOM_OVERRIDE,
  '  room/acim-do:',
  '    agents:',
  '      don:',
  '        access_level: sandbox',
  ...ROOM_OVERRIDE,
]);

let root, egptHome;
const file = (n) => join(egptHome, 'config', n);
const ctx = () => ({
  id: '0028', egptHome, platform: 'win32', dryRun: false, log: () => {},
  backup: (p) => { const b = `${p}.bak-0028-test`; writeFileSync(b, readFileSync(p)); return b; },
});
const write = (n, text) => { mkdirSync(join(egptHome, 'config'), { recursive: true }); writeFileSync(file(n), text); };
const yaml = (n) => YAML.parse(readFileSync(file(n), 'utf8'));
const node = (config, rooms) => { write('config.yaml', config); if (rooms) write('rooms.yaml', rooms); };

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'egpt-0028-')); egptHome = join(root, '.egpt'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('0028 — beings are kept thin', () => {
  it('REPRODUCE (kg): node 0.80 and the meta engineer and acim at 0.50 - nothing thin, and the meta engineer BELOW the node', async () => {
    node(configOf('wren', '0.80'), KG_ROOMS);
    expect(yaml('config.yaml').compaction.ratio).toBe(0.8);
    expect(yaml('config.yaml').agents.wren.conversation_defaults.compaction.ratio).toBe(0.5);
    expect((await plan(ctx())).satisfied).toBe(false);
  });

  it('kg: the node goes to 0.2, wren and acim\'s being to 0.8', async () => {
    node(configOf('wren', '0.80'), KG_ROOMS);
    await (await plan(ctx())).apply();
    expect(yaml('config.yaml').compaction.ratio).toBe(0.2);
    expect(yaml('config.yaml').agents.wren.conversation_defaults.compaction).toEqual({ ratio: 0.8 });
    expect(yaml('rooms.yaml').rooms['room/acim'].agents.egpt.compaction).toEqual({ ratio: 0.8 });
  });

  it('do: the node goes to 0.2, dren to 0.8, and the rooms not named lose their override', async () => {
    node(configOf('dren', '0.65'), DO_ROOMS);
    await (await plan(ctx())).apply();
    expect(yaml('config.yaml').compaction.ratio).toBe(0.2);
    expect(yaml('config.yaml').agents.dren.conversation_defaults.compaction).toEqual({ ratio: 0.8 });
    const rooms = yaml('rooms.yaml').rooms;
    expect(rooms['room/dj-son'].agents.pi.compaction).toBeUndefined();
    expect(rooms['room/acim-do'].agents.don.compaction).toBeUndefined();
    expect(rooms['room/acim-do'].agents.don.access_level).toBe('sandbox');
  });

  it('the "lower than the node" comments go with their values, and the new blocks say why they are higher', async () => {
    node(configOf('wren', '0.80'), KG_ROOMS);
    await (await plan(ctx())).apply();
    const cfg = readFileSync(file('config.yaml'), 'utf8');
    const rooms = readFileSync(file('rooms.yaml'), 'utf8');
    expect(cfg).not.toMatch(/LOWER THRESHOLD THAN THE NODE/);
    expect(rooms).not.toMatch(/Compact at HALF the window/);
    expect(cfg).toMatch(/HIGHER THAN THE NODE \(0028, operator 2026-09-24: "metaeng 0\.8"\)/);
    expect(cfg).toMatch(/# THIN \(0028/);
    expect(rooms).toMatch(/"acim has an acim-E, we can keep it at \.8"/);
  });

  it('touches nothing else: every other key of both files reads exactly as before', async () => {
    node(configOf('wren', '0.80'), KG_ROOMS);
    const before = { cfg: yaml('config.yaml'), rooms: yaml('rooms.yaml') };
    await (await plan(ctx())).apply();
    const after = { cfg: yaml('config.yaml'), rooms: yaml('rooms.yaml') };
    expect(after.cfg.agents.egpt).toEqual(before.cfg.agents.egpt);
    const { compaction: _w, ...wrenRest } = after.cfg.agents.wren.conversation_defaults;
    const { compaction: _v, ...wrenBefore } = before.cfg.agents.wren.conversation_defaults;
    expect(wrenRest).toEqual(wrenBefore);
    expect({ ...after.cfg.compaction, ratio: null }).toEqual({ ...before.cfg.compaction, ratio: null });
    const { compaction: _a, ...acimRest } = after.rooms.rooms['room/acim'].agents.egpt;
    const { compaction: _b, ...acimBefore } = before.rooms.rooms['room/acim'].agents.egpt;
    expect(acimRest).toEqual(acimBefore);
  });

  it('keeps CRLF, backs up both files first, and is satisfied afterwards', async () => {
    node(configOf('wren', '0.80'), KG_ROOMS);
    await (await plan(ctx())).apply();
    for (const n of ['config.yaml', 'rooms.yaml']) {
      expect(readFileSync(file(n), 'utf8').split('\n').slice(0, -1).every((l) => l.endsWith('\r'))).toBe(true);
    }
    expect(readdirSync(join(egptHome, 'config')).filter((n) => n.includes('bak-0028')).sort()).toEqual(['config.yaml.bak-0028-test', 'rooms.yaml.bak-0028-test']);
    expect((await plan(ctx())).satisfied).toBe(true);
  });

  it('matches the meta engineer by handle, not by key', async () => {
    node(configOf('wren', '0.80').replace('  wren:\r\n', '  builder:\r\n').replace('agent/wren', 'agent/builder'));
    await (await plan(ctx())).apply();
    expect(yaml('config.yaml').agents.builder.conversation_defaults.compaction).toEqual({ ratio: 0.8 });
  });

  it('a node already there is satisfied, and one with no rooms.yaml is fine', async () => {
    node(configOf('wren', '0.2').replace('        ratio: 0.50', '        ratio: 0.8'));
    const p = await plan(ctx());
    expect(p.satisfied).toBe(true);
  });

  it('refuses, naming the place, when a compaction it must edit is not a mapping', async () => {
    node(configOf('wren', '0.80').replace('      compaction:\r\n        ratio: 0.50', '      compaction: 0.5'));
    await expect(plan(ctx())).rejects.toThrow(/0028 refuses: agents\.wren\.conversation_defaults\.compaction .* not a mapping/);
  });

  it('through the runner, on a node whose ledger already records 0001-0027: applied and recorded', async () => {
    node(configOf('wren', '0.80'), KG_ROOMS);
    // A real node's ledger - so the runner never loads an earlier migration against this minimal
    // fixture, which is not a whole node and is not meant to satisfy them.
    mkdirSync(join(egptHome, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0028');
    writeFileSync(join(egptHome, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-09-24T00:00:00Z' }]))));
    const { exitCode } = await runMigrations({ through: '0028', egptHome, elevated: false, platform: 'win32', ctx: { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set(), findChrome: () => null, isDirectory: () => false }, log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(egptHome, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0028-beings-are-kept-thin'].outcome).toBe('applied');
    expect(yaml('config.yaml').compaction.ratio).toBe(0.2);
  });
});
