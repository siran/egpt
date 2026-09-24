// tests/migrations-0021-the-mouth-can-drive.test.mjs — migrations/0021-the-mouth-can-drive.mjs.
//
// ONE ruling, the SAME half on both nodes: the mouth's matrix id joins the `access_level: all`
// being's allowed_users. The fixtures are miniatures of each node's state as it reads AFTER
// 0018/0019/0020, so every earlier migration in the chain has nothing left to do on them (the
// last assertion in this file proves exactly that — a fixture an earlier migration acts on fails
// these tests for the wrong reason, which is how the 0003, 0010, 0018 and 0019 fixtures broke).
//
//   kg  `wren` — handles [ wren, w ], `access_level: all`, `scope: agent/wren` — beside the
//       SANDBOXED persona `egpt`, whose allowed_users line is BYTE-IDENTICAL to wren's, and
//       `llama`, also sandboxed, whose list ends in a BARE unquoted scalar. Only wren's changes:
//       the being is found by its properties and edited by its YAML path, never by matching text.
//   do  `dren` — handles [ dren ], `access_level: all`, `scope: agent/dren` — beside TWO beings
//       that must not move. `don`, the worker, answers to the HANDLE `rodz` since 0020 (`rodz` the
//       handle and `@dolly-egpt:beeper.com` the account are different things, and don is
//       `regular`). And `djh`, the radio agent, IS `access_level: all` — unsandboxed — but is
//       pinned to no `scope:`, so it is not a meta engineer. Measured on do 2026-09-22: that pair
//       is the live shape, and a level-only predicate would read it as ambiguous and refuse,
//       stopping the chain on the one node this ruling is most about.
//
// The assertions are on the FULL text, never a re-parse: the trailing comments beside these lists
// and every other byte are what the splice layer exists to protect. CRLF throughout, as the live
// configs are.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0021-the-mouth-can-drive.mjs';
import { runMigrations } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');

const MOUTH = '@dolly-egpt:beeper.com';
// kg's list as the operator measured it, 2026-09-22 — every id quoted, as they have to be: a bare
// phone number would read as an integer and `@…` is a YAML reserved indicator.
const OPERATOR = '[ "16468217865", "34836563681438", "@anrodriguez:beeper.com" ]';
const DRIVEN = `[ "16468217865", "34836563681438", "@anrodriguez:beeper.com", "${MOUTH}" ]`;
// The trailing comment on the line that CHANGES. It is on the meta engineer's line only, so it
// also names, for these tests, which of the two identical lists is the one that moved.
const DRIVES = '# who may drive this being';

// ── kg, post-0018/0019/0020 ──────────────────────────────────────────────────────────────────
const KG_LINES = [
  '# config.yaml - kg (fixture)',
  'node_name: kg',
  'agents:',
  '  # E, the persona. SANDBOXED - not this node\'s meta engineer, however its own list reads.',
  '  egpt:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ e, egpt, ekg ]',
  '    default: true',
  '    name: "E"',
  '    conversation_defaults:',
  '      access_level: sandbox',
  `      allowed_users: ${OPERATOR} # who may wake E`,
  '',
  '  # WREN - the meta engineer: unsandboxed, running as the operator because its job is the box.',
  '  wren:',
  '    configuration: sonnet-high # config/agents/sonnet-high.yaml',
  '    personality: wren # config/agents/identities/wren.md',
  '    handles: [ wren, w ]',
  '    name: "Wren"',
  '    scope: agent/wren # one agent/wren node-wide',
  '    sandboxed: false',
  '    conversation_defaults:',
  '      access_level: all',
  `      allowed_users: ${OPERATOR} ${DRIVES}`,
  '',
  '  # llama - a local model, SANDBOXED. Its list ends in a BARE unquoted scalar, which the splice',
  '  # could not append to - and never has to, because this being is never visited.',
  '  llama:',
  '    configuration: llama-local',
  '    handles: [ llama ]',
  '    conversation_defaults:',
  '      access_level: sandbox',
  '      allowed_users: [ "16468217865", operator ]',
  '',
  '  # codex, which is not going anywhere',
  '  codex:',
  '    configuration: codex',
  '    handles: [ codex ]',
  'heartbeats:',
  '  alive: true',
];
const KG = crlf(KG_LINES);
const KG_USERS_LINE = KG_LINES.indexOf(`      allowed_users: ${OPERATOR} ${DRIVES}`) + 1;
const KG_AFTER = KG.replace(`${OPERATOR} ${DRIVES}`, `${DRIVEN} ${DRIVES}`);

