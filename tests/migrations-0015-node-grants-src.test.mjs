// tests/migrations-0015-node-grants-src.test.mjs — migrations/0015-node-grants-the-operators-src.mjs.
//
// The block this writes is the ONE place a folder is granted to every being on the node, so what
// it writes is asserted on the FULL text, never a re-parse: the comment lines that say why it is
// there are not part of the parse, and "byte-identical apart from the inserted lines" is the only
// check that can see them. CRLF throughout, as kg's own config.yaml is.
//
// THE PATH IS READ OFF THE FIXTURE (`dirname(egptHome) + '/src'`), never spelled C:/Users/an: a
// migration that hardcoded the operator's box would pass a test that hardcoded it too. The home is
// therefore a `.egpt` INSIDE a temp dir, so the test owns whether `<home>/src` exists.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0015-node-grants-the-operators-src.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const slash = (p) => String(p).replace(/\\/g, '/');

// kg: the persona and wren, and a `networks:` block after them - so the insertion point is the END
// of the document and the last root key is a NESTED one, which is where a naive append lands
// inside the wrong map.
const KG_LINES = [
  '# config.yaml - kg (fixture)',
  'node_name: kg',
  'user_name: "John"',
  'agents:',
  '  egpt:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    personality: egpt # config/agents/identities/egpt.md',
  '    handles: [ e, egpt, ekg, egptkg ]',
  '    default: true',
  '    name: "E"',
  '    conversation_defaults:',
  '      access_level: sandbox',
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
  '',
  'networks:',
  '  home:',
  '    subnet: 10.0.0.0/24',
];
const KG = crlf(KG_LINES);

// do: a flatter config, no `agents:` at all - the grant is a NODE property, not an agents one, so
// a node with no beings declared yet still gets it.
const DO_LINES = [
  '# config.yaml - do (fixture)',
  'node_name: do',
  'user_name: "John"',
];
const DO = crlf(DO_LINES);

const TYPES = {
  wren: crlf(['type: ccode', 'model: opus', 'cwd: /somewhere/else', 'allowed_tools: [ "*" ]']),
  'sonnet-default': 'type: ccode\nmodel: sonnet\neffort: high\n',
};
const IDENTITIES = { wren: '# I am wren\n', egpt: '# I am {{agent_name}}\n' };

// The profile is <base>/.egpt, so `dirname(egptHome)` is <base> and the src/ this grants is
// <base>/src - created only when the test says the node has one.
function home({ config = KG, src = true, types = TYPES, identities = IDENTITIES } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'egpt-0015-'));
  const h = join(base, '.egpt');
  mkdirSync(join(h, 'config', 'agents', 'identities'), { recursive: true });
  writeFileSync(join(h, 'config', 'config.yaml'), config);
  for (const [name, text] of Object.entries(types)) writeFileSync(join(h, 'config', 'agents', `${name}.yaml`), text);
  for (const [name, text] of Object.entries(identities)) writeFileSync(join(h, 'config', 'agents', 'identities', `${name}.md`), text);
  if (src) mkdirSync(join(base, 'src', 'egpt'), { recursive: true });
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const srcOf = (h) => slash(join(dirname(h), 'src'));
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0015-test`; writeFileSync(to, readFileSync(f)); return to; } });
const baks = (h) => readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'));

// The block as it must read in the operator's file.
const blockLines = (h) => [
  '# NODE-WIDE READ GRANT (0015, operator 2026-09-20: "we can \'leak\' my own src/ to the agent',
  '# (read-only for now)"). ONE place to grant a folder to EVERY being here, and one place to',
  '# revoke it - src/spine/brainpool.mjs resolveBeingDef merges this into every being\'s def, UNDER',
  '# the def\'s own allowed_paths, so a being that names the same path keeps its own narrower grant.',
  'allowed_paths:',
  `  ${srcOf(h)}:`,
  '    allowed_tools: [ Read, Glob, Grep ]',
];

describe('0015 on a node that grants nothing yet', () => {
  it('plans the whole block, at the document root, naming the derived path', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${KG_LINES.length + 1}-${KG_LINES.length + 7}  insert the node-level \`allowed_paths:\` block at the document root (7 lines):`,
      ...blockLines(h).map((l) => `  + ${l}`),
      `every being on this node reads ${srcOf(h)} - granted once, revoked once`,
      'backup first, beside it: <file>.bak-0015-<timestamp>',
    ]);
  });

  it('apply: byte-identical apart from the appended block - CRLF kept, nothing nested into networks:', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const out = readFileSync(cfgPath(h), 'utf8');
    expect(out).toBe(KG + crlf(blockLines(h)));
    expect(out.startsWith(KG)).toBe(true);
    // The key is at the ROOT, not under networks: - the parse is the proof the splice's own
    // verification already demanded, asserted here in the shape a being will read it.
    const cfg = YAML.parse(out);
    expect(cfg.allowed_paths).toEqual({ [srcOf(h)]: { allowed_tools: ['Read', 'Glob', 'Grep'] } });
    expect(cfg.networks).toEqual({ home: { subnet: '10.0.0.0/24' } });
    expect(readFileSync(`${cfgPath(h)}.bak-0015-test`, 'utf8')).toBe(KG);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('a node with no `agents:` at all is granted it too - this is a node property, not an agents one', async () => {
    const h = home({ config: DO });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO + crlf(blockLines(h)));
  });

  it('a node whose profile lives elsewhere grants ITS OWN src/, never the operator\'s box', async () => {
    const h = home();
    expect(srcOf(h)).not.toBe('C:/Users/an/src');
    const p = await plan(ctxFor(h));
    expect(p.changes.join('\n')).toContain(srcOf(h));
    expect(p.changes.join('\n')).not.toContain('C:/Users/an/src');
  });
});

