// tests/migrations-0016-dron-is-a-meta-engineer.test.mjs — migrations/0016-dron-is-a-meta-engineer.mjs.
//
// do's fixture carries the trap this migration is written around: the being the operator calls
// `dron` is keyed `rodz`. Every assertion here is about finding it by HANDLE — the key is never
// `dron`, so a migration that looked at the key would read satisfied on the one node it is for.
//
// The assertions are on the FULL text, never a re-parse: a comment is not part of the parse, and
// the inserted block's comment is what tells the next reader why the level and the list are one
// change. CRLF throughout, as the live configs are. kg has no such being and is the same one rule
// reading satisfied, not a second branch.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0016-dron-is-a-meta-engineer.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

// do: the persona answers to d/don and carries the node's trusted ids; the being the operator
// calls dron is agents.RODZ, and only its `handles:` says so.
const DO_LINES = [
  '# config.yaml - do (fixture)',
  'node_name: do',
  'agents:',
  '  egpt:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ d, don ]',
  '    default: true',
  '    name: "D"',
  '    conversation_defaults:',
  '      access_level: regular',
  '      allowed_users: [ "1555@s.whatsapp.net", "1666@s.whatsapp.net" ]',
  '',
  '  # the being the operator calls dron - keyed rodz, which is exactly the trap.',
  '  rodz:',
  '    configuration: sonnet-high # config/agents/sonnet-high.yaml',
  '    personality: dron # config/agents/identities/dron.md',
  '    handles: [ dron ]',
  '    name: "Dron"',
  '    conversation_defaults:',
  '      access_level: regular',
  '      sandboxed: false',
];
const DO = crlf(DO_LINES);
// The list as YAML renders it back (0011's own rendering): a plain scalar keeps no quotes it does
// not need. The IDS are the node's, byte for byte; only the quoting is the serializer's.
const USERS = '[ 1555@s.whatsapp.net, 1666@s.whatsapp.net ]';
// The SECOND `access_level: regular` - rodz's, not the persona's.
const LEVEL_LINE_NO = DO_LINES.lastIndexOf('      access_level: regular') + 1;

// kg: nothing answers to `dron`.
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
]);

const INSERTED = [
  '      # A meta engineer is gated by name (0016): brainpool.mjs\'s structural gate REFUSES a turn',
  '      # for an `access_level: all` being with no allowed_users at either tier, so the level',
  '      # without the list would silence this being instead of promoting it. Copied from this',
  '      # node\'s own trusted ids, never invented here.',
  `      allowed_users: ${USERS}`,
];

// do's config.yaml after both edits: the one line changed, the block inserted after it, and
// `sandboxed: false` still below - an `all` being runs unsandboxed, as wren does.
const DO_AFTER = crlf(DO_LINES.flatMap((l, i) => (
  i === LEVEL_LINE_NO - 1 ? ['      access_level: all', ...INSERTED] : [l]
)));

const TYPES = {
  'sonnet-default': 'type: ccode\nmodel: sonnet\neffort: high\n',
  'sonnet-high': 'type: ccode\nmodel: sonnet\neffort: high\n',
};

