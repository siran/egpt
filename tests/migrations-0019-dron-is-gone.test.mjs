// tests/migrations-0019-dron-is-gone.test.mjs — migrations/0019-dron-is-gone.mjs.
//
// Fixtures are miniatures of each node's REAL state as measured by the operator on 2026-09-20. do
// carries the trap the whole alignment came out of: the being it calls `dron` is KEYED `rodz`
// (name "Dron", `handles: [ dron ]`), already `access_level: all` because 0016 promoted it, plus
// ONE per-chat record in config/conversations.yaml and config/agents/identities/dron.md. kg has
// nothing answering to `dron` at all — its own `rodz` being answers to `rodz`/`r` and is 0020's
// business, not this one's — so kg reads SATISFIED, never refused.
//
// The assertions are on the FULL text, never a re-parse: a comment is not part of the parse, and
// what survives the removal is exactly what these migrations exist to protect. CRLF throughout, as
// the live configs are.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0019-dron-is-gone.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

// ── do ───────────────────────────────────────────────────────────────────────────────────────
const DO_BEFORE = [
  '# config.yaml - do (fixture)',
  'node_name: do',
  'agents:',
  '  don:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ d, don ]',
  '    default: true',
  '    name: "D"',
  '    conversation_defaults:',
  '      access_level: regular',
  '      allowed_users: [ "1555@s.whatsapp.net", "1666@s.whatsapp.net" ]',
  '',
];
// The block as it reads on do: KEYED `rodz`, and only `handles:` says it is dron.
const DRON = [
  '  # DRON (0016) - the being the operator calls dron, KEYED `rodz`: that is the trap. The mouth',
  '  # it is named beside is an ACCOUNT (beeper.secondary, dolly.egpt@gmail.com).',
  '  rodz:',
  '    configuration: sonnet-high # config/agents/sonnet-high.yaml',
  '    personality: dron # config/agents/identities/dron.md',
  '    handles: [ dron ]',
  '    name: "Dron"',
  '    conversation_defaults:',
  '      access_level: all',
  '      allowed_users: [ "1555@s.whatsapp.net", "1666@s.whatsapp.net" ]',
  '      sandboxed: false',
];
const DO_AFTER = [
  '  # codex, which is not going anywhere',
  '  codex:',
  '    configuration: codex',
  '    handles: [ codex ]',
  'heartbeats:',
  '  alive: true',
];
const DO = crlf([...DO_BEFORE, ...DRON, ...DO_AFTER]);
const DO_WITHOUT = crlf([...DO_BEFORE, ...DO_AFTER]);

// do's ONE per-chat record for it, beside the persona's in the same `agents:` block.
const CONV_BEFORE = [
  'contacts:',
  '  whatsapp:',
  '    "120363000000000002@g.us": # Casa',
  '      conversation_path: .egpt/conversations/whatsapp/Casa',
  '      agents:',
  '        don:',
  '          threadId: aaaa-1111',
  '          threadCreatedAt: 2026-09-18T10:00:00.000Z',
];
const CONV_DRON = [
  '        # dron keeps its own thread in this chat',
  '        rodz:',
  '          threadId: bbbb-2222',
  '          threadCreatedAt: 2026-09-19T11:00:00.000Z',
];
const CONV = crlf([...CONV_BEFORE, ...CONV_DRON]);
const CONV_WITHOUT = crlf(CONV_BEFORE);
// rooms.yaml has no record for it (measured) - it is read, and left byte-identical.
const ROOMS = crlf(['rooms:', '  room/lobby:', '    agents:', '      egpt:', '        threadId: cccc-3333']);

const IDENTITY = `# I am Dron\r\n\r\n${'I am the meta engineer on do. '.repeat(10)}\r\n`;

// ── kg: nothing answers to `dron`. Its `rodz` being answers to `rodz`/`r`, which is 0020's half. ──
const KG = crlf([
  '# config.yaml - kg (fixture)',
  'node_name: kg',
  'agents:',
  '  egpt:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ e, egpt, ekg ]',
  '    default: true',
  '    name: "E"',
  '    conversation_defaults:',
  '      access_level: sandbox',
  '      allowed_users: [ "1555@s.whatsapp.net" ]',
  '',
  '  # RODZ - a persona named after the mouth. 0020 removes it; 0019 leaves it alone.',
  '  rodz:',
  '    configuration: sonnet-high # config/agents/sonnet-high.yaml',
  '    personality: rodz # config/agents/identities/rodz.md',
  '    handles: [ rodz, r ]',
  '    name: "Rodz"',
  '    conversation_defaults:',
  '      access_level: sandbox',
]);

