// seed.mjs — make the PROFILE the operator-facing home (operator 2026-07-02). At
// boot we copy the repo's shipped skeletons into ~/.egpt2/config/skeletons/, the shipped
// brain defs + personalities (config/skeletons/agents/) into ~/.egpt2/config/agents/, and
// drop a commented example agent-type file there too, so an operator editing their profile
// has the paste-ready templates right there.
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
// Identities are FLAT .md files, and they live under the AGENTS dir (operator 2026-09-10:
// an identity is a property of the agent) — config/agents/identities/<name>.md.
export const PROFILE_IDENTITIES_DIR = join(EGPT_HOME, 'config', 'agents', 'identities');

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
# allowed_tools:        # list tools explicitly (CONFINED) — e.g. [Read, Edit, Grep]. "all"/"*" is NOT a
#                       # superpower: it is silently COERCED to the eight default tools (operator 2026-07-03).
#                       # The FULL grantable vocabulary is enumerated, commented out, in egpt.yaml beside this file.
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
allowed_tools:        # list tools explicitly. A LIST = CONFINED (file tools path-limited to the conversation dir + allowed_paths).
                      # \`all\`/\`*\` is NOT a superpower: it is silently COERCED to exactly the eight below (operator 2026-07-03).
  - Read           # read files
  - Write          # create / overwrite files
  - Edit           # in-place edits
  - Glob           # find files by pattern
  - Grep           # search file contents
  - WebSearch      # web search
  - WebFetch       # fetch a URL — http:// is auto-upgraded to https://, so plain-HTTP localhost ports are unreachable
  - Task           # sub-agents (the CLI's older name for Agent; both names work)
  # ─── EVERYTHING ELSE THAT IS GRANTABLE — uncomment a line to turn it on ───
  # These are the Claude Code CLI's own tool names (what \`--allowedTools\` accepts); there is no
  # other vocabulary. Full reference: https://code.claude.com/docs/en/tools-reference
  #- MultiEdit               # several edits to ONE file in a single call (write-class)
  #- NotebookEdit            # edit Jupyter .ipynb cells (write-class)
  #- Bash(git:*)             # SCOPED shell — the house rule is Bash(<bin>:*), NEVER bare Bash
  #- PowerShell(Get-ChildItem *)  # scoped PowerShell, same shape as Bash(...) — Windows-only tool
  #- Monitor                 # run a command in the background, streaming each output line back; scoped by the Bash(...) rules
  #- LSP                     # language-server smarts: jump to definition, find references, type errors
  #- Agent                   # sub-agents under the CLI's current name — the SAME tool as Task above; grant one
  #- Skill                   # run a skill by name; Skill(deploy *) narrows it to some skills
  #- Workflow                # run a dynamic workflow (a script that fans work out to many sub-agents)
  #- TaskCreate              # session to-do list: add an item
  #- TaskUpdate              # ...update / complete / delete one
  #- TaskList                # ...list them
  #- TaskGet                 # ...read one in full
  #- TaskStop                # stop a running background task or named agent
  #- TodoWrite               # the OLD one-call to-do list; off by default since CLI 2.1.142
  #- ToolSearch              # load deferred MCP tools on demand (needs MCP tool-search enabled)
  #- ListMcpResourcesTool    # list resources exposed by connected MCP servers
  #- ReadMcpResourceTool     # read one MCP resource by URI
  #- WaitForMcpServers       # wait for an MCP server that is still connecting
  #- Artifact                # publish an .html/.md file as a private page on claude.ai (paid plan + /login)
  #- EnterWorktree           # create/enter an isolated git worktree
  #- ExitWorktree            # ...and come back out of it
  #- EnterPlanMode           # switch into plan mode before acting
  #- ExitPlanMode            # present the plan and leave plan mode
  # Real tool names, but INERT in a headless chat turn — nobody is at a terminal and the spine
  # owns the turn's lifetime: AskUserQuestion, EndConversation, PushNotification, SendUserFile,
  # SendMessage, RemoteTrigger, ScheduleWakeup, CronCreate, CronList, CronDelete, ReportFindings,
  # ShareOnboardingGuide, TaskOutput.
  # NOT IN THE VOCABULARY: there is no CDP / drive-a-real-browser tool and no "execution power"
  # beyond the two shells above — driving Chrome on :9221 needs a WebSocket and no tool speaks one.
  # An MCP server's tools are grantable as mcp__<server>__<tool>, but this engine runs with
  # --setting-sources '' so no MCP server is inherited from ~/.claude; there are none to grant.