// ── do, post-0018/0019/0020: the worker is KEYED `don` and answers to `rodz` too ──────────────
const DO_LINES = [
  '# config.yaml - do (fixture)',
  'node_name: do',
  'agents:',
  '  # the WORKER, do\'s persona. Since 0020 it answers to `rodz` as well - a HANDLE, not an id.',
  '  don:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ d, don, rodz ] # the worker, addressed either way',
  '    default: true',
  '    name: "D"',
  '    conversation_defaults:',
  '      access_level: regular',
  `      allowed_users: ${OPERATOR} # who may wake the worker`,
  '  # DREN - do\'s meta engineer',
  '  dren:',
  '    configuration: sonnet-high # config/agents/sonnet-high.yaml',
  '    personality: dren # config/agents/identities/dren.md',
  '    handles: [ dren ]',
  '    name: "Dren"',
  '    scope: agent/dren # one agent/dren node-wide',
  '    sandboxed: false',
  '    conversation_defaults:',
  '      access_level: all',
  `      allowed_users: ${OPERATOR} ${DRIVES}`,
  '  # DJH - the radio agent. UNSANDBOXED, and pinned to NO `scope:`, so it is not a meta engineer.',
  '  # Off since 0006.',
  '  djh:',
  '    configuration: haiku-low # config/agents/haiku-low.yaml',
  '    handles: [ djh ]',
  '    mode: off',
  '    conversation_defaults:',
  '      access_level: all',
  '      allowed_users: [ "16468217865" ] # who may wake the radio',
  '  codex:',
  '    configuration: codex',
  '    handles: [ codex ]',
];
const DO = crlf(DO_LINES);
const DO_USERS_LINE = DO_LINES.indexOf(`      allowed_users: ${OPERATOR} ${DRIVES}`) + 1;
const DO_AFTER = DO.replace(`${OPERATOR} ${DRIVES}`, `${DRIVEN} ${DRIVES}`);

// kg with its meta engineer lifted out: the persona, llama and codex, nothing `all` and nothing
// pinned. Sliced by NAME rather than by line number so it follows the fixture above.
const WREN_AT = KG_LINES.indexOf('  wren:') - 1;                                              // the comment line above it
const AFTER_WREN = KG_LINES.indexOf(`      allowed_users: ${OPERATOR} ${DRIVES}`) + 2;        // past its trailing blank line
const NO_ENGINEER = crlf([...KG_LINES.slice(0, WREN_AT), ...KG_LINES.slice(AFTER_WREN)]);

// do with dren's pin lifted: `dren` and `djh` are both `all`, and now NEITHER is pinned. Nothing
// here is a meta engineer, and that is a note - never a refusal over two unpinned beings.
const DO_UNPINNED = DO.replace('    scope: agent/dren # one agent/dren node-wide\r\n', '');
// The one line that names every unsandboxed being this migration does NOT give the mouth.
const LEFT_ALONE = (n, handles) => `agents.${n} (answers to ${handles}) is \`access_level: all\` too but carries no \`scope:\` pin, so it is not this node's meta engineer and is left alone`;

// The two type files the `configuration:` lines name. Neither pins a `cwd:`, so 0014 has nothing
// to move and reads satisfied (it returns before it ever looks for an identity file).
const TYPES = {
  'sonnet-default': 'type: ccode\nmodel: sonnet\neffort: high\n',
  'sonnet-high': 'type: ccode\nmodel: sonnet\neffort: high\n',
  'haiku-low': 'type: ccode\nmodel: haiku\neffort: low\n',
};
const IDENTITIES = { wren: '# I am Wren\n', dren: '# I am Dren\n' };