function home({ config = DO, types = TYPES } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0016-')), '.egpt');
  mkdirSync(join(h, 'config', 'agents', 'identities'), { recursive: true });
  writeFileSync(join(h, 'config', 'config.yaml'), config);
  for (const [name, text] of Object.entries(types)) writeFileSync(join(h, 'config', 'agents', `${name}.yaml`), text);
  writeFileSync(join(h, 'config', 'agents', 'identities', 'dron.md'), '# I am dron\n');
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0016-test`; writeFileSync(to, readFileSync(f)); return to; } });
const baks = (h) => readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'));

describe('0016 on do - the being keyed `rodz` is the one that answers to `dron`', () => {
  it('plans the one changed line and the inserted list, naming where the ids came from', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${LEVEL_LINE_NO}`,
      '  -       access_level: regular',
      '  +       access_level: all',
      `${cfgPath(h)}:${LEVEL_LINE_NO + 1}-${LEVEL_LINE_NO + 5}  insert agents.rodz.conversation_defaults.allowed_users, copied from agents.egpt.conversation_defaults.allowed_users (5 lines):`,
      ...INSERTED.map((l) => `  + ${l}`),
      'agents.rodz answers to `dron` and becomes this node\'s meta engineer - unsandboxed, running as the operator',
      'backup first, beside it: <file>.bak-0016-<timestamp>',
    ]);
  });

  it('apply: byte-identical apart from that one line and the inserted block - the PERSONA\'s access_level is untouched', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const out = readFileSync(cfgPath(h), 'utf8');
    expect(out).toBe(DO_AFTER);
    // The persona's own `access_level: regular` is still there - the FIRST one in the file, which
    // is what a path-less text edit would have hit.
    expect(out.split('\r\n').filter((l) => l.trim() === 'access_level: regular')).toHaveLength(1);
    const cfg = YAML.parse(out);
    expect(cfg.agents.rodz.conversation_defaults).toEqual({
      access_level: 'all',
      allowed_users: ['1555@s.whatsapp.net', '1666@s.whatsapp.net'],
      sandboxed: false,   // stays: an `all` being runs unsandboxed
    });
    expect(cfg.agents.egpt.conversation_defaults.access_level).toBe('regular');
    expect(readFileSync(`${cfgPath(h)}.bak-0016-test`, 'utf8')).toBe(DO);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('the ids come from another `all` being before the persona, when the node has one', async () => {
    const withWren = crlf([...DO_LINES, '', '  wren:', '    configuration: wren', '    conversation_defaults:', '      access_level: all', '      allowed_users: [ "*" ]']);
    const h = home({ config: withWren });
    const p = await plan(ctxFor(h));
    expect(p.changes[3]).toContain('copied from agents.wren.conversation_defaults.allowed_users');
    await p.apply();
    expect(YAML.parse(readFileSync(cfgPath(h), 'utf8')).agents.rodz.conversation_defaults.allowed_users).toEqual(['*']);
  });

  it('a trailing comment on the access_level line is rewritten, not left lying', async () => {
    const documented = DO.replace('      access_level: regular\r\n      sandboxed: false', '      access_level: regular # like everyone else here\r\n      sandboxed: false');
    const h = home({ config: documented });
    await (await plan(ctxFor(h))).apply();
    const out = readFileSync(cfgPath(h), 'utf8');
    expect(out).toContain('      access_level: all # a meta engineer runs as the operator because its job is to change the machine (0016, operator 2026-09-20: "dron is a meta engineer in DO")');
    expect(out).not.toContain('like everyone else here');
  });

  it('a being ALREADY `all` but with no allowed_users gets only the list - the gate that would silence it', async () => {
    const h = home({ config: DO.replace('      access_level: regular\r\n      sandboxed: false', '      access_level: all\r\n      sandboxed: false') });
    const p = await plan(ctxFor(h));
    expect(p.changes[0]).toContain('insert agents.rodz.conversation_defaults.allowed_users');
    await p.apply();
    const cfg = YAML.parse(readFileSync(cfgPath(h), 'utf8'));
    expect(cfg.agents.rodz.conversation_defaults.access_level).toBe('all');
    expect(cfg.agents.rodz.conversation_defaults.allowed_users).toEqual(['1555@s.whatsapp.net', '1666@s.whatsapp.net']);
  });

  it('a being that already has allowed_users keeps its OWN list - only the level moves', async () => {
    const h = home({ config: DO.replace('      sandboxed: false', '      allowed_users: [ "1777@s.whatsapp.net" ]\r\n      sandboxed: false') });
    const p = await plan(ctxFor(h));
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${LEVEL_LINE_NO}`,
      '  -       access_level: regular',
      '  +       access_level: all',
      'agents.rodz answers to `dron` and becomes this node\'s meta engineer - unsandboxed, running as the operator',
      'backup first, beside it: <file>.bak-0016-<timestamp>',
    ]);
    await p.apply();
    expect(YAML.parse(readFileSync(cfgPath(h), 'utf8')).agents.rodz.conversation_defaults.allowed_users).toEqual(['1777@s.whatsapp.net']);
  });
});

describe('0016 is satisfied where it has nothing to do', () => {
  it('kg: no being answers to `dron`', async () => {
    const h = home({ config: KG });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`no being in ${cfgPath(h)} answers to \`dron\`, so this node has no dron to promote`);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
  });

  it('the map KEY is `dron` but its handles say otherwise - the key is not the wake vocabulary', async () => {
    const keyed = KG.replace('  egpt:', '  dron:');   // handles: [ e, egpt, ekg ] - a complete list that does not include `dron`
    const h = home({ config: keyed });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toContain('answers to `dron`');
  });

  it('...and a being with NO handles at all falls back to its key, which is how a `dron:` key still answers', async () => {
    // Same fixture, the being keyed `dron` and declaring no handles: wakeTokens' map-key fallback
    // is THE definition, so it is found exactly as the `rodz`/`handles: [ dron ]` shape is.
    const keyed = DO.replace('  rodz:', '  dron:').replace('    handles: [ dron ]\r\n', '');
    const h = home({ config: keyed });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes[0]).toBe(`${cfgPath(h)}:${LEVEL_LINE_NO - 1}`);
    expect(p.changes.at(-2)).toContain('agents.dron answers to `dron`');
  });

  it('already a meta engineer, gated', async () => {
    const h = home({ config: DO.replace('      access_level: regular\r\n      sandboxed: false', '      access_level: all\r\n      allowed_users: [ "*" ]\r\n      sandboxed: false') });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe('agents.rodz already runs `access_level: all` gated by 1 allowed_users - it is already this node\'s meta engineer');
  });

  it('the node lists no trusted ids anywhere - not promoted ungated', async () => {
    const h = home({ config: DO.replace('      allowed_users: [ "1555@s.whatsapp.net", "1666@s.whatsapp.net" ]\r\n', '') });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe('this node lists no trusted ids (agents.egpt.conversation_defaults.allowed_users), and agents.rodz is not promoted ungated - brainpool.mjs refuses a turn for an `all` being with no allowed_users, so the level alone would silence it');
    expect(readFileSync(cfgPath(h), 'utf8')).not.toContain('access_level: all');
  });

  it('a node with no `agents:` mapping at all', async () => {
    const h = home({ config: 'node_name: zz\n' });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`${cfgPath(h)} has no \`agents:\` mapping, so nothing here answers to \`dron\``);
  });
});

