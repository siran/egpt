// tests/migrations-0020-the-mouth-is-not-a-being.test.mjs — migrations/0020-the-mouth-is-not-a-being.mjs.
//
// ONE ruling, a DIFFERENT half on each node, and the fixtures are miniatures of each node's REAL
// state as measured by the operator on 2026-09-20:
//   kg  a BEING named after the mouth - `agents.rodz`, name "Rodz", `personality: rodz`,
//       `handles: [ rodz, r ]`, `access_level: sandbox` - with FOUR per-chat records in
//       config/conversations.yaml, none in rooms.yaml, and config/agents/identities/rodz.md. kg
//       has no being answering to `don`, so its other half is a note.
//   do  the worker, `handles: [ d, don ]`, and (after 0019) nothing answering to `rodz`. Its half
//       is the handle; the removal is the note.
//
// The assertions are on the FULL text, never a re-parse: what survives the removal, and the
// trailing comment beside the handles list, are exactly what this layer exists to protect. CRLF
// throughout, as the live configs are.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0020-the-mouth-is-not-a-being.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

// ── kg ───────────────────────────────────────────────────────────────────────────────────────
const KG_BEFORE = [
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
];
const RODZ = [
  '  # RODZ (operator) - a persona named after the mouth. `beeper.secondary` is the ACCOUNT',
  '  # dolly.egpt@gmail.com, display name Rodz, and BOTH nodes speak through it.',
  '  rodz:',
  '    configuration: sonnet-high # config/agents/sonnet-high.yaml',
  '    personality: rodz # config/agents/identities/rodz.md',
  '    handles: [ rodz, r ]',
  '    name: "Rodz"',
  '    body_emoji: "🗣"',
  '    mode: mention',
  '    conversation_defaults:',
  '      access_level: sandbox',
];
const KG_AFTER = [
  '  # codex, which is not going anywhere',
  '  codex:',
  '    configuration: codex',
  '    handles: [ codex ]',
  'heartbeats:',
  '  alive: true',
];
const KG = crlf([...KG_BEFORE, ...RODZ, ...KG_AFTER]);
const KG_WITHOUT = crlf([...KG_BEFORE, ...KG_AFTER]);

// kg's FOUR per-chat records, each beside the persona's in the same chat. Seven lines a chat, the
// last two being the record this removes.
const CHATS = [['0001', 'Reencuentro CRC'], ['0002', 'Casa'], ['0003', 'Taller'], ['0004', 'Vecinos']];
const chatLines = (n, label, withRodz) => [
  `    "12036300000000${n}@g.us": # ${label}`,
  `      conversation_path: .egpt/conversations/whatsapp/${label}`,
  '      agents:',
  '        egpt:',
  `          threadId: ${n}-egpt`,
  ...(withRodz ? ['        rodz:', `          threadId: ${n}-rodz`] : []),
];
const CONV = crlf(['contacts:', '  whatsapp:', ...CHATS.flatMap(([n, l]) => chatLines(n, l, true))]);
const CONV_WITHOUT = crlf(['contacts:', '  whatsapp:', ...CHATS.flatMap(([n, l]) => chatLines(n, l, false))]);
// Nothing for it in rooms.yaml (measured) - the file is read and left byte-identical.
const ROOMS = crlf(['rooms:', '  room/lobby:', '    agents:', '      egpt:', '        threadId: cccc-3333']);

const IDENTITY = `# I am Rodz\r\n\r\n${'I am the voice the operator hears on the shared account. '.repeat(21)}\r\n`;

// ── do: post-0019. Nothing answers to `rodz`; the worker answers to `d`/`don`. ────────────────
const DO_LINES = [
  '# config.yaml - do (fixture)',
  'node_name: do',
  'agents:',
  '  egpt:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ d, don ] # the worker, addressed either way',
  '    default: true',
  '    name: "D"',
  '    conversation_defaults:',
  '      access_level: regular',
  '      allowed_users: [ "1555@s.whatsapp.net", "1666@s.whatsapp.net" ]',
  '  codex:',
  '    configuration: codex',
  '    handles: [ codex ]',
];
const DO = crlf(DO_LINES);
const HANDLES_LINE = DO_LINES.indexOf('    handles: [ d, don ] # the worker, addressed either way') + 1;
const DO_AFTER = DO.replace('[ d, don ]', '[ d, don, rodz ]');

const TYPES = { 'sonnet-default': 'type: ccode\nmodel: sonnet\neffort: high\n', 'sonnet-high': 'type: ccode\nmodel: sonnet\neffort: high\n' };