function home(config = KG) {
  // `.egpt` nested inside the temp dir, so `<parent>/src` does not exist and 0015 stays satisfied.
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0021-')), '.egpt');
  mkdirSync(join(h, 'config', 'agents', 'identities'), { recursive: true });
  if (config !== null) writeFileSync(join(h, 'config', 'config.yaml'), config);
  for (const [name, text] of Object.entries(TYPES)) writeFileSync(join(h, 'config', 'agents', `${name}.yaml`), text);
  for (const [name, text] of Object.entries(IDENTITIES)) writeFileSync(join(h, 'config', 'agents', 'identities', `${name}.md`), text);
  return h;
}
const doHome = () => home(DO);
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0021-test`; writeFileSync(to, readFileSync(f)); return to; } });
const baks = (h) => readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'));
const users = (h, being) => YAML.parse(readFileSync(cfgPath(h), 'utf8')).agents[being].conversation_defaults.allowed_users;

describe('0021 on kg - the mouth may drive wren', () => {
  it('plans exactly one changed line, and says whose and why', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${KG_USERS_LINE}`,
      `  -       allowed_users: ${OPERATOR} ${DRIVES}`,
      `  +       allowed_users: ${DRIVEN} ${DRIVES}`,
      'agents.wren (answers to `wren`/`w`) is this node\'s meta engineer - the `access_level: all` being pinned node-wide to `agent/wren` - '
        + `and ${MOUTH}, the mouth, may drive it from here on; the 3 ids already there keep theirs`,
      'backup first, beside it: <file>.bak-0021-<timestamp>',
    ]);
  });

  it('apply: wren gains the id, keeps its three, and every other byte - comments included - is untouched', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_AFTER);
    expect(users(h, 'wren')).toEqual(['16468217865', '34836563681438', '@anrodriguez:beeper.com', MOUTH]);
    expect(readFileSync(cfgPath(h), 'utf8')).toContain(`${DRIVEN} ${DRIVES}\r\n`);
    expect(readFileSync(`${cfgPath(h)}.bak-0021-test`, 'utf8')).toBe(KG);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('the SANDBOXED persona keeps its list, though its line reads byte-for-byte the same', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    expect(users(h, 'egpt')).toEqual(['16468217865', '34836563681438', '@anrodriguez:beeper.com']);
    expect(users(h, 'egpt')).not.toContain(MOUTH);
    expect(readFileSync(cfgPath(h), 'utf8')).toContain(`      allowed_users: ${OPERATOR} # who may wake E\r\n`);
    // Every other being is left exactly as it was.
    const cfg = YAML.parse(readFileSync(cfgPath(h), 'utf8'));
    expect(Object.keys(cfg.agents)).toEqual(['egpt', 'wren', 'llama', 'codex']);
    expect(cfg.agents.codex).toEqual({ configuration: 'codex', handles: ['codex'] });
    expect(cfg.agents.wren.handles).toEqual(['wren', 'w']);
    expect(cfg.agents.wren.scope).toBe('agent/wren');
  });

  // kg's `eplus` really does end its list with a bare unquoted `operator` (measured 2026-09-22).
  // The splice could not append `@dolly-egpt:beeper.com` to a plain-scalar list - and never has to,
  // because a being that is not the meta engineer is never visited at all.
  it('a BARE-scalar allowed_users on a non-qualifying being is never visited, let alone refused', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);          // no refusal, though llama's list could not be spliced
    await p.apply();
    expect(users(h, 'llama')).toEqual(['16468217865', 'operator']);
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('      allowed_users: [ "16468217865", operator ]\r\n');
  });

  it('the meta engineer is found by its ACCESS LEVEL, never by the map key', async () => {
    // The SANDBOXED persona takes the key `wren`; the meta engineer is keyed `meta` and keeps its
    // handles. A key-based lookup would hand the mouth authority over the sandboxed being.
    const decoy = KG.replace('  egpt:\r\n', '  wren:\r\n').replace('  wren:\r\n    configuration: sonnet-high', '  meta:\r\n    configuration: sonnet-high');
    const h = home(decoy);
    const p = await plan(ctxFor(h));
    expect(p.changes[3]).toContain('agents.meta (answers to `wren`/`w`)');
    await p.apply();
    expect(users(h, 'meta')).toContain(MOUTH);
    expect(users(h, 'wren')).not.toContain(MOUTH);
  });
});

