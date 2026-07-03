// spine-seed.test.mjs — the boot-time profile seeding (src/spine/seed.mjs). COPY-IF-
// MISSING: every repo skeleton + the commented example agent-type file are written into
// the profile only when absent; an existing file is NEVER touched (operator edits are
// sacred). Fully in-memory io — nothing hits the real profile.
import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { seedSkeletons, EXAMPLE_TYPE_FILE, EGPT_TYPE_FILE, PRESET_IDENTITIES } from '../src/spine/seed.mjs';

// Built with join so keys + the dirs passed to seedSkeletons share the platform separator.
const REPO = join('/repo', 'skeletons'), SKEL = join('/prof', 'config', 'skeletons'), AGENTS = join('/prof', 'config', 'agents'), IDS = join('/prof', 'config', 'identities');

// A tiny in-memory fs: a { path: contents } map, plus a set of "directories that exist".
function memfs(seed = {}) {
  const files = { ...seed };
  return {
    files,
    io: {
      existsSync: (p) => p in files,
      readdirSync: (p) => Object.keys(files)
        .filter((f) => dirname(f) === p)
        .map((f) => f.slice(p.length + 1)),
      readFileSync: (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
      writeFileSync: (p, c) => { files[p] = c; },
      mkdirSync: () => {},
    },
  };
}

function run(seed) {
  const { files, io } = memfs(seed);
  seedSkeletons({ repoDir: REPO, profileSkeletonsDir: SKEL, agentsDir: AGENTS, identitiesDir: IDS, io });
  return files;
}

describe('seedSkeletons', () => {
  it('copies every repo skeleton (*.yaml/*.md) into the profile skeletons/ folder', () => {
    const files = run({
      [join(REPO, 'config.yaml')]: 'A',
      [join(REPO, 'heartbeats.yaml')]: 'B',
      [join(REPO, 'script.x.md')]: 'C',
    });
    expect(files[join(SKEL, 'config.yaml')]).toBe('A');
    expect(files[join(SKEL, 'heartbeats.yaml')]).toBe('B');
    expect(files[join(SKEL, 'script.x.md')]).toBe('C');
  });

  it('seeds the commented example agent-type file config/agents/sonnet-high.yaml', () => {
    const files = run({ [join(REPO, 'config.yaml')]: 'A' });
    expect(files[join(AGENTS, 'sonnet-high.yaml')]).toBe(EXAMPLE_TYPE_FILE);
  });

  it('seeds the WORKING egpt agent-type file config/agents/egpt.yaml (so agents.egpt.configuration: egpt resolves), and NOT the old default.yaml', () => {
    const files = run({ [join(REPO, 'config.yaml')]: 'A' });
    expect(files[join(AGENTS, 'egpt.yaml')]).toBe(EGPT_TYPE_FILE);
    expect(files[join(AGENTS, 'default.yaml')]).toBeUndefined();   // renamed 2026-07-02 — never recreated
  });

  it('NEVER touches an existing file (operator edits are sacred)', () => {
    const files = run({
      [join(REPO, 'config.yaml')]: 'FRESH',
      [join(SKEL, 'config.yaml')]: 'OPERATOR EDIT',          // already present
      [join(AGENTS, 'sonnet-high.yaml')]: 'MY OWN TYPE',     // already present
      [join(AGENTS, 'egpt.yaml')]: 'MY OWN EGPT',            // already present
    });
    expect(files[join(SKEL, 'config.yaml')]).toBe('OPERATOR EDIT');   // untouched
    expect(files[join(AGENTS, 'sonnet-high.yaml')]).toBe('MY OWN TYPE');
    expect(files[join(AGENTS, 'egpt.yaml')]).toBe('MY OWN EGPT');
  });

  it('the example type file is inert (all comments → YAML parses to null, so the registry ignores it)', async () => {
    const YAML = await import('yaml');
    expect(YAML.parse(EXAMPLE_TYPE_FILE)).toBeNull();
  });

  it('the egpt type file is a LIVE def (parses to { type: ccode, ... }, allowed_tools a LIST = confined), unlike the commented example', async () => {
    const YAML = await import('yaml');
    const def = YAML.parse(EGPT_TYPE_FILE);
    expect(def).toMatchObject({ type: 'ccode', model: 'sonnet', effort: 'high' });
    expect(Array.isArray(def.allowed_tools)).toBe(true);            // a LIST → confined-by-default
    expect(def.allowed_tools).toContain('Read');
    expect(def.allowed_paths).toBeNull();                           // the block is all-commented (conversation dir is implicit)
  });

  it('a missing repo dir is tolerated (still seeds the example type file)', () => {
    const files = run({});   // no repo skeletons present
    expect(files[join(AGENTS, 'sonnet-high.yaml')]).toBe(EXAMPLE_TYPE_FILE);
  });

  it('seeds each preset personality identity layer (FLAT config/identities/<name>.md), copy-if-missing', () => {
    const files = run({});
    const names = Object.keys(PRESET_IDENTITIES);
    expect(names).toHaveLength(10);   // the 10 operator-named flavors — can't-rot
    expect(names).toEqual(expect.arrayContaining([
      'secretary', 'psychologist', 'detective', 'poet', 'writer',
      'spiritual-advisor', 'financial-advisor', 'philosopher', 'logicist', 'one-two-many',
    ]));
    for (const name of names) {
      expect(files[join(IDS, `${name}.md`)]).toBe(PRESET_IDENTITIES[name]);
    }
  });

  it('NEVER overwrites an operator-edited preset layer (edits are sacred)', () => {
    const files = run({ [join(IDS, 'poet.md')]: 'MY OWN POET' });
    expect(files[join(IDS, 'poet.md')]).toBe('MY OWN POET');       // untouched
    expect(files[join(IDS, 'detective.md')]).toBe(PRESET_IDENTITIES.detective);  // others still seeded
  });

  it('seeds the shared room template (config/skeletons/room/*.md) copy-if-missing', () => {
    const files = run({
      [join(REPO, 'room', '00-identity.md')]: 'I am eGPT',
      [join(REPO, 'room', '30-pointers.md')]: 'Pointers',
      [join(REPO, 'room', '40-rules.md')]: 'RULES',
    });
    expect(files[join(SKEL, 'room', '00-identity.md')]).toBe('I am eGPT');
    expect(files[join(SKEL, 'room', '30-pointers.md')]).toBe('Pointers');
    expect(files[join(SKEL, 'room', '40-rules.md')]).toBe('RULES');
  });

  it('NEVER overwrites an operator-edited room template file', () => {
    const files = run({
      [join(REPO, 'room', '00-identity.md')]: 'SHIPPED',
      [join(SKEL, 'room', '00-identity.md')]: 'MY OWN IDENTITY',   // already present
    });
    expect(files[join(SKEL, 'room', '00-identity.md')]).toBe('MY OWN IDENTITY');   // untouched
  });

  it('each preset layer is plain markdown (a short instruction file), not YAML config', () => {
    for (const [name, body] of Object.entries(PRESET_IDENTITIES)) {
      expect(body.trimStart().startsWith('#')).toBe(true);   // a markdown heading, like the default layer
      expect(body.length).toBeLessThan(1200);                // SHORT — a paragraph or two
      expect(body).not.toMatch(/^type:/m);                   // not an agent-type file
    }
  });
});
