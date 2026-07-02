// spine-seed.test.mjs — the boot-time profile seeding (src/spine/seed.mjs). COPY-IF-
// MISSING: every repo skeleton + the commented example agent-type file are written into
// the profile only when absent; an existing file is NEVER touched (operator edits are
// sacred). Fully in-memory io — nothing hits the real profile.
import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { seedSkeletons, EXAMPLE_TYPE_FILE, DEFAULT_TYPE_FILE } from '../src/spine/seed.mjs';

// Built with join so keys + the dirs passed to seedSkeletons share the platform separator.
const REPO = join('/repo', 'skeletons'), SKEL = join('/prof', 'config', 'skeletons'), AGENTS = join('/prof', 'config', 'agents');

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
  seedSkeletons({ repoDir: REPO, profileSkeletonsDir: SKEL, agentsDir: AGENTS, io });
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

  it('seeds the WORKING default agent-type file config/agents/default.yaml (so agents.egpt.type: default resolves)', () => {
    const files = run({ [join(REPO, 'config.yaml')]: 'A' });
    expect(files[join(AGENTS, 'default.yaml')]).toBe(DEFAULT_TYPE_FILE);
  });

  it('NEVER touches an existing file (operator edits are sacred)', () => {
    const files = run({
      [join(REPO, 'config.yaml')]: 'FRESH',
      [join(SKEL, 'config.yaml')]: 'OPERATOR EDIT',          // already present
      [join(AGENTS, 'sonnet-high.yaml')]: 'MY OWN TYPE',     // already present
      [join(AGENTS, 'default.yaml')]: 'MY OWN DEFAULT',      // already present
    });
    expect(files[join(SKEL, 'config.yaml')]).toBe('OPERATOR EDIT');   // untouched
    expect(files[join(AGENTS, 'sonnet-high.yaml')]).toBe('MY OWN TYPE');
    expect(files[join(AGENTS, 'default.yaml')]).toBe('MY OWN DEFAULT');
  });

  it('the example type file is inert (all comments → YAML parses to null, so the registry ignores it)', async () => {
    const YAML = await import('yaml');
    expect(YAML.parse(EXAMPLE_TYPE_FILE)).toBeNull();
  });

  it('the default type file is a LIVE def (parses to { type: ccode, ... }), unlike the commented example', async () => {
    const YAML = await import('yaml');
    expect(YAML.parse(DEFAULT_TYPE_FILE)).toMatchObject({ type: 'ccode', model: null, allowed_tools: 'all' });
  });

  it('a missing repo dir is tolerated (still seeds the example type file)', () => {
    const files = run({});   // no repo skeletons present
    expect(files[join(AGENTS, 'sonnet-high.yaml')]).toBe(EXAMPLE_TYPE_FILE);
  });
});