function home({ config = KG, conversations = CONV, rooms = ROOMS, identity = IDENTITY } = {}) {
  // `.egpt` nested inside the temp dir, so `<parent>/src` does not exist and 0015 stays satisfied.
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0020-')), '.egpt');
  mkdirSync(join(h, 'config', 'agents', 'identities'), { recursive: true });
  // `null` means "this node does not have that file" - `undefined` would take the default above.
  if (config !== null) writeFileSync(join(h, 'config', 'config.yaml'), config);
  if (conversations !== null) writeFileSync(join(h, 'config', 'conversations.yaml'), conversations);
  if (rooms !== null) writeFileSync(join(h, 'config', 'rooms.yaml'), rooms);
  if (identity !== null) writeFileSync(idPath(h), identity);
  for (const [name, text] of Object.entries(TYPES)) writeFileSync(join(h, 'config', 'agents', `${name}.yaml`), text);
  return h;
}
const doHome = () => home({ config: DO, conversations: null, identity: null });
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const convPath = (h) => join(h, 'config', 'conversations.yaml');
const roomsPath = (h) => join(h, 'config', 'rooms.yaml');
const idPath = (h) => join(h, 'config', 'agents', 'identities', 'rodz.md');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0020-test`; writeFileSync(to, readFileSync(f)); return to; } });
const baks = (h) => readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'));

const FIRST = KG_BEFORE.length + 1;
// Each splice is applied to the result of the one before it, so the records after the first are
// reported at the line they sit at THEN: 8-9, then 13-14, 18-19, 23-24 rather than 15-16, 22-23, 29-30.
const RECORD_AT = [8, 13, 18, 23];

describe('0020 on kg - the being named after the mouth goes, threads and all', () => {
  it('plans the block and its comment, ALL FOUR per-chat records with their threadIds, and the identity file', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${FIRST}-${FIRST + RODZ.length - 1}  remove agents.rodz - the being that answers to \`rodz\` and the comment above it (${RODZ.length} lines):`,
      ...RODZ.map((l) => `  - ${l}`),
      ...CHATS.flatMap(([n], i) => [
        `${convPath(h)}:${RECORD_AT[i]}-${RECORD_AT[i] + 1}  remove contacts.whatsapp.12036300000000${n}@g.us.agents.rodz - threadId "${n}-rodz" (2 lines):`,
        '  -         rodz:',
        `  -           threadId: ${n}-rodz`,
      ]),
      `delete ${idPath(h)} (${Buffer.byteLength(IDENTITY)} bytes) - the identity it wore, declared by no other being here`,
      `(the other half is already settled here: no being in ${cfgPath(h)} answers to \`don\`, so there is nothing here to hand \`@rodz\` to)`,
      'backup first, beside each: <file>.bak-0020-<timestamp>',
    ]);
  });

  it('apply: config.yaml and conversations.yaml byte-identical except the removed lines, the identity gone', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_WITHOUT);
    // The blank line above the removed comment and codex's own comment both survive.
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('"1555@s.whatsapp.net" ]\r\n\r\n  # codex, which is not going anywhere\r\n');
    expect(readFileSync(convPath(h), 'utf8')).toBe(CONV_WITHOUT);
    expect(readFileSync(roomsPath(h), 'utf8')).toBe(ROOMS);          // read, never rewritten
    expect(existsSync(idPath(h))).toBe(false);
    expect(readFileSync(`${cfgPath(h)}.bak-0020-test`, 'utf8')).toBe(KG);
    expect(readFileSync(`${convPath(h)}.bak-0020-test`, 'utf8')).toBe(CONV);
    expect(readFileSync(`${idPath(h)}.bak-0020-test`, 'utf8')).toBe(IDENTITY);
    const cfg = YAML.parse(readFileSync(cfgPath(h), 'utf8'));
    expect(Object.keys(cfg.agents)).toEqual(['egpt', 'codex']);
    expect(cfg.agents.egpt.handles).toEqual(['e', 'egpt', 'ekg']);   // `r` and `rodz` reach nobody on kg now
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });
});