describe('0021 on do - dren gains it, and the worker that answers to `rodz` does not', () => {
  it('plans exactly one changed line, dren\'s', async () => {
    const h = doHome();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:${DO_USERS_LINE}`,
      `  -       allowed_users: ${OPERATOR} ${DRIVES}`,
      `  +       allowed_users: ${DRIVEN} ${DRIVES}`,
      'agents.dren (answers to `dren`) is this node\'s meta engineer - the `access_level: all` being pinned node-wide to `agent/dren` - '
        + `and ${MOUTH}, the mouth, may drive it from here on; the 3 ids already there keep theirs`,
      LEFT_ALONE('djh', '`djh`'),
      'backup first, beside it: <file>.bak-0021-<timestamp>',
    ]);
  });

  it('apply: dren gains the id and the file is otherwise byte-identical', async () => {
    const h = doHome();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO_AFTER);
    expect(users(h, 'dren')).toEqual(['16468217865', '34836563681438', '@anrodriguez:beeper.com', MOUTH]);
    expect(readFileSync(`${cfgPath(h)}.bak-0021-test`, 'utf8')).toBe(DO);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  // THE `rodz` TRAP. `rodz` is a HANDLE do's worker answers to since 0020; `@dolly-egpt:beeper.com`
  // is an ACCOUNT ID. A migration written against a handle list would have put the mouth's
  // authority on the worker - the `regular` being - instead of on the meta engineer.
  it('`don` answers to the handle `rodz` and still gains NOTHING - a handle is not an id', async () => {
    const h = doHome();
    expect(YAML.parse(DO).agents.don.handles).toContain('rodz');
    await (await plan(ctxFor(h))).apply();
    expect(users(h, 'don')).toEqual(['16468217865', '34836563681438', '@anrodriguez:beeper.com']);
    expect(users(h, 'don')).not.toContain(MOUTH);
    expect(readFileSync(cfgPath(h), 'utf8')).toContain(`      allowed_users: ${OPERATOR} # who may wake the worker\r\n`);
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('    handles: [ d, don, rodz ] # the worker, addressed either way\r\n');
  });

  // THE do REGRESSION. Two `access_level: all` beings on one node, only one of them pinned. A
  // level-only predicate reads that as ambiguous and REFUSES - which stops every later migration
  // on the one node this ruling is most about. It must apply, and djh must be visible and untouched.
  it('two `all` beings, one pinned: it APPLIES, and the unpinned one is named and left alone', async () => {
    const h = doHome();
    const cfg = YAML.parse(DO);
    expect(cfg.agents.dren.conversation_defaults.access_level).toBe('all');
    expect(cfg.agents.djh.conversation_defaults.access_level).toBe('all');   // both unsandboxed
    expect(cfg.agents.dren.scope).toBe('agent/dren');
    expect(Object.hasOwn(cfg.agents.djh, 'scope')).toBe(false);              // only one is pinned

    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);                                        // NEVER a refusal
    expect(p.changes).toContain(LEFT_ALONE('djh', '`djh`'));
    await p.apply();
    expect(users(h, 'dren')).toContain(MOUTH);
    expect(users(h, 'djh')).toEqual(['16468217865']);
    expect(users(h, 'djh')).not.toContain(MOUTH);
    expect(readFileSync(cfgPath(h), 'utf8')).toContain('      allowed_users: [ "16468217865" ] # who may wake the radio\r\n');
  });

  it('the unpinned `all` being is still named once the change is settled', async () => {
    const h = home(DO_AFTER);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `agents.dren (answers to \`dren\`) is this node's meta engineer and its allowed_users already lists ${MOUTH}`,
      LEFT_ALONE('djh', '`djh`'),
    ]);
  });
});

