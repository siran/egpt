// A type file's own top-level allowed_tools can only NARROW its access level's grant (2026-10-15,
// edw-marketer: a boxed lead session with exactly Read/Grep/Glob/WebFetch/WebSearch). The
// narrowed list reaches the CLI as --tools, so unlisted tools do not exist even under the
// sandboxed bypass. A type that declares no list keeps the 2026-09-23 default (a boxed being gets
// every tool). Real brains registry + real config/permissions/*.md; a fake warm pool.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrainPool } from '../src/spine/brainpool.mjs';
import { createBrains } from '../src/spine/brains.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { loadPermissionLevel } from '../src/spine/permission-levels.mjs';
import { buildClaudeArgs } from '../src/claude-args.mjs';
import { emptyState } from '../src/conversations-state.mjs';

// The live kg type files these beings run on (C:/Users/an/.egpt/config/agents, 2026-10-15).
const TYPES = {
  'opus-default': 'type: ccode\nmodel: opus\neffort: high\nverbose_thinking: false\nallowed_paths:\n  C:/Users/an/src/egpt:\n    allowed_tools: [ Read, Glob, Grep ]\n',
  'opus-xhigh': 'type: ccode\nmodel: opus\neffort: xhigh\nallowed_paths:\n  C:/Users/an/src/egpt:\n    allowed_tools: [ Read, Glob, Grep ]\n',
  wren: 'type: ccode\nmodel: opus\neffort: xhigh\nverbose_thinking: false\npersonality: wren\ncwd: C:/Users/an/wren-cwd\n',
  'edw-marketer': 'type: ccode\nmodel: sonnet\neffort: medium\npersonality: edw-marketer\nallowed_tools: [ Read, Grep, Glob, WebFetch, WebSearch ]\n',
  pi: 'type: pi\nmodel: local/gemma\npersonality: egpt\nallowed_tools: [read, grep, find, ls, edit, write, bash]\n',
};
const AGENTS = {
  egpt: { configuration: 'opus-default', default: true, conversation_defaults: { access_level: 'sandbox' } },
  ken: { configuration: 'opus-xhigh', conversation_defaults: { access_level: 'sandbox' } },
  wren: { configuration: 'wren', conversation_defaults: { access_level: 'all', sandboxed: false, allowed_users: ['*'] } },
  'edw-marketer': { configuration: 'edw-marketer', conversation_defaults: { access_level: 'regular', sandboxed: true } },
  pi: { configuration: 'pi', conversation_defaults: { access_level: 'sandbox', sandboxed: true } },
};
const EV = { surface: 'whatsapp', chatId: '!lead:beeper.com', chatName: 'Lead', line: 'Bea@[Lead].wa (14:05) #m1: hola', body: 'hola' };

async function optionsFor(being, agents = AGENTS, types = TYPES) {
  const dir = mkdtempSync(join(tmpdir(), 'egpt-narrow-'));
  for (const [name, text] of Object.entries(types)) writeFileSync(join(dir, `${name}.yaml`), text);
  let state = emptyState();
  const calls = [];
  const pool = { run: async (key, message, onPartial, opts) => { calls.push(opts.brainOptions); return { text: 'ok', sessionId: 'sid-1' }; }, steer: async () => false, evict() {} };
  const loadState = async () => state;
  const writeState = async (s) => { state = s; };
  const brain = createBrainPool({
    pool,
    getConfig: () => ({ agents }),
    contacts: createContacts({ loadState, writeState, io: { mkdir: async () => {} } }),
    loadState, writeState,
    io: { mkdir: async () => {}, readFile: async () => null, writeFile: async () => {} },
    resolveConfig: () => ({}),
    loadFeed: async () => '', loadManifest: async () => '',
    seedLayers: async () => {}, writeCard: async () => {},
    brains: createBrains({ builtinDir: join(dir, 'no-builtin'), agentsDir: dir }),
    loadPermission: loadPermissionLevel,
    defaultKey: 'egpt',
    platform: 'win32',
  });
  await brain.turn(being, EV);
  const opts = calls[0];
  // Drop the per-run temp conversation folder so the argv compares across runs.
  return { opts, argv: buildClaudeArgs({ ...opts, cwd: undefined }).map((a) => a.split(opts.cwd).join('<cwd>')) };
}

describe('regression locks — E, ken and wren run exactly as before (no top-level list in their types)', () => {
  it('E (opus-default, sandbox): argv byte-identical', async () => {
    const { argv } = await optionsFor('egpt');
    expect(argv).toEqual(SNAP.egpt);
  });
  it('ken (opus-xhigh, sandbox): argv byte-identical', async () => {
    const { argv } = await optionsFor('ken');
    expect(argv).toEqual(SNAP.ken);
  });
  it('wren (wren, all, unboxed): argv byte-identical', async () => {
    const { argv } = await optionsFor('wren');
    expect(argv).toEqual(SNAP.wren);
  });
});

