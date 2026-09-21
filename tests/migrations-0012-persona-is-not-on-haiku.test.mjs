// tests/migrations-0012-persona-is-not-on-haiku.test.mjs — migrations/0012-persona-is-not-on-haiku.mjs.
//
// do's fixture is built from the live line, byte for byte (CRLF, the trailing comment that names
// the SHIPPED type file, the emoji): that line is the whole point of this migration, and what it
// becomes is asserted in full. kg's persona is on sonnet-default, whose model is sonnet, so kg is
// the same rule reading satisfied — not a second branch.
//
// The assertions are on the FULL text, never a re-parse: the data surviving is not the point, the
// bytes are. The comment is not part of the parse, so "byte-identical apart from that one line" is
// the only check that can see it.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../migrations/0012-persona-is-not-on-haiku.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

// do, through the persona's block. Line 5 (index 4) is the live line, exactly as it reads on dolly.
const DO_LINES = [
  '# config.yaml - do (fixture)',
  'node_name: do',
  'agents:',
  '  egpt:',
  '    configuration: haiku-low # config/agents/haiku-low.yaml (SHIPPED; haiku-default is reve-only)',
  '    personality: egpt # config/agents/identities/egpt.md',
  '    handles: [ d, don ] # what wakes D in a chat',
  '    default: true',
  '    name: "D"',
  '    body_emoji: 🤝',
  '    conversation_defaults:',
  '      access_level: regular',
  '      verbose_thinking: true # this tier outranks the brain def',
  '      sandboxed: false # no sandbox pool provisioned on dolly yet',
  '',
  '  # E on do is answered by kg and posted from this account.',
  '  e:',
  '    configuration: relay # config/agents/relay.yaml',
  '    relay_channel: ekg.kg',
];
const DO_LINE_NO = 5;
const AFTER_LINE = '    configuration: sonnet-high # config/agents/sonnet-high.yaml (0012, operator 2026-09-17: "as in KG, sonnet high")';
const DO = crlf(DO_LINES);
const DO_AFTER = crlf(DO_LINES.map((l, i) => (i === DO_LINE_NO - 1 ? AFTER_LINE : l)));

const KG_LINES = [
  '# config.yaml - kg (fixture)',
  'node_name: kg',
  'agents:',
  '  egpt:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    personality: egpt # config/agents/identities/egpt.md',
  '    handles: [ e, egpt, ekg, egptkg ]',
  '    default: true',
  '    name: "E"',
  '    conversation_defaults:',
  '      access_level: sandbox',
  '      verbose_thinking: true',
];
const KG = crlf(KG_LINES);

const TYPES = {
  'haiku-low': 'type: ccode\nmodel: haiku\neffort: low\n',
  'sonnet-high': 'type: ccode\nmodel: sonnet\neffort: high\n',
  'sonnet-default': 'type: ccode\nmodel: sonnet\neffort: high\n',
  relay: 'type: relay\n',
};

function home({ config = DO, types = TYPES } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'egpt-0012-'));
  mkdirSync(join(h, 'config', 'agents'), { recursive: true });
  writeFileSync(join(h, 'config', 'config.yaml'), config);
  for (const [name, text] of Object.entries(types)) writeFileSync(join(h, 'config', 'agents', `${name}.yaml`), text);
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const typePath = (h, name) => join(h, 'config', 'agents', `${name}.yaml`);
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0012-test`; writeFileSync(to, readFileSync(f)); return to; } });
const without = (...names) => Object.fromEntries(Object.entries(TYPES).filter(([n]) => !names.includes(n)));

describe('0012 on do - the persona\'s type file is model haiku', () => {
  it('plans exactly one changed line, and says what that line becomes - comment included', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${DO_LINE_NO}`,
      `  - ${DO_LINES[DO_LINE_NO - 1]}`,
      `  + ${AFTER_LINE}`,
      `haiku-low is ${typePath(h, 'haiku-low')} (model haiku); sonnet-high is ${typePath(h, 'sonnet-high')}`,
      'backup first, beside it: config.yaml.bak-0012-<timestamp>',
    ]);
  });

  it('apply: byte-identical apart from that one line - CRLF, the emoji and every other comment kept, and no comment left naming haiku-low', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const out = readFileSync(cfgPath(h), 'utf8');
    expect(out).toBe(DO_AFTER);
    const before = DO.split('\r\n');
    const after = out.split('\r\n');
    expect(after.flatMap((l, i) => (l === before[i] ? [] : [i + 1]))).toEqual([DO_LINE_NO]);
    expect(out).not.toContain('haiku-low');
    expect(readFileSync(`${cfgPath(h)}.bak-0012-test`, 'utf8')).toBe(DO);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('a persona line with NO trailing comment gets its value repointed and no comment invented', async () => {
    const bare = DO.replace(DO_LINES[DO_LINE_NO - 1], '    configuration: haiku-low');
    const h = home({ config: bare });
    const p = await plan(ctxFor(h));
    expect(p.changes.slice(1, 3)).toEqual(['  -     configuration: haiku-low', '  +     configuration: sonnet-high']);
    await p.apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(bare.replace('configuration: haiku-low', 'configuration: sonnet-high'));
  });

  it('refuses to write over a config.yaml edited between plan and apply, and touches nothing', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = DO.replace('relay_channel: ekg.kg', 'relay_channel: ekg.kg2');
    writeFileSync(cfgPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0012 refuses: .*config\.yaml changed since it was planned - re-run/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(edited);
    expect(readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'))).toEqual([]);
  });
});

