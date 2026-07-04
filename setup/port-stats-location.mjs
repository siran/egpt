#!/usr/bin/env node
// port-stats-location.mjs — ONE-SHOT: relocate the per-conversation stats from INSIDE the
// being's writable conv dir (conversations/<surface>/<slug>/stats.yaml) to the spine-owned
// state root (state/stats/<surface>/<chatId>.yaml), then derive the per-CONTACT rollup files
// (state/stats/<surface>/<sanitized-senderId>.yaml).
//
// Why (operator 2026-07-04): stats.yaml used to sit in the warm claude process's CONFINED cwd
// — the being's OWN sandbox, where its file tools can read/tamper/race the spine's bookkeeping.
// Stats are SPINE-owned records, so they now live under state/ (unreachable by a conversation's
// --cwd/--add-dir grant). This port moves the existing files in one pass, without waiting for
// traffic to re-write each one at its new location.
//
// KEY FINDING (verified in the codebase, encoded here so the script stays honest): the OLD
// location is what the LIVE code has ALWAYS written to — slugDir(surface, slug) + '/stats.yaml'
// (= EGPT_HOME/conversations/<surface>/<sanitizeSlug(slug)>/stats.yaml). The registry's
// per-entry `conversation_path`+`home_dir` keys are a self-describing RELOCATABLE POINTER ONLY
// (conversations-state.mjs:96-110) — NOTHING in the codebase ever expands them back into a real
// path; resolution ALWAYS runs through EGPT_HOME + slugDir. So this script does the same: it
// calls slugDir(surface, entry.slug), never a hand-rolled conversation_path expansion.
//
// The NEW per-chat file is keyed by the registry KEY (the jid / chat id being iterated) — the
// already-filename-safe short Beeper room token — matching where the live spine now writes
// (statsPath). Sender ids CAN carry ':' (Matrix user ids on other homeservers), so the
// per-contact filename is run through sanitizeStatKey (same helper the live collector uses).
//
// Idempotent: a second run re-does nothing (old already gone → skip; the rollup recomputes the
// SAME bytes from the same per-chat data). Dependency-light (conversations-state.mjs + `yaml`
// + node builtins), mirroring setup/port-explicit-tools.mjs. The orchestrator runs it stopped.
//
// Usage:  node setup/port-stats-location.mjs [conversations.yaml path]   # defaults to CONV_YAML_PATH
import { pathToFileURL } from 'node:url';
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir, rm as fsRm, readdir as fsReaddir, rename as fsRename } from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import {
  CONV_YAML_PATH, readState, slugDir, sanitizeStatKey, mergeStats,
  statsDir, unsanitizeStatKey, KNOWN_SURFACES, resolveStatFilename,
} from '../conversations-state.mjs';
import { sanitizeSlug } from '../src/sanitize.mjs';

// Headers mirror conversations-state's STATS_HEADER / CONTACT_STATS_HEADER (not exported —
// they self-heal onto the file on the first live read-merge-write anyway; kept here so a
// freshly-ported file already reads like a live one).
const CHAT_HEADER = '# per-chat stats (spine-written — do not edit)\n';
const CONTACT_HEADER = '# per-contact cross-chat stats (spine-written — do not edit)\n';

// Default resolvers: the REAL frozen (EGPT_HOME-keyed) module locations. OLD stats file =
// slugDir(...)+/stats.yaml (the only location live code ever used). NEW chat/contact files are
// the ID-BASED basenames — the move+backfill passes work in id-space (the live code no longer
// does, but the rename pass runs LAST to give each file its human name; keeping move/backfill
// id-based means those passes never have to resolve). The rename pass uses resolveStatFilename
// directly, keyed off statsSurfaceDir.
const defaultPaths = {
  oldStatsFile: (surface, slug) => join(slugDir(surface, slug), 'stats.yaml'),
  chatFile: (surface, chatId) => join(statsDir(surface), `${chatId}.yaml`),
  contactFile: (surface, senderId) => join(statsDir(surface), `${sanitizeStatKey(senderId)}.yaml`),
  statsSurfaceDir: (surface) => statsDir(surface),
};

const defaultIo = {
  readFile: fsReadFile, writeFile: fsWriteFile, mkdir: fsMkdir, rm: fsRm, existsSync: fsExistsSync,
  readdir: fsReaddir, rename: fsRename,
};

