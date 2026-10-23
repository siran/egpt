// beeperBlockOf — the one reader of the Beeper limb's block (limbs.beeper, else the pre-0049
// top-level beeper:), and the two setup scripts that edit the block in place, on either form.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';
import { beeperBlockOf, beeperBlockPath } from '../src/tools/config-io.mjs';
import { restartKeysChanged, isRestartKey } from '../src/spine/config-swap.mjs';

const BLOCK = () => ({ primary: { account: 'an@example.com', token: 'TOK-p' }, secondary: { account: 'rodz@example.com', token: 'TOK-s' }, auto_update: { windows: { method: 'manual' } } });

describe('beeperBlockOf', () => {
  it('returns the same block from limbs.beeper and from a top-level beeper:', () => {
    expect(beeperBlockOf({ limbs: { beeper: BLOCK() } })).toEqual(BLOCK());
    expect(beeperBlockOf({ beeper: BLOCK() })).toEqual(BLOCK());
    expect(beeperBlockPath({ limbs: { beeper: BLOCK() } })).toEqual(['limbs', 'beeper']);
    expect(beeperBlockPath({ beeper: BLOCK() })).toEqual(['beeper']);
  });

  it('the top-level form: ONE deprecation line per call that asks for it, none for limbs.beeper', () => {
    const seen = [];
    const onDeprecated = (m) => seen.push(m);
    beeperBlockOf({ beeper: BLOCK() }, { onDeprecated });
    expect(seen).toEqual([expect.stringMatching(/^deprecated config\.yaml key — top-level beeper: read as limbs\.beeper\. Migration 0049 copies it under limbs:$/)]);
    beeperBlockOf({ limbs: { beeper: BLOCK() } }, { onDeprecated });
    beeperBlockOf({}, { onDeprecated });
    beeperBlockOf({ beeper: BLOCK() });
    expect(seen).toHaveLength(1);
  });

  it('both forms: limbs.beeper wins; one informational line names the top-level block as the deprecated copy, and says when they differ', () => {
    const seen = [];
    const onDeprecated = (m) => seen.push(m);
    expect(beeperBlockOf({ limbs: { beeper: BLOCK() }, beeper: BLOCK() }, { onDeprecated })).toEqual(BLOCK());
    expect(beeperBlockOf({ limbs: { beeper: { main: { token: 'A' } } }, beeper: { main: { token: 'B' } } }, { onDeprecated })).toEqual({ main: { token: 'A' } });
    expect(seen).toEqual([
      'top-level beeper: is the deprecated copy kept for older code; limbs.beeper is used',
      'top-level beeper: is the deprecated copy kept for older code; limbs.beeper is used, and the two differ (expected: a renewed token goes into limbs.beeper only)',
    ]);
  });

  it('neither form, or no config: nothing, and nothing said', () => {
    const seen = [];
    for (const cfg of [{}, { limbs: null }, { limbs: {} }, null, undefined]) expect(beeperBlockOf(cfg, { onDeprecated: (m) => seen.push(m) })).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('limbs is restart-only, and the 0049 copy restarts the spine', () => {
    expect(isRestartKey('limbs.beeper.primary.token')).toBe(true);
    expect(restartKeysChanged({ beeper: BLOCK() }, { limbs: { beeper: BLOCK() }, beeper: BLOCK() })).toEqual(['limbs']);
  });
});

const SETUP = join(fileURLToPath(new URL('..', import.meta.url)), 'setup');
const TOKEN = 'NEW-TOKEN-0123456789';
const TOP = ['node_name: kg', '# --- Beeper', 'beeper:', '  primary:', '    account: an@example.com', '    token: OLD-TOKEN-0123456789', '  primary_gui:   # the window', '    account: an@example.com', '    token: GUI-TOKEN-0123456789', 'agents: {}', ''].join('\n');
const LIMBS = ['node_name: kg', 'limbs:', '  # --- Beeper', '  beeper:', '    primary:', '      account: an@example.com', '      token: OLD-TOKEN-0123456789', '    primary_gui:   # the window', '      account: an@example.com', '      token: GUI-TOKEN-0123456789', 'agents: {}', ''].join('\n');

describe('the setup scripts that edit the block, on either form', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'egpt-beeper-block-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const cfgAt = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
  const run = (script, args, input) => spawnSync(process.execPath, [join(SETUP, script), ...args], { input, encoding: 'utf8' });

  for (const [form, text, at] of [['top-level beeper:', TOP, 'beeper.primary.token'], ['limbs.beeper', LIMBS, 'limbs.beeper.primary.token']]) {
    it(`set-beeper-token on ${form} writes ${at}, every other byte kept`, () => {
      const p = cfgAt('config.yaml', text);
      const r = run('set-beeper-token.mjs', ['primary', '--config', p], TOKEN);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`${at} written`);
      expect(readFileSync(p, 'utf8')).toBe(text.replace('OLD-TOKEN-0123456789', TOKEN));
    });

    it(`beeper-share-config remove-gui takes primary_gui out of ${form}`, () => {
      const p = cfgAt('config.yaml', text);
      const r = run('beeper-share-config.mjs', ['remove-gui', '--config', p]);
      expect(r.status, r.stderr).toBe(0);
      expect(beeperBlockOf(YAML.parse(readFileSync(p, 'utf8')))).toEqual({ primary: { account: 'an@example.com', token: 'OLD-TOKEN-0123456789' } });
    });
  }

  it('beeper-share-config restore puts a pre-0049 backup back into limbs.beeper, re-indented', () => {
    const backup = cfgAt('config.yaml.bak-share-1', TOP);
    const now = LIMBS.replace('OLD-TOKEN-0123456789', TOKEN).replace('    primary_gui:   # the window\n      account: an@example.com\n      token: GUI-TOKEN-0123456789\n', '');
    const p = cfgAt('config.yaml', now);
    const r = run('beeper-share-config.mjs', ['restore', '--from', backup, '--config', p]);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(p, 'utf8')).toBe(LIMBS);
  });
});
