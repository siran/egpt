// access_level `reader` (plans/2610261726-CHATBOXES.md, phase 1 step 3): a public chatbox being
// reads its own conversation folder (its desk) and nothing else — Read/Glob/Grep only, no grant
// beyond the folder, no internal cards, no MCP, no browser link. Real brains registry and real
// config/permissions/*.md; a fake warm pool.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createBrainPool } from '../src/spine/brainpool.mjs';
import { createBrains } from '../src/spine/brains.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { loadPermissionLevel, isAccessLevel, ACCESS_LEVELS } from '../src/spine/permission-levels.mjs';
import { buildClaudeArgs } from '../src/claude-args.mjs';
import { emptyState, ensureContact, patchBeing, readIdentityFeed, seedIdentityLayers } from '../src/conversations-state.mjs';
import { Room } from '../src/room-core.mjs';

const EV = { surface: 'http', chatId: 'edw-s1', chatName: 'visitor', line: 'V@[visitor].http (14:05) #m1: hola', body: 'hola' };
// A type that carries its own read grant and pins a workspace — both must be ignored for a reader.
const TYPE = 'type: ccode\nmodel: haiku\neffort: high\npersonality: egpt\nallowed_paths:\n  C:/Users/an/src/egpt:\n    allowed_tools: [ Read, Glob, Grep ]\n';
// The node's global read grants: 0015's node allowed_paths and 0034's global_read_paths.
const NODE = {
  node_name: 'kg',
  allowed_paths: { 'C:/Users/an/src': { allowed_tools: ['Read', 'Glob', 'Grep'] } },
  global_read_paths: [{ repos: 'C:/Users/an/src/siran' }],
};
// ...and a /fork-style grant on this conversation's own block.
const CONV_PATHS = { 'C:/Users/an/.egpt/conversations/whatsapp/other': { allowed_tools: ['Read', 'Glob', 'Grep'] } };
const FEED_CFG = { agent_name: 'Fixture', node_name: 'kg', chrome: { bin: 'C:/fixture/chrome.exe', profile_dir: 'C:/fixture/profile' } };

async function turnFor(level, { platform = 'win32', type = TYPE, conv = {}, cd = {}, loadFeed, loadPermission = loadPermissionLevel } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'egpt-reader-'));
  writeFileSync(join(dir, 'mk.yaml'), type);
  const config = { ...NODE, agents: { mk: { configuration: 'mk', conversation_defaults: { access_level: level, allowed_users: ['*'], ...cd } } } };
  let state = ensureContact(emptyState(), EV.surface, EV.chatId, { pushedName: EV.chatName, slugHint: EV.chatName }).state;
  state = patchBeing(state, EV.surface, EV.chatId, 'mk', { allowed_paths: CONV_PATHS, ...conv });
  const calls = [], seeds = [], cards = [], logs = [];
  const pool = { run: async (key, message, onPartial, opts) => { calls.push({ message, opts: opts.brainOptions }); return { text: 'ok', sessionId: 'sid-1' }; }, steer: async () => false, evict() {} };
  const loadState = async () => state;
  const writeState = async (s) => { state = s; };
  const brain = createBrainPool({
    pool, getConfig: () => config,
    contacts: createContacts({ loadState, writeState, io: { mkdir: async () => {} } }),
    loadState, writeState,
    io: { mkdir: async () => {}, readFile: async () => null, writeFile: async () => {} },
    resolveConfig: () => ({}),
    loadFeed: loadFeed ?? (async () => 'FEED'), loadManifest: async () => '',
    labelOf: () => 'Fixture',
    seedLayers: async (room, name, o) => { seeds.push(o); }, writeCard: async () => { cards.push(1); },
    brains: createBrains({ builtinDir: join(dir, 'no-builtin'), agentsDir: dir }),
    loadPermission,
    beingLink: { forBeing: () => ({ mint: () => null }) },
    onLog: (l) => logs.push(l),
    defaultKey: 'mk', platform,
  });
  await brain.turn('mk', EV);
  const { message, opts } = calls[0];
  const argv = buildClaudeArgs({ ...opts, cwd: undefined }).map((a) => a.split(opts.cwd).join('<cwd>'));
  return { opts, argv, message, seeds, cards: cards.length, logs };
}

