// tests/migrations-0009-gauss-is-gone.test.mjs — migrations/0009-gauss-is-gone.mjs.
//
// Fixtures are miniatures of each node's REAL state as measured by the operator on 2026-09-17: kg's
// config.yaml is CRLF and carries the gauss block VERBATIM below (its four comment lines, `gauss:`
// and its lines), directly after ken's last line and directly before `codex:`, plus
// config/agents/identities/gauss.md (527 bytes, starts `# I am Gauss`); nothing else on kg names
// gauss. do has no gauss at all.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0009-gauss-is-gone.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

const KG_BEFORE = [
  '# config.yaml - kg (fixture)',
  'node_name: kg',
  'agents:',
  '  egpt:',
  '    configuration: sonnet-default',
  '    handles: [ e ]',
  '    default: true',
  '  ken:',
  '    configuration: opus-xhigh # config/agents/opus-xhigh.yaml',
  '    personality: ken',
  '    handles: [ ken ]',
  '    conversation_defaults:',
  '      verbose_thinking: true # rescued from ken.yaml; this tier outranks the brain def',
];
// kg's lines 69-82 as measured, byte for byte.
const GAUSS = [
  '  # GAUSS (operator 2026-09-16) - the number researcher. Woken by the primo-del-dia-contexto',
  '  # heartbeat in Reencuentro CRC, 5 minutes after the prime is posted: reads prime-of-the-day.txt',
  '  # and looks up where that number turns up in the world. Its own being, so it runs opus-xhigh',
  '  # without touching E\'s model; mode: mention so it stays out of ordinary chatter.',
  '  gauss:',
  '    configuration: opus-xhigh # config/agents/opus-xhigh.yaml - SHARED with ken',
  '    personality: gauss # config/agents/identities/gauss.md',
  '    handles: [ gauss ] # NOT primo: a bare leading handle addresses, and "primo" opens ordinary Spanish sentences',
  '    name: "Gauss"',
  '    body_emoji: "🔢"',
  '    mode: mention',
  '    conversation_defaults:',
  '      access_level: sandbox',
];
const KG_AFTER = [
  '  codex:',
  '    configuration: codex',
  '    handles: [ codex ]',
  'heartbeats:',
  '  alive: true',
];
const KG = crlf([...KG_BEFORE, ...GAUSS, ...KG_AFTER]);
const KG_WITHOUT = crlf([...KG_BEFORE, ...KG_AFTER]);
const IDENTITY = `# I am Gauss\r\n\r\n${'I look up where the prime of the day turns up in the world. '.repeat(8)}\r\n`;

const DO = `node_name: do\nagents:\n  egpt:\n    configuration: haiku-low\n    handles: [ d, don ]\n    default: true\n`;

// The heartbeat the operator runs in Reencuentro CRC - as E, which is NOT a reference to gauss.
const CONVERSATIONS = crlf([
  'contacts:',
  '  whatsapp:',
  '    "120363000000000001@g.us": # Reencuentro CRC',
  '      conversation_path: .egpt/conversations/whatsapp/Reencuentro CRC',
  '      heartbeats:',
  '        primo-del-dia-contexto:',
  '          frequency: 24h',
  '          agent: e',
  '          prompt: "el primo del dia"',
  '      agents:',
  '        egpt:',
  '          threadId: 0a1b-fixture',
]);