describe('0012 is satisfied where it has nothing to do', () => {
  it('kg: the persona is on sonnet-default, whose model is sonnet - nothing touched', async () => {
    const h = home({ config: KG });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`agents.egpt.configuration is sonnet-default, and ${typePath(h, 'sonnet-default')} is model "sonnet" - this node's persona does not answer on haiku`);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
  });

  // A refusal STOPS THE WHOLE CHAIN, so a node this migration has no business on reads satisfied.
  it('a node with no persona at all: no `agents:` mapping, or no agent carrying `default: true`', async () => {
    const none = await plan(ctxFor(home({ config: 'node_name: zz\n' })));
    expect(none).toMatchObject({ satisfied: true });
    expect(none.notes[0]).toMatch(/has no `agents:` mapping, so this node has no persona/);
    const undefaulted = await plan(ctxFor(home({ config: DO.replace('    default: true\r\n', '') })));
    expect(undefaulted).toMatchObject({ satisfied: true });
    expect(undefaulted.notes[0]).toMatch(/carries `default: true`, so this node has no persona/);
  });

  // Checked BEFORE the refusals below: without the file to repoint TO this is not a node 0012 can
  // act on, and stopping its chain over that node's other state would be the 0003/0007 mistake.
  it('config/agents/sonnet-high.yaml is not in the profile: satisfied, and says so - even when the persona is broken', async () => {
    const h = home({ types: without('sonnet-high') });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`there is no ${typePath(h, 'sonnet-high')} on this node, so there is nothing for agents.egpt.configuration to be repointed to - left alone`);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
    const broken = await plan(ctxFor(home({ config: DO.replace(DO_LINES[DO_LINE_NO - 1], '    name_only: x'), types: without('sonnet-high') })));
    expect(broken).toMatchObject({ satisfied: true });
  });
});

describe('0012 refuses, naming the place', () => {
  it('more than one agent carries `default: true`', async () => {
    const two = DO.replace('    relay_channel: ekg.kg\r\n', '    default: true\r\n');
    await expect(plan(ctxFor(home({ config: two })))).rejects
      .toThrow(/0012 refuses: the default persona cannot be identified: 2 agents carry `default: true` \(egpt, e\)/);
  });

  it('changes an inline Haiku definition to Sonnet high without replacing its other fields', async () => {
    const inline = DO.replace(DO_LINES[DO_LINE_NO - 1], '    configuration: { type: ccode, model: haiku, effort: low }');
    const h = home({ config: inline });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(inline.replace('model: haiku, effort: low', 'model: sonnet, effort: high'));
    expect(await plan(ctxFor(h))).toMatchObject({ satisfied: true });
  });

  it('changes the shipped block-style inline definition without touching its personality', async () => {
    const inline = DO.replace(DO_LINES[DO_LINE_NO - 1], [
      '    configuration:',
      '      type: ccode',
      '      model: haiku',
      '      effort: low',
      '      personality: egpt',
    ].join('\r\n'));
    const h = home({ config: inline, types: without('sonnet-high') });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(inline.replace('model: haiku', 'model: sonnet').replace('effort: low', 'effort: high'));
    expect(await plan(ctxFor(h))).toMatchObject({ satisfied: true });
  });

  it('refuses a named target that is not Sonnet high before writing config.yaml', async () => {
    for (const target of ['model: haiku\neffort: high\n', 'model: sonnet\neffort: low\n']) {
      const h = home({ types: { ...TYPES, 'sonnet-high': target } });
      await expect(plan(ctxFor(h))).rejects.toThrow(/sonnet-high\.yaml must declare model: sonnet and effort: high/);
      expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
      expect(readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'))).toEqual([]);
    }
  });

  it('the persona has no `configuration` key at all', async () => {
    const gone = DO.replace(`${DO_LINES[DO_LINE_NO - 1]}\r\n`, '');
    await expect(plan(ctxFor(home({ config: gone })))).rejects
      .toThrow(/0012 refuses: agents\.egpt in .* has no `configuration` key, so there is nothing to repoint/);
  });

  // The node is ALREADY broken - the persona names a type file that is not there, or will not
  // parse - and a silent repoint would hide that behind a migration claiming to have fixed it.
  it('the named type file is missing, or does not parse', async () => {
    const h = home({ types: without('haiku-low') });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(new RegExp(`0012 refuses: the persona's configuration names haiku-low, but there is no ${typePath(h, 'haiku-low').replace(/[\\.]/g, '\\$&')} - this node is already broken`));
    await expect(plan(ctxFor(home({ types: { ...TYPES, 'haiku-low': 'model: [ broken\n' } })))).rejects
      .toThrow(/0012 refuses: .*haiku-low\.yaml does not parse/);
  });

  it('a config.yaml that does not parse', async () => {
    await expect(plan(ctxFor(home({ config: 'agents: [ broken\n' })))).rejects.toThrow(/0012 refuses: .* does not parse/);
  });
});

describe('0012 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is empty
  // so 0007 reads nothing as this node's own (as tests/migrations-0011-*).
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');
  const ledger = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0012-persona-is-not-on-haiku'].outcome;

  it('do: applied and recorded, only that one line changed, a backup left beside the config', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('applied');
    // 0020, later in the chain, hands do's persona the `rodz` handle on top of 0012's one line.
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO_AFTER.replace('[ d, don ]', '[ d, don, rodz ]'));
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('config.yaml.bak-0012-'))).toHaveLength(1);
  });

  it('kg: recorded as already satisfied, nothing touched, no backup', async () => {
    const h = home({ config: KG });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('already-satisfied');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
    expect(readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'))).toEqual([]);
  });
});
