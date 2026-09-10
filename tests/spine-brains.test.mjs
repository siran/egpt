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

  // ── dangerously_skip_permissions: true — BASE-LAYERS-ONLY (operator 2026-08: the
  // escalation-hole fix). A conv-local brains/<name>.yaml override must never be able to GRANT
  // dangerously_skip_permissions:true, nor REVOKE a base-level grant. See
  // src/spine/brainpool.mjs's confinementFor: dangerously_skip_permissions:true skips ALL
  // confinement, so this key must be immune to the one layer a confined being can write to
  // itself (its own conversation directory).
  it('conv-local CANNOT grant dangerously_skip_permissions:true when the base layers never set it (the escalation reproduction)', () => {
    const brains = harness({
      [join(BUILTIN, 'sonnet-high.yaml')]: 'type: ccode\nmodel: sonnet\nallowed_tools:\n  - Read\n',
      [join('/conv/slug', 'brains', 'sonnet-high.yaml')]: 'dangerously_skip_permissions: true\nallowed_tools:\n  - Bash\n',
    });
    const def = brains.resolve('sonnet-high', { convDir: '/conv/slug' });
    expect(def.dangerously_skip_permissions).not.toBe(true);
    // the rest of the conv-local override still applies normally (only dangerously_skip_permissions is special)
    expect(def.allowed_tools).toEqual(['Bash']);
  });

  it('a base-level dangerously_skip_permissions:true is STICKY — conv-local cannot revoke it', () => {
    const brains = harness({
      [join(BUILTIN, 'meta-engineer.yaml')]: 'type: ccode\nmodel: sonnet\ndangerously_skip_permissions: true\n',
    });
    // conv-local says nothing about dangerously_skip_permissions → still true
    expect(brains.resolve('meta-engineer', { convDir: '/conv/slug' }).dangerously_skip_permissions).toBe(true);
    // conv-local EXPLICITLY tries to revoke it → still true (immune in both directions)
    const brainsRevoke = harness({
      [join(BUILTIN, 'meta-engineer.yaml')]: 'type: ccode\nmodel: sonnet\ndangerously_skip_permissions: true\n',
      [join('/conv/slug', 'brains', 'meta-engineer.yaml')]: 'dangerously_skip_permissions: false\n',
    });
    expect(brainsRevoke.resolve('meta-engineer', { convDir: '/conv/slug' }).dangerously_skip_permissions).toBe(true);
  });

  it('regression: every OTHER field still layers normally across all three tiers with convDir (dangerously_skip_permissions fix touched nothing else)', () => {
    const brains = harness({
      [join(BUILTIN, 'sonnet-high.yaml')]: 'type: ccode\nmodel: null\neffort: low\nallowed_tools: all\n',
      [join(AGENTS,  'sonnet-high.yaml')]: 'model: opus\n',
      [join('/conv/slug', 'brains', 'sonnet-high.yaml')]: 'effort: max\n',
    });
    expect(brains.resolve('sonnet-high', { convDir: '/conv/slug' }))
      .toEqual({ name: 'sonnet-high', type: 'ccode', model: 'opus', effort: 'max', allowed_tools: 'all' });
  });

  // ── `agents.<name>.configuration` has TWO forms (operator 2026-09-07). A STRING names
  // config/agents/<name>.yaml (everything above); an INLINE MAP written straight into
  // config.yaml IS the def. Same resolver, same single entry point — not a second registry.
  describe('inline configuration map', () => {
    it('an INLINE map resolves to itself — type/model/effort/verbose_thinking/personality all survive', () => {
      const brains = harness({});     // no files anywhere: an inline def needs none
      expect(brains.resolve({ type: 'ccode', model: 'haiku', effort: 'low', verbose_thinking: true, personality: 'egpt' }))
        .toMatchObject({ type: 'ccode', model: 'haiku', effort: 'low', verbose_thinking: true, personality: 'egpt' });
    });

    it('an inline map is NOT merged with any file — there is no filename, so the layer walk does not apply', () => {
      // Every layer carries an `egpt.yaml` that would loudly win/lose a merge…
      const brains = harness({
        [join(BUILTIN, 'egpt.yaml')]: 'type: codex\nmodel: sonnet\neffort: max\nallowed_tools: all\n',
        [join(AGENTS,  'egpt.yaml')]: 'model: opus\ncwd: /somewhere\n',
        [join('/conv/slug', 'brains', 'egpt.yaml')]: 'effort: high\n',
      });
      // …and the inline map even names itself `egpt`. Nothing from those files may leak in.
      const def = brains.resolve({ name: 'egpt', type: 'ccode', model: 'haiku' }, { convDir: '/conv/slug' });
      expect(def).toEqual({ name: 'egpt', type: 'ccode', model: 'haiku' });
      expect(def.effort).toBeUndefined();
      expect(def.allowed_tools).toBeUndefined();
      expect(def.cwd).toBeUndefined();
    });

    it('allowed_tools written INLINE is still honored (the live egpt.yaml/wren.yaml key is not retired)', () => {
      const def = harness({}).resolve({ type: 'ccode', allowed_tools: ['Read', 'Grep'] });
      expect(def.allowed_tools).toEqual(['Read', 'Grep']);
    });

    it('the STRING form is unchanged — it still walks the layers and merges field-by-field', () => {
      const brains = harness({
        [join(BUILTIN, 'egpt.yaml')]: 'type: ccode\nmodel: sonnet\neffort: high\n',
        [join(AGENTS,  'egpt.yaml')]: 'model: opus\n',
      });
      expect(brains.resolve('egpt')).toEqual({ name: 'egpt', type: 'ccode', model: 'opus', effort: 'high' });
    });

    // LOUD, not silent (standing operator rule). A `configuration` that is neither a usable
    // map nor a resolvable NAME is a config mistake, and the old code turned every one of
    // them into a null that each caller quietly replaced with a bare ccode def.
    it('a structurally unusable configuration THROWS, naming the agent', () => {
      const brains = harness({});
      expect(() => brains.resolve([], { agent: 'ken' })).toThrow(/ken/);
      expect(() => brains.resolve(7, { agent: 'ken' })).toThrow(/ken/);
      expect(() => brains.resolve({}, { agent: 'ken' })).toThrow(/ken/);
      expect(() => brains.resolve('', { agent: 'ken' })).toThrow(/ken/);
    });

    it('a string is a bare NAME, never a path — config/agents/<name>.yaml and nothing else (operator ruling)', () => {
      const brains = harness({ [join(AGENTS, 'egpt.yaml')]: 'type: ccode\n' });
      expect(() => brains.resolve('here/the/path', { agent: 'ken' })).toThrow(/ken/);
      expect(() => brains.resolve('../../etc/egpt', { agent: 'ken' })).toThrow(/ken/);
      expect(() => brains.resolve('C:\\evil\\egpt', { agent: 'ken' })).toThrow(/ken/);
    });

    it('no configuration at all (a relay agent) still resolves quietly to null — never a throw', () => {
      const brains = harness({});
      expect(brains.resolve(undefined, { agent: 'carol' })).toBeNull();
      expect(brains.resolve(null, { agent: 'carol' })).toBeNull();
    });
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
