// tests/migrations-0011-eplus-is-e-on-opus.test.mjs — migrations/0011-eplus-is-e-on-opus.mjs.
//
// The fixtures are miniatures of each node's real shape: kg's config.yaml is CRLF, its default
// agent is `egpt` with handles [ e, egpt, ekg, egptkg ], its block ends with conversation_defaults
// and a continuation comment line, and the next thing in the file is a blank line and the comment
// block that introduces ken. do's default persona answers to [ d, don ], so do is not E's node.
//
// The assertions are on the FULL text, never a re-parse: what this migration must not do is reflow
// the operator's file. And the last test is the one that proves the BLOCK is right rather than just
// well-placed — the inserted config, parsed back out of the fixture, must make `+ hola` and
// `e+ hola` resolve to eplus through router.mjs's addressed(), the node's one mention matcher.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0011-eplus-is-e-on-opus.mjs';
import { runMigrations } from '../setup/migrate.mjs';
import { addressed } from '../src/spine/router.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

// kg, through the end of the persona's own block — the last two lines are the shape that matters:
// an end-of-line comment, then a comment line indented INSIDE conversation_defaults.
const KG_HEAD = [
  '# config.yaml - kg (fixture)',
  'node_name: kg',
  'agents:',
  '  egpt:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    personality: egpt # config/agents/identities/egpt.md',
  '    handles: [ e, egpt, ekg, egptkg ]',
  '    default: true',
  '    name: "E"',
  '    body_emoji: "🐶"',
  '    conversation_defaults:',
  '      access_level: sandbox',
  '      allowed_users: [ "+15551234567" ]',
  '      verbose_thinking: true # rescued from egpt.yaml; this tier outranks the brain def,',
  '      # and it stays on for every conversation on this node',
];
const KG_TAIL = [
  '',
  '  # KING KEN - the operator\'s second being (2026-08-20). Opus xhigh, mention only.',
  '  ken:',
  '    configuration: opus-xhigh # config/agents/opus-xhigh.yaml',
  '    personality: ken',
  '    handles: [ ken ]',
  '    mode: mention',
  '    conversation_defaults:',
  '      verbose_thinking: true',
];
// The block 0011 inserts, spelled out here so this test pins its CONTENT, not just its place.
const BLOCK = [
  '  # E+ - E\'s own voice on a bigger model (operator 2026-09-17: "+/e+ for opus high only for',
  '  # allowed user"). Its own key, so its own threads: this is not E\'s conversation continued,',
  '  # it is a second being wearing E\'s identity. Opus 5 is 2.5x Sonnet 5 per token ($5/$25 vs',
  '  # $2/$10 per million), so `allowed_users` keeps it to the operator - anyone else saying "+"',
  '  # in a chat wakes nobody.',
  '  eplus:',
  '    configuration: opus-high # config/agents/opus-high.yaml',
  '    personality: egpt # config/agents/identities/egpt.md - E\'s identity, E\'s voice',
  '    handles: [ "+", "e+" ] # quoted: bare + and e+ are not plain YAML scalars',
  '    name: "E+"',
  '    body_emoji: "🐶"',
  '    mode: mention # never answers unaddressed',
  '    conversation_defaults:',
  '      access_level: sandbox',
  '      allowed_users: [ "+15551234567" ]',
  '      verbose_thinking: true',
];
const KG = crlf([...KG_HEAD, ...KG_TAIL]);
const KG_WITH = crlf([...KG_HEAD, ...BLOCK, ...KG_TAIL]);

const DO = [
  'node_name: do',
  'agents:',
  '  egpt:',
  '    configuration: haiku-low',
  '    handles: [ d, don ]',
  '    default: true',
  '    conversation_defaults:',
  '      allowed_users: [ "+15551234567" ]',
  '  e:',
  '    configuration: relay # answered by kg, posted from this account',
  '    relay_channel: ekg.kg',
  '',
].join('\n');

