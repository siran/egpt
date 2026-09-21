// tests/migrations-0010-stray-handle-records.test.mjs — migrations/0010-stray-handle-records.mjs.
//
// Fixtures are miniatures of kg's REAL state as measured by the operator on 2026-09-17: config.yaml
// keys E as `egpt` and declares `handles: [ e, egpt, ekg, egptkg ]`; config/rooms.yaml is CRLF and
// carries, under `room/lobby:` → `agents:`, the real `egpt:` block (threadId / threadCreatedAt /
// identityInjectedAt) and then a stray `      e:` whose only child is `        threadId: null`.
// Nothing else on kg has one, and do has none.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0010-stray-handle-records.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

const KG_CONFIG = crlf([
  '# config.yaml - kg (fixture)',
  'node_name: kg',
  'agents:',
  '  egpt:',
  '    configuration: sonnet-default',
  '    handles: [ e, egpt, ekg, egptkg ]',
  '    default: true',
  '  ken:',
  '    configuration: opus-xhigh',
  '    handles: [ ken ]',
]);

const ROOMS_BEFORE = [
  '# rooms.yaml - kg (fixture)',
  'rooms:',
  '  room/lobby:',
  '    agents:',
  '      egpt:',
  '        threadId: 9d1e-fixture',
  '        threadCreatedAt: "2026-09-16T10:00:00.000Z"',
  '        identityInjectedAt: "2026-09-16T10:00:01.000Z"',
];
// The stray, byte for byte as measured.
const STRAY = [
  '      e:',
  '        threadId: null',
];
const ROOMS_AFTER = [
  '  room/radio:',
  '    agents:',
  '      egpt:',
  '        access_level: all',
];
const ROOMS = crlf([...ROOMS_BEFORE, ...STRAY, ...ROOMS_AFTER]);
const ROOMS_WITHOUT = crlf([...ROOMS_BEFORE, ...ROOMS_AFTER]);

const CONVERSATIONS = crlf([
  'contacts:',
  '  whatsapp:',
  '    "120363000000000001@g.us": # Reencuentro CRC',
  '      conversation_path: .egpt/conversations/whatsapp/Reencuentro CRC',
  '      agents:',
  '        egpt:',
  '          threadId: 0a1b-fixture',
]);

const DO_CONFIG = 'node_name: do\nagents:\n  egpt:\n    configuration: haiku-low\n    handles: [ d, don ]\n    default: true\n';