describe('0015 on a node that already has a node-level allowed_paths', () => {
  const WITH_BLOCK = crlf([...DO_LINES, 'allowed_paths:', '  C:/shared/reference:', '    allowed_tools: [ Read ]']);

  it('the one path goes INTO the existing block, and what was there is untouched', async () => {
    const h = home({ config: WITH_BLOCK });
    const p = await plan(ctxFor(h));
    expect(p.changes[0]).toBe(`${cfgPath(h)}:7-8  insert ${srcOf(h)} into the node's existing \`allowed_paths:\` (2 lines):`);
    await p.apply();
    const out = readFileSync(cfgPath(h), 'utf8');
    expect(out).toBe(WITH_BLOCK + crlf([`  ${srcOf(h)}:`, '    allowed_tools: [ Read, Glob, Grep ]']));
    expect(YAML.parse(out).allowed_paths).toEqual({
      'C:/shared/reference': { allowed_tools: ['Read'] },
      [srcOf(h)]: { allowed_tools: ['Read', 'Glob', 'Grep'] },
    });
  });
});

describe('0015 is satisfied where it has nothing to do', () => {
  it('the node already grants that path node-wide - whatever class it granted it in', async () => {
    const h = home({ config: DO });
    const already = crlf([...DO_LINES, 'allowed_paths:', `  ${srcOf(h)}:`]);   // full access, not read-only
    writeFileSync(cfgPath(h), already);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`${cfgPath(h)} already grants ${srcOf(h)} node-wide (\`allowed_paths.${srcOf(h)}\`), so every being here already reads it`);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(already);
  });

  it('the msys form of the same folder IS the same folder', async () => {
    const h = home({ config: DO });
    const msys = srcOf(h).replace(/^([A-Za-z]):\//, (_m, d) => `/${d.toLowerCase()}/`);
    writeFileSync(cfgPath(h), crlf([...DO_LINES, 'allowed_paths:', `  ${msys}:`, '    allowed_tools: [ Read ]']));
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toContain(`already grants ${srcOf(h)} node-wide (\`allowed_paths.${msys}\`)`);
  });

  it('there is no src/ on this node - a grant on a folder that is not there is a line that only lies', async () => {
    const h = home({ src: false });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toBe(`there is no ${srcOf(h)} on this node, so there is nothing to grant - not added here`);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG);
  });
});

describe('0015 refuses, naming the place', () => {
  it('a top-level allowed_paths that is not a mapping', async () => {
    const h = home({ config: crlf([...DO_LINES, 'allowed_paths: [ C:/one, C:/two ]']) });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0015 refuses: `allowed_paths:` in .* is \["C:\/one","C:\/two"\], not a mapping of paths/);
  });

  it('a config.yaml that does not parse', async () => {
    const h = home({ config: 'agents: [ broken\n' });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0015 refuses: .* does not parse/);
  });

  it('there is no config.yaml', async () => {
    const h = home();
    const p = plan({ ...ctxFor(h), egptHome: join(h, 'nowhere') });
    await expect(p).rejects.toThrow(/0015 refuses: there is no .*nowhere/);
  });

  it('the file changed between plan and apply', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = KG.replace('node_name: kg', 'node_name: kg2');
    writeFileSync(cfgPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0015 refuses: .*config\.yaml changed since it was planned - re-run/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(edited);
    expect(baks(h)).toEqual([]);
  });
});

describe('0015 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is empty
  // so 0007 reads nothing as this node's own (as tests/migrations-0014-*).
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');
  const ledger = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0015-node-grants-the-operators-src'].outcome;

  it('kg: applied and recorded, the block at the root, a backup beside config.yaml', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('applied');
    // 0014 rewrites wren.yaml on this fixture, so config.yaml is asserted on the grant itself.
    expect(YAML.parse(readFileSync(cfgPath(h), 'utf8')).allowed_paths)
      .toEqual({ [srcOf(h)]: { allowed_tools: ['Read', 'Glob', 'Grep'] } });
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('config.yaml.bak-0015-'))).toHaveLength(1);
  });

  it('a node with no src/: recorded as already satisfied, nothing touched, no backup', async () => {
    const h = home({ config: DO, src: false });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledger(h)).toBe('already-satisfied');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
    expect(existsSync(`${cfgPath(h)}.bak-0015-test`)).toBe(false);
    expect(baks(h)).toEqual([]);
  });
});