allowed_paths:
  # by default agents can access their conversation directory (the one listed in
  # conversations.yaml) — that root is granted automatically. Add extra roots here:
  #  /c/Users/you/project:               # full access (read + write)
  #  /c/Users/you/reference:             # READ-ONLY — a per-path list with NO write-class tool
  #    allowed_tools: [Read, Glob, Grep] #   (write-class = Edit / Write / MultiEdit / NotebookEdit)
# personality: egpt  # identity feed a fresh conversation boots from
                        # (config/agents/identities/<name>.md); a property of the TYPE,
                        # not the conversation. Absent ⇒ 'egpt'.
`;

export function seedSkeletons({
  repoDir = REPO_SKELETONS_DIR,
  profileSkeletonsDir = PROFILE_SKELETONS_DIR,
  agentsDir = PROFILE_AGENTS_DIR,
  identitiesDir = PROFILE_IDENTITIES_DIR,
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

  // 1b. the room template (config/skeletons/room/*.md) — the SHARED identity/pointers/rules
  //     feed layers (operator 2026-07-03). Copy-if-missing into the profile so the operator
  //     can edit the eGPT default + the shared pointers/rules right in their profile; a fresh
  //     profile falls back to the repo's shipped template until seeded.
  let roomNames = [];
  try { roomNames = readDir(join(repoDir, 'room')); } catch { roomNames = []; }
  for (const name of roomNames) {
    if (typeof name !== 'string' || !name.endsWith('.md')) continue;
    copyIfMissing(join(profileSkeletonsDir, 'room', name), () => readFile(join(repoDir, 'room', name), 'utf8'));
  }

  // 1c. the shipped BRAIN DEFS (config/skeletons/agents/*.yaml) → config/agents/<name>.yaml,
  //     the canonical home a string `configuration:` resolves against. Each is a live
  //     three-field def (type/model/effort) — the model × effort grid an operator points an
  //     agent at without writing one. Runs BEFORE step 2 so the live sonnet-high def wins the
  //     name it shares with the commented example (which parses to null and would make
  //     `configuration: sonnet-high` resolve to nothing on a fresh profile).
  let defNames = [];
  try { defNames = readDir(join(repoDir, 'agents')); } catch { defNames = []; }
  for (const name of defNames) {
    if (typeof name !== 'string' || !name.endsWith('.yaml')) continue;
    copyIfMissing(join(agentsDir, name), () => readFile(join(repoDir, 'agents', name), 'utf8'));
  }

  // 1d. the shipped PERSONALITIES (config/skeletons/agents/identities/*.md) → the FLAT
  //     config/agents/identities/<name>.md an agent's `personality:` names. Identities ship
  //     ONE way — as files here; they used to ALSO live as a JS object literal in this module
  //     (PRESET_IDENTITIES), which was a second channel for the same artifact.
  let idNames = [];
  try { idNames = readDir(join(repoDir, 'agents', 'identities')); } catch { idNames = []; }
  for (const name of idNames) {
    if (typeof name !== 'string' || !name.endsWith('.md')) continue;
    copyIfMissing(join(identitiesDir, name), () => readFile(join(repoDir, 'agents', 'identities', name), 'utf8'));
  }

  // 2. the commented example agent-type file.
  copyIfMissing(join(agentsDir, 'sonnet-high.yaml'), () => EXAMPLE_TYPE_FILE);

  // 3. the WORKING egpt agent-type file (UNcommented) so agents.egpt.configuration: egpt
  //    resolves from the profile the operator can open; copy-if-missing keeps edits sacred.
  //    (The old default.yaml was renamed to egpt.yaml 2026-07-02 — we do NOT recreate it.)
  copyIfMissing(join(agentsDir, 'egpt.yaml'), () => EGPT_TYPE_FILE);
}