const READER_ARGV = [
  '--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--tools', 'Read,Glob,Grep', '--strict-mcp-config',
  '--setting-sources', '', '--permission-mode', 'default',
  '--model', 'haiku', '--effort', 'high',
  '--add-dir', '<cwd>',
  '--settings', '{"cleanupPeriodDays":3650000}',
];

describe('reader is a fourth access level', () => {
  it('REPRODUCE: it is a level, its file parses, and it is confined (no skip-permissions)', () => {
    expect(ACCESS_LEVELS).toContain('reader');
    expect(isAccessLevel('reader')).toBe(true);
    expect(loadPermissionLevel('reader')).toEqual({ dangerouslySkipPermissions: false, allowedTools: ['Read', 'Glob', 'Grep'] });
  });
});

describe('the CLI args a reader being gets', () => {
  for (const platform of ['win32', 'linux']) {
    it(`REPRODUCE (${platform}): only Read/Glob/Grep, confined to its own folder, no extra --add-dir though the node grants global read paths`, async () => {
      const { opts, argv } = await turnFor('reader', { platform });
      expect(argv).toEqual(READER_ARGV);
      expect(opts.sandboxed).toBe(false);
      expect(opts.confineToDirs).toEqual([opts.cwd]);
      expect(opts.addDirs).toBeUndefined();
      expect(opts.readOnlyDirs).toBeUndefined();
      expect(opts.sandboxSharePaths).toBeUndefined();
      expect(opts.sandboxSharePathsReadOnly).toBeUndefined();
      expect(opts.sandboxReadMounts).toBeUndefined();
      expect(opts.beingLink).toBeUndefined();   // no browser credential
    });
  }

  it('Bash, WebFetch, Write and Task are absent: not in --tools (unlisted built-ins do not exist), nothing pre-approved, no bypass', async () => {
    const { opts, argv } = await turnFor('reader');
    expect(opts.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(argv).not.toContain('--allowedTools');
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv.join(' ')).not.toMatch(/Bash|WebFetch|WebSearch|Write|Edit|Task|Agent/);
  });

  it('a pinned workspace is ignored: cwd is the conversation folder', async () => {
    const { opts } = await turnFor('reader', { type: `${TYPE}cwd: C:/Users/an/elsewhere\n` });
    expect(opts.cwd).not.toMatch(/elsewhere/);
    expect(basename(opts.cwd)).toMatch(/visitor/);
  });

  it('a type that declares its own list can only narrow it: [Read, WebFetch, Bash] → Read', async () => {
    const { opts, argv } = await turnFor('reader', { type: `${TYPE}allowed_tools: [ Read, WebFetch, Bash ]\n` });
    expect(opts.tools).toEqual(['Read']);
    expect(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2)).toEqual(['--tools', 'Read']);
  });

  it('an explicit sandboxed: true does not box it (the box drops the CLI gate and mounts src/repos) — and the dead line is logged', async () => {
    const { opts, argv, logs } = await turnFor('reader', { conv: { sandboxed: true } });
    expect(opts.sandboxed).toBe(false);
    expect(argv).toEqual(READER_ARGV);
    expect(logs.join('\n')).toMatch(/reader.*sandboxed: true is dead config/);
  });

  it('fails closed: no reader.md → the turn is refused, never run on the type\'s own tools', async () => {
    await expect(turnFor('reader', { loadPermission: () => null })).rejects.toThrow(/reader/);
  });

  it('fails closed: a non-ccode engine (no --tools to hold it) is refused', async () => {
    await expect(turnFor('reader', { type: 'type: pi\nmodel: local/gemma\n' })).rejects.toThrow(/reader/);
  });
});