describe('0021: "nothing to do here" is a note, never a refusal', () => {
  it('already applied: satisfied, naming the being, and nothing is written', async () => {
    const h = home(KG_AFTER);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([`agents.wren (answers to \`wren\`/\`w\`) is this node's meta engineer and its allowed_users already lists ${MOUTH}`]);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(KG_AFTER);
    expect(baks(h)).toEqual([]);
  });

  it('a list already carrying the explicit `*` wildcard permits the mouth already', async () => {
    const wild = KG.replace(`${OPERATOR} ${DRIVES}`, `[ "*" ] ${DRIVES}`);
    const h = home(wild);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toContain('already reads ["*"] - the explicit wildcard permits anyone, the mouth included');
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(wild);
  });

  it('a node with no `access_level: all` being at all', async () => {
    const h = home(NO_ENGINEER);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([`no being in ${cfgPath(h)} is \`conversation_defaults.access_level: all\` AND pinned node-wide with \`scope:\`, so this node has no meta engineer for the mouth to drive`]);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(NO_ENGINEER);
  });

  it('a node whose `all` beings are NONE of them pinned: satisfied, and both are named', async () => {
    const h = home(DO_UNPINNED);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toEqual([
      `no being in ${cfgPath(h)} is \`conversation_defaults.access_level: all\` AND pinned node-wide with \`scope:\`, so this node has no meta engineer for the mouth to drive`,
      LEFT_ALONE('dren', '`dren`'),
      LEFT_ALONE('djh', '`djh`'),
    ]);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(DO_UNPINNED);
    expect(baks(h)).toEqual([]);
  });

  it('a node with no `agents:` mapping at all', async () => {
    const h = home('node_name: zz\n');
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes[0]).toContain('has no `agents:` mapping');
  });
});

describe('0021 refuses, naming the place, only on what it cannot honestly edit', () => {
  // The genuinely ambiguous shape, and the ONLY one that still refuses over a count: two beings
  // that are each unsandboxed AND pinned node-wide. do's `dren`/`djh` pair is not this - the node
  // itself already says which of the two is the engineer.
  it('TWO PINNED `all` beings - which one the mouth drives is a human decision', async () => {
    const two = KG.replace('      access_level: sandbox', '      access_level: all').replace('    default: true', '    default: true\r\n    scope: agent/egpt');
    const h = home(two);
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0021 refuses: 2 beings in .* are `access_level: all` AND pinned node-wide with `scope:` \(agents\.egpt \(answers to `e`\/`egpt`\/`ekg`\) pinned to `agent\/egpt`, agents\.wren \(answers to `wren`\/`w`\) pinned to `agent\/wren`\) - which one the mouth drives is a human decision, not a guess/,
    );
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(two);
  });

  it('two `all` beings of which only one is pinned is NOT that case - it applies', async () => {
    const two = KG.replace('      access_level: sandbox', '      access_level: all');   // egpt: `all`, no `scope:`
    const h = home(two);
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toContain(LEFT_ALONE('egpt', '`e`/`egpt`/`ekg`'));
  });

  it('an `allowed_users` that is ABSENT - there is no list here, and where one belongs is a guess', async () => {
    const none = KG.replace(`      allowed_users: ${OPERATOR} ${DRIVES}\r\n`, '');
    const h = home(none);
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0021 refuses: agents\.wren \(answers to `wren`\/`w`\) is this node's meta engineer and its `conversation_defaults:` in .* has no `allowed_users`/,
    );
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(none);
  });

  it('an `allowed_users` that is not a list at all', async () => {
    const scalar = KG.replace(`      allowed_users: ${OPERATOR} ${DRIVES}`, `      allowed_users: "${MOUTH}"`);
    const h = home(scalar);
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0021 refuses: `allowed_users` in agents\.wren\.conversation_defaults is "@dolly-egpt:beeper\.com" - an `all` being with an empty or non-list allowed_users is refused a turn by brainpool\.mjs/,
    );
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(scalar);
  });

  it('an EMPTY `allowed_users` - somebody wrote a list and put nobody on it', async () => {
    const empty = KG.replace(`${OPERATOR} ${DRIVES}`, `[] ${DRIVES}`);
    const h = home(empty);
    await expect(plan(ctxFor(h))).rejects.toThrow(/0021 refuses: `allowed_users` in agents\.wren\.conversation_defaults is \[\]/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(empty);
  });

  it('a BLOCK list - a shape this splice does not write', async () => {
    const block = KG.replace(`      allowed_users: ${OPERATOR} ${DRIVES}`, '      allowed_users:\r\n        - "16468217865"\r\n        - "@anrodriguez:beeper.com"');
    const h = home(block);
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0021 refuses: `allowed_users:` in agents\.wren\.conversation_defaults cannot take @dolly-egpt:beeper\.com \(refusing to edit agents\.wren\.conversation_defaults\.allowed_users: it is a block list; only an inline flow list is appended to\)/,
    );
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(block);
  });

  // `@` is a YAML RESERVED INDICATOR: the id can only be written quoted, and the splice renders a
  // new item in the style of the one before it. Every id in a live list is quoted (a bare phone
  // number would read as an integer), but a list whose last item were PLAIN is caught by the
  // splice's own re-parse and refused by name - never written as YAML that no longer loads.
  it('a list whose last item is a PLAIN scalar is refused, not written broken', async () => {
    const plain = KG.replace(`      allowed_users: ${OPERATOR} ${DRIVES}`, `      allowed_users: [ anrodriguez ] ${DRIVES}`);
    const h = home(plain);
    await expect(plan(ctxFor(h))).rejects
      .toThrow(/0021 refuses: `allowed_users:` in agents\.wren\.conversation_defaults cannot take @dolly-egpt:beeper\.com [\s\S]*the edited text no longer parses [\s\S]*reserved character @/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(plain);
  });

  it('a config.yaml that does not parse, and one that is not there', async () => {
    const broken = home('agents: [ broken\n');
    await expect(plan(ctxFor(broken))).rejects.toThrow(/0021 refuses: .*config\.yaml does not parse/);
    const none = home(null);
    await expect(plan(ctxFor(none))).rejects.toThrow(/0021 refuses: there is no .*config\.yaml/);
  });

  it('a file edited between plan and apply, and nothing is written', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = KG.replace('node_name: kg', 'node_name: kg-two');
    writeFileSync(cfgPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0021 refuses: .*config\.yaml changed since it was planned - re-run/);
    expect(readFileSync(cfgPath(h), 'utf8')).toBe(edited);
    expect(baks(h)).toEqual([]);
  });
});