// Root-override resolvers (testability, item 6): point every path under an explicit profile
// root WITHOUT mutating process.env.EGPT_HOME. These MIRROR slugDir/statsPath/contactStatsPath
// (see room-core ConversationRoom.baseDir = join(EGPT_HOME,'conversations',surface,sanitizeSlug(slug))
// and conversations-state.statsDir = join(EGPT_HOME,'state','stats',surface)); used only by the
// root-override branch of main() + the dry-run, never by a default (production) run.
export function pathsForRoot(root) {
  return {
    oldStatsFile: (surface, slug) => join(root, 'conversations', surface, sanitizeSlug(slug), 'stats.yaml'),
    chatFile: (surface, chatId) => join(root, 'state', 'stats', surface, `${chatId}.yaml`),
    contactFile: (surface, senderId) => join(root, 'state', 'stats', surface, `${sanitizeStatKey(senderId)}.yaml`),
    statsSurfaceDir: (surface) => join(root, 'state', 'stats', surface),
  };
}

// Merge two member blocks taking the MAX count + the LATEST last_seen per sender. This is the
// OLD/NEW SAME-chat-file merge (the same chat existed in both old and new locations — max
// avoids double-counting a sender that appears in both), NOT the cross-chat rollup (which SUMS
// disjoint per-chat tallies — see deriveContactRollups). ISO timestamps compare lexically.
function mergeMembersMaxLatest(a, b) {
  const out = {};
  for (const src of [a, b]) {
    if (!src || typeof src !== 'object') continue;
    for (const [id, v] of Object.entries(src)) {
      const count = Number(v?.count) || 0;
      const ls = v?.last_seen ?? null;
      const cur = out[id] ?? { count: 0, last_seen: null };
      cur.count = Math.max(cur.count, count);
      if (ls && (!cur.last_seen || String(ls) > String(cur.last_seen))) cur.last_seen = ls;
      out[id] = cur;
    }
  }
  return out;
}

// Fold an OLD stats object into an already-present NEW one: union threads by id + fill absent
// scalars (new wins — mergeStats), then MAX/LATEST-merge the members block.
function mergeOldIntoNew(newContent, oldContent) {
  const merged = mergeStats(newContent, oldContent);
  const members = mergeMembersMaxLatest(newContent?.members, oldContent?.members);
  if (Object.keys(members).length) merged.members = members;
  return merged;
}

// Every primary (non-alias, slug-bearing) contact entry across all surfaces — the units to move.
function* primaryEntries(state) {
  for (const [surface, bucket] of Object.entries(state?.contacts ?? {})) {
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    for (const [chatId, entry] of Object.entries(bucket)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.aliasOf || !entry.slug) continue;
      yield { surface, chatId, slug: entry.slug };
    }
  }
}

