// conversations-state.mjs — pure-logic module for @e's per-contact
// conversation registry and personalities.
//
// Per-contact (NOT per-JID) model: each human or group gets ONE
// contact entry, keyed by a slug (e.g., "diego", "premise-driven-bitcoin").
// Multiple WA JIDs can map to one contact (lid + phone-number form for
// the same person) — they all live in the entry's `jids` array, share
// one `threadId`, one personality.
//
// Operator (2026-05-19): registry is YAML for human readability,
// personalities are markdown files shipped with egpt + overridable in
// ~/.egpt/personalities/, all timestamps ISO 8601.
//
// This file: pure functions only — no fs/io side effects EXCEPT in
// explicit read/write helpers at the bottom that take paths. Easy to
// test, easy to call from any host.

import { readFile, writeFile, mkdir, stat, rename, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import * as YAML from 'yaml';
import { sanitizeSlug } from './src/sanitize.mjs';
import { Room } from './src/room-core.mjs';
import { EGPT_HOME } from './src/egpt-home.mjs';

const _here = dirname(fileURLToPath(import.meta.url));
const PERSONALITIES_SHIPPED_DIR  = join(_here, 'config', 'personalities');
const PERSONALITIES_OPERATOR_DIR = join(EGPT_HOME, 'personalities');
// Identity folders (operator 2026-05-26): an identity is a folder of NN-*.md
// files (NN- orders the injection); operator overrides shipped, per folder.
const IDENTITIES_SHIPPED_DIR  = join(_here, 'identities');
const IDENTITIES_OPERATOR_DIR = join(EGPT_HOME, 'identities');
// Canonical location of the per-contact YAML registry. Exported so
// daemon + slashes + tools all agree. The registry sits OUTSIDE the
// per-conversation dirs so conversation-e (cwd-locked to its own
// slug dir) can't read it.
export const CONV_YAML_PATH = join(EGPT_HOME, 'conversations.yaml');

// Known surfaces — used as the first dir level under conversations/
// and the first key level under contacts: in the YAML. Adding a new
// surface = add it here + wire its bridge in egpt.mjs.
export const KNOWN_SURFACES = ['whatsapp', 'telegram', 'shell', 'signal'];

// Per-conversation directory. Each contact gets its own folder; that
// folder is the only filesystem location conversation-e is given
// access to via --cwd / --add-dir. Layout:
//
//   ~/.egpt/conversations/<surface>/<slug>/
//     transcript.md                ← per-thread play-script log
//     daily-YYYY-MM-DD.md (opt)    ← optional daily summaries written by @e
//     media/                       ← per-chat media downloads
//
// Surface separation lets WA / TG / Signal / shell each be backed up,
// wiped, or moved without touching the others. Pre-2026-05-21 the
// layout was a flat conversations/<slug>/ (everything WA) — see
// migrateToSurfaceLayout() for the one-shot migration.
export function slugDir(surface, slug) {
  if (!surface || !KNOWN_SURFACES.includes(surface)) {
    throw new Error(`slugDir: unknown surface "${surface}" (expected one of ${KNOWN_SURFACES.join('|')})`);
  }
  // A conversation IS a Room (GENOME §2.5): delegate the path to the
  // ConversationRoom implementation so this root and the rooms root share ONE
  // tree definition. Byte-identical to the legacy formula (Phase 0c). The
  // surface check stays here (the Room API is permissive; slugDir's contract is
  // to reject unknown surfaces).
  return Room.forChat(surface, slug).baseDir();
}
export function slugTranscriptPath(surface, slug) {
  return join(slugDir(surface, slug), 'transcript.md');
}

// Per-entry STORED conversation path — relative to ~/.egpt, posix-style, so the
// registry (keyed by Beeper group id) is self-describing + portable instead of
// forcing every reader to re-derive the folder from surface+slug (operator
// 2026-06-27: "it should be STORED, of course"). Same layout slugDir produces, so
// it stays a stable pointer to the conversation's transcript.md / config / media.
const _EGPT_HOME = join(EGPT_HOME);
export function conversationPathOf(surface, slug) {
  return relative(_EGPT_HOME, slugDir(surface, slug)).split(/[\\/]/).join('/');
}

// Move a contact's on-disk slug folder old→new (transcript.md, media/, identity
// files all ride along). Used by the placeholder self-heal (ensureContact +
// migratePlaceholderSlugs). Idempotent + safe: no-op if the source is missing
// or the target already exists (NEVER clobbers — a name collision must not eat a
// transcript). Returns true only when a move actually happened.
export async function renameSlugDir(surface, oldSlug, newSlug, reason = 'name changed') {
  if (!oldSlug || !newSlug || oldSlug === newSlug) return false;
  const from = slugDir(surface, oldSlug);
  const to = slugDir(surface, newSlug);
  if (!existsSync(from) || existsSync(to)) return false;
  try {
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    await appendRenameLog(to, oldSlug, newSlug, reason);
    return true;
  }
  catch (e) { console.error(`!! renameSlugDir(${oldSlug} -> ${newSlug}): ${e?.message ?? e}`); return false; }
}

// Append a rename record into the conversation folder (operator 2026-06-14:
// "renames can be logged in conversation folder"). One line per rename, so the
// folder carries its own naming history. Best-effort — never throws into a
// dispatch/migration path.
export function renameLogLine(from, to, reason = '') {
  return `${new Date().toISOString()}  ${from}  →  ${to}${reason ? `  (${reason})` : ''}\n`;
}
export async function appendRenameLog(dir, from, to, reason = '') {
  try { await appendFile(join(dir, 'renames.log'), renameLogLine(from, to, reason), 'utf8'); }
  catch (e) { console.error(`!! appendRenameLog(${dir}): ${e?.message ?? e}`); }
}

// Pre-surface-layout slug dir — used only inside the legacy migration
// chain that operates on the flat ~/.egpt/conversations/<slug>/ shape.
// Once migrateToSurfaceLayout has run, callers use slugDir(surface, slug)
// for the new ~/.egpt/conversations/<surface>/<slug>/ shape.
function _legacySlugDir(slug) {
  return join(EGPT_HOME, 'conversations', sanitizeSlug(slug));
}

// system-e shared dir. All operator-DM contacts with personality='system'
// (WA Self DM, TG operator-bot-DM, future surfaces) share ONE conversation
// thread and ONE transcript file living here. Operator (2026-05-21):
// "system-e is a same conversation thread" across surfaces — distinct from
// per-chat conversation-e which stays surface-scoped under whatsapp/, etc.
export const SYSTEM_SLUG_DIR = join(EGPT_HOME, 'conversations', '_system', 'system-e');

// Shared system-e thread state — sits at the YAML root, sibling to
// `contacts:`. All system-personality dispatches read from / write to here
// instead of the per-contact threadId field.
//
//   system_thread:
//     threadId: <claude session id>
//     threadCreatedAt: <iso>
//     identityInjectedAt: <iso>
//     threadCwd: <override path; usually null = homedir>
export function getSystemThread(state) {
  return state?.system_thread ?? null;
}
export function setSystemThread(state, patch) {
  return { ...(state ?? {}), system_thread: { ...(state?.system_thread ?? {}), ...patch } };
}

// Per-JID media directory the bridge writes to (unchanged; for
// permissioning purposes we add it to conversation-e's --add-dir set).
export function jidMediaDir(jid) {
  const sanitized = String(jid ?? '').replace(/@/g, '_').replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(EGPT_HOME, 'media', sanitized);
}

// Best-effort reverse of claude-code's project-dir sanitization.
//
// Claude-code derives the project-dir name from cwd by mapping `\`,
// `/`, `:`, `.`, AND `_` ALL to `-`. That's many-to-one — an output
// dash could have come from any of them — so the reverse is
// fundamentally ambiguous. This function tries the obvious case
// (drive letter prefix, slash-only) but is NOT reliable when cwd
// contained `.`, `_`, or other chars that sanitize to `-`.
//
// Returns: the resolved cwd matched against `candidateCwds` when
// possible (preferred), or a heuristic guess otherwise.
//
// Callers should treat the return as a hint, not ground truth.
// The previous implementation hard-mapped every `-` to `/` and
// produced paths like `C:/Users/an//egpt/conversations/premise/driven/bitcoin/e/2605211611`
// for the cwd `C:/Users/an/.egpt/conversations/premise_driven_bitcoin_e-2605211611`
// — totally broken. Surface-layout migration now invalidates
// threadIds instead of relying on this recovery path.
export function reverseSanitizeCwd(projectDir, candidateCwds = []) {
  if (!projectDir || typeof projectDir !== 'string') return null;

  // If the host provided a list of known cwds (e.g., from the
  // conversations registry), find one whose claude-sanitized form
  // matches the project-dir. This is the only reliable reverse.
  const sanitize = (cwd) => String(cwd).replace(/[\\\/:._]/g, '-');
  for (const cwd of candidateCwds) {
    if (sanitize(cwd) === projectDir) return cwd;
  }

  // Fallback heuristic: drive-letter unambiguously maps to 'X--'.
  // The rest is unreliable, but we attempt it for the simplest case
  // (cwd with no `.` or `_`). Callers should verify the resulting
  // path exists on disk before trusting it.
  const winMatch = projectDir.match(/^([A-Za-z])--(.+)$/);
  if (winMatch) {
    return `${winMatch[1]}:/${winMatch[2].replace(/-/g, '/')}`;
  }
  if (projectDir.startsWith('-')) {
    return '/' + projectDir.slice(1).replace(/-/g, '/');
  }
  return null;
}

// Scan ~/.claude/projects/*/<threadId>.jsonl. Returns { projectDir, cwd }
// or null when not found anywhere.
import { readdirSync as _readdirSync, existsSync as _existsSync } from 'node:fs';
export function findThreadJsonl(threadId, candidateCwds = []) {
  if (!threadId) return null;
  const projects = join(homedir(), '.claude', 'projects');
  if (!_existsSync(projects)) return null;
  let entries;
  try { entries = _readdirSync(projects); } catch (e) { console.error(`!! findThreadJsonl readdir(${projects}): ${e?.message ?? e}`); return null; }
  for (const d of entries) {
    const candidate = join(projects, d, `${threadId}.jsonl`);
    if (_existsSync(candidate)) {
      return {
        projectDir: d,
        cwd:        reverseSanitizeCwd(d, candidateCwds),
        jsonlPath:  candidate,
      };
    }
  }
  return null;
}

// Move media for each contact from ~/.egpt/media/<jid-sanitized>/ into
// the contact's <slug-dir>/media/. Operator (2026-05-20): media should
// live inside the conversation's own dir so conversation-e sees it at
// ./media without crossing its sandbox.
// Multi-JID contacts merge contents (filename-collision tolerant — on
// collision the existing file in slug-dir wins, the legacy stays for
// audit). Idempotent: skips contacts whose jid-media-dirs no longer
// exist (already migrated).
export async function migrateMediaToSlugDirs() {
  if (!existsSync(CONV_YAML_PATH)) return { migrated: 0, files: 0 };
  const state = await readState(CONV_YAML_PATH);
  // Surface-layout is the post-2026-05-21 shape — media already lives
  // under conversations/<surface>/<slug>/media/. Nothing to migrate.
  if (_isSurfaceLayout(state)) return { migrated: 0, files: 0, skipped: 'surface-layout' };
  let contactsTouched = 0, filesMoved = 0;
  const isJid = _isJidKeyed(state);
  // Collect (slug, jids[]) tuples for both schemas.
  const groups = [];
  if (isJid) {
    // New shape: iterate primary entries (those with `slug`, not `aliasOf`).
    // Each primary's jids[] = the primary jid + every alias pointing to it.
    for (const [primaryJid, entry] of Object.entries(state.contacts ?? {})) {
      if (entry?.aliasOf || !entry?.slug) continue;
      const jids = [primaryJid];
      for (const [j, e] of Object.entries(state.contacts ?? {})) {
        if (e?.aliasOf === primaryJid) jids.push(j);
      }
      groups.push({ slug: entry.slug, jids });
    }
  } else {
    // Old shape: slug-keyed.
    for (const [slug, entry] of Object.entries(state.contacts ?? {})) {
      groups.push({ slug, jids: entry?.jids ?? [] });
    }
  }
  for (const { slug, jids } of groups) {
    // This migration predates surface-layout — destination is the
    // legacy flat path. Later migrateToSurfaceLayout moves the whole
    // slug-dir (media included) into conversations/whatsapp/<slug>/.
    const dstDir = join(_legacySlugDir(slug), 'media');
    let touched = false;
    for (const jid of jids) {
      const srcDir = jidMediaDir(jid);
      if (!existsSync(srcDir)) continue;
      try { await mkdir(dstDir, { recursive: true }); } catch {}
      const { readdir } = await import('node:fs/promises');
      let names;
      try { names = await readdir(srcDir); }
      catch (e) {
        console.error(`!! migrateMediaToSlugDirs readdir(${srcDir}): ${e?.message ?? e}`);
        continue;
      }
      for (const name of names) {
        const srcPath = join(srcDir, name);
        const dstPath = join(dstDir, name);
        if (existsSync(dstPath)) continue;
        try { await rename(srcPath, dstPath); filesMoved++; touched = true; }
        catch (e) {
          console.error(`!! migrateMediaToSlugDirs rename(${srcPath} -> ${dstPath}): ${e?.message ?? e}`);
        }
      }
    }
    if (touched) contactsTouched++;
  }
  return { migrated: contactsTouched, files: filesMoved };
}

// Detect whether the on-disk state uses the new JID-keyed shape.
// JID-keyed entries always have '@' in the key; slug-keyed never do.
function _isJidKeyed(state) {
  const keys = Object.keys(state?.contacts ?? {});
  return keys.length > 0 && keys[0].includes('@');
}

// New shape detection: top-level keys under contacts: are surface names
// (whatsapp / telegram / shell / signal), not JIDs. The migration
// migrateToSurfaceLayout() converts JID-keyed → surface-nested. Empty
// state counts as surface-layout (avoids re-running the migration when
// nothing's there yet).
function _isSurfaceLayout(state) {
  const keys = Object.keys(state?.contacts ?? {});
  if (keys.length === 0) return true;
  return keys.every(k => KNOWN_SURFACES.includes(k));
}

// Convert slug-keyed → JID-keyed (one-time, idempotent). For each
// slug-keyed entry, pick the first JID in its jids[] as primary; drop
// jids[] from the entry, replace the YAML key with primary JID, add
// alias stubs ({aliasOf: <primary>}) for additional JIDs.
//
//   contacts:
//     diego_p_rez_koma-2605200133:
//       jids: [A, B]
//       personality: default
//   →
//     contacts:
//       A:
//         slug: diego_p_rez_koma-2605200133
//         personality: default
//       B:
//         aliasOf: A
export async function migrateConversationsToJidKey() {
  if (!existsSync(CONV_YAML_PATH)) return null;
  const state = await readState(CONV_YAML_PATH);
  if (_isSurfaceLayout(state)) return { skipped: 'surface-layout' };
  if (_isJidKeyed(state)) return { skipped: 'already-jid-keyed' };
  const oldContacts = state.contacts ?? {};
  const newContacts = {};
  let primaries = 0, aliases = 0, dangling = 0;
  for (const [slug, entry] of Object.entries(oldContacts)) {
    const jids = entry?.jids ?? [];
    if (!jids.length) {
      // No JID to key on — keep under old key (rare edge case).
      newContacts[slug] = entry;
      dangling++;
      continue;
    }
    const primaryJid = jids[0];
    const { jids: _drop, ...rest } = entry;
    newContacts[primaryJid] = { ...rest, slug };
    primaries++;
    for (const aliasJid of jids.slice(1)) {
      newContacts[aliasJid] = { aliasOf: primaryJid };
      aliases++;
    }
  }
  await writeState(CONV_YAML_PATH, { contacts: newContacts });
  return { migrated: primaries, aliases, dangling };
}

// One-shot migration: flat JID-keyed → nested-by-surface.
//
// Pre-2026-05-21: contacts at top-level under `contacts:`, slug-dirs flat at
// ~/.egpt/conversations/<slug>/. Everything was WhatsApp.
//
// Post: contacts.whatsapp.<jid>, slug-dirs at
// ~/.egpt/conversations/whatsapp/<slug>/. Telegram and Signal get
// their own buckets as their bridges register chats.
//
// Idempotent: returns { skipped } when state already surface-layout.
// Migrates BOTH yaml and on-disk slug-dirs. Crash-safe insofar as each
// dir rename is atomic; partial completion is detectable on next boot
// (some dirs in new path, some still in old) and the migration will
// finish the move.
export async function migrateToSurfaceLayout() {
  if (!existsSync(CONV_YAML_PATH)) return { skipped: 'no registry yet' };
  const state = await readState(CONV_YAML_PATH);
  if (_isSurfaceLayout(state)) return { skipped: 'already surface-layout' };

  // Move yaml: wrap existing flat contacts in { whatsapp: ... }.
  // Each primary entry's cwd moves from conversations/<slug>/ to
  // conversations/whatsapp/<slug>/, which means claude-code's
  // sanitized project-dir name changes too (cwd is its key). Any
  // stored `threadId` points to a jsonl in the OLD project-dir,
  // unreachable from the new cwd. `reverseSanitizeCwd` can't help
  // reliably because claude-code's sanitize is many-to-one (`.`, `_`,
  // `/`, `:` all map to `-`). Cleanest fix: invalidate thread state
  // on migrated entries. Next dispatch spawns a fresh thread at the
  // new cwd. Transcripts on disk are preserved; only the live
  // claude session_id is lost.
  const flat = {};
  for (const [jid, entry] of Object.entries(state.contacts ?? {})) {
    if (entry?.aliasOf) { flat[jid] = entry; continue; }
    flat[jid] = {
      ...entry,
      threadId:           null,
      threadCwd:          null,
      threadCreatedAt:    null,
      identityInjectedAt: null,
    };
  }
  const newState = { ...state, contacts: { whatsapp: flat } };

  // Move slug-dirs: ~/.egpt/conversations/<slug>/ → conversations/whatsapp/<slug>/.
  // Iterate by primary entries (those with `.slug`, not aliases).
  const newSurfaceRoot = join(EGPT_HOME, 'conversations', 'whatsapp');
  await mkdir(newSurfaceRoot, { recursive: true });
  let dirsMoved = 0, missingDirs = 0;
  for (const [_jid, entry] of Object.entries(flat)) {
    if (entry?.aliasOf || !entry?.slug) continue;
    const oldDir = _legacySlugDir(entry.slug);
    const newDir = join(newSurfaceRoot, sanitizeSlug(entry.slug));
    if (!existsSync(oldDir)) { missingDirs++; continue; }
    if (existsSync(newDir)) { dirsMoved++; continue; }   // already moved
    try {
      await rename(oldDir, newDir);
      dirsMoved++;
    } catch (e) {
      console.error(`!! migrateToSurfaceLayout rename(${oldDir} -> ${newDir}): ${e?.message ?? e}`);
    }
  }

  await writeState(CONV_YAML_PATH, newState);
  return { migrated: Object.keys(flat).length, dirsMoved, missingDirs };
}

// At-rest repair: re-slug every primary contact whose folder name no longer
// matches its current title (pushedName) — both a nameless 'contact-<ts>'
// placeholder finally learning its name AND an old aggressively-sanitized slug
// ('Dando_Ruiz') upgrading to the path-safe title ('Dando Ruiz'). The registry
// slug + on-disk folder both follow the name (operator 2026-06-14: slugs must
// track the current name, not stay frozen). This is the batch form of the
// per-message tracking in ensureContact, for chats not currently messaging.
//
// Idempotent: an entry whose slug base already equals its title is skipped, so a
// steady state re-runs clean. Entries with no known title are left as-is.
// threadId is nulled on rename (cwd changed ⇒ stale claude session); transcripts
// move with the folder via renameSlugDir (which logs the rename). Surface-layout
// only — the earlier boot migrations convert older shapes first.
export async function migrateSlugsToCurrentName() {
  if (!existsSync(CONV_YAML_PATH)) return { renamed: 0, skipped: 'no registry' };
  const state = await readState(CONV_YAML_PATH);
  if (!_isSurfaceLayout(state)) return { renamed: 0, skipped: 'not surface-layout' };
  const nextContacts = { ...(state.contacts ?? {}) };
  let renamed = 0, touched = false;
  for (const surface of Object.keys(nextContacts)) {
    if (!KNOWN_SURFACES.includes(surface)) continue;
    const bucket = { ...(nextContacts[surface] ?? {}) };
    let bucketTouched = false;
    for (const [jid, entry] of Object.entries(bucket)) {
      if (!entry || entry.aliasOf || !entry.slug) continue;
      const nameBase = sanitizeSlug(entry.pushedName);
      if (!nameBase || nameBase === 'contact') continue;            // no title to adopt
      const curBase = String(entry.slug).replace(/-\d{10}$/, '');
      if (nameBase === curBase) continue;                            // already current
      const suffix = String(entry.slug).match(/-(\d{10})$/)?.[1]
        || slugSuffix(entry.firstSeenAt ? new Date(entry.firstSeenAt) : new Date());
      const candidate = suffix ? `${nameBase}-${suffix}` : nameBase;
      if (candidate === entry.slug) continue;
      // Collision guard within this (in-progress) bucket — never two on one slug.
      if (_findByslug({ contacts: { [surface]: bucket } }, surface, candidate)) continue;
      await renameSlugDir(surface, entry.slug, candidate, 'name changed (boot repair)');
      bucket[jid] = { ...entry, slug: candidate, conversation_path: conversationPathOf(surface, candidate), threadId: null, threadCreatedAt: null, identityInjectedAt: null, threadCwd: null };
      bucketTouched = true; renamed++;
    }
    if (bucketTouched) { nextContacts[surface] = bucket; touched = true; }
  }
  if (touched) await writeState(CONV_YAML_PATH, { ...state, contacts: nextContacts });
  return { renamed };
}

// Rename any contact whose slug lacks the '-yymmddhhmm' suffix.
// Idempotent: skips entries that already match the pattern. Only runs
// for slug-keyed state — once converted to JID-keyed, this is a no-op.
export async function migrateSlugSuffix() {
  if (!existsSync(CONV_YAML_PATH)) return { renamed: 0, skipped: 0 };
  const state = await readState(CONV_YAML_PATH);
  if (_isSurfaceLayout(state)) return { renamed: 0, skipped: 'surface-layout' };
  if (_isJidKeyed(state)) return { renamed: 0, skipped: 'jid-keyed' };
  const oldContacts = state.contacts ?? {};
  const nextContacts = {};
  let renamed = 0, skipped = 0;
  for (const [oldSlug, entry] of Object.entries(oldContacts)) {
    if (hasSlugSuffix(oldSlug) || !entry?.jids?.length) {
      // Already migrated or has no JIDs to derive from — keep as-is.
      // Backfill firstSeenAt for already-suffixed entries that lack it.
      if (hasSlugSuffix(oldSlug) && !entry.firstSeenAt) {
        const inferredFromSlug = (() => {
          const m = oldSlug.match(/-(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
          if (!m) return null;
          const [, yy, MM, dd, HH, mm] = m;
          return new Date(Date.UTC(2000 + Number(yy), Number(MM) - 1, Number(dd), Number(HH), Number(mm))).toISOString();
        })();
        nextContacts[oldSlug] = { ...entry, firstSeenAt: inferredFromSlug ?? entry.threadCreatedAt ?? new Date().toISOString() };
      } else {
        nextContacts[oldSlug] = entry;
      }
      skipped++;
      continue;
    }
    // Determine firstSeenAt: explicit field, then threadCreatedAt,
    // then dir mtime, then now.
    let firstSeenAt = entry.firstSeenAt;
    if (!firstSeenAt) {
      if (entry.threadCreatedAt) firstSeenAt = entry.threadCreatedAt;
      else {
        try {
          const s = await stat(_legacySlugDir(oldSlug));
          firstSeenAt = new Date(s.birthtimeMs || s.mtimeMs).toISOString();
        } catch (e) { console.error(`!! migrateSlugSuffix stat(${oldSlug}): ${e?.message ?? e}`); firstSeenAt = new Date().toISOString(); }
      }
    }
    const newSlug = appendSlugSuffix(oldSlug, new Date(firstSeenAt));
    const oldDir = _legacySlugDir(oldSlug);
    const newDir = _legacySlugDir(newSlug);
    if (existsSync(oldDir) && !existsSync(newDir)) {
      try { await rename(oldDir, newDir); }
      catch (e) { console.error(`!! migrateSlugSuffix rename(${oldDir} -> ${newDir}): ${e?.message ?? e}`); }
    }
    nextContacts[newSlug] = { ...entry, firstSeenAt };
    renamed++;
  }
  if (renamed > 0 || Object.keys(nextContacts).some(k => oldContacts[k]?.firstSeenAt !== nextContacts[k]?.firstSeenAt)) {
    await writeState(CONV_YAML_PATH, { ...state, contacts: nextContacts });
  }
  return { renamed, skipped };
}

// ── State shape ─────────────────────────────────────────────────────────────

// emptyState() returns the empty registry.
export function emptyState() {
  return { contacts: {} };
}

// ── Slug uniqueness ────────────────────────────────────────────────────────

// Operator (2026-05-20): use a local-time suffix so the slug encodes
// the contact's creation time at a glance — '-yymmddhhmm'. Two groups
// with the same name across time will have different suffixes and
// won't collide.
//   diego-2605201243  =  contact 'diego' first seen 2026-05-20 12:43 local
export function slugSuffix(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  // UTC — stable across operator's TZ changes; not the local clock.
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const HH = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return yy + MM + dd + HH + mm;
}
export function hasSlugSuffix(slug) {
  return /-\d{10}$/.test(String(slug ?? ''));
}
export function appendSlugSuffix(baseSlug, date = new Date()) {
  const base = sanitizeSlug(baseSlug);
  const suf = slugSuffix(date);
  return suf ? `${base}-${suf}` : base;
}

// A PLACEHOLDER slug is one whose BASE (slug minus the -yymmddhhmm suffix) is
// empty or the generic 'contact' fallback — i.e. ensureContact had no name to
// work with at first contact (Beeper title not resolved yet, etc.). These are
// meant to self-heal: once the chat's real title is known, the slug — and its
// on-disk folder — recompute to follow the name. 'contact-2606101622' →
// placeholder; 'morgan-2606101622' → not. Without this, a chat first seen
// before its title resolved stays nameless forever (operator 2026-06-14).
export function isPlaceholderSlug(slug) {
  const base = String(slug ?? '').replace(/-\d{10}$/, '');
  return base === '' || base === 'contact';
}

// ── Slug sanitization (Windows-path-safe) ──────────────────────────────────
// Extracted VERBATIM to the leaf src/sanitize.mjs (Phase 0a of the
// conversations↔rooms merge, GENOME §2.5) so the Room abstraction can share it
// without an import cycle. Re-exported here so every existing importer of
// `sanitizeSlug` from conversations-state.mjs is unaffected. See sanitize.mjs
// for the operator rationale (keep the slug close to the real name; only strip
// Windows-illegal chars). Imported at the top so slugDir() below keeps a local
// binding; re-exported here so importers of conversations-state.sanitizeSlug work.
export { sanitizeSlug };

// ── Schema notes ───────────────────────────────────────────────────────────
//
// Operator (2026-05-21): conversations are nested by surface, then keyed by
// JID/chat-id within each surface. Surface separation lets each bridge
// own its own contact namespace. Multi-JID humans (within ONE surface)
// are modeled with a primary entry + alias entries pointing back via
// `aliasOf: <primary-jid>`. The on-disk slug-dir lives under
// conversations/<surface>/<slug>/.
//
//   contacts:
//     whatsapp:
//       "26087681749235@lid":
//         slug: diego_p_rez_koma-2605200133
//         personality: default
//         threadId: …
//         firstSeenAt: …
//         pushedName: "Diego Pérez (Koma)"
//         ...
//       "584122182178@s.whatsapp.net":
//         aliasOf: "26087681749235@lid"
//     telegram:
//       "tg:user:88164392":
//         slug: an-self-tg-2605211200
//         personality: system
//         ...

// ── Lookups ─────────────────────────────────────────────────────────────────

// Resolve a JID within one surface, following one level of aliasing.
// Returns {primaryJid, entry} or null when not registered (or alias
// dangles).
function _resolveByJid(state, surface, jid) {
  const bucket = state.contacts?.[surface];
  if (!bucket) return null;
  const direct = bucket[jid];
  if (!direct) return null;
  if (direct.aliasOf) {
    const primary = bucket[direct.aliasOf];
    if (!primary) return null;
    return { primaryJid: direct.aliasOf, entry: primary };
  }
  return { primaryJid: jid, entry: direct };
}

// Find which contact's primary entry owns a given JID inside surface.
// Returns the slug (string) or null. Slug-callers will still get the
// dir under conversations/<surface>/<slug>/.
export function findContactByJid(state, surface, jid) {
  const r = _resolveByJid(state, surface, jid);
  return r?.entry?.slug ?? null;
}

// Get the resolved contact entry + slug + primary-JID for a JID within
// a surface. Returns { jid, slug, entry, surface } or null.
export function getContact(state, surface, jid) {
  const r = _resolveByJid(state, surface, jid);
  return r ? { jid: r.primaryJid, slug: r.entry.slug, entry: r.entry, surface } : null;
}

// ── per-being view (#2: per-resident conversation shape) ────────────────────
// A conversation can host several resident beings (E + custom agents), each its own
// sub-block: `<being>: { mode, readonly: { model, effort, personality }, threadId,
// threadCreatedAt, identityInjectedAt }`. `mode` is the hot reply-gate; `readonly` is
// how the thread was started (changing it reloads the agent via /e new|identity|brain).
//
// READER-CONVERGENCE (stage 1): read the nested block, falling back to today's FLAT
// fields for the default 'e' so an un-migrated conversation resolves identically. No
// writer or migration yet — nothing nested exists until the migrate stage, so every
// read still lands on the flat fallback. Behavior-neutral by construction.
const _FLAT_ENTRY_KEYS = new Set([
  'slug', 'personality', 'threadId', 'threadCreatedAt', 'identityInjectedAt', 'threadCwd',
  'pushedName', 'firstSeenAt', 'mode', 'send_to_egpt', 'aliasOf', 'jids', 'transcribe',
]);

// Resolve a resident being's view of a conversation. `entry[being]` (nested) wins;
// for 'e' it falls back to the legacy flat fields. Returns null when there's no contact.
export function getBeing(state, surface, jid, being = 'e') {
  const c = getContact(state, surface, jid);
  if (!c) return null;
  const e = c.entry ?? {};
  const b = (e[being] && typeof e[being] === 'object' && !Array.isArray(e[being])) ? e[being] : null;
  const flat = being === 'e' ? e : {};
  const ro = b?.readonly ?? {};
  return {
    jid: c.jid, slug: c.slug, surface, being,
    present:            !!b || being === 'e',                                   // 'e' is the implicit legacy resident
    mode:               b?.mode               ?? flat.mode               ?? null,
    send_to_egpt:       b?.send_to_egpt       ?? flat.send_to_egpt       ?? null,  // per-conv 'always'|'mode' override
    threadId:           b?.threadId           ?? flat.threadId           ?? null,
    threadCreatedAt:    b?.threadCreatedAt    ?? flat.threadCreatedAt    ?? null,
    identityInjectedAt: b?.identityInjectedAt ?? flat.identityInjectedAt ?? null,
    personality:        ro.personality        ?? flat.personality        ?? 'default',
    model:              ro.model              ?? null,
    effort:             ro.effort             ?? null,
  };
}

// The resident being names configured on an entry: the nested per-being keys, plus an
// implicit 'e' for a legacy flat entry (which has no nested blocks). 'e' is always first.
export function residentsOf(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const named = Object.keys(entry).filter(
    (k) => !_FLAT_ENTRY_KEYS.has(k) && entry[k] && typeof entry[k] === 'object' && !Array.isArray(entry[k]),
  );
  if (!named.length) return ['e'];
  return named.includes('e') ? named : ['e', ...named];
}

// Top-N primary contacts across surfaces, newest first — the `/e` / `/egpt` browser.
// `recencyOf(surface, slug, entry) → ms` is supplied by the caller (the spine uses the
// transcript.md mtime, falling back to firstSeenAt) so this stays pure + testable. Skips
// aliases and slug-less entries.
export function recentContacts(state, { limit = 10, offset = 0, recencyOf } = {}) {
  const rows = [];
  for (const surface of Object.keys(state?.contacts ?? {})) {
    if (!KNOWN_SURFACES.includes(surface)) continue;
    for (const [jid, entry] of Object.entries(state.contacts[surface] ?? {})) {
      if (!entry || entry.aliasOf || !entry.slug) continue;
      const recency = recencyOf ? Number(recencyOf(surface, entry.slug, entry)) || 0 : 0;
      rows.push({ surface, jid, slug: entry.slug, pushedName: entry.pushedName || entry.slug, entry, recency });
    }
  }
  rows.sort((a, b) => b.recency - a.recency);
  const start = Math.max(0, offset);
  return rows.slice(start, start + Math.max(0, limit));
}

// Look up a contact by its slug WITHIN one surface (linear scan; N small).
function _findByslug(state, surface, slug) {
  const bucket = state.contacts?.[surface] ?? {};
  for (const [jid, entry] of Object.entries(bucket)) {
    if (entry?.aliasOf) continue;
    if (entry?.slug === slug) return { primaryJid: jid, entry };
  }
  return null;
}

// Name-search: substring match (case-insensitive) on pushedName + slug.
// Searches ALL surfaces unless one is named explicitly (operator might
// want "@e new daniel" to disambiguate by surface later — for now,
// cross-surface is the default). Returns an array of
// { jid, slug, entry, pushedName, surface } for primary entries only.
export function findContactsByName(state, term, surface = null) {
  const needle = String(term ?? '').trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  const surfaces = surface ? [surface] : Object.keys(state.contacts ?? {});
  for (const surf of surfaces) {
    const bucket = state.contacts?.[surf] ?? {};
    for (const [jid, entry] of Object.entries(bucket)) {
      if (entry?.aliasOf || !entry?.slug) continue;
      const pn = String(entry.pushedName ?? '').toLowerCase();
      const sl = String(entry.slug ?? '').toLowerCase();
      if (pn.includes(needle) || sl.includes(needle)) {
        out.push({ jid, slug: entry.slug, entry, pushedName: entry.pushedName ?? '', surface: surf });
      }
    }
  }
  return out;
}

// Shared chat-target resolver for ANY slash command that takes a jid. Accepts:
//   - a real @-jid          → resolved to its LIVE name (bridge group subject)
//   - a fuzzy name term     → matched against the bridge's live chat names
//                             first (the real WA subjects), then registered
//                             contacts (pushedName + slug) as a fallback.
// Returns { jid, name } on a unique hit, { error } on none/ambiguous, or {} for
// an empty term (caller falls back to the current chat). `waBridge` is the live
// WA bridge (ctx.waBridgeRef.current) or null; this module stays bridge-free —
// the bridge is passed in. Always names the picked chat so a bare-jid echo is
// never the only feedback ([[feedback-verify-wa-chat-name]]).
export async function resolveChatTarget(term, { waBridge = null, surface = 'whatsapp', statePath = CONV_YAML_PATH } = {}) {
  if (!term) return {};
  // A JID/room-id (not a fuzzy name): a WA jid carries '@'; a Beeper room id is
  // '!<room>:beeper.local' (no '@'). Recognize BOTH — else a Beeper id falls to
  // the fuzzy-name path and never resolves (operator 2026-06-16: `/e auto status`
  // showed raw `!…:beeper.local` ids because getChatName was never consulted).
  const _t = String(term);
  if (_t.includes('@') || _t.startsWith('!') || _t.includes(':beeper')) {
    const live = waBridge?.getChatName?.(term) ?? null;
    if (live) return { jid: term, name: live };
    const cs = await readState(statePath);
    return { jid: term, name: findContactByJid(cs, surface, term) ?? null };
  }
  const needle = String(term).trim().toLowerCase();
  const hits = new Map();   // jid -> name
  try {
    const chats = await waBridge?.listChats?.({ all: true, limit: 2000, messagesPerChat: 0, includeStatus: false }) ?? [];
    for (const c of chats) {
      const nm = String(c.name ?? '');
      if (nm && c.jid && nm.toLowerCase().includes(needle)) hits.set(c.jid, nm);
    }
  } catch { /* bridge optional */ }
  // The LIVE chat list is AUTHORITATIVE. Only consult the registry when NO live
  // chat matched (e.g. an archived chat the bridge no longer lists) — otherwise
  // stale/duplicate registry entries (a renamed or baileys→Beeper-migrated jid
  // for the SAME group) create phantom "matches N" ambiguity for what is really
  // one live chat (operator 2026-06-16: `/e auto on HFM` → "matches 2").
  if (!hits.size) {
    try {
      const cs = await readState(statePath);
      for (const m of findContactsByName(cs, term, surface)) {
        if (!hits.has(m.jid)) hits.set(m.jid, m.pushedName || m.slug || m.jid);
      }
    } catch { /* conv-state optional */ }
  }
  const arr = [...hits.entries()];
  if (!arr.length) return { error: `no chat matches "${term}" — try /channels to see exact names, or pass the @-jid` };
  if (arr.length > 1) {
    return { error: `"${term}" matches ${arr.length}: ${arr.slice(0, 8).map(([, n]) => n).join(', ')} — be more specific or pass the @-jid` };
  }
  return { jid: arr[0][0], name: arr[0][1] };
}

// Normalize a `residents` config value to a flat list of ENABLED being-names.
// Accepts any of:
//   ["e","l"]              — plain list of names
//   [{e:true},{l:false}]   — list of {name: enabled} toggles
//   {e:true, l:false}      — a {name: enabled} map
// Falsy toggles are dropped. So the operator can write residents as a list OR
// as an enable-map (which reads naturally: `e: true`, `l: false`).
export function normalizeResidents(val) {
  if (Array.isArray(val)) {
    const out = [];
    for (const item of val) {
      if (typeof item === 'string') { if (item.trim()) out.push(item.trim()); }
      else if (item && typeof item === 'object') {
        for (const [k, v] of Object.entries(item)) if (v) out.push(k);
      }
    }
    return out;
  }
  if (val && typeof val === 'object') {
    return Object.entries(val).filter(([, v]) => v).map(([k]) => k);
  }
  return [];
}

// ── Upsert ─────────────────────────────────────────────────────────────────

// Idempotent. Schema is surface-nested + JID-keyed. Multi-JID humans
// (within one surface) get alias entries pointing to a primary. Returns
// { state, jid, slug, entry, surface, isNew, changed } where jid is the
// PRIMARY jid (alias resolution already applied).
export function ensureContact(state, surface, jid, ctx = {}) {
  if (!surface || !KNOWN_SURFACES.includes(surface)) {
    throw new Error(`ensureContact: unknown surface "${surface}" (expected one of ${KNOWN_SURFACES.join('|')})`);
  }
  if (!jid) return { state, surface, jid: null, slug: null, entry: null, isNew: false, changed: false };

  // Deep-clone the touched bucket so the original state is unchanged.
  const prevBucket = state.contacts?.[surface] ?? {};
  const nextBucket = { ...prevBucket };
  const next = { ...state, contacts: { ...(state.contacts ?? {}), [surface]: nextBucket } };

  // 1. JID already known (directly or as alias) → refresh pushedName on primary,
  //    and SELF-HEAL a placeholder slug now that a real name may be known.
  const resolved = _resolveByJid(state, surface, jid);
  if (resolved) {
    const cur = resolved.entry;
    let changed = false;
    let patch = cur;
    if (ctx.pushedName && cur.pushedName !== ctx.pushedName) {
      patch = { ...patch, pushedName: ctx.pushedName };
      changed = true;
    }
    // Backfill the STORED conversation_path + a populated threadCwd for an already-
    // started thread (operator 2026-06-27: the path must be stored, and every started
    // conversation has a conversation-e cwd — null is nonsensical). One-time per entry:
    // once written they equal the desired value, so this stops churning. A rename below
    // overrides both for the new slug.
    const _wantPath = conversationPathOf(surface, cur.slug);
    if (cur.conversation_path !== _wantPath) { patch = { ...patch, conversation_path: _wantPath }; changed = true; }
    if (cur.threadId && !cur.threadCwd) { patch = { ...patch, threadCwd: slugDir(surface, cur.slug) }; changed = true; }
    // Track the CURRENT name (operator 2026-06-14: "the slug must be updated with
    // the current contact/group name, not frozen"). Whenever the chat's title
    // (pushedName) changes — including a 'contact-<ts>' placeholder finally
    // learning its name, OR a group being renamed — recompute the slug so the
    // folder always follows the name. Driven off pushedName ONLY (the title), so
    // it can't flap between two slug derivations. KEEP the original -yymmddhhmm
    // suffix (encodes firstSeen → preserves ordering + keeps the slug unique).
    // Renaming the slug-dir changes conversation-e's cwd, which invalidates the
    // stored threadId (a claude session keyed on cwd) — so null thread state, the
    // same trade-off migrateToSurfaceLayout makes. The on-disk transcript is
    // moved by the caller (renameSlugDir / dispatch), which also writes a
    // renames.log entry into the folder.
    let renamedFrom = null, renamedTo = null;
    const nameBase = sanitizeSlug(ctx.pushedName);
    const curBase = String(cur.slug ?? '').replace(/-\d{10}$/, '');
    if (nameBase && nameBase !== 'contact' && nameBase !== curBase) {
      const suffix = String(cur.slug).match(/-(\d{10})$/)?.[1]
        || slugSuffix(cur.firstSeenAt ? new Date(cur.firstSeenAt) : new Date());
      const candidate = suffix ? `${nameBase}-${suffix}` : nameBase;
      if (candidate !== cur.slug && !_findByslug(state, surface, candidate)) {
        renamedFrom = cur.slug;
        renamedTo = candidate;
        patch = { ...patch, slug: candidate, conversation_path: conversationPathOf(surface, candidate), threadId: null, threadCreatedAt: null, identityInjectedAt: null, threadCwd: null };
        changed = true;
      }
    }
    if (changed) nextBucket[resolved.primaryJid] = patch;
    return {
      state: changed ? next : state,
      surface,
      jid: resolved.primaryJid,
      slug: patch.slug,
      entry: changed ? patch : cur,
      isNew: false,
      changed,
      renamedFrom,
      renamedTo,
    };
  }

  // 2. New JID. Multi-JID auto-merge: does a primary entry already exist
  //    in this surface whose slug matches our intended slug (within the
  //    same minute)? Same-base-slug + same suffix == same contact → alias.
  const firstSeen = new Date();
  // pushedName (the chat TITLE) drives the slug so a fresh contact is named like
  // the contact, AND so creation agrees with the name-tracking above (no rename
  // on the 2nd message). slugHint is a fallback for callers that pass only a slug
  // (e.g. a slash command), and 'contact' is the last-resort placeholder.
  const baseSlug = sanitizeSlug(ctx.pushedName)
    || sanitizeSlug(ctx.slugHint)
    || 'contact';
  const candidateSlug = appendSlugSuffix(baseSlug, firstSeen);
  const slugMatch = _findByslug(state, surface, candidateSlug);
  if (slugMatch) {
    nextBucket[jid] = { aliasOf: slugMatch.primaryJid };
    return {
      state: next,
      surface,
      jid: slugMatch.primaryJid,
      slug: slugMatch.entry.slug,
      entry: slugMatch.entry,
      isNew: false,
      changed: true,
    };
  }

  // 3. Brand-new contact. firstSeenAt set once, drives the slug-suffix,
  //    never overwritten on /e new.
  const entry = {
    slug: candidateSlug,
    conversation_path: conversationPathOf(surface, candidateSlug),
    personality: ctx.personality ?? 'default',
    threadId: null,
    threadCreatedAt: null,
    firstSeenAt: firstSeen.toISOString(),
    identityInjectedAt: null,
    pushedName: ctx.pushedName ?? '',
  };
  nextBucket[jid] = entry;
  return { state: next, surface, jid, slug: candidateSlug, entry, isNew: true, changed: true };
}

// patchContact accepts EITHER a JID or a slug as the lookup key, scoped
// to one surface. The patch always lands on the primary entry. Returns
// a new state; if not found, returns the original state unchanged.
export function patchContact(state, surface, jidOrSlug, patch) {
  if (!surface || !KNOWN_SURFACES.includes(surface)) {
    throw new Error(`patchContact: unknown surface "${surface}"`);
  }
  const prevBucket = state.contacts?.[surface] ?? {};
  // First try JID lookup (preferred for new code).
  const byJid = _resolveByJid(state, surface, jidOrSlug);
  if (byJid) {
    const nextBucket = { ...prevBucket, [byJid.primaryJid]: { ...byJid.entry, ...patch } };
    return { ...state, contacts: { ...(state.contacts ?? {}), [surface]: nextBucket } };
  }
  // Fall back: slug lookup (back-compat with slug-passing callers).
  const bySlug = _findByslug(state, surface, jidOrSlug);
  if (bySlug) {
    const nextBucket = { ...prevBucket, [bySlug.primaryJid]: { ...bySlug.entry, ...patch } };
    return { ...state, contacts: { ...(state.contacts ?? {}), [surface]: nextBucket } };
  }
  return state;
}

// Record that a new claude thread was just spawned for a contact.
export function recordThread(state, surface, jidOrSlug, threadId, nowIso = nowIsoString()) {
  return patchContact(state, surface, jidOrSlug, {
    threadId,
    threadCreatedAt: nowIso,
    identityInjectedAt: nowIso,
  });
}

// ── Predicates ─────────────────────────────────────────────────────────────

export function isMuted(entry) {
  return entry?.personality === 'mute';
}

// ── Personality file resolution ────────────────────────────────────────────

// Resolution chain: operator dir → shipped dir. Returns absolute path or null.
export function resolvePersonalityFile(name, opts = {}) {
  const safeName = sanitizeSlug(name || 'default') || 'default';
  const opDir   = opts.operatorDir   ?? PERSONALITIES_OPERATOR_DIR;
  const shipDir = opts.shippedDir    ?? PERSONALITIES_SHIPPED_DIR;
  const candidates = [
    join(opDir, `${safeName}.md`),
    join(shipDir, `${safeName}.md`),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

// Safe-default tool allowlist for personalities that have no frontmatter
// or no `allowed_tools` field. File ops (read + write + edit) scoped to
// the contact's slug-dir via additionalDirectories; READ-ONLY web access
// (WebSearch + WebFetch); no Bash, no Agent, no NotebookEdit.
//
// Operator security trail (2026-05-22):
//   - First pass: "if any of my contacts convince the model to send
//     messages via node, that would be a major flaw." → restrict tools.
//   - Refinement: "conversation-e should be able to write text files"
//     (so it can maintain summaries, daily notes, scratch state in its
//     own slug-dir). The additionalDirectories pin keeps writes
//     contained; absence of Bash blocks self-elevation (no
//     `chmod +x && ./malicious.sh` path), absence of Agent blocks
//     spawning sub-agents that could escape the scope.
//   - 2026-06-16: grant WebSearch + WebFetch. E kept telling contacts it
//     "couldn't search the internet" and asking for authorization — the
//     lineage prelude PROMISES these tools, but the permission layer didn't
//     grant them (they're non-file tools, so under the confined path they
//     weren't pre-approved → a headless permission prompt = denied). They are
//     READ-ONLY network tools: no self-elevation (still no Bash/Agent), no file
//     escape (file tools stay path-confined). So E can answer "what happened in
//     X?" without widening its sandbox.
export const DEFAULT_PERSONALITY_TOOLS = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];

function _parseFrontmatter(raw) {
  if (typeof raw !== 'string') return { meta: {}, body: '' };
  const m = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  try {
    const meta = YAML.parse(m[1]);
    return { meta: (meta && typeof meta === 'object') ? meta : {}, body: m[2] };
  } catch (e) {
    console.error(`!! personality frontmatter parse: ${e?.message ?? e}`);
    return { meta: {}, body: m[2] };
  }
}

export async function readPersonality(name, opts = {}) {
  const p = resolvePersonalityFile(name, opts);
  if (!p) return null;
  try {
    const raw = await readFile(p, 'utf8');
    // Strip YAML frontmatter from the body that goes into the prompt;
    // the meta lives separately (see readPersonalityMeta below).
    return _parseFrontmatter(raw).body;
  }
  catch (e) { console.error(`!! readPersonality(${name}): ${e?.message ?? e}`); return null; }
}

// Read the personality's YAML frontmatter (allowed_tools, etc.) without
// the body. Returns { allowed_tools, ... } or a safe default when the
// file is missing or has no frontmatter.
export async function readPersonalityMeta(name, opts = {}) {
  const p = resolvePersonalityFile(name, opts);
  if (!p) return { allowed_tools: DEFAULT_PERSONALITY_TOOLS };
  try {
    const raw = await readFile(p, 'utf8');
    const { meta } = _parseFrontmatter(raw);
    if (meta.allowed_tools === undefined) {
      meta.allowed_tools = DEFAULT_PERSONALITY_TOOLS;
    }
    return meta;
  } catch (e) {
    console.error(`!! readPersonalityMeta(${name}): ${e?.message ?? e}`);
    return { allowed_tools: DEFAULT_PERSONALITY_TOOLS };
  }
}

// Operator-editable rules + pointers files. These live in ~/.egpt/ but
// get COPIED into <slug-dir>/ at /e new and /e persona so conversation-e
// (sandboxed to its slug-dir) can `cat ./rules.md ./pointers.md`.
const RULES_OPERATOR_PATH    = join(EGPT_HOME, 'rules.md');
const POINTERS_OPERATOR_PATH = join(EGPT_HOME, 'pointers.md');

// Read identity/rules/pointers content. Returns { identity, rules, pointers }
// with empty strings (not null) for any missing file — easier downstream.
export async function readIdentityBundle(personalityName, opts = {}) {
  // The PERSONALITY (config/personalities/<name>.md) — historically returned as
  // `identity`, kept under that key for back-compat. The egpt-wide MANIFEST
  // (e_identity.md) is passed in by the caller via opts.manifest, since this
  // module doesn't know APP_DIR / config; '' when omitted.
  const personality = (await readPersonality(personalityName, opts)) ?? '';
  let rules = '';
  let pointers = '';
  try { rules    = await readFile(opts.rulesPath    ?? RULES_OPERATOR_PATH,    'utf8'); }
  catch (e) { if (e?.code !== 'ENOENT') console.error(`!! readIdentityBundle rules.md: ${e?.message ?? e}`); }
  try { pointers = await readFile(opts.pointersPath ?? POINTERS_OPERATOR_PATH, 'utf8'); }
  catch (e) { if (e?.code !== 'ENOENT') console.error(`!! readIdentityBundle pointers.md: ${e?.message ?? e}`); }
  return { manifest: String(opts.manifest ?? ''), identity: personality, personality, rules, pointers };
}

// <slug>/identity.d/ — the ordered set of files fed to conversation-e. Files
// sort lexically; numeric prefixes give order + insertion gaps so the operator
// (or E) can drop extras (e.g. 30-project.md) and they're fed too — no schema.
export function identityDir(surface, slug) {
  return join(slugDir(surface, slug), 'identity.d');
}

// Populate identity.d/ from sources. `manifest` is the egpt-wide e_identity
// content (caller resolves brains.identity). Also keeps the flat ./identity.md
// (= personality, back-compat) + ./rules.md + ./pointers.md the sandbox may cat.
export async function populateIdentityDir(surface, slug, personalityName, opts = {}) {
  const bundle = await readIdentityBundle(personalityName, opts);
  const dir = slugDir(surface, slug);
  const idd = identityDir(surface, slug);
  await mkdir(idd, { recursive: true });
  await writeFile(join(idd, '00-manifest.md'),    bundle.manifest,    'utf8');
  await writeFile(join(idd, '20-personality.md'), bundle.personality, 'utf8');
  await writeFile(join(idd, '40-rules.md'),       bundle.rules,       'utf8');
  await writeFile(join(idd, '60-pointers.md'),    bundle.pointers,    'utf8');
  // Flat copies for back-compat (e_identity references ./rules.md etc.).
  await writeFile(join(dir, 'identity.md'), bundle.personality, 'utf8');
  await writeFile(join(dir, 'rules.md'),    bundle.rules,       'utf8');
  await writeFile(join(dir, 'pointers.md'), bundle.pointers,    'utf8');
  return bundle;
}

// Back-compat alias: same as populateIdentityDir, returns the bundle.
export async function installPersonaIntoSlugDir(surface, slug, personalityName, opts = {}) {
  return populateIdentityDir(surface, slug, personalityName, opts);
}

// Rewrite ONLY the personality slice of identity.d/ (for /e persona — swap
// flavor without re-sending the manifest). Returns the new personality content.
export async function writeIdentityPersonality(surface, slug, personalityName, opts = {}) {
  const idd = identityDir(surface, slug);
  await mkdir(idd, { recursive: true });
  const personality = (await readPersonality(personalityName, opts)) ?? '';
  await writeFile(join(idd, '20-personality.md'), personality, 'utf8');
  await writeFile(join(slugDir(surface, slug), 'identity.md'), personality, 'utf8');
  return personality;
}

// Read + concat identity.d/*.md in lexical (= numeric-prefix) order, skipping
// empty files. This is the full bundle fed to E on /e new and /e identity.
export async function readIdentityDir(surface, slug) {
  const idd = identityDir(surface, slug);
  let names = [];
  try { const { readdir } = await import('node:fs/promises'); names = await readdir(idd); }
  catch { return ''; }
  const parts = [];
  for (const n of names.filter(x => x.endsWith('.md')).sort()) {
    try { const t = (await readFile(join(idd, n), 'utf8')).trim(); if (t) parts.push(t); }
    catch (e) { console.error(`!! readIdentityDir ${n}: ${e?.message ?? e}`); }
  }
  return parts.join('\n\n');
}

// ── Identity folders (operator 2026-05-26) ──────────────────────────────────
// An identity is a FOLDER `identities/<name>/` of NN-*.md files. The NN- prefix
// orders the injection; it is STRIPPED when files are copied into the
// conversation dir (40-rules.md → ./rules.md) so the sandboxed brain reads
// clean names. The kickoff FEED is the concat in NN- order. Operator overrides
// (~/.egpt/identities/<name>/) win over shipped (<repo>/identities/<name>/).

export function resolveIdentityDir(name) {
  const safe = sanitizeSlug(name || 'default') || 'default';
  for (const base of [IDENTITIES_OPERATOR_DIR, IDENTITIES_SHIPPED_DIR]) {
    const p = join(base, safe);
    if (existsSync(p)) return p;
  }
  return null;
}

// Read a source identity folder's NN-*.md in order → [{ src, name, content }]
// where `name` is the de-prefixed filename (40-rules.md → rules.md).
async function _readIdentityFiles(dir) {
  const { readdir } = await import('node:fs/promises');
  let names = [];
  try { names = (await readdir(dir)).filter(n => n.toLowerCase().endsWith('.md')).sort(); }
  catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const content = await readFile(join(dir, n), 'utf8');
      out.push({ src: n, name: n.replace(/^\d+[-_]/, ''), content });
    } catch (e) { console.error(`!! _readIdentityFiles ${n}: ${e?.message ?? e}`); }
  }
  return out;
}

// Install identity <name> into a conversation slug-dir: copy each file
// de-prefixed (so ./rules.md, ./pointers.md, ./identity.md exist in the
// sandbox) and return { feed, files, dir }. feed = concat in NN- order for the
// kickoff turn. Returns null dir when the identity folder doesn't exist.
export async function installIdentity(surface, slug, name) {
  const dir = resolveIdentityDir(name);
  if (!dir) return { feed: '', files: [], dir: null };
  const files = await _readIdentityFiles(dir);
  const slugd = slugDir(surface, slug);
  await mkdir(slugd, { recursive: true });
  for (const f of files) await writeFile(join(slugd, f.name), f.content, 'utf8');
  const feed = files.map(f => f.content.trim()).filter(Boolean).join('\n\n');
  return { feed, files: files.map(f => f.name), dir };
}

// Read identity <name>'s concatenated feed (NN- order) WITHOUT writing any
// slug-dir copies — for the first-dispatch auto-wrap, which just needs the
// content in-context. '' when the identity folder doesn't exist.
export async function readIdentityFeed(name) {
  const dir = resolveIdentityDir(name);
  if (!dir) return '';
  const files = await _readIdentityFiles(dir);
  return files.map(f => f.content.trim()).filter(Boolean).join('\n\n');
}

// Full-install announcement: the whole identity.d bundle (manifest +
// personality + rules + pointers + any extras), re-grounding the model.
export function buildIdentityAnnouncement(personalityName, feed) {
  // Feed ONLY the identity text — no "Reboot complete / Installing persona" preamble
  // (operator 2026-06-29: that framing reads like a roleplay setup the model declines).
  return String(feed ?? '').trim();
}

// Legacy frame kept for slash/egpt.mjs (the cross-chat @egpt variant) until it
// migrates to identity.d. Embeds the manifest first when present.
export function buildRebootAnnouncement(personalityName, bundle) {
  const { manifest = '', identity = '', rules = '', pointers = '' } = bundle;
  return [
    'Reboot complete. All systems operational.',
    `Installing persona: ${personalityName}`,
    '',
    manifest.trim(),
    manifest.trim() ? '' : null,
    identity.trim(),
    '',
    'Please, remember to:',
    '- follow the ./rules.md:',
    rules.trim(),
    '',
    '- read your ./pointers.md file when you think you lack an ability or tool:',
    pointers.trim(),
  ].filter(x => x != null).join('\n');
}

// ── YAML serialization ─────────────────────────────────────────────────────

export function serialize(state) {
  return YAML.stringify(state, { lineWidth: 100 });
}

export function parse(text) {
  if (!text || !text.trim()) return emptyState();
  const doc = YAML.parse(text);
  if (!doc || typeof doc !== 'object') return emptyState();
  if (!doc.contacts || typeof doc.contacts !== 'object') doc.contacts = {};
  return doc;
}

// ── Disk I/O helpers ───────────────────────────────────────────────────────

export async function readState(yamlPath) {
  try {
    const text = await readFile(yamlPath, 'utf8');
    return parse(text);
  } catch (e) {
    // ENOENT on first daemon run is legitimate (empty registry).
    // Anything else (parse error, permission, IO) must surface so
    // the operator can see WHY the registry came back empty
    // — silent fallback is how we lost yesterday's contacts.
    if (e?.code !== 'ENOENT') {
      console.error(`!! readState(${yamlPath}): ${e?.stack ?? e?.message ?? e}`);
    }
    return emptyState();
  }
}

// Atomic write: serialize → temp file → rename to final. Protects against
// torn writes if the process is killed mid-write or if a concurrent reader
// catches the file half-written. The rename is atomic at the fs level on
// both POSIX and Windows NTFS (within the same volume). Codex review
// 2026-05-21: parse failures returning emptyState made the next write
// dangerous — atomicity removes the partial-write class of failures.
export async function writeState(yamlPath, state) {
  await mkdir(dirname(yamlPath), { recursive: true });
  const body = serialize(state);
  const tmp = yamlPath + '.tmp-' + process.pid + '-' + Date.now();
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, yamlPath);
}

// ── Migration: conversations.json → conversations.yaml ────────────────────

// Reads the old JID-keyed JSON shape and rebuilds it as the new slug-keyed
// YAML shape. JSON entries with the same customName merge into one
// new contact (their JIDs accumulate). Old entries without a customName
// get a slug derived from pushedName, or 'contact_<short>'.
//
// Returns { migrated: <#contacts>, jids: <#total jids merged> } or null
// when no migration needed.
export function migrateJsonToYaml(jsonMap) {
  if (!jsonMap || typeof jsonMap !== 'object') return null;
  const state = emptyState();
  let totalJids = 0;
  for (const [jid, row] of Object.entries(jsonMap)) {
    if (!row || typeof row !== 'object') continue;
    totalJids++;
    const slug = (
      sanitizeSlug(row.customName)
      || sanitizeSlug(row.pushedName)
      || `contact_${sanitizeSlug(jid).slice(0, 12)}`
    );
    if (!state.contacts[slug]) {
      state.contacts[slug] = {
        personality: 'default',
        threadId: null,
        threadCreatedAt: null,
        identityInjectedAt: null,
        pushedName: row.pushedName ?? '',
        jids: [],
      };
    }
    state.contacts[slug].jids.push(jid);
    if (row.pushedName && !state.contacts[slug].pushedName) {
      state.contacts[slug].pushedName = row.pushedName;
    }
    // Preserve customNameSource flag if operator set one.
    if (row.customNameSource) state.contacts[slug].customNameSource = row.customNameSource;
  }
  return { state, migrated: Object.keys(state.contacts).length, jids: totalJids };
}

// ── Layout migration (flat conversations/e/<slug>.md → per-slug dirs) ─────

// Detect-and-migrate. Idempotent: if the new layout already exists,
// returns { skipped: 'reason' } without touching disk. Otherwise
// reads the old registry, creates per-slug dirs, moves transcript
// files in, and writes the registry at its new location.
import { readdirSync } from 'node:fs';
export async function migrateLayoutIfNeeded() {
  const newRegistry    = CONV_YAML_PATH;
  const oldDirRoot     = join(EGPT_HOME, 'conversations', 'e');
  const oldYaml        = join(oldDirRoot, 'conversations.yaml');
  const oldJson        = join(oldDirRoot, 'conversations.json');
  if (existsSync(newRegistry)) return { skipped: 'new layout already in place' };

  // Source the state from whichever legacy file exists.
  let state = null;
  if (existsSync(oldYaml)) {
    try { state = parse(await readFile(oldYaml, 'utf8')); } catch {}
  }
  if (!state && existsSync(oldJson)) {
    try {
      const json = JSON.parse(await readFile(oldJson, 'utf8'));
      const r = migrateJsonToYaml(json);
      if (r) state = r.state;
    } catch {}
  }
  if (!state) return { skipped: 'no old registry found' };

  // For each slug: create new dir, find + move transcript file in.
  // Old filename shapes we've used (worst case all five):
  //   <slug>.md
  //   <jid-sanitized>.md            (early days, jid-only)
  //   <jid-sanitized>__<slug>.md    (most common)
  //   <slug>__...md
  //   <jid-sanitized>__<pushedName-sanitized>.md   (pushedName variant)
  // Match case-insensitively + try each contact JID.
  let moved = 0;
  const entries = existsSync(oldDirRoot) ? readdirSync(oldDirRoot) : [];
  const lcEntries = entries.map(fn => ({ fn, lc: fn.toLowerCase() }));
  for (const [slug, entry] of Object.entries(state.contacts ?? {})) {
    // This migration converts JSON → flat slug-keyed YAML. The "new"
    // dir at this point is still the legacy flat path; the later
    // migrateToSurfaceLayout pushes it under conversations/whatsapp/.
    const newDir = _legacySlugDir(slug);
    try { await mkdir(newDir, { recursive: true }); } catch (e) { console.error(`!! migrateLayoutIfNeeded mkdir(${newDir}): ${e?.message ?? e}`); }
    const safeSlug = sanitizeSlug(slug).toLowerCase();
    const jids = entry.jids ?? [];
    const jidSluglets = jids.map(j => sanitizeSlug(j).toLowerCase());
    const candidates = lcEntries
      .filter(({ fn, lc }) => fn.endsWith('.md') && lc !== 'conversations.yaml')
      .filter(({ lc }) =>
        lc === `${safeSlug}.md` ||
        lc.endsWith(`__${safeSlug}.md`) ||
        lc.startsWith(`${safeSlug}__`) ||
        jidSluglets.some(j => lc === `${j}.md` || lc.startsWith(`${j}__`))
      )
      .map(({ fn }) => fn);
    if (!candidates.length) continue;
    // Pick the longest filename (most descriptive); if multiple, move
    // the first into transcript.md and append the rest below the header
    // so no history is lost.
    candidates.sort((a, b) => b.length - a.length);
    const target = join(newDir, 'transcript.md');
    try {
      if (!existsSync(target)) {
        await rename(join(oldDirRoot, candidates[0]), target);
        moved++;
      }
      // Any leftover candidates: append their content + bak-rename
      for (const fn of candidates.slice(1)) {
        try {
          const extra = await readFile(join(oldDirRoot, fn), 'utf8');
          const sep = `\n\n<!-- merged from legacy file: ${fn} -->\n\n`;
          await (await import('node:fs/promises')).appendFile(target, sep + extra);
          await rename(join(oldDirRoot, fn), join(oldDirRoot, fn + '.merged.bak'));
        } catch (e) { console.error(`!! migrateLayoutIfNeeded merge(${fn}): ${e?.message ?? e}`); }
      }
    } catch (e) { console.error(`!! migrateLayoutIfNeeded transcript-merge: ${e?.message ?? e}`); }
  }
  await writeFile(newRegistry, serialize(state), 'utf8');
  if (existsSync(oldYaml)) { try { await rename(oldYaml, oldYaml + '.bak'); } catch (e) { console.error(`!! migrateLayoutIfNeeded yaml-bak: ${e?.message ?? e}`); } }
  if (existsSync(oldJson)) { try { await rename(oldJson, oldJson + '.bak'); } catch (e) { console.error(`!! migrateLayoutIfNeeded json-bak: ${e?.message ?? e}`); } }
  return { migrated: Object.keys(state.contacts ?? {}).length, moved };
}

// ── ISO time helper ────────────────────────────────────────────────────────

export function nowIsoString(d = new Date()) {
  return d.toISOString();
}

// Convert legacy numeric `at` (ms since epoch) → ISO. Used by persona-state
// when reading old config.json that still has numeric timestamps.
export function isoFromMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  try { return new Date(ms).toISOString(); } catch { return null; }
}
