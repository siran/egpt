// setup/backfill-conversations.mjs — deterministic one-shot backfill of the
// conversations.yaml registry. DRY-RUN by default; nothing is written unless you
// pass --apply. Idempotent: re-running converges.
//
//   node setup/backfill-conversations.mjs            # dry-run: show what it would do
//   node setup/backfill-conversations.mjs --apply    # write the SAFE fields
//   node setup/backfill-conversations.mjs --apply --readonly   # also write e.readonly (pins brain/model)
//
// What it determines, per primary entry (deterministic, in this order):
//   slug              — the entry's CURRENT slug (drift vs sanitizeSlug(name) is REPORTED, never auto-renamed —
//                       a rename moves the on-disk folder + invalidates the thread, too destructive for a backfill)
//   conversation_path — conversationPathOf(surface, slug)              [SAFE: written on --apply]
//   threadId          — kept; if null, the NEWEST .jsonl in ~/.claude/projects/<sanitized slugDir>/ [SAFE]
//   threadCwd         — slugDir(surface, slug), only when threadId is set and threadCwd is null [SAFE]
//   brain/model/effort/personality → e.readonly:
//       brain       = default_brain.type (canonical)
//       model       = the model recorded in the thread's .jsonl (GROUND TRUTH), else default_brain.model
//       effort      = default_brain.effort ?? per-brain default (claude-code:medium, codex:low).
//                     NOTE: effort is a launch-time knob (--effort / reasoningEffort), NOT recorded
//                     in the session .jsonl — so it can't be "recovered" from a thread the way model
//                     can. egpt only defaults codex (low); claude-code passes none → engine default.
//                     We record the per-brain default here so the registry shows a real value, not
//                     null. Change a chat's effort via the console; it doesn't alter dispatch yet.
//       personality = entry.personality ?? 'default'
//                     [PINS the chat to that brain/model — only written with --readonly]
//
// NOTE on the daemon: --apply writes the live registry. Run it with the egpt
// daemon STOPPED (or restart the daemon right after), or the daemon's in-memory
// state can overwrite the change on its next dispatch. Dry-run is always safe.

import {
  readState, writeState, CONV_YAML_PATH,
  conversationPathOf, slugDir, findThreadJsonl, KNOWN_SURFACES, sanitizeSlug,
} from '../conversations-state.mjs';
import { readConfig } from '../src/tools/config-io.mjs';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const APPLY    = process.argv.includes('--apply');
const READONLY = process.argv.includes('--readonly');

const canonicalBrain = (type) => {
  const t = String(type ?? '').toLowerCase();
  if (['ccode', 'claude-code', 'claude-sdk', 'claude'].includes(t)) return 'claude-code';
  if (t === 'codex') return 'codex';
  return t || 'claude-code';
};

// Pull the LAST recorded model out of a claude/codex session .jsonl (each assistant
// turn carries "model":"claude-haiku-…"). The last one = the model the thread is on now.
const modelFromJsonl = (jsonlPath) => {
  try {
    const txt = readFileSync(jsonlPath, 'utf8');
    const ms = [...txt.matchAll(/"model"\s*:\s*"([^"]+)"/g)];
    if (!ms.length) return null;
    const raw = ms[ms.length - 1][1].toLowerCase();
    for (const m of ['haiku', 'sonnet', 'opus', 'fable']) if (raw.includes(m)) return m;
    return ms[ms.length - 1][1];
  } catch { return null; }
};

// threadId === null but a session may exist on disk: the newest .jsonl in the
// claude project dir that maps to this slug's cwd. That's "which thread_id I'd pick".
const discoverThread = (surface, slug) => {
  const sanitized = String(slugDir(surface, slug)).replace(/[\\/:._]/g, '-');
  const dir = join(homedir(), '.claude', 'projects', sanitized);
  if (!existsSync(dir)) return null;
  try {
    let best = null, bestMt = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const mt = statSync(join(dir, f)).mtimeMs;
      if (mt > bestMt) { bestMt = mt; best = f; }
    }
    return best ? { threadId: best.replace(/\.jsonl$/, ''), jsonlPath: join(dir, best) } : null;
  } catch { return null; }
};

// Per-brain DEFAULT effort. egpt only defines codex (low); claude-code passes no
// --effort so it runs at the engine default — we record 'medium' as the established
// claude-code default so the registry shows a real value instead of null.
const BRAIN_DEFAULT_EFFORT = { 'claude-code': 'medium', codex: 'low' };

const cfg = await readConfig();
const db = cfg.default_brain ?? {};
const dbBrain = canonicalBrain(db.type);
const dbModel = db.model ?? null;
const dbEffort = db.effort ?? BRAIN_DEFAULT_EFFORT[dbBrain] ?? 'medium';