// The core, testable transform. Moves every per-chat stats file old→new (merge if both exist),
// then derives the per-contact rollups from the resulting per-chat member blocks. Injectable
// `paths` + `io` so a test/dry-run can point it at a scratch dir with no env mutation.
export async function portStatsLocation(state, { paths = defaultPaths, io = defaultIo } = {}) {
  const readFile = io.readFile ?? defaultIo.readFile;
  const writeFile = io.writeFile ?? defaultIo.writeFile;
  const mkdir = io.mkdir ?? defaultIo.mkdir;
  const rm = io.rm ?? defaultIo.rm;
  const existsSync = io.existsSync ?? defaultIo.existsSync;

  const parseYaml = async (fp) => { try { return YAML.parse(await readFile(fp, 'utf8')) ?? {}; } catch { return {}; } };

  let moved = 0, merged = 0, skipped = 0, contactsWritten = 0;
  const entries = [...primaryEntries(state)];

  // ── Pass 1: MOVE each per-chat stats file old → new (merge conservatively on collision). ──
  for (const { surface, chatId, slug } of entries) {
    const oldFp = paths.oldStatsFile(surface, slug);
    if (!existsSync(oldFp)) { skipped++; continue; }   // already moved (new present) or never existed (both absent)
    const oldContent = await parseYaml(oldFp);
    // Where does this chat's data currently live at the new location? A PRIOR run may have
    // renamed the new file to its human name (rename pass), so resolve by body chat_id (read-
    // only) instead of assuming the id-only basename — otherwise a reappearing old file would
    // be moved into a NEW duplicate id-only file alongside the already-correctly-named one.
    // Falls back to the id-only basename when nothing on disk holds this chat_id yet (first run,
    // or an unstamped id-only file — caught by existsSync below and merged, not duplicated).
    const dir = paths.statsSurfaceDir(surface);
    const { path: newFp } = await resolveStatFilename({ dir, idField: 'chat_id', id: chatId, name: undefined, io, rename: false });
    let finalContent;
    if (existsSync(newFp)) { finalContent = mergeOldIntoNew(await parseYaml(newFp), oldContent); merged++; }
    else { finalContent = oldContent; moved++; }
    await mkdir(dirname(newFp), { recursive: true });
    await writeFile(newFp, CHAT_HEADER + YAML.stringify(finalContent), 'utf8');
    await rm(oldFp, { force: true });   // move = copy-then-delete
  }

  // ── Pass 2: DERIVE per-contact rollups from the (now relocated) per-chat member blocks. ──
  // Per surface, per sender: count = SUM across every chat (disjoint per-chat tallies → their
  // sum IS the sender's true cross-chat total), last_seen = the LATEST across those chats. No
  // `name` — the old per-chat member blocks carry none to backfill; name only starts populating
  // going forward via live ev.senderName. Recomputing from current per-chat data = idempotent.
  const bySurface = new Map();   // surface -> Map<chatId, slug present?>  (we only need the chatIds)
  for (const { surface, chatId } of entries) {
    if (!bySurface.has(surface)) bySurface.set(surface, new Set());
    bySurface.get(surface).add(chatId);
  }
  for (const [surface, chatIds] of bySurface) {
    const dir = paths.statsSurfaceDir(surface);
    const rollup = {};   // senderId -> { count, last_seen }
    for (const chatId of chatIds) {
      // Read via resolve (by body chat_id) so a chat file already renamed to its human name (a
      // prior run's rename pass) is still found — reading the id-only path would miss it and
      // drop that chat's members from the rollup. Falls back to the id-only path when unstamped.
      const { path: chatFp } = await resolveStatFilename({ dir, idField: 'chat_id', id: chatId, name: undefined, io, rename: false });
      const members = (await parseYaml(chatFp))?.members;
      if (!members || typeof members !== 'object') continue;
      for (const [senderId, v] of Object.entries(members)) {
        const acc = rollup[senderId] ?? { count: 0, last_seen: null };
        acc.count += Number(v?.count) || 0;
        const ls = v?.last_seen ?? null;
        if (ls && (!acc.last_seen || String(ls) > String(acc.last_seen))) acc.last_seen = ls;
        rollup[senderId] = acc;
      }
    }
    for (const [senderId, acc] of Object.entries(rollup)) {
      const fp = paths.contactFile(surface, senderId);
      await mkdir(dirname(fp), { recursive: true });
      await writeFile(fp, CONTACT_HEADER + YAML.stringify(acc), 'utf8');
      contactsWritten++;
    }
  }

  return { moved, merged, skipped, contactsWritten };
}