// The two type files the persona and the being name. Neither pins a `cwd`, and there is no
// opus-high.yaml - which is what keeps 0011/0012/0014 satisfied on these fixtures.
const TYPES = { 'sonnet-default': 'type: ccode\nmodel: sonnet\neffort: high\n', 'sonnet-high': 'type: ccode\nmodel: sonnet\neffort: high\n' };

function home({ config = DO, conversations = CONV, rooms = ROOMS, identity = IDENTITY, identities = {} } = {}) {
  // `.egpt` nested inside the temp dir, so `<parent>/src` does not exist and 0015 stays satisfied.
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0019-')), '.egpt');
  mkdirSync(join(h, 'config', 'agents', 'identities'), { recursive: true });
  // `null` means "this node does not have that file" - `undefined` would take the default above.
  if (config !== null) writeFileSync(join(h, 'config', 'config.yaml'), config);
  if (conversations !== null) writeFileSync(join(h, 'config', 'conversations.yaml'), conversations);
  if (rooms !== null) writeFileSync(join(h, 'config', 'rooms.yaml'), rooms);
  if (identity !== null) writeFileSync(idPath(h), identity);
  for (const [name, text] of Object.entries(TYPES)) writeFileSync(join(h, 'config', 'agents', `${name}.yaml`), text);
  for (const [name, text] of Object.entries(identities)) writeFileSync(join(h, 'config', 'agents', 'identities', `${name}.md`), text);
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const convPath = (h) => join(h, 'config', 'conversations.yaml');
const roomsPath = (h) => join(h, 'config', 'rooms.yaml');
const idPath = (h) => join(h, 'config', 'agents', 'identities', 'dron.md');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0019-test`; writeFileSync(to, readFileSync(f)); return to; } });
const baks = (h) => readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'));

const FIRST = DO_BEFORE.length + 1;

describe('0019 on do - the being KEYED `rodz` is the one that answers to `dron`', () => {
  it('plans the block and its comment, the per-chat record WITH ITS threadId, and the identity file', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${FIRST}-${FIRST + DRON.length - 1}  remove agents.rodz - the being that answers to \`dron\` and the comment above it (${DRON.length} lines):`,
      ...DRON.map((l) => `  - ${l}`),
      `${convPath(h)}:${CONV_BEFORE.length + 1}-${CONV_BEFORE.length + CONV_DRON.length}  remove contacts.whatsapp.120363000000000002@g.us.agents.rodz - threadId "bbbb-2222" (${CONV_DRON.length} lines):`,
      ...CONV_DRON.map((l) => `  - ${l}`),
      `delete ${idPath(h)} (${Buffer.byteLength(IDENTITY)} bytes) - the identity it wore, declared by no other being here`,
      'backup first, beside each: <file>.bak-0019-<timestamp>',
    ]);
  });

  it('apply: every file byte-identical except the removed lines, the identity gone, each backed up', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO_WITHOUT);
    // The blank line above the removed comment, and the NEXT key's own comment, both survive.
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('"1666@s.whatsapp.net" ]\r\n\r\n  # codex, which is not going anywhere\r\n  codex:\r\n');
    expect(readFileSync(convPath(h), 'utf8')).toBe(CONV_WITHOUT);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(ROOMS);           // read, never rewritten
    expect(existsSync(idPath(h))).toBe(false);
    expect(readFileSync(`${cfgPath(h)}.bak-0019-test`, 'utf8')).toBe(DO);
    expect(readFileSync(`${convPath(h)}.bak-0019-test`, 'utf8')).toBe(CONV);
    expect(existsSync(`${roomsPath(h)}.bak-0019-test`)).toBe(false);
    expect(readFileSync(`${idPath(h)}.bak-0019-test`, 'utf8')).toBe(IDENTITY);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('the persona and codex are untouched, and the surviving per-chat record keeps its thread', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    const cfg = YAML.parse(readFileSync(cfgPath(h), 'utf8'));
    expect(Object.keys(cfg.agents)).toEqual(['don', 'codex']);
    expect(cfg.agents.don.handles).toEqual(['d', 'don']);
    const conv = YAML.parse(readFileSync(convPath(h), 'utf8'));
    expect(conv.contacts.whatsapp['120363000000000002@g.us'].agents).toEqual({ don: { threadId: 'aaaa-1111', threadCreatedAt: '2026-09-18T10:00:00.000Z' } });
  });

  it('every per-chat record goes, in every registry, however deep - and each is listed with its threadId', async () => {
    // room/taller records ONLY this being: the empty `agents:` goes with it, because the splice
    // layer will not leave a map holding null.
    const many = crlf([
      'rooms:',
      '  room/lobby:',
      '    agents:',
      '      egpt:',
      '        threadId: cccc-3333',
      '      rodz:',
      '        threadId: dddd-4444',
      '  room/taller:',
      '    mode: mention',
      '    agents:',
      '      rodz:',
      '        threadId: eeee-5555',
    ]);
    const h = home({ rooms: many });
    const p = await plan(ctxFor(h));
    // rooms.yaml before conversations.yaml: the order the migration reads the two registries in.
    expect(p.changes.filter((c) => c.includes(' - threadId '))).toEqual([
      `${roomsPath(h)}:6-7  remove rooms.room/lobby.agents.rodz - threadId "dddd-4444" (2 lines):`,
      `${roomsPath(h)}:8-10  remove rooms.room/taller.agents.rodz and the \`agents:\` it was alone in - threadId "eeee-5555" (3 lines):`,
      `${convPath(h)}:9-12  remove contacts.whatsapp.120363000000000002@g.us.agents.rodz - threadId "bbbb-2222" (4 lines):`,
    ]);
    await p.apply();
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(crlf([
      'rooms:', '  room/lobby:', '    agents:', '      egpt:', '        threadId: cccc-3333', '  room/taller:', '    mode: mention',
    ]));
    const out = YAML.parse(readFileSync(roomsPath(h), 'utf8'));
    expect(out.rooms['room/lobby'].agents).toEqual({ egpt: { threadId: 'cccc-3333' } });
    expect(out.rooms['room/taller']).toEqual({ mode: 'mention' });
  });
});