function home({ config = KG_CONFIG, rooms, conversations, files = {} } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'egpt-0010-'));
  mkdirSync(join(h, 'config'), { recursive: true });
  if (config !== null) writeFileSync(join(h, 'config', 'config.yaml'), config);
  if (rooms !== undefined) writeFileSync(roomsPath(h), rooms);
  if (conversations !== undefined) writeFileSync(convPath(h), conversations);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(h, rel, '..'), { recursive: true });
    writeFileSync(join(h, rel), text);
  }
  return h;
}
const roomsPath = (h) => join(h, 'config', 'rooms.yaml');
const convPath = (h) => join(h, 'config', 'conversations.yaml');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0010-test`; writeFileSync(to, readFileSync(f)); return to; } });

describe('0010 on kg - one stray `e:` record under room/lobby', () => {
  it('plans removing exactly the two lines of the stray record', async () => {
    const h = home({ rooms: ROOMS, conversations: CONVERSATIONS });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    const first = ROOMS_BEFORE.length + 1;
    expect(p.changes).toEqual([
      `${roomsPath(h)}:${first}-${first + STRAY.length - 1}  remove rooms.room/lobby.agents.e (${STRAY.length} lines):`,
      ...STRAY.map((l) => `  - ${l}`),
      'backup first, beside each: <file>.bak-0010-<timestamp>',
    ]);
  });

  it('apply: rooms.yaml is byte-identical except those two lines (CRLF, the real egpt: block and room/radio kept), backed up', async () => {
    const h = home({ rooms: ROOMS, conversations: CONVERSATIONS });
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(ROOMS_WITHOUT);
    expect(readFileSync(roomsPath(h), 'utf8')).toContain('identityInjectedAt: "2026-09-16T10:00:01.000Z"\r\n  room/radio:\r\n');
    expect(readFileSync(`${roomsPath(h)}.bak-0010-test`, 'utf8')).toBe(ROOMS);
    expect(readFileSync(convPath(h), 'utf8')).toBe(CONVERSATIONS);          // untouched, and no backup of it
    expect(existsSync(`${convPath(h)}.bak-0010-test`)).toBe(false);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('refuses to write over a rooms.yaml edited between plan and apply, and touches nothing', async () => {
    const h = home({ rooms: ROOMS });
    const p = await plan(ctxFor(h));
    const edited = ROOMS.replace('access_level: all', 'access_level: regular');
    writeFileSync(roomsPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0010 refuses: .*rooms\.yaml changed since it was planned - re-run/);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(edited);
    expect(readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  it('a stray in config/conversations.yaml is found the same way', async () => {
    const conv = CONVERSATIONS.replace('          threadId: 0a1b-fixture\r\n', '          threadId: 0a1b-fixture\r\n        ekg:\r\n          threadId: null\r\n');
    const h = home({ conversations: conv });
    const p = await plan(ctxFor(h));
    expect(p.changes[0]).toContain('remove contacts.whatsapp.120363000000000001@g.us.agents.ekg');
    await p.apply();
    expect(readFileSync(convPath(h), 'utf8')).toBe(CONVERSATIONS);
  });

  it('two strays, one in each file, are planned and written in one pass', async () => {
    const conv = CONVERSATIONS.replace('          threadId: 0a1b-fixture\r\n', '          threadId: 0a1b-fixture\r\n        egptkg:\r\n          threadId: null\r\n');
    const h = home({ rooms: ROOMS, conversations: conv });
    const p = await plan(ctxFor(h));
    expect(p.changes.filter((c) => c.includes('  remove '))).toHaveLength(2);
    await p.apply();
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(ROOMS_WITHOUT);
    expect(readFileSync(convPath(h), 'utf8')).toBe(CONVERSATIONS);
  });
});

describe('0010 is satisfied where there is nothing this bug made', () => {
  it('do has no registry file at all: satisfied, nothing touched', async () => {
    const h = home({ config: DO_CONFIG });
    expect(await plan(ctxFor(h))).toEqual({ satisfied: true, notes: ['no handle-named being record in config/rooms.yaml or config/conversations.yaml — nothing to remove'] });
    expect(readdirSync(join(h, 'config')).sort()).toEqual(['config.yaml']);
  });

  it('a record named after the agent KEY is never a stray, even holding only threadId: null', async () => {
    const rooms = crlf(['rooms:', '  room/lobby:', '    agents:', '      egpt:', '        threadId: null']);
    const h = home({ rooms });
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(rooms);
  });

  it('a REAL being record nobody claims as a handle (a turn-seeded sibling) is left alone', async () => {
    const rooms = crlf(['rooms:', '  room/lobby:', '    agents:', '      wren:', '        threadId: null']);
    const h = home({ rooms });
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(rooms);
  });

  it("an agent that declares NO handles: keeps its key as its handle, so its own record is not a stray", async () => {
    const config = crlf(['agents:', '  carol:', '    configuration: sonnet-default']);
    const rooms = crlf(['rooms:', '  room/lobby:', '    agents:', '      carol:', '        threadId: null']);
    const h = home({ config, rooms });
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
  });
});

describe('0010 refuses, naming the record, for anything holding more than an empty thread', () => {
  const roomsWith = (lines) => crlf(['rooms:', '  room/lobby:', '    agents:', '      egpt:', '        threadId: 9d1e-fixture', ...lines]);

  it('a handle-named record with a REAL threadId', async () => {
    const h = home({ rooms: roomsWith(['      e:', '        threadId: 4c4c-live']) });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0010 refuses: these records are named after a handle.*rooms\.yaml: rooms\.room\/lobby\.agents\.e = \{"threadId":"4c4c-live"\}/);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(roomsWith(['      e:', '        threadId: 4c4c-live']));
  });

  it('a handle-named record carrying another field beside threadId: null', async () => {
    const h = home({ rooms: roomsWith(['      e:', '        threadId: null', '        mode: on']) });
    await expect(plan(ctxFor(h))).rejects.toThrow(/rooms\.room\/lobby\.agents\.e = \{"threadId":null,"mode":"on"\}/);
  });

  it('a handle-named record that is not a mapping at all', async () => {
    const h = home({ rooms: roomsWith(['      e: 42']) });
    await expect(plan(ctxFor(h))).rejects.toThrow(/rooms\.room\/lobby\.agents\.e = 42/);
  });

  it('a registry file it must check that does not parse is refused, not skipped', async () => {
    const h = home({ rooms: 'rooms: [ broken\n' });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0010 refuses: .*rooms\.yaml does not parse/);
  });

  it('no config.yaml: refused, because a KEY cannot be told from a HANDLE', async () => {
    const h = home({ config: null, rooms: ROOMS });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0010 refuses: there is no .*config\.yaml/);
  });
});

describe('0010 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is empty
  // so 0007 reads nothing as this node's own (as tests/migrations-0009-*).
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');

  it('kg: 0010 applies, is recorded, removes only the stray lines, and leaves a backup', async () => {
    const h = home({ rooms: ROOMS, conversations: CONVERSATIONS });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0010-stray-handle-records'].outcome).toBe('applied');
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(ROOMS_WITHOUT);
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('rooms.yaml.bak-0010-'))).toHaveLength(1);
  });

  it('do: recorded as already satisfied, nothing touched, no backup', async () => {
    const h = home({ config: DO_CONFIG });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0010-stray-handle-records'].outcome).toBe('already-satisfied');
    // 0018 runs later in the same chain and keys this fixture's persona by its handle (`don`),
    // leaving its own backup beside the config. What is asserted here is that 0010 left no mark.
    expect(readdirSync(join(h, 'config')).sort().filter((f) => !f.startsWith('config.yaml.bak-0018-'))).toEqual(['config.yaml']);
  });
});
