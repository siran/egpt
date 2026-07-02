// The brain registry: resolve a brain def by name across layers (built-in ←
// profile ← conversation), most-specific winning, partial overrides merging.
// In-memory fs seam — no disk, no real profile.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createBrains } from '../src/spine/brains.mjs';

const BUILTIN = '/builtin', PROFILE = '/profile', AGENTS = '/agents';

function harness(files) {
  // files: { '<absolute path>': '<yaml text>' }
  return createBrains({
    builtinDir: BUILTIN, profileDir: PROFILE, agentsDir: AGENTS,
    exists: (p) => p in files,
    readFile: (p) => files[p],
  });
}

describe('brain registry', () => {
  it('resolves a shipped built-in brain by name', () => {
    const brains = harness({ [join(BUILTIN, 'default.yaml')]: 'type: ccode\nmodel: null\nallowed_tools: all\n' });
    expect(brains.resolve('default')).toEqual({ name: 'default', type: 'ccode', model: null, allowed_tools: 'all' });
  });

  it('a profile override wins field-by-field over the built-in (partial merge)', () => {
    const brains = harness({
      [join(BUILTIN, 'default.yaml')]: 'type: ccode\nmodel: null\nallowed_tools: all\n',
      [join(PROFILE, 'default.yaml')]: 'model: opus\n',   // only overrides model
    });
    expect(brains.resolve('default')).toEqual({ name: 'default', type: 'ccode', model: 'opus', allowed_tools: 'all' });
  });

  it('a conversation brain (<slug>/brains) wins over the profile', () => {
    const brains = harness({
      [join(BUILTIN, 'default.yaml')]: 'type: ccode\nmodel: null\n',
      [join(PROFILE, 'default.yaml')]: 'model: opus\n',
      [join('/conv/slug', 'brains', 'default.yaml')]: 'model: haiku\n',
    });
    expect(brains.resolve('default', { convDir: '/conv/slug' })).toMatchObject({ model: 'haiku', type: 'ccode' });
  });

  it('returns null for an unknown brain', () => {
    const brains = harness({ [join(BUILTIN, 'default.yaml')]: 'type: ccode\n' });
    expect(brains.resolve('codex')).toBeNull();
  });

  it('config/agents (the NEW canonical type-file layer) overrides config/brains overrides built-in', () => {
    const brains = harness({
      [join(BUILTIN, 'sonnet-high.yaml')]: 'type: ccode\nmodel: sonnet\neffort: low\nallowed_tools: all\n',
      [join(PROFILE, 'sonnet-high.yaml')]: 'effort: medium\n',   // config/brains layer
      [join(AGENTS,  'sonnet-high.yaml')]: 'effort: high\n',     // config/agents layer wins
    });
    expect(brains.resolve('sonnet-high')).toEqual({ name: 'sonnet-high', type: 'ccode', model: 'sonnet', effort: 'high', allowed_tools: 'all' });
  });

  it('a conversation brains/ still wins over config/agents', () => {
    const brains = harness({
      [join(AGENTS, 'sonnet-high.yaml')]: 'type: ccode\neffort: high\n',
      [join('/conv/slug', 'brains', 'sonnet-high.yaml')]: 'effort: max\n',
    });
    expect(brains.resolve('sonnet-high', { convDir: '/conv/slug' })).toMatchObject({ effort: 'max', type: 'ccode' });
  });

  it('the shipped default.yaml really loads (real fs)', () => {
    const brains = createBrains({ profileDir: '/nonexistent-profile-dir' });   // real builtin, empty profile
    expect(brains.resolve('default')).toMatchObject({ name: 'default', type: 'ccode', allowed_tools: 'all' });
  });
});