describe('0020 on do - the worker answers to `@rodz` too', () => {
  it('plans exactly one changed line, and says why', async () => {
    const h = doHome();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${HANDLES_LINE}`,
      '  -     handles: [ d, don ] # the worker, addressed either way',
      '  +     handles: [ d, don, rodz ] # the worker, addressed either way',
      'agents.egpt answers to `@rodz` from here on - `@rodz` is the account both nodes speak through, and a mention of it now reaches this node\'s worker',
      `(the other half is already settled here: no being in ${cfgPath(h)} answers to \`rodz\`, and there is no ${idPath(h)} - nothing to evict here)`,
      'backup first, beside each: <file>.bak-0020-<timestamp>',
    ]);
  });

  it('apply: `rodz` is added and `d`/`don` are kept, the trailing comment and every other byte untouched', async () => {
    const h = doHome();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO_AFTER);
    expect(YAML.parse(readFileSync(cfgPath(h), 'utf8')).agents.egpt.handles).toEqual(['d', 'don', 'rodz']);
    expect(readFileSync(`${cfgPath(h)}.bak-0020-test`, 'utf8')).toBe(DO);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('only `rodz`, never `r` - a one-letter handle is too easy to trigger by accident', async () => {
    const h = doHome();
    await (await plan(ctxFor(h))).apply();
    expect(YAML.parse(readFileSync(cfgPath(h), 'utf8')).agents.egpt.handles).not.toContain('r');
  });

  it('the worker is found by HANDLE: a being KEYED `don` whose handles say otherwise is not it', async () => {
    const keyed = DO.replace('  codex:', '  don:').replace('    handles: [ codex ]', '    handles: [ codex ]');
    const h = home({ config: keyed, conversations: null, identity: null });
    const p = await plan(ctxFor(h));
    // `egpt` still answers to `don` through its own list, and THAT is the being extended.
    expect(p.changes[0]).toBe(`${cfgPath(h)}:${HANDLES_LINE}`);
    expect(p.changes[2]).toContain('[ d, don, rodz ]');
  });
});

describe('0020: each half is independently satisfiable, and the node that has neither is satisfied', () => {
  it('a node with the `rodz` being and no `don`: it does the removal alone', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.changes.some((c) => c.startsWith('  + '))).toBe(false);   // nothing is ADDED here
    expect(p.changes.at(-2)).toContain('no being in');
    expect(p.changes.at(-2)).toContain('answers to `don`');
  });

  it('a node with `don` and no `rodz` being: it does the handle alone', async () => {
    const h = doHome();
    const p = await plan(ctxFor(h));
    expect(p.changes.some((c) => c.startsWith('delete '))).toBe(false);
    expect(p.changes.filter((c) => c.includes('remove agents.'))).toEqual([]);
  });

  it('a node with BOTH: one write, both edits, and the re-plan is satisfied', async () => {
    const both = crlf([...KG_BEFORE.slice(0, 5), '    handles: [ e, don ]', ...KG_BEFORE.slice(6), ...RODZ, ...KG_AFTER]);
    const h = home({ config: both });
    const p = await plan(ctxFor(h));
    expect(p.changes.some((c) => c.includes('remove agents.rodz'))).toBe(true);
    expect(p.changes.some((c) => c === '  +     handles: [ e, don, rodz ]')).toBe(true);
    await p.apply();
    const out = readFileSync(cfgPath(h), 'utf8');
    expect(out).toBe(crlf([...KG_BEFORE.slice(0, 5), '    handles: [ e, don, rodz ]', ...KG_BEFORE.slice(6), ...KG_AFTER]));
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('config.yaml.bak-'))).toHaveLength(1);
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
  });

  it('already applied on do: satisfied with both notes', async () => {
    const h = home({ config: DO_AFTER, conversations: null, identity: null });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `nothing in ${cfgPath(h)} answers to \`rodz\` but agents.egpt, which is the being that answers to \`don\` and keeps it, and there is no ${idPath(h)} - nothing to evict here`,
      'agents.egpt already answers to `rodz`',
    ]);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO_AFTER);
    expect(baks(h)).toEqual([]);
  });

  it('already applied on kg: satisfied, and nothing is written', async () => {
    const h = home({ config: KG_WITHOUT, conversations: CONV_WITHOUT, identity: null });
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
    expect(baks(h)).toEqual([]);
  });

  it('a node with neither, and one with no `agents:` mapping at all', async () => {
    const neither = home({ config: crlf([...KG_BEFORE, ...KG_AFTER]), conversations: CONV_WITHOUT, identity: null });
    expect((await plan(ctxFor(neither))).satisfied).toBe(true);
    const bare = home({ config: 'node_name: zz\n', conversations: null, rooms: null, identity: null });
    expect((await plan(ctxFor(bare))).satisfied).toBe(true);
  });

  // THE REGRESSION LOCK. Half two makes the `don` being answer to `rodz`; without the exclusion,
  // the very next plan() reads the node's PERSONA as the being to evict and deletes it.
  it('the being that answers to `don` is NEVER the being removed, even once it answers to `rodz`', async () => {
    const h = doHome();
    await (await plan(ctxFor(h))).apply();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`nothing in ${cfgPath(h)} answers to \`rodz\` but agents.egpt, which is the being that answers to \`don\` and keeps it, and there is no ${idPath(h)} - nothing to evict here`);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO_AFTER);
  });
});