function home({ config, identity, conversations, files = {} } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'egpt-0009-'));
  mkdirSync(join(h, 'config', 'agents', 'identities'), { recursive: true });
  if (config !== undefined) writeFileSync(join(h, 'config', 'config.yaml'), config);
  if (identity !== undefined) writeFileSync(idPath(h), identity);
  if (conversations !== undefined) writeFileSync(join(h, 'config', 'conversations.yaml'), conversations);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(h, rel, '..'), { recursive: true });
    writeFileSync(join(h, rel), text);
  }
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const idPath = (h) => join(h, 'config', 'agents', 'identities', 'gauss.md');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0009-test`; writeFileSync(to, readFileSync(f)); return to; } });

describe('0009 on kg - gauss is defined, and nothing references it', () => {
  it('plans removing exactly the gauss block and the four comment lines above it, and deleting its identity file', async () => {
    const h = home({ config: KG, identity: IDENTITY, conversations: CONVERSATIONS });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    const first = KG_BEFORE.length + 1;
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${first}-${first + GAUSS.length - 1}  remove agents.gauss and the comment above it (${GAUSS.length} lines):`,
      ...GAUSS.map((l) => `  - ${l}`),
      `delete ${idPath(h)} (${Buffer.byteLength(IDENTITY)} bytes)`,
      'backup first, beside each: <file>.bak-0009-<timestamp>',
    ]);
  });

  it('apply: config.yaml is byte-identical except the removed lines (CRLF, ken\'s last line and codex kept), the identity file is gone, both backed up', async () => {
    const h = home({ config: KG, identity: IDENTITY, conversations: CONVERSATIONS });
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_WITHOUT);
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('verbose_thinking: true # rescued from ken.yaml; this tier outranks the brain def\r\n  codex:\r\n');
    expect(existsSync(idPath(h))).toBe(false);
    expect(readFileSync(`${cfgPath(h)}.bak-0009-test`, 'utf8')).toBe(KG);
    expect(readFileSync(`${idPath(h)}.bak-0009-test`, 'utf8')).toBe(IDENTITY);
    expect(readFileSync(join(h, 'config', 'conversations.yaml'), 'utf8')).toBe(CONVERSATIONS);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('refuses to write over a config.yaml edited between plan and apply, and touches nothing', async () => {
    const h = home({ config: KG, identity: IDENTITY });
    const p = await plan(ctxFor(h));
    const edited = KG.replace('handles: [ codex ]', 'handles: [ codex, cx ]');
    writeFileSync(cfgPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0009 refuses: .*config\.yaml changed since it was planned - re-run/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(edited);
    expect(readFileSync(idPath(h), 'utf8')).toBe(IDENTITY);
    expect(readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  it('refuses when the identity file changed between plan and apply', async () => {
    const h = home({ config: KG, identity: IDENTITY });
    const p = await plan(ctxFor(h));
    writeFileSync(idPath(h), `${IDENTITY}one more line\r\n`);
    await expect(p.apply()).rejects.toThrow(/0009 refuses: .*gauss\.md changed since it was planned - re-run/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
  });
});

describe('0009 is satisfied, or finishes, where there is less to do', () => {
  it('do has no gauss and no identity file: satisfied, nothing touched', async () => {
    const h = home({ config: DO });
    expect(await plan(ctxFor(h))).toEqual({ satisfied: true, notes: ['no agents.gauss in config.yaml and no config/agents/identities/gauss.md - nothing to evict'] });
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
    expect(readdirSync(join(h, 'config')).sort()).toEqual(['agents', 'config.yaml']);
  });

  it('satisfied is checked FIRST: a node with no gauss is not refused over a leftover heartbeat naming it', async () => {
    const h = home({ config: DO, files: { 'config/rooms.yaml': 'rooms:\n  room/crc:\n    heartbeats:\n      x:\n        agent: gauss\n' } });
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
  });

  it('only the block is left (the identity file is already gone): it removes the block alone', async () => {
    const h = home({ config: KG });
    const p = await plan(ctxFor(h));
    expect(p.changes.some((c) => c.startsWith('delete '))).toBe(false);
    await p.apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_WITHOUT);
  });

  it('only the identity file is left (the block is already gone): it deletes the file alone, config.yaml untouched', async () => {
    const h = home({ config: KG_WITHOUT, identity: IDENTITY });
    const p = await plan(ctxFor(h));
    expect(p.changes).toEqual([`delete ${idPath(h)} (${Buffer.byteLength(IDENTITY)} bytes)`, 'backup first, beside each: <file>.bak-0009-<timestamp>']);
    await p.apply();
    expect(existsSync(idPath(h))).toBe(false);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_WITHOUT);
    expect(existsSync(`${cfgPath(h)}.bak-0009-test`)).toBe(false);
  });
});

describe('0009 refuses, naming the place, while anything still references gauss', () => {
  const beat = (indent) => ['heartbeats:', '  primo-contexto:', '    frequency: 24h', '    agent: gauss', '    prompt: "busca el primo"'].map((l) => `${' '.repeat(indent)}${l}`).join('\n');

  it('a heartbeat agent: gauss in config/rooms.yaml', async () => {
    const h = home({ config: KG, identity: IDENTITY, files: { 'config/rooms.yaml': `rooms:\n  room/crc:\n${beat(4)}\n` } });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0009 refuses: gauss is still referenced.*rooms\.yaml: rooms\.room\/crc\.heartbeats\.primo-contexto\.agent = "gauss"/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
    expect(existsSync(idPath(h))).toBe(true);
  });

  it('a heartbeat agent: gauss in config/conversations.yaml', async () => {
    const h = home({ config: KG, identity: IDENTITY, conversations: CONVERSATIONS.replace('agent: e', 'agent: gauss') });
    await expect(plan(ctxFor(h))).rejects.toThrow(/conversations\.yaml: contacts\.whatsapp\.120363000000000001@g\.us\.heartbeats\.primo-del-dia-contexto\.agent = "gauss"/);
  });

  it('a heartbeat agent: gauss in an entity config.yaml under conversations/ or rooms/', async () => {
    const conv = home({ config: KG, identity: IDENTITY, files: { 'conversations/whatsapp/Reencuentro CRC/config.yaml': `${beat(0)}\n` } });
    await expect(plan(ctxFor(conv))).rejects.toThrow(/Reencuentro CRC[\\/]config\.yaml: heartbeats\.primo-contexto\.agent = "gauss"/);
    const room = home({ config: KG, identity: IDENTITY, files: { 'rooms/crc/config.yaml': `${beat(0)}\n` } });
    await expect(plan(ctxFor(room))).rejects.toThrow(/rooms[\\/]crc[\\/]config\.yaml: heartbeats\.primo-contexto\.agent = "gauss"/);
  });

  it('a conversations.yaml agents.gauss record', async () => {
    const conv = CONVERSATIONS.replace('      agents:\r\n', '      agents:\r\n        gauss:\r\n          threadId: 9f9f-fixture\r\n');
    const h = home({ config: KG, identity: IDENTITY, conversations: conv });
    await expect(plan(ctxFor(h))).rejects.toThrow(/conversations\.yaml: contacts\.whatsapp\.120363000000000001@g\.us\.agents\.gauss/);
  });

  it('a heartbeat that runs as E (the real primo-del-dia-contexto) is not a reference', async () => {
    const h = home({ config: KG, identity: IDENTITY, conversations: CONVERSATIONS });
    expect((await plan(ctxFor(h))).satisfied).toBe(false);
  });

  it('a file it must check that does not parse is refused, not skipped', async () => {
    const h = home({ config: KG, identity: IDENTITY, files: { 'config/rooms.yaml': 'rooms: [ broken\n' } });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0009 refuses: .*rooms\.yaml does not parse/);
  });
});

describe('0009 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is empty so
  // 0007 reads nothing as this node's own (as tests/migrations-0008-*).
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');
  // 0025 runs LAST in this chain and states an `access_level:` on every being that declares none,
  // so the live config.yaml is no longer the end state THIS migration is about. Its BACKUP is:
  // ctx.backup copies the file the instant before 0025 writes it, which is exactly what the chain
  // up to 0024 left behind - so the byte-for-byte assertions below are unchanged.
  const upTo0024 = (h) => {
    const d = join(h, 'config');
    return readFileSync(join(d, readdirSync(d).find((f) => f.startsWith('config.yaml.bak-0025-'))), 'utf8');
  };

  it('kg: 0009 applies, is recorded, removes only the gauss lines and the identity file, and leaves a backup of each', async () => {
    const h = home({ config: KG, identity: IDENTITY, conversations: CONVERSATIONS });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0009-gauss-is-gone'].outcome).toBe('applied');
    expect(upTo0024(h)).toBe(KG_WITHOUT);
    expect(existsSync(idPath(h))).toBe(false);
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('config.yaml.bak-0009-'))).toHaveLength(1);
    expect(readdirSync(join(h, 'config', 'agents', 'identities')).filter((f) => f.startsWith('gauss.md.bak-0009-'))).toHaveLength(1);
  });

  it('do: recorded as already satisfied, nothing touched, no backup', async () => {
    const h = home({ config: DO });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0009-gauss-is-gone'].outcome).toBe('already-satisfied');
    // Three later migrations act on this same fixture: 0018 keys do's persona by its handle
    // (`don`), 0020 hands it `rodz` and 0025 states the level it already resolves to. None of them
    // is 0009's doing — what is asserted here is that 0009 itself left no mark: no file of its own,
    // and no backup of its own.
    expect(upTo0024(h)).toBe(DO.replace('  egpt:', '  don:').replace('[ d, don ]', '[ d, don, rodz ]'));
    expect(readdirSync(join(h, 'config')).filter((f) => !f.includes('.bak-')).sort()).toEqual(['agents', 'config.yaml']);
    expect(readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-0009-'))).toEqual([]);
  });
});