function home({ config = KG, configuration = true, files = {} } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'egpt-0011-'));
  mkdirSync(join(h, 'config', 'agents'), { recursive: true });
  writeFileSync(join(h, 'config', 'config.yaml'), config);
  if (configuration) writeFileSync(join(h, 'config', 'agents', 'opus-high.yaml'), 'type: ccode\nmodel: opus\neffort: high\n');
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(h, rel), text);
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0011-test`; writeFileSync(to, readFileSync(f)); return to; } });
// The persona's own allowed_users removed, so the wren fallback is the only source left.
const withoutPersonaUsers = (src) => src.replace('      allowed_users: [ "+15551234567" ]\r\n', '');
const WREN = crlf([
  '  wren:',
  '    configuration: opus-max',
  '    handles: [ wren ]',
  '    conversation_defaults:',
  '      access_level: all',
  '      allowed_users: [ "operator@kg" ]',
]);

describe('0011 on kg - the persona answers to `e`, so this is E\'s node', () => {
  it('plans inserting exactly the E+ block, directly after the persona, with allowed_users copied from the persona', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${KG_HEAD.length + 1}-${KG_HEAD.length + BLOCK.length}  insert agents.eplus directly after agents.egpt (${BLOCK.length} lines):`,
      ...BLOCK.map((l) => `  + ${l}`),
      'allowed_users copied from agents.egpt.conversation_defaults.allowed_users',
      'backup first, beside it: <file>.bak-0011-<timestamp>',
    ]);
  });

  it('apply: byte-identical except the inserted lines - CRLF kept, the block lands after the persona\'s continuation comment and BEFORE the blank line and `# KING KEN`', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    const out = readFileSync(cfgPath(h), 'utf8');
    expect(out).toBe(KG_WITH);
    expect(out).toContain('      # and it stays on for every conversation on this node\r\n  # E+ -');
    expect(out).toContain('      verbose_thinking: true\r\n\r\n  # KING KEN -');
    expect(readFileSync(`${cfgPath(h)}.bak-0011-test`, 'utf8')).toBe(KG);
    expect(Object.keys(YAML.parse(out).agents)).toEqual(['egpt', 'eplus', 'ken']);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  // The IDS are copied; their quoting in the NEW block is whatever YAML's own flow output needs
  // (`operator@kg` needs none), and the source block wren declares them in is untouched.
  it('takes allowed_users from the wren agent when the persona has none of its own', async () => {
    const h = home({ config: withoutPersonaUsers(KG) + WREN });
    const p = await plan(ctxFor(h));
    expect(p.changes).toContain('allowed_users copied from agents.wren.conversation_defaults.allowed_users');
    expect(p.changes).toContain('  +       allowed_users: [ operator@kg ]');
    await p.apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(crlf([...KG_HEAD.filter((l) => !l.includes('allowed_users')), ...BLOCK.map((l) => l.replace('[ "+15551234567" ]', '[ operator@kg ]')), ...KG_TAIL]) + WREN);
  });

  it('refuses to write over a config.yaml edited between plan and apply, and touches nothing', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = KG.replace('handles: [ ken ]', 'handles: [ ken, k ]');
    writeFileSync(cfgPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0011 refuses: .*config\.yaml changed since it was planned - re-run/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(edited);
    expect(readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'))).toEqual([]);
  });
});

describe('0011 is satisfied where it has nothing to do', () => {
  it('do: the persona answers to [ d, don ], not `e` - satisfied, nothing touched', async () => {
    const h = home({ config: DO, configuration: false });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toMatch(/agents\.egpt, which answers to \[ d, don \] and not `e`/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO);
  });

  it('satisfied is checked FIRST: agents.eplus already there on opus-high wins over anything it could refuse over', async () => {
    const already = crlf([...KG_HEAD, ...BLOCK, ...KG_TAIL, '  gauss:', '    handles: [ "+" ]']);
    const p = await plan(ctxFor(home({ config: already, configuration: false })));
    expect(p).toMatchObject({ satisfied: true });
    expect(p.notes[0]).toMatch(/already configured: handles \[ \+, e\+ \] on opus-high/);
  });

  // A refusal STOPS THE WHOLE CHAIN, so a node with no persona - which is every config.yaml with no
  // `agents:` block - must read satisfied rather than halt every migration after this one.
  it('a node with no persona at all: no `agents:` mapping, or no agent carrying `default: true`', async () => {
    const none = await plan(ctxFor(home({ config: 'node_name: zz\n', configuration: false })));
    expect(none).toMatchObject({ satisfied: true });
    expect(none.notes[0]).toMatch(/has no `agents:` mapping, so this node has no persona/);
    const undefaulted = await plan(ctxFor(home({ config: KG.replace('    default: true\r\n', ''), configuration: false })));
    expect(undefaulted).toMatchObject({ satisfied: true });
    expect(undefaulted.notes[0]).toMatch(/carries `default: true`, so this node has no persona/);
  });
});