describe('the reader feed: its identity plus only the layers that name nothing internal', () => {
  it('readIdentityFeed(publicOnly) keeps the identity, actions and rules, and drops 30-pointers', async () => {
    const feed = await readIdentityFeed('egpt', FEED_CFG, { publicOnly: true });
    expect(feed).toMatch(/^# I am Fixture/);
    expect(feed).toMatch(/# Actions/);
    expect(feed).toMatch(/# RULES/);
    expect(feed).not.toMatch(/# Pointers|EGPT_ASK_SPINE|chrome|~\/src/);
  });

  it('the reader kickoff carries the identity and not 30-pointers', async () => {
    const { message } = await turnFor('reader', { loadFeed: readIdentityFeed });
    expect(message).toMatch(/I am an eGPT instance named Fixture/);
    expect(message).toMatch(/# Actions/);
    expect(message).not.toMatch(/# Pointers|EGPT_ASK_SPINE/);
  });

  it('its directives/ copy is the same set, and a 30-pointers.md filed earlier is removed', async () => {
    const wrote = [], removed = [];
    const io = {
      mkdir: async () => {},
      readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      writeFile: async (p) => { wrote.push(basename(p)); },
      unlink: async (p) => { removed.push(basename(p)); },
    };
    expect(await seedIdentityLayers(Room.forChat('http', 'reader-desk'), 'egpt', { io, publicOnly: true })).toEqual(['10-actions.md', '40-rules.md']);
    expect(wrote).toEqual(['10-actions.md', '40-rules.md']);
    expect(removed).toEqual(['30-pointers.md']);
  });

  it('a reader turn seeds publicOnly and writes no config card (it names node, handles, allowed_users)', async () => {
    const { seeds, cards } = await turnFor('reader');
    expect(seeds[0].publicOnly).toBe(true);
    expect(cards).toBe(0);
  });
});

// Captured from the code BEFORE `reader` existed (origin/main 47adf391), same fixture: the lock is
// that regular/all/sandbox never move — except --strict-mcp-config, on every level since 2026-10-26.
const HEAD = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
const NO_MCP = ['--strict-mcp-config'];
const BYPASS = ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions'];
const TAIL = ['--model', 'haiku', '--effort', 'high'];
const SETTINGS = ['--settings', '{"cleanupPeriodDays":3650000}'];
const ALL_TOOLS = ['--allowedTools', 'Read Write Edit Glob Grep Bash Agent WebSearch WebFetch'];
const RO = ['C:/Users/an/src/egpt', 'C:/Users/an/src', 'C:/Users/an/.egpt/conversations/whatsapp/other'];
const deny = (d) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map((t) => `${t}(${d}/**)`);
const SNAP = {
  'regular/win32': { argv: [...HEAD, ...BYPASS, ...NO_MCP, ...TAIL, ...SETTINGS], boxed: true },
  'regular/linux': {
    argv: [...HEAD, ...NO_MCP, '--setting-sources', '', '--permission-mode', 'default', '--allowedTools', 'WebSearch WebFetch Task', ...TAIL,
      '--add-dir', '<cwd>', ...RO.flatMap((d) => ['--add-dir', d]),
      '--settings', JSON.stringify({ cleanupPeriodDays: 3650000, permissions: { deny: RO.flatMap(deny) } })],
    boxed: false,
  },
  'all/win32': { argv: [...HEAD, ...BYPASS, ...NO_MCP, ...ALL_TOOLS, ...TAIL, ...SETTINGS], boxed: true },
  'all/linux': { argv: [...HEAD, ...BYPASS, ...NO_MCP, ...ALL_TOOLS, ...TAIL, ...SETTINGS], boxed: false },
  'sandbox/win32': { argv: [...HEAD, ...BYPASS, ...NO_MCP, ...ALL_TOOLS, ...TAIL, ...SETTINGS], boxed: true },
  'sandbox/linux': { argv: [...HEAD, ...BYPASS, ...NO_MCP, ...ALL_TOOLS, ...TAIL, ...SETTINGS], boxed: true },
};

describe('regression lock — regular, all and sandbox run exactly as before, plus --strict-mcp-config', () => {
  for (const [key, snap] of Object.entries(SNAP)) {
    const [level, platform] = key.split('/');
    it(`${key}: argv, box, grants, browser link, card and full feed unchanged`, async () => {
      const { opts, argv, message, seeds, cards } = await turnFor(level, { platform, loadFeed: readIdentityFeed });
      expect(argv).toEqual(snap.argv);
      expect(opts.sandboxed).toBe(snap.boxed);
      expect(opts.tools).toBeUndefined();
      expect(opts.sandboxSharePathsReadOnly).toEqual(snap.boxed ? RO : undefined);
      expect(opts.sandboxReadMounts).toEqual(snap.boxed ? [{ name: 'repos', path: 'C:/Users/an/src/siran' }] : undefined);
      expect(opts.beingLink).toBeDefined();
      expect(cards).toBe(1);
      expect(seeds[0].publicOnly).toBeFalsy();
      expect(message).toMatch(/# Pointers/);
      expect(message).toMatch(/# Actions/);
    });
  }
});
