// tests/migrations-0014-wren-wakes-at-home.test.mjs — migrations/0014-wren-wakes-at-home.mjs.
//
// kg's fixture carries the live line byte for byte (CRLF, the trailing comment that says why wren
// used to run in the deployed tree): that one line is the whole point of this migration, and what
// it becomes — value AND comment — is asserted in full. do has no unsandboxed being, so do is the
// same one rule reading satisfied, not a second branch.
//
// The assertions are on the FULL text, never a re-parse: the data surviving is not the point, the
// bytes are. A comment is not part of the parse, so "byte-identical apart from that one line" is
// the only check that can see it. The identity file is asserted the same way — the appended line
// is the rules wren stops picking up for free the moment it wakes outside the checkout.
//
// The HOME is read off the fixture (`dirname(egptHome)`), never spelled C:/Users/an: a migration
// that hardcoded the operator's box would pass a test that hardcoded it too.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { plan } from '../migrations/0014-wren-wakes-at-home.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const slash = (p) => String(p).replace(/\\/g, '/');

// kg's agent registry: the persona, and wren - the ONE being that runs as the operator.
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
  '',
  '  # wren - the meta engineer. Unsandboxed, because its job is to change the machine.',
  '  wren:',
  '    configuration: wren # config/agents/wren.yaml',
  '    personality: wren # config/agents/identities/wren.md',
  '    handles: [ w, wren, wkg ]',
  '    name: "wren"',
  '    conversation_defaults:',
  '      access_level: all',
  '      allowed_users: [ "*" ]',
  '      sandboxed: false',
];
const KG = crlf(KG_LINES);

// do: the persona is sandboxed and E is a relay. No being runs as the operator.
const DO = crlf([
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
  '',
  '  e:',
  '    configuration: relay # config/agents/relay.yaml',
  '    relay_channel: ekg.kg',
]);

// config/agents/wren.yaml. Line 6 (index 5) is the live line, exactly as it reads on kg.
const WREN_TYPE_LINES = [
  '# config/agents/wren.yaml - the meta engineer\'s run configuration.',
  'type: ccode',
  'model: opus',
  'effort: xhigh',
  'personality: wren',
  'cwd: C:/Users/an/bin/egpt # wren\'s job is the system, so it runs in the deployed tree',
  'allowed_tools: [ "*" ]',
];
const CWD_LINE_NO = 6;
const WREN_TYPE = crlf(WREN_TYPE_LINES);

const COMMENT = 'a meta engineer manages the whole box, and only a being in this cwd can inherit a thread from the operator\'s own session (0014, operator 2026-09-20: "should wake in your same folder")';

const WREN_ID_LINES = [
  '# I am {{agent_name}}',
  '',
  'I am wren, the meta-engineer. I run unsandboxed, as the operator, and my job',
  'is the system itself.',
];
const WREN_ID = crlf(WREN_ID_LINES);
const ID_APPEND_LINE_NO = WREN_ID_LINES.length + 2;   // the blank line, then the appended one

const TYPES = {
  wren: WREN_TYPE,
  'sonnet-default': 'type: ccode\nmodel: sonnet\neffort: high\n',
  relay: 'type: relay\n',
};
const IDENTITIES = { wren: WREN_ID, egpt: '# I am {{agent_name}}\n' };

function home({ config = KG, types = TYPES, identities = IDENTITIES } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'egpt-0014-'));
  mkdirSync(join(h, 'config', 'agents', 'identities'), { recursive: true });
  writeFileSync(join(h, 'config', 'config.yaml'), config);
  for (const [name, text] of Object.entries(types)) writeFileSync(join(h, 'config', 'agents', `${name}.yaml`), text);
  for (const [name, text] of Object.entries(identities)) writeFileSync(join(h, 'config', 'agents', 'identities', `${name}.md`), text);
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const typePath = (h, name) => join(h, 'config', 'agents', `${name}.yaml`);
const idPath = (h, name) => join(h, 'config', 'agents', 'identities', `${name}.md`);
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0014-test`; writeFileSync(to, readFileSync(f)); return to; } });

// What the node's own home is, read off the fixture the way the migration reads it.
const homeOf = (h) => slash(dirname(h));
const rulesOf = (h) => slash(join(dirname(h), 'src', 'egpt', 'CLAUDE.md'));
const lineOf = (h) => `I wake in the operator's own folder, not in the eGPT checkout, so the repo's rules do not load themselves: the engineering rules I work by are ${rulesOf(h)}, and I read that file before I change the system.`;
const cwdAfter = (h) => `cwd: ${homeOf(h)} # ${COMMENT}`;
const typeAfter = (h) => crlf(WREN_TYPE_LINES.map((l, i) => (i === CWD_LINE_NO - 1 ? cwdAfter(h) : l)));
const idAfter = (h) => `${WREN_ID}\r\n${lineOf(h)}\r\n`;
const baks = (h, dir) => readdirSync(join(h, 'config', ...dir)).filter((f) => f.includes('.bak-'));

