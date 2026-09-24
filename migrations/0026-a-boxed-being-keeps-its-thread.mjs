// 0026 — a being moved into the box keeps its thread.
//
// THE DEFECT, measured on do 2026-09-24 00:12. 0025/33c9eb5 moved `don` from `regular` to
// `sandbox`. A boxed turn runs the CLI with CLAUDE_CONFIG_DIR=~/.egpt-jsonl/<threadId>
// (src/sandbox-cli-session.mjs), so the CLI looks for its session under THAT root. The thread it
// was told to resume had been written unboxed, into the operator's ~/.claude/projects. So
// `--resume` found nothing ("No conversation found with session ID: 915d6617-…"), and brainpool's
// dead-session backstop answered from a blank thread. The file was still there, one root over.
//
// AT RISK when this was written (read-only, resolved exactly as below): do 17 threads, all `don`;
// kg 1, `egpt`. Operator: "we need to fix: On do, the first sandboxed turn loses the being's thread."
//
// WHAT IT DOES. For every recorded thread whose being resolves BOXED, and whose session file is in
// ~/.claude/projects but not yet anywhere in its own store, it COPIES the file into
// ~/.egpt-jsonl/<threadId>/projects/<the same folder>/, with the session's sibling folder
// (<threadId>/: subagents, tool results) when it has one.
//   - COPY, NEVER MOVE: the ~/.claude file is the record the thread was written into. After this
//     nothing reads it for that thread (the box reads the store), so leaving it costs disk only.
//   - NEVER OVERWRITE: a store that already holds the thread, in any folder, is left alone, and
//     each file is copied COPYFILE_EXCL. The sibling folder goes first and the .jsonl last, so the
//     .jsonl's presence - which is what makes this satisfied - means the copy finished.
//
// FOUND BY ID, NEVER BY THE GROUP'S NAME (operator ruling 2026-09-24): findThreadJsonl scans
// projects/*/<threadId>.jsonl. Claude Code files a session under a folder named after its cwd, the
// cwd is the Room, and the Room carries the group's name, which changes. The folder name is only
// CARRIED ACROSS, never computed. It is the right name in the store because the boxed CLI names
// the folder the same way: its cwd is a junction onto the Room, and the store it wrote on do after
// 0025 is filed under the Room's own path, exactly as the unboxed one was.
//
// WHO IS BOXED is decided exactly as a turn decides it: readState's merged view (conversations,
// rooms, agents), the being's own row, its node default in config.yaml (`agents.<being>.
// conversation_defaults`), then resolveSandboxed. An unboxed being - the meta engineers, codex - is
// never copied; its thread stays where its own CLI reads it.
//
// SATISFIED, NOT REFUSED - a refusal stops every later migration on the node (setup/migrate.mjs).
// Nothing to carry is satisfied; a boxed thread with no session file anywhere is NOTED (there is
// nothing to copy). IT REFUSES only when a config file does not parse: readState would read it as
// empty, and this would report "nothing to do" over a node it could not read.
import { readFileSync, existsSync, mkdirSync, copyFileSync, cpSync, statSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as YAML from 'yaml';
import { readState, findThreadJsonl } from '../src/conversations-state.mjs';
import { resolveSandboxed } from '../src/spine/brainpool.mjs';
import { jsonlStoreDirOf } from '../src/sandbox-cli-session.mjs';

export const elevated = false;
export const summary = "a being moved into the box keeps its thread: a boxed being's session file that is still only in ~/.claude is copied, found by id, into its own ~/.egpt-jsonl store";

const CONFIG_FILES = ['config.yaml', 'conversations.yaml', 'rooms.yaml', 'agents.yaml'];

function readYaml(file) {
  if (!existsSync(file)) return null;
  try { return YAML.parse(readFileSync(file, 'utf8')) ?? {}; } catch (e) {
    throw new Error(`0026: ${file} does not parse (${e.message}) - refusing: which beings are boxed cannot be read from it`);
  }
}

// PURE BUT FOR READS. The roots are parameters so a test never reads a real profile; plan() hands
// in the operator's own (homedir(), exactly as the spine resolves both).
export async function threadsToCarry({ egptHome, platform, claudeProjects, storeRoot }) {
  const cfgDir = join(egptHome, 'config');
  const parsed = Object.fromEntries(CONFIG_FILES.map((f) => [f, readYaml(join(cfgDir, f))]));
  const cfg = parsed['config.yaml'] ?? {};
  const state = await readState(join(cfgDir, 'conversations.yaml'));
  const carry = new Map();
  const missing = new Map();
  for (const [surface, bucket] of Object.entries(state?.contacts ?? {})) {
    for (const [slug, entry] of Object.entries(bucket ?? {})) {
      for (const [being, b] of Object.entries(entry?.agents ?? {})) {
        const threadId = typeof b?.threadId === 'string' ? b.threadId.trim() : '';
        if (!threadId || carry.has(threadId) || missing.has(threadId)) continue;
        const def = cfg?.agents?.[being]?.conversation_defaults ?? {};
        const accessLevel = b.access_level ?? def.access_level ?? 'sandbox';
        const boxed = resolveSandboxed({ accessLevel, conversationValue: b.sandboxed ?? null, agentDefaultValue: def.sandboxed ?? null, platform });
        if (!boxed) continue;
        const storeDir = jsonlStoreDirOf(threadId, { jsonlStoreRoot: storeRoot });
        if (findThreadJsonl(threadId, [], { projectsRoot: join(storeDir, 'projects') })) continue;
        const where = `${surface}/${slug}`;
        const found = findThreadJsonl(threadId, [], { projectsRoot: claudeProjects });
        if (!found) { missing.set(threadId, { threadId, being, where }); continue; }
        carry.set(threadId, {
          threadId, being, where,
          from: found.jsonlPath,
          fromDir: join(claudeProjects, found.projectDir, threadId),
          toDir: join(storeDir, 'projects', found.projectDir),
        });
      }
    }
  }
  return { carry: [...carry.values()], missing: [...missing.values()] };
}

export async function plan(ctx) {
  const home = ctx.homeDir ?? homedir();
  const { carry, missing } = await threadsToCarry({
    egptHome: ctx.egptHome, platform: ctx.platform,
    claudeProjects: join(home, '.claude', 'projects'), storeRoot: join(home, '.egpt-jsonl'),
  });
  const notes = missing.length
    ? [`${missing.length} boxed thread(s) have a session file neither in ~/.claude nor in their store - nothing to copy: ${missing.map((m) => `${m.being} ${m.threadId.slice(0, 8)}`).join(', ')}`]
    : [];
  if (!carry.length) return { satisfied: true, notes: [...notes, 'every boxed thread with a session file already has it in its own store'] };
  return {
    satisfied: false,
    notes,
    changes: carry.map((c) => `copy ${c.being}'s thread ${c.threadId} (${c.where}) from ~/.claude into ${c.toDir}`),
    apply: async () => {
      for (const c of carry) {
        mkdirSync(c.toDir, { recursive: true });
        if (existsSync(c.fromDir) && statSync(c.fromDir).isDirectory()) {
          cpSync(c.fromDir, join(c.toDir, c.threadId), { recursive: true, force: false, errorOnExist: false });
        }
        const dest = join(c.toDir, `${c.threadId}.jsonl`);
        try {
          copyFileSync(c.from, dest, constants.COPYFILE_EXCL);
        } catch (e) {
          if (e?.code !== 'EEXIST') throw e;
          ctx.log(`${dest} already exists - left as it is`);
          continue;
        }
        ctx.log(`copied ${c.being} ${c.threadId} -> ${dest}`);
      }
    },
  };
}