describe('0016 refuses, naming the place', () => {
  it('two beings answer to `dron`', async () => {
    const two = crlf([...DO_LINES, '', '  other:', '    handles: [ dron, dr ]', '    conversation_defaults:', '      access_level: regular']);
    const h = home({ config: two });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0016 refuses: 2 beings in .* answer to `dron` \(rodz, other\) - which one is the meta engineer is a human decision, not a guess/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(two);
  });

  it('the being has no `conversation_defaults:` mapping', async () => {
    const h = home({ config: DO.replace('    conversation_defaults:\r\n      access_level: regular\r\n      sandboxed: false\r\n', '') });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0016 refuses: agents\.rodz \(the being that answers to `dron`\) has no `conversation_defaults:` mapping/);
  });

  it('`conversation_defaults:` has no `access_level:` key', async () => {
    const h = home({ config: DO.replace('      access_level: regular\r\n      sandboxed: false', '      sandboxed: false') });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0016 refuses: agents\.rodz\.conversation_defaults in .* has no `access_level:` key/);
  });

  it('an allowed_users that is present but empty is a hand edit, not a gap to fill', async () => {
    const h = home({ config: DO.replace('      sandboxed: false', '      allowed_users: []\r\n      sandboxed: false') });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0016 refuses: `allowed_users` in agents\.rodz\.conversation_defaults is \[\]/);
  });

  it('a config.yaml that does not parse', async () => {
    const h = home({ config: 'agents: [ broken\n' });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0016 refuses: .* does not parse/);
  });

  it('the file changed between plan and apply', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = DO.replace('node_name: do', 'node_name: do2');
    writeFileSync(cfgPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0016 refuses: .*config\.yaml changed since it was planned - re-run/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(edited);
    expect(baks(h)).toEqual([]);
  });
});

describe('0016 through the runner', () => {
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');
  const ledger = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0016-dron-is-a-meta-engineer'].outcome;

  it('do: applied and recorded, both edits made, a backup beside config.yaml', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('applied');
    // Three later migrations act on this fixture. 0018 keys the persona by its handle (`don`);
    // `rodz` answers to `dron`, not one of 0018's three handles, so it keeps its key just long
    // enough for 0019 to REMOVE it entirely ("dron needs not to exist"); then 0020 hands the persona
    // the `rodz` handle. So at the end of the chain the promoted block is gone with its being, and
    // what remains of 0016 is the ledger entry and the backup 0019 took.
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(crlf(DO_LINES.slice(0, 12)).replace('  egpt:', '  don:').replace('[ d, don ]', '[ d, don, rodz ]'));
    // 0019's backup is the file as 0018 left it - which is 0016's two edits plus that one key
    // rename, and the only place either of 0016's edits is still observable after the chain.
    const bak0019 = readdirSync(join(h, 'config')).find((f) => f.startsWith('config.yaml.bak-0019-'));
    expect(readFileSync(join(h, 'config', bak0019), 'utf8')).toBe(DO_AFTER.replace('  egpt:', '  don:'));
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('config.yaml.bak-0016-'))).toHaveLength(1);
  });

  it('kg: recorded as already satisfied, nothing touched, no backup', async () => {
    const h = home({ config: KG });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('already-satisfied');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
    expect(existsSync(`${cfgPath(h)}.bak-0016-test`)).toBe(false);
    expect(baks(h)).toEqual([]);
  });
});