describe('0014 on kg - wren is pinned to the deployed tree', () => {
  it('plans the one changed line and the one appended line, and says what each becomes', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${typePath(h, 'wren')}:${CWD_LINE_NO}`,
      `  - ${WREN_TYPE_LINES[CWD_LINE_NO - 1]}`,
      `  + ${cwdAfter(h)}`,
      `wren wakes at ${homeOf(h)} - the operator's own session folder, the parent of ${h} - instead of C:/Users/an/bin/egpt`,
      `${idPath(h, 'wren')}:${ID_APPEND_LINE_NO}  append the rules ${typePath(h, 'wren')} no longer wakes inside:`,
      `  + ${lineOf(h)}`,
      'backup first, beside each: <file>.bak-0014-<timestamp>',
    ]);
  });

  it('apply: the type file is byte-identical apart from that one line - CRLF and every other comment kept', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const out = readFileSync(typePath(h, 'wren'), 'utf8');
    expect(out).toBe(typeAfter(h));
    const before = WREN_TYPE.split('\r\n');
    expect(out.split('\r\n').flatMap((l, i) => (l === before[i] ? [] : [i + 1]))).toEqual([CWD_LINE_NO]);
    expect(out).not.toContain('bin/egpt');
    expect(readFileSync(`${typePath(h, 'wren')}.bak-0014-test`, 'utf8')).toBe(WREN_TYPE);
    // config.yaml is only READ - the being is declared there, its cwd is not.
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('apply: the identity gains exactly one line, naming the repo rules it no longer wakes inside', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    const out = readFileSync(idPath(h, 'wren'), 'utf8');
    expect(out).toBe(idAfter(h));
    expect(out.startsWith(WREN_ID)).toBe(true);
    expect(out.split('\r\n').filter((l) => l.includes('CLAUDE.md'))).toEqual([lineOf(h)]);
    expect(readFileSync(`${idPath(h, 'wren')}.bak-0014-test`, 'utf8')).toBe(WREN_ID);
  });

  it('a cwd line with NO trailing comment gets its value moved and no comment invented', async () => {
    const bare = WREN_TYPE.replace(WREN_TYPE_LINES[CWD_LINE_NO - 1], 'cwd: C:/Users/an/bin/egpt');
    const h = home({ types: { ...TYPES, wren: bare } });
    const p = await plan(ctxFor(h));
    expect(p.changes.slice(1, 3)).toEqual(['  - cwd: C:/Users/an/bin/egpt', `  + cwd: ${homeOf(h)}`]);
    await p.apply();
    expect(readFileSync(typePath(h, 'wren'), 'utf8')).toBe(bare.replace('cwd: C:/Users/an/bin/egpt', `cwd: ${homeOf(h)}`));
  });

  it('the identity line is added once: a re-run of the move over an identity that already names the rules appends nothing', async () => {
    const h = home();
    writeFileSync(idPath(h, 'wren'), idAfter(h));   // as a first run would have left it
    const p = await plan(ctxFor(h));
    expect(p.changes).toEqual([
      `${typePath(h, 'wren')}:${CWD_LINE_NO}`,
      `  - ${WREN_TYPE_LINES[CWD_LINE_NO - 1]}`,
      `  + ${cwdAfter(h)}`,
      `wren wakes at ${homeOf(h)} - the operator's own session folder, the parent of ${h} - instead of C:/Users/an/bin/egpt`,
      `${idPath(h, 'wren')} already names ${rulesOf(h)} - left alone`,
      'backup first, beside each: <file>.bak-0014-<timestamp>',
    ]);
    await p.apply();
    expect(readFileSync(idPath(h, 'wren'), 'utf8')).toBe(idAfter(h));
    expect(baks(h, ['agents', 'identities'])).toEqual([]);
  });

  it('two meta engineers that agree about their cwd both move, and share one identity append', async () => {
    const twoLines = [...KG_LINES,
      '',
      '  ken:',
      '    configuration: ken # config/agents/ken.yaml',
      '    personality: wren',
      '    conversation_defaults:',
      '      access_level: all',
    ];
    const h = home({
      config: crlf(twoLines),
      types: { ...TYPES, ken: 'type: ccode\ncwd: C:/Users/an/bin/egpt\n' },
    });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(typePath(h, 'wren'), 'utf8')).toBe(typeAfter(h));
    expect(readFileSync(typePath(h, 'ken'), 'utf8')).toBe(`type: ccode\ncwd: ${homeOf(h)}\n`);
    expect(readFileSync(idPath(h, 'wren'), 'utf8')).toBe(idAfter(h));
  });
});