describe('0019 is satisfied, or finishes, where there is less to do', () => {
  it('kg: nothing answers to `dron` and there is no dron.md - satisfied with a note, nothing written', async () => {
    const h = home({ config: KG, conversations: null, identity: null });
    const p = await plan(ctxFor(h));
    expect(p).toEqual({ satisfied: true, notes: [`no being in ${cfgPath(h)} answers to \`dron\`, and there is no ${idPath(h)} - nothing to evict here`] });
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
    expect(baks(h)).toEqual([]);
  });

  it('already applied: satisfied', async () => {
    const h = home({ config: DO_WITHOUT, conversations: CONV_WITHOUT, identity: null });
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
  });

  it('half-way - the block is gone and only the identity file is left - deletes the file alone', async () => {
    const h = home({ config: DO_WITHOUT, conversations: CONV_WITHOUT });
    const p = await plan(ctxFor(h));
    expect(p.changes).toEqual([
      `delete ${idPath(h)} (${Buffer.byteLength(IDENTITY)} bytes) - the identity it wore, declared by no other being here`,
      'backup first, beside each: <file>.bak-0019-<timestamp>',
    ]);
    await p.apply();
    expect(existsSync(idPath(h))).toBe(false);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO_WITHOUT);
  });

  it('an identity ANOTHER being still declares is left alone, with a note - two beings can wear one', async () => {
    const shared = DO_WITHOUT.replace('    configuration: codex', '    personality: dron\r\n    configuration: codex');
    const h = home({ config: shared, conversations: CONV_WITHOUT });
    const p = await plan(ctxFor(h));
    expect(p).toEqual({ satisfied: true, notes: [`no being in ${cfgPath(h)} answers to \`dron\`, and ${idPath(h)} is still worn by agents.codex (\`personality: dron\`) and is left alone - nothing to evict here`] });
    expect(existsSync(idPath(h))).toBe(true);
  });

  it('a node with no `agents:` mapping, and one whose registries do not exist', async () => {
    const bare = home({ config: 'node_name: zz\n', conversations: null, rooms: null, identity: null });
    expect((await plan(ctxFor(bare))).satisfied).toBe(true);
    const noRegistries = home({ conversations: null, rooms: null });
    const p = await plan(ctxFor(noRegistries));
    expect(p.changes.some((c) => c.includes('threadId'))).toBe(false);
    await p.apply();
    expect(readFileSync(cfgPath(noRegistries), 'utf8')).toBe(DO_WITHOUT);
  });

  it('the map KEY is `dron` but its handles say otherwise - the key is not the wake vocabulary', async () => {
    const keyed = KG.replace('  egpt:', '  dron:');   // handles: [ e, egpt, ekg ] - a list that does not include `dron`
    const h = home({ config: keyed, conversations: null, identity: null });
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(keyed);
  });

  it('...and a being with NO handles falls back to its key, which is how a `dron:` key still goes', async () => {
    const keyed = DO.replace('  rodz:', '  dron:').replace('    handles: [ dron ]\r\n', '');
    const h = home({ config: keyed, conversations: CONV_WITHOUT });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes[0]).toContain('remove agents.dron - the being that answers to `dron`');
  });
});