// Captured from the code BEFORE the narrowing change (main 985f80c) — the lock is that it never moves.
const BOXED = (effort) => ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--allowedTools', 'Read Write Edit Glob Grep Bash Agent WebSearch WebFetch', '--model', 'opus', '--effort', effort, '--settings', '{"cleanupPeriodDays":3650000}'];
const SNAP = { egpt: BOXED('high'), ken: BOXED('xhigh'), wren: BOXED('xhigh') };

const FIVE = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

describe('a ccode type that declares allowed_tools narrows its level to that list, via --tools', () => {
  it('edw-marketer, boxed (regular + sandboxed: true): exactly the 5 tools, as --tools, under the bypass', async () => {
    const { opts, argv } = await optionsFor('edw-marketer');
    expect(opts.sandboxed).toBe(true);
    expect(opts.allowedTools).toEqual(FIVE);
    expect(opts.tools).toEqual(FIVE);
    expect(argv).toEqual(['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--tools', 'Read,Grep,Glob,WebFetch,WebSearch', '--model', 'sonnet', '--effort', 'medium', '--settings', '{"cleanupPeriodDays":3650000}']);
  });

  it('edw-marketer at access_level sandbox narrows the same way (the level adds Bash/Agent; the type drops them)', async () => {
    const { opts, argv } = await optionsFor('edw-marketer', { ...AGENTS, 'edw-marketer': { configuration: 'edw-marketer', conversation_defaults: { access_level: 'sandbox' } } });
    expect(opts.allowedTools).toEqual(FIVE);
    expect(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2)).toEqual(['--tools', 'Read,Grep,Glob,WebFetch,WebSearch']);
    expect(argv.join(' ')).not.toMatch(/Bash|Agent|Write|Edit/);
  });

  it('it can only narrow: a tool the level does not grant stays out', async () => {
    const { opts } = await optionsFor('edw-marketer', AGENTS, { ...TYPES, 'edw-marketer': 'type: ccode\nmodel: sonnet\nallowed_tools: [ Read, Bash, Agent ]\n' });
    expect(opts.allowedTools).toEqual(['Read']);   // regular grants no Bash/Agent; the type cannot add them
    expect(opts.tools).toEqual(['Read']);
  });

  // djhaiku states no effort: since 2026-10-22 every ccode being runs a concrete one (DETERMINISTIC_EFFORT).
  it('REGRESSION (dolly djh): a scoped entry `Bash(curl:*)` admits its base tool, so the DJ keeps Bash', async () => {
    const types = { ...TYPES, djhaiku: 'type: ccode\nmodel: haiku\nallowed_tools: [ Read, Bash(curl:*) ]\n' };
    const agents = { ...AGENTS, djh: { configuration: 'djhaiku', conversation_defaults: { access_level: 'all', allowed_users: ['*'] } } };
    const { opts, argv } = await optionsFor('djh', agents, types);
    expect(opts.allowedTools).toEqual(['Read', 'Bash(curl:*)']);
    expect(opts.tools).toEqual(['Read', 'Bash']);
    expect(argv).toEqual(['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--tools', 'Read,Bash', '--allowedTools', 'Read Bash(curl:*)', '--model', 'haiku', '--effort', 'high', '--settings', '{"cleanupPeriodDays":3650000}']);
  });

  it('two scoped entries of one tool name it once in --tools', async () => {
    const types = { ...TYPES, 'edw-marketer': 'type: ccode\nmodel: sonnet\nallowed_tools: [ Read, Bash(git:*), Bash(curl:*) ]\n' };
    const { opts } = await optionsFor('edw-marketer', { ...AGENTS, 'edw-marketer': { configuration: 'edw-marketer', conversation_defaults: { access_level: 'sandbox' } } }, types);
    expect(opts.tools).toEqual(['Read', 'Bash']);
  });

  it('a non-ccode type (pi, its own tool names) is untouched: the level list, no --tools', async () => {
    const { opts } = await optionsFor('pi');
    expect(opts.allowedTools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Agent', 'WebSearch', 'WebFetch']);
    expect(opts.tools).toBeUndefined();
  });

  it('a type with no list gets no tools field at all (the boxed default: every tool)', async () => {
    for (const being of ['egpt', 'ken', 'wren']) expect((await optionsFor(being)).opts.tools).toBeUndefined();
  });
});

describe('buildClaudeArgs — tools: <list> → --tools, in every permission tier', () => {
  const base = { allowedTools: FIVE, tools: FIVE };
  const at = (argv) => argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2);
  it('osConfined (sandboxed bypass), dangerouslySkipPermissions, CLI-confined and plain', () => {
    for (const o of [{ osConfined: true }, { dangerouslySkipPermissions: true }, { confineToDirs: ['C:/x'] }, {}]) {
      expect(at(buildClaudeArgs({ ...base, ...o }))).toEqual(['--tools', 'Read,Grep,Glob,WebFetch,WebSearch']);
    }
  });
  it('an empty narrowed list is "" (no tools), and no tools option adds nothing', () => {
    expect(at(buildClaudeArgs({ allowedTools: [], tools: [] }))).toEqual(['--tools', '']);
    expect(buildClaudeArgs({ allowedTools: FIVE })).not.toContain('--tools');
  });
});