describe('0021 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", and localAddresses is
  // empty so 0007 reads nothing as this node's own (as tests/migrations-0008-*).
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
  const ledgerOf = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));

  it('kg: applied and recorded, one line changed and one backup beside it', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)['0021-the-mouth-can-drive'].outcome).toBe('applied');
    expect(upTo0024(h)).toBe(KG_AFTER);
    expect(readdirSync(join(h, 'config')).filter((f) => f.startsWith('config.yaml.bak-0021-'))).toHaveLength(1);
  });

  it('do: applied and recorded; dren has it, don does not', async () => {
    const h = doHome();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)['0021-the-mouth-can-drive'].outcome).toBe('applied');
    expect(upTo0024(h)).toBe(DO_AFTER);   // byte-identical but dren's one line
    expect(users(h, 'don')).not.toContain(MOUTH);
    expect(users(h, 'djh')).not.toContain(MOUTH);              // unsandboxed, unpinned, untouched
  });

  it('a node with no meta engineer converges too, recorded as already-satisfied', async () => {
    const h = home(NO_ENGINEER);
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)['0021-the-mouth-can-drive'].outcome).toBe('already-satisfied');
    expect(upTo0024(h)).toBe(NO_ENGINEER);
  });

  it('EVERY earlier migration reads satisfied on both fixtures - one that acted would invalidate these', async () => {
    for (const h of [home(), doHome()]) {
      await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {} });
      const earlier = Object.entries(ledgerOf(h)).filter(([id]) => id < '0021');
      expect(earlier.length).toBeGreaterThanOrEqual(20);
      expect(earlier.filter(([, e]) => e.outcome !== 'already-satisfied')).toEqual([]);
      // One backup in the whole chain up to this migration, and it is this migration's: nothing
      // EARLIER wrote a file. 0025 runs after it and its own suite asserts what it writes.
      expect(baks(h).filter((f) => !f.includes('.bak-0025-')).map((f) => f.replace(/\d{8}T\d{6}$/, '<stamp>')))
        .toEqual(['config.yaml.bak-0021-<stamp>']);
    }
  });
});