describe('0014 is satisfied where it has nothing to do', () => {
  it('do: no being runs as the operator, so there is no meta engineer to move', async () => {
    const h = home({ config: DO });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`no being in ${cfgPath(h)} has \`conversation_defaults.access_level: all\`, so this node has no meta engineer`);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
  });

  it('a node with no `agents:` mapping at all', async () => {
    const h = home({ config: 'node_name: zz\n' });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`${cfgPath(h)} has no \`agents:\` mapping, so this node has no meta engineer`);
  });

  it('the cwd is already the home - nothing touched, and no rules line appended either', async () => {
    const h = home();
    const already = crlf(WREN_TYPE_LINES.map((l, i) => (i === CWD_LINE_NO - 1 ? `cwd: ${homeOf(h)}` : l)));
    writeFileSync(typePath(h, 'wren'), already);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`${typePath(h, 'wren')} already pins \`cwd: ${homeOf(h)}\` - this node's meta engineer already wakes where the operator's own session does`);
    expect(readFileSync(typePath(h, 'wren'), 'utf8')).toBe(already);
    expect(readFileSync(idPath(h, 'wren'), 'utf8')).toBe(WREN_ID);
  });

  it('the type file pins no `cwd:` key', async () => {
    const h = home({ types: { ...TYPES, wren: 'type: ccode\nmodel: opus\n' } });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`this node's meta engineer (wren) pins no \`cwd\`, so nothing here decides where it wakes: agents.wren runs wren, and ${typePath(h, 'wren')} pins no \`cwd\``);
  });

  it('the type file is missing', async () => {
    const h = home({ types: Object.fromEntries(Object.entries(TYPES).filter(([n]) => n !== 'wren')) });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`this node's meta engineer (wren) pins no \`cwd\`, so nothing here decides where it wakes: agents.wren names wren, and there is no ${typePath(h, 'wren')}`);
  });

  it('the being names no type file at all - an inline `configuration:` pins no cwd this can move', async () => {
    const inline = KG.replace('    configuration: wren # config/agents/wren.yaml\r\n', '    configuration: { type: ccode, model: opus }\r\n');
    const p = await plan(ctxFor(home({ config: inline })));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toMatch(/agents\.wren names no type file \(`configuration:` is an inline map\)/);
  });
});