describe('0019 refuses, naming the place, only on what it cannot honestly edit', () => {
  it('two beings answer to `dron`', async () => {
    const two = DO.replace('    handles: [ codex ]', '    handles: [ codex, dron ]');
    const h = home({ config: two });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0019 refuses: 2 beings in .* answer to `dron` \(rodz, codex\) - which one goes is a human decision, not a guess/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(two);
    expect(existsSync(idPath(h))).toBe(true);
  });

  it('a chat entry holding NOTHING but this being - whether the whole entry goes is a human decision', async () => {
    const only = crlf(['rooms:', '  room/taller:', '    agents:', '      rodz:', '        threadId: eeee-5555']);
    const h = home({ rooms: only });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/rooms\.room\/taller\.agents\.rodz cannot be spliced out[\s\S]*it is the only being recorded there[\s\S]*whether that whole entry goes is a human decision/);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(only);
  });

  it('a config.yaml that does not parse, and one that is not there', async () => {
    const broken = home({ config: 'agents: [ broken\n' });
    await expect(plan(ctxFor(broken))).rejects.toThrow(/0019 refuses: [\s\S]*config\.yaml does not parse/);
    const none = home({ config: null });
    await expect(plan(ctxFor(none))).rejects.toThrow(/0019 refuses: there is no .*config\.yaml/);
  });

  it('a registry it must read that does not parse is refused, not skipped', async () => {
    const h = home({ rooms: 'rooms: [ broken\n' });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0019 refuses: [\s\S]*rooms\.yaml does not parse [\s\S]*so whether it holds a record for agents\.rodz cannot be read/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
  });

  it('a file edited between plan and apply, and nothing is written', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = CONV.replace('aaaa-1111', 'aaaa-9999');
    writeFileSync(convPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0019 refuses: .*conversations\.yaml changed since it was planned - re-run/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
    expect(readFileSync(convPath(h), 'utf8')).toBe(edited);
    expect(existsSync(idPath(h))).toBe(true);
    expect(baks(h)).toEqual([]);
  });

  it('an identity file edited between plan and apply', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    writeFileSync(idPath(h), `${IDENTITY}one more line\r\n`);
    await expect(p.apply()).rejects.toThrow(/0019 refuses: .*dron\.md changed since it was planned - re-run/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
  });
});

describe('0019 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is empty
  // so 0007 reads nothing as this node's own (as tests/migrations-0008-*).
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');
  const ledgerOf = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));

  it('do: applied and recorded; the block, the record and the identity are gone, each backed up', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ through: '0019', dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)['0019-dron-is-gone'].outcome).toBe('applied');
    const out = readFileSync(cfgPath(h), 'utf8');
    expect(out).not.toContain('Dron');
    expect(out).not.toContain('  rodz:');
    expect(out).toContain('  # codex, which is not going anywhere');
    expect(readFileSync(convPath(h), 'utf8')).toBe(CONV_WITHOUT);
    expect(existsSync(idPath(h))).toBe(false);
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('config.yaml.bak-0019-'))).toHaveLength(1);
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('conversations.yaml.bak-0019-'))).toHaveLength(1);
    expect(readdirSync(join(h, 'config', 'agents', 'identities')).filter((f) => f.startsWith('dron.md.bak-0019-'))).toHaveLength(1);
  });

  it('kg: recorded as already satisfied, nothing touched, no backup of anything 0019 owns', async () => {
    const h = home({ config: KG, conversations: null, identity: null });
    const { exitCode } = await runMigrations({ through: '0019', dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)['0019-dron-is-gone'].outcome).toBe('already-satisfied');
    expect(readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-0019-'))).toEqual([]);
  });

  it('EVERY earlier migration reads satisfied on both fixtures - one that acted would invalidate these', async () => {
    for (const h of [home(), home({ config: KG, conversations: null, identity: null })]) {
      await runMigrations({ through: '0019', dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
      const earlier = Object.entries(ledgerOf(h)).filter(([id]) => id < '0019');
      expect(earlier.length).toBeGreaterThanOrEqual(17);
      expect(earlier.filter(([, e]) => e.outcome !== 'already-satisfied')).toEqual([]);
    }
  });
});