describe('0011 refuses, naming the place', () => {
  it('agents.eplus already exists in a DIFFERENT shape', async () => {
    const other = crlf([...KG_HEAD, '  eplus:', '    configuration: opus-max', '    handles: [ "++" ]', ...KG_TAIL]);
    await expect(plan(ctxFor(home({ config: other })))).rejects
      .toThrow(/0011 refuses: agents\.eplus already exists in .* in a different shape \(configuration: "opus-max", handles: \["\+\+"\]\) - a hand edit/);
  });

  it('another being already answers to `+` or `e+` - by handles, by voice_handles, or by a fallback_handle', async () => {
    const add = (lines) => crlf([...KG_HEAD, ...KG_TAIL, ...lines]);
    await expect(plan(ctxFor(home({ config: add(['  plus:', '    handles: [ "+", plus ]']) })))).rejects
      .toThrow(/another being already answers to E\+'s handles in .*: agents\.plus\.handles claims "\+"/);
    await expect(plan(ctxFor(home({ config: add(['  spoken:', '    handles: [ spoken ]', '    voice_handles: [ "e+" ]']) })))).rejects
      .toThrow(/agents\.spoken\.voice_handles claims "e\+"/);
    await expect(plan(ctxFor(home({ config: add(['  rodz:', '    handles: [ rodz ]', '    fallback_handle: { handle: [ "+" ], unless_present: "+13472576794" }']) })))).rejects
      .toThrow(/agents\.rodz\.fallback_handle claims "\+"/);
  });

  // NOT A REFUSAL (2026-09-17): a node without the type file is not a node E+ belongs on, and a
  // refusal would stop its whole chain over a being it never asked for.
  it('config/agents/opus-high.yaml is not in the profile: satisfied, and says so', async () => {
    const p = await plan(ctxFor(home({ configuration: false })));
    expect(p.satisfied).toBe(true);
    expect(p.notes.join(' ')).toMatch(/there is no .*opus-high\.yaml on this node/);
  });

  // MORE THAN ONE persona, only: such a node may well be E's, and nothing here can say which block
  // E+ goes after. (None at all is satisfied, above - it cannot be E's node.)
  it('the default persona cannot be identified - two agents carry `default: true`', async () => {
    await expect(plan(ctxFor(home({ config: KG.replace('    mode: mention\r\n', '    default: true\r\n') })))).rejects
      .toThrow(/0011 refuses: the default persona cannot be identified: 2 agents carry `default: true` \(egpt, ken\)/);
  });

  // An ungated E+ is what the operator ruled against, so it is not written - but the node is left
  // alone rather than refused, or every later migration would stop behind it.
  it('neither the persona nor wren gives an allowed_users list: satisfied, nothing written', async () => {
    const p = await plan(ctxFor(home({ config: withoutPersonaUsers(KG) })));
    expect(p.satisfied).toBe(true);
    expect(p.notes.join(' ')).toMatch(/lists no trusted ids \(agents\.egpt\.conversation_defaults\.allowed_users or agents\.wren\.conversation_defaults\.allowed_users\)/);
    // Present but EMPTY gates nobody, so it is not a list to copy either.
    expect((await plan(ctxFor(home({ config: KG.replace('[ "+15551234567" ]', '[]') })))).satisfied).toBe(true);
  });

  it('a config.yaml that does not parse', async () => {
    await expect(plan(ctxFor(home({ config: 'agents: [ broken\n' })))).rejects.toThrow(/0011 refuses: .* does not parse/);
  });
});

// THE test that proves the block is right rather than merely well placed.
describe('the inserted block makes `+` and `e+` address E+, and nobody else', () => {
  const agentsAfter = () => YAML.parse(KG_WITH).agents;
  const hit = (text) => addressed(text, agentsAfter()).map((h) => [h.name, h.token, h.atStart]);

  it('`+ hola` and `e+ hola` resolve to eplus, not to the persona that owns `e`', () => {
    expect(hit('+ hi, please write this egpt module')).toEqual([['eplus', '+', true]]);
    expect(hit('e+ hola')).toEqual([['eplus', 'e+', true]]);
    expect(hit('@+ hola')).toEqual([['eplus', '+', true]]);
  });

  it('E still owns `e`, and the tokens that are not an address still wake nobody', () => {
    expect(hit('e hola')).toEqual([['egpt', 'e', true]]);
    for (const text of ['+hi', '1+1 = 2', 'c++ rocks', 'me gusta + que nada']) expect(hit(text)).toEqual([]);
  });
});

describe('0011 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is empty
  // so 0007 reads nothing as this node's own (as tests/migrations-0009-*).
  const ctx = { ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }), localAddresses: new Set() };
  const dir = join(import.meta.dirname, '..', 'migrations');

  it('kg: applied and recorded, only the E+ lines added, a backup left beside the config', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0011-eplus-is-e-on-opus'].outcome).toBe('applied');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_WITH);
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('config.yaml.bak-0011-'))).toHaveLength(1);
  });

  it('do: recorded as already satisfied, nothing touched, no backup', async () => {
    const h = home({ config: DO, configuration: false });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0011-eplus-is-e-on-opus'].outcome).toBe('already-satisfied');
    // 0018 runs later in the same chain and keys this fixture's persona by its handle (`don`), so
    // the config comes back renamed with a 0018 backup beside it - neither is 0011's doing.
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO.replace('  egpt:', '  don:'));
    expect(readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-') && !f.startsWith('config.yaml.bak-0018-'))).toEqual([]);
    expect(existsSync(join(h, 'config', 'agents', 'opus-high.yaml'))).toBe(false);
  });
});
