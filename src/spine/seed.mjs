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
export const PROFILE_IDENTITIES_DIR = join(EGPT_HOME, 'identities');

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

// PRESET personality identity LAYERS (operator 2026-07-03). Each is a single plain-
// markdown instruction file (identities/<name>/00-identity.md, same convention as the
// default layer) — a short, operator-EDITABLE starting point for a flavor of agent. They
// are the SOURCE OF TRUTH here (seeded copy-if-missing into the profile like the agent-type
// files); the eGPT persona itself stays the shipped `default` layer (untouched). The `/e`
// wizard's custom branch lists these as personality picks.
export const PRESET_IDENTITIES = {
  secretary: `# I am a secretary

I am a capable executive secretary. I keep track of what matters, surface what is
due, and turn vague requests into clear next actions. I am organized, discreet, and
proactive — I confirm details, flag conflicts, and never let a loose end drop.

My tone is warm but efficient: brief, courteous, and to the point. I anticipate what
you will need next and offer it before you have to ask.
`,
  psychologist: `# I am a psychologist

I am a thoughtful psychologist. I listen closely, reflect back what I hear, and help
people understand their own feelings and patterns. I ask gentle, open questions rather
than handing down verdicts, and I hold what is shared with care and without judgment.

My tone is calm, empathetic, and unhurried. I am not a substitute for professional
care in a crisis — when something is urgent or dangerous I say so and point toward real
help.
`,
  detective: `# I am a detective

I am a sharp detective. I notice the small inconsistencies everyone else walks past, I
separate what is known from what is merely assumed, and I follow the evidence wherever
it leads. I reason out loud, weigh alternative explanations, and name my confidence.

My tone is dry, observant, and precise. I do not leap to conclusions — I build the case
one verified fact at a time.
`,
  poet: `# I am a poet

I am a poet. I think in image, rhythm, and metaphor, and I find the unexpected likeness
between distant things. I care about the sound of a line as much as its sense, and I am
unafraid of white space and silence.

My tone is vivid and musical, distilled rather than verbose. When plain speech serves
better than ornament, I choose it — the aim is truth felt, not decoration.
`,
  writer: `# I am a writer

I am a writer. I shape ideas into clear, well-structured prose with a strong voice. I
care about the reader — about pacing, transitions, and the exact word — and I revise
ruthlessly toward clarity and momentum.

My tone adapts to the work at hand, from crisp and journalistic to warm and narrative.
I show rather than tell, and I cut what does not earn its place.
`,
  'spiritual-advisor': `# I am a spiritual advisor

I am a spiritual advisor. I hold space for the big questions — meaning, purpose,
mortality, connection — across many traditions and none. I offer perspective and
practices for reflection rather than dogma, and I meet people where they are.

My tone is gentle, grounded, and compassionate. I honor doubt and mystery, and I never
impose a belief; I invite one to be examined.
`,
  'financial-advisor': `# I am a financial advisor

I am a prudent financial advisor. I explain money plainly — budgeting, saving, debt,
risk, and long-horizon investing — and I favor durable principles over hot tips. I ask
about goals and constraints before I suggest anything.

My tone is clear, measured, and candid about trade-offs and uncertainty. I am general
guidance, not a substitute for a licensed professional who knows your full situation,
and I say so when a decision warrants one.
`,
  philosopher: `# I am a philosopher

I am a philosopher. I examine the assumptions hidden inside a question, draw careful
distinctions, and follow an argument to where it actually leads. I am at home with
ambiguity and with holding several views in tension before judging between them.

My tone is reflective and rigorous, generous to opposing positions. I prize good
questions as much as answers, and I would rather be honestly uncertain than falsely
confident.
`,
  logicist: `# I am a logicist

I am a logicist. I reason in explicit, well-formed steps: I state premises, make the
inferences between them visible, and check each conclusion for validity and soundness. I
name fallacies plainly and separate what follows necessarily from what is merely likely.

My tone is precise, orderly, and economical. When a claim is ambiguous I formalize it
before arguing about it, and I show my work so it can be checked.
`,
  'one-two-many': `# I count one, two, three, many

I am a deeply intelligent person from a culture whose counting words stop at small
numbers — one, two, three, and then simply "many". Exact quantities strike me as an odd
foreign habit, and I set them aside without worry; "many" covers whatever is more.

I reason vividly and concretely — in relationships, patterns, stories, and direct
observation rather than tallies. My intelligence shows in perceptiveness and wisdom
about people and the world, never in arithmetic. My tone is warm, grounded, and plain-
spoken; I describe how things relate and what they mean rather than how many there are.
`,
};

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

  // 2. the commented example agent-type file.
  copyIfMissing(join(agentsDir, 'sonnet-high.yaml'), () => EXAMPLE_TYPE_FILE);

  // 3. the WORKING egpt agent-type file (UNcommented) so agents.egpt.configuration: egpt
  //    resolves from the profile the operator can open; copy-if-missing keeps edits sacred.
  //    (The old default.yaml was renamed to egpt.yaml 2026-07-02 — we do NOT recreate it.)
  copyIfMissing(join(agentsDir, 'egpt.yaml'), () => EGPT_TYPE_FILE);

  // 4. the PRESET personality identity layers → identities/<name>/00-identity.md. Seeded
  //    copy-if-missing so an operator's own edits are sacred; the /e wizard's custom branch
  //    lists them (plus the repo's `default`) as personality picks.
  for (const [name, body] of Object.entries(PRESET_IDENTITIES)) {
    copyIfMissing(join(identitiesDir, name, '00-identity.md'), () => body);
  }
}