describe('0014 refuses, naming the place', () => {
  it('the type file does not parse', async () => {
    const h = home({ types: { ...TYPES, wren: 'cwd: [ broken\n' } });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0014 refuses: .*wren\.yaml does not parse/);
    expect(readFileSync(idPath(h, 'wren'), 'utf8')).toBe(WREN_ID);
  });

  it('`cwd` is present but is not a string', async () => {
    const h = home({ types: { ...TYPES, wren: 'type: ccode\ncwd: 42\n' } });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0014 refuses: `cwd` in .*wren\.yaml is 42, not a directory/);
  });

  it('two meta engineers disagree about where they wake', async () => {
    const twoLines = [...KG_LINES,
      '',
      '  ken:',
      '    configuration: ken # config/agents/ken.yaml',
      '    conversation_defaults:',
      '      access_level: all',
    ];
    const h = home({
      config: crlf(twoLines),
      types: { ...TYPES, ken: 'type: ccode\ncwd: C:/Users/an/src/egpt\n' },
    });
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0014 refuses: this node has more than one meta engineer and they disagree about where they wake .* - which one is the operator's own folder is a human decision, not a guess/);
    expect(readFileSync(typePath(h, 'wren'), 'utf8')).toBe(WREN_TYPE);
    expect(readFileSync(typePath(h, 'ken'), 'utf8')).toBe('type: ccode\ncwd: C:/Users/an/src/egpt\n');
  });

  // The whole second half of this migration is "the rules must still reach it". With no identity
  // file there is nowhere to put them, so the move is not made either.
  it('the identity file is not there, so the rules would have nowhere to go', async () => {
    const h = home();
    rmSync(idPath(h, 'wren'));
    await expect(plan(ctxFor(h))).rejects
      .toThrow(new RegExp(`0014 refuses: agents\\.wren wears the identity wren, and there is no ${idPath(h, 'wren').replace(/[\\.]/g, '\\$&')} - moving it out of the checkout without naming`));
    expect(readFileSync(typePath(h, 'wren'), 'utf8')).toBe(WREN_TYPE);
  });

  it('a config.yaml that does not parse', async () => {
    await expect(plan(ctxFor(home({ config: 'agents: [ broken\n' })))).rejects.toThrow(/0014 refuses: .* does not parse/);
  });
});

describe('0014 writes both files or neither', () => {
  it('refuses when the TYPE FILE changed between plan and apply, and leaves the identity alone', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = WREN_TYPE.replace('effort: xhigh', 'effort: high');
    writeFileSync(typePath(h, 'wren'), edited);
    await expect(p.apply()).rejects.toThrow(/0014 refuses: .*wren\.yaml changed since it was planned - re-run/);
    expect(readFileSync(typePath(h, 'wren'), 'utf8')).toBe(edited);
    expect(readFileSync(idPath(h, 'wren'), 'utf8')).toBe(WREN_ID);
    expect(baks(h, ['agents'])).toEqual([]);
    expect(baks(h, ['agents', 'identities'])).toEqual([]);
  });

  it('refuses when the IDENTITY changed between plan and apply, and leaves the type file alone', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = `${WREN_ID}\r\nI also host the radio.\r\n`;
    writeFileSync(idPath(h, 'wren'), edited);
    await expect(p.apply()).rejects.toThrow(new RegExp(`0014 refuses: .*identities.${'wren'}\\.md changed since it was planned - re-run`));
    expect(readFileSync(idPath(h, 'wren'), 'utf8')).toBe(edited);
    expect(readFileSync(typePath(h, 'wren'), 'utf8')).toBe(WREN_TYPE);
    expect(baks(h, ['agents'])).toEqual([]);
  });
});

describe('0014 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is empty
  // so 0007 reads nothing as this node's own (as tests/migrations-0012-*).
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');
  const ledger = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0014-wren-wakes-at-home'].outcome;

  it('kg: applied and recorded, the one line moved, the rules named, a backup beside each file', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('applied');
    expect(readFileSync(typePath(h, 'wren'), 'utf8')).toBe(typeAfter(h));
    expect(readFileSync(idPath(h, 'wren'), 'utf8')).toBe(idAfter(h));
    expect(readdirSync(join(h, 'config', 'agents')).filter((f) => f.startsWith('wren.yaml.bak-0014-'))).toHaveLength(1);
    expect(readdirSync(join(h, 'config', 'agents', 'identities')).filter((f) => f.startsWith('wren.md.bak-0014-'))).toHaveLength(1);
  });

  it('do: recorded as already satisfied, nothing touched, no backup', async () => {
    const h = home({ config: DO });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('already-satisfied');
    expect(readFileSync(typePath(h, 'wren'), 'utf8')).toBe(WREN_TYPE);
    expect(existsSync(`${typePath(h, 'wren')}.bak-0014-test`)).toBe(false);
    expect(baks(h, ['agents'])).toEqual([]);
  });
});
