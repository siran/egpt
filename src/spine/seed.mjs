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

}