describe('0020 refuses, naming the place, only on what it cannot honestly edit', () => {
  it('two beings answer to `rodz` - the `don` being aside', async () => {
    const two = KG.replace('    handles: [ codex ]', '    handles: [ codex, rodz ]');
    const h = home({ config: two });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0020 refuses: 2 beings in .* answer to `rodz` \(rodz, codex\) - which one goes is a human decision, not a guess/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(two);
    expect(existsSync(idPath(h))).toBe(true);
  });

  it('two beings answer to `don`', async () => {
    const two = DO.replace('    handles: [ codex ]', '    handles: [ codex, don ]');
    const h = home({ config: two, conversations: null, identity: null });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0020 refuses: 2 beings in .* answer to `don` \(egpt, codex\) - which one takes `@rodz` is a human decision, not a guess/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(two);
  });

  it('the `don` being has NO `handles:` list - it answers by its map key, and there is no list to append to', async () => {
    const keyed = DO.replace('  egpt:', '  don:').replace('    handles: [ d, don ] # the worker, addressed either way\r\n', '');
    const h = home({ config: keyed, conversations: null, identity: null });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0020 refuses: agents\.don \(the being that answers to `don`\) has no `handles:` list in .* - `handles` is null, so it answers by its map key alone/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(keyed);
  });

  it('a `handles:` that is not a list at all', async () => {
    const scalar = DO.replace('  egpt:', '  don:').replace('    handles: [ d, don ] # the worker, addressed either way', '    handles: don');
    const h = home({ config: scalar, conversations: null, identity: null });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0020 refuses: agents\.don .* `handles` is "don"/);
  });

  it('a `handles:` written as a BLOCK list - a shape this splice does not write', async () => {
    const block = DO.replace('    handles: [ d, don ] # the worker, addressed either way', '    handles:\r\n      - d\r\n      - don');
    const h = home({ config: block, conversations: null, identity: null });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0020 refuses: `handles:` in agents\.egpt cannot take `rodz` \(refusing to edit agents\.egpt\.handles: it is a block list; only an inline flow list is appended to\)/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(block);
  });

  it('a config.yaml that does not parse, and one that is not there', async () => {
    const broken = home({ config: 'agents: [ broken\n' });
    await expect(plan(ctxFor(broken))).rejects.toThrow(/0020 refuses: [\s\S]*config\.yaml does not parse/);
    const none = home({ config: null });
    await expect(plan(ctxFor(none))).rejects.toThrow(/0020 refuses: there is no .*config\.yaml/);
  });

  it('a registry it must read that does not parse is refused, not skipped', async () => {
    const h = home({ rooms: 'rooms: [ broken\n' });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0020 refuses: [\s\S]*rooms\.yaml does not parse [\s\S]*so whether it holds a record for agents\.rodz cannot be read/);
  });

  it('a file edited between plan and apply, and nothing is written', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = KG.replace('node_name: kg', 'node_name: kg2');
    writeFileSync(cfgPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0020 refuses: .*config\.yaml changed since it was planned - re-run/);
    expect(readFileSync(convPath(h), 'utf8')).toBe(CONV);
    expect(existsSync(idPath(h))).toBe(true);
    expect(baks(h)).toEqual([]);
  });
});

describe('0020 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is empty
  // so 0007 reads nothing as this node's own (as tests/migrations-0008-*).
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');
  const ledgerOf = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));

  it('kg: applied and recorded; the being, its four records and its identity are gone', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)['0020-the-mouth-is-not-a-being'].outcome).toBe('applied');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_WITHOUT);
    expect(readFileSync(convPath(h), 'utf8')).toBe(CONV_WITHOUT);
    expect(existsSync(idPath(h))).toBe(false);
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('config.yaml.bak-0020-'))).toHaveLength(1);
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('conversations.yaml.bak-0020-'))).toHaveLength(1);
  });

  it('do: applied and recorded; the one line changed and nothing else', async () => {
    const h = doHome();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)['0020-the-mouth-is-not-a-being'].outcome).toBe('applied');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO_AFTER);
  });

  it('EVERY earlier migration reads satisfied on both fixtures - one that acted would invalidate these', async () => {
    for (const h of [home(), doHome()]) {
      await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
      const earlier = Object.entries(ledgerOf(h)).filter(([id]) => id < '0020');
      expect(earlier.length).toBeGreaterThanOrEqual(18);
      expect(earlier.filter(([, e]) => e.outcome !== 'already-satisfied')).toEqual([]);
    }
  });
});
