// seed.mjs — make the PROFILE the operator-facing home (operator 2026-07-02). At
// boot we copy the repo's shipped skeletons into ~/.egpt2/config/skeletons/ and drop
// a commented example agent-type file at ~/.egpt2/config/agents/sonnet-high.yaml, so
// an operator editing their profile has the paste-ready templates right there.
//
// COPY-IF-MISSING only: an existing file is NEVER touched (operator edits are sacred;
// /upgrade refreshes only what they haven't created). All fs is injectable so tests
// run fully in-memory — nothing hits the real profile.
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { EGPT_HOME } from '../egpt-home.mjs';

export const REPO_SKELETONS_DIR = fileURLToPath(new URL('../../config/skeletons/', import.meta.url));
export const PROFILE_SKELETONS_DIR = join(EGPT_HOME, 'config', 'skeletons');
export const PROFILE_AGENTS_DIR = join(EGPT_HOME, 'config', 'agents');

// The example agent-type file. A TYPE is a brain def (config/agents/<type>.yaml); an
// agents.<name>.type key points here. Shipped FULLY COMMENTED so seeding it can never
// change behavior (an all-comments YAML parses to null → the registry ignores it) — it
// is documentation the operator uncomments + edits.
export const EXAMPLE_TYPE_FILE = `# sonnet-high — an example AGENT TYPE (a brain def). A type is an ENGINE config; the
# \`agents:\` block in config.yaml points an agent at one by name (agents.<name>
# .configuration: sonnet-high). This file is the canonical home: config/agents/<type>.yaml.
#
# Resolution layers (most-specific wins): src/brains (built-in) < config/agents < a
# conversation's own brains/. Set only the fields you want to change.
#
# Uncomment + edit to make \`sonnet-high\` a real type:
# type: ccode           # engine: ccode | codex | chatgpt-cdp | claude-cdp | llama
# model: sonnet         # PIN a concrete model — don't rely on a null 'login default' (non-deterministic)
# effort: high          # reasoning effort, when the engine supports it
# allowed_tools: all    # "all" | a space-separated allow-list | ["Read", "Edit", ...]
`;

// The WORKING egpt agent-type file. UNlike the example above this is UNcommented (a
// live def) so agents.egpt.configuration: egpt resolves from the PROFILE the operator can
// open. Mirrors the repo's built-in src/brains/egpt.yaml (which stays the fallback); seeded
// copy-if-missing so an operator edit here is sacred and wins over the built-in.
export const EGPT_TYPE_FILE = `# egpt — the shipped persona AGENT TYPE (a brain def): the warm Claude Code CLI (no API
# key; uses your existing \`claude\` login). config.yaml's agents.egpt.configuration: egpt
# points here; a fresh conversation is INSTANCED from it (frozen into conversations.yaml
# \`readonly\`), re-pointable later with \`/e\`. This is the canonical, EDITABLE home; the
# repo's built-in src/brains/egpt.yaml is the fallback it mirrors. Seeding never overwrites it.
type: ccode           # engine: ccode | codex | chatgpt-cdp | claude-cdp | llama (only ccode wired in v2)
model: sonnet         # concrete model the engine runs (PINNED = deterministic per conversation)
effort: high          # reasoning effort (engine-dependent)
allowed_tools:        # a LIST = CONFINED (file tools path-limited to allowed_paths); \`allowed_tools: all\` = TRUSTED/unconfined (every tool, no prompts, full filesystem)
  - Read           # read files
  - Write          # create / overwrite files
  - Edit           # in-place edits
  - Glob           # find files by pattern
  - Grep           # search file contents
  - WebSearch      # web search
  - WebFetch       # fetch a URL
  - Task           # sub-agents
  #- Bash(git:*)    # SCOPED shell — the house rule is Bash(<bin>:*), never bare Bash
allowed_paths:
  # by default agents can access their conversation directory (the one listed in
  # conversations.yaml) — that root is granted automatically. Add extra roots here:
  #  /c/Users/you/project:               # full access (read + write)
  #  /c/Users/you/reference:             # READ-ONLY (a tool list that omits write tools)
  #    allowed_tools: [Read, Glob, Grep]
# personality: default  # identity feed a fresh conversation boots from (identities/<name>/);
                        # a property of the TYPE, not the conversation. Absent ⇒ 'default'.
`;

export function seedSkeletons({
  repoDir = REPO_SKELETONS_DIR,
  profileSkeletonsDir = PROFILE_SKELETONS_DIR,
  agentsDir = PROFILE_AGENTS_DIR,
  io = {},
  onLog = () => {},
} = {}) {
  const exists = io.existsSync ?? existsSync;
  const readDir = io.readdirSync ?? readdirSync;
  const readFile = io.readFileSync ?? readFileSync;
  const writeFile = io.writeFileSync ?? writeFileSync;
  const mkdir = io.mkdirSync ?? mkdirSync;

  // Write dest ONLY when it does not already exist. Returns true iff it wrote.
  const copyIfMissing = (dest, produce) => {
    try {
      if (exists(dest)) return false;                          // never touch an operator's file
      mkdir(dirname(dest), { recursive: true });
      writeFile(dest, produce());
      onLog(`seeded ${dest}`);
      return true;
    } catch (e) { onLog(`seed ${dest}: ${e?.message ?? e}`); return false; }
  };

  // 1. every repo skeleton → the profile's skeletons/ (files only).
  let names = [];
  try { names = readDir(repoDir); } catch { names = []; }
  for (const name of names) {
    if (typeof name !== 'string' || !name.endsWith('.yaml') && !name.endsWith('.md')) continue;
    copyIfMissing(join(profileSkeletonsDir, name), () => readFile(join(repoDir, name), 'utf8'));
  }

  // 2. the commented example agent-type file.
  copyIfMissing(join(agentsDir, 'sonnet-high.yaml'), () => EXAMPLE_TYPE_FILE);

  // 3. the WORKING egpt agent-type file (UNcommented) so agents.egpt.configuration: egpt
  //    resolves from the profile the operator can open; copy-if-missing keeps edits sacred.
  //    (The old default.yaml was renamed to egpt.yaml 2026-07-02 — we do NOT recreate it.)
  copyIfMissing(join(agentsDir, 'egpt.yaml'), () => EGPT_TYPE_FILE);
}
