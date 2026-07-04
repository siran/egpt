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
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir, rm as fsRm } from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import {
  CONV_YAML_PATH, readState, slugDir, statsPath, contactStatsPath, sanitizeStatKey, mergeStats,
} from '../conversations-state.mjs';
import { sanitizeSlug } from '../src/sanitize.mjs';

// Headers mirror conversations-state's STATS_HEADER / CONTACT_STATS_HEADER (not exported —
// they self-heal onto the file on the first live read-merge-write anyway; kept here so a
// freshly-ported file already reads like a live one).
const CHAT_HEADER = '# <chat>.yaml — the conversation\'s stats module (spine-written)\n';
const CONTACT_HEADER = '# <sender>.yaml — the contact\'s cross-chat stats module (spine-written)\n';

// Default resolvers: the REAL frozen (EGPT_HOME-keyed) module helpers — exactly what the live
// code writes/reads. OLD stats file = slugDir(...)+/stats.yaml (the only location live code
// ever used); NEW chat file = statsPath; NEW contact file = contactStatsPath.
const defaultPaths = {
  oldStatsFile: (surface, slug) => join(slugDir(surface, slug), 'stats.yaml'),
  chatFile: (surface, chatId) => statsPath(surface, chatId),
  contactFile: (surface, senderId) => contactStatsPath(surface, senderId),
};

const defaultIo = {
  readFile: fsReadFile, writeFile: fsWriteFile, mkdir: fsMkdir, rm: fsRm, existsSync: fsExistsSync,
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
    const newFp = paths.chatFile(surface, chatId);
    const oldThere = existsSync(oldFp);
    const newThere = existsSync(newFp);
    if (!oldThere) { skipped++; continue; }   // already moved (new present) or never existed (both absent)
    const oldContent = await parseYaml(oldFp);
    let finalContent;
    if (newThere) { finalContent = mergeOldIntoNew(await parseYaml(newFp), oldContent); merged++; }
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
    const rollup = {};   // senderId -> { count, last_seen }
    for (const chatId of chatIds) {
      const members = (await parseYaml(paths.chatFile(surface, chatId)))?.members;
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
  return result;
}

// Run only when invoked directly (so the exports import cleanly in tests). A positional arg is
// the conversations.yaml path (defaults to CONV_YAML_PATH under the live EGPT_HOME).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main({ path: process.argv[2] });
}

export { main };
