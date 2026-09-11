// spine-seed.test.mjs — the boot-time profile seeding (src/spine/seed.mjs). COPY-IF-
// MISSING: every repo skeleton + the commented example agent-type file are written into
// the profile only when absent; an existing file is NEVER touched (operator edits are
// sacred). Fully in-memory io — nothing hits the real profile.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { seedSkeletons, REPO_SKELETONS_DIR } from '../src/spine/seed.mjs';

// Built with join so keys + the dirs passed to seedSkeletons share the platform separator.
const REPO = join('/repo', 'skeletons'), SKEL = join('/prof', 'config', 'skeletons'), AGENTS = join('/prof', 'config', 'agents'), IDS = join('/prof', 'config', 'agents', 'identities');

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

// Same seeding run, but reading the REAL repo skeletons (so the shipped set can't rot)
// while every WRITE still lands in memory — nothing touches a real profile. `pre` pre-loads
// the fake profile with operator-edited files, to prove copy-if-missing leaves them alone.
function runAgainstRepo(pre = {}) {
  const files = { ...pre };
  const io = {
    existsSync: (p) => (String(p).startsWith(REPO_SKELETONS_DIR) ? existsSync(p) : p in files),
    readdirSync: (p) => readdirSync(p),
    readFileSync: (p) => (p in files ? files[p] : readFileSync(p, 'utf8')),
    writeFileSync: (p, c) => { files[p] = c; },
    mkdirSync: () => {},
  };
  seedSkeletons({ repoDir: REPO_SKELETONS_DIR, profileSkeletonsDir: SKEL, agentsDir: AGENTS, identitiesDir: IDS, io });
  return files;
}

// The SHIPPED brain defs + personalities, read straight off disk — the one source of truth
// both the seeder and these assertions are held to.
const SHIPPED_AGENTS_DIR = join(REPO_SKELETONS_DIR, 'agents');
const SHIPPED_IDS_DIR = join(SHIPPED_AGENTS_DIR, 'identities');
const shippedDefs = () => readdirSync(SHIPPED_AGENTS_DIR).filter((n) => n.endsWith('.yaml'));
const shippedIdentities = () => readdirSync(SHIPPED_IDS_DIR).filter((n) => n.endsWith('.md'));

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



  it('a missing repo dir is tolerated — nothing is seeded and nothing throws', () => {
    const files = run({});   // no repo skeletons present
    expect(files[join(AGENTS, 'sonnet-high.yaml')]).toBeUndefined();
    expect(files[join(AGENTS, 'egpt.yaml')]).toBeUndefined();      // `egpt` is a PERSONALITY, never a brain config
  });

  it('copies the shipped brain defs (config/skeletons/agents/*.yaml) into config/agents/', () => {
    const files = run({
      [join(REPO, 'agents', 'haiku-low.yaml')]: 'H',
      [join(REPO, 'agents', 'opus-max.yaml')]: 'O',
    });
    expect(files[join(AGENTS, 'haiku-low.yaml')]).toBe('H');
    expect(files[join(AGENTS, 'opus-max.yaml')]).toBe('O');
    // the nested identities/ dir is NOT swept up as a brain def
    expect(files[join(AGENTS, 'identities.yaml')]).toBeUndefined();
  });

  it('copies the shipped personalities (config/skeletons/agents/identities/*.md) into config/agents/identities/', () => {
    const files = run({ [join(REPO, 'agents', 'identities', 'ken.md')]: 'I am Ken' });
    expect(files[join(IDS, 'ken.md')]).toBe('I am Ken');
  });

  it('seeds the shared room template (config/skeletons/room/*.md) copy-if-missing', () => {
    const files = run({
      [join(REPO, 'room', '00-identity.md')]: 'I am eGPT',
      [join(REPO, 'room', '10-actions.md')]: 'My limbs',   // the emit-limbs grammar (operator 2026-07-06)
      [join(REPO, 'room', '30-pointers.md')]: 'Pointers',
      [join(REPO, 'room', '40-rules.md')]: 'RULES',
    });
    expect(files[join(SKEL, 'room', '00-identity.md')]).toBe('I am eGPT');
    expect(files[join(SKEL, 'room', '10-actions.md')]).toBe('My limbs');   // auto-rides the room seed → a /restart seeds it
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

  it('each shipped personality is plain markdown (a short instruction file), not YAML config', () => {
    for (const name of shippedIdentities()) {
      const body = readFileSync(join(SHIPPED_IDS_DIR, name), 'utf8');
      expect(body.trimStart().startsWith('#'), `${name} is not a markdown heading`).toBe(true);
      expect(body).not.toMatch(/^type:/m);                   // not an agent-type file
    }
  });
});