// ── BACKFILL: stamp chat_id / sender_id onto stats files that already exist without them
// (operator 2026-07-04 defect: files self-identify only via their opaque filename, not their
// body). Deliberately separate from portStatsLocation above — this runs over WHATEVER is
// currently at the new location (whether portStatsLocation just wrote it or it's been there
// since an earlier run), so main() runs the two passes back-to-back and nothing is missed.
// Idempotent: a file that already carries its id field is left byte-for-byte untouched (no
// read+rewrite), so a second run touches nothing.
export async function backfillStatsIds(state, { paths = defaultPaths, io = defaultIo } = {}) {
  const readFile = io.readFile ?? defaultIo.readFile;
  const writeFile = io.writeFile ?? defaultIo.writeFile;
  const readdirFn = io.readdir ?? defaultIo.readdir;
  const existsSync = io.existsSync ?? defaultIo.existsSync;

  let chatsStamped = 0, contactsStamped = 0, skipped = 0;

  for (const surface of KNOWN_SURFACES) {
    const dir = paths.statsSurfaceDir(surface);
    if (!existsSync(dir)) continue;
    const chatIds = new Set(Object.keys(state?.contacts?.[surface] ?? {}));
    let names;
    try { names = await readdirFn(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.yaml')) continue;
      const base = name.slice(0, -'.yaml'.length);
      const fp = join(dir, name);
      let content;
      try { content = YAML.parse(await readFile(fp, 'utf8')) ?? {}; } catch { continue; }
      // Already self-identifying (chat OR contact) → leave byte-for-byte. Checked BEFORE the
      // filename-based classification because a later run sees files under their HUMAN names
      // (rename pass) whose base no longer matches a registry key — the id in the BODY is the
      // anchor, so a stamped chat file must not be re-misclassified as a contact and re-stamped.
      if (content.chat_id || content.sender_id) { skipped++; continue; }
      // Unstamped → still id-based (rename runs AFTER backfill), so the filename classifies it:
      // a registry chat key ⇒ chat file (chat_id = the key); else ⇒ contact file (sender_id =
      // the real unsanitized id recovered from the sanitized base).
      if (chatIds.has(base)) {
        await writeFile(fp, CHAT_HEADER + YAML.stringify({ chat_id: base, ...content }), 'utf8');
        chatsStamped++;
      } else {
        await writeFile(fp, CONTACT_HEADER + YAML.stringify({ sender_id: unsanitizeStatKey(base), ...content }), 'utf8');
        contactsStamped++;
      }
    }
  }
  return { chatsStamped, contactsStamped, skipped };
}

// ── RENAME: give each id-based/garbled stats filename its natural, HUMAN-READABLE name from the
// body's `name:` field (operator 2026-07-04: "filenames must become human-readable"). A PURE
// filesystem rename — the body bytes are otherwise UNTOUCHED and NO former_names entry is ever
// added (the name was correct all along; only the FILENAME was garbled). Reuses resolveStatFilename
// so the offline port and the live writers share ONE resolve/rename algorithm (no drift). Runs
// LAST in main() — after backfill has stamped chat_id/sender_id, which is what resolve keys off.
// Idempotent: a file already at its canonical name fast-paths to a no-op (renamedFrom = null).
// `state` is unused (the surface dirs are the units) but kept for main()'s uniform (state, opts)
// call shape.
export async function renameStatsToNames(_state, { paths = defaultPaths, io = defaultIo } = {}) {
  const readFile = io.readFile ?? defaultIo.readFile;
  const readdirFn = io.readdir ?? defaultIo.readdir;
  const existsSync = io.existsSync ?? defaultIo.existsSync;
  let renamed = 0, skipped = 0;
  for (const surface of KNOWN_SURFACES) {
    const dir = paths.statsSurfaceDir(surface);
    if (!existsSync(dir)) continue;
    let names;
    try { names = await readdirFn(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.yaml')) continue;
      let body;
      try { body = YAML.parse(await readFile(join(dir, name), 'utf8')) ?? {}; } catch { continue; }
      const idField = body.chat_id ? 'chat_id' : (body.sender_id ? 'sender_id' : null);
      const displayName = body.name;
      if (!idField || !displayName) { skipped++; continue; }   // unstamped, or no natural name → leave id-based
      const { renamedFrom } = await resolveStatFilename({ dir, idField, id: body[idField], name: displayName, io, rename: true });
      if (renamedFrom) renamed++; else skipped++;              // already at its canonical name → no-op
    }
  }
  return { renamed, skipped };
}

async function main({ path, root } = {}) {
  const paths = root ? pathsForRoot(root) : undefined;
  const yamlPath = path ?? (root ? join(root, 'config', 'conversations.yaml') : CONV_YAML_PATH);
  const state = await readState(yamlPath);
  const result = await portStatsLocation(state, paths ? { paths } : {});
  console.log(`port-stats-location: from ${yamlPath}`);
  console.log(`  chat files moved:    ${result.moved}`);
  console.log(`  chat files merged:   ${result.merged}`);
  console.log(`  chat files skipped:  ${result.skipped}`);
  console.log(`  contact files written: ${result.contactsWritten}`);
  const backfill = await backfillStatsIds(state, paths ? { paths } : {});
  console.log(`  chat ids backfilled:    ${backfill.chatsStamped}`);
  console.log(`  sender ids backfilled:  ${backfill.contactsStamped}`);
  console.log(`  already had id:         ${backfill.skipped}`);
  const renamePass = await renameStatsToNames(state, paths ? { paths } : {});
  console.log(`  files renamed to human names: ${renamePass.renamed}`);
  console.log(`  files left id-based:          ${renamePass.skipped}`);
  return { ...result, backfill, rename: renamePass };
}

// Run only when invoked directly (so the exports import cleanly in tests). A positional arg is
// the conversations.yaml path (defaults to CONV_YAML_PATH under the live EGPT_HOME).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main({ path: process.argv[2] });
}

export { main };
