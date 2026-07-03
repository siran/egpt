// The brain registry: resolve a brain def by name across layers (built-in ←
// config/agents ← conversation), most-specific winning, partial overrides merging.
// The legacy config/brains layer is dropped (operator 2026-07-02: no baggage).
// In-memory fs seam — no disk, no real profile.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createBrains } from '../src/spine/brains.mjs';
import { buildClaudeArgs } from '../src/claude-args.mjs';

const BUILTIN = '/builtin', AGENTS = '/agents';

function harness(files) {
  // files: { '<absolute path>': '<yaml text>' }
  return createBrains({
    builtinDir: BUILTIN, agentsDir: AGENTS,
    exists: (p) => p in files,
    readFile: (p) => files[p],
  });
}

describe('brain registry', () => {
  it('resolves a shipped built-in brain by name', () => {
    const brains = harness({ [join(BUILTIN, 'default.yaml')]: 'type: ccode\nmodel: null\nallowed_tools: all\n' });
    expect(brains.resolve('default')).toEqual({ name: 'default', type: 'ccode', model: null, allowed_tools: 'all' });
  });

  it('a config/agents override wins field-by-field over the built-in (partial merge)', () => {
    const brains = harness({
      [join(BUILTIN, 'default.yaml')]: 'type: ccode\nmodel: null\nallowed_tools: all\n',
      [join(AGENTS,  'default.yaml')]: 'model: opus\n',   // only overrides model
    });
    expect(brains.resolve('default')).toEqual({ name: 'default', type: 'ccode', model: 'opus', allowed_tools: 'all' });
  });

  it('a conversation brain (<slug>/brains) wins over config/agents', () => {
    const brains = harness({
      [join(BUILTIN, 'default.yaml')]: 'type: ccode\nmodel: null\n',
      [join(AGENTS,  'default.yaml')]: 'model: opus\n',
      [join('/conv/slug', 'brains', 'default.yaml')]: 'model: haiku\n',
    });
    expect(brains.resolve('default', { convDir: '/conv/slug' })).toMatchObject({ model: 'haiku', type: 'ccode' });
  });

  it('returns null for an unknown brain', () => {
    const brains = harness({ [join(BUILTIN, 'default.yaml')]: 'type: ccode\n' });
    expect(brains.resolve('codex')).toBeNull();
  });

  it('config/agents (the canonical type-file layer) overrides the built-in', () => {
    const brains = harness({
      [join(BUILTIN, 'sonnet-high.yaml')]: 'type: ccode\nmodel: sonnet\neffort: low\nallowed_tools: all\n',
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

  it('the shipped egpt.yaml built-in really loads (real fs)', () => {
    // Override the agents layer so only the repo built-in is seen (independent of the
    // real operator profile, which we must not depend on).
    const brains = createBrains({ agentsDir: '/nonexistent-agents-dir' });
    const egpt = brains.resolve('egpt');
    expect(egpt).toMatchObject({ name: 'egpt', type: 'ccode' });
    expect(Array.isArray(egpt.allowed_tools)).toBe(true);          // shipped as a LIST → confined-by-default
  });

  it('the name "default" NO LONGER resolves — no legacy alias (operator 2026-07-02: no baggage)', () => {
    // The shipped type was renamed to 'egpt'; there is no built-in default.yaml and no alias.
    // Stored readonly.agent:"default" records were PORTED at cutover instead.
    const brains = createBrains({ agentsDir: '/nonexistent-agents-dir' });
    expect(brains.resolve('default')).toBeNull();
    // …but if an operator deliberately keeps a real default.yaml layer, it resolves normally
    // (generic layer mechanism, not a special-case alias).
    const withDefault = harness({ [join(AGENTS, 'default.yaml')]: 'type: codex\nmodel: gpt\n' });
    expect(withDefault.resolve('default')).toMatchObject({ name: 'default', type: 'codex', model: 'gpt' });
  });

  it('a VERTICAL allowed_tools list flows end-to-end: type file → resolve (array) → buildClaudeArgs --allowedTools', () => {
    // The documented vertical YAML-list form (default.yaml / config/agents examples).
    const brains = harness({
      [join(AGENTS, 'scoped.yaml')]: 'type: ccode\nallowed_tools:\n  - Read\n  - Grep\n  - "Bash(git:*)"\n',
    });
    const def = brains.resolve('scoped');
    expect(def.allowed_tools).toEqual(['Read', 'Grep', 'Bash(git:*)']);   // array survives resolve
    // brainpool passes def.allowed_tools straight through as baseOpts.allowedTools (unconfined).
    const args = buildClaudeArgs({ allowedTools: def.allowed_tools });
    const i = args.indexOf('--allowedTools');
    expect(args[i + 1]).toBe('Read Grep Bash(git:*)');
  });
});