// ── identities and brain defs ship ONE way: FILES under config/skeletons/agents/ ───────
// They used to ship TWO ways — these same 10 personalities also lived as a JS object
// literal (seed.mjs PRESET_IDENTITIES) that the seeder wrote out. Two shipping channels for
// one artifact is how they drift; the constant is gone and the files are the source.
describe('the shipped agents/ skeleton is the ONLY channel for brain defs + personalities', () => {
  it('no longer exports PRESET_IDENTITIES (the second channel is gone)', async () => {
    const mod = await import('../src/spine/seed.mjs');
    expect(mod.PRESET_IDENTITIES).toBeUndefined();
  });

  it('lands every shipped brain def at config/agents/<name>.yaml', () => {
    const files = runAgainstRepo();
    const names = shippedDefs();
    // the model × effort grid: 3 models × 5 efforts
    expect(names.length).toBe(15);
    for (const m of ['haiku', 'sonnet', 'opus']) {
      for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) {
        expect(names, `no shipped ${m}-${e}.yaml`).toContain(`${m}-${e}.yaml`);
      }
    }
    for (const name of names) {
      expect(files[join(AGENTS, name)], `${name} was not seeded`)
        .toBe(readFileSync(join(SHIPPED_AGENTS_DIR, name), 'utf8'));
    }
  });

  it('each shipped brain def is a LIVE three-field def — and declares no allowed_tools', async () => {
    const YAML = await import('yaml');
    for (const name of shippedDefs()) {
      const def = YAML.parse(readFileSync(join(SHIPPED_AGENTS_DIR, name), 'utf8'));
      const [model, effort] = name.replace(/\.yaml$/, '').split('-');
      expect(def, name).toEqual({ type: 'ccode', model, effort });
      // capability comes from conversation_defaults.access_level now, not a per-def tool list
      expect(def.allowed_tools, `${name} still carries allowed_tools`).toBeUndefined();
    }
  });

  it('lands every shipped personality at config/agents/identities/<name>.md', () => {
    const files = runAgainstRepo();
    const names = shippedIdentities();
    // the three shipped characters plus the ten preset flavors
    expect(names).toEqual(expect.arrayContaining([
      'egpt.md', 'ken.md', 'wren.md',
      'secretary.md', 'psychologist.md', 'detective.md', 'poet.md', 'writer.md',
      'spiritual-advisor.md', 'financial-advisor.md', 'philosopher.md', 'logicist.md', 'one-two-many.md',
    ]));
    for (const name of names) {
      expect(files[join(IDS, name)], `${name} was not seeded`)
        .toBe(readFileSync(join(SHIPPED_IDS_DIR, name), 'utf8'));
    }
  });

  // The three characters differ only by an inserted paragraph the operator is still tuning,
  // so pin the SHARED framing, never the character line itself.
  it('egpt / ken / wren each carry the shared eGPT framing', () => {
    for (const name of ['egpt.md', 'ken.md', 'wren.md']) {
      const body = readFileSync(join(SHIPPED_IDS_DIR, name), 'utf8');
      expect(body.trim().length, `${name} is empty`).toBeGreaterThan(0);
      expect(body, name).toContain('{{agent_name}}');
      expect(body, name).toContain('{{node_name}}');
      expect(body, name).toMatch(/eGPT is the SYSTEM/);
    }
  });

  it('NEVER clobbers an operator-edited brain def or personality (edits are sacred)', () => {
    const files = runAgainstRepo({
      [join(AGENTS, 'haiku-low.yaml')]: 'MY OWN BRAIN',
      [join(IDS, 'poet.md')]: 'MY OWN POET',
    });
    expect(files[join(AGENTS, 'haiku-low.yaml')]).toBe('MY OWN BRAIN');   // untouched
    expect(files[join(IDS, 'poet.md')]).toBe('MY OWN POET');              // untouched
    // ...and the siblings still seed
    expect(files[join(AGENTS, 'haiku-high.yaml')]).toBe(readFileSync(join(SHIPPED_AGENTS_DIR, 'haiku-high.yaml'), 'utf8'));
    expect(files[join(IDS, 'detective.md')]).toBe(readFileSync(join(SHIPPED_IDS_DIR, 'detective.md'), 'utf8'));
  });

  // sonnet-high used to collide: it is a shipped brain def AND was the name of the retired
  // commented EXAMPLE_TYPE_FILE. With that constant gone the shipped def is the only writer.
  it('sonnet-high comes from the shipped brain def, and nothing else writes that path', () => {
    const files = runAgainstRepo();
    expect(files[join(AGENTS, 'sonnet-high.yaml')])
      .toBe(readFileSync(join(SHIPPED_AGENTS_DIR, 'sonnet-high.yaml'), 'utf8'));
  });
});

// ── the GRANTABLE TOOL VOCABULARY the type file must spell out ────────────────────────
// Operator 2026-07-26, asked twice: "i **still** don't see a commented 'execution'
// allowed_tool as i asked you a few turns back. […] I only want to uncomment, get it? how
// could i know what to write?" The type file is the ONLY place an operator learns what is
// grantable, so every tool must be listed COMMENTED OUT — configuring = uncommenting.
//
// The vocabulary is not ours to invent: the engine is the Claude Code CLI, so `--allowedTools`
// decides what a name means. Every name below was confirmed twice — in the CLI's own tools
// reference (code.claude.com/docs/en/tools-reference) AND as a literal string in the installed
// claude binary. Names that exist but are INERT headless (AskUserQuestion, PushNotification,
// …) are named in prose, not as uncommentable lines, so nobody grants a no-op.
const GRANTABLE = [
  'MultiEdit', 'NotebookEdit',                        // write-class, and NOT in DEFAULT_ALLOWED_TOOLS
  'Bash(git:*)', 'PowerShell(', 'Monitor',            // the execution tier the operator kept asking for
  'LSP', 'Agent', 'Skill', 'Workflow',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TodoWrite',
  'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'WaitForMcpServers',
  'Artifact', 'EnterWorktree', 'ExitWorktree', 'EnterPlanMode', 'ExitPlanMode',
];