const state = await readState(CONV_YAML_PATH);
let entriesTouched = 0, fieldChanges = 0, drift = 0;

for (const surface of Object.keys(state.contacts ?? {})) {
  if (!KNOWN_SURFACES.includes(surface)) continue;
  const bucket = state.contacts[surface] ?? {};
  for (const [jid, entry] of Object.entries(bucket)) {
    if (!entry || entry.aliasOf || !entry.slug) continue;
    const slug = entry.slug;
    const patch = {};
    const notes = [];

    // slug drift (report only)
    const nameBase = sanitizeSlug(entry.pushedName);
    const curBase = String(slug).replace(/-\d{10}$/, '');
    if (nameBase && nameBase !== 'contact' && nameBase !== curBase) { drift++; notes.push(`slug drift: name "${nameBase}" vs slug "${curBase}" (NOT renamed)`); }

    // conversation_path
    const wantPath = conversationPathOf(surface, slug);
    if (entry.conversation_path !== wantPath) patch.conversation_path = wantPath;

    // threadId (discover if missing) + locate its jsonl
    let threadId = entry.threadId ?? null;
    let jsonlPath = null;
    if (threadId) {
      jsonlPath = findThreadJsonl(threadId, [slugDir(surface, slug)])?.jsonlPath ?? null;
    } else {
      const disc = discoverThread(surface, slug);
      if (disc) { threadId = disc.threadId; jsonlPath = disc.jsonlPath; patch.threadId = threadId; notes.push('threadId discovered from disk'); }
    }

    // threadCwd — only set when a thread exists and it's currently null (non-destructive)
    if (threadId && !entry.threadCwd) patch.threadCwd = slugDir(surface, slug);

    // brain/model/effort/personality → e.readonly (REPORTED always; WRITTEN only with --readonly)
    const eBlock = (entry.e && typeof entry.e === 'object') ? entry.e : null;
    const hasReadonly = eBlock?.readonly && typeof eBlock.readonly === 'object';
    const model = (jsonlPath ? modelFromJsonl(jsonlPath) : null) ?? dbModel;
    const readonly = { brain: dbBrain, model, effort: dbEffort, personality: entry.personality ?? 'default' };
    const modelSrc = jsonlPath && modelFromJsonl(jsonlPath) ? 'jsonl' : 'default_brain';
    if (!hasReadonly && READONLY) patch.e = { ...(eBlock ?? {}), mode: eBlock?.mode ?? entry.mode ?? 'mention', readonly };
    // Fill a null/missing effort on an ALREADY-written readonly (effort isn't thread-recoverable;
    // record the per-brain default so the registry shows a real value).
    else if (hasReadonly && READONLY && (eBlock.readonly.effort == null)) {
      const brainHere = canonicalBrain(eBlock.readonly.brain ?? dbBrain);
      patch.e = { ...eBlock, readonly: { ...eBlock.readonly, effort: BRAIN_DEFAULT_EFFORT[brainHere] ?? dbEffort } };
    }

    const willChange = Object.keys(patch).length > 0;
    if (willChange || !hasReadonly || notes.length) {
      entriesTouched++;
      console.log(`\n• ${slug}  [${surface}]`);
      if (patch.conversation_path) console.log(`    conversation_path → ${patch.conversation_path}`);
      if (patch.threadId)          console.log(`    threadId          → ${patch.threadId}`);
      if (patch.threadCwd)         console.log(`    threadCwd         → ${patch.threadCwd}`);
      if (!hasReadonly)            console.log(`    e.readonly        ${READONLY ? '→' : '(determined)'} ${JSON.stringify(readonly)}  [model from ${modelSrc}]`);
      else if (patch.e)            console.log(`    e.readonly.effort → ${patch.e.readonly.effort}  (filled null)`);
      else                         console.log(`    e.readonly        (already set) ${JSON.stringify(eBlock.readonly)}`);
      for (const n of notes) console.log(`    ! ${n}`);
      fieldChanges += Object.keys(patch).length;
      if (APPLY && willChange) bucket[jid] = { ...entry, ...patch };
    }
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${entriesTouched} entries reviewed · ${fieldChanges} field writes · ${drift} slug drifts`);
console.log(`readonly: ${READONLY ? 'WRITE (pins brain/model)' : 'report-only (pass --readonly to write)'}`);
if (APPLY && fieldChanges > 0) {
  await writeState(CONV_YAML_PATH, state);
  console.log(`APPLIED → ${CONV_YAML_PATH}  (restart the daemon to reload)`);
} else {
  console.log(APPLY ? 'nothing to write.' : 'DRY-RUN — pass --apply to write.');
}
